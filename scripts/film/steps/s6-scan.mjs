// S6 scan (`do`, not recorded, after tf-prep.mjs): walk up to Runner, "Watch its trades", then read every
// house agent profile (report + rule changes) through "Back to the arena" -> each template card's "Watch".
// Read-only: clicks only "Watch its trades", "Watch" and "Back to the arena".
import { guard, tfHoldUntil, bodyText, waitFor, clock } from './lib.mjs';

const PROFILE = "[data-testid='arena-agent-profile']";
const IDS = ['genesis', 'runner', 'dip-hunter', 'midcap-climber', 'late-bloomer'];

export default async ({ page, log, sleep }) => {
  await guard(page, log);
  const at = clock();
  await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= -700);
  await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= -1000);
  await tfHoldUntil(page, sleep, ['d'], (p) => p.x >= -510);
  await page.keyboard.down('w');
  await waitFor(page, sleep, async () => /Watch its trades/i.test(await bodyText(page)), 6000);
  await page.keyboard.up('w');
  await page.getByRole('button', { name: 'Watch its trades', exact: true }).first().click();
  log(`${at()} profile after ${await waitFor(page, sleep, () => page.evaluate((s) => !!document.querySelector(s), PROFILE), 8000)} ms`);
  await sleep(2500);
  const read = async () => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return 'no profile';
    const t = el.innerText.replace(/\s+/g, ' ');
    const cut = (from, len) => { const i = t.search(from); return i < 0 ? 'NONE' : t.slice(i, i + len); };
    return `HEAD ${t.slice(0, 220)} || REPORT ${cut(/Latest 30-minute report/i, 900)} || RULES ${cut(/Rule changes/i, 600)}`;
  }, PROFILE);
  log(`${at()} runner (via pop-up): ${await read()}`);
  for (const id of IDS) {
    const back = page.getByRole('button', { name: 'Back to the arena', exact: true });
    if (await back.count()) { await back.first().click(); await sleep(800); }
    const card = page.locator(`[data-testid='arena-template-${id}']`).first();
    if (!(await card.count())) { log(`${at()} ${id}: card not found`); continue; }
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: /^Watch/ }).first().click();
    await waitFor(page, sleep, () => page.evaluate((s) => !!document.querySelector(s), PROFILE), 8000);
    await sleep(2000);
    log(`${at()} ${id}: ${await read()}`);
  }
};
