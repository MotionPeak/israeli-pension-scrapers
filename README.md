# israeli-pension-scrapers

Scrape Israeli **pension funds (קרנות פנסיה)**, **study funds (קרן השתלמות)** and **provident funds (קופות גמל)** balances from the major providers. The sibling of [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) for the long-term savings side of an Israeli household balance sheet.

| Provider | Hebrew | How it signs in |
|---|---|---|
| **Migdal** | מגדל | Headless · automated OTP |
| **Harel** | הראל | Headless · automated OTP |
| **Clal** | כלל | Headless · automated OTP |
| **Meitav** | מיטב | Visible Chromium window · you sign in once, cookies persist |
| **Menora Mivtachim** | מנורה מבטחים | Visible Chromium window · you sign in once, cookies persist |

Works on **macOS**, **Linux** and **Windows**. Saved sessions live under the OS-conventional per-user data directory so the next sync just resumes.

---

## Install

```sh
npm install israeli-pension-scrapers
```

Puppeteer downloads its own Chromium on `npm install`. The **interactive** funds (Meitav, Menora) prefer the **real Google Chrome** installed on the system because its reCAPTCHA reputation carries across runs — install [Google Chrome](https://www.google.com/chrome/) if you plan to use those.

## Quick start

```ts
import { scrapePension } from 'israeli-pension-scrapers';

const result = await scrapePension({
  fundId: 'migdal',
  credentials: { id: '123456789' },          // ID number (תעודת זהות)
  connectionId: 'my-migdal-account',         // any string — used to key the saved session
  onProgress: (msg) => console.log(msg),
  onOtpNeeded: async () => prompt('SMS code') ?? '',
});

if (!result.success) {
  console.error(result.errorType, result.errorMessage);
  process.exit(1);
}

for (const account of result.accounts) {
  console.log(account.label, account.balance, account.currency);
}
```

There's a runnable version in [`examples/quick-start.ts`](./examples/quick-start.ts):

```sh
PENSION_ID=123456789 npx tsx examples/quick-start.ts migdal
PENSION_ID=123456789 PENSION_PHONE=0501234567 npx tsx examples/quick-start.ts harel
npx tsx examples/quick-start.ts meitav     # opens a visible window
```

## How it works

Pension providers each run their own member portal, with no shared scraping library. This package drives each one in a Puppeteer browser (with `puppeteer-extra-plugin-stealth` to mask the most obvious automation tells) and reads the accumulated balance of every product the member holds.

Two sign-in modes:

### 1. Headless OTP login — Migdal, Harel, Clal

The portal is passwordless: enter your ID (and phone, where required), the portal sends an SMS, you relay the code through `onOtpNeeded`. Runs entirely headless.

```ts
await scrapePension({
  fundId: 'harel',
  credentials: { id: '123456789', phone: '0501234567' },
  connectionId: 'harel-1',
  onOtpNeeded: askUserForSmsCode,
});
```

### 2. Visible-window sign-in — Meitav, Menora

These two wall their login with **reCAPTCHA Enterprise / Radware / hCaptcha** that resists automation. The library opens a real Chromium window, pre-fills your ID/phone, and waits up to **5 minutes** for you to clear the security check and submit the SMS code yourself. Once you do, the saved session cookies (encrypted by your `SessionStore`) make every subsequent sync resume without any browser window at all — until the session expires (a few days, set by the provider).

```ts
await scrapePension({
  fundId: 'meitav',
  credentials: { id: '123456789', phone: '0501234567' },
  connectionId: 'meitav-1',
  // No onOtpNeeded — you enter the code in the browser window yourself.
});
```

## Cross-platform data directory

The default {@link SessionStore} writes one JSON file per `connectionId` under:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/israeli-pension-scrapers/` |
| Windows | `%APPDATA%\israeli-pension-scrapers\` |
| Linux | `$XDG_DATA_HOME/israeli-pension-scrapers/` (falls back to `~/.local/share/…`) |

The persistent Chrome profile used by Meitav/Menora lives under `browser-profiles/<fundId>/` in the same directory.

You can override the path:

```ts
import { scrapePension, createFileSessionStore } from 'israeli-pension-scrapers';

const session = createFileSessionStore({ baseDir: '/var/lib/myapp/pension-sessions' });
await scrapePension({ fundId: 'migdal', credentials: { id }, session, /* … */ });
```

Or supply your own store backed by a vault, database, or anything else:

```ts
import type { SessionStore } from 'israeli-pension-scrapers';

const session: SessionStore = {
  async load(connectionId) { return await myVault.get(connectionId); },
  async save(connectionId, cookies) { await myVault.put(connectionId, cookies); },
};
```

## API

### `scrapePension(args)`

```ts
interface ScrapePensionArgs {
  fundId: 'migdal' | 'harel' | 'clal' | 'meitav' | 'menora';
  credentials: { id?: string; phone?: string };
  onProgress?: (message: string) => void;
  onOtpNeeded?: () => Promise<string>;       // Required for the headless funds
  connectionId?: string;                     // Session-store key; defaults to `${fundId}-default`
  session?: SessionStore;                    // Defaults to file-based store
  screenshotPath?: string;                   // Where to dump a failure screenshot
  headless?: boolean;                        // Override the headless default
}

interface PensionScrapeOutcome {
  success: boolean;
  accounts: PensionAccount[];
  errorType?: string;                        // 'CONFIG' | 'LOGIN_FAILED' | 'INTERACTIVE_TIMEOUT' | …
  errorMessage?: string;
}

interface PensionAccount {
  accountNumber: string;                     // Stable per-product id
  label?: string;                            // Product name as the portal shows it
  balance?: number;                          // Accumulated balance
  currency: string;                          // ILS in practice
  transactions: never[];                     // For shape-compat with bank scrapers
}
```

### `PENSION_COMPANIES`

A ready-made catalog you can drop into an "Add connection" picker:

```ts
import { PENSION_COMPANIES } from 'israeli-pension-scrapers';
// → [{ id: 'migdal', name: 'Migdal (מגדל)', loginFields: ['id'],
//      type: 'pension', domain: 'migdal.co.il', interactive: false }, …]
```

### `FUND_IDS`

Every fund id the library knows, in catalog order. Use it to validate user input.

### `createFileSessionStore(opts?)` / `defaultDataDir(appName?)`

Helpers for the default file-based session store. See the source of [`src/session.ts`](./src/session.ts) for options.

## Environment variables

| Variable | What it does |
|---|---|
| `PENSION_SCRAPERS_HEADFUL=1` | Launch every fund in a visible browser, including the headless ones (useful for debugging WAF / bot-detection rejections). |
| `PENSION_SCRAPERS_NO_SANDBOX=1` | Drop Chromium's sandbox flag. Set this in Docker images where Chromium runs as root with no user namespace. |

## Error handling

On any failure `result.success === false` and `errorType` is one of:

| `errorType` | Meaning |
|---|---|
| `CONFIG` | Missing or bad input (unknown `fundId`, no ID number, missing `onOtpNeeded` for a headless fund). |
| `LOGIN_FAILED` | The portal rejected the credentials or the code, or the form layout shifted enough that the library couldn't find it. A debug HTML page is written next to `screenshotPath` if provided. |
| `INTERACTIVE_TIMEOUT` | The user did not complete the visible-window sign-in within the 5-minute window. |
| `NEEDS_SELECTORS` | Signed in successfully, but couldn't pin down the balances — the portal layout has likely changed and the reader needs updating. The rendered DOM is dumped to `*-pension.html` next to your screenshot path. |
| `EXCEPTION` | An unexpected error escaped — `errorMessage` carries the underlying message. |

## Why this exists

Israel's pension/gemel/study-fund ecosystem is fragmented across half a dozen large providers, each with a distinct portal, each lacking an open API. Membership data is therefore scattered across as many member portals as you have products — a real friction point for anyone trying to see their long-term savings the way [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers) lets you see your bank and card balances. This library closes the gap.

## Contributing

Pull requests welcome, especially:
- **New providers** — Phoenix (הפניקס), Altshuler-Shaham (אלטשולר שחם), Psagot (פסגות), Yelin Lapidot (ילין לפידות), …
- **Selector updates** when a portal redesigns
- **Test fixtures** captured from a real sync (`*-pension.html` + `*-pension.json` next to a failure screenshot are a great starting point)

## License

MIT — see [LICENSE](./LICENSE).
