// S6 (take ~24 s, after tf-prep.mjs): walk up to a house agent, "Watch its trades", the profile opens,
// scroll to "Latest 30-minute report" (hold), then to "Rule changes" (hold). Read-only.
import { guard, tfHoldUntil, bodyText, waitFor, clock } from './lib.mjs';

export const AGENT = { name: 'Runner', x: -510 }; // best report on 2026-10-02 02:15Z (see SHOOT.md)
export const LANE_X = -700;
export const LINE_Z = -1000;
export const PROFILE_HOLD_MS = 2500;
export const REPORT_HOLD_MS = 6000;
export const RULES_HOLD_MS = 4000;
const PROFILE = "[data-testid='arena-agent-profile']";

async function scrollToText(page, re) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const el = [...document.querySelectorAll('h1,h2,h3,h4,h5,p,div,span')]
      .filter((e) => re.test(e.textContent || '') && e.children.length === 0)[0];
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }, re.source);
}

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= LANE_X);
  await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= LINE_Z);
  await tfHoldUntil(page, sleep, ['d'], (p) => (AGENT.x < LANE_X ? p.x <= AGENT.x : p.x >= AGENT.x));
  await page.keyboard.down('w');
  await waitFor(page, sleep, async () => /Watch its trades/i.test(await bodyText(page)), 6000);
  await page.keyboard.up('w');
  log(`${at()} pop-up up`);
  await sleep(1200);
  await page.getByRole('button', { name: 'Watch its trades', exact: true }).first().click();
  log(`${at()} click "Watch its trades"; profile after ${await waitFor(page, sleep, () => page.evaluate((s) => !!document.querySelector(s), PROFILE), 8000)} ms`);
  await sleep(PROFILE_HOLD_MS);
  log(`${at()} scroll to report: ${await scrollToText(page, /^Latest 30-minute report$/)}`);
  await sleep(REPORT_HOLD_MS);
  log(`${at()} scroll to rule changes: ${await scrollToText(page, /^Rule changes$/)}`);
  await sleep(RULES_HOLD_MS);
  log(`${at()} done`);
};
