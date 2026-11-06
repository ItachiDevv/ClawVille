import { describe, expect, it } from 'bun:test';
import { resolveSpendPolicyValues, spendPolicyInputSchema, toSpendPolicyView } from '../spend-policy';

describe('spend policy view', () => {
  it('treats a missing row as unset caps and no vendors', () => {
    expect(toSpendPolicyView(null)).toEqual({
      dailyCapUsdCents: null,
      perCallCapUsdCents: null,
      allowedVendors: [],
      studiosKeyImagesPerDay: 10,
      studiosVideosPerDay: 2,
      studiosCharacterShotsPerDay: 5,
      studiosRecastsPerDay: 1,
      requireApproval: false,
      configured: false,
      updatedAt: null,
    });
  });

  it('shows ask-me-before-each-payment, off when the row is missing or never set', () => {
    const base = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [], updatedAt: null };
    expect(toSpendPolicyView({ ...base, requireApproval: true }).requireApproval).toBe(true);
    expect(toSpendPolicyView({ ...base, requireApproval: null }).requireApproval).toBe(false);
    expect(toSpendPolicyView(base).requireApproval).toBe(false);
  });

  it('shows the saved own-key image count, or the default when it was never set', () => {
    const base = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [], updatedAt: null };
    expect(toSpendPolicyView({ ...base, studiosKeyImagesPerDay: 0 }).studiosKeyImagesPerDay).toBe(0);
    expect(toSpendPolicyView({ ...base, studiosKeyImagesPerDay: 40 }).studiosKeyImagesPerDay).toBe(40);
    expect(toSpendPolicyView({ ...base, studiosKeyImagesPerDay: null }).studiosKeyImagesPerDay).toBe(10);
  });

  it('is configured only when both caps are set', () => {
    const base = { allowedVendors: [], updatedAt: null };
    expect(toSpendPolicyView({ ...base, dailyCapUsdCents: 100, perCallCapUsdCents: null }).configured).toBe(false);
    expect(toSpendPolicyView({ ...base, dailyCapUsdCents: null, perCallCapUsdCents: 10 }).configured).toBe(false);
    expect(toSpendPolicyView({ ...base, dailyCapUsdCents: 0, perCallCapUsdCents: 0 }).configured).toBe(true);
  });

  it('drops vendor ids that are no longer known', () => {
    const view = toSpendPolicyView({
      dailyCapUsdCents: 1, perCallCapUsdCents: 1, allowedVendors: ['studios', 'retired-vendor'], updatedAt: null,
    });
    expect(view.allowedVendors).toEqual(['studios']);
  });
});

describe('spend policy input', () => {
  it('takes an optional own-key image count from 0 to 1000 whole', () => {
    const base = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] };
    expect(spendPolicyInputSchema.safeParse(base).success).toBe(true);
    for (const ok of [0, 25, 1000]) expect(spendPolicyInputSchema.safeParse({ ...base, studiosKeyImagesPerDay: ok }).success).toBe(true);
    for (const bad of [-1, 1001, 2.5, null, '5']) {
      expect(spendPolicyInputSchema.safeParse({ ...base, studiosKeyImagesPerDay: bad }).success).toBe(false);
    }
  });

  it('keeps the current own-key image count when the input leaves it out', () => {
    const current = toSpendPolicyView({ dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [], studiosKeyImagesPerDay: 7, updatedAt: null });
    const base = { dailyCapUsdCents: 100, perCallCapUsdCents: 10, allowedVendors: [] as 'studios'[] };
    expect(resolveSpendPolicyValues(base, current).studiosKeyImagesPerDay).toBe(7);
    expect(resolveSpendPolicyValues({ ...base, studiosKeyImagesPerDay: 3 }, current).studiosKeyImagesPerDay).toBe(3);
  });

  it('takes an optional boolean requireApproval and keeps the saved one when left out', () => {
    const base = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] as 'studios'[] };
    expect(spendPolicyInputSchema.safeParse({ ...base, requireApproval: true }).success).toBe(true);
    for (const bad of ['yes', 1, null]) expect(spendPolicyInputSchema.safeParse({ ...base, requireApproval: bad }).success).toBe(false);
    const asking = toSpendPolicyView({ ...base, requireApproval: true, updatedAt: null });
    expect(resolveSpendPolicyValues(base, asking).requireApproval).toBe(true);
    expect(resolveSpendPolicyValues({ ...base, requireApproval: false }, asking).requireApproval).toBe(false);
  });

  it('accepts unset caps (the human may clear a cap)', () => {
    expect(spendPolicyInputSchema.safeParse({
      dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [],
    }).success).toBe(true);
  });

  it('refuses a per-call cap above the daily cap', () => {
    expect(spendPolicyInputSchema.safeParse({
      dailyCapUsdCents: 10, perCallCapUsdCents: 11, allowedVendors: [],
    }).success).toBe(false);
  });
});
