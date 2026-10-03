// REAL S9 (take ~125 s, right after real-s8-sit.mjs, seated with "My trader" open): scroll to the
// decision stream and hold. Logs the stream at the start and the end so rig.log maps events to footage.
import { guard, clock } from './lib.mjs';

export const PRE_ROLL_MS = 1500;
export const POST_ROLL_MS = 1500;
export const HOLD_MS = Number(process.env.S9_HOLD_MS || 120000);
export const SNAPSHOT_EVERY_MS = 15000;

export default async ({ page, log, sleep }) => {
  await guard(page, log, { allow: process.env.FILM_LAUNCH === 'GO' });
  const at = clock();
  await sleep(PRE_ROLL_MS);
  // my-trader.tsx: <ArenaBlock title="Decision stream" testId="arena-desk-stream"> inside [data-testid='arena-my-trader'].
  const found = await page.evaluate(() => {
    if (!document.querySelector("[data-testid='arena-my-trader']")) return 'no my-trader panel';
    const block = document.querySelector("[data-testid='arena-desk-stream']");
    if (!block) return 'no arena-desk-stream block';
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return 'ok';
  });
  log(`${at()} scroll to "Decision stream": ${found}`);
  const snap = () => page.evaluate(() => (document.querySelector("[data-testid='arena-desk-stream']")?.innerText || 'none').replace(/\s+/g, ' ').slice(0, 700));
  const t0 = Date.now();
  while (Date.now() - t0 < HOLD_MS) {
    log(`${at()} stream: ${await snap()}`);
    await sleep(Math.min(SNAPSHOT_EVERY_MS, HOLD_MS - (Date.now() - t0)));
  }
  await sleep(POST_ROLL_MS);
};
