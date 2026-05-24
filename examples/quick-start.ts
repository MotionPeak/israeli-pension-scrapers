// Quick-start: scrape your Migdal pension/קרן השתלמות/קופת גמל balances.
//
//   PENSION_ID=123456789 npx tsx examples/quick-start.ts migdal
//   PENSION_ID=123456789 PENSION_PHONE=0501234567 npx tsx examples/quick-start.ts harel
//   npx tsx examples/quick-start.ts meitav     # visible window, sign in by hand
//
// The first sync of a CAPTCHA-walled fund (meitav / menora) opens a real
// Chrome window. You clear the security check and enter the SMS code yourself.
// Subsequent syncs reuse the saved cookies and run without prompting until
// the session expires (~ a few days).

import { createInterface } from 'node:readline';
import { scrapePension, FUND_IDS } from '../src/index.js';

const fundId = process.argv[2];
if (!fundId || !FUND_IDS.includes(fundId as (typeof FUND_IDS)[number])) {
  console.error(`Usage: tsx examples/quick-start.ts <${FUND_IDS.join('|')}>`);
  console.error('Set PENSION_ID and (for Harel/Clal/Meitav/Menora) PENSION_PHONE.');
  process.exit(1);
}

const credentials = {
  id: process.env.PENSION_ID ?? '',
  phone: process.env.PENSION_PHONE ?? '',
};

// Reads the SMS code from stdin when the portal asks for one.
function askOtp(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter the SMS code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const result = await scrapePension({
  fundId,
  credentials,
  connectionId: `cli-${fundId}`,
  onProgress: (msg) => console.log(`[${fundId}] ${msg}`),
  onOtpNeeded: askOtp,
});

if (!result.success) {
  console.error(`Scrape failed: ${result.errorType} — ${result.errorMessage}`);
  process.exit(2);
}

console.log(`\nFound ${result.accounts.length} product(s):`);
for (const account of result.accounts) {
  const balance = account.balance != null
    ? `${account.balance.toLocaleString('he-IL')} ${account.currency}`
    : '—';
  console.log(`  • ${account.label ?? account.accountNumber}: ${balance}`);
}
