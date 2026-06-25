import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { sessionDirFor } from '../server/profiles.js';

// WHY: A persistent profile dir means cookies, localStorage, and IndexedDB are
// all automatically restored on next launch. Far simpler than manually
// serialising cookies to JSON, and survives Meesho's session token rotation.
// Each ACCOUNT (profile) gets its own dir — data/.browser-profile/<profileId> —
// so the three Meesho logins never overwrite each other.
const MEESHO_URL  = 'https://supplier.meesho.com/';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;   // 3 minutes for manual fallback

// WHY: Chromium can only have one instance using a given persistent profile
// dir. We cache the active context PER PROFILE so back-to-back runs (or a new run
// while the previous browser is still open) reuse it instead of crashing on a
// "profile in use" lock. Reuse also skips the login flow — already authenticated.
const _contexts = new Map();   // profileId -> BrowserContext

/**
 * Heuristic — we consider the user "logged in" once the URL no longer
 * contains /login or /auth.  Meesho redirects to /panel/... after success.
 */
async function isLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const url = page.url();
  return !url.includes('/login') && !url.includes('/auth') && url.includes('meesho.com');
}

/**
 * Attempt to fill the email + password and submit.  Resilient to selector
 * changes by trying multiple common patterns.  Returns true on success.
 */
async function attemptLogin(page, email, password, log) {
  log('Looking for email field...');

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
  ];
  let emailSel = null;
  for (const s of emailSelectors) {
    if (await page.locator(s).first().isVisible().catch(() => false)) { emailSel = s; break; }
  }
  if (!emailSel) { log('No email field detected.'); return false; }

  await page.fill(emailSel, email);
  log('Email entered.');

  // Some flows use a 2-step form: enter email → click Continue → enter password.
  const continueBtn = page.locator(
    'button:has-text("Continue"), button:has-text("Next"), button:has-text("Proceed")'
  ).first();
  if (await continueBtn.isVisible().catch(() => false)) {
    await continueBtn.click();
    await page.waitForTimeout(2000);
  }

  const passSelectors = ['input[type="password"]', 'input[name="password"]'];
  let passSel = null;
  for (const s of passSelectors) {
    if (await page.locator(s).first().isVisible().catch(() => false)) { passSel = s; break; }
  }
  if (!passSel) { log('No password field detected.'); return false; }

  await page.fill(passSel, password);
  log('Password entered.');

  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
  ];
  for (const s of submitSelectors) {
    const btn = page.locator(s).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      log('Login submitted.');
      break;
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  return await isLoggedIn(page);
}

/**
 * Launch headed Chromium, ensure the user is logged into Meesho, return the page.
 * On first launch this performs a real login; subsequent launches reuse the profile.
 *
 * @param {(msg: string) => void} [logFn] - Progress callback (default: console.log)
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
export async function getSession(logFn = console.log, profile = null) {
  const log = logFn;
  const profileId = profile?.id || 'yatin';
  const PROFILE_DIR = path.resolve(sessionDirFor(profileId));

  // ─── Reuse an open browser session for THIS profile if there is one ─────────
  // The page may be on the dashboard, mid-form, or a success screen — the
  // executor's first navigate step handles getting us back to the right URL.
  const cached = _contexts.get(profileId);
  if (cached) {
    try {
      const pages = cached.pages();
      const reusedPage = pages[0] || await cached.newPage();
      // Sanity check: if user manually closed the browser, this will throw.
      await reusedPage.evaluate(() => 1);
      log('✓ Reusing open browser session — login skipped.');
      // Bring the window to front so the user can see what's happening.
      await reusedPage.bringToFront().catch(() => {});
      return { context: cached, page: reusedPage };
    } catch {
      // Stale reference — context or page died. Fall through to a fresh launch.
      _contexts.delete(profileId);
    }
  }

  // Credentials come from the active profile; fall back to .env for safety.
  const email = profile?.email || process.env.MEESHO_EMAIL;
  const password = profile?.password || process.env.MEESHO_PASSWORD;
  if (!email || !password) {
    throw new Error(`No Meesho email/password set for this account ("${profile?.name || profileId}"). Add them in Settings → Profiles.`);
  }

  await fs.mkdir(PROFILE_DIR, { recursive: true });

  log('Launching Chromium...');
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,                    // use full window size
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    // Most common cause: an external Chromium (or a previous Node process that
    // didn't clean up) is still using the profile dir.
    if (/in use|profile|locked|SingletonLock/i.test(String(err.message))) {
      throw new Error(
        'A Chromium browser using the saved Meesho profile is already open. ' +
        'Close that browser window first, then try again.'
      );
    }
    throw err;
  }

  // Cache for reuse. When the context closes (manual close or closeSession),
  // drop it from the per-profile cache automatically.
  _contexts.set(profileId, context);
  context.on('close', () => {
    if (_contexts.get(profileId) === context) _contexts.delete(profileId);
  });

  const page = context.pages()[0] || await context.newPage();

  log('Opening Meesho supplier panel...');
  await page.goto(MEESHO_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  if (await isLoggedIn(page)) {
    log('✓ Already logged in (session restored).');
    return { context, page };
  }

  log('Not logged in — attempting automatic login...');
  const success = await attemptLogin(page, email, password, log);
  if (success) {
    log('✓ Auto-login successful.');
    return { context, page };
  }

  // Manual fallback — Meesho may show OTP/captcha or have changed selectors.
  log('Auto-login could not complete. Please finish logging in manually in the browser.');
  log(`Waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes for you to log in...`);

  const start = Date.now();
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    if (await isLoggedIn(page)) {
      log('✓ Login detected.');
      return { context, page };
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Login timed out. Please check credentials and try again.');
}

/**
 * Close the persistent browser context.
 */
export async function closeSession({ context }) {
  for (const [id, ctx] of _contexts) {
    if (ctx === context) _contexts.delete(id);
  }
  await context?.close().catch(() => {});
}
