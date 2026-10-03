// REAL S5b+S7 pre-roll (`do`, after tf-prep.mjs): strafe to the head of the x -700 lane.
// From there W runs straight to Runner's left side: the pop-up opens at z ~ -1190 and Runner stays
// visible to the right of our avatar (a straight-on approach hides Runner behind our avatar).
import { guard, tfHoldUntil } from './lib.mjs';

export const LANE_X = -700;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  log(`A: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= LANE_X))}`);
  await sleep(1200);
};
