// S1 v2 recorded beat (run with `take`): the avatar walks south down the road to the Trading Floor door,
// E starts the automatic walk-in, the stage curtain crosses to /trading-floor, the room appears.
// Needs s1v2-setup.mjs first (start mark + camera facing south).
export const ESTABLISH_MS = 4000;          // S1 v2: 4 s establishing hold on the building (framing from s1v2-setup)
export const WALK_TIMEOUT_MS = 9000;       // W held until the door prompt shows
export const PROMPT_RE = /Press E\s*·?\s*Trading Floor|Trading Floor[\s\S]{0,40}Press E/i;
export const ROOM_HUD_RE = /WASD to walk/i;
export const E_HOLD_MS = 150;            // a sub-frame press('e') is missed by the per-frame input edge (2026-10-02)

export default async ({ page, log, sleep }) => {
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(2);
  await sleep(ESTABLISH_MS);
  await page.keyboard.down('w');
  log(`t+${at()} W down`);
  let prompt = false;
  while (Date.now() - t0 < ESTABLISH_MS + WALK_TIMEOUT_MS) {
    const t = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (PROMPT_RE.test(t)) { prompt = true; break; }
    await sleep(100);
  }
  await page.keyboard.up('w');
  log(`t+${at()} W up, door prompt=${prompt}`);
  await page.keyboard.down('e');
  await sleep(E_HOLD_MS);
  await page.keyboard.up('e');
  log(`t+${at()} E pressed (walk-in)`);
  let routed = false, room = false;
  while (Date.now() - t0 < 24000) {
    if (!routed && page.url().includes('/trading-floor')) { routed = true; log(`t+${at()} url -> /trading-floor`); }
    const t = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (routed && ROOM_HUD_RE.test(t) && !/riding the current|dropping in/i.test(t)) { room = true; log(`t+${at()} room HUD visible`); break; }
    await sleep(100);
  }
  if (!room) log(`t+${at()} WARN room HUD not seen; url=${page.url()}`);
};
