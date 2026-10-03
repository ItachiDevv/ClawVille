// S2 v2 pre-roll (`do`, after tf-prep.mjs): raise the room camera so the five standing house agents,
// their name capsules and the board columns clear our avatar's head. ArrowUp raises the camera HEIGHT
// at 180 wu/s (clamp +150). 450 ms cuts only the board's header line; 900 ms cuts the board top.
import { hold } from './lib.mjs';

export const RAISE_MS = 380;
export const SETTLE_MS = 1200;

export default async ({ page, log, sleep }) => {
  await hold(page, ['ArrowUp'], RAISE_MS, log, sleep);
  await sleep(SETTLE_MS);
};
