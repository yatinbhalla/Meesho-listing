import fs from 'fs/promises';
import path from 'path';

// ─── Multi-account profiles ─────────────────────────────────────────────────────
// Each profile is a separate Meesho seller account with its OWN:
//   • login credentials (email/password)
//   • recorded paths     → paths/<id>/recording_*
//   • browser session    → data/.browser-profile/<id>
// The active profile decides which account a recording or listing run uses.
//
// Stored locally in data/profiles.json (git-ignored — it holds passwords, same
// as .env). Loaded once into memory at startup so the rest of the server can read
// the active profile synchronously; writes update memory and disk together.

const PROFILES_FILE = path.resolve('data/profiles.json');
const PATHS_ROOT    = path.resolve('paths');
const BROWSER_ROOT  = path.resolve('data/.browser-profile');

// The 3 accounts the user runs. Ids are stable internal keys; names are display-only.
const SEED = [
  { id: 'yatin', name: 'Yatin Bhalla', email: '', password: '' },
  { id: 'param', name: 'param',        email: '', password: '' },
  { id: 'dayal', name: 'dayal',        email: '', password: '' },
];

let _state = null;   // { activeProfileId, profiles: [...] }

export function pathsDirFor(id)   { return path.join(PATHS_ROOT, id); }
export function sessionDirFor(id) { return path.join(BROWSER_ROOT, id); }

async function save() {
  await fs.mkdir(path.dirname(PROFILES_FILE), { recursive: true });
  await fs.writeFile(PROFILES_FILE, JSON.stringify(_state, null, 2), 'utf8');
}

/**
 * Load profiles.json into memory. On first ever run (file absent) it seeds the 3
 * profiles, copies the existing single-account credentials/paths/session under
 * the "yatin" profile, and writes the file. Idempotent — safe to call repeatedly.
 */
export async function ensureProfilesInit() {
  if (_state) return _state;

  try {
    _state = JSON.parse(await fs.readFile(PROFILES_FILE, 'utf8'));
    // Backfill any missing seed profile (e.g. a hand-edited file).
    for (const s of SEED) {
      if (!_state.profiles.find((p) => p.id === s.id)) _state.profiles.push({ ...s });
    }
    if (!_state.activeProfileId) _state.activeProfileId = _state.profiles[0].id;
    return _state;
  } catch {
    // First run — create + migrate the existing single-account setup into "yatin".
  }

  _state = {
    activeProfileId: 'yatin',
    profiles: SEED.map((p) =>
      p.id === 'yatin'
        ? { ...p, email: process.env.MEESHO_EMAIL || '', password: process.env.MEESHO_PASSWORD || '' }
        : { ...p }
    ),
  };

  await migrateExistingPathsToYatin();
  await migrateExistingSessionToYatin();
  await save();
  return _state;
}

// Move every legacy paths/recording_* into paths/yatin/recording_*.
async function migrateExistingPathsToYatin() {
  const dest = pathsDirFor('yatin');
  try {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(PATHS_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^recording_/.test(e.name)) {
        await fs.rename(path.join(PATHS_ROOT, e.name), path.join(dest, e.name)).catch(() => {});
      }
    }
  } catch { /* no legacy paths — nothing to migrate */ }
}

// Nest the legacy flat browser session under data/.browser-profile/yatin so the
// user stays logged in as Yatin. Best-effort: if it fails, Yatin simply logs in
// again from its .env-seeded credentials on the next run.
async function migrateExistingSessionToYatin() {
  try {
    await fs.access(BROWSER_ROOT);
  } catch {
    return;   // no existing session dir
  }
  const yatinDir = sessionDirFor('yatin');
  try {
    await fs.access(yatinDir);
    return;   // already nested — nothing to do
  } catch { /* not nested yet */ }

  // A flat profile can't be moved into a child of itself directly — bounce via a
  // sibling temp dir.
  const tmp = `${BROWSER_ROOT}__migrate`;
  try {
    await fs.rename(BROWSER_ROOT, tmp);
    await fs.mkdir(BROWSER_ROOT, { recursive: true });
    await fs.rename(tmp, yatinDir);
  } catch {
    // Locked or partially moved — leave it; getSession will create a fresh dir.
    await fs.rename(tmp, BROWSER_ROOT).catch(() => {});
  }
}

export function getProfiles()      { return _state?.profiles || []; }
export function getActiveProfileId(){ return _state?.activeProfileId || 'yatin'; }
export function getActiveProfile() {
  const id = getActiveProfileId();
  return getProfiles().find((p) => p.id === id) || getProfiles()[0];
}

export async function setActiveProfile(id) {
  if (!getProfiles().find((p) => p.id === id)) throw new Error(`Unknown profile "${id}".`);
  _state.activeProfileId = id;
  await save();
  return getActiveProfile();
}

export async function updateProfile(id, { name, email, password }) {
  const p = getProfiles().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown profile "${id}".`);
  if (name != null && name !== '')     p.name = String(name);
  if (email != null)                    p.email = String(email);
  if (password)                         p.password = String(password);   // blank = keep existing
  await save();
  return p;
}
