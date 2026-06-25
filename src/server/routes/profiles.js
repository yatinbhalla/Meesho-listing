import express from 'express';
import { getProfiles, getActiveProfileId, setActiveProfile, updateProfile } from '../profiles.js';
import { getActiveSession } from '../index.js';

const router = express.Router();

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-2);
}

// Never leak full passwords to the client.
function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    email: p.email || '',
    hasPassword: !!p.password,
    passwordMasked: mask(p.password),
  };
}

// ─── GET /api/profiles — list profiles + which is active ──────────────────────
router.get('/', (_req, res) => {
  res.json({
    activeProfileId: getActiveProfileId(),
    profiles: getProfiles().map(publicProfile),
  });
});

// ─── POST /api/profiles/active — switch the active account ────────────────────
router.post('/active', async (req, res) => {
  try {
    if (getActiveSession()) {
      return res.status(409).json({ error: 'Finish or stop the running session before switching accounts.' });
    }
    const active = await setActiveProfile(req.body.id);
    res.json({ ok: true, activeProfileId: active.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── PATCH /api/profiles/:id — edit name / email / password ───────────────────
router.patch('/:id', async (req, res) => {
  try {
    const p = await updateProfile(req.params.id, req.body);
    res.json(publicProfile(p));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
