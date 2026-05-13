import fs from 'fs/promises';
import path from 'path';
import { callGeminiJSON } from './client.js';

const SKUS_FILE = path.resolve('data/used_skus.json');

// ─── Field-name → guidance heuristics ───────────────────────────────────────────
function inferGuidance(fieldName) {
  const n = fieldName.toLowerCase();
  if (n.includes('title') || n.includes('name'))
    return 'SEO-optimized product title for Meesho. 50-80 characters. Front-load the most-searched keywords (material, key feature, use-case, size). Use natural phrasing a shopper would type into search. No filler adjectives, no ALL CAPS, no special characters.';
  if (n.includes('description'))
    return 'SEO + GEO optimized product description for Indian Meesho shoppers. STRICT MAX 1300 characters. Lead with 1-2 sentence hook, then short benefit-led bullet points (one per line, no symbols). Naturally weave in: high-intent search keywords (material, size, use-case, room/occasion), India-specific context (suits Indian homes/climate/lifestyle, festive/wedding/daily-use occasions where relevant, common Indian household scenarios), and trust cues (durability, easy care, value). Write for a Tier 2/3 Indian shopper — clear, concrete, no jargon. End with a short closing line.';
  if (n.includes('keyword') || n.includes('tag') || n.includes('search'))
    return 'Comma-separated search keywords (8-12 terms). Lowercase. No duplicates.';
  if (n.includes('material'))   return 'Primary material name (1-3 words).';
  if (n.includes('color') || n.includes('colour')) return 'Primary color (1-2 words).';
  if (n.includes('size') || n.includes('dimension')) return 'Size as it would appear on Meesho (e.g. "16x16 inch", "Free Size").';
  if (n.includes('care'))       return 'Care instructions in 1-2 short sentences.';
  return `Brief, relevant text for "${fieldName}". 1-2 sentences maximum.`;
}

function buildPrompt(aiFields, productDescription) {
  const specs = aiFields
    .map((f) => `- "${f.fieldName}": ${f.aiPrompt || inferGuidance(f.fieldName)}`)
    .join('\n');

  return `You are writing product-listing copy for Meesho, an Indian e-commerce marketplace.

Seller's product description:
"""
${productDescription}
"""

Generate a JSON object containing EXACTLY these keys (and no others). Each value is the text for that field:
${specs}

Rules:
- Plain text only — no markdown, no asterisks, no code fences.
- No emoji.
- Respect any stated character limits.
- Tone: clear, factual, benefit-led, accessible to typical Meesho shoppers.
- Output valid JSON only. No preamble, no explanation.`;
}

/**
 * Generate AI values for all fields with type === 'ai' in a single Gemini call.
 *
 * @param {import('../types/models.js').FieldConfig[]} fields
 * @param {string} productDescription
 * @param {(msg: string) => void} [logFn]   - optional progress callback
 * @returns {Promise<Record<string, string>>}
 */
export async function generateFields(fields, productDescription, logFn) {
  const aiFields = fields.filter((f) => f.type === 'ai');
  if (aiFields.length === 0) return {};

  if (!productDescription || productDescription.trim().length < 5) {
    throw new Error('Product description is required for AI field generation (5+ chars).');
  }

  const prompt = buildPrompt(aiFields, productDescription);
  const parsed = await callGeminiJSON(prompt, { temperature: 0.7, log: logFn });

  const missing = aiFields.filter((f) => !(f.fieldName in parsed));
  if (missing.length > 0) {
    throw new Error(`Gemini did not return values for: ${missing.map((f) => f.fieldName).join(', ')}`);
  }

  const out = {};
  for (const f of aiFields) {
    const v = parsed[f.fieldName];
    out[f.fieldName] = Array.isArray(v) ? v.join(', ') : String(v).trim();
  }
  return out;
}

/**
 * Generate a unique SKU from a pattern containing "X" as the random-digits placeholder.
 *
 * Example:  generateSKU("WH_FURR/X")  →  "WH_FURR/56483"
 *
 * @param {string} pattern
 * @returns {Promise<string>}
 */
export async function generateSKU(pattern) {
  if (!pattern || !pattern.includes('X')) {
    throw new Error('SKU pattern must contain the placeholder character X.');
  }

  const used = await loadUsedSkus();
  const usedSet = new Set(used);

  for (let i = 0; i < 50; i++) {
    const random = Math.floor(10_000 + Math.random() * 90_000);
    const sku = pattern.replace('X', String(random));
    if (!usedSet.has(sku)) {
      used.push(sku);
      await saveUsedSkus(used);
      return sku;
    }
  }

  throw new Error(
    `Could not generate a unique SKU after 50 attempts for pattern "${pattern}". ` +
    `Consider a longer numeric placeholder or a different prefix.`
  );
}

async function loadUsedSkus() {
  try {
    const raw = await fs.readFile(SKUS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function saveUsedSkus(list) {
  await fs.mkdir(path.dirname(SKUS_FILE), { recursive: true });
  await fs.writeFile(SKUS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
