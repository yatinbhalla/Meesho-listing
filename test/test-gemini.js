// Live test for Gemini field generation. Requires GEMINI_API_KEY in .env.
//
// Run with:  node test/test-gemini.js

import 'dotenv/config';
import { generateFields } from '../src/ai/generator.js';

const fields = [
  { fieldName: 'Product Title',    selector: '#title',    type: 'ai' },
  { fieldName: 'Description',      selector: '#desc',     type: 'ai' },
  { fieldName: 'Search Keywords',  selector: '#keywords', type: 'ai' },
  { fieldName: 'Material',         selector: '#material', type: 'ai' },
  { fieldName: 'SKU',              selector: '#sku',      type: 'sku' },     // skipped
  { fieldName: 'MRP',              selector: '#mrp',      type: 'fixed', fixedValue: '599' },  // skipped
];

const description = 'White faux fur cushion cover, 16x16 inch, soft texture, machine washable, perfect for sofa decor.';

async function main() {
  console.log('Calling Gemini for', fields.filter((f) => f.type === 'ai').length, 'AI fields...\n');
  const t = Date.now();
  const out = await generateFields(fields, description);
  const elapsed = ((Date.now() - t) / 1000).toFixed(2);

  console.log(`✓ Generated in ${elapsed}s\n`);
  for (const [name, value] of Object.entries(out)) {
    console.log(`── ${name} ${'─'.repeat(Math.max(0, 40 - name.length))}`);
    console.log(value);
    console.log();
  }
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
