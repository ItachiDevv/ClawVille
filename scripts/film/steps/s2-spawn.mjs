// S2 (take ~8 s, after tf-prep.mjs): hold the spawn view. Five house agents stand under the board (P15).
import { guard, tfPlayer } from './lib.mjs';

export const HOLD_MS = Number(process.env.HOLD_MS || 7500); // S3 uses HOLD_MS=12000

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  log(`player ${JSON.stringify(await tfPlayer(page))}`);
  await sleep(HOLD_MS);
};
