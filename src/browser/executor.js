import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { getSession } from './session.js';
import { findElementWithAI } from '../ai/navigator.js';

const MAX_RETRIES = 3;

// WHY: floor-delay between steps for React's batched re-renders to flush.
// The HEAVY waiting (DOM-load, target-element-attached) is dynamic — see
// waitForReady(). This is just a tiny settle so animations/transitions complete.
const SETTLE_MS = 250;

// How long to wait for the next step's target element to appear in the DOM
// before giving up and letting smartClick / fill handle the failure.
const READY_TIMEOUT_MS = 15_000;

/**
 * Replay a recorded PathConfig with computed field values.
 * Emits live progress over the returned EventEmitter.
 *
 *   .on('log',   ({type, text}) => …)
 *   .on('done',  (result)        => …)
 *   .on('error', (err)           => …)
 *
 * @param {Object}   args
 * @param {import('../types/models.js').PathConfig} args.pathConfig
 * @param {string}   args.heroImagePath   - Absolute path to the per-listing hero image
 * @param {string}   args.pathDir         - Path config's directory (for shared_images/)
 * @param {Object}   args.aiValues        - { fieldName: generatedText } for type='ai' fields
 * @param {string}   args.sku             - Generated SKU (e.g. "WH_FURR/56483")
 * @param {import('playwright').Page} [args.page] - Optional pre-opened page. When passed,
 *   executor reuses the existing browser session instead of opening a new one. Used by
 *   batch mode in run.js so all listings in a batch share one Chromium window.
 * @returns {EventEmitter}
 */
export function executeRun({ pathConfig, heroImagePath, pathDir, aiValues = {}, sku = '', page = null }) {
  const emitter = new EventEmitter();
  const log = (type, text) => emitter.emit('log', { type, text });

  process.nextTick(() => runFlow().catch((err) => {
    log('error', err.message);
    emitter.emit('error', err);
  }));

  async function runFlow() {
    log('info', '🚀 Starting listing automation...');

    // Reuse the caller's page if provided, otherwise open a fresh session.
    const activePage = page || (await getSession((m) => log('info', m))).page;

    // imageSlot resets on every call — first image filled is always the hero.
    // imageFieldCount lets fillField decide whether a non-hero image input is
    // the single "Add more" multi-file input (→ upload all shared images at
    // once) or one of several discrete slots (→ one image each).
    const imageFieldCount = (pathConfig.fields || []).filter((f) => f.type === 'image').length;
    const ctx = { page: activePage, pathConfig, pathDir, heroImagePath, aiValues, sku, log, imageSlot: 0, imageFieldCount };

    // Tracks whether the steps we're about to replay are part of the recorded
    // login flow. When the persistent profile is already logged in, the browser
    // opens straight at /panel/... and replaying login-form clicks/fills would
    // fail. We skip them and resume at the first post-login navigate.
    let inLoginFlow = false;
    let skipped = 0;

    for (let i = 0; i < pathConfig.steps.length; i++) {
      const step = pathConfig.steps[i];
      const progress = `[${i + 1}/${pathConfig.steps.length}]`;

      // ─── Wait for any in-flight redirect to settle BEFORE skip-check ──────
      // WHY: page.goto({waitUntil:'domcontentloaded'}) returns before client-side
      // redirects complete. After a navigate-to-login on a logged-in profile,
      // Meesho flips the URL from /login → /panel/... a beat later. Without
      // this wait, the next step's skip-check sees the stale /login URL and
      // wrongly tries to interact with the login form on what's now the dashboard.
      // We only do this wait when the PREVIOUS step targeted a login URL — that's
      // the exact moment a "logged in → silently bounced past login" redirect
      // can happen. Otherwise we'd waste time on every step.
      const prev = i > 0 ? pathConfig.steps[i - 1] : null;
      if (prev && prev.action === 'navigate' && isLoginUrl(prev.value)) {
        await activePage.waitForFunction(
          () => !/\b(auth|login|signin|signup)\b/i.test(window.location.href),
          null,
          { timeout: 4000 },
        ).catch(() => {});   // Times out cleanly if we're genuinely on a login page
                              //  (i.e. not logged in) — we then fall through and
                              //  interact with the login form normally.
      }

      // ─── Skip about:blank navigates (recorder noise) ──────────────────────
      // The recorder occasionally captures intermediate about:blank navigations
      // when the page transitions through SPA routing. They're no-ops at best
      // and waste 3+ seconds each at worst. Always skip.
      if (step.action === 'navigate' && /^about:blank/i.test(step.value || '')) {
        log('info', `${progress} ⏭  Skipping about:blank navigate (recorder noise).`);
        skipped++;
        continue;
      }

      // ─── Skip-login-when-already-logged-in ────────────────────────────────
      if (step.action === 'navigate') {
        const targetIsLogin = isLoginUrl(step.value);
        if (targetIsLogin && isPostLoginUrl(activePage.url())) {
          log('info', `${progress} ⏭  Already logged in — skipping nav to login (${step.label}).`);
          inLoginFlow = true;
          skipped++;
          continue;
        }
        inLoginFlow = targetIsLogin;
      } else if (inLoginFlow && isPostLoginUrl(activePage.url())) {
        log('info', `${progress} ⏭  Skipping login-form ${step.action} (already logged in).`);
        skipped++;
        continue;
      }

      log('info', `${progress} ${stepLabel(step)}`);

      // Active readiness check — replaces the old fixed delay.
      await waitForReady(activePage, step, log);

      try {
        await runStepWithRetry(step, i, ctx);
      } catch (e) {
        log('error', `Step "${step.label}" failed permanently: ${e.message}`);
        throw e;
      }
    }

    if (skipped > 0) {
      log('info', `(skipped ${skipped} login-flow step${skipped === 1 ? '' : 's'} — session restored from previous login)`);
    }
    if (ctx.aiNavCount > 0) {
      log('info', `(🤖 AI navigation rescued ${ctx.aiNavCount} step${ctx.aiNavCount === 1 ? '' : 's'} — selectors persisted to path config)`);
    }

    log('success', '✓ All steps completed. Form is filled — review and submit in the browser.');
    emitter.emit('done', { sku });
    // Browser stays open so the user can verify and submit.
  }

  return emitter;
}

function stepLabel(step) {
  const icon = { navigate: '📍', click: '👆', select: '📋', fill: '📝', wait: '⏱' }[step.action] || '•';
  return `${icon} ${step.label || step.action}`;
}

/**
 * Run a single step. Retries on transient failures, then offers recovery
 * (user clicks the correct element in the browser) for permanent selector breaks.
 */
async function runStepWithRetry(step, stepIndex, ctx) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await executeStep(step, ctx);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = 500 * Math.pow(2, attempt);
        ctx.log('info', `  ↻ retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms (${e.message.slice(0, 80)})`);
        await ctx.page.waitForTimeout(delay);
      }
    }
  }

  // Retries exhausted — try recovery if this step has a selector to update.
  if (!step.selector) throw lastErr;

  ctx.log('error', `Selector failed: ${step.selector}`);

  // ─── Try AI navigation BEFORE prompting the user for manual recovery ─────
  // Falls back cleanly to the recovery overlay if AI declines, errors, or
  // suggests a selector that still doesn't work.
  const aiEnabled = process.env.AI_NAVIGATION_ENABLED !== 'false';
  if (aiEnabled && step.selector) {
    const aiResult = await findElementWithAI({
      page: ctx.page,
      step,
      log: ctx.log,
    });

    // Guard: if AI returns the exact selector that just failed, retrying it is
    // pointless (it'll fail identically). Skip straight to manual recovery.
    if (aiResult?.selector && aiResult.selector === step.selector) {
      ctx.log('info', '🤖 AI suggested the same selector that just failed — going to manual recovery.');
    } else if (aiResult?.selector) {
      ctx.log('success', `🤖 ✓ AI suggested: ${aiResult.selector}${aiResult.reason ? ` — ${aiResult.reason}` : ''}`);
      const aiSelector = aiResult.selector;

      // Try the step once with the AI-suggested selector. If it works, persist it.
      const prevSelector = step.selector;
      step.selector = aiSelector;
      try {
        await executeStep(step, ctx);
        // Success — also sync field.selector for fill steps and write to disk.
        if (step.action === 'fill' && step.fieldRef != null && ctx.pathConfig.fields[step.fieldRef]) {
          ctx.pathConfig.fields[step.fieldRef].selector = aiSelector;
        }
        await persistConfig(ctx.pathConfig, ctx.pathDir);
        ctx.log('info', '💾 Saved AI-corrected selector to path config.');
        ctx.aiNavCount = (ctx.aiNavCount || 0) + 1;
        return;
      } catch (aiErr) {
        // AI's pick also failed — restore the original selector so the
        // recovery overlay still shows the user what went wrong, then fall
        // through to the manual flow.
        step.selector = prevSelector;
        ctx.log('info', `🤖 AI's pick failed too (${aiErr.message.slice(0, 80)}) — falling back to manual recovery.`);
      }
    }
  }

  ctx.log('info', '⏸  Pausing for recovery — switch to the browser window.');
  const newSelector = await requestRecovery(ctx.page, step);
  if (!newSelector) {
    throw new Error(`Recovery cancelled for "${step.label}".`);
  }

  ctx.log('success', `✓ New selector captured: ${newSelector}`);
  step.selector = newSelector;
  if (step.action === 'fill' && step.fieldRef != null && ctx.pathConfig.fields[step.fieldRef]) {
    ctx.pathConfig.fields[step.fieldRef].selector = newSelector;
  }

  await persistConfig(ctx.pathConfig, ctx.pathDir);
  ctx.log('info', '💾 Saved updated path config.');

  await executeStep(step, ctx);
}

async function executeStep(step, ctx) {
  const { page } = ctx;

  if (step.action === 'navigate') {
    await page.goto(step.value, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return;
  }
  if (step.action === 'click') {
    // Skip clicks on file inputs — they're usually hidden behind a styled
    // button, so clicking fails ("element not visible"). The upload is handled
    // by the subsequent fill step (setInputFiles works on hidden inputs).
    const isFileInput = await page.locator(step.selector).first()
      .evaluate((el) => el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file')
      .catch(() => false);
    if (isFileInput) {
      ctx.log('info', `↪ ${step.label}: file input — upload handled by the fill step, skipping click.`);
      return;
    }
    await smartClick(page, step.selector, step.label);
    return;
  }
  if (step.action === 'select') {
    await page.selectOption(step.selector, { label: step.value })
      .catch(() => page.selectOption(step.selector, step.value));
    return;
  }
  if (step.action === 'wait') {
    await page.waitForTimeout(Number(step.value) || 1000);
    return;
  }
  if (step.action === 'fill') {
    const field = ctx.pathConfig.fields[step.fieldRef];
    if (!field) throw new Error(`Field index ${step.fieldRef} not found in path config.`);
    await fillField(page, field, ctx);
    if (field.type === 'image') ctx.imageSlot++;
    return;
  }
  throw new Error(`Unknown step action: ${step.action}`);
}

/**
 * Wait for the page (and the next step's target) to be ready before we act.
 *
 * Replaces the old fixed 2-second delay between steps with active checks:
 *   1. Wait for the document to be at least DOMContentLoaded.
 *   2. Wait for any in-flight network requests to settle (best-effort).
 *   3. If the step has a selector, wait for that element to be attached
 *      to the DOM. This is the BIG win — instead of guessing how long
 *      Meesho's React form needs to render, we wait until it's actually there.
 *   4. Tiny settle for animations / batched re-renders.
 */
async function waitForReady(page, step, log) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Best-effort networkidle — bounded so a long-polling Meesho widget
  // doesn't stall us forever.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  if (step.selector && step.action !== 'navigate') {
    try {
      await page.waitForSelector(step.selector, {
        state: 'attached',
        timeout: READY_TIMEOUT_MS,
      });
    } catch {
      // Don't throw here — let the step itself handle the missing-selector
      // case (which has its own retry + recovery flow).
      log('info', `  ⌛ ${step.selector} didn't appear within ${READY_TIMEOUT_MS}ms — continuing anyway.`);
    }
  }

  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Click that survives Meesho's floating-label wrappers, React-Select dropdown
 * options, and delayed renders. Fallback ladder:
 *
 *   1. Normal click (Playwright auto-waits for visible/stable/no-overlay).
 *   2. If overlay is intercepting → scroll into view, then force-click.
 *   3. If element wasn't found in time → try matching an OPEN dropdown option
 *      by its visible text/role (most Meesho fields are React-Select dropdowns,
 *      whose option DOM is positional and brittle but whose accessible name is
 *      stable). Then fall back to wait + force-click.
 *
 * @param {string} [label] - the recorded step label (option text), used for the
 *   role/text-based dropdown-option fallback.
 */
async function smartClick(page, selector, label = '') {
  const locator = page.locator(selector).first();

  try {
    await locator.click({ timeout: 8000 });
    return;
  } catch (e) {
    const msg = String(e.message || '');

    // Overlay / pointer-events case — element is found but blocked.
    if (/intercept|pointer events|not stable|outside.*viewport|covers/i.test(msg)) {
      try { await locator.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
      await locator.click({ timeout: 5000, force: true });
      return;
    }

    // Element not found in time — likely a React-Select option whose recorded
    // positional selector no longer matches. Try selecting by accessible
    // name / visible text within the currently-open dropdown.
    if (/Timeout|waiting for/i.test(msg)) {
      if (await clickOptionByText(page, label)) return;

      await page.waitForTimeout(1500);
      try { await locator.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
      await locator.click({ timeout: 5000, force: true });
      return;
    }

    throw e;
  }
}

/**
 * Click a visible dropdown option by its text. Tries, in order:
 *   role=option (exact) → role=option (substring) → listitem → any exact-text node.
 * Returns true if a visible match was clicked. Used to make React-Select option
 * selection robust against brittle positional selectors — no AI call needed.
 */
async function clickOptionByText(page, label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 60) return false;

  const candidates = [
    page.getByRole('option', { name: text, exact: true }),
    page.getByRole('option', { name: text }),
    page.getByRole('menuitemradio', { name: text, exact: true }),
    page.locator('[role="option"]', { hasText: text }),
    page.locator('li', { hasText: text }),
  ];

  for (const c of candidates) {
    const first = c.first();
    if (await first.isVisible({ timeout: 1000 }).catch(() => false)) {
      try {
        await first.scrollIntoViewIfNeeded({ timeout: 1000 });
        await first.click({ timeout: 3000 });
        return true;
      } catch { /* try next candidate */ }
    }
  }
  return false;
}

async function fillField(page, field, ctx) {
  const { heroImagePath, pathDir, aiValues, sku, imageSlot, log } = ctx;

  if (field.type === 'image') {
    const sharedDir = path.join(pathDir, 'shared_images');
    const sharedFiles = ['img2.jpg', 'img3.jpg', 'img4.jpg'].map((f) => path.join(sharedDir, f));

    if (imageSlot === 0) {
      // Hero — the unique per-listing photo.
      log('info', `🖼  Uploading hero image: ${path.basename(heroImagePath)}`);
      await page.setInputFiles(field.selector, heroImagePath);
      return;
    }

    // Non-hero image input. Meesho's "Add more images" input accepts MULTIPLE
    // files at once. If the path has only one extra image input (the common
    // case: hero + "add more"), push ALL shared images to it in a single
    // setInputFiles call — otherwise only img2 would ever upload.
    if (ctx.imageFieldCount <= 2) {
      const present = [];
      for (const f of sharedFiles) {
        try { await fs.access(f); present.push(f); } catch { /* skip missing */ }
      }
      const files = present.length ? present : sharedFiles;
      log('info', `🖼  Uploading ${files.length} shared image(s): ${files.map((f) => path.basename(f)).join(', ')}`);
      await page.setInputFiles(field.selector, files);
    } else {
      // Multiple discrete image slots — one shared image per slot.
      const file = path.join(sharedDir, `img${imageSlot + 1}.jpg`);
      log('info', `🖼  Uploading image #${imageSlot + 1}: ${path.basename(file)}`);
      await page.setInputFiles(field.selector, file);
    }
    return;
  }

  let value;
  if (field.type === 'sku') {
    value = sku;
    log('info', `🏷  ${field.fieldName}: ${value}`);
  } else if (field.type === 'ai') {
    value = aiValues[field.fieldName];
    if (value === undefined) throw new Error(`No AI value generated for "${field.fieldName}".`);
    log('info', `🤖 ${field.fieldName}: ${truncate(value, 60)}`);
  } else {
    value = field.fixedValue ?? '';
    log('info', `📝 ${field.fieldName}: ${truncate(value, 60)}`);
  }

  const loc = page.locator(field.selector).first();

  // WHY: Meesho's GST %, HSN code, and similar fields are React-Select style
  // dropdowns. Their underlying <input> (#supplier_gst_percent, #hsn_code) is
  // HIDDEN and managed by React — the value is set by the preceding click steps
  // (open dropdown → click option), not by typing. page.fill() on a hidden input
  // hangs for the full timeout and then fails. So: if the target isn't actually
  // editable, the value was already set by the dropdown selection — skip the
  // redundant fill instead of hanging/aborting.
  const editable = await loc.isEditable({ timeout: 5000 }).catch(() => false);
  if (!editable) {
    log('info', `↪ ${field.fieldName}: not a typeable input (dropdown-managed) — value already set by selection, skipping fill.`);
    return;
  }

  // Editable text input — fill normally with a bounded timeout (not the 30s default).
  await loc.fill('', { timeout: 8000 }).catch(() => {});
  await loc.fill(value, { timeout: 8000 });
}

// How long the recovery overlay waits for the user before giving up.
const RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Inject a recovery overlay into the browser. Resolves with the CSS selector
 * of whatever the user clicks next, null if they click "Cancel", or null on
 * timeout (5 min). Also resolves null if the page/browser closes mid-wait so
 * the run aborts cleanly instead of throwing a "Target closed" stack trace.
 */
async function requestRecovery(page, step) {
  // Node-side timeout — runs in parallel with the page.evaluate. Whichever
  // wins (page result or our own timer) determines the outcome.
  let timeoutHandle;
  const nodeTimeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve('__TIMEOUT__'), RECOVERY_TIMEOUT_MS);
  });

  const browserPromise = page.evaluate(({ stepLabel, timeoutMs }) => {
    return new Promise((resolve) => {
      // ── Selector generator (mirrors recorder.js) ─────────────────────────
      function getSelector(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id) return '#' + CSS.escape(el.id);
        const tag = el.tagName.toLowerCase();
        if (el.getAttribute('name')) return tag + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
        if (el.getAttribute('data-testid')) return '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]';
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
          node = parent;
        }
        return parts.join(' > ');
      }

      // ── Overlay UI ───────────────────────────────────────────────────────
      const overlay = document.createElement('div');
      overlay.id = '__meesho_recovery';
      overlay.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#dc2626;color:#fff;padding:14px 20px;border-radius:10px;' +
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:80vw;';
      overlay.innerHTML =
        '<div style="display:flex;align-items:center;gap:14px;">' +
          '<span>⚠ Recovery: Click the correct element for <strong>' + stepLabel + '</strong>' +
          ' <span id="__rec_timer" style="opacity:.7;font-size:12px;margin-left:8px;"></span></span>' +
          '<button id="__rec_cancel" style="background:#fff;color:#dc2626;border:none;padding:4px 10px;border-radius:4px;font-weight:bold;cursor:pointer;">Cancel</button>' +
        '</div>';
      document.body.appendChild(overlay);

      // Live countdown shown to the user.
      const startTime = Date.now();
      const timerEl = document.getElementById('__rec_timer');
      const tick = setInterval(() => {
        const left = Math.max(0, timeoutMs - (Date.now() - startTime));
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        if (timerEl) timerEl.textContent = '(' + m + ':' + String(s).padStart(2,'0') + ' left)';
      }, 1000);

      // Browser-side timeout — auto-cancels if no click in time.
      const giveUp = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

      function cleanup() {
        clearInterval(tick);
        clearTimeout(giveUp);
        document.removeEventListener('click', onClick, true);
        if (overlay.parentNode) overlay.remove();
      }

      function onClick(e) {
        // Cancel button → resolve null
        if (e.target.id === '__rec_cancel' || (overlay.contains(e.target) && e.target.tagName === 'BUTTON')) {
          e.preventDefault();
          e.stopPropagation();
          cleanup();
          resolve(null);
          return;
        }
        if (overlay.contains(e.target)) return;

        // Capture the user's click target as the new selector
        e.preventDefault();
        e.stopPropagation();
        const selector = getSelector(e.target);
        cleanup();
        resolve(selector);
      }

      document.addEventListener('click', onClick, true);
    });
  }, { stepLabel: step.label, timeoutMs: RECOVERY_TIMEOUT_MS })
  // Catch "Target closed" / page evaluate errors when user closes the browser
  // mid-wait — surface as null (cancel) instead of throwing.
  .catch(() => null);

  const result = await Promise.race([browserPromise, nodeTimeout]);
  clearTimeout(timeoutHandle);
  if (result === '__TIMEOUT__') return null;
  return result;
}

async function persistConfig(pathConfig, pathDir) {
  pathConfig.updatedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(pathDir, 'config.json'),
    JSON.stringify(pathConfig, null, 2),
    'utf8'
  );
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─── URL helpers — used to skip recorded login steps when already logged in ───

/**
 * True if the URL points at any kind of authentication page.
 * Matches /auth, /login, /signin, /signup as path segments.
 */
function isLoginUrl(url) {
  if (!url) return false;
  return /\b(auth|login|signin|signup)\b/i.test(url);
}

/**
 * True if the URL is the user's authenticated state on Meesho — i.e. they're
 * past login. Used to detect that the persistent profile has restored the
 * session and we should skip the recorded login flow.
 *
 * WHY no path-beyond-root requirement: after a fresh launch with persistent
 * session, Meesho briefly leaves the page on the root URL (`https://supplier.meesho.com/`)
 * before client-side routing pushes it to /panel/.... If we required a path,
 * the skip-check would fire on the first step *before* that route resolves.
 * Any meesho.com URL that is NOT a login URL is treated as logged-in.
 */
function isPostLoginUrl(url) {
  if (!url || !/^https?:\/\//.test(url)) return false;     // about:blank etc.
  if (!/meesho\.com/i.test(url)) return false;             // not on Meesho
  if (isLoginUrl(url)) return false;                       // on a login page
  return true;
}
