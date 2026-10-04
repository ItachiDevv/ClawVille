// S11 (take ~10 s, after tf-prep.mjs + `do arena-open.mjs`): the contest banner, then "Contest rules".
import { guard, clock } from './lib.mjs';

export const BANNER_HOLD_MS = 3500;
export const RULES_HOLD_MS = 4500;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  await page.evaluate(() => document.querySelector("[data-testid='arena-contest-banner']")?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  log(`${at()} banner: ${await page.evaluate(() => document.querySelector("[data-testid='arena-contest-banner']")?.innerText.replace(/\s+/g, ' ').slice(0, 600) || 'none')}`);
  await sleep(BANNER_HOLD_MS);
  const rules = page.locator('summary, button', { hasText: /^Contest rules$/ }).first();
  // "Contest rules" opens its own view ([data-testid='arena-contest-rules']) with "Back to the arena".
  if (await rules.count()) { await rules.click(); log(`${at()} click "Contest rules"`); }
  else log(`${at()} "Contest rules" button not found`);
  await sleep(600);
  log(`${at()} rules: ${await page.evaluate(() => document.querySelector("[data-testid='arena-contest-rules']")?.innerText.replace(/\s+/g, ' ').slice(0, 1600) || 'none')}`);
  await sleep(RULES_HOLD_MS);
};
