// Smoke test for AI navigation. Requires GEMINI_API_KEY in .env.
//
// Loads the local mock-form.html in a real Chromium, deliberately gives the
// navigator a broken selector for the Submit button, and verifies that
// Gemini suggests a working one.
//
// Run with:  node test/test-navigator.js

import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import { pathToFileURL } from 'url';
import { findElementWithAI } from '../src/ai/navigator.js';

const FORM_URL = pathToFileURL(path.resolve('test/mock-form.html')).href;

async function main() {
  console.log('Launching plain Chromium...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(FORM_URL);
  console.log('✓ Mock form loaded.\n');

  // Deliberately broken selector — points at the 99th div, which doesn't exist.
  // Recorded intent says we wanted to click "Submit Listing".
  const brokenStep = {
    action: 'click',
    selector: 'div:nth-of-type(99) > button.nope-fake-class',
    label: 'Submit Listing',
  };

  const log = (type, text) => console.log(`  [${type}] ${text}`);

  console.log('Calling findElementWithAI on a deliberately broken Submit selector...');
  console.log('  Intent: "Submit Listing"');
  console.log('  Broken selector:', brokenStep.selector);
  console.log();

  const t0 = Date.now();
  const result = await findElementWithAI({ page, step: brokenStep, log });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  if (!result) {
    console.error(`\n❌ AI returned null after ${elapsed}s.`);
    await browser.close();
    process.exit(1);
  }

  console.log(`\n✓ AI returned in ${elapsed}s`);
  console.log('  Suggested selector:', result.selector);
  console.log('  Reason:            ', result.reason);

  // Verify the suggested selector actually works.
  console.log('\nVerifying the AI-suggested selector by clicking it...');
  try {
    await page.locator(result.selector).first().click({ timeout: 5000 });
    // The mock form populates #output after submit click.
    await page.waitForSelector('#output:not([hidden])', { timeout: 3000 });
    const out = await page.locator('#output').textContent();
    if (out && out.includes('Submitted')) {
      console.log('✓ Click succeeded. Mock form output:');
      console.log('  ', out.split('\n')[0]);
      console.log('\n✅ Navigator smoke test passed.');
    } else {
      console.error('❌ Click ran but form did not show submitted output.');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ AI-suggested selector did not produce a working click:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
