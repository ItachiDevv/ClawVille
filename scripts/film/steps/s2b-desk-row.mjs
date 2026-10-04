// S2b (take ~8 s, after s2b-setup.mjs): walk the left desk row toward the board.
// The room camera keeps its yaw (no auto-follow), so the desks run along the left of frame.
import { guard, tfHoldUntil, tfPlayer, clock } from './lib.mjs';

export const LEAD_IN_MS = 1000;
export const END_Z = -1100; // stays 414 wu from the Genesis spot: no P15 pop-up
export const TAIL_MS = 1500;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  log(`${at()} start ${JSON.stringify(await tfPlayer(page))}`);
  await sleep(LEAD_IN_MS);
  log(`${at()} W down`);
  const r = await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= END_Z, { timeoutMs: 7000 });
  log(`${at()} W up ${JSON.stringify(r)}`);
  await sleep(TAIL_MS);
};
