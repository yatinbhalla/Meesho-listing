// Tests SKU generation + deduplication. No API key needed.
//
// Run with:  node test/test-sku.js

import { generateSKU } from '../src/ai/generator.js';
import fs from 'fs/promises';
import path from 'path';

const SKUS_FILE = path.resolve('data/used_skus.json');

async function main() {
  // Snapshot whatever's already in used_skus.json so the test is non-destructive.
  let original;
  try { original = await fs.readFile(SKUS_FILE, 'utf8'); } catch { original = '[]'; }

  try {
    console.log('Generating 5 SKUs from pattern "TEST/X"...');
    const generated = [];
    for (let i = 0; i < 5; i++) {
      const sku = await generateSKU('TEST/X');
      console.log('  →', sku);
      generated.push(sku);
    }

    // Verify uniqueness
    const unique = new Set(generated);
    if (unique.size !== generated.length) {
      throw new Error('Duplicate SKU generated!');
    }
    console.log('✓ All 5 are unique.');

    // Verify pattern shape
    for (const sku of generated) {
      if (!/^TEST\/\d{5}$/.test(sku)) throw new Error(`Bad shape: ${sku}`);
    }
    console.log('✓ All match TEST/##### shape.');

    // Verify they were persisted
    const persisted = JSON.parse(await fs.readFile(SKUS_FILE, 'utf8'));
    for (const sku of generated) {
      if (!persisted.includes(sku)) throw new Error(`${sku} not persisted to disk.`);
    }
    console.log('✓ All persisted to data/used_skus.json.');

    // Verify pattern without X is rejected
    try {
      await generateSKU('NO_PLACEHOLDER');
      throw new Error('Should have thrown — pattern has no X.');
    } catch (e) {
      if (!e.message.includes('placeholder')) throw e;
      console.log('✓ Rejects pattern without X.');
    }

    console.log('\n✅ All SKU tests passed.');
  } finally {
    // Restore original used_skus.json
    await fs.writeFile(SKUS_FILE, original, 'utf8');
    console.log('(restored data/used_skus.json to its previous state)');
  }
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
