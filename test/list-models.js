// Lists every Gemini model your API key can access.
// Use this when generation fails to figure out which models to try.
//
// Run with:  node test/list-models.js

import 'dotenv/config';

const key = process.env.GEMINI_API_KEY;
if (!key || key === 'your_gemini_api_key_here') {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;

try {
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    console.error(`API returned ${res.status}:`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const models = (data.models || []).filter(
    (m) => m.supportedGenerationMethods?.includes('generateContent')
  );

  if (models.length === 0) {
    console.log('⚠ No models support generateContent on your API key.');
    console.log('  Visit https://aistudio.google.com/app/apikey to enable models.');
    process.exit(0);
  }

  console.log(`Models accessible to your API key (${models.length}):\n`);
  for (const m of models) {
    const name = m.name.replace('models/', '');
    const limit = m.inputTokenLimit ? ` (in:${m.inputTokenLimit.toLocaleString()})` : '';
    console.log(`  ${name.padEnd(40)} ${m.displayName || ''}${limit}`);
  }

  // Highlight which to try — prefer lite variants (highest free-tier daily quota).
  const names = models.map((m) => m.name.replace('models/', ''));
  const liteFlash = names.filter((n) => /flash-lite/i.test(n) && !/preview|tts|image/i.test(n));
  const flash = names.filter((n) => /flash/i.test(n) && !/lite|preview|tts|image/i.test(n));
  const recommended = liteFlash[0] || flash[0];
  if (recommended) {
    console.log(`\n💡 Recommended for this app — set in .env:\n`);
    console.log(`   GEMINI_MODEL=${recommended}`);
    if (liteFlash[0]) {
      console.log(`\n   (lite variants give the highest free-tier daily quota — ~1500 req/day)`);
    }
  }
} catch (err) {
  console.error('Failed to query Gemini API:', err.message);
  process.exit(1);
}
