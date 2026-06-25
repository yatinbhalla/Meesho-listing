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
export function executeRun({ pathConfig, heroImagePath, pathDir, aiValues = {}, sku = '', page = null, noSubmit = false, credentials = null }) {
  const emitter = new EventEmitter();
  const log = (type, text) => emitter.emit('log', { type, text });

  // Diagnostic no-submit mode can be requested per-run (preferred, explicit) or
  // via the MEESHO_NO_SUBMIT=1 env var (global fallback). Either fills the whole
  // form but stops at "Submit Catalog" so a test run never publishes a listing.
  const noSubmitMode = noSubmit || process.env.MEESHO_NO_SUBMIT === '1';

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
    const ctx = { page: activePage, pathConfig, pathDir, heroImagePath, aiValues, sku, log, imageSlot: 0, imageFieldCount, credentials };

    // Tracks whether the steps we're about to replay are part of the recorded
    // login flow. When the persistent profile is already logged in, the browser
    // opens straight at /panel/... and replaying login-form clicks/fills would
    // fail. We skip them and resume at the first post-login navigate.
    let inLoginFlow = false;
    let skipped = 0;
    let reachedSubmit = false;   // no-submit mode: true once we hit "Submit Catalog"

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
        // WHY: we no longer skip the navigate-to-login step based on the URL
        // *before* navigating. That URL is unreliable — a fresh navigate to the
        // dashboard hasn't client-side-redirected to /login yet, so a logged-OUT
        // session still looks "logged in" (any non-login meesho URL passes
        // isPostLoginUrl), making us wrongly skip login and break the run.
        // Instead we always navigate to the login URL and let Meesho decide: a
        // live session bounces straight to the dashboard (caught by the
        // settle-wait above + the post-login skip below); a dead one lands on the
        // login form, which we then fill normally.
        inLoginFlow = isLoginUrl(step.value);
      } else if (inLoginFlow && isPostLoginUrl(activePage.url())) {
        log('info', `${progress} ⏭  Skipping login-form ${step.action} (already logged in).`);
        skipped++;
        continue;
      }

      // Diagnostic guard — when MEESHO_NO_SUBMIT=1, fill the whole form but stop
      // at "Submit Catalog" and skip EVERYTHING after it (the declaration
      // checkbox, Update Changes, Proceed) — those only exist in the submission
      // flow, so a test run never publishes a listing.
      if (noSubmitMode) {
        if (reachedSubmit || /^submit catalog$/i.test((step.label || '').trim())) {
          reachedSubmit = true;
          log('info', `${progress} ⏭  [no-submit mode] skipping "${step.label}".`);
          skipped++;
          continue;
        }
      }

      log('info', `${progress} ${stepLabel(step)}`);

      // Active readiness check — replaces the old fixed delay.
      await waitForReady(activePage, step, log);

      ctx.currentStepIndex = i;   // lets executeStep look ahead (auto-open dropdowns)

      // A click whose only purpose is to focus an input right before a fill on a
      // concrete selector is non-essential: Playwright's fill() focuses the field
      // itself. Recorded login "focus clicks" use brittle text= label selectors
      // (e.g. text="Email Id or mobile number…") that often don't resolve — when
      // they fail we skip them rather than aborting the run or pausing for manual
      // recovery, since the following fill targets the field directly anyway.
      const nextStep = pathConfig.steps[i + 1];
      const softClick = step.action === 'click'
        && nextStep && nextStep.action === 'fill'
        && isTypeableInputSelector(nextStep.selector);

      // Fast-path: a non-essential focus-click whose target isn't readily present
      // is skipped immediately rather than grinding the full ~90s retry ladder —
      // the following fill focuses the field on its own. (Brittle recorded login
      // label-clicks like text="Show Password Password" hit this path.)
      if (softClick) {
        const quickHit = await activePage.locator(step.selector).first()
          .isVisible({ timeout: 1500 }).catch(() => false);
        if (!quickHit) {
          log('info', `${progress} ⏭  Skipping non-essential focus-click "${step.label}" — next step fills the field directly.`);
          skipped++;
          continue;
        }
      }

      try {
        await runStepWithRetry(step, i, ctx, softClick);
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
async function runStepWithRetry(step, stepIndex, ctx, soft = false) {
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

  // Non-essential focus-click that failed — skip it. The following fill targets
  // the field directly, so we neither abort nor pause for manual recovery.
  if (soft) {
    ctx.log('info', `  ⏭  Skipping non-essential focus-click "${step.label}" — the next step fills the field directly.`);
    return;
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

      // Try the step once with the AI-suggested selector — but use it ONLY for
      // this run; NEVER persist it to the path config. WHY: a transient failure
      // (slow render, a dynamic MUI id that wasn't ready) could otherwise let AI
      // overwrite a correct recorded selector with a wrong-but-clickable one
      // (e.g. clicking the GST dropdown instead of opening the size dialog),
      // silently and permanently corrupting the path for every future run. We
      // restore the recorded selector immediately after, so the on-disk config
      // is left exactly as recorded/edited by the user.
      const prevSelector = step.selector;
      step.selector = aiSelector;
      try {
        await executeStep(step, ctx);
        step.selector = prevSelector;   // keep the recorded selector intact
        ctx.log('info', '🤖 Rescued this step for the current run only — recorded selector left unchanged.');
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
    // Custom checkbox steps (size "Free Size", the post-submit declaration,
    // etc.): toggle by clicking the checkbox element next to its text. Recorded
    // selectors for these are unreliable (positional paths, or invalid ids built
    // from the label sentence), so we resolve by the checkbox's TEXT instead.
    if (step.kind === 'checkbox') {
      const cbText = step.checkboxText || cleanCheckboxText(step.label);
      const ok = await clickCheckboxByText(page, cbText, ctx.log);
      if (ok) return;
      ctx.log('info', `☐ Could not resolve checkbox "${truncate(cbText, 50)}" by text — falling back to its selector.`);
      // fall through to the normal click ladder with the recorded selector
    }

    // Skip clicks on file inputs — they're usually hidden behind a styled
    // button, so clicking fails ("element not visible"). The upload is handled
    // by the subsequent fill step (setInputFiles works on hidden inputs).
    // PERF: skip this probe entirely for text="…" option selectors — an option
    // is never a file input, and when its dropdown isn't open yet the locator
    // matches nothing, making .evaluate() block for the full 30s default timeout
    // (this alone wasted ~30s on every auto-opened dropdown).
    const isFileInput = /^text=/.test(step.selector || '')
      ? false
      : await page.locator(step.selector).first()
          .evaluate((el) => el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file')
          .catch(() => false);
    if (isFileInput) {
      ctx.log('info', `↪ ${step.label}: file input — upload handled by the fill step, skipping click.`);
      return;
    }
    // Dropdown OPTION clicks (text="X" followed by a fill on a #control):
    // route through a dedicated handler that scopes everything to the OPEN
    // dropdown menu. This fixes the numeric-option ambiguity ("0.5" / "40"
    // appear all over the page once values are set) and the missing open-click /
    // search-filter gaps in one place.
    const optText = optionTextFromSelector(step.selector);
    if (optText) {
      const ctrl = findFollowingControl(ctx.pathConfig.steps, ctx.currentStepIndex);
      const done = await selectDropdownOption(page, optText, ctrl, ctx.log);
      if (done) return;
      ctx.log('info', `↪ option "${optText}" not resolved in a menu — falling back to plain click.`);
    }

    // Self-heal a recorder mis-capture: a dropdown OPTION click is sometimes
    // recorded with the dropdown's own #control id as the selector (instead of
    // the option's text=…), so a naive replay just re-clicks the control and
    // selects nothing. Detect it — a click whose selector is the SAME #control a
    // nearby preceding step opened, but whose label is a concrete value (not
    // "Select"/"Search") — and route it by the label through the menu-scoped
    // option handler. Falls through to a normal click if no such option exists.
    if (!optText) {
      const healedOpt = optionFromRepeatedControlClick(step, ctx);
      if (healedOpt) {
        const done = await selectDropdownOption(page, healedOpt, step.selector, ctx.log);
        if (done) {
          ctx.log('info', `↪ healed mis-recorded option click → selected "${truncate(healedOpt, 40)}".`);
          return;
        }
        ctx.log('info', `↪ "${truncate(healedOpt, 40)}" not in an open menu — falling back to plain click.`);
      }
    }

    // WHY: a click right after typing into a search box is almost always
    // selecting that search result. Prefer the option matching what was typed,
    // then clear it so it only influences the immediately-following click.
    const preferText = ctx.lastTypedValue || '';
    ctx.lastTypedValue = null;

    // Duplicate-ID disambiguation: Meesho renders TWO controls with the same id
    // (e.g. id="size" — a size-chart dialog AND a plain dropdown). A plain
    // `#size` selector can't tell them apart. We track how many times each
    // selector has been clicked and target the Nth occurrence in DOM order, so
    // the first `#size` click hits the first control and the second hits the
    // second. Only applied to bare #id selectors (class/text selectors that are
    // intentionally reused stay on the visible-first path).
    let occurrence = 0;
    if (/^#[A-Za-z][\w-]*$/.test(step.selector || '')) {
      ctx.selectorClicks = ctx.selectorClicks || {};
      occurrence = ctx.selectorClicks[step.selector] || 0;
      ctx.selectorClicks[step.selector] = occurrence + 1;
    }
    await smartClick(page, step.selector, step.label, preferText, occurrence);
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
    const field = resolveFillField(step, ctx);
    await fillField(page, field, ctx);
    if (field.type === 'image') ctx.imageSlot++;
    return;
  }
  throw new Error(`Unknown step action: ${step.action}`);
}

/**
 * Resolve which value a fill step writes — ROBUSTLY, so a corrupted/misaligned
 * fieldRef index can't make a search box upload an image (or vice-versa).
 *
 * Priority:
 *   1. Inline `valueType` on the step (explicit, self-contained).
 *   2. A field whose SELECTOR matches the step's selector. Matching by selector
 *      instead of array index is immune to add/delete/reorder edits. When
 *      several fields share a selector (e.g. a fixed + an AI variant of the same
 *      input), prefer the AI/SKU/image one over an empty fixed.
 *   3. The fieldRef'd field — but ONLY if its selector matches the step's
 *      (a mismatched index is corruption and must be ignored).
 *   4. The step's own inline `value` as a plain fixed fill.
 */
function resolveFillField(step, ctx) {
  const fields = ctx.pathConfig.fields || [];

  if (step.valueType) {
    return {
      fieldName: step.label || step.selector, selector: step.selector,
      type: step.valueType, fixedValue: step.value ?? '',
      aiPrompt: step.aiPrompt, imageRole: step.imageRole,
    };
  }

  const bySelector = fields.filter((f) => f.selector && f.selector === step.selector);
  let f = null;
  if (bySelector.length === 1) {
    f = bySelector[0];
  } else if (bySelector.length > 1) {
    f = bySelector.find((x) => x.type === 'ai')
      || bySelector.find((x) => x.type === 'sku' || x.type === 'image')
      || bySelector.find((x) => x.type === 'fixed' && x.fixedValue)
      || bySelector[0];
  }

  // fieldRef fallback — only trust it if its selector matches the step's.
  if (!f && step.fieldRef != null) {
    const cand = fields[step.fieldRef];
    if (cand && (!cand.selector || cand.selector === step.selector)) f = cand;
  }

  if (f) {
    // A field can have a blank selector (e.g. reclassified as a field in the
    // editor, or a recorder gap) — fall back to the STEP's selector, which is
    // the element actually being acted on. Without this, an image/fill field
    // with no selector calls setInputFiles('') and crashes.
    if (!f.selector && step.selector) f = { ...f, selector: step.selector };
    // A matched-but-empty fixed field, when the step carries its own value,
    // should use the step's value (covers older configs that stored value on the step).
    if (f.type === 'fixed' && !f.fixedValue && step.value) {
      return { ...f, fixedValue: String(step.value) };
    }
    return f;
  }

  // No usable field — use the step's own value (or empty) as a fixed fill.
  if (step.value != null) {
    return {
      fieldName: step.label || step.selector, selector: step.selector,
      type: 'fixed', fixedValue: String(step.value),
    };
  }

  throw new Error(`Fill step "${step.label}" has no resolvable value (selector ${step.selector}).`);
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

  // NOTE: we deliberately do NOT wait for 'networkidle' here. Meesho's panel is
  // a single-page app with constant background traffic (analytics, polling), so
  // networkidle never settles and just burns its full timeout on EVERY step
  // (~5s × 100+ steps ≈ 9 wasted minutes). The real readiness signal is the
  // next step's target element being attached, which we wait for below.

  if (step.selector && step.action !== 'navigate') {
    // Option-style selectors (text="…") belong to a dropdown that often isn't
    // open yet — the click handler auto-opens it. Don't burn the full 15s here;
    // a short wait is enough, then let the click's open-preflight take over.
    const isOption = /^text=/.test(step.selector);
    const timeout = isOption ? 2500 : READY_TIMEOUT_MS;
    try {
      await page.waitForSelector(step.selector, { state: 'attached', timeout });
    } catch {
      // Don't throw — the step's own retry + auto-open + recovery flow handles it.
      if (!isOption) {
        log('info', `  ⌛ ${step.selector} didn't appear within ${timeout}ms — continuing anyway.`);
      }
    }
  }

  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Resolve a selector to the best matching element:
 *   1. If `preferText` is given and a VISIBLE match contains that text, use it.
 *      (Critical for search→select: after typing "table cloth", the next click
 *      on a generic `[data-testid="resultRow"]` must land on the row that
 *      actually says "Table Cloths", not whichever row is first.)
 *   2. Otherwise the first VISIBLE match.
 *   3. Otherwise the first match (so hidden file inputs still resolve).
 * Bounded scan so a selector matching hundreds of nodes can't stall us.
 */
async function firstVisible(page, selector, preferText) {
  const all = page.locator(selector);
  let count = 0;
  try { count = await all.count(); } catch { return all.first(); }
  if (count <= 1) return all.first();

  const scan = Math.min(count, 30);
  const visibles = [];
  for (let i = 0; i < scan; i++) {
    const nth = all.nth(i);
    if (await nth.isVisible().catch(() => false)) visibles.push(nth);
  }
  if (visibles.length === 0) return all.first();

  const pt = String(preferText || '').trim().toLowerCase();
  if (pt) {
    for (const v of visibles) {
      const t = (await v.innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t && t.includes(pt)) return v;
    }
  }
  return visibles[0];
}

/**
 * Click a CUSTOM checkbox identified by its visible text — robustly.
 *
 * WHY: Meesho's checkboxes (size "Free Size", the post-submit "I understand…"
 * declaration, etc.) are not <input type=checkbox> with a <label>. They're a
 * styled <svg> sitting next to a text node, and ONLY a real pointer click on
 * the svg/box toggles them — clicking the text is a no-op, and a synthetic
 * .click() on the row does nothing. So we locate the checkbox element in the
 * DOM (svg sibling of the text, or a real checkbox input in the same row), tag
 * it, and let Playwright do a real pointer click on it.
 *
 * Returns true if it found and clicked a checkbox, false otherwise.
 */
async function clickCheckboxByText(page, text, log) {
  const target = String(text || '').replace(/\s+/g, ' ').trim();
  if (!target) return false;

  // The checkbox usually lives in a dialog/section that the PRECEDING click just
  // opened — which may not have rendered yet (especially now that per-step waits
  // are lean). Give the text a few seconds to appear before tagging, so a
  // not-yet-rendered checkbox isn't a false miss. If it never appears (e.g. the
  // open-click didn't actually open the dialog), we fall through and return false.
  await page.getByText(target, { exact: false }).first()
    .waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});

  // Tag the checkbox element (browser side) so Playwright can click it.
  const found = await page.evaluate((wanted) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const w = wanted.toLowerCase();
    document.querySelectorAll('[data-meesho-cb]').forEach((e) => e.removeAttribute('data-meesho-cb'));

    // Find the smallest VISIBLE element whose text matches (exact, else contains).
    const all = Array.from(document.querySelectorAll('body *'));
    const visible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length);
    let textEl =
      all.find((el) => visible(el) && norm(el.innerText) .toLowerCase() === w && el.children.length === 0) ||
      all.find((el) => visible(el) && norm(el.textContent).toLowerCase() === w && el.children.length <= 1) ||
      all.find((el) => visible(el) && norm(el.textContent).toLowerCase().includes(w) && el.children.length <= 2);
    if (!textEl) return null;

    // 1. A checkbox input in the nearest row ancestor.
    let row = textEl;
    for (let i = 0; i < 5 && row.parentElement; i++) {
      const input = row.querySelector && row.querySelector('input[type="checkbox"]');
      if (input) { input.setAttribute('data-meesho-cb', '1'); return 'input'; }
      row = row.parentElement;
    }
    // 2. An <svg> that is the previous sibling of the text (the size pattern).
    if (textEl.previousElementSibling && textEl.previousElementSibling.tagName.toLowerCase() === 'svg') {
      textEl.previousElementSibling.setAttribute('data-meesho-cb', '1'); return 'svg-prev';
    }
    // 3. Any <svg> within the nearest small row ancestor.
    row = textEl;
    for (let i = 0; i < 4 && row.parentElement; i++) {
      const svg = row.querySelector && row.querySelector('svg');
      if (svg) { svg.setAttribute('data-meesho-cb', '1'); return 'svg-row'; }
      row = row.parentElement;
    }
    // 4. Fallback: tag the text element's parent row to click it directly.
    (textEl.parentElement || textEl).setAttribute('data-meesho-cb', '1');
    return 'row';
  }, target).catch(() => null);

  if (!found) return false;

  try {
    await page.locator('[data-meesho-cb="1"]').first().click({ timeout: 5000 });
    log && log('info', `  ☑ checkbox "${truncate(target, 50)}" clicked (${found}).`);
    await page.evaluate(() => document.querySelectorAll('[data-meesho-cb]').forEach((e) => e.removeAttribute('data-meesho-cb'))).catch(() => {});
    return true;
  } catch {
    await page.evaluate(() => document.querySelectorAll('[data-meesho-cb]').forEach((e) => e.removeAttribute('data-meesho-cb'))).catch(() => {});
    return false;
  }
}

/** Extract the option text from a `text="X"` / `text=X` selector. */
function optionTextFromSelector(selector) {
  const m = /^text=(?:"([\s\S]*)"|([\s\S]*))$/.exec(String(selector || '').trim());
  if (!m) return '';
  return (m[1] != null ? m[1] : m[2] || '').replace(/\\"/g, '"').trim();
}

/**
 * Type a value into the search box of an OPEN dropdown so a search-filtered
 * option (Meesho's dimension dropdowns: "40", "0.5", "12", "60", …) renders.
 * Targets the visible search input inside the open menu/popover. Returns true
 * if it typed into one.
 */
async function typeIntoDropdownSearch(page, value, log) {
  // WHY tagging: the page's TOP category search is also a `.MuiInputBase-inputAdornedStart`
  // and is the FIRST visible such input — typing the value there does nothing for
  // the open dropdown. We pick the search box INSIDE the open dropdown
  // (popover/menu), else the LAST visible search input on the page (dropdown
  // searches render after the page's main search), and tag it for Playwright.
  const tagged = await page.evaluate(() => {
    document.querySelectorAll('[data-meesho-search]').forEach((e) => e.removeAttribute('data-meesho-search'));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const isSearchish = (el) =>
      el.tagName === 'INPUT' &&
      !['hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes((el.type || '').toLowerCase()) &&
      (/MuiInputBase-inputAdornedStart/.test(el.className) || /search/i.test(el.placeholder || '') || el.closest('[role="presentation"], .MuiPopover-paper, .MuiMenu-paper, ul[role="menu"], .MuiAutocomplete-popper'));

    const all = Array.from(document.querySelectorAll('input')).filter((el) => isSearchish(el) && visible(el));
    if (!all.length) return false;
    // Prefer one inside an open popover/menu; else the last visible (the just-opened dropdown).
    const inPopover = all.filter((el) => el.closest('[role="presentation"], .MuiPopover-paper, .MuiMenu-paper, ul[role="menu"], .MuiAutocomplete-popper'));
    const chosen = (inPopover.length ? inPopover[inPopover.length - 1] : all[all.length - 1]);
    chosen.setAttribute('data-meesho-search', '1');
    return true;
  }).catch(() => false);

  if (!tagged) return false;
  try {
    const loc = page.locator('[data-meesho-search="1"]').first();
    await loc.fill('', { timeout: 2000 }).catch(() => {});
    await loc.fill(String(value), { timeout: 3000 });
    log && log('info', `  ⌨ typed "${truncate(String(value), 30)}" into the dropdown's search box to filter the option.`);
    await page.evaluate(() => document.querySelectorAll('[data-meesho-search]').forEach((e) => e.removeAttribute('data-meesho-search'))).catch(() => {});
    return true;
  } catch {
    await page.evaluate(() => document.querySelectorAll('[data-meesho-search]').forEach((e) => e.removeAttribute('data-meesho-search'))).catch(() => {});
    return false;
  }
}

// Containers that hold an OPEN dropdown's options (MUI menus/popovers/listboxes).
const OPEN_MENU = 'ul[role="menu"], [role="listbox"], [role="presentation"] ul, .MuiMenu-paper, .MuiPopover-paper, .MuiAutocomplete-popper';

/**
 * Select an option from a dropdown ROBUSTLY, scoped to the currently-open menu:
 *   1. If the option text isn't visible inside an open menu, open the dropdown
 *      (click its #control) — handles recordings missing the open-click.
 *   2. If still not present, type the value into the menu's search box — handles
 *      search-filtered dimension dropdowns ("40", "0.5", "12", …).
 *   3. Click the option, MATCHED INSIDE THE OPEN MENU — so a stray "0.5" already
 *      shown elsewhere on the page can't be clicked by mistake.
 * Returns true on success, false to let the caller fall back.
 */
async function selectDropdownOption(page, optionText, controlSelector, log) {
  const menuOption = () => page.locator(OPEN_MENU).getByText(optionText, { exact: true }).first();

  const optionInMenuVisible = async () => {
    try { return await menuOption().isVisible({ timeout: 800 }); } catch { return false; }
  };
  // Is ANY dropdown menu/popover currently open? (so we don't re-click the
  // control and accidentally TOGGLE an already-open dropdown shut).
  const anyMenuOpen = async () => {
    try { return await page.locator(OPEN_MENU).first().isVisible({ timeout: 500 }); } catch { return false; }
  };

  // 1. Open the dropdown ONLY if nothing is open yet (recordings sometimes miss
  //    the open-click). If a menu is already open, leave it — we'll filter/click.
  if (!(await optionInMenuVisible()) && !(await anyMenuOpen()) && controlSelector) {
    log && log('info', `↻ opening dropdown ${controlSelector} for option "${truncate(optionText, 30)}".`);
    await smartClick(page, controlSelector, 'open dropdown').catch(() => {});
    await page.waitForTimeout(600);
  }
  // 2. Still not showing → type into the OPEN dropdown's search box to filter it in.
  if (!(await optionInMenuVisible())) {
    if (await typeIntoDropdownSearch(page, optionText, log)) {
      await page.waitForTimeout(700);
    }
  }
  // 3. Click the option inside the open menu.
  try {
    const opt = menuOption();
    if (await opt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await opt.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await opt.click({ timeout: 4000 });
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

/** True if the selector has at least one visible match (bounded scan). */
async function hasVisible(page, selector) {
  const all = page.locator(selector);
  let count = 0;
  try { count = await all.count(); } catch { return false; }
  const scan = Math.min(count, 30);
  for (let i = 0; i < scan; i++) {
    if (await all.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Find the dropdown control (#id selector) that the fill step following `idx`
 * targets — used to auto-open a dropdown whose option-click is missing its
 * preceding open-click in the recording.
 */
function findFollowingControl(steps, idx) {
  if (!Array.isArray(steps) || idx == null) return null;
  for (let j = idx + 1; j < Math.min(idx + 3, steps.length); j++) {
    const s = steps[j];
    if (s && s.action === 'fill' && /^#/.test(s.selector || '')) return s.selector;
  }
  return null;
}

// Recorder mis-capture heal: returns the option text to select when a click step
// is really an option-pick that got recorded with the dropdown's own #control id
// (instead of text="value"). Conditions: this step's selector is a #control, a
// preceding step within the last 3 opened that SAME control, and the label is a
// concrete value rather than a generic action word ("Select", "Search", …).
function optionFromRepeatedControlClick(step, ctx) {
  const sel = step.selector || '';
  if (!/^#/.test(sel)) return null;
  const label = (step.label || '').trim();
  if (!label || /^(select|search|open|click|choose)\b/i.test(label)) return null;

  const steps = ctx.pathConfig.steps || [];
  const idx = ctx.currentStepIndex;
  if (idx == null) return null;
  for (let j = idx - 1; j >= 0 && j >= idx - 3; j--) {
    const p = steps[j];
    if (p && p.action === 'click' && p.selector === sel) return label;
  }
  return null;
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
async function smartClick(page, selector, label = '', preferText = '', occurrence = 0) {
  // Duplicate-ID case: target the Nth match in DOM order (occurrence > 0 means
  // this is a repeat click on a selector that matches several elements — e.g.
  // the second `#size` control).
  let locator;
  if (occurrence > 0) {
    const all = page.locator(selector);
    const count = await all.count().catch(() => 0);
    locator = count > occurrence ? all.nth(occurrence) : await firstVisible(page, selector, preferText);
  } else {
    // WHY firstVisible: many Meesho selectors (e.g. the dropdown search box
    // `input.MuiInputBase-input.MuiInputBase-inputAdornedStart`, or a generic
    // `[data-testid="resultRow"]`) match MANY elements — most hidden, and the
    // visible ones may be several options. We pick the visible match that
    // contains `preferText` (what the user just typed) when available, else the
    // first visible one.
    locator = await firstVisible(page, selector, preferText);
  }

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

// Read an image file and return a Playwright setInputFiles payload whose name +
// MIME come from the file's MAGIC BYTES, not its on-disk extension. WHY: shared
// images are stored as imgN.jpg regardless of their real format, so a PNG saved
// as img2.jpg would be sent to Meesho as image/jpeg with PNG bytes — a mismatch
// Meesho rejects, leaving "Add more images" incomplete. Sniffing the true format
// makes every image upload with the correct type.
async function toTypedFile(filePath) {
  const buffer = await fs.readFile(filePath);
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  let ext = 'jpg', mimeType = 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    ext = 'png'; mimeType = 'image/png';
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    ext = 'jpg'; mimeType = 'image/jpeg';
  } else if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    ext = 'webp'; mimeType = 'image/webp';
  }
  return { name: `${base}.${ext}`, mimeType, buffer };
}

async function fillField(page, field, ctx) {
  const { heroImagePath, pathDir, aiValues, sku, imageSlot, log } = ctx;

  if (field.type === 'image') {
    const sharedDir = path.join(pathDir, 'shared_images');
    const sharedFiles = ['img2.jpg', 'img3.jpg', 'img4.jpg'].map((f) => path.join(sharedDir, f));

    // Decide which source this image input uses:
    //  • field.imageRole === 'hero'   → the per-listing image the user uploads at run time
    //  • field.imageRole === 'shared' → the 3 pre-uploaded shared images
    //  • unset / 'auto'               → legacy order: 1st image input = hero, rest = shared
    const role = field.imageRole && field.imageRole !== 'auto'
      ? field.imageRole
      : (imageSlot === 0 ? 'hero' : 'shared');

    // WHY 12s (not the 30s default): a file input that isn't on the page yet
    // means the preceding "Add images" click didn't reveal it. Fail fast so the
    // retry/AI/recovery flow kicks in instead of hanging 30s × retries (90s).
    const SET_FILES_TIMEOUT = 12_000;

    if (role === 'hero') {
      log('info', `🖼  Uploading hero image (your run-time photo): ${path.basename(heroImagePath)}`);
      await page.setInputFiles(field.selector, await toTypedFile(heroImagePath), { timeout: SET_FILES_TIMEOUT });
      return;
    }

    // Shared. Meesho's "Add more images" input accepts MULTIPLE files at once.
    // For the common hero + single "add more" layout, push ALL shared images in
    // one setInputFiles call. For multiple discrete shared slots, one per slot.
    if (ctx.imageFieldCount <= 2 || field.imageRole === 'shared') {
      const present = [];
      for (const f of sharedFiles) {
        try { await fs.access(f); present.push(f); } catch { /* skip missing */ }
      }
      const files = present.length ? present : sharedFiles;
      const typed = await Promise.all(files.map(toTypedFile));
      log('info', `🖼  Uploading ${typed.length} shared image(s): ${typed.map((t) => t.name).join(', ')}`);
      await page.setInputFiles(field.selector, typed, { timeout: SET_FILES_TIMEOUT });
    } else {
      const file = path.join(sharedDir, `img${imageSlot + 1}.jpg`);
      const typed = await toTypedFile(file);
      log('info', `🖼  Uploading image #${imageSlot + 1}: ${typed.name}`);
      await page.setInputFiles(field.selector, typed, { timeout: SET_FILES_TIMEOUT });
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
    // SECURITY: login credentials come from the ACTIVE profile (ctx.credentials),
    // falling back to .env — never from the stored path config (which no longer
    // holds them). Resolve by the field's selector.
    const sel = field.selector || '';
    const creds = ctx.credentials || {};
    if (/password/i.test(sel)) {
      value = creds.password || process.env.MEESHO_PASSWORD || value;
    } else if (/emailorphone|email/i.test(sel)) {
      value = creds.email || process.env.MEESHO_EMAIL || value;
    }
    const shown = isSensitiveField(field) ? '••••••••' : truncate(value, 60);
    log('info', `📝 ${field.fieldName}: ${shown}`);
  }

  // Target the first VISIBLE match — Meesho's search/text selectors are often
  // shared across many hidden inputs; .first() would grab a hidden one.
  const loc = await firstVisible(page, field.selector);

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

  // Remember what was just typed so the NEXT click can prefer the matching
  // option (search→select pattern). Only meaningful for short search-like text.
  if (value && String(value).length <= 40) {
    ctx.lastTypedValue = String(value);
  }
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

// Derive the checkbox's visible text from a recorded step label. Labels for
// checkbox steps are typically the checkbox text itself (e.g. "free size",
// "I understand that all products…"). Strip a leading "Fill " if present.
function cleanCheckboxText(label) {
  return String(label || '')
    .replace(/^Fill\s+/i, '')
    // Strip a trailing recorder annotation like "(size checkbox)" or
    // "(declaration checkbox)" — it's not part of the on-page text. This makes
    // the fallback work for recordings that didn't store an explicit checkboxText.
    .replace(/\s*\([^)]*checkbox[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// True for selectors that target a REAL typeable text input — input[…],
// textarea, or a [name=…] field (e.g. the login input[name="password"]).
// A fill() on one of these focuses the field itself, so a preceding "focus
// click" (the brittle recorded login label-clicks) is redundant and skippable.
// Deliberately EXCLUDES bare #id selectors: Meesho's dropdowns are #control ids
// whose value is set by the preceding OPTION click (text="Fabric" → #material),
// and that option click is essential — it must not be treated as skippable, or
// orphaned dropdowns (no separate open-click) never get selected.
function isTypeableInputSelector(sel) {
  if (!sel) return false;
  return /^(input|textarea)\b/i.test(sel) || /\[name=/i.test(sel);
}

// True for fields whose value must never be written to the (broadcast + on-disk)
// run log — passwords above all. Checked against both the field name and the
// selector so it catches input[name="password"] and "Show Password" labels alike.
function isSensitiveField(field) {
  const hay = `${field?.fieldName || ''} ${field?.selector || ''}`.toLowerCase();
  return /\b(password|passwd|pwd|secret|otp)\b/.test(hay);
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
