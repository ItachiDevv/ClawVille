// S3 pre-roll (`do`, after tf-prep.mjs): walk to the front of the dais at x 0 and lower the camera a little.
import { guard, hold, tfHoldUntil } from './lib.mjs';
export const STAND_Z = Number(process.env.S3_Z || 520); // the dais blocks the body at z <= 490 on x 0
export const TILT_KEY = 'ArrowDown'; // camera height -54 wu (180 wu/s): whole board + header + footer clear the avatar
export const TILT_MS = Number(process.env.S3_TILT_MS || 300);
export default async ({ page, log, sleep }) => {
  await guard(page, log);
  log(`W: ${JSON.stringify(await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= STAND_Z, { timeoutMs: 4000 }))}`);
  await hold(page, [TILT_KEY], TILT_MS, log, sleep);
  await sleep(1200);
};
