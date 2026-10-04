// Generic probe: ACT="key:ArrowUp:400,wheel:600,sleep:500,shot:name,pos" runs the actions in order.
//   key:<Key>:<ms>       hold a key            keys:<K1+K2>:<ms>  hold several keys
//   wheel:<dy>           mouse wheel at screen centre (dy > 0 zooms out on OrbitControls)
//   drag:<dx>:<dy>:<ms>  left-drag from screen centre over ms
//   sleep:<ms>  shot:<name>  pos (log SONAR / room position)
import { sonar, tfPlayer } from './lib.mjs';

export default async ({ page, log, sleep, screenshotDom }) => {
  for (const a of (process.env.ACT || '').split(',').filter(Boolean)) {
    const [op, x, y, z] = a.split(':');
    if (op === 'key') { await page.keyboard.down(x); await sleep(+y); await page.keyboard.up(x); }
    else if (op === 'keys') { const ks = x.split('+'); for (const k of ks) await page.keyboard.down(k); await sleep(+y); for (const k of ks.reverse()) await page.keyboard.up(k); }
    else if (op === 'wheel') { await page.mouse.move(960, 600); await page.mouse.wheel(0, +x); }
    else if (op === 'drag') {
      await page.mouse.move(960, 600); await page.mouse.down();
      const n = 20; for (let i = 1; i <= n; i++) { await page.mouse.move(960 + (+x * i) / n, 600 + (+y * i) / n); await sleep(+z / n); }
      await page.mouse.up();
    }
    else if (op === 'sleep') await sleep(+x);
    else if (op === 'shot') await screenshotDom(x);
    else if (op === 'pos') log(`pos sonar=${JSON.stringify(await sonar(page))} room=${JSON.stringify(await tfPlayer(page).catch(() => null))}`);
    log(`act ${a}`);
  }
};
