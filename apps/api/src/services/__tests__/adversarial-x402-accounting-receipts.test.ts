import { describe, expect, it } from 'bun:test';
import type { X402SettlementReceipt } from '@clawville/database';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  claimX402Settlement,
  type ClaimX402SettlementInput,
} from '../x402-settlement-receipts';
import {
  assertSettlementAmountsConserved,
  calculateMeridianSettlementAmounts,
} from '../x402-settlement-accounting';

const agentPaySource = readFileSync(
  fileURLToPath(new URL('../agent-pay.ts', import.meta.url)),
  'utf8',
);
const migration0044 = readFileSync(
  fileURLToPath(new URL(
    '../../../../../packages/database/migrations/0044_x402_meridian_fees.sql',
    import.meta.url,
  )),
  'utf8',
);

function loadPrivateNetUsdcAtomicToVclaw(): (net: bigint) => number {
  const body = agentPaySource.match(
    /function netUsdcAtomicToVclaw\(netUsdcAtomic: bigint\): number \{([\s\S]*?)\n\}/,
  )?.[1];
  if (!body) throw new Error('netUsdcAtomicToVclaw source seam disappeared');
  return new Function('netUsdcAtomic', body) as (net: bigint) => number;
}

describe('adversarial Meridian fee-accounting fuzz', () => {
  const toVclaw = loadPrivateNetUsdcAtomicToVclaw();

  for (const platformFeeBps of [0, 1, 999, 1_000]) {
    for (const gross of [10_101n, 99_999n, 100_000n]) {
      it(`conserves gross exactly at bps=${platformFeeBps}, gross=${gross}`, () => {
        const amounts = calculateMeridianSettlementAmounts(gross, platformFeeBps);

        expect(() => assertSettlementAmountsConserved(amounts)).not.toThrow();
        expect(
          amounts.netUsdcAtomic
            + amounts.platformFeeUsdcAtomic
            + amounts.treasuryFeeUsdcAtomic,
        ).toBe(gross);

        if (amounts.netUsdcAtomic >= 10_000n) {
          expect(() => toVclaw(amounts.netUsdcAtomic)).not.toThrow();
          expect(toVclaw(amounts.netUsdcAtomic)).toBeGreaterThanOrEqual(1);
        } else {
          expect(() => toVclaw(amounts.netUsdcAtomic)).toThrow(
            'net USDC produces an invalid vCLAW credit',
          );
        }
      });
    }
  }

  it('F5 rejects a conserved settlement whose net is zero', () => {
    expect(() => assertSettlementAmountsConserved({
      grossUsdcAtomic: 100n,
      platformFeeUsdcAtomic: 99n,
      treasuryFeeUsdcAtomic: 1n,
      netUsdcAtomic: 0n,
    })).toThrow();
  });

  it('proves the post-fee 10_000-atomic credit guard is load-bearing', () => {
    expect(toVclaw(10_000n)).toBe(1);
    expect(() => toVclaw(9_999n)).toThrow(
      'net USDC produces an invalid vCLAW credit',
    );
  });
});

function inMemoryReceiptTx() {
  const rows = new Map<string, X402SettlementReceipt>();
  const tx = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  const signature = String(value.txSignature);
                  if (rows.has(signature)) return [];
                  const receipt = {
                    ...value,
                    createdAt: new Date('2026-07-22T00:00:00.000Z'),
                  } as X402SettlementReceipt;
                  rows.set(signature, receipt);
                  return [receipt];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  const existing = rows.values().next().value;
                  return existing ? [existing] : [];
                },
              };
            },
          };
        },
      };
    },
  };
  return { tx: tx as never, rows };
}

const baseClaim: ClaimX402SettlementInput = {
  txSignature: 'adversarial-receipt-signature',
  rail: 'agent_payment',
  kind: 'agent_payment',
  referenceId: '00000000-0000-4000-8000-000000000001',
  subjectId: '00000000-0000-4000-8000-000000000002',
  amountUsdcAtomic: 100_000n,
};

describe('adversarial receipt-claim idempotency', () => {
  it('replays the same legacy-shaped owner as same_owner without a second row', async () => {
    const memory = inMemoryReceiptTx();

    expect((await claimX402Settlement(baseClaim, memory.tx)).kind).toBe('claimed');
    expect((await claimX402Settlement(baseClaim, memory.tx)).kind).toBe('same_owner');
    expect(memory.rows.size).toBe(1);
  });

  it('replays the same fee-carrying owner as same_owner without a second row', async () => {
    const memory = inMemoryReceiptTx();
    const amounts = calculateMeridianSettlementAmounts(100_000n, 1_000);
    const claim = { ...baseClaim, ...amounts };

    expect((await claimX402Settlement(claim, memory.tx)).kind).toBe('claimed');
    expect((await claimX402Settlement(claim, memory.tx)).kind).toBe('same_owner');
    expect(memory.rows.size).toBe(1);
  });

  it('legacy then nonzero-fee claim cannot create or mutate ownership', async () => {
    const memory = inMemoryReceiptTx();
    const first = await claimX402Settlement(baseClaim, memory.tx);
    const original = structuredClone(memory.rows.get(baseClaim.txSignature));
    const feeClaim = {
      ...baseClaim,
      ...calculateMeridianSettlementAmounts(baseClaim.amountUsdcAtomic, 1_000),
    };

    const replay = await claimX402Settlement(feeClaim, memory.tx);

    expect(first.kind).toBe('claimed');
    expect(replay.kind).toBe('foreign_owner');
    expect(memory.rows.size).toBe(1);
    expect(memory.rows.get(baseClaim.txSignature)).toEqual(original);
  });
});

describe('migration 0044 static double-apply safety (no local PostgreSQL available)', () => {
  it('guards every ADD COLUMN and both ADD CONSTRAINT operations', () => {
    expect(migration0044.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(9);
    expect(migration0044).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);

    for (const constraint of [
      'x402_settlement_receipts_fee_conservation',
      'agent_payments_x402_fee_conservation',
    ]) {
      const guardedConstraint = new RegExp(
        `IF NOT EXISTS \\([\\s\\S]*?conname = '${constraint}'[\\s\\S]*?ADD CONSTRAINT "${constraint}"`,
      );
      expect(migration0044).toMatch(guardedConstraint);
    }
  });

  it('makes both data backfills repeatable with COALESCE plus NULL predicates', () => {
    expect(migration0044.match(/UPDATE "/g)).toHaveLength(2);
    expect(migration0044.match(/COALESCE\(/g)).toHaveLength(9);
    expect(migration0044.match(/ IS NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});
