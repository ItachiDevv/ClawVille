// S1 v2 pre-roll (`do`, NOT recorded): reload /game (camera faces NORTH), walk S to START_Z on the road,
// turn the camera to face SOUTH (the Trading Floor door is at (0, 3360), the building centre at (0, 4160)),
// then apply the framing (zoom out + tilt). Nori and the town-centre NPCs stay behind at the spawn.
import { hold, holdUntil, sonar, waitReady } from './lib.mjs';

export const START_Z = Number(process.env.S1_START_Z || 2300);
export const TURN_180_MS = 2094; // world orbit 1.5 rad/s
export const WHEEL_OUT = Number(process.env.S1_WHEEL || 0); // mouse wheel dy (> 0 = zoom out)
export const TILT_KEY = process.env.S1_TILT_KEY || '';      // 'ArrowUp' or 'ArrowDown'
export const TILT_MS = Number(process.env.S1_TILT_MS || 0);
export const SETTLE_MS = 2500;

export default async ({ page, goto, log, sleep, screenshotDom }) => {
  if (!page.url().includes('/game')) await goto('https://staging.clawville.world/game');
  else await page.reload({ waitUntil: 'domcontentloaded' });
  log(`ready in ${await waitReady(page, sleep, { hud: /SONAR/ })} ms`);
  await sleep(2000);
  const from = await sonar(page);
  const key = from.z < START_Z ? 's' : 'w';
  const r = await holdUntil(page, sleep, [key], (s) => (key === 's' ? s.z >= START_Z : s.z <= START_Z), { timeoutMs: 15000 });
  log(`walk ${key} to z=${START_Z} -> ${JSON.stringify(r)}`);
  await sleep(400);
  await hold(page, ['ArrowLeft'], TURN_180_MS, log, sleep);
  if (WHEEL_OUT) { await page.mouse.move(960, 600); await page.mouse.wheel(0, WHEEL_OUT); log(`wheel ${WHEEL_OUT}`); }
  if (TILT_KEY && TILT_MS) await hold(page, [TILT_KEY], TILT_MS, log, sleep);
  await sleep(SETTLE_MS);
  log(`start mark ${JSON.stringify(await sonar(page))}`);
  await screenshotDom(process.env.SHOT || 's1v2-start');
};
