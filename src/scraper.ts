// Pension / קרן השתלמות / קופות גמל connector.
//
// Israeli pension, gemel and study-fund providers each run their own member
// portal — there is no shared scraping library for them the way
// israeli-bank-scrapers covers the banks. This module drives a provider's
// portal in a Puppeteer browser and reads the accumulated balance of every
// product the member holds.
//
// Migdal, Harel and Clal use **passwordless OTP login** — the library fills
// the form, relays the SMS code via your `onOtpNeeded` callback, and reads
// the balances headless.
//
// Meitav and Menora sit behind CAPTCHA bot-walls (reCAPTCHA Enterprise /
// Radware + hCaptcha) that resist automation, so they run in a **visible
// Chromium window**: the library pre-fills the ID/phone, the user clears
// the security check and enters the SMS code themselves, then the library
// reads the balances. The session cookies are saved (via the SessionStore
// you supply, or the default file-based one) so the next sync resumes
// already logged in — no sign-in at all — until they expire.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import puppeteerVanilla, { type Browser, type Frame, type Page } from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type {
  OtpCallback,
  PensionAccount,
  PensionCompanyInfo,
  PensionScrapeOutcome,
  ScrapePensionArgs,
  SessionStore,
} from './types.js';
import { createFileSessionStore, defaultDataDir } from './session.js';

// Internal aliases — the rest of the file was written against these names
// and is left untouched so it reads identically to the Hon source.
type NormalizedAccount = PensionAccount;
type ScrapeOutcome = PensionScrapeOutcome;
type CompanyInfo = PensionCompanyInfo;

// A minimal handle the helpers expect; it carries the cookies that were
// loaded into the browser and a save() that flushes them after a sync. Both
// adapt to the user-supplied SessionStore. The library does not require the
// caller to manage this — `scrapePension` builds one internally.
interface SessionHandle {
  cookies?: unknown[];
  save(cookies: unknown[]): Promise<void>;
}

async function restoreSession(browser: Browser, session?: SessionHandle): Promise<boolean> {
  const cookies = session?.cookies;
  if (!cookies || cookies.length === 0) return false;
  try {
    await browser.setCookie(...(cookies as Parameters<Browser['setCookie']>));
    return true;
  } catch {
    return false;
  }
}

async function persistSession(browser: Browser, session?: SessionHandle): Promise<void> {
  if (!session) return;
  try {
    const cookies = await browser.cookies();
    await session.save(cookies as unknown as unknown[]);
  } catch {
    /* best effort */
  }
}

// Wrap the project's puppeteer with the stealth plugin — it masks the most
// obvious automation tells, which helps every portal load normally.
// puppeteer-extra's bundled types lag the installed puppeteer; the cast keeps
// the call site clean — the runtimes are compatible.
const puppeteer = addExtra(puppeteerVanilla as unknown as Parameters<typeof addExtra>[0]);
puppeteer.use(StealthPlugin());

// page.evaluate runs its callback in the browser, where these globals exist.
declare const document: any;
declare const location: any;
declare const Event: any;

interface PensionFund {
  id: string;
  /** Shown in the catalog / Add-connection picker. */
  name: string;
  /** Website host, used to show the provider's favicon as a logo. */
  domain: string;
  /** Member-portal login URL. */
  loginUrl: string;
  /** Credentials the user supplies — rendered as fields in the Add flow. */
  loginFields: string[];
  /** CSS selector for the ID-number input. */
  idSelector?: string;
  /** CSS selector for the phone-number input, when the portal needs one. */
  phoneSelector?: string;
  /** CSS selector for a phone-prefix <select> (050/052/…), when split out. */
  phonePrefixSelector?: string;
  /** CSS selector for the "send the code by SMS" radio, clicked to be sure. */
  smsRadioSelector?: string;
  /** CSS selector for a "I agree to the terms" checkbox that gates submit. */
  termsCheckboxSelector?: string;
  /** Text on the button that submits the form — omitted for interactive funds. */
  submitLabels?: string[];
  /** Page to open after login to reach the product balances, when separate. */
  productsUrl?: string;
  /** Visible button text to click first to reveal the login form (Harel). */
  openLoginLabel?: string;
  /** When set, the portal is behind a CAPTCHA / bot wall. Hon opens a visible
   *  Chromium window for it and the user signs in by hand; the connector then
   *  reads balances from the portal's API and saves the session. */
  interactive?: boolean;
}

const FUNDS: Record<string, PensionFund> = {
  migdal: {
    id: 'migdal',
    name: 'Migdal (מגדל)',
    domain: 'migdal.co.il',
    loginUrl: 'https://my.migdal.co.il/mymigdal/process/login',
    loginFields: ['id'],
    idSelector: '#username',
    smsRadioSelector: '#otpToCell',
    submitLabels: ['המשך', 'כניסה', 'שלח'],
    productsUrl: 'https://my.migdal.co.il/mymigdal/info/myproducts',
  },
  clal: {
    id: 'clal',
    name: 'Clal (כלל)',
    domain: 'clalbit.co.il',
    loginUrl: 'https://www.clalbit.co.il/login/',
    loginFields: ['id', 'phone'],
    idSelector: '[formcontrolname="tz"]',
    phoneSelector: '[formcontrolname="mobile"]',
    // The login form is Angular Material: SMS is the first delivery radio and
    // a terms checkbox gates the "שליחה" submit button.
    smsRadioSelector: '#mat-radio-2-input',
    termsCheckboxSelector: '#mat-checkbox-1-input',
    submitLabels: ['שליחה', 'שלח', 'המשך', 'כניסה'],
    productsUrl: 'https://www.clalbit.co.il/portfolio/',
  },
  harel: {
    id: 'harel',
    name: 'Harel (הראל)',
    domain: 'harel-group.co.il',
    loginUrl: 'https://www.harel-group.co.il/Pages/login-Page/Login.aspx',
    loginFields: ['id', 'phone'],
    idSelector: '#idUser',
    phoneSelector: '#phone',
    openLoginLabel: 'כניסה לאזור האישי',
    submitLabels: ['המשך', 'כניסה', 'שלח'],
    productsUrl:
      'https://www.harel-group.co.il/personal-info/my-harel/Pages/client-view.aspx',
  },
  // Meitav and Menora sit behind CAPTCHA bot-walls (reCAPTCHA Enterprise /
  // Radware + hCaptcha). They run in a visible Chromium window the user signs
  // in to; Hon pre-fills the ID/phone and reads the balances afterwards.
  meitav: {
    id: 'meitav',
    name: 'Meitav (מיטב)',
    domain: 'meitav.co.il',
    loginUrl: 'https://customers.meitav.co.il/v2/login/loginAmit',
    loginFields: ['id', 'phone'],
    idSelector: '#id-identity-input',
    // Meitav's phone is split: a prefix <select> (050/052/…) + a 7-digit number.
    phonePrefixSelector: 'select[name="prefixPhone"]',
    phoneSelector: '[name="phoneNumber"]',
    submitLabels: ['כניסה', 'התחברות', 'המשך', 'שליחה', 'שלח', 'אישור'],
    interactive: true,
  },
  menora: {
    id: 'menora',
    name: 'Menora Mivtachim (מנורה מבטחים)',
    domain: 'menoramivt.co.il',
    loginUrl: 'https://www.menoramivt.co.il/customer-login/',
    loginFields: ['id', 'phone'],
    idSelector: '#id-num',
    phoneSelector: '#email-phone-num',
    submitLabels: ['כניסה', 'התחברות', 'המשך', 'שליחה', 'שלח', 'אישור'],
    interactive: true,
  },
};

/**
 * Whether a fund opens a visible browser window the user signs in to — true
 * for the CAPTCHA-walled funds (Meitav/Menora).
 */
function isInteractive(fund: PensionFund): boolean {
  return Boolean(fund.interactive);
}

/** Catalog entries so the pension funds appear in the Add-connection picker. */
export const PENSION_COMPANIES: CompanyInfo[] = Object.values(FUNDS).map((fund) => ({
  id: fund.id,
  name: fund.name,
  loginFields: fund.loginFields,
  type: 'pension',
  domain: fund.domain,
  interactive: isInteractive(fund),
}));

export function isPensionCompany(companyId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FUNDS, companyId);
}

/** Every fund id the library knows how to scrape, in catalog order. */
export const FUND_IDS = Object.keys(FUNDS) as Array<
  'migdal' | 'clal' | 'harel' | 'meitav' | 'menora'
>;

// Set PENSION_SCRAPERS_HEADFUL=1 (or pass headless: false in args) to scrape
// with a visible browser — useful when a portal's WAF or bot-detection
// rejects a headless session.
const DEFAULT_HEADLESS = process.env.PENSION_SCRAPERS_HEADFUL !== '1';

// How long an interactive fund waits for the user to finish signing in (and
// pass the CAPTCHA + OTP) in the visible browser window before giving up.
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60_000;

// In a container Chromium runs as root with no user namespace, so its
// sandbox cannot start — set PENSION_SCRAPERS_NO_SANDBOX=1 to drop it. On a
// normal desktop the array stays empty so the sandbox stays on.
const SANDBOX_ARGS: string[] =
  process.env.PENSION_SCRAPERS_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// The OTP code-entry step exposes dedicated inputs. Migdal renders six boxes
// all named otp, otp2…otp6; a waitForSelector on this catches that step
// reliably — it polls the live DOM and does not depend on page text.
const OTP_FIELD_SELECTOR =
  'input[name="otp"], input[name="otp1"], input[id="otp"], ' +
  'input[autocomplete="one-time-code"]';

// Product keywords used to recognise a pension / gemel / study-fund balance.
const PRODUCT_KEYWORDS = [
  'קרן השתלמות', 'השתלמות', 'קופת גמל', 'גמל להשקעה', 'גמל',
  'קרן פנסיה', 'פנסיה', 'תגמולים', 'פיצויים', 'ביטוח מנהלים',
  'קצבה', 'חיסכון',
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(errorType: string, errorMessage: string): ScrapeOutcome {
  return { success: false, accounts: [], errorType, errorMessage };
}

/** Logs a pension-connector diagnostic line to the sidecar console (stderr). */
function plog(...parts: unknown[]): void {
  console.error('[pension]', ...parts);
}

/** Derives a debug-file path next to the run's failure screenshot. */
function debugSibling(screenshotPath: string | undefined, suffix: string): string | undefined {
  return screenshotPath ? screenshotPath.replace(/\.png$/i, suffix) : undefined;
}

/**
 * Launches a Chromium for a pension scrape and prepares a page: user agent,
 * Hebrew Accept-Language, the tsx `__name` shim, and a JSON-response collector
 * feeding `jsonResponses` (the dashboard's real balance data, kept for debug).
 * A headless launch sizes the viewport; a visible one lets the OS size the
 * window. CAPTCHA-walled funds launch visible so the user can sign in.
 *
 * `profileDir` opts into a persistent Chrome profile: the real installed
 * Google Chrome (less bot-detectable than the bundled Chromium) reusing a
 * dedicated on-disk profile, so cookies and reCAPTCHA reputation carry across
 * runs — the next sync resumes already signed in. Falls back to the bundled
 * Chromium when Chrome is not installed.
 */
async function launchPensionBrowser(
  headless: boolean,
  jsonResponses: { url: string; body: string }[],
  profileDir?: string,
): Promise<{ browser: Browser; page: Page }> {
  const launchOptions = {
    headless,
    defaultViewport: headless ? undefined : null,
    userDataDir: profileDir,
    args: [
      ...SANDBOX_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--lang=he-IL',
      ...(headless ? [] : ['--window-size=1280,960']),
    ],
  };
  let browser: Browser;
  try {
    // Prefer the real installed Chrome for a persistent profile.
    browser = await puppeteer.launch(
      profileDir ? { ...launchOptions, channel: 'chrome' } : launchOptions,
    );
  } catch (err) {
    if (!profileDir) throw err;
    // Chrome is not installed — fall back to the bundled Chromium, still with
    // the persistent profile so cookies survive between runs.
    plog('launchPensionBrowser: real Chrome unavailable, using bundled Chromium');
    browser = await puppeteer.launch(launchOptions);
  }
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  if (headless) await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
  // tsx/esbuild rewrites this file's functions with a `__name` helper. When a
  // function is handed to page.evaluate it runs in the browser, where that
  // helper is undefined — so define it as a no-op in every document.
  await page.evaluateOnNewDocument(
    'window.__name = window.__name || function (f) { return f; };',
  );
  // Collect JSON API responses — the dashboard's real balance data, and the
  // best material for tightening the balance reader after a real run.
  page.on('response', (res) => {
    const contentType = res.headers()['content-type'] ?? '';
    if (!contentType.includes('json') || jsonResponses.length >= 60) return;
    res
      .text()
      .then((body) => {
        if (body && body.length < 200_000) {
          jsonResponses.push({ url: res.url(), body });
        }
      })
      .catch(() => {});
  });
  return { browser, page };
}

/**
 * Logs into a pension provider's member portal and reads each product's
 * balance. The public entry point — drives the whole login itself, because
 * pension funds have no shared scraping library the way the banks do.
 */
export async function scrapePension(args: ScrapePensionArgs): Promise<ScrapeOutcome> {
  const {
    fundId,
    credentials,
    onProgress,
    onOtpNeeded,
    connectionId,
    session: userStore,
    screenshotPath,
    headless,
  } = args;

  const fund = FUNDS[fundId];
  if (!fund) return fail('CONFIG', `Unknown pension fund: ${fundId}`);
  // CAPTCHA-walled funds (Meitav/Menora) run in a visible window the user
  // signs in to; the rest are driven headless by the library.
  const captchaWalled = Boolean(fund.interactive);
  plog(`start ${fundId}: captchaWalled=${captchaWalled}`);

  // A non-CAPTCHA fund is driven entirely by the library, so its credentials
  // are required up front. A CAPTCHA-walled fund can always fall back to a
  // hand sign-in, so missing credentials there are not fatal.
  if (!captchaWalled) {
    if (!(credentials.id ?? '').trim()) {
      return fail('CONFIG', 'This pension connection needs an ID number.');
    }
    if (fund.phoneSelector && !(credentials.phone ?? '').trim()) {
      return fail('CONFIG', 'This pension connection needs a phone number.');
    }
  }

  if (!onOtpNeeded && !captchaWalled) {
    return fail('CONFIG',
      'This fund needs an onOtpNeeded callback to relay the SMS code.');
  }

  // Build a SessionHandle from the user-supplied store (or the default
  // file-based one). connectionId scopes saved cookies so two members of
  // the same fund can share a process without overwriting each other.
  const store: SessionStore = userStore ?? createFileSessionStore();
  const sessionKey = connectionId ?? `${fundId}-default`;
  const restoredCookies = await store.load(sessionKey).catch(() => null);
  const session: SessionHandle = {
    cookies: restoredCookies ?? undefined,
    save: (cookies) => store.save(sessionKey, cookies),
  };

  const htmlPath = debugSibling(screenshotPath, '-pension.html');
  const dataPath = debugSibling(screenshotPath, '-pension.json');
  const jsonResponses: { url: string; body: string }[] = [];

  let browser: Browser | undefined;
  let page!: Page;
  try {
    onProgress?.('Starting the browser…');
    // CAPTCHA-walled funds open a *visible* window the user signs in to,
    // using a persistent real-Chrome profile so the sign-in (and its
    // reCAPTCHA reputation) sticks across runs. The rest run headless.
    // The profile lives in the OS data dir so it survives process restarts.
    const profileDir =
      captchaWalled ? join(defaultDataDir(), 'browser-profiles', fundId) : undefined;
    const wantHeadless = headless ?? DEFAULT_HEADLESS;
    ({ browser, page } = await launchPensionBrowser(
      !captchaWalled && wantHeadless,
      jsonResponses,
      profileDir,
    ));

    // Replay a saved session's cookies before any navigation, so the portal
    // can recognise the session and skip the sign-in.
    await restoreSession(browser, session);

    // Fast path: with a saved session, open the products page directly. If the
    // portal still trusts the session it renders balances with no login and no
    // SMS code; otherwise it bounces to a login URL and the normal sign-in
    // runs. CAPTCHA-walled funds handle their own resume below. Any failure
    // here is non-fatal — the run just falls through to a full sign-in.
    if (!captchaWalled && fund.productsUrl && session?.cookies?.length) {
      onProgress?.('Resuming your saved session…');
      try {
        await page.goto(fund.productsUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        if (!/login/i.test(page.url())) {
          const resumed = await readBalances(fundId, page, screenshotPath).catch(
            () => [] as NormalizedAccount[],
          );
          if (resumed.length > 0) {
            await persistSession(browser, session);
            await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses).catch(
              () => {},
            );
            return { success: true, accounts: resumed };
          }
        }
      } catch {
        /* fall through to a normal sign-in */
      }
      onProgress?.('Saved session has expired — signing in again…');
    }

    onProgress?.('Opening the pension portal…');
    try {
      await page.goto(fund.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      // A CAPTCHA-walled fund's bot-wall may re-navigate the page during goto;
      // that race is harmless. For an automated fund a goto failure is real.
      if (!captchaWalled) throw err;
    }

    // CAPTCHA-walled funds (Meitav/Menora). A visible Chromium window is open:
    // a restored session may already be signed in; otherwise the user signs in
    // by hand. Hon pre-fills the ID/phone, polls the balance API, and on
    // success saves the session so the next sync resumes already logged in.
    if (captchaWalled) {
      // A restored session may still authenticate the balance API — try a
      // read before asking the user to sign in at all.
      if (session?.cookies?.length) {
        onProgress?.('Resuming your saved session…');
        const resumed = await readBalances(fundId, page, screenshotPath).catch(
          () => [] as NormalizedAccount[],
        );
        if (resumed.length > 0) {
          await persistSession(browser, session);
          await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses).catch(
            () => {},
          );
          return { success: true, accounts: resumed };
        }
      }
      // Not signed in — the user does it themselves in the visible window.
      // Hon pre-fills the ID and phone (fire-and-forget, so the balance poll
      // runs alongside) and waits for the sign-in to complete.
      onProgress?.(
        `A Chromium window is open — sign in to ${fund.name} there. Hon fills ` +
          'your ID and phone; you clear the security check and enter the SMS code.',
      );
      void prefillCredentials(page, fund, credentials).catch(() => {});
      onProgress?.('Waiting for you to finish signing in…');
      const deadline = Date.now() + INTERACTIVE_LOGIN_TIMEOUT_MS;
      let accounts: NormalizedAccount[] = [];
      while (Date.now() < deadline) {
        await delay(5000);
        if (page.isClosed()) break;
        try {
          accounts = await readBalances(fundId, page, screenshotPath);
        } catch {
          accounts = []; // a navigation mid-read — try again next tick
        }
        if (accounts.length > 0) break;
      }
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses).catch(
        () => {},
      );
      if (accounts.length === 0) {
        return fail(
          'INTERACTIVE_TIMEOUT',
          `Sign-in to ${fund.name} was not completed in the browser window. ` +
            'Open the connection again and finish signing in.',
        );
      }
      await persistSession(browser, session);
      return { success: true, accounts };
    }

    onProgress?.('Logging in…');
    if (!(await fillAndSubmitLogin(page, fund, credentials))) {
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
      return fail(
        'LOGIN_FAILED',
        'Could not find the login form on the portal. A debug page was saved.',
      );
    }

    // Both portals are passwordless: after login they send an SMS code and
    // show a code-entry step. waitForSelector reliably catches it — it polls
    // the live DOM for the code boxes, surviving the headless re-renders that
    // made an evaluate-based page check unreliable.
    onProgress?.('Waiting for the verification code…');
    const otpAppeared = await page
      .waitForSelector(OTP_FIELD_SELECTOR, { timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    if (!otpAppeared) {
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
      return fail(
        'LOGIN_FAILED',
        'The portal did not reach the verification-code step — the ID number ' +
          'may have been rejected. A debug page was saved.',
      );
    }

    // The guard at the top of scrapePension already returned for the no-OTP
    // case, so onOtpNeeded is guaranteed defined for headless funds here.
    const code = await onOtpNeeded!();
    onProgress?.('Submitting the verification code…');
    await enterOtpCode(page, (code ?? '').trim());

    // Let the portal finish signing in once the code is submitted.
    onProgress?.('Signing in…');
    await delay(7000);

    // Migdal shows balances on a separate "my products" page — the session
    // cookie is set now, so navigate straight there.
    if (fund.productsUrl) {
      onProgress?.('Opening your products…');
      try {
        await page.goto(fund.productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch {
        // fall through and read whatever page is loaded
      }
    }
    onProgress?.('Reading your balances…');
    await delay(4000); // let the products page render its data
    const accounts = await readBalances(fundId, page, screenshotPath);
    await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);

    if (accounts.length === 0) {
      return fail(
        'NEEDS_SELECTORS',
        'Signed in, but could not read the balances yet — the portal layout ' +
          'still needs mapping, or the code was not accepted. The rendered ' +
          'page was saved to the debug folder.',
      );
    }
    await persistSession(browser, session);
    return { success: true, accounts };
  } catch (err) {
    plog('EXCEPTION in', fundId, '—', err instanceof Error ? err.stack : String(err));
    if (browser) {
      const pages = await browser.pages().catch(() => []);
      if (pages[0]) {
        await saveDebug(pages[0], screenshotPath, htmlPath, dataPath, jsonResponses);
      }
    }
    return fail('EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Fills an input by CSS selector. Picks the visible match when a portal
 * duplicates an id, types with real keystrokes, then also sets the value via
 * JS with input/change events so an Angular reactive form registers it even
 * if the element was not cleanly interactable.
 */
async function fillField(page: Page, selector: string, value: string): Promise<boolean> {
  // A page navigating mid-query (e.g. a Radware bounce) makes $$ throw
  // "Execution context destroyed" — treat that as "no field" so the caller
  // simply retries rather than crashing the whole login.
  const handles = await page.$$(selector).catch(() => []);
  if (handles.length === 0) return false;
  let target = handles[0];
  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      target = handle;
      break;
    }
  }
  if (!target) return false;
  try {
    await target.click({ clickCount: 3 });
    await target.type(value, { delay: 45 });
  } catch {
    // not cleanly interactable — the JS fill below still sets the value
  }
  await target
    .evaluate((el: any, val: string) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, value)
    .catch(() => {});
  return true;
}

/** Clicks the first enabled element whose text matches one of `labels`. */
async function clickByText(page: Page, labels: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const off = (n: any): boolean =>
        Boolean(n.disabled) || n.getAttribute('aria-disabled') === 'true';
      for (const label of wanted) {
        const controls: any[] = Array.from(
          document.querySelectorAll(
            'button, input[type=submit], input[type=button], a, [role=button]',
          ),
        );
        let hit: any = controls.find((n: any) => {
          const t = norm(n.innerText || n.value || n.getAttribute('aria-label') || '');
          return !off(n) && (t === label || t.includes(label));
        });
        // Buttons built from plain <div>/<span> (e.g. Migdal's "המשך") carry no
        // button tag or role — take the innermost element whose own text is the
        // label; a click on it bubbles up to the real handler.
        if (!hit) {
          const plain: any[] = Array.from(
            document.querySelectorAll('span, div, a, p, li'),
          ).filter((n: any) => norm(n.innerText || '') === label && !off(n));
          plain.sort(
            (a: any, b: any) =>
              a.querySelectorAll('*').length - b.querySelectorAll('*').length,
          );
          hit = plain[0];
        }
        if (hit) {
          (hit.closest('button, a, [role=button]') || hit).click();
          return true;
        }
      }
      return false;
    }, labels);
  } catch {
    return false;
  }
}

/**
 * Fills a fund's phone field(s) from a raw phone string. Normalises to a local
 * 0XXXXXXXXX form, then either fills a single field or splits across a prefix
 * <select> (050/052/…) plus a 7-digit number field when the portal needs that.
 */
async function fillPhone(page: Page, fund: PensionFund, rawPhone: string): Promise<void> {
  if (!fund.phoneSelector) return;
  let phone = (rawPhone ?? '').replace(/\D/g, '');
  if (phone.startsWith('972')) phone = `0${phone.slice(3)}`;
  if (phone.length === 9 && phone.startsWith('5')) phone = `0${phone}`;
  if (fund.phonePrefixSelector && phone.length >= 4) {
    await page
      .evaluate(
        (sel: string, value: string) => {
          const el: any = document.querySelector(sel);
          if (!el) return;
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        fund.phonePrefixSelector,
        phone.slice(0, 3),
      )
      .catch(() => {});
    await fillField(page, fund.phoneSelector, phone.slice(3)).catch(() => false);
  } else {
    await fillField(page, fund.phoneSelector, phone || (rawPhone ?? '').trim()).catch(
      () => false,
    );
  }
}

/**
 * Fills the login form (ID number, plus phone where the portal needs it),
 * makes sure the code goes by SMS, and submits — which triggers the SMS code.
 */
async function fillAndSubmitLogin(
  page: Page,
  fund: PensionFund,
  credentials: Record<string, string>,
): Promise<boolean> {
  plog('fillAndSubmitLogin: entered for', fund.id);
  // Only automated funds reach here; interactive funds carry no selectors.
  if (!fund.idSelector || !fund.submitLabels) {
    plog('fillAndSubmitLogin: no idSelector/submitLabels — bailing');
    return false;
  }
  // Harel hides its login form behind a CTA button. The page also renders a
  // zero-size duplicate of that button, so target the *visible* one (real
  // bounding box) and click its centre with a real mouse click — page.click's
  // hit-test and a synthetic .click() both fail here; a mouse click works.
  if (fund.openLoginLabel) {
    try {
      await page.waitForSelector('button, [role=button]', { timeout: 40_000 });
      await delay(2000);
      const point = await page.evaluate((label: string) => {
        const nodes: any[] = Array.from(
          document.querySelectorAll('button, a, [role=button]'),
        );
        for (const node of nodes) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (text !== label) continue;
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, fund.openLoginLabel);
      if (point) {
        await page.mouse.click(point.x, point.y);
        await delay(1500);
      }
    } catch {
      // fall through — the idSelector wait below will fail clearly
    }
  }
  // Wait for the ID field and fill it. Menora's login can re-render between
  // the wait and the fill (Radware bot-check, SPA hydration), so the element
  // found a moment ago can be gone by fill time — retry a few rounds.
  let idFilled = false;
  for (let attempt = 1; attempt <= 6 && !idFilled; attempt += 1) {
    const ready = await page
      .waitForSelector(fund.idSelector, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      plog(`fillAndSubmitLogin: idSelector absent, attempt ${attempt}, url=${page.url()}`);
      continue;
    }
    await delay(1500); // let the form finish rendering
    idFilled = await fillField(page, fund.idSelector, (credentials.id ?? '').trim());
    if (!idFilled) {
      plog(`fillAndSubmitLogin: fillField missed, attempt ${attempt}, url=${page.url()}`);
    }
  }
  if (!idFilled) return false;
  plog('fillAndSubmitLogin: ID field filled');
  if (fund.phoneSelector) {
    await fillPhone(page, fund, credentials.phone ?? '');
  }
  if (fund.smsRadioSelector) {
    // A JS click checks the radio even when it is a visually-hidden custom
    // control (Puppeteer's page.click needs a visible, hit-testable target).
    await page
      .evaluate((sel: string) => {
        const radio: any = document.querySelector(sel);
        if (radio) radio.click();
      }, fund.smsRadioSelector)
      .catch(() => {});
  }
  if (fund.termsCheckboxSelector) {
    // A terms checkbox can gate submit; tick it if it is not already checked.
    await page
      .evaluate((sel: string) => {
        const box: any = document.querySelector(sel);
        if (box && !box.checked) box.click();
      }, fund.termsCheckboxSelector)
      .catch(() => {});
  }
  await delay(800); // let Angular validate the form and enable the button
  if (!(await clickByText(page, fund.submitLabels))) {
    await page.keyboard.press('Enter');
  }
  return true;
}

/**
 * Assists an interactive login: waits for the login form to appear — the user
 * is clearing the portal's CAPTCHA during that wait — then fills the ID and
 * phone fields with the stored credentials. The user still does the CAPTCHA,
 * the submit and the OTP; Hon only types the details it already holds. A no-op
 * when the fund exposes no selectors or no credentials were stored.
 */
async function prefillCredentials(
  page: Page,
  fund: PensionFund,
  credentials: Record<string, string>,
): Promise<void> {
  const id = (credentials.id ?? '').trim();
  if (!fund.idSelector || !id) return;
  // This wait spans the time the user spends on the CAPTCHA — the login form
  // only renders once they clear it.
  const formAppeared = await page
    .waitForSelector(fund.idSelector, { timeout: INTERACTIVE_LOGIN_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!formAppeared) return;
  await delay(900); // let the form settle
  await fillField(page, fund.idSelector, id).catch(() => false);
  await fillPhone(page, fund, credentials.phone ?? '');
}

/**
 * Types the verification code and submits it. The code field may be a single
 * input or several single-digit boxes — Migdal uses six boxes named
 * otp, otp2…otp6, so each digit is typed into its own box.
 */
async function enterOtpCode(page: Page, code: string): Promise<void> {
  const digits = code.replace(/\D/g, '');
  // Tag the OTP box(es): prefer inputs that identify themselves as OTP — named
  // otp/otp2… (Migdal), formcontrolname="otp" (Clal) or autocomplete="one-time-
  // code" (Harel/Clal). Only if none match fall back to the visible empty text
  // inputs, and even then skip search boxes — a stray search field next to the
  // OTP box would otherwise be mistaken for a second code box.
  const boxes = await page.evaluate(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    const visible = (el: any): boolean => Boolean(el.offsetWidth || el.offsetHeight);
    const isSearch = (el: any): boolean => {
      const id = (el.id || '') + ' ' + (el.getAttribute('name') || '');
      return (
        (el.getAttribute('type') || '').toLowerCase() === 'search' ||
        el.getAttribute('role') === 'searchbox' ||
        /search|חיפוש/i.test(id)
      );
    };
    let picked: any[] = inputs.filter((el: any) => {
      const key =
        el.getAttribute('name') || el.getAttribute('formcontrolname') || el.id || '';
      const oneTimeCode =
        (el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code';
      return (/^otp\d*$/i.test(key) || oneTimeCode) && visible(el) && !el.disabled;
    });
    if (picked.length === 0) {
      picked = inputs.filter((el: any) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const textLike = ['text', 'tel', 'number', 'password', ''].includes(type);
        return (
          textLike &&
          visible(el) &&
          !el.disabled &&
          !el.readOnly &&
          !el.value &&
          !isSearch(el)
        );
      });
    }
    picked.forEach((el: any, i: number) => el.setAttribute('data-hon-otp', String(i)));
    return picked.length;
  });

  if (boxes >= 2) {
    for (let i = 0; i < boxes && i < digits.length; i += 1) {
      await page.click(`[data-hon-otp="${i}"]`).catch(() => {});
      await page.type(`[data-hon-otp="${i}"]`, digits[i] ?? '', { delay: 80 });
    }
  } else if (boxes === 1) {
    await page.click('[data-hon-otp="0"]', { clickCount: 3 }).catch(() => {});
    await page.type('[data-hon-otp="0"]', digits, { delay: 60 });
  }

  await delay(600);
  // Submit — scoped to the OTP field's dialog so a stray "המשך" on a form
  // behind it (Harel keeps its login panel open behind the OTP modal) is not
  // clicked. Handles both real buttons and div/span-built buttons.
  const submitted = await page.evaluate(() => {
    const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
    const labels = ['המשך', 'אישור', 'כניסה', 'התחברות', 'שלח', 'Continue', 'Submit', 'Verify'];
    // "שלחו לי את הקוד שוב" (resend) contains "שלח" — never click a resend
    // control, or the code is re-sent instead of verified.
    const isResend = (t: string): boolean =>
      /שוב|חוזר|resend|send.?again|שלחו לי/i.test(t);
    const field: any = document.querySelector('[data-hon-otp]');
    const scopes: any[] = [];
    if (field) {
      const dialog = field.closest(
        '[role=dialog], dialog, [class*="modal" i], [class*="dialog" i], form',
      );
      if (dialog) scopes.push(dialog);
    }
    scopes.push(document);
    for (const scope of scopes) {
      const controls: any[] = Array.from(
        scope.querySelectorAll('button, input[type=submit], [role=button]'),
      ).filter((b: any) => !b.disabled && !isResend(norm(b.innerText || b.value || '')));
      // Prefer an exact label match; only then fall back to a contains match.
      let hit: any = controls.find((b: any) =>
        labels.includes(norm(b.innerText || b.value || '')),
      );
      if (!hit) {
        hit = controls.find((b: any) => {
          const t = norm(b.innerText || b.value || '');
          return labels.some((l) => t.includes(l));
        });
      }
      if (!hit) {
        // div/span-built buttons (Migdal's "המשך"): innermost exact-text node.
        const plain: any[] = Array.from(scope.querySelectorAll('span, div, a')).filter(
          (n: any) => labels.includes(norm(n.innerText || '')),
        );
        plain.sort(
          (a: any, b: any) => a.querySelectorAll('*').length - b.querySelectorAll('*').length,
        );
        hit = plain[0];
      }
      if (hit) {
        (hit.closest('button, a, [role=button]') || hit).click();
        return true;
      }
    }
    return false;
  });
  if (!submitted) await page.keyboard.press('Enter');
}

/**
 * Dispatches to the per-fund balance reader, falling back to a generic
 * heuristic. Used by both the automated flow and the interactive poll loop —
 * for an interactive fund this is called repeatedly and returns an empty list
 * until the user's sign-in authenticates the session.
 */
async function readBalances(
  companyId: string,
  page: Page,
  screenshotPath: string | undefined,
): Promise<NormalizedAccount[]> {
  if (companyId === 'migdal') return readMigdalBalances(page);
  if (companyId === 'harel') {
    return readHarelBalances(page, debugSibling(screenshotPath, '-harel-frame.html'));
  }
  if (companyId === 'clal') return readClalBalances(page);
  if (companyId === 'meitav') return readMeitavBalances(page);
  if (companyId === 'menora') return readMenoraBalances(page);
  return readGenericBalances(page);
}

/**
 * Reads balances from Migdal's "my products" page (verified live 2026-05-22):
 * each product is a `.table` block — the name is in an <a>, and the accumulated
 * balance is the <strong> whose preceding label reads "ערכי פדיון" (or, for a
 * gemel / study fund, "צבירה" / "יתרה"). Other <strong> values in the block
 * (deposits, projected monthly pension) are deliberately skipped by the label.
 */
async function readMigdalBalances(page: Page): Promise<NormalizedAccount[]> {
  await page.waitForSelector('.table', { timeout: 30_000 }).catch(() => {});
  let products: { name: string; balance: number }[] = [];
  try {
    products = (await page.evaluate(() => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const isBalanceLabel = (s: string): boolean =>
        /ערכי פדיון|צבירה|יתרה|סך חיסכון|סך צבירה/.test(s);
      const out: { name: string; balance: number }[] = [];
      const tables: any[] = Array.from(document.querySelectorAll('.table'));
      for (const table of tables) {
        const link = table.querySelector('a');
        const name = norm(link ? link.innerText : '');
        if (!name) continue;
        let balance = 0;
        const strongs: any[] = Array.from(table.querySelectorAll('strong'));
        for (const strong of strongs) {
          // The value's label is a nearby preceding sibling.
          let label = '';
          let prev = strong.previousElementSibling;
          for (let i = 0; prev && !label && i < 4; i += 1) {
            label = norm(prev.innerText || '');
            prev = prev.previousElementSibling;
          }
          if (!isBalanceLabel(label)) continue;
          const value = parseFloat(norm(strong.innerText).replace(/[^\d.]/g, ''));
          if (Number.isFinite(value) && value > balance) balance = value;
        }
        if (balance > 0) out.push({ name, balance });
      }
      return out;
    })) as { name: string; balance: number }[];
  } catch {
    return [];
  }
  return products.map((p) => ({
    accountNumber: `migdal:${p.name}`,
    label: p.name,
    balance: Math.round(p.balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/**
 * Reads balances from Harel's "client-view" widget (verified live 2026-05-22):
 * products render inside a cross-origin iframe whose URL contains
 * "client-view"; each tile pairs a product name with a "₪ <amount>" figure.
 */
async function readHarelBalances(
  page: Page,
  frameDumpPath?: string,
): Promise<NormalizedAccount[]> {
  // Pulls the product tiles out of the client-view widget frame: tries the
  // keyword-matched blocks first, then falls back to any block carrying a
  // shekel-sized figure so a single-product account still reports a balance.
  // The frame.evaluate callbacks stay inline and anonymous on purpose — that
  // keeps esbuild from injecting a `__name` wrapper, which need not exist in
  // this cross-origin frame.
  const extractTiles = async (
    frame: Frame,
  ): Promise<{ label: string; balance: number }[]> => {
    let hits: { label: string; balance: number }[] = [];
    try {
      hits = (await frame.evaluate((keywords: string[]) => {
        const results: { label: string; balance: number }[] = [];
        const blocks: any[] = Array.from(
          document.querySelectorAll('div, section, li, article'),
        );
        for (const block of blocks) {
          const text: string = (block.innerText || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 200) continue;
          if (!keywords.some((k) => text.includes(k))) continue;
          let largest = 0;
          for (const match of text.match(/[\d][\d.,]{3,}/g) || []) {
            const value = parseFloat(match.replace(/[^\d.,]/g, '').replace(/,/g, ''));
            if (Number.isFinite(value) && value > largest) largest = value;
          }
          if (largest < 1000) continue;
          const label = text
            .replace(/[\d][\d.,]*\s*₪?|₪/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50);
          results.push({ label: label || 'חיסכון', balance: largest });
        }
        return results;
      }, PRODUCT_KEYWORDS)) as { label: string; balance: number }[];
    } catch {
      hits = [];
    }
    if (hits.length > 0) return hits;
    try {
      hits = (await frame.evaluate(() => {
        const results: { label: string; balance: number }[] = [];
        const blocks: any[] = Array.from(document.querySelectorAll('div, section, li, article'));
        for (const block of blocks) {
          const text: string = (block.innerText || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 200) continue;
          if (!text.includes('₪')) continue;
          let largest = 0;
          for (const match of text.match(/[\d][\d.,]{3,}/g) || []) {
            const value = parseFloat(match.replace(/[^\d.,]/g, '').replace(/,/g, ''));
            if (Number.isFinite(value) && value > largest) largest = value;
          }
          if (largest < 1000) continue;
          const label = text
            .replace(/[\d][\d.,]*\s*₪?|₪/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50);
          results.push({ label: label || 'חיסכון', balance: largest });
        }
        return results;
      })) as { label: string; balance: number }[];
    } catch {
      hits = [];
    }
    return hits;
  };

  // The client-view widget is a single-spa micro-frontend inside a cross-origin
  // iframe; after sign-in Harel shows a loading screen first and the balance
  // tiles render well after the iframe document loads. Poll the widget by
  // running the real reader until it actually pulls a balance (up to ~75s) —
  // a check that just looks for "any number" matches the loading screen's own
  // digits and made the connector give up with a false "needs mapping".
  const deadline = Date.now() + 75_000;
  let frame: Frame | undefined;
  let found: { label: string; balance: number }[] = [];
  while (Date.now() < deadline) {
    // The portal greets a fresh session with a privacy-policy modal and a
    // cookie banner that sit over (and can stall) the widget. They can also
    // appear late, so clear them on every pass rather than just once.
    await clickByText(page, [
      'הבנתי, תודה', 'הבנתי', 'אישור', 'סגירה', 'סגור', 'קיבלתי',
    ]);
    frame = page
      .frames()
      .find((f) => /client-view|digital\.harel/.test(f.url()));
    if (frame) {
      found = await extractTiles(frame);
      if (found.length > 0) break;
    }
    await delay(1500);
  }

  // Always dump the widget frame's rendered HTML — if the reader missed, this
  // is the material to map the tile structure precisely on the next pass.
  if (frameDumpPath && frame) {
    try {
      writeFileSync(frameDumpPath, await frame.content(), 'utf8');
    } catch {
      /* best effort */
    }
  }

  // One entry per distinct balance; the tightest (shortest-label) block wins.
  const byBalance = new Map<number, string>();
  for (const item of found) {
    const prev = byBalance.get(item.balance);
    if (prev === undefined || item.label.length < prev.length) {
      byBalance.set(item.balance, item.label);
    }
  }
  return [...byBalance].map(([balance, label]) => ({
    accountNumber: `harel:${label}`,
    label,
    balance: Math.round(balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/**
 * Reads balances from Clal's portfolio page (verified live 2026-05-22):
 * `www.clalbit.co.il/portfolio/`. Each product is an `h2.link-title` (the
 * product type, e.g. "קרן פנסיה") paired with a sibling `.financial-data-sum`
 * whose spans (shekel + bigger-value + "." + smaller-value) concatenate to the
 * accrued balance. The page also lists non-savings products under "מוצרי עבר"
 * (e.g. travel insurance) — a product-keyword filter keeps only savings.
 */
async function readClalBalances(page: Page): Promise<NormalizedAccount[]> {
  let found: { label: string; provider: string; balance: number }[] = [];
  try {
    found = (await page.evaluate((keywords: string[]) => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const out: { label: string; provider: string; balance: number }[] = [];
      const titles: any[] = Array.from(document.querySelectorAll('h2.link-title'));
      for (const title of titles) {
        const label = norm(title.innerText || '');
        // Skip insurance and other non-savings products (travel, etc.).
        if (!keywords.some((k) => label.includes(k))) continue;
        const row = title.parentElement;
        const sumEl = row ? row.querySelector('.financial-data-sum') : null;
        if (!sumEl) continue;
        const raw = norm(sumEl.innerText || '').replace(/,/g, '');
        const value = parseFloat((raw.match(/[\d]+(?:\.[\d]+)?/) || ['0'])[0]);
        if (!Number.isFinite(value)) continue;
        // The provider name sits in a `.link-info` within the product card.
        let provider = '';
        let card = row;
        for (let i = 0; card && !provider && i < 6; i += 1) {
          const info = card.querySelector('.link-info');
          if (info) provider = norm(info.innerText || '');
          card = card.parentElement;
        }
        out.push({ label, provider, balance: value });
      }
      return out;
    }, PRODUCT_KEYWORDS)) as {
      label: string;
      provider: string;
      balance: number;
    }[];
  } catch {
    return [];
  }
  return found.map((p) => {
    const name = p.provider ? `${p.label} — ${p.provider}` : p.label;
    return {
      accountNumber: `clal:${name}`,
      label: name,
      balance: Math.round(p.balance * 100) / 100,
      currency: 'ILS',
      transactions: [],
    };
  });
}

interface MeitavRow {
  name: string;
  accountNum: string | number | null;
  balance: number | null;
}

/**
 * Reads balances from Meitav's member portal API (interactive fund — the user
 * signs in by hand first). GET /v2/api/AllAccounts/GetAllAmitAccounts returns
 * `{ t: { CustomPensionAccountMain[], CustomAccountMain[] } }`; each fund row
 * carries `AccountNumForShow` (name) and `YitrotAccountSum` (current balance).
 * The same fund recurs once per period — dedup by account number, keeping the
 * largest (latest) balance. Returns [] until the session is authenticated.
 */
async function readMeitavBalances(page: Page): Promise<NormalizedAccount[]> {
  let raw: { pension: MeitavRow[]; other: MeitavRow[] } | null = null;
  try {
    raw = (await page.evaluate(async () => {
      const res = await fetch('/v2/api/AllAccounts/GetAllAmitAccounts', {
        credentials: 'include',
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const t: any = data && data.t ? data.t : data;
      const pick = (arr: any[]): any[] =>
        (arr || []).map((p: any) => ({
          name: p.AccountNumForShow,
          accountNum: p.AccountNum,
          balance: p.YitrotAccountSum,
        }));
      return { pension: pick(t.CustomPensionAccountMain), other: pick(t.CustomAccountMain) };
    })) as { pension: MeitavRow[]; other: MeitavRow[] } | null;
  } catch {
    return [];
  }
  if (!raw) return [];
  const byAccount = new Map<string, { name: string; balance: number }>();
  for (const row of [...raw.pension, ...raw.other]) {
    const balance = Number(row.balance);
    const name = (row.name ?? '').trim();
    if (!name || !Number.isFinite(balance)) continue;
    const key = String(row.accountNum ?? name);
    const prev = byAccount.get(key);
    if (!prev || balance > prev.balance) byAccount.set(key, { name, balance });
  }
  return [...byAccount.values()].map((p) => ({
    accountNumber: `meitav:${p.name}`,
    label: p.name,
    balance: Math.round(p.balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/**
 * Reads balances from Menora Mivtachim's dashboard API (interactive fund — the
 * user signs in by hand first). POST /personal/dashboard/api/v1/customer-
 * summary/active returns `{ data: { pension[], socialBenefit[], managerFund[],
 * annuity[], … } }`; `socialBenefit` holds both gemel and study (השתלמות)
 * funds. Each savings row carries `title` (name) and `cashSurrenderValue`
 * (accrued balance). Insurance arrays and `forecastPension` (a projected
 * monthly payout, not a balance) are ignored. Returns [] until authenticated.
 */
async function readMenoraBalances(page: Page): Promise<NormalizedAccount[]> {
  let rows: { name: string; balance: number }[] | null = null;
  try {
    rows = (await page.evaluate(async () => {
      const uuid =
        Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
      const res = await fetch(
        '/personal/dashboard/api/v1/customer-summary/active?counter=1&uuid=' + uuid,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) return null;
      const body: any = await res.json();
      const d: any = body && body.data ? body.data : {};
      const pick = (arr: any[]): any[] =>
        (arr || []).map((p: any) => ({ name: p.title, balance: p.cashSurrenderValue }));
      return ([] as any[]).concat(
        pick(d.pension),
        pick(d.socialBenefit),
        pick(d.managerFund),
        pick(d.annuity),
      );
    })) as { name: string; balance: number }[] | null;
  } catch {
    return [];
  }
  if (!rows) return [];
  const out: NormalizedAccount[] = [];
  for (const row of rows) {
    const balance = Number(row.balance);
    const name = (row.name ?? '').trim();
    if (!name || !Number.isFinite(balance) || balance <= 0) continue;
    out.push({
      accountNumber: `menora:${name}`,
      label: name,
      balance: Math.round(balance * 100) / 100,
      currency: 'ILS',
      transactions: [],
    });
  }
  return out;
}

/**
 * Fallback balance reader for any portal without a precise mapping: finds page
 * blocks that name a pension product and pairs each with the largest shekel-
 * sized number inside it. A miss is expected — saveDebug keeps the page.
 */
async function readGenericBalances(page: Page): Promise<NormalizedAccount[]> {
  let found: { label: string; balance: number }[] = [];
  try {
    found = (await page.evaluate((keywords: string[]) => {
      const toAmount = (text: string): number | null => {
        const cleaned = (text || '').replace(/[^\d.,]/g, '').replace(/,/g, '');
        const value = parseFloat(cleaned);
        return Number.isFinite(value) ? value : null;
      };
      const results: { label: string; balance: number }[] = [];
      const blocks: any[] = Array.from(
        document.querySelectorAll('div, section, article, li, tr'),
      );
      for (const block of blocks) {
        const text: string = (block.innerText || '').trim();
        if (!text || text.length > 400) continue;
        const keyword = keywords.find((k) => text.includes(k));
        if (!keyword) continue;
        let largest = 0;
        for (const match of text.match(/[\d][\d.,]{3,}/g) || []) {
          const value = toAmount(match);
          if (value != null && value > largest) largest = value;
        }
        // Pension balances are at least a few thousand shekels; smaller hits
        // are fees or contribution amounts, not the accumulated balance.
        if (largest >= 1000) results.push({ label: keyword, balance: largest });
      }
      return results;
    }, PRODUCT_KEYWORDS)) as { label: string; balance: number }[];
  } catch {
    return [];
  }

  // One account per product type, keeping the largest balance seen for each.
  const byLabel = new Map<string, number>();
  for (const item of found) {
    byLabel.set(item.label, Math.max(byLabel.get(item.label) ?? 0, item.balance));
  }
  return [...byLabel].map(([label, balance]) => ({
    accountNumber: `pension:${label}`,
    label,
    balance: Math.round(balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/** Saves a screenshot, the rendered HTML and the captured JSON for diagnosis. */
async function saveDebug(
  page: Page,
  screenshotPath: string | undefined,
  htmlPath: string | undefined,
  dataPath: string | undefined,
  jsonResponses: { url: string; body: string }[],
): Promise<void> {
  try {
    if (screenshotPath) {
      const shot = await page.screenshot({ fullPage: true });
      writeFileSync(screenshotPath, shot);
    }
  } catch {
    // best-effort
  }
  try {
    if (htmlPath) writeFileSync(htmlPath, await page.content());
  } catch {
    // best-effort
  }
  try {
    if (dataPath) writeFileSync(dataPath, JSON.stringify(jsonResponses, null, 2));
  } catch {
    // best-effort
  }
}
