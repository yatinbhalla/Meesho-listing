import path from 'path';
import sharp from 'sharp';
import { env, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

// ─── Product cutout (background removal) ──────────────────────────────────────
// Runs the RMBG-1.4 segmentation model fully locally via Transformers.js
// (Apache-2.0). The model weights (briaai/RMBG-1.4) are non-commercial-licensed,
// which matches this app's own PolyForm-Noncommercial license. First use
// downloads ~170 MB to data/.models; afterwards it's offline.
//
// This is the only "heavy" step in the generate flow and it runs ONCE per batch,
// no matter how many background variants the user asks for.

// Prefer a locally-staged copy of the model (data/.models-local/briaai/RMBG-1.4)
// so a flaky connection to the Hugging Face hub doesn't block generation; fall
// back to a remote download (cached under data/.models) when it isn't present.
env.localModelPath = path.resolve('data/.models-local');
env.cacheDir = path.resolve('data/.models');
env.allowLocalModels = true;
env.allowRemoteModels = true;

const MODEL_ID = 'briaai/RMBG-1.4';
// Quantized (q8) by default: ~44 MB download and much faster CPU inference on
// modest hardware, with solid mask quality for product cutouts. Set
// RMBG_DTYPE=fp32 for maximum edge fidelity at the cost of size/speed.
const DTYPE = process.env.RMBG_DTYPE || 'q8';
let _ready = null;   // cached { model, processor } promise — loaded once per process

function load(log) {
  if (_ready) return _ready;
  _ready = (async () => {
    log?.(`⏳ Loading background-removal model (${DTYPE}; first run downloads once, then cached)…`);
    const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE });
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    log?.('✓ Model ready.');
    return { model, processor };
  })().catch((err) => {
    _ready = null;   // allow a retry on the next call after a transient download failure
    throw err;
  });
  return _ready;
}

/**
 * Remove the background from a product photo.
 * @param {string} inputPath  absolute path to the source image
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<Buffer>}  a PNG buffer (RGBA) — the product on transparency
 */
export async function removeBackground(inputPath, log) {
  const { model, processor } = await load(log);

  // Let Transformers.js decode the image; the mask we build is resized back to
  // this same object's dimensions, so pixels and mask stay perfectly aligned.
  const image = await RawImage.read(inputPath);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  // output[0] is a [1,H,W] mask in 0..1 → scale to 0..255 and back to full size.
  const maskRaw = await RawImage.fromTensor(output[0].mul(255).to('uint8'));
  const mask = await maskRaw.resize(image.width, image.height);   // resize is async
  const alpha = mask.data;   // Uint8Array, length width*height

  // Stitch the alpha channel onto the original RGB pixels (image.channels may be
  // 3 or 4; we read the first three either way).
  const { width, height, channels, data } = image;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    rgba[p * 4]     = data[s];
    rgba[p * 4 + 1] = data[s + 1];
    rgba[p * 4 + 2] = data[s + 2];
    rgba[p * 4 + 3] = alpha[p];
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
