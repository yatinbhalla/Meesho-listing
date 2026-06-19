import { getSession, closeSession } from './session.js';
import fs from 'fs/promises';
import path from 'path';

const PATHS_DIR = path.resolve('paths');

/**
 * Open Meesho with a recording overlay; capture every interaction and return
 * the assembled PathConfig once the user clicks "Save & Finish".
 *
 * @param {(type: string, text: string) => void} [logFn]
 * @returns {Promise<{ pathConfig: import('../types/models.js').PathConfig, savedTo: string }>}
 */
export async function recordPath(logFn = (t, m) => console.log(`[${t}] ${m}`)) {
  const log = (text, type = 'info') => logFn(type, text);
  const { context, page } = await getSession((m) => log(m));

  // ─── State (lives in Node, not the browser) ─────────────────────────────────
  const state = {
    steps: [],
    fields: [],
    seen: new Set(),
    paused: false,
  };

  let resolveFinish;
  const finishPromise = new Promise((r) => { resolveFinish = r; });

  // ─── Bridge: browser → Node ──────────────────────────────────────────────────
  // WHY idempotent: getSession() may hand back a REUSED browser context (one a
  // previous run left open). exposeFunction throws if the name is already bound
  // on that context, so we swallow "already registered" and move on.
  async function expose(name, fn) {
    try { await context.exposeFunction(name, fn); }
    catch (e) {
      if (!/already registered|already been registered/i.test(String(e.message))) throw e;
    }
  }

  await expose('__recorderEmit', (event) => {
    if (state.paused) return;
    handleEvent(event);
  });
  await expose('__recorderFinish', () => resolveFinish());
  await expose('__recorderPauseToggle', (paused) => {
    state.paused = paused;
    log(paused ? '⏸  Recording paused.' : '▶  Recording resumed.');
  });
  await expose('__recorderClear', () => {
    state.steps = [];
    state.fields = [];
    state.seen.clear();
    log('🗑  Recording cleared.');
  });

  function handleEvent(ev) {
    const { type, selector, label, value, fieldType, kind, checkboxText } = ev;

    if (type === 'navigation') {
      // Avoid duplicate consecutive navigation entries.
      const last = state.steps[state.steps.length - 1];
      if (last?.action === 'navigate' && last.value === value) return;
      state.steps.push({ action: 'navigate', value, label: `Go to ${value}` });
      log(`📍 Navigate: ${value}`);
      return;
    }

    if (type === 'click') {
      // Dedupe: ignore clicks that match the previous recorded click
      // (happens when user clicks the same input multiple times to focus it).
      const last = state.steps[state.steps.length - 1];
      if (last?.action === 'click' && last.selector === selector) return;
      const stepObj = { action: 'click', selector, label };
      // Custom checkbox → tag it so the executor toggles by text (robust),
      // not by the fragile recorded selector. Covers the size "Free Size" box
      // and the post-submit "I understand…" declaration checkbox.
      if (kind === 'checkbox' && checkboxText) {
        stepObj.kind = 'checkbox';
        stepObj.checkboxText = checkboxText;
      }
      state.steps.push(stepObj);
      log(kind === 'checkbox' ? `☑ Checkbox: ${label}` : `👆 Click: ${label}`);
      return;
    }

    if (type === 'select') {
      state.steps.push({
        action: 'select', selector, value,
        label: `Select "${value}" in ${label}`,
      });
      log(`📋 Select: ${value} → ${label}`);
      return;
    }

    if (type === 'input') {
      // Fields are recorded once. The order matters, so we also push a 'fill'
      // step pointing at the field index — the executor walks steps in order.
      // SECURITY: never persist login credentials (Meesho email/password). The
      // executor fills these from .env (MEESHO_EMAIL / MEESHO_PASSWORD) at run
      // time, so the captured value is dropped — keeping plaintext secrets out
      // of the path config files.
      const isCredential = /password|emailorphone/i.test(selector);
      let fieldIndex;
      if (state.seen.has(selector)) {
        fieldIndex = state.fields.findIndex((f) => f.selector === selector);
        // Update fixedValue in case user retyped (but never store credentials).
        if (state.fields[fieldIndex]) state.fields[fieldIndex].fixedValue = isCredential ? '' : value;
      } else {
        fieldIndex = state.fields.length;
        state.fields.push({
          fieldName: label || selector,
          selector,
          type: fieldType || 'fixed',     // user can change in the app later
          fixedValue: (fieldType === 'image' || isCredential) ? '' : value,
        });
        state.seen.add(selector);
        state.steps.push({
          action: 'fill', selector, fieldRef: fieldIndex,
          label: `Fill ${label}`,
        });
        log(`📝 Field captured: ${label} (${fieldType || 'fixed'})`);
      }
    }
  }

  // ─── Inject overlay + listeners on every page load ──────────────────────────
  await context.addInitScript(() => {
    if (window.__meeshoRecorderInstalled) return;
    window.__meeshoRecorderInstalled = true;

    // ── Selector generator (v2) — prefer stable, semantic anchors ─────────
    // Order of preference (most stable first):
    //   1. #id                     — usually generated, but unique
    //   2. [data-testid="..."]      — explicit test handles
    //   3. tag[name="..."]          — form fields
    //   4. [aria-label="..."]       — accessibility-stable
    //   5. role=role[name=text]     — Playwright's accessibility locator
    //   6. text="exact visible"     — for buttons/links/options/labels
    //   7. tag.class                — moderate stability
    //   8. nth-of-type CSS path     — last resort
    function getSelector(el) {
      if (!el || el.nodeType !== 1) return null;
      const tag = el.tagName.toLowerCase();

      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.getAttribute('data-testid'))
        return `[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]`;
      if (el.getAttribute('name'))
        return `${tag}[name="${CSS.escape(el.getAttribute('name'))}"]`;
      if (el.getAttribute('aria-label'))
        return `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;

      // 4b. Checkbox / radio / switch WITHOUT a stable attribute → anchor on the
      //     associated label's text. WHY: MUI checkboxes are text-less <span>
      //     wrappers; their class (.MuiCheckbox-root) matches EVERY checkbox on
      //     the page, so a class selector clicks the wrong one. The label text
      //     (e.g. "Same as Manufacturer Details") is unique and stable, and
      //     clicking the <label> toggles its control.
      const isToggle =
        /^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '') ||
        (tag === 'input' && /^(checkbox|radio)$/.test((el.type || '').toLowerCase())) ||
        /\bMui(Checkbox|Radio|Switch)\b/.test(el.className || '') ||
        !!(el.closest && el.closest('.MuiCheckbox-root, .MuiRadio-root, .MuiSwitch-root'));

      if (isToggle) {
        const labelEl = el.closest && el.closest('label, .MuiFormControlLabel-root');
        const labelText = labelEl
          ? (labelEl.innerText || '').replace(/\s+/g, ' ').trim()
          : '';
        if (labelText && labelText.length >= 2 && labelText.length <= 80) {
          return `label:has-text("${labelText.replace(/"/g, '\\"')}")`;
        }
      }

      // --- Visible-text strategies (Playwright text engine) ---------------
      // Use innerText (not textContent) so we capture only what the user sees.
      const rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();

      // Is this a selectable OPTION (dropdown / MUI menu item / listbox row)?
      // WHY: Meesho's measurement dropdowns (length/width/weight) have purely
      // NUMERIC options ("0.5", "5", "30"). We MUST anchor on their exact text,
      // otherwise we fall through to a generic class like `li.MuiMenuItem-root`
      // which matches the FIRST option in EVERY dropdown — silently selecting
      // the wrong value with no error. So for option-like elements we allow
      // numeric text and use an exact text match.
      const optionLike =
        el.getAttribute('role') === 'option' ||
        el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'menuitemradio' ||
        tag === 'option' ||
        /\bMenuItem\b|\boption\b/i.test(el.className || '');

      const hasLetters = /[A-Za-z]/.test(rawText);
      const notBlank = rawText && !/^[\s​-‍﻿]+$/.test(rawText);
      // Generic elements need letters (avoid matching stray numbers); option-like
      // elements may be purely numeric.
      const usable = notBlank && rawText.length <= 80 &&
        (optionLike ? rawText.length >= 1 : (rawText.length >= 2 && hasLetters));

      const role = el.getAttribute('role') || implicitRole(el);

      // 5a. Option-like → EXACT text match (Playwright `text="..."` is exact).
      //     This is the single most important selector for Meesho's dropdowns.
      if (optionLike && usable) {
        return `text="${rawText.replace(/"/g, '\\"')}"`;
      }

      // 5b. Role + accessible name (Playwright's `role` locator) for others.
      if (role && usable && hasLetters) {
        const safe = rawText.replace(/"/g, '\\"');
        return `role=${role}[name="${safe}"]`;
      }

      // 6. Visible-text exact match for clickable elements. Includes <p> because
      //    Meesho renders some toggles/links as MUI Typography paragraphs
      //    (e.g. the "Importer Address" row) whose class is non-unique.
      if (usable && /^(button|a|li|option|label|span|div|td|th|p)$/.test(tag)) {
        const safe = rawText.replace(/"/g, '\\"');
        return `text="${safe}"`;
      }

      // 7. Tag + 1-2 most distinctive classes.
      if (el.classList.length > 0) {
        const classes = Array.from(el.classList)
          .filter((c) => c && !/^(active|focused|selected|hover)$/i.test(c))
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`).join('');
        if (classes) return `${tag}${classes}`;
      }

      // 8. Last resort: short nth-of-type CSS path.
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (sameTag.length > 1) {
            part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
          }
        }
        parts.unshift(part);
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        node = parent;
      }
      return parts.join(' > ');
    }

    // ARIA implicit-role mapping for common HTML elements.
    function implicitRole(el) {
      const t = el.tagName.toLowerCase();
      if (t === 'button') return 'button';
      if (t === 'a' && el.hasAttribute('href')) return 'link';
      if (t === 'input') {
        const type = (el.type || '').toLowerCase();
        if (type === 'submit' || type === 'button') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio')    return 'radio';
        return 'textbox';
      }
      if (t === 'textarea') return 'textbox';
      if (t === 'select') return 'combobox';
      if (t === 'option') return 'option';
      if (t === 'li') return 'listitem';
      return null;
    }

    function getLabel(el) {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent.trim().slice(0, 60);
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent.trim().slice(0, 60);
      if (el.placeholder) return el.placeholder.trim();
      const text = (el.textContent || '').trim();
      if (text && text.length < 60) return text;
      return el.name || el.id || el.tagName.toLowerCase();
    }

    const isInsideOverlay = (el) => !!el.closest && !!el.closest('#__meesho_recorder_panel');

    // ── Click capture (for steps) ──────────────────────────────────────────
    // Walk to the nearest SEMANTIC ancestor — buttons, links, list options,
    // checkboxes, radios, switches (incl. MUI's styled-span variants). Avoid
    // capturing opaque wrapper divs that have no identity. If nothing semantic
    // is in scope, fall back to the click target itself.
    const SEMANTIC_TAGS = 'button, a, [role="button"], [role="option"], [role="tab"], ' +
      '[role="menuitem"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], ' +
      '[role="link"], label, li, option, input[type="checkbox"], input[type="radio"], ' +
      '.MuiCheckbox-root, .MuiRadio-root, .MuiSwitch-root, .MuiMenuItem-root';

    // Elements that ARE controls even when they have no visible text
    // (MUI checkboxes/switches/radios are just styled spans + a hidden input).
    const CONTROL_SELECTOR = 'button, a, [role], input, select, textarea, label, li, option, ' +
      '.MuiCheckbox-root, .MuiRadio-root, .MuiSwitch-root, .MuiMenuItem-root';

    function findClickTarget(el) {
      if (!el) return null;
      const semantic = el.closest && el.closest(SEMANTIC_TAGS);
      return semantic || el;
    }

    function isFileInput(el) {
      return el && el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file';
    }

    function isMeaningfulClick(el) {
      if (!el) return false;
      if (el === document.body || el === document.documentElement) return false;
      // Skip clicks directly on hidden file inputs — the file is set via the
      // upload (change) event, not a click. Recording the click just produces
      // a step that fails at replay ("element not visible").
      if (isFileInput(el)) return false;
      const text = (el.innerText || '').replace(/[\s​-‍﻿]+/g, '').trim();
      const hasText = text.length > 0;
      const isControl = el.matches && el.matches(CONTROL_SELECTOR);
      const hasIdentity =
        el.id || el.getAttribute('name') || el.getAttribute('data-testid') ||
        el.getAttribute('aria-label') || el.getAttribute('role') ||
        ['BUTTON', 'A', 'LI', 'OPTION', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName);
      // Capture if it has text, a semantic identity, OR is a known control
      // (covers text-less MUI checkboxes/switches the user toggled).
      return hasText || hasIdentity || isControl;
    }

    // Detect a custom checkbox click (Meesho size/declaration checkboxes are a
    // styled <svg> next to a text node, or a MUI/role checkbox). Returns the
    // checkbox's visible text so replay can toggle it by text (robust) rather
    // than by a fragile positional selector.
    function detectCheckbox(rawTarget) {
      let el = rawTarget;
      for (let i = 0; i < 4 && el && el.tagName; i++) {
        const tag = el.tagName.toLowerCase();
        const cls = typeof el.className === 'string' ? el.className : '';
        const isSvg = tag === 'svg' || tag === 'rect' || tag === 'path';
        const isCb = (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'checkbox')
          || el.getAttribute('role') === 'checkbox'
          || /\bMuiCheckbox-root\b/.test(cls);
        if (isSvg || isCb) {
          const row = (el.closest && el.closest('label, li, div')) || el.parentElement || el;
          const txt = ((row && row.innerText) || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length <= 140) return { isCheckbox: true, text: txt };
        }
        el = el.parentElement;
      }
      return { isCheckbox: false };
    }

    document.addEventListener('click', (e) => {
      if (isInsideOverlay(e.target)) return;
      const el = findClickTarget(e.target);
      if (!isMeaningfulClick(el)) return;
      const selector = getSelector(el);
      if (!selector) return;
      const ev = { type: 'click', selector, label: getLabel(el) };
      const cb = detectCheckbox(e.target);
      if (cb.isCheckbox && cb.text) {
        ev.kind = 'checkbox';
        ev.checkboxText = cb.text;
        ev.label = cb.text.slice(0, 80);
      }
      window.__recorderEmit(ev);
    }, true);

    // Shared helper — capture a text input/textarea's current value as a field.
    // handleEvent (Node side) dedupes by selector, so calling this from multiple
    // events (change/blur/input) is safe — it just keeps the latest value.
    function captureTextValue(el) {
      if (!el) return;
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
      if (['file', 'checkbox', 'radio', 'submit', 'button'].includes((el.type || '').toLowerCase())) return;
      const selector = getSelector(el);
      if (!selector) return;
      const value = el.value;
      if (value == null || value === '') return;
      window.__recorderEmit({ type: 'input', selector, label: getLabel(el), value });
    }

    // ── Change capture (selects, checkboxes, file inputs, text fields) ─────
    document.addEventListener('change', (e) => {
      if (isInsideOverlay(e.target)) return;
      const el = e.target;
      const selector = getSelector(el);
      if (!selector) return;
      const label = getLabel(el);

      if (el.tagName === 'SELECT') {
        const value = el.options[el.selectedIndex]?.text || el.value;
        window.__recorderEmit({ type: 'select', selector, label, value });
      } else if (el.type === 'file') {
        // File inputs become image fields automatically.
        window.__recorderEmit({ type: 'input', selector, label, value: '', fieldType: 'image' });
      } else {
        // Text inputs / textareas — 'change' fires on commit (blur/Enter) and is
        // more reliable than 'blur' for some MUI-wrapped fields.
        captureTextValue(el);
      }
    }, true);

    // ── Blur capture (text inputs / textareas) — belt-and-suspenders ───────
    document.addEventListener('blur', (e) => {
      if (isInsideOverlay(e.target)) return;
      captureTextValue(e.target);
    }, true);

    // ── focusout — bubbles, so it fires even when 'blur' (which doesn't bubble)
    //    is swallowed by a wrapper that stops propagation. Covers MUI fields. ─
    document.addEventListener('focusout', (e) => {
      if (isInsideOverlay(e.target)) return;
      captureTextValue(e.target);
    }, true);

    // ── Track navigation ────────────────────────────────────────────────────
    // Skip about:blank — it's an intermediate state during SPA route changes
    // that adds noise and breaks subsequent steps when re-executed.
    window.addEventListener('load', () => {
      const url = window.location.href;
      if (/^about:/i.test(url)) return;
      window.__recorderEmit({ type: 'navigation', value: url });
    });

    // ── Inject overlay panel ────────────────────────────────────────────────
    function injectPanel() {
      if (document.getElementById('__meesho_recorder_panel')) return;
      const panel = document.createElement('div');
      panel.id = '__meesho_recorder_panel';
      panel.style.cssText = `
        position:fixed;top:16px;right:16px;width:340px;z-index:2147483647;
        background:#1e1e2e;color:#fff;border-radius:12px;padding:16px;
        font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;
        box-shadow:0 8px 32px rgba(0,0,0,.5);border:2px solid #f43397;
        line-height:1.4;
      `;
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="color:#f43397;font-size:14px;">🔴 Recording Path</strong>
          <span id="__rec_count" style="background:#f43397;padding:2px 8px;border-radius:10px;font-size:11px;">0</span>
        </div>
        <p style="margin:0 0 10px 0;color:#aaa;font-size:11px;">
          Walk through Meesho's listing form normally. Every click, dropdown, and field is captured.
        </p>
        <div id="__rec_list" style="max-height:160px;overflow-y:auto;background:#0f0f1a;border-radius:6px;padding:8px;font-size:11px;font-family:monospace;margin-bottom:10px;"></div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button id="__rec_pause" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">⏸ Pause</button>
          <button id="__rec_clear" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">🗑 Clear</button>
        </div>
        <button id="__rec_finish" style="width:100%;padding:10px;background:#f43397;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">Save &amp; Finish</button>
      `;
      document.body.appendChild(panel);

      let isPaused = false;
      document.getElementById('__rec_pause').addEventListener('click', () => {
        isPaused = !isPaused;
        document.getElementById('__rec_pause').textContent = isPaused ? '▶ Resume' : '⏸ Pause';
        window.__recorderPauseToggle(isPaused);
      });

      document.getElementById('__rec_clear').addEventListener('click', () => {
        if (!confirm('Clear all recorded events?')) return;
        document.getElementById('__rec_list').innerHTML = '';
        document.getElementById('__rec_count').textContent = '0';
        window.__recorderClear();
      });

      // Finish recording. Path details (name, SKU, description) are collected
      // in the app's PathConfig screen — NOT here — because Meesho's page modals
      // use focus-traps that make injected overlay inputs un-typeable.
      document.getElementById('__rec_finish').addEventListener('click', () => {
        window.__recorderFinish();
        panel.innerHTML =
          '<div style="text-align:center;padding:24px;color:#4ade80;font-weight:bold;">✅ Recording saved!<br/>' +
          '<span style="font-size:11px;color:#aaa;font-weight:normal;">Switch back to the Meesho Lister app to name &amp; configure this path.</span></div>';
      });

      // Hook into emit so we can reflect events in the UI list
      const originalEmit = window.__recorderEmit;
      window.__recorderEmit = function (ev) {
        try {
          const list = document.getElementById('__rec_list');
          const counter = document.getElementById('__rec_count');
          if (list && !isPaused) {
            const line = document.createElement('div');
            line.style.cssText = 'color:#ddd;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            const icon = { click: '👆', select: '📋', input: '📝', navigation: '📍' }[ev.type] || '•';
            line.textContent = `${icon} ${ev.label || ev.value || ev.selector || ''}`;
            list.appendChild(line);
            list.scrollTop = list.scrollHeight;
            counter.textContent = list.children.length;
          }
        } catch {}
        return originalEmit.apply(this, arguments);
      };
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectPanel);
    } else {
      injectPanel();
    }

    // Expose a manual installer so Node can force-inject into an already-loaded
    // page (reused browser session) where the init script wouldn't re-run.
    window.__meeshoInstallRecorder = injectPanel;
  });

  // ─── Ensure the overlay is actually present ─────────────────────────────────
  // WHY: addInitScript only runs on NEW document loads. getSession() may return
  // a browser a previous run left open and already loaded — the init script
  // won't fire on it, so the pink panel never appears and nothing is captured.
  // Navigate to the supplier home for a clean starting point (this triggers the
  // init script), then verify the panel exists; if not, inject it directly.
  try {
    log('Preparing a clean recording window...');
    await page.goto('https://supplier.meesho.com/panel/v3/new/growth/vaqbo/home', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    const hasPanel = await page.locator('#__meesho_recorder_panel').count().catch(() => 0);
    if (!hasPanel) {
      await page.evaluate(() => window.__meeshoInstallRecorder && window.__meeshoInstallRecorder()).catch(() => {});
    }
  } catch (e) {
    log(`Could not auto-open the start page (${e.message}). Navigate to Meesho manually — the recorder is active.`);
  }

  // ─── Wait for user to finish ────────────────────────────────────────────────
  log('Recording started. Walk through Meesho\'s listing form, then click "Save & Finish".');

  await finishPromise;

  // ─── Assemble + persist PathConfig ──────────────────────────────────────────
  // Path details (name, SKU pattern, description) are collected in the app's
  // PathConfig screen, NOT in the browser overlay — Meesho's page modals use
  // focus-traps that block injected overlay inputs. So we save with a default
  // name + a timestamped folder, and the app fills in the rest.
  const now = new Date().toISOString();
  const stamp = Date.now();
  const safeName = `recording_${stamp}`;

  /** @type {import('../types/models.js').PathConfig} */
  const pathConfig = {
    name: `New Recording ${new Date().toLocaleString('en-IN')}`,
    skuPattern: '',
    productDescription: '',
    steps: state.steps,
    fields: state.fields,
    sharedImages: ['img2.jpg', 'img3.jpg', 'img4.jpg'],
    _folder: safeName,
    createdAt: now,
    updatedAt: now,
  };

  const dir = path.join(PATHS_DIR, safeName);
  await fs.mkdir(path.join(dir, 'shared_images'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(pathConfig, null, 2), 'utf8');

  log(`✓ Path saved to ${dir}`, 'success');
  log('Captured ' + state.steps.length + ' steps and ' + state.fields.length + ' fields.');

  // Give the user a moment to read the success message before closing.
  await page.waitForTimeout(2500);
  await closeSession({ context }).catch(() => {});

  return { pathConfig, savedTo: dir };
}
