// Opens the Exchange arena overview from the room (`do` or inside a take), after tf-prep.mjs:
// walk up to a house agent, "Watch its trades", then "Back to the arena". Read-only.
import { tfHoldUntil, bodyText, waitFor } from './lib.mjs';

export async function openArenaOverview(page, sleep, log, { laneX = -700, lineZ = -1000, agentX = -510 } = {}) {
  await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= laneX);
  await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= lineZ);
  await tfHoldUntil(page, sleep, ['d'], (p) => p.x >= agentX);
  await page.keyboard.down('w');
  await waitFor(page, sleep, async () => /Watch its trades/i.test(await bodyText(page)), 6000);
  await page.keyboard.up('w');
  await page.getByRole('button', { name: 'Watch its trades', exact: true }).first().click();
  await waitFor(page, sleep, () => page.evaluate(() => !!document.querySelector("[data-testid='arena-agent-profile']")), 8000);
  await page.getByRole('button', { name: 'Back to the arena', exact: true }).first().click();
  const ms = await waitFor(page, sleep, () => page.evaluate(() => !!document.querySelector("[data-testid='floor-arena-section']")), 8000);
  log?.(`arena overview after ${ms} ms`);
}

export default async ({ page, log, sleep }) => {
  await openArenaOverview(page, sleep, log);
  await sleep(1500);
  const r = await page.evaluate(() => {
    const sec = document.querySelector("[data-testid='floor-arena-section']");
    const ids = [...(sec || document).querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    const uniq = [...new Set(ids)].slice(0, 80);
    return { ids: uniq, text: (sec?.innerText || '').replace(/\s+/g, ' ').slice(0, 3500) };
  });
  log(`ids=${r.ids.join(',')}`);
  log(`text=${r.text}`);
};
