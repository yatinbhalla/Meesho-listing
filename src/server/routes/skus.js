import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();
const SKUS_FILE = path.resolve('data/used_skus.json');

// GET /api/skus — return all used SKU IDs
router.get('/', async (_req, res) => {
  try {
    const raw = await fs.readFile(SKUS_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch {
    res.json([]);
  }
});

export default router;
