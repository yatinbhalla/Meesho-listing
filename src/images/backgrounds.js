import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

// ─── Built-in studio backgrounds ─────────────────────────────────────────────
// 50 procedurally-generated 1080×1080 plates (no bundled stock photos). Colours
// are spread across the ENTIRE colour wheel with real separation in hue AND
// lightness, so a product composited onto different plates never reads as a
// near-duplicate (Meesho rejects visually-similar images). Distinctness is
// asserted at generation time — see assertDistinct().
//
// Users can drop their own *.jpg into this folder; every jpg is offered in the
// gallery. Stale built-ins are auto-removed when the palette changes.

export const BG_DIR = path.resolve('assets/backgrounds');
export const BG_SIZE = 1080;
const MANIFEST = path.join(BG_DIR, 'manifest.json');

// Minimum pairwise colour distance (weighted RGB, ~perceptual). Kept high so no
// two plates can be mistaken for the same image.
const MIN_COLOR_DIST = 60;

// ─── Colour maths ─────────────────────────────────────────────────────────────
const mix = (a, b, t) => Math.round(a + (b - a) * t);
const lighten = (rgb, t) => rgb.map((c) => mix(c, 255, t));
const darken  = (rgb, t) => rgb.map((c) => mix(c, 0, t));
const smooth  = (t) => t * t * (3 - 2 * t);

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

// Weighted-RGB distance — a cheap stand-in for perceptual (ΔE) distance.
function colorDist(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

const HUE_NAMES = [
  'Red', 'Orange', 'Amber', 'Yellow', 'Chartreuse', 'Green',
  'Spring', 'Teal', 'Cyan', 'Azure', 'Blue', 'Indigo',
  'Violet', 'Purple', 'Magenta', 'Pink',
];
const hueName = (h) => HUE_NAMES[Math.round((((h % 360) + 360) % 360) / 22.5) % 16];
const lightName = (l) => l < 0.42 ? 'Deep' : l < 0.55 ? 'Rich' : l < 0.68 ? 'Bright' : 'Light';

/**
 * Build 50 maximally-distinct colours via farthest-point sampling: from a dense
 * candidate grid over the whole HSL space, repeatedly take the candidate whose
 * nearest already-chosen colour is as FAR as possible. This maximises the
 * minimum pairwise distance, so no two plates read as near-duplicates. Fully
 * deterministic (fixed grid + fixed seed), so the 50 plates are stable.
 */
function buildColors() {
  const cand = [];
  for (let h = 0; h < 360; h += 5) {
    for (const s of [0.9, 0.75, 0.6]) {
      for (const l of [0.38, 0.5, 0.62, 0.72]) {
        cand.push({ h, l, rgb: hslToRgb(h, s, l) });
      }
    }
  }
  const picked = [cand[0]];                                  // deterministic seed (pure red)
  const near = cand.map((c) => colorDist(c.rgb, cand[0].rgb));
  while (picked.length < 50) {
    let bi = 0, bv = -1;
    for (let i = 0; i < cand.length; i++) if (near[i] > bv) { bv = near[i]; bi = i; }
    picked.push(cand[bi]);
    for (let i = 0; i < cand.length; i++) {
      const d = colorDist(cand[i].rgb, cand[bi].rgb);
      if (d < near[i]) near[i] = d;
    }
  }
  return picked.map((c, i) => ({
    id: `bg-${String(i + 1).padStart(2, '0')}`,
    name: `${hueName(c.h)} ${lightName(c.l)}`,
    style: i % 2 ? 'sweep' : 'vignette',
    rgb: c.rgb,
  }));
}

// Throw if any two plates are closer than MIN_COLOR_DIST — a hard guarantee the
// palette can't drift back into near-duplicate territory.
function assertDistinct(colors) {
  let min = Infinity, pair = null;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = colorDist(colors[i].rgb, colors[j].rgb);
      if (d < min) { min = d; pair = [colors[i].id, colors[j].id]; }
    }
  }
  if (min < MIN_COLOR_DIST) {
    throw new Error(`Background palette not distinct enough: ${pair?.join(' vs ')} are ${min.toFixed(1)} apart (min ${MIN_COLOR_DIST}).`);
  }
  return min;
}

// Turn a colour into a full plate spec (centre/edge for vignette, top/bottom for
// sweep) so it still reads as a lit studio backdrop rather than a flat fill.
function toSpec(c) {
  return c.style === 'vignette'
    ? { id: c.id, name: c.name, style: 'vignette', center: lighten(c.rgb, 0.14), edge: darken(c.rgb, 0.12) }
    : { id: c.id, name: c.name, style: 'sweep',    top: lighten(c.rgb, 0.18), bottom: darken(c.rgb, 0.08) };
}

// Render one plate to a raw RGB buffer (pure pixel math — no SVG dependency).
function renderBuffer(spec, size = BG_SIZE) {
  const buf = Buffer.allocUnsafe(size * size * 3);
  if (spec.style === 'vignette') {
    const cx = (size - 1) / 2, cy = (size - 1) / 2;
    const maxD = Math.hypot(cx, cy);
    const [c0, c1, c2] = spec.center;
    const [e0, e1, e2] = spec.edge;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = smooth(Math.hypot(x - cx, y - cy) / maxD);
        const i = (y * size + x) * 3;
        buf[i] = mix(c0, e0, t); buf[i + 1] = mix(c1, e1, t); buf[i + 2] = mix(c2, e2, t);
      }
    }
  } else {
    const [t0, t1, t2] = spec.top;
    const [b0, b1, b2] = spec.bottom;
    for (let y = 0; y < size; y++) {
      const t = smooth(y / (size - 1));
      const r = mix(t0, b0, t), g = mix(t1, b1, t), b = mix(t2, b2, t);
      let i = y * size * 3;
      for (let x = 0; x < size; x++) { buf[i++] = r; buf[i++] = g; buf[i++] = b; }
    }
  }
  return buf;
}

/**
 * Ensure the built-in plates exist. Regenerates the set (and removes any stale
 * built-ins from a previous palette, tracked via the old manifest) while leaving
 * user-added files untouched. Idempotent and cheap once generated.
 */
export async function ensureBackgrounds() {
  await fs.mkdir(BG_DIR, { recursive: true });
  const colors = buildColors();
  assertDistinct(colors);
  const specs = colors.map(toSpec);
  const wantedIds = new Set(specs.map((s) => s.id));

  // Remove stale built-ins (in the old manifest but no longer in the palette).
  try {
    const old = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
    for (const id of Object.keys(old)) {
      if (!wantedIds.has(id)) await fs.rm(path.join(BG_DIR, `${id}.jpg`), { force: true }).catch(() => {});
    }
  } catch { /* no previous manifest */ }

  const manifest = {};
  for (const spec of specs) {
    manifest[spec.id] = spec.name;
    const full = path.join(BG_DIR, `${spec.id}.jpg`);
    try { await fs.access(full); continue; } catch { /* needs generating */ }
    await sharp(renderBuffer(spec), { raw: { width: BG_SIZE, height: BG_SIZE, channels: 3 } })
      .jpeg({ quality: 90 })
      .toFile(full);
  }
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * List every plate offered in the gallery: built-ins (pretty names from the
 * manifest) plus any user-dropped *.jpg (filename-derived name).
 */
export async function listBackgrounds() {
  const manifest = await ensureBackgrounds();
  const entries = await fs.readdir(BG_DIR);
  const jpgs = entries.filter((f) => /\.jpe?g$/i.test(f));
  return jpgs.map((file) => {
    const id = file.replace(/\.jpe?g$/i, '');
    const name = manifest[id]
      || id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { id, name, file };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a background id to its absolute file path, guarding against traversal.
 * Returns null if the id isn't a real plate in BG_DIR.
 */
export async function backgroundPathFor(id) {
  if (!/^[a-z0-9][\w-]*$/i.test(String(id || ''))) return null;
  for (const ext of ['.jpg', '.jpeg']) {
    const full = path.join(BG_DIR, `${id}${ext}`);
    if (path.dirname(full) !== BG_DIR) return null;
    try { await fs.access(full); return full; } catch { /* try next */ }
  }
  return null;
}
