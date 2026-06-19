import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { generateFields, generateSKU } from '../../ai/generator.js';
import { executeRun } from '../../browser/executor.js';
import { getSession } from '../../browser/session.js';
import { broadcast, getActiveSession, setActiveSession, clearActiveSession } from '../index.js';

const router = express.Router();
const PATHS_DIR   = path.resolve('paths');
const UPLOADS_DIR = path.resolve('data/uploads');
const MAX_BATCH   = 50;

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

    const pathDir = path.join(PATHS_DIR, pathName);
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
    runBatch({ pathConfig, pathDir, files: req.files, noSubmit })
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
 * Run one batch: open browser once, generate AI once, loop per hero image.
 * Stops on first failure (per the user's chosen policy).
 */
async function runBatch({ pathConfig, pathDir, files, noSubmit = false }) {
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
  );
  log('success', `✓ Generated ${Object.keys(aiValues).length} AI field(s).`);

  // ─── 2. Open the browser ONCE — reused across all listings ───────────────
  const { page } = await getSession((m) => log('info', m));

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
      await runOneListing({ pathConfig, pathDir, heroImagePath: file.path, aiValues, sku, page, noSubmit });
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
function runOneListing({ pathConfig, pathDir, heroImagePath, aiValues, sku, page, noSubmit }) {
  return new Promise((resolve, reject) => {
    const emitter = executeRun({ pathConfig, heroImagePath, pathDir, aiValues, sku, page, noSubmit });
    emitter.on('log',   (msg) => broadcast({ ...msg, topic: 'run' }));
    emitter.once('done',  () => resolve());
    emitter.once('error', (err) => reject(err));
  });
}

export default router;
