import fs from 'fs/promises';
import path from 'path';
import { removeBackground } from './cutout.js';
import { compositeOnBackground } from './composite.js';
import { backgroundPathFor, BG_SIZE } from './backgrounds.js';

// ─── Generate background-swapped variants ─────────────────────────────────────
// Cut the product out ONCE, then composite it onto each chosen background. One
// generated JPEG per background → each later becomes its own listing.

/**
 * @param {Object} args
 * @param {string}   args.heroImagePath  absolute path to the single source photo
 * @param {string[]} args.backgroundIds  chosen plate ids (order preserved)
 * @param {string}   args.outDir         dir to write the generated JPEGs into
 * @param {number}   [args.size=1080]
 * @param {(msg:string)=>void} [args.log]
 * @returns {Promise<Array<{ file:string, name:string, bgId:string }>>}
 */
export async function generateVariants({ heroImagePath, backgroundIds, outDir, size = BG_SIZE, log }) {
  if (!Array.isArray(backgroundIds) || backgroundIds.length === 0) {
    throw new Error('Pick at least one background.');
  }

  // Resolve + validate every background up front so we fail before the (slow)
  // cutout rather than half-way through.
  const plates = [];
  for (const id of backgroundIds) {
    const p = await backgroundPathFor(id);
    if (!p) throw new Error(`Unknown background "${id}".`);
    plates.push({ id, path: p });
  }

  await fs.mkdir(outDir, { recursive: true });

  log?.('✂️  Removing background from your photo…');
  const cutout = await removeBackground(heroImagePath, log);
  log?.('✓ Product cut out. Compositing onto backgrounds…');

  const results = [];
  for (let i = 0; i < plates.length; i++) {
    const { id, path: bgPath } = plates[i];
    const jpeg = await compositeOnBackground(cutout, bgPath, { size });
    const file = path.join(outDir, `gen_${String(i + 1).padStart(2, '0')}_${id}.jpg`);
    await fs.writeFile(file, jpeg);
    results.push({ file, name: path.basename(file), bgId: id });
    log?.(`  ✓ ${i + 1}/${plates.length} · ${id}`);
  }

  return results;
}
