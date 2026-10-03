// S2b pre-roll (`do`, after tf-prep.mjs): strafe from spawn (0,1170) to the head of the left desk row.
import { guard, tfHoldUntil } from './lib.mjs';

export const ROW_X = -1350;

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  log(`A -> x<=${ROW_X}: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= ROW_X))}`);
  await sleep(1200);
};
