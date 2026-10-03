// S7-dry (take ~45 s, after tf-prep.mjs): P15 walk-up to Runner -> "Choose this trading style" -> Step 2 .. Step 4,
// type a test name, then Back and close. NEVER click "Launch". guard() also aborts any POST to /me/launch.
import { guard, tfHoldUntil, bodyText, waitFor, pressKey, clock } from './lib.mjs';

export const LANE_X = -700;
export const LINE_Z = -1000;
export const AGENT_X = -510; // Runner
export const MAX_OPEN = '3'; // Step 2 on-camera edit, limits.max_open (1..5)
export const TEST_NAME = 'Reef Rehearsal'; // <= 16 chars; typed, never launched
export const TYPE_DELAY_MS = 90;
export const READ_MS = 1500; // hold on each step for the camera

const LAUNCH = "[data-testid='arena-launch']";

export default async ({ page, log, sleep, screenshotDom }) => {
  await guard(page, log);
  const at = clock();
  const flowText = () => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ') || '', LAUNCH);
  const step = async (n) => waitFor(page, sleep, async () => new RegExp(`Step ${n} of 4`).test(await bodyText(page)), 8000);
  const click = async (name) => {
    if (/^launch/i.test(name)) throw new Error(`refused to click ${name}`);
    await page.getByRole('button', { name, exact: true }).first().click();
    log(`${at()} click "${name}"`);
  };

  await tfHoldUntil(page, sleep, ['a'], (p) => p.x <= LANE_X);
  await tfHoldUntil(page, sleep, ['w'], (p) => p.z <= LINE_Z);
  await tfHoldUntil(page, sleep, ['d'], (p) => p.x >= AGENT_X);
  await page.keyboard.down('w');
  const pop = await waitFor(page, sleep, async () => /Choose this trading style/i.test(await bodyText(page)), 6000);
  await page.keyboard.up('w');
  log(`${at()} pop-up after ${pop} ms`);
  await sleep(READ_MS);

  await click('Choose this trading style');
  log(`${at()} Step 2 after ${await step(2)} ms`);
  await sleep(READ_MS);
  log(`${at()} STEP2 ${(await flowText()).slice(0, 2500)}`);
  const field = page.locator("[data-testid='arena-field-limits.max_open'] input, input[data-testid='arena-field-limits.max_open']").first();
  if (await field.count()) {
    const before = await field.inputValue();
    await field.click();
    await field.press('Control+A');
    await page.keyboard.type(MAX_OPEN, { delay: TYPE_DELAY_MS });
    log(`${at()} max_open ${before} -> ${await field.inputValue()}`);
  } else log(`${at()} max_open field not found`);
  await sleep(READ_MS);
  await click('Next');
  log(`${at()} Step 3 after ${await step(3)} ms`);
  await sleep(READ_MS);
  log(`${at()} STEP3 ${(await flowText()).slice(0, 1500)}`);
  await click('Next');
  log(`${at()} Step 4 after ${await step(4)} ms`);
  await sleep(READ_MS);
  const name = page.locator("[data-testid='arena-launch-review'] input").first();
  await name.click();
  await page.keyboard.type(TEST_NAME, { delay: TYPE_DELAY_MS });
  log(`${at()} typed name "${await name.inputValue()}"`);
  await sleep(READ_MS);
  log(`${at()} STEP4 ${(await flowText()).slice(0, 1500)}`);
  await screenshotDom('reh-s7-step4');
  await click('Back');
  log(`${at()} back to Step 3 after ${await step(3)} ms`);
  await sleep(800);
  await pressKey(page, sleep, 'Escape');
  await sleep(800);
  log(`${at()} after Escape: flow open=${await page.evaluate((s) => !!document.querySelector(s), LAUNCH)}`);
};
