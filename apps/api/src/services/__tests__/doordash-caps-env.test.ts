import { afterEach, describe, expect, test } from 'bun:test';

/**
 * The environment may only ever make a cap TIGHTER.
 *
 * The frozen spec (section 8.2) asks for this to be proven by setting a value
 * above the ceiling and confirming the API refuses to boot. Proving it here
 * instead of by hand on a box is strictly better: it is deterministic, it runs
 * on every change, and it does not require restarting a live environment to
 * find out. Each case re-imports the module under a fresh query string so the
 * module-load validation runs again with the env it is given.
 */
const saved = { ...process.env };
let uniq = 0;

async function loadCaps(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  uniq += 1;
  return import(`../doordash-caps.ts?env=${uniq}`) as Promise<typeof import('../doordash-caps')>;
}

afterEach(() => {
  for (const key of ['DOORDASH_MAX_ORDER_USD_CENTS', 'DOORDASH_DAILY_ORDER_COUNT',
    'DOORDASH_DAILY_SPEND_USD_CENTS', 'DOORDASH_PREVIEW_TTL_MS']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

describe('the environment can only tighten a cap', () => {
  test('a lower value is accepted', async () => {
    const caps = await loadCaps({
      DOORDASH_MAX_ORDER_USD_CENTS: '2500',
      DOORDASH_DAILY_ORDER_COUNT: '1',
      DOORDASH_DAILY_SPEND_USD_CENTS: '5000',
      DOORDASH_PREVIEW_TTL_MS: '120000',
    });
    expect(caps.DOORDASH_CAPS.maxOrderCents).toBe(2500);
    expect(caps.DOORDASH_CAPS.dailyOrderCount).toBe(1);
    expect(caps.DOORDASH_CAPS.dailySpendCents).toBe(5000);
    expect(caps.DOORDASH_CAPS.previewTtlMs).toBe(120000);
  });

  test('a HIGHER value refuses to load rather than being clamped', async () => {
    // Clamping would hide the mistake from whoever set it. This is the case the
    // spec asks to be proven: a value above the ceiling stops the boot.
    await expect(loadCaps({ DOORDASH_MAX_ORDER_USD_CENTS: '50000' })).rejects.toThrow(/may only lower/);
  });

  test('every cap refuses a value above its built-in default', async () => {
    await expect(loadCaps({ DOORDASH_DAILY_ORDER_COUNT: '3' })).rejects.toThrow(/may only lower/);
    await expect(loadCaps({ DOORDASH_DAILY_SPEND_USD_CENTS: '20000' })).rejects.toThrow(/may only lower/);
    await expect(loadCaps({ DOORDASH_PREVIEW_TTL_MS: '3600000' })).rejects.toThrow(/may only lower/);
  });

  test('a value below the usable floor refuses too', async () => {
    await expect(loadCaps({ DOORDASH_DAILY_ORDER_COUNT: '0' })).rejects.toThrow(/at least/);
    await expect(loadCaps({ DOORDASH_PREVIEW_TTL_MS: '1000' })).rejects.toThrow(/at least/);
  });

  test('a non-numeric or negative value refuses', async () => {
    await expect(loadCaps({ DOORDASH_MAX_ORDER_USD_CENTS: 'lots' })).rejects.toThrow(/whole number/);
    await expect(loadCaps({ DOORDASH_MAX_ORDER_USD_CENTS: '-1' })).rejects.toThrow(/whole number/);
    await expect(loadCaps({ DOORDASH_MAX_ORDER_USD_CENTS: '75.00' })).rejects.toThrow(/whole number/);
  });

  test('an unset or blank value falls back to the founder default', async () => {
    const caps = await loadCaps({
      DOORDASH_MAX_ORDER_USD_CENTS: undefined,
      DOORDASH_DAILY_ORDER_COUNT: '   ',
    });
    expect(caps.DOORDASH_CAPS.maxOrderCents).toBe(7500);
    expect(caps.DOORDASH_CAPS.dailyOrderCount).toBe(2);
  });
});
