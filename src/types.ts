// Public types the library exposes. Mirrors the shape of israeli-bank-scrapers
// where it overlaps, so a consumer that already speaks that vocabulary can
// drop a pension fund in alongside a bank with no extra mapping.

/** Catalog entry shown in an "add a pension connection" picker. */
export interface PensionCompanyInfo {
  /** Stable id used as the catalog key (`migdal`, `harel`, …). */
  id: string;
  /** Display name with the Hebrew form in brackets. */
  name: string;
  /** Inputs the user fills in to authenticate (`id`, sometimes `phone`). */
  loginFields: string[];
  /** Always `"pension"`, kept for symmetry with bank catalogs. */
  type: 'pension';
  /** Provider website host, handy for favicon lookups. */
  domain: string;
  /**
   * True when the fund opens a visible Chromium window for the user to sign
   * in by hand — used for providers that wall their login with CAPTCHA
   * (Meitav / Menora today).
   */
  interactive: boolean;
}

/** A single product (pension, gemel, study fund) the member holds. */
export interface PensionAccount {
  /** Stable per-product reference the provider gives — used as the dedup key
   *  on rescrape. Falls back to the product name when no id is on offer. */
  accountNumber: string;
  /** Human-readable product name as the portal shows it. */
  label?: string;
  /** Current accumulated balance, in `currency`. */
  balance?: number;
  /** ISO-4217 code — `ILS` in practice for every Israeli provider. */
  currency: string;
  /**
   * Empty for pension providers (there are no individual transactions to
   * scrape), kept so consumers can treat a PensionAccount the same way they
   * treat an israeli-bank-scrapers Account.
   */
  transactions: never[];
}

/** What a scrape returns — either a list of accounts or a typed failure. */
export interface PensionScrapeOutcome {
  success: boolean;
  accounts: PensionAccount[];
  errorType?: string;
  errorMessage?: string;
}

/** Resolves with the user-supplied SMS / one-time-password code. */
export type OtpCallback = () => Promise<string>;

/**
 * Pluggable session storage. The default implementation in `./session.ts`
 * writes JSON files to the OS-appropriate data dir, but a consumer can
 * supply their own (encrypted vault, database row, in-memory map, …).
 *
 * `cookies` is a Puppeteer cookie list — the same shape `page.cookies()`
 * returns. The library treats them as opaque on save/load.
 */
export interface SessionStore {
  /** Returns the saved cookies for a connection, or `null` if none / expired. */
  load(connectionId: string): Promise<unknown[] | null>;
  /** Persists the current browser cookies under the connection id. */
  save(connectionId: string, cookies: unknown[]): Promise<void>;
}

/** Arguments for {@link scrapePension}. */
export interface ScrapePensionArgs {
  /** One of {@link FUND_IDS}. */
  fundId: string;
  /** ID number (תעודת זהות) and, for some funds, the phone number. */
  credentials: { id?: string; phone?: string };
  /** Streaming progress updates ("Logging in…", "Reading balances…"). */
  onProgress?: (message: string) => void;
  /** Called when the OTP code is needed — your UI prompts the user. */
  onOtpNeeded?: OtpCallback;
  /** Optional connection id used as the session-store key (e.g. `migdal-1`). */
  connectionId?: string;
  /** Optional session store; defaults to the JSON-file store. */
  session?: SessionStore;
  /** Where to write a failure screenshot, if a sync fails. */
  screenshotPath?: string;
  /**
   * Defaults to `true`. Set `false` to launch a visible browser even for the
   * headless-friendly funds — useful when a provider's WAF rejects you and
   * you want to watch the page.
   */
  headless?: boolean;
}
