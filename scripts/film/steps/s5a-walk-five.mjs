// S5a (take ~8 s, after s5a-setup.mjs): truck right along z -1000, past Genesis .. Late Bloomer.
import { guard, tfHoldUntil, tfPlayer, bodyText, clock } from './lib.mjs';

export const LEAD_IN_MS = 800;
export const END_X = 1250;
export const TAIL_MS = 1000;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  log(`${at()} start ${JSON.stringify(await tfPlayer(page))}`);
  await sleep(LEAD_IN_MS);
  log(`${at()} D down`);
  const r = await tfHoldUntil(page, sleep, ['d'], (p) => p.x >= END_X, { timeoutMs: 7000 });
  log(`${at()} D up ${JSON.stringify(r)}`);
  await sleep(TAIL_MS);
  log(`${at()} popup=${/Choose this trading style/i.test(await bodyText(page))}`);
};
