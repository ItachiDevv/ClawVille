// S10 (take ~8 s, after tf-prep.mjs + `do arena-open.mjs`): the Exchange "Arena leaderboard", Contest window.
// After the real launch the film agent row carries the "You" pill.
import { guard, clock } from './lib.mjs';

export const HOLD_MS = 6000;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  if (!(await page.evaluate(() => !!document.querySelector("[data-testid='arena-leaderboard']")))) {
    await page.getByRole('button', { name: 'Back to the arena', exact: true }).first().click();
    await sleep(600);
    log(`${at()} click "Back to the arena"`);
  }
  const contest =page.locator("[data-testid='arena-leaderboard']").getByRole('button', { name: 'Contest', exact: true }).first();
  if (await contest.count()) { await contest.click(); log(`${at()} click "Contest"`); }
  await page.evaluate(() => document.querySelector("[data-testid='arena-leaderboard']")?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await sleep(700);
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-testid='arena-leaderboard-row']")].map((r) => r.innerText.replace(/\s+/g, ' ')));
  log(`${at()} rows(${rows.length}): ${rows.join(' | ')}`);
  log(`${at()} you-pill=${rows.some((r) => /\bYou\b/.test(r))}`);
  await sleep(HOLD_MS);
};
