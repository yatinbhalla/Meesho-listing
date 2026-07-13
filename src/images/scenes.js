import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

// ─── Procedural "scene" backdrops ─────────────────────────────────────────────
// 100 ORIGINAL, license-free textured backgrounds generated entirely in code —
// marble, wood, linen, concrete, bokeh, and gradient sweeps. These are NOT
// photographs (this project can't run a photoreal image model), but they're
// material-suggestive, fully original, and carry zero copyright risk — use them
// as-is; no "modifying to dodge copyright" needed (which wouldn't be legal
// anyway). Written to a SEPARATE folder so they stay distinct from the 50 solid
// studio plates.

export const SCENES_DIR = path.resolve('assets/backgrounds-scenes');
const RENDER = 720;          // render resolution; upscaled to 1080 on write
const OUT = 1080;

// ─── helpers ──────────────────────────────────────────────────────────────────
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Cheap seeded value-noise with fractal (fBm) octaves.
function noiseFns(seed) {
  const hash = (x, y) => {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2246822519;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise2 = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const v00 = hash(xi, yi), v10 = hash(xi + 1, yi);
    const v01 = hash(xi, yi + 1), v11 = hash(xi + 1, yi + 1);
    return mix(mix(v00, v10, u), mix(v01, v11, u), v);
  };
  const fbm = (x, y, oct = 4) => {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * noise2(x * f, y * f); norm += a; a *= 0.5; f *= 2; }
    return sum / norm;
  };
  return { noise2, fbm };
}

// ─── category renderers (fill a raw RGB buffer, size R×R) ───────────────────────
function renderMarble(buf, R, { base, vein, seed }) {
  const { fbm } = noiseFns(seed);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R, ny = y / R;
      const turb = fbm(nx * 3, ny * 3, 5);
      const pattern = 0.5 + 0.5 * Math.sin((nx * 3 + ny * 1.2 + turb * 4) * Math.PI * 2);
      const veinAmt = Math.pow(smooth(Math.max(0, (pattern - 0.6) / 0.4)), 1.5);
      const shade = 0.94 + 0.06 * fbm(nx * 1.5, ny * 1.5, 3);
      const c = mixRgb(base, vein, veinAmt * 0.85);
      const i = (y * R + x) * 3;
      buf[i] = clamp(c[0] * shade); buf[i + 1] = clamp(c[1] * shade); buf[i + 2] = clamp(c[2] * shade);
    }
  }
}

function renderWood(buf, R, { light, dark, seed }) {
  const { fbm } = noiseFns(seed);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R, ny = y / R;
      const warp = fbm(nx * 2, ny * 2, 3);
      const grain = 0.5 + 0.5 * Math.sin((ny * 14 + warp * 3 + fbm(nx * 10, ny * 10, 2) * 1.2) * Math.PI);
      const fine = 0.96 + 0.08 * fbm(nx * 60, ny * 6, 2);   // long streaks
      const c = mixRgb(light, dark, smooth(grain) * 0.8);
      const i = (y * R + x) * 3;
      buf[i] = clamp(c[0] * fine); buf[i + 1] = clamp(c[1] * fine); buf[i + 2] = clamp(c[2] * fine);
    }
  }
}

function renderLinen(buf, R, { base, seed }) {
  const { fbm } = noiseFns(seed);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R, ny = y / R;
      const weave = 0.5 + 0.25 * Math.sin(x * Math.PI / 2) + 0.25 * Math.sin(y * Math.PI / 2);
      const slub = fbm(nx * 8, ny * 8, 3);
      const shade = 0.9 + 0.12 * weave + 0.06 * (slub - 0.5);
      const i = (y * R + x) * 3;
      buf[i] = clamp(base[0] * shade); buf[i + 1] = clamp(base[1] * shade); buf[i + 2] = clamp(base[2] * shade);
    }
  }
}

function renderConcrete(buf, R, { base, seed }) {
  const { fbm, noise2 } = noiseFns(seed);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R, ny = y / R;
      const mott = 0.82 + 0.32 * fbm(nx * 4, ny * 4, 5);
      const speck = noise2(x * 1.7, y * 1.7) > 0.985 ? 0.8 : 1;   // occasional fleck
      const i = (y * R + x) * 3;
      buf[i] = clamp(base[0] * mott * speck);
      buf[i + 1] = clamp(base[1] * mott * speck);
      buf[i + 2] = clamp(base[2] * mott * speck);
    }
  }
}

function renderBokeh(buf, R, { top, bottom, blobs, seed }) {
  const { noise2 } = noiseFns(seed);
  // deterministic pseudo-random from seed
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967295);
  const lights = [];
  for (let b = 0; b < blobs.length; b++) {
    lights.push({ cx: rand(), cy: rand(), r: 0.12 + rand() * 0.22, col: blobs[b], amt: 0.35 + rand() * 0.4 });
  }
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R, ny = y / R;
      let c = mixRgb(top, bottom, smooth(ny));
      for (const L of lights) {
        const dx = nx - L.cx, dy = ny - L.cy;
        const fall = Math.exp(-(dx * dx + dy * dy) / (2 * L.r * L.r));
        const a = fall * L.amt;
        c = [c[0] + L.col[0] * a * 0.6, c[1] + L.col[1] * a * 0.6, c[2] + L.col[2] * a * 0.6];
      }
      const grain = 0.98 + 0.04 * noise2(x, y);
      const i = (y * R + x) * 3;
      buf[i] = clamp(c[0] * grain); buf[i + 1] = clamp(c[1] * grain); buf[i + 2] = clamp(c[2] * grain);
    }
  }
}

function renderSweep(buf, R, { a, b, angle, seed }) {
  const { fbm } = noiseFns(seed);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const nx = x / R - 0.5, ny = y / R - 0.5;
      const t = smooth((nx * ca + ny * sa) + 0.5);
      const paper = 0.98 + 0.05 * (fbm(x / R * 6, y / R * 6, 3) - 0.5);
      const c = mixRgb(a, b, t);
      const i = (y * R + x) * 3;
      buf[i] = clamp(c[0] * paper); buf[i + 1] = clamp(c[1] * paper); buf[i + 2] = clamp(c[2] * paper);
    }
  }
}

// ─── palettes → 100 specs ───────────────────────────────────────────────────────
const MARBLE = [
  ['White',   [244, 242, 238], [178, 172, 160]],
  ['Carrara', [230, 231, 233], [140, 146, 158]],
  ['Noir',    [42, 43, 47],    [120, 124, 132]],
  ['Beige',   [236, 227, 210], [176, 156, 120]],
  ['Rose',    [240, 221, 224], [196, 150, 158]],
  ['Emerald', [214, 228, 216], [96, 132, 108]],
  ['Azure',   [219, 230, 240], [128, 156, 186]],
];
const WOOD = [
  ['Oak',      [206, 170, 120], [150, 110, 66]],
  ['Walnut',   [150, 106, 68],  [86, 56, 34]],
  ['Espresso', [96, 66, 44],    [50, 32, 20]],
  ['Ash Grey', [190, 184, 176], [128, 120, 110]],
  ['Maple',    [224, 194, 150], [180, 140, 92]],
  ['Mahogany', [160, 92, 66],   [96, 46, 34]],
];
const LINEN = [
  ['Ivory',  [238, 232, 220]], ['Oat', [224, 214, 196]], ['Stone', [206, 202, 194]],
  ['Sage',   [206, 214, 198]], ['Mist', [204, 216, 222]], ['Blush', [232, 214, 214]],
  ['Slate',  [176, 184, 196]], ['Sand', [222, 206, 176]],
];
const CONCRETE = [
  ['Grey',      [176, 176, 178]], ['Warm Grey', [188, 180, 170]], ['Pale', [206, 204, 200]],
  ['Charcoal',  [96, 98, 102]],   ['Sandstone', [200, 184, 158]], ['Clay', [188, 156, 138]],
];
const BOKEH = [
  ['Warm Gold', [60, 44, 34], [90, 66, 44], [[255, 214, 150], [255, 180, 120], [255, 236, 200]]],
  ['Cool Blue', [30, 38, 58], [46, 58, 84], [[150, 190, 255], [120, 160, 240], [200, 220, 255]]],
  ['Rose',      [58, 36, 46], [84, 52, 66], [[255, 170, 200], [255, 200, 220], [240, 150, 190]]],
  ['Teal',      [26, 50, 52], [40, 74, 76], [[120, 230, 220], [160, 240, 230], [90, 200, 200]]],
  ['Violet',    [42, 34, 62], [64, 52, 92], [[190, 160, 255], [220, 190, 255], [160, 130, 240]]],
  ['Emerald',   [26, 48, 36], [40, 72, 54], [[140, 230, 170], [180, 245, 200], [110, 210, 150]]],
];
const SWEEP = [
  ['Sunlit',  [255, 244, 228], [236, 200, 168]],
  ['Slate',   [232, 236, 242], [150, 164, 186]],
  ['Peony',   [252, 232, 236], [226, 168, 190]],
  ['Mint',    [232, 244, 236], [160, 206, 182]],
  ['Sky',     [232, 240, 250], [160, 190, 228]],
  ['Sand',    [246, 236, 216], [206, 178, 136]],
  ['Lilac',   [240, 234, 248], [190, 172, 224]],
];

// Build exactly 100 specs, distributed across categories with per-palette seeds.
function buildSpecs() {
  const specs = [];
  const push = (category, key, name, extra) =>
    specs.push({ id: `${category}-${key}`, name, category, ...extra });

  const plan = [
    ['marble', MARBLE, 20], ['wood', WOOD, 18], ['linen', LINEN, 16],
    ['concrete', CONCRETE, 16], ['bokeh', BOKEH, 16], ['sweep', SWEEP, 14],
  ];

  for (const [cat, palettes, count] of plan) {
    for (let n = 0; n < count; n++) {
      const p = palettes[n % palettes.length];
      const variant = Math.floor(n / palettes.length) + 1;
      const seed = (cat.length * 7919 + n * 104729 + 1) >>> 0;
      const key = `${p[0].toLowerCase().replace(/[^a-z0-9]+/g, '')}-${variant}`;
      const nm = `${p[0]} ${cat[0].toUpperCase()}${cat.slice(1)}${variant > 1 ? ' ' + variant : ''}`;
      if (cat === 'marble')   push(cat, key, nm, { render: renderMarble,   args: { base: p[1], vein: p[2], seed } });
      if (cat === 'wood')     push(cat, key, nm, { render: renderWood,     args: { light: p[1], dark: p[2], seed } });
      if (cat === 'linen')    push(cat, key, nm, { render: renderLinen,    args: { base: p[1], seed } });
      if (cat === 'concrete') push(cat, key, nm, { render: renderConcrete, args: { base: p[1], seed } });
      if (cat === 'bokeh')    push(cat, key, nm, { render: renderBokeh,    args: { top: p[1], bottom: p[2], blobs: p[3], seed } });
      if (cat === 'sweep')    push(cat, key, nm, { render: renderSweep,    args: { a: p[1], b: p[2], angle: (n * 1.1) % Math.PI, seed } });
    }
  }
  return specs;
}

/**
 * Generate the 100 procedural scene backdrops (idempotent; skips ones already on
 * disk). Returns the manifest { id: name }.
 * @param {(msg:string)=>void} [log]
 */
export async function ensureScenes(log) {
  await fs.mkdir(SCENES_DIR, { recursive: true });
  const specs = buildSpecs();
  const manifest = {};
  let made = 0;
  for (const spec of specs) {
    manifest[spec.id] = spec.name;
    const full = path.join(SCENES_DIR, `${spec.id}.jpg`);
    try { await fs.access(full); continue; } catch { /* generate */ }
    const buf = Buffer.allocUnsafe(RENDER * RENDER * 3);
    spec.render(buf, RENDER, spec.args);
    await sharp(buf, { raw: { width: RENDER, height: RENDER, channels: 3 } })
      .resize(OUT, OUT, { fit: 'fill' })
      .jpeg({ quality: 88 })
      .toFile(full);
    made++;
    if (log && made % 10 === 0) log(`  …${made} generated`);
  }
  await fs.writeFile(path.join(SCENES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, made, total: specs.length };
}
