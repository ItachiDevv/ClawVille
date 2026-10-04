// Clears first-time overlays for the film account. Re-run before every take (`do`, not recorded).
// Works on /game and /trading-floor. Sets localStorage keys, reloads once if a key changed,
// then closes any modal that still shows. It NEVER screenshots: the first-time backup modal shows secret keys.
import { waitReady } from './lib.mjs';

export const COLLAPSE_SIDEBAR = true; // right sidebar -> thin "MENU" tab (also hides its LIVE FLOOR panel)
export const KEYS = {
  'clawville-tutorial-seen': 'true',               // Field Manual "Welcome to ClawVille!" (tutorial-overlay.tsx:13)
  'clawville-quest-intro-seen': 'true',            // quest tracker auto-expand + toast (quest-tracker.tsx:22)
  'clawville-activity-tutorial-skip-all': 'true',  // activity tutorial cards (ActivityTutorialCard.tsx:44)
  ...(COLLAPSE_SIDEBAR ? { 'clawville-sidebar-collapsed': 'true' } : {}), // sidebar-menu.tsx:1125
};
export const VERIFY_RE = /verify your email|verify email|check your inbox/i;
export const BACKUP_RE = /I['’]ve saved these keys|secret key/i;

export default async ({ page, log, sleep }) => {
  const changed = await page.evaluate((keys) => {
    const out = [];
    for (const [k, v] of Object.entries(keys)) if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); out.push(k); }
    return out;
  }, KEYS);
  log(`keys set: ${changed.length ? changed.join(', ') : 'none changed'}`);
  if (changed.length) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    log(`reloaded, ready in ${await waitReady(page, sleep)} ms`);
    await sleep(2000);
  }
  const text = () => page.evaluate(() => document.body.innerText).catch(() => '');
  let t = await text();
  if (BACKUP_RE.test(t)) { log('STOP: first-time backup modal (secret keys) is open; finish it by hand, never record it'); return; }
  if (/FIELD MANUAL/i.test(t)) { await page.keyboard.press('Escape'); await sleep(400); log('Field Manual: Escape'); }
  const daily = page.getByRole('button', { name: /collect & continue/i });
  if (await daily.count()) { await daily.first().click(); await sleep(500); log('daily login modal: Collect & Continue'); }
  const verifyBtn = page.getByRole('button', { name: /dismiss email verification banner/i });
  if (await verifyBtn.count()) { await verifyBtn.first().click(); log('email verify banner: dismissed'); }
  t = await text();
  log(`check: fieldManual=${/FIELD MANUAL/i.test(t)} verifyBanner=${VERIFY_RE.test(t)} dailyModal=${/collect & continue/i.test(t)} url=${page.url()}`);
};
