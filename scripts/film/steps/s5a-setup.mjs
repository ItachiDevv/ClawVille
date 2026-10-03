// S5a pre-roll (`do`, after tf-prep.mjs): go to the west end of the line in front of the five agents.
import { guard, tfHoldUntil } from './lib.mjs';

export const LINE_Z = -1000; // agents at z -1350; the walk-up opens at 250 wu, so 350 wu keeps it shut
export const START_X = -1250; // the chairs of desks 6 and 8 end at |x| 1381

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  log(`A: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= START_X))}`);
  log(`W: ${JSON.stringify(await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= LINE_Z))}`);
  await sleep(1200);
};
