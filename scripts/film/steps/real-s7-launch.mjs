// REAL S5b + S7 (take ~60 s, after tf-prep.mjs + real-s7-setup.mjs): walk up to Runner, read the pop-up,
// "Choose this trading style", show Paper / Live "Coming later" and the locked rules, type ONE rule change,
// Next, Next, type the trader name, then Launch and hold the success screen.
//
// SAFETY: without FILM_LAUNCH=GO this step REFUSES to click "Launch": it stops at Step 4, clicks "Back",
// closes the modal, and the launch/seat guard stays on. One arena agent per account, forever.
import { guard, bodyText, waitFor, pressKey, clock } from './lib.mjs';

export const GO = process.env.FILM_LAUNCH === 'GO';
export const PRE_ROLL_MS = 1500;
export const POST_ROLL_MS = 1500;
export const AGENT = 'Runner';                       // best on 2026-10-02: +$32.49 contest P&L, clear report
export const FIELD = 'limits.max_open';             // "Max open positions" (1..5); alt: 'exits.tp' 1.2 -> 1.3
export const FIELD_VALUE = process.env.REAL_FIELD_VALUE || '3';
export const TRADER_NAME = 'Reef Rookie';           // letters + space, <= 16 chars, not a house name
export const TYPE_DELAY_MS = 120;
export const POPUP_HOLD_MS = 3000;
export const STEP_HOLD_MS = 2500;
export const STEP2_TOP_HOLD_MS = 4500;
export const SUCCESS_HOLD_MS = 6000;
const LAUNCH = "[data-testid='arena-launch']";

export default async ({ page, log, sleep, screenshotDom }) => {
  await guard(page, log, { allow: GO });
  const at = clock();
  log(`${at()} mode=${GO ? 'GO (will click Launch)' : 'DRY (will NOT click Launch)'}`);
  const step = async (n) => waitFor(page, sleep, async () => new RegExp(`Step ${n} of 4`).test(await bodyText(page)), 8000);
  const click = async (name) => {
    if (/^launch$/i.test(name) && !GO) throw new Error('refused: Launch without FILM_LAUNCH=GO');
    await page.getByRole('button', { name, exact: true }).first().click();
    log(`${at()} click "${name}"`);
  };

  await sleep(PRE_ROLL_MS);
  await page.keyboard.down('w');
  const pop = await waitFor(page, sleep, async () => new RegExp(`Choose this trading style`, 'i').test(await bodyText(page)), 8000);
  await page.keyboard.up('w');
  log(`${at()} pop-up after ${pop} ms`);
  await sleep(POPUP_HOLD_MS);

  await click('Choose this trading style');
  log(`${at()} Step 2 after ${await step(2)} ms`);
  // The top of Step 2 already shows "Starting from Runner", Paper trading / Live trading "Coming later"
  // and the five locked rules (checked 2026-10-02 02:22Z). A scroll to the form lands in the dense filter list.
  await sleep(STEP2_TOP_HOLD_MS);
  const field = page.locator(`[data-testid='arena-field-${FIELD}'] input, input[data-testid='arena-field-${FIELD}']`).first();
  await field.scrollIntoViewIfNeeded();
  await sleep(800);
  const before = await field.inputValue();
  await field.click();
  await field.press('Control+A');
  await page.keyboard.type(FIELD_VALUE, { delay: TYPE_DELAY_MS });
  log(`${at()} ${FIELD}: ${before} -> ${await field.inputValue()}`);
  await sleep(STEP_HOLD_MS);
  await click('Next');
  log(`${at()} Step 3 after ${await step(3)} ms (every add-on stays OFF)`);
  await sleep(STEP_HOLD_MS);
  await click('Next');
  log(`${at()} Step 4 after ${await step(4)} ms`);
  await sleep(1200);
  const name = page.locator("[data-testid='arena-launch-review'] input").first();
  await name.click();
  await page.keyboard.type(TRADER_NAME, { delay: TYPE_DELAY_MS });
  log(`${at()} name "${await name.inputValue()}"`);
  await sleep(STEP_HOLD_MS);
  log(`${at()} STEP4 ${(await page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ') || '', LAUNCH)).slice(0, 900)}`);

  if (!GO) {
    log(`${at()} DRY: "Launch" NOT clicked (set FILM_LAUNCH=GO for the real take)`);
    await screenshotDom('real-s7-dry-step4');
    await click('Back');
    await sleep(600);
    await pressKey(page, sleep, 'Escape');
    await sleep(POST_ROLL_MS);
    return;
  }
  const resp = page.waitForResponse((r) => /\/api\/floor\/arena\/me\/launch/.test(r.url()) && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
  await click('Launch');
  const r = await resp;
  log(`${at()} POST /me/launch -> ${r ? r.status() : 'no response in 20 s'}`);
  const ok = await waitFor(page, sleep, async () => /is ready|Setting up your ClawPump agent|Open my trader/i.test(await bodyText(page)), 20000);
  log(`${at()} success screen after ${ok} ms: ${(await page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ') || '', LAUNCH)).slice(0, 600)}`);
  await sleep(SUCCESS_HOLD_MS);
  await sleep(POST_ROLL_MS);
};
