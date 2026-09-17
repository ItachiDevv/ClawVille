import { describe, expect, test } from 'bun:test';
// Imports the caps module ONLY. Reaching through the bridge would evaluate
// the operator identity at module load and poison the other suites.
import { DOORDASH_CAPS, capRefusal, formatUsd } from '../doordash-caps';

/**
 * The frozen spec (section 8.2) requires the cap refusal to be covered AT THE
 * EXACT BOUNDARY and one cent under. The claim transaction around this needs a
 * live database, but the arithmetic does not, and the arithmetic is the part
 * that decides whether the founder's card gets charged past a limit he set.
 *
 * The founder's caps (2026-09-16): 2 orders per UTC day, $75 per order,
 * $150 per UTC day including tip.
 */
const NONE = { count: 0, spentCents: 0 };

describe('the built-in caps are the founder ruling', () => {
  test('defaults match what was agreed, so a silent default change fails here', () => {
    expect(DOORDASH_CAPS.dailyOrderCount).toBe(2);
    expect(DOORDASH_CAPS.maxOrderCents).toBe(7500);
    expect(DOORDASH_CAPS.dailySpendCents).toBe(15000);
  });
});

describe('per-order cap, at the boundary', () => {
  test('exactly $75.00 is allowed', () => {
    expect(capRefusal(NONE, 7500)).toBeNull();
  });

  test('one cent under is allowed', () => {
    expect(capRefusal(NONE, 7499)).toBeNull();
  });

  test('one cent over is refused, and says the real numbers', () => {
    const reason = capRefusal(NONE, 7501);
    expect(reason).not.toBeNull();
    expect(reason).toContain(formatUsd(7501));
    expect(reason).toContain(formatUsd(7500));
  });
});

describe('daily order count, at the boundary', () => {
  test('the first and second orders of the day are allowed', () => {
    expect(capRefusal({ count: 0, spentCents: 0 }, 1000)).toBeNull();
    expect(capRefusal({ count: 1, spentCents: 1000 }, 1000)).toBeNull();
  });

  test('the third is refused even when it is cheap', () => {
    const reason = capRefusal({ count: 2, spentCents: 2000 }, 1);
    expect(reason).toContain('order 3 today');
    expect(reason).toContain('2 a day');
  });
});

describe('daily spend cap, at the boundary', () => {
  test('a charge landing exactly on $150.00 for the day is allowed', () => {
    expect(capRefusal({ count: 1, spentCents: 7500 }, 7500)).toBeNull();
  });

  test('one cent under the daily total is allowed', () => {
    expect(capRefusal({ count: 1, spentCents: 7500 }, 7499)).toBeNull();
  });

  test('one cent over the daily total is refused', () => {
    // The per-order cap must NOT be what catches this: 7501 would trip that
    // first and hide whether the daily arithmetic works at all.
    const reason = capRefusal({ count: 1, spentCents: 7501 }, 7500);
    expect(reason).not.toBeNull();
    expect(reason).toContain('a day');
  });
});

describe('the tip is inside the cap, not outside it', () => {
  test('a $74 order with a $2 tip breaches the per-order cap', () => {
    // The caller passes total + tip as the charge, which is the whole reason
    // the tip cannot be used to step around the limit.
    expect(capRefusal(NONE, 7400)).toBeNull();
    expect(capRefusal(NONE, 7400 + 200)).not.toBeNull();
  });

  test('a tip can push the day over even when the order itself fits', () => {
    expect(capRefusal({ count: 1, spentCents: 7500 }, 7400)).toBeNull();
    expect(capRefusal({ count: 1, spentCents: 7500 }, 7400 + 200)).not.toBeNull();
  });
});

describe('which cap is reported when more than one is broken', () => {
  test('the order count is reported first, because it is the hardest stop', () => {
    const reason = capRefusal({ count: 2, spentCents: 20000 }, 90000);
    expect(reason).toContain('order 3 today');
  });

  test('a zero charge still cannot beat an exhausted order count', () => {
    expect(capRefusal({ count: 2, spentCents: 0 }, 0)).not.toBeNull();
  });
});
