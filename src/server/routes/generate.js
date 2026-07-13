import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { listBackgrounds } from '../../images/backgrounds.js';
import { generateVariants } from '../../images/generate.js';
import { broadcast } from '../index.js';

const router = express.Router();

export const GENERATED_DIR = path.resolve('data/generated');
const SRC_DIR = path.resolve('data/uploads');
const MAX_VARIANTS = 50;

// Only one cutout job at a time — it's CPU-heavy and shares one cached model.
let _busy = false;

// ─── Source-photo upload (single, ephemeral) ────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await fs.mkdir(SRC_DIR, { recursive: true });
      cb(null, SRC_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    /jpeg|jpg|png|webp/i.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, and WebP images allowed.'));
  },
});

/** GET /api/backgrounds — the gallery of studio plates (built-in + user-added). */
router.get('/backgrounds', async (_req, res) => {  // mounted at /api
  try {
    const list = await listBackgrounds();
    res.json(list.map(({ id, name, file }) => ({ id, name, url: `/assets/backgrounds/${file}` })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/generate  (multipart)
 *   - file  "photo"          : the single source product photo
 *   - field "backgroundIds"  : JSON array of plate ids (one output per id)
 *
 * Cuts the product out once, composites onto each background, and writes the
 * results to data/generated/<sessionId>/. Returns the previews for the approval
 * gate — nothing is listed until the user confirms and runs.
 */
router.post('/generate', upload.single('photo'), async (req, res) => {
  if (_busy) return res.status(409).json({ error: 'A generation is already running — wait for it to finish.' });
  if (!req.file) return res.status(400).json({ error: 'A "photo" file is required.' });

  let backgroundIds;
  try {
    backgroundIds = JSON.parse(req.body.backgroundIds || '[]');
  } catch {
    return res.status(400).json({ error: 'backgroundIds must be a JSON array.' });
  }
  if (!Array.isArray(backgroundIds) || backgroundIds.length === 0) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Select at least one background.' });
  }
  if (backgroundIds.length > MAX_VARIANTS) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: `At most ${MAX_VARIANTS} backgrounds per batch.` });
  }

  _busy = true;
  const sessionId = uuidv4();
  const outDir = path.join(GENERATED_DIR, sessionId);
  const log = (text) => broadcast({ type: 'info', topic: 'generate', text });

  try {
    await pruneOldSessions();
    broadcast({ type: 'event', topic: 'generate', event: 'generate_start', total: backgroundIds.length,
      text: `🎨 Generating ${backgroundIds.length} image(s)…` });

    const results = await generateVariants({
      heroImagePath: req.file.path,
      backgroundIds,
      outDir,
      log,
    });

    const images = results.map((r) => ({
      name: r.name,
      bgId: r.bgId,
      url: `/generated/${sessionId}/${r.name}`,
    }));

    broadcast({ type: 'success', topic: 'generate', event: 'generate_complete',
      text: `✓ Generated ${images.length} image(s). Review, then Run.` });
    res.json({ sessionId, images });
  } catch (err) {
    broadcast({ type: 'error', topic: 'generate', text: `Generation failed: ${err.message}` });
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    _busy = false;
    await fs.unlink(req.file.path).catch(() => {});   // source photo is not reused
  }
});

// Keep data/generated from growing forever: drop session dirs older than 6h.
async function pruneOldSessions() {
  const MAX_AGE = 6 * 60 * 60 * 1000;
  try {
    const entries = await fs.readdir(GENERATED_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(GENERATED_DIR, e.name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && now - stat.mtimeMs > MAX_AGE) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch { /* dir doesn't exist yet — nothing to prune */ }
}

export default router;
