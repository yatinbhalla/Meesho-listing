import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();
const ENV_FILE = path.resolve('.env');

// Fields the UI is allowed to read/write. PORT is read-only via this API.
const EDITABLE = ['MEESHO_EMAIL', 'MEESHO_PASSWORD', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'AI_NAVIGATION_ENABLED'];
const SECRETS  = ['MEESHO_PASSWORD', 'GEMINI_API_KEY'];

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-2);
}

async function readEnvRaw() {
  try { return await fs.readFile(ENV_FILE, 'utf8'); } catch { return ''; }
}

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// Update keys in-place when present, append at end when new — preserves comments.
async function writeEnv(updates) {
  let raw = await readEnvRaw();
  const lines = raw.split(/\r?\n/);
  const seen = new Set();

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) updated.push(`${k}=${v}`);
  }

  await fs.writeFile(ENV_FILE, updated.join('\n'), 'utf8');

  // WHY: refresh process.env so the next API call (e.g. Gemini generation) sees
  // the new value without requiring a server restart.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

// ─── GET /api/settings ────────────────────────────────────────────────────────
// Returns email + masked secrets + model. Never returns full secret values.
router.get('/', async (_req, res) => {
  const env = parseEnv(await readEnvRaw());
  res.json({
    MEESHO_EMAIL: env.MEESHO_EMAIL || '',
    MEESHO_PASSWORD_MASKED: mask(env.MEESHO_PASSWORD),
    GEMINI_API_KEY_MASKED: mask(env.GEMINI_API_KEY),
    GEMINI_MODEL: env.GEMINI_MODEL || '',
    // Default to enabled if the key isn't present in .env.
    AI_NAVIGATION_ENABLED: env.AI_NAVIGATION_ENABLED !== 'false',
    hasPassword: !!env.MEESHO_PASSWORD,
    hasApiKey: !!env.GEMINI_API_KEY,
  });
});

// ─── PUT /api/settings ─────────────────────────────────────────────────────────
// Only updates fields the user actually changed (non-empty values).
router.put('/', async (req, res) => {
  try {
    const updates = {};
    for (const key of EDITABLE) {
      if (key in req.body && req.body[key] !== '' && req.body[key] != null) {
        updates[key] = String(req.body[key]);
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }
    await writeEnv(updates);
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
