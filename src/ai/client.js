import { GoogleGenerativeAI } from '@google/generative-ai';

// WHY: Free-tier model availability varies by account/region. We try the list
// in order until one works, then cache the winner for the rest of the session.
// Lite variants come first because they have the most generous free quota
// (~1500 RPD vs ~250 for flash and ~100 for pro).
const MODEL_FALLBACK = [
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

const MAX_RETRIES = 2;

let _client = null;
let _workingModel = null;     // cached after first successful call

function getClient() {
  if (_client) return _client;
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY is missing from .env. Get one at https://aistudio.google.com/app/apikey');
  }
  _client = new GoogleGenerativeAI(key);
  return _client;
}

/**
 * Call Gemini with a JSON-output prompt. Tries the fallback model chain until
 * one accepts the request. Returns parsed JSON.
 *
 * @param {string} prompt
 * @param {Object} [opts]
 * @param {number} [opts.temperature]  default 0.7
 * @param {(msg: string) => void} [opts.log]  progress callback (logs which model is being tried)
 * @returns {Promise<any>}  parsed JSON response
 */
export async function callGeminiJSON(prompt, opts = {}) {
  const log = (m) => opts.log ? opts.log(m) : null;
  const client = getClient();

  // Build candidate list: cached winner first, then user override, then fallback chain.
  const userOverride = process.env.GEMINI_MODEL;
  const candidates = [];
  if (_workingModel) candidates.push(_workingModel);
  if (userOverride && !candidates.includes(userOverride)) candidates.push(userOverride);
  for (const m of MODEL_FALLBACK) if (!candidates.includes(m)) candidates.push(m);

  let lastErr;
  for (const modelName of candidates) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: opts.temperature ?? 0.7,
        },
      });

      const text = await callWithRetry(model, prompt);

      if (_workingModel !== modelName) {
        log(`✓ Using model: ${modelName}`);
        _workingModel = modelName;
      }

      return parseJSON(text);
    } catch (err) {
      lastErr = err;
      if (err.code === 'MODEL_NOT_ACCESSIBLE') {
        log(`⚠ ${modelName} not accessible — trying next…`);
        continue;
      }
      throw new Error(friendlyGeminiError(err));
    }
  }

  throw new Error(
    `None of these Gemini models were accessible for your API key:\n  ${candidates.join('\n  ')}\n\n` +
    `Run "node test/list-models.js" to see exactly which models your key supports, ` +
    `then set GEMINI_MODEL in .env to one of them.`
  );
}

/**
 * Call one model with retry on transient 429s. Throws a tagged
 * MODEL_NOT_ACCESSIBLE error for permanent "this model isn't yours" failures
 * so the fallback loop can move on.
 */
async function callWithRetry(model, prompt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);

      // Permanent: model is not enabled for this account/region.
      if (msg.includes('404') || /not found/i.test(msg) || /limit:\s*0/.test(msg)) {
        const tagged = new Error(msg);
        tagged.code = 'MODEL_NOT_ACCESSIBLE';
        throw tagged;
      }

      // Transient: real rate limit. Retry with the suggested delay.
      const is429 = msg.includes('429') || /quota/i.test(msg) || /rate/i.test(msg);
      if (!is429 || attempt === MAX_RETRIES) break;

      const m = msg.match(/retry in ([\d.]+)s/i);
      const delaySec = m ? Math.min(parseFloat(m[1]) + 0.5, 30) : Math.pow(2, attempt + 1);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
  throw lastErr;
}

// Defensive code-fence stripping in case the model ignores the JSON-only rule.
function parseJSON(text) {
  try { return JSON.parse(text); }
  catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(stripped);
  }
}

function friendlyGeminiError(err) {
  const msg = String(err.message || err);
  if (msg.includes('API key') || msg.includes('401') || msg.includes('403')) {
    return 'Gemini API key is invalid or unauthorized. Double-check GEMINI_API_KEY in .env.';
  }
  if (msg.includes('429') || /quota/i.test(msg)) {
    return 'Gemini rate limit hit and retries exhausted. Wait a minute, then try again.';
  }
  return msg;
}
