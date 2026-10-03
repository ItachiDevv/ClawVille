// Inside pre-roll (`do`, not recorded): go to /trading-floor, install the scene hook (reload), check the room build.
import { waitReady, tfPlayer } from './lib.mjs';
const HOOK = `(() => { if (window.__THREE_DEVTOOLS__) return; window.__cvScenes = []; const t = new EventTarget();
  t.addEventListener('observe', (e) => { const o = e.detail; if (o && o.isScene) window.__cvScenes.push(o); });
  window.__THREE_DEVTOOLS__ = t; })();`;
export default async ({ page, goto, log, sleep }) => {
  await page.addInitScript(HOOK);
  if (page.url().includes('/trading-floor')) await page.reload({ waitUntil: 'domcontentloaded' });
  else await goto('https://staging.clawville.world/trading-floor');
  log(`ready in ${await waitReady(page, sleep, { hud: /WASD to walk/ })} ms`);
  await sleep(2500);
  const room = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/_next\/static\/chunks\/.*\.js/.test(u));
    for (const u of urls) { const t = await (await fetch(u)).text().catch(() => ''); const m = t.match(/halfX:(1950|1300),halfZ:(1650|1100)/); if (m) return m[0]; }
    return 'not found';
  });
  log(`room=${room} player=${JSON.stringify(await tfPlayer(page))} scenes=${await page.evaluate(() => (window.__cvScenes || []).length)}`);
};
