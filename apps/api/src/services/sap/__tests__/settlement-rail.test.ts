/**
 * settlementRail — the payai-rail discriminator (conservation keystone).
 *
 * Every settle/refund dispatches from the ROW's recorded rail. The invariant
 * locked here: ONLY the exact string 'payai' selects the payai rail; every
 * legacy row (no `rail` key), malformed metadata, or garbage value falls back
 * to 'onchain' — so no pre-existing vault-funded job can ever be re-routed to
 * a facilitator payment (which would strand its vault USDC and double-pay).
 */

import { describe, it, expect } from 'bun:test';
import { settlementRail } from '../escrow-gate';

describe('settlementRail — row-recorded rail dispatch', () => {
  it("reads 'payai' only from the exact recorded marker", () => {
    expect(settlementRail({ metadata: { rail: 'payai' } })).toBe('payai');
    expect(settlementRail({ metadata: { rail: 'payai', funded: false } })).toBe('payai');
  });

  it('legacy rows (no rail key) are on-chain — pre-payai vault jobs never re-route', () => {
    expect(settlementRail({ metadata: {} })).toBe('onchain');
    expect(settlementRail({ metadata: { isTopUp: false, funded: true } })).toBe('onchain');
  });

  it('explicit onchain / garbage / wrong-typed values are on-chain (fail-closed)', () => {
    expect(settlementRail({ metadata: { rail: 'onchain' } })).toBe('onchain');
    expect(settlementRail({ metadata: { rail: 'PAYAI' } })).toBe('onchain');
    expect(settlementRail({ metadata: { rail: 'payai ' } })).toBe('onchain');
    expect(settlementRail({ metadata: { rail: 42 } })).toBe('onchain');
    expect(settlementRail({ metadata: { rail: null } })).toBe('onchain');
  });

  it('null/undefined metadata is on-chain', () => {
    expect(settlementRail({ metadata: null as unknown as Record<string, unknown> })).toBe(
      'onchain',
    );
    expect(
      settlementRail({ metadata: undefined as unknown as Record<string, unknown> }),
    ).toBe('onchain');
  });
});
