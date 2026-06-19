import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';

const router = express.Router();
const PATHS_DIR = path.resolve('paths');

async function ensurePathsDir() {
  await fs.mkdir(PATHS_DIR, { recursive: true });
}

// Helper: resolve a path's config.json by directory name (= safeName).
async function loadConfig(name) {
  const file = path.join(PATHS_DIR, name, 'config.json');
  const raw = await fs.readFile(file, 'utf8');
  return { config: JSON.parse(raw), file };
}

// ─── GET /api/paths — list all saved paths ────────────────────────────────────
router.get('/', async (_req, res) => {
  await ensurePathsDir();
  const entries = await fs.readdir(PATHS_DIR, { withFileTypes: true });
  const configs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(PATHS_DIR, entry.name, 'config.json'), 'utf8');
      const config = JSON.parse(raw);
      // Tag with the folder name so the UI can use it for subsequent calls.
      config._folder = entry.name;
      // Mark whether shared images are uploaded — UI shows a warning if not.
      config._sharedImagesReady = await sharedImagesPresent(entry.name);
      configs.push(config);
    } catch {
      // Skip incomplete dirs
    }
  }
  res.json(configs);
});

// ─── GET /api/paths/:name — fetch one path ────────────────────────────────────
router.get('/:name', async (req, res) => {
  try {
    const { config } = await loadConfig(req.params.name);
    config._folder = req.params.name;
    config._sharedImagesReady = await sharedImagesPresent(req.params.name);
    res.json(config);
  } catch {
    res.status(404).json({ error: 'Path not found.' });
  }
});

// ─── PATCH /api/paths/:name — update fields/metadata after recording ──────────
// Used to mark which fields are AI-generated, fixed, or SKU.
router.patch('/:name', async (req, res) => {
  try {
    const { config, file } = await loadConfig(req.params.name);

    // Whitelist of editable top-level keys.
    const editable = ['name', 'skuPattern', 'productDescription', 'fields', 'steps'];
    for (const key of editable) {
      if (key in req.body) config[key] = req.body[key];
    }
    config.updatedAt = new Date().toISOString();

    await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf8');
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: `Failed to update path: ${err.message}` });
  }
});

// ─── POST /api/paths/:name/duplicate — clone a path ───────────────────────────
// WHY: product variants (e.g. the same item in different colours) share the
// entire recorded workflow. Cloning a path lets the user tweak just the few
// fields that differ (colour, name, SKU pattern, description) instead of
// re-recording and re-verifying the whole path. The clone copies the config AND
// the shared images, so it's runnable immediately.
router.post('/:name/duplicate', async (req, res) => {
  try {
    const { config } = await loadConfig(req.params.name);

    const newFolder = `recording_${Date.now()}`;
    const newDir = path.join(PATHS_DIR, newFolder);
    await fs.mkdir(newDir, { recursive: true });

    const now = new Date().toISOString();
    const clone = { ...config, name: `${config.name || 'Untitled'} (copy)`, createdAt: now, updatedAt: now };
    delete clone._folder;
    delete clone._sharedImagesReady;

    await fs.writeFile(path.join(newDir, 'config.json'), JSON.stringify(clone, null, 2), 'utf8');

    // Copy shared images too, so the clone can run without re-uploading them.
    try {
      await fs.cp(
        path.join(PATHS_DIR, req.params.name, 'shared_images'),
        path.join(newDir, 'shared_images'),
        { recursive: true },
      );
    } catch { /* source path had no shared images — nothing to copy */ }

    clone._folder = newFolder;
    clone._sharedImagesReady = await sharedImagesPresent(newFolder);
    res.status(201).json(clone);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Path not found.' });
    res.status(500).json({ error: `Failed to duplicate path: ${err.message}` });
  }
});

// ─── GET /api/paths/:name/export — download a single-file backup ──────────────
// WHY: a recorded path lives only on this machine. Exporting it as one
// self-contained JSON file (the config PLUS the shared images, base64-encoded)
// lets the user back it up and restore it later — even if the path folder is
// deleted. Login credentials are stripped so the backup never carries secrets.
router.get('/:name/export', async (req, res) => {
  try {
    const { config } = await loadConfig(req.params.name);
    delete config._folder;
    delete config._sharedImagesReady;
    for (const f of (config.fields || [])) {
      if (/password|emailorphone/i.test(f.selector || '')) f.fixedValue = '';
    }

    // Bundle the shared images so a restore needs nothing else.
    const images = {};
    const imgDir = path.join(PATHS_DIR, req.params.name, 'shared_images');
    try {
      for (const file of await fs.readdir(imgDir)) {
        if (/\.(jpe?g|png|webp)$/i.test(file)) {
          images[file] = (await fs.readFile(path.join(imgDir, file))).toString('base64');
        }
      }
    } catch { /* path has no shared images — nothing to bundle */ }

    const backup = {
      meeshoPathBackup: 1,
      exportedAt: new Date().toISOString(),
      config,
      images,
    };
    const safe = (config.name || req.params.name).replace(/[^a-z0-9._-]+/gi, '_');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.meesho-path.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Path not found.' });
    res.status(500).json({ error: `Failed to export path: ${err.message}` });
  }
});

// ─── POST /api/paths/import — restore a path from a backup file ────────────────
// Accepts the backup as an uploaded file (multipart) so the embedded images can
// exceed the small global JSON body limit. Recreates the path in a fresh folder.
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});
router.post('/import', backupUpload.single('backup'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No backup file uploaded.' });
    let backup;
    try { backup = JSON.parse(req.file.buffer.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Backup file is not valid JSON.' }); }
    if (backup.meeshoPathBackup !== 1 || !backup.config) {
      return res.status(400).json({ error: 'Not a valid Meesho path backup file.' });
    }

    const newFolder = `recording_${Date.now()}`;
    const newDir = path.join(PATHS_DIR, newFolder);
    await fs.mkdir(newDir, { recursive: true });

    const now = new Date().toISOString();
    const config = { ...backup.config };
    delete config._folder;
    delete config._sharedImagesReady;
    config.updatedAt = now;
    if (!config.createdAt) config.createdAt = now;
    // Never restore credentials from a (possibly old) backup.
    for (const f of (config.fields || [])) {
      if (/password|emailorphone/i.test(f.selector || '')) f.fixedValue = '';
    }
    await fs.writeFile(path.join(newDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

    // Restore shared images.
    const images = backup.images || {};
    if (Object.keys(images).length) {
      const restoreDir = path.join(newDir, 'shared_images');
      await fs.mkdir(restoreDir, { recursive: true });
      for (const [name, b64] of Object.entries(images)) {
        await fs.writeFile(path.join(restoreDir, path.basename(name)), Buffer.from(b64, 'base64'));
      }
    }

    config._folder = newFolder;
    config._sharedImagesReady = await sharedImagesPresent(newFolder);
    res.status(201).json(config);
  } catch (err) {
    res.status(500).json({ error: `Failed to import path: ${err.message}` });
  }
});

// ─── DELETE /api/paths/:name ──────────────────────────────────────────────────
router.delete('/:name', async (req, res) => {
  try {
    await fs.rm(path.join(PATHS_DIR, req.params.name), { recursive: true, force: true });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not delete path.' });
  }
});

// ─── POST /api/paths/:name/images — upload 3 shared images ────────────────────
// WHY: shared images are stored as img2.jpg / img3.jpg / img4.jpg regardless
// of the original filename, so the executor can predict the path at run time.
const sharedUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = path.join(PATHS_DIR, req.params.name, 'shared_images');
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `__tmp_${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    /jpeg|jpg|png|webp/i.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, and WebP images allowed.'));
  },
});

router.post(
  '/:name/images',
  sharedUpload.fields([
    { name: 'img2', maxCount: 1 },
    { name: 'img3', maxCount: 1 },
    { name: 'img4', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const dir = path.join(PATHS_DIR, req.params.name, 'shared_images');
      const required = ['img2', 'img3', 'img4'];
      for (const slot of required) {
        if (!req.files?.[slot]?.[0]) {
          return res.status(400).json({ error: `Missing image: ${slot}` });
        }
      }

      // Rename the uploaded tmp files into stable slot names, overwriting any
      // previous shared images for this path.
      for (const slot of required) {
        const tmpPath = req.files[slot][0].path;
        const finalPath = path.join(dir, `${slot}.jpg`);
        await fs.rm(finalPath, { force: true });
        await fs.rename(tmpPath, finalPath);
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Upload failed: ${err.message}` });
    }
  }
);

// ─── helpers ──────────────────────────────────────────────────────────────────
async function sharedImagesPresent(name) {
  const dir = path.join(PATHS_DIR, name, 'shared_images');
  try {
    const files = await fs.readdir(dir);
    return ['img2.jpg', 'img3.jpg', 'img4.jpg'].every((f) => files.includes(f));
  } catch {
    return false;
  }
}

export default router;
