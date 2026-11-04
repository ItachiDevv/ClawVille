import { describe, expect, it } from 'bun:test';
import { spendPolicyInputSchema, toSpendPolicyView } from '../spend-policy';

describe('spend policy view', () => {
  it('treats a missing row as unset caps and no vendors', () => {
    expect(toSpendPolicyView(null)).toEqual({
      dailyCapUsdCents: null,
      perCallCapUsdCents: null,
      allowedVendors: [],
      configured: false,
      updatedAt: null,
    });
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
