// S3 close pre-roll (`do`, after tf-prep.mjs): stand in the lane LEFT of the dais (the dais blocks x -538..538,
// z -624..444), closer to the board than s3-setup, and turn the camera right toward the board centre.
// The chase camera keeps ~520 wu behind the avatar and a fixed look height, so a closer stand cuts the board top.
import { guard, hold, tfHoldUntil, tfPlayer } from './lib.mjs';

export const LANE_X = Number(process.env.S3C_X || -700);
export const STAND_Z = Number(process.env.S3C_Z || -260);
export const YAW_KEY = process.env.S3C_YAW_KEY || 'ArrowRight';
export const YAW_MS = Number(process.env.S3C_YAW_MS || 250);   // room yaw 1.25 rad/s: 250 ms ~ 18 deg
export const TILT_KEY = process.env.S3C_TILT_KEY || '';
export const TILT_MS = Number(process.env.S3C_TILT_MS || 0);

export default async ({ page, log, sleep, screenshotDom }) => {
  await guard(page, log);
  log(`A: ${JSON.stringify(await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= LANE_X))}`);
  log(`W: ${JSON.stringify(await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= STAND_Z))}`);
  if (YAW_MS) await hold(page, [YAW_KEY], YAW_MS, log, sleep);
  if (TILT_KEY && TILT_MS) await hold(page, [TILT_KEY], TILT_MS, log, sleep);
  await sleep(1200);
  log(`stand ${JSON.stringify(await tfPlayer(page))}`);
  if (process.env.SHOT) await screenshotDom(process.env.SHOT);
};
