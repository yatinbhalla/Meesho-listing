import sharp from 'sharp';

// ─── Composite a cutout onto a background ─────────────────────────────────────
// Places the transparent product PNG, centred with a margin, on a background
// plate — producing a square listing image. Cheap: pure sharp resize + composite,
// milliseconds each.

/**
 * @param {Buffer} cutoutPng     RGBA PNG from removeBackground()
 * @param {string} backgroundPath absolute path to a 1080² (or any) plate
 * @param {Object} [opts]
 * @param {number} [opts.size=1080]      output square edge
 * @param {number} [opts.marginPct=0.08] empty margin around the product (fraction of edge)
 * @param {number} [opts.quality=90]     JPEG quality
 * @returns {Promise<Buffer>}  a JPEG buffer
 */
export async function compositeOnBackground(cutoutPng, backgroundPath, opts = {}) {
  const { size = 1080, marginPct = 0.08, quality = 90 } = opts;

  const bg = sharp(backgroundPath).resize(size, size, { fit: 'cover', position: 'centre' });

  // Trim the transparent border so the product fills the frame consistently
  // regardless of how much empty space the original photo had. If trim finds
  // nothing to cut (rare), fall back to the untrimmed cutout.
  let fgPipeline = sharp(cutoutPng);
  try {
    const trimmed = await sharp(cutoutPng).trim().toBuffer();
    fgPipeline = sharp(trimmed);
  } catch { /* keep untrimmed */ }

  const box = Math.round(size * (1 - 2 * marginPct));
  const fg = await fgPipeline
    .resize(box, box, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  const { width: fw, height: fh } = await sharp(fg).metadata();
  const left = Math.round((size - fw) / 2);
  const top = Math.round((size - fh) / 2);

  return bg
    .composite([{ input: fg, left, top }])
    .jpeg({ quality })
    .toBuffer();
}
