// Smoke test for the executor — uses the local mock-form.html instead of Meesho.
// Bypasses session.js so no .env credentials are needed.
//
// Run with:  node test/test-executor.js

import { chromium } from 'playwright';
import { EventEmitter } from 'events';
import path from 'path';
import { pathToFileURL } from 'url';

const FORM_URL = pathToFileURL(path.resolve('test/mock-form.html')).href;

// A fake hero image — we'll just upload this file as a stand-in.
const FAKE_IMAGE = path.resolve('test/mock-form.html');  // any existing file works

/** @type {import('../src/types/models.js').PathConfig} */
const mockConfig = {
  name: 'Smoke Test',
  skuPattern: 'TEST/X',
  productDescription: 'Test product',
  fields: [
    { fieldName: 'Product Title', selector: '#title',       type: 'ai' },
    { fieldName: 'SKU',           selector: '#sku',         type: 'sku' },
    { fieldName: 'Description',   selector: '#description', type: 'ai' },
    { fieldName: 'Hero',          selector: '#hero',        type: 'image' },
    { fieldName: 'Image 2',       selector: '#img2',        type: 'image' },
  ],
  steps: [
    { action: 'navigate', value: FORM_URL,                                label: 'Open mock form' },
    { action: 'fill',     selector: '#title',       fieldRef: 0,          label: 'Fill title' },
    { action: 'fill',     selector: '#sku',         fieldRef: 1,          label: 'Fill SKU' },
    { action: 'fill',     selector: '#description', fieldRef: 2,          label: 'Fill description' },
    { action: 'select',   selector: '#category',    value: 'Cushion Cover', label: 'Select category' },
    { action: 'fill',     selector: '#hero',        fieldRef: 3,          label: 'Upload hero' },
    { action: 'fill',     selector: '#img2',        fieldRef: 4,          label: 'Upload image 2' },
    { action: 'click',    selector: '#submit',                            label: 'Click Submit' },
  ],
  sharedImages: ['img2.jpg', 'img3.jpg', 'img4.jpg'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── Run ────────────────────────────────────────────────────────────────────────
// We can't import executor.js directly because it calls getSession() (which needs
// Meesho creds). Instead we copy the core loop here against a plain Chromium.

async function main() {
  console.log('Launching plain Chromium...');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  let imageSlot = 0;
  for (let i = 0; i < mockConfig.steps.length; i++) {
    const step = mockConfig.steps[i];
    console.log(`[${i + 1}/${mockConfig.steps.length}] ${step.label}`);

    if (step.action === 'navigate') {
      await page.goto(step.value);
    } else if (step.action === 'click') {
      await page.click(step.selector);
    } else if (step.action === 'select') {
      await page.selectOption(step.selector, { label: step.value });
    } else if (step.action === 'fill') {
      const field = mockConfig.fields[step.fieldRef];
      if (field.type === 'image') {
        await page.setInputFiles(field.selector, FAKE_IMAGE);
        imageSlot++;
      } else if (field.type === 'sku') {
        await page.fill(field.selector, 'TEST/12345');
      } else if (field.type === 'ai') {
        await page.fill(field.selector, `[AI value for ${field.fieldName}]`);
      } else {
        await page.fill(field.selector, field.fixedValue || '');
      }
    }
    await page.waitForTimeout(400);
  }

  console.log('\n✓ Smoke test completed. Browser left open — check the form output.');
  console.log('Press Ctrl+C to exit.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
