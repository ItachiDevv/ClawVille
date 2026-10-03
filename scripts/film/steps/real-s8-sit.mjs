// REAL S8 (take ~14 s, after tf-prep.mjs, AFTER the real launch): walk to free seat 2 (UI desk 3),
// E to sit, "My trader" opens. The panel stays open for S9 (no Escape).
// The seat write (POST /me/seat) must go through for the agent to trade: the guard is off only with FILM_LAUNCH=GO.
import { guard, tfHoldUntil, bodyText, waitFor, pressE, clock } from './lib.mjs';

export const GO = process.env.FILM_LAUNCH === 'GO';
export const PRE_ROLL_MS = 1500;
export const POST_ROLL_MS = 1500;
export const SEAT = { index: 2, x: -1565, z: 500 }; // free seats: 0, 2, 4, 6, 8
export const PANEL_HOLD_MS = 3000;

export default async ({ page, log, sleep }) => {
  await guard(page, log, { allow: GO });
  const at = clock();
  await sleep(PRE_ROLL_MS);
  log(`${at()} A: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= SEAT.x + 5))}`);
  log(`${at()} W: ${JSON.stringify(await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= SEAT.z + 40))}`);
  log(`${at()} capsule after ${await waitFor(page, sleep, async () => /press E to sit/i.test(await bodyText(page)), 2000)} ms`);
  await pressE(page, sleep);
  log(`${at()} E (sit)`);
  const ms = await waitFor(page, sleep, () => page.evaluate(() => !!document.querySelector("[data-testid='arena-my-trader'],[data-testid='arena-launch']")), 6000);
  const which = await page.evaluate(() => (document.querySelector("[data-testid='arena-my-trader']") ? 'arena-my-trader' : document.querySelector("[data-testid='arena-launch']") ? 'arena-launch (NO AGENT?)' : 'none'));
  log(`${at()} panel ${which} after ${ms} ms`);
  await sleep(PANEL_HOLD_MS);
  log(`${at()} panel text: ${(await page.evaluate(() => document.querySelector("[data-testid='arena-my-trader']")?.innerText.replace(/\s+/g, ' ') || '')).slice(0, 900)}`);
  await sleep(POST_ROLL_MS);
};
