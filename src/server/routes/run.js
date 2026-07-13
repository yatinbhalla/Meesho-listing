import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { generateFields, generateSKU } from '../../ai/generator.js';
import { executeRun } from '../../browser/executor.js';
import { getSession } from '../../browser/session.js';
import { broadcast, getActiveSession, setActiveSession, clearActiveSession } from '../index.js';
import { getActiveProfile, pathsDirFor } from '../profiles.js';

const router = express.Router();
const UPLOADS_DIR   = path.resolve('data/uploads');
const GENERATED_DIR = path.resolve('data/generated');
const MAX_BATCH     = 50;

// ─── Hero-image upload (per-listing, ephemeral) ─────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `hero_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    /jpeg|jpg|png|webp/i.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, and WebP images allowed.'));
  },
});

/**
 * POST /api/run  (multipart)
 *   - field "pathName"    : string  — folder name under paths/
 *   - files "heroImages"  : 1..MAX_BATCH images. Each one becomes its own listing.
 *
 * Responds 202 immediately. Progress + completion arrive via WebSocket.
 */
router.post('/', upload.array('heroImages', MAX_BATCH), async (req, res) => {
  try {
    if (getActiveSession()) {
      return res.status(409).json({
        error: `Another session is already active (${getActiveSession()}).`,
      });
    }

    const pathName = req.body.pathName;
    if (!pathName) return res.status(400).json({ error: 'pathName is required.' });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one heroImages file is required.' });
    }

    // Resolve the path under the ACTIVE profile's directory and run with that
    // account's session + credentials.
    const profile = getActiveProfile();
    const pathDir = path.join(path.resolve(pathsDirFor(profile.id)), pathName);
    let pathConfig;
    try {
      const raw = await fs.readFile(path.join(pathDir, 'config.json'), 'utf8');
      pathConfig = JSON.parse(raw);
    } catch {
      return res.status(404).json({ error: `Path "${pathName}" not found.` });
    }

    setActiveSession('running');
    res.status(202).json({ ok: true, message: `Batch of ${req.files.length} listing(s) started.` });

    // ─── Background batch run ───────────────────────────────────────────────
    // Explicit per-run diagnostic flag: fill the form but never click Submit.
    const noSubmit = req.body.noSubmit === 'true' || req.body.noSubmit === true;
    runBatch({ pathConfig, pathDir, files: req.files, noSubmit, profile })
      .catch((err) => {
        broadcast({ type: 'error', topic: 'run', text: err.message });
      })
      .finally(() => {
        clearActiveSession();
        // WHY: clean up every uploaded hero image — they're per-batch, not reusable.
        for (const file of req.files) {
          fs.unlink(file.path).catch(() => {});
        }
      });

  } catch (err) {
    clearActiveSession();
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/run/generated  (JSON)
 *   - pathName   : string  — folder name under the active profile's paths/
 *   - sessionId  : string  — the generation session (data/generated/<sessionId>/)
 *   - images     : string[] — generated file names to list (one listing each)
 *   - noSubmit   : boolean  — optional diagnostic (fill but never submit)
 *
 * Lists images the user already generated + approved via /api/generate. Reuses
 * the exact same batch pipeline as uploaded images. Responds 202 immediately.
 */
router.post('/generated', async (req, res) => {
  try {
    if (getActiveSession()) {
      return res.status(409).json({ error: `Another session is already active (${getActiveSession()}).` });
    }

    const { pathName, sessionId, images, noSubmit } = req.body || {};
    if (!pathName) return res.status(400).json({ error: 'pathName is required.' });
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return res.status(400).json({ error: 'A valid sessionId is required.' });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'At least one generated image is required.' });
    }

    // Resolve the path config under the ACTIVE profile.
    const profile = getActiveProfile();
    const pathDir = path.join(path.resolve(pathsDirFor(profile.id)), pathName);
    let pathConfig;
    try {
      pathConfig = JSON.parse(await fs.readFile(path.join(pathDir, 'config.json'), 'utf8'));
    } catch {
      return res.status(404).json({ error: `Path "${pathName}" not found.` });
    }

    // Resolve + validate every generated file (guard against path traversal:
    // names must be plain gen_*.jpg and stay inside the session dir).
    const sessionDir = path.join(GENERATED_DIR, sessionId);
    const files = [];
    for (const name of images) {
      if (typeof name !== 'string' || !/^gen_[\w.-]+\.jpe?g$/i.test(name)) {
        return res.status(400).json({ error: `Invalid image name "${name}".` });
      }
      const full = path.join(sessionDir, name);
      if (path.dirname(full) !== sessionDir) {
        return res.status(400).json({ error: `Invalid image path for "${name}".` });
      }
      try { await fs.access(full); }
      catch { return res.status(404).json({ error: `Generated image "${name}" no longer exists — regenerate.` }); }
      files.push({ path: full, originalname: name });
    }

    setActiveSession('running');
    res.status(202).json({ ok: true, message: `Batch of ${files.length} listing(s) started.` });

    const noSub = noSubmit === true || noSubmit === 'true';
    runBatch({ pathConfig, pathDir, files, noSubmit: noSub, profile })
      .catch((err) => broadcast({ type: 'error', topic: 'run', text: err.message }))
      .finally(() => {
        clearActiveSession();
        // Generated composites are per-batch — drop the whole session dir.
        fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      });
  } catch (err) {
    clearActiveSession();
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run one batch: open browser once, generate AI once, loop per hero image.
 * Stops on first failure (per the user's chosen policy).
 */
async function runBatch({ pathConfig, pathDir, files, noSubmit = false, profile = null }) {
  const log = (type, text) => broadcast({ type, text, topic: 'run' });
  const total = files.length;

  broadcast({ type: 'event', event: 'batch_start', topic: 'run', total, text: `🚀 Starting batch of ${total} listing(s)...` });

  // ─── 1. Generate AI values ONCE for the whole batch ──────────────────────
  // WHY: productDescription is the same across all listings in a batch, so
  // Gemini's output would be identical anyway. One call instead of N.
  log('info', '🤖 Generating AI field values (once for the batch)...');
  const aiValues = await generateFields(
    pathConfig.fields,
    pathConfig.productDescription,
    (m) => log('info', m),
    profile?.geminiApiKey,
  );
  log('success', `✓ Generated ${Object.keys(aiValues).length} AI field(s).`);

  // ─── 2. Open the browser ONCE — reused across all listings ───────────────
  log('info', `🔑 Account: ${profile?.name || 'default'}`);
  const { page } = await getSession((m) => log('info', m), profile);
  const credentials = { email: profile?.email, password: profile?.password };

  // ─── 3. Loop ─────────────────────────────────────────────────────────────
  const succeededSkus = [];
  const hasSku = pathConfig.fields.some((f) => f.type === 'sku');

  for (let i = 0; i < files.length; i++) {
    const index = i + 1;
    const file = files[i];

    let sku = '';
    if (hasSku) {
      sku = await generateSKU(pathConfig.skuPattern);
    }

    broadcast({
      type: 'event', event: 'batch_item_start', topic: 'run',
      index, total, sku,
      text: `── Listing ${index} of ${total}${sku ? ` · ${sku}` : ''} · ${path.basename(file.originalname)} ──`,
    });

    try {
      await runOneListing({ pathConfig, pathDir, heroImagePath: file.path, aiValues, sku, page, noSubmit, credentials });
      succeededSkus.push(sku);
      broadcast({
        type: 'event', event: 'batch_item_complete', topic: 'run',
        index, total, sku,
        text: `✓ Listing ${index} of ${total} complete.`,
      });
    } catch (err) {
      broadcast({
        type: 'event', event: 'batch_failed', topic: 'run',
        index, total, sku, error: err.message,
        text: `✗ Listing ${index} of ${total} failed: ${err.message}. Batch halted.`,
      });
      return;   // stop the batch on first failure
    }
  }

  broadcast({
    type: 'event', event: 'batch_complete', topic: 'run',
    skus: succeededSkus,
    text: `✓ Batch complete — ${succeededSkus.length} listing(s) created.`,
  });
}

/**
 * Run a single listing in an existing browser session.
 * Wraps executeRun's emitter into a Promise.
 */
function runOneListing({ pathConfig, pathDir, heroImagePath, aiValues, sku, page, noSubmit, credentials }) {
  return new Promise((resolve, reject) => {
    const emitter = executeRun({ pathConfig, heroImagePath, pathDir, aiValues, sku, page, noSubmit, credentials });
    emitter.on('log',   (msg) => broadcast({ ...msg, topic: 'run' }));
    emitter.once('done',  () => resolve());
    emitter.once('error', (err) => reject(err));
  });
}

export default router;
