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
  await context.exposeFunction('__recorderEmit', (event) => {
    if (state.paused) return;
    handleEvent(event);
  });

  await context.exposeFunction('__recorderFinish', (config) => resolveFinish(config));

  await context.exposeFunction('__recorderPauseToggle', (paused) => {
    state.paused = paused;
    log(paused ? '⏸  Recording paused.' : '▶  Recording resumed.');
  });

  await context.exposeFunction('__recorderClear', () => {
    state.steps = [];
    state.fields = [];
    state.seen.clear();
    log('🗑  Recording cleared.');
  });

  function handleEvent(ev) {
    const { type, selector, label, value, fieldType } = ev;

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
      state.steps.push({ action: 'click', selector, label });
      log(`👆 Click: ${label}`);
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
      let fieldIndex;
      if (state.seen.has(selector)) {
        fieldIndex = state.fields.findIndex((f) => f.selector === selector);
        // Update fixedValue in case user retyped
        if (state.fields[fieldIndex]) state.fields[fieldIndex].fixedValue = value;
      } else {
        fieldIndex = state.fields.length;
        state.fields.push({
          fieldName: label || selector,
          selector,
          type: fieldType || 'fixed',     // user can change in the app later
          fixedValue: fieldType === 'image' ? '' : value,
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

      // --- Visible-text strategies (Playwright text engine) ---------------
      // Use innerText (not textContent) so we capture only what the user sees.
      const rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const usable = rawText && rawText.length >= 2 && rawText.length <= 80
        && /[A-Za-z]/.test(rawText)               // must contain letters (not just numbers)
        && !/^[\s​-‍﻿]+$/.test(rawText);  // not just whitespace/zero-width

      // 5. Role + accessible name (Playwright's `role` locator).
      const role = el.getAttribute('role') || implicitRole(el);
      if (role && usable) {
        // Escape quotes inside text for the locator string.
        const safe = rawText.replace(/"/g, '\\"');
        return `role=${role}[name="${safe}"]`;
      }

      // 6. Visible-text exact match for clickable elements.
      if (usable && /^(button|a|li|option|label|span|div|td|th)$/.test(tag)) {
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
    // Walk to the nearest SEMANTIC ancestor — buttons, links, list options, etc.
    // Avoid capturing opaque wrapper divs that have no identity. If nothing
    // semantic is in scope, fall back to the click target itself.
    const SEMANTIC_TAGS = 'button, a, [role="button"], [role="option"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="link"], label, li, option, input[type="checkbox"], input[type="radio"]';

    function findClickTarget(el) {
      if (!el) return null;
      const semantic = el.closest && el.closest(SEMANTIC_TAGS);
      return semantic || el;
    }

    function isMeaningfulClick(el) {
      if (!el) return false;
      // Skip clicks on the document root or layout containers with no identity.
      if (el === document.body || el === document.documentElement) return false;
      // Skip elements whose visible text is only zero-width characters.
      const text = (el.innerText || '').replace(/[\s​-‍﻿]+/g, '').trim();
      const hasText = text.length > 0;
      const hasIdentity =
        el.id ||
        el.getAttribute('name') ||
        el.getAttribute('data-testid') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('role') ||
        ['BUTTON', 'A', 'LI', 'OPTION', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName);
      // Need either visible text OR a semantic identity to be worth capturing.
      return hasText || hasIdentity;
    }

    document.addEventListener('click', (e) => {
      if (isInsideOverlay(e.target)) return;
      const el = findClickTarget(e.target);
      if (!isMeaningfulClick(el)) return;
      const selector = getSelector(el);
      if (!selector) return;
      window.__recorderEmit({ type: 'click', selector, label: getLabel(el) });
    }, true);

    // ── Change capture (selects, checkboxes, file inputs) ──────────────────
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
      }
    }, true);

    // ── Blur capture (text inputs / textareas) ─────────────────────────────
    document.addEventListener('blur', (e) => {
      if (isInsideOverlay(e.target)) return;
      const el = e.target;
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
      if (['file', 'checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
      const selector = getSelector(el);
      if (!selector) return;
      const value = el.value;
      if (!value) return;
      window.__recorderEmit({ type: 'input', selector, label: getLabel(el), value });
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

      document.getElementById('__rec_finish').addEventListener('click', showConfigForm);

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

    function showConfigForm() {
      const panel = document.getElementById('__meesho_recorder_panel');
      if (!panel) return;
      panel.innerHTML = `
        <strong style="color:#f43397;display:block;margin-bottom:12px;font-size:14px;">⚙️ Configure Path</strong>
        <label style="display:block;margin-bottom:4px;font-size:11px;color:#aaa;">Path Name</label>
        <input id="__cfg_name" placeholder="Faux Fur Cushion Cover"
          style="width:100%;padding:8px;background:#0f0f1a;border:1px solid #333;color:#fff;border-radius:4px;margin-bottom:10px;box-sizing:border-box;" />
        <label style="display:block;margin-bottom:4px;font-size:11px;color:#aaa;">SKU Pattern (X = random number)</label>
        <input id="__cfg_sku" placeholder="WH_FURR/X"
          style="width:100%;padding:8px;background:#0f0f1a;border:1px solid #333;color:#fff;border-radius:4px;margin-bottom:10px;box-sizing:border-box;" />
        <label style="display:block;margin-bottom:4px;font-size:11px;color:#aaa;">Product Description (used by AI)</label>
        <textarea id="__cfg_desc" rows="3" placeholder="White faux fur cushion cover, 16x16 inch, soft texture, for sofa"
          style="width:100%;padding:8px;background:#0f0f1a;border:1px solid #333;color:#fff;border-radius:4px;margin-bottom:10px;box-sizing:border-box;font-family:inherit;resize:vertical;"></textarea>
        <p style="font-size:11px;color:#888;margin:0 0 10px;">After saving, mark which fields are AI-generated in the Meesho Lister app.</p>
        <button id="__cfg_save" style="width:100%;padding:10px;background:#f43397;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">Save Path</button>
      `;

      document.getElementById('__cfg_save').addEventListener('click', () => {
        const name = document.getElementById('__cfg_name').value.trim();
        const skuPattern = document.getElementById('__cfg_sku').value.trim();
        const productDescription = document.getElementById('__cfg_desc').value.trim();
        if (!name) { alert('Please enter a path name.'); return; }
        if (!skuPattern || !skuPattern.includes('X')) {
          alert('SKU pattern must include an X (it gets replaced with a random number).');
          return;
        }
        window.__recorderFinish({ name, skuPattern, productDescription });
        panel.innerHTML = '<div style="text-align:center;padding:24px;color:#0f0;">✅ Saved!<br/><span style="font-size:11px;color:#aaa;">You can close this browser window.</span></div>';
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectPanel);
    } else {
      injectPanel();
    }
  });

  // ─── Wait for user to finish ────────────────────────────────────────────────
  log('Recording started. Walk through Meesho\'s listing form, then click "Save & Finish".');

  const userConfig = await finishPromise;

  // ─── Assemble + persist PathConfig ──────────────────────────────────────────
  const now = new Date().toISOString();
  /** @type {import('../types/models.js').PathConfig} */
  const pathConfig = {
    name: userConfig.name,
    skuPattern: userConfig.skuPattern,
    productDescription: userConfig.productDescription,
    steps: state.steps,
    fields: state.fields,
    sharedImages: ['img2.jpg', 'img3.jpg', 'img4.jpg'],
    createdAt: now,
    updatedAt: now,
  };

  const safeName = userConfig.name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
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
