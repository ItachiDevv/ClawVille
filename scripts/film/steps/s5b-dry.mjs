// S5b-dry (take ~8 s, after tf-prep.mjs): walk up to Runner until the P15 pop-up shows, read it, Escape.
// NEVER click "Choose this trading style" on the film account.
import { guard, tfHoldUntil, tfPlayer, bodyText, waitFor, panelText, pressKey, clock } from './lib.mjs';

export const AGENT_X = -510; // Runner spot (-510, -1350)
export const LANE_X = -700; // the dais blocks x -538..538, z -624..444: go round it on this lane
export const LINE_Z = -1000; // 350 wu from the agents: the pop-up stays shut until the last approach
export const POPUP_RE = /Choose this trading style/i;

export default async ({ page, log, sleep, screenshotDom }) => {
  await guard(page, log);
  const at = clock();
  log(`${at()} A: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= LANE_X))}`);
  log(`${at()} W: ${JSON.stringify(await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= LINE_Z))}`);
  log(`${at()} D: ${JSON.stringify(await tfHoldUntil(page, sleep, ['d'], (p) => p.x >= AGENT_X))}`);
  log(`${at()} W down (approach)`);
  let popup = false;
  await page.keyboard.down('w');
  const ms = await waitFor(page, sleep, async () => (popup = POPUP_RE.test(await bodyText(page))), 7000);
  await page.keyboard.up('w');
  log(`${at()} W up popup=${popup} after ${ms} ms player=${JSON.stringify(await tfPlayer(page))}`);
  await sleep(1500);
  log(`${at()} popup text: ${await panelText(page, { re: 'Choose this trading style' })}`);
  await screenshotDom('reh-s5b-popup');
  await pressKey(page, sleep, 'Escape');
  await sleep(800);
  log(`${at()} after Escape popup=${POPUP_RE.test(await bodyText(page))}`);
};
