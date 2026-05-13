import { callGeminiJSON } from './client.js';

const MAX_ELEMENTS = 80;          // cap so the prompt stays under flash-lite's budget
const TEXT_LIMIT   = 80;          // truncate visible text per element to keep tokens low

/**
 * When a recorded selector fails at runtime, ask Gemini to look at the page
 * and pick the element that matches the recorded intent.
 *
 * Strategy:
 *   1. Snapshot every viewport-visible interactive element with a temp marker.
 *   2. Send a compact numbered list to Gemini with the action + intent.
 *   3. Gemini returns an index (or -1 if no match).
 *   4. Re-compute a stable selector for the chosen element and return it.
 *
 * Never throws on AI failure — returns null so the caller can fall back to the
 * manual recovery overlay.
 *
 * @param {Object}   args
 * @param {import('playwright').Page} args.page
 * @param {Object}   args.step           - { action, label, value, selector }
 * @param {(type: string, text: string) => void} args.log
 * @returns {Promise<{ selector: string, reason: string } | null>}
 */
export async function findElementWithAI({ page, step, log }) {
  try {
    // 1) Snapshot interactive elements ── runs in the browser.
    const snapshot = await page.evaluate((MAX) => {
      // Mark each candidate with a unique temporary attribute so we can locate
      // it again from Node-side after Gemini picks an index.
      const ATTR = 'data-meesho-ai-id';

      // Clean up any leftover markers from a previous call.
      document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

      const SELECTORS = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="option"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="link"]',
        'label',
        'li[role]',
        '[aria-haspopup]',
      ];

      const all = Array.from(document.querySelectorAll(SELECTORS.join(', ')));
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Filter to viewport-visible elements with non-empty text or identity.
      const visible = all.filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.bottom < 0 || r.top > vh) return false;
        if (r.right < 0 || r.left > vw) return false;
        const cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
        return true;
      });

      // De-duplicate: if a child and parent both match, prefer the more specific (deeper) one.
      const filtered = visible.filter((el) => {
        return !visible.some((other) => other !== el && el.contains(other));
      });

      const limited = filtered.slice(0, MAX);
      const list = limited.map((el, i) => {
        el.setAttribute(ATTR, String(i));
        const text = (el.innerText || el.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 80);
        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          text,
          role: el.getAttribute('role') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          dataTestid: el.getAttribute('data-testid') || '',
          type: (el.getAttribute('type') || '').toLowerCase(),
          placeholder: el.getAttribute('placeholder') || '',
          href: el.getAttribute('href') || '',
        };
      });

      return { url: window.location.href, title: document.title, list };
    }, MAX_ELEMENTS);

    if (snapshot.list.length === 0) {
      log('info', '🤖 No interactive elements found on the page — AI can\'t help here.');
      await clearMarkers(page);
      return null;
    }

    // 2) Build prompt + ask Gemini.
    const prompt = buildPrompt(step, snapshot);
    log('info', `🤖 Asking Gemini to locate "${step.label}" among ${snapshot.list.length} elements...`);

    const result = await callGeminiJSON(prompt, {
      temperature: 0.3,             // deterministic-leaning
      log: (m) => log('info', `  ${m}`),
    });

    if (typeof result.index !== 'number' || result.index < 0) {
      log('info', `🤖 Gemini declined: ${result.reason || 'no match'}`);
      await clearMarkers(page);
      return null;
    }

    if (result.index >= snapshot.list.length) {
      log('info', `🤖 Gemini returned out-of-range index ${result.index}.`);
      await clearMarkers(page);
      return null;
    }

    // 3) Re-compute a stable selector for the chosen element.
    const selector = await page.evaluate(({ aiId }) => {
      const ATTR = 'data-meesho-ai-id';
      const el = document.querySelector(`[${ATTR}="${aiId}"]`);
      if (!el) return null;

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

        const rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const usable = rawText && rawText.length >= 2 && rawText.length <= 80
          && /[A-Za-z0-9]/.test(rawText)
          && !/^[\s​-‍﻿]+$/.test(rawText);

        if (usable && /^(button|a|li|option|label|span|div|td|th)$/.test(tag)) {
          return `text="${rawText.replace(/"/g, '\\"')}"`;
        }

        if (el.classList.length > 0) {
          const classes = Array.from(el.classList)
            .filter((c) => c && !/^(active|focused|selected|hover)$/i.test(c))
            .slice(0, 2)
            .map((c) => `.${CSS.escape(c)}`).join('');
          if (classes) return `${tag}${classes}`;
        }

        // Last-resort path
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

      const sel = getSelector(el);
      // Clean up all markers now that we have what we need.
      document.querySelectorAll(`[${ATTR}]`).forEach((e) => e.removeAttribute(ATTR));
      return sel;
    }, { aiId: result.index });

    if (!selector) {
      log('info', '🤖 Could not compute a selector for the AI-suggested element.');
      return null;
    }

    return { selector, reason: result.reason || '' };
  } catch (err) {
    log('info', `🤖 AI nav failed: ${err.message}`);
    await clearMarkers(page).catch(() => {});
    return null;
  }
}

async function clearMarkers(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-meesho-ai-id]').forEach((el) =>
      el.removeAttribute('data-meesho-ai-id')
    );
  }).catch(() => {});
}

function buildPrompt(step, snapshot) {
  // One compact line per element. Keep tokens tight.
  const lines = snapshot.list.map((e) => {
    const parts = [`[${e.index}]`, e.tag.toUpperCase().padEnd(8)];
    if (e.text) parts.push(`text="${truncate(e.text, TEXT_LIMIT)}"`);
    if (e.role) parts.push(`role="${e.role}"`);
    if (e.ariaLabel) parts.push(`aria-label="${truncate(e.ariaLabel, 60)}"`);
    if (e.id) parts.push(`id="${e.id}"`);
    if (e.dataTestid) parts.push(`testid="${e.dataTestid}"`);
    if (e.name) parts.push(`name="${e.name}"`);
    if (e.placeholder) parts.push(`placeholder="${truncate(e.placeholder, 40)}"`);
    if (e.type) parts.push(`type="${e.type}"`);
    if (e.href) parts.push(`href="${truncate(e.href, 50)}"`);
    return parts.join(' ');
  }).join('\n');

  return `You are helping a browser-automation script recover from a broken selector.

The script was trying to execute a recorded step but the original selector no longer matches anything on the page. Pick the element that best matches the recorded intent.

RECORDED STEP:
  Action:   ${step.action}
  Intent:   ${step.label || '(no label)'}
  ${step.value ? `Value:    ${truncate(step.value, 120)}` : ''}
  Original selector that failed: ${truncate(step.selector || '', 120)}

CURRENT PAGE:
  URL:    ${snapshot.url}
  Title:  ${snapshot.title}

INTERACTIVE ELEMENTS ON SCREEN (numbered):
${lines}

Respond with a single JSON object: { "index": N, "reason": "one short sentence" }.
- "index" is the index of the matching element from the list above.
- If NO element is a confident match, return { "index": -1, "reason": "..." }.
- Prefer elements whose visible text or aria-label most closely matches the recorded intent.
- For numeric/option intents (like "5" for a 5% GST option), match the element whose text contains that value AS A WHOLE WORD or as a labelled option.
- Output JSON only, no preamble.`;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
