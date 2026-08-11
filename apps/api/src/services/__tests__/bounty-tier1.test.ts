import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveTier1BountyMaxUsdCents,
  selectUsdcBountyTier,
  settleTier1Bounty,
  assertTier1BountyApprovable,
  claimTier1BountyCancellation,
  claimTier1BountyExpiry,
  planTier1SettlementAttempt,
  resumeTier1BountySettlements,
  tier1SettlementIdempotencyKey,
  TIER1_SETTLEMENT_MAX_ATTEMPTS,
  Tier1LifecycleConflictError,
} from '../bounty-tier1';
import type { AgentPayInput, AgentPayResult } from '../agent-pay';
import {
  admitPosterUsdcSpend,
  PosterUsdcSpendAdmissionError,
} from '../usdc-spend-admission';

const BOUNTY_ID = '11111111-1111-4111-8111-111111111111';
const POSTER = '22222222-2222-4222-8222-222222222222';
const HUNTER = '33333333-3333-4333-8333-333333333333';

describe('Tier-1 bounty rail and cap', () => {
  it('defaults to $50 and floors an unsafe env override at $1', () => {
    expect(resolveTier1BountyMaxUsdCents(undefined)).toBe(5_000);
    expect(resolveTier1BountyMaxUsdCents('50')).toBe(100);
    expect(resolveTier1BountyMaxUsdCents('1500')).toBe(1_500);
    expect(resolveTier1BountyMaxUsdCents('2500')).toBe(2_500);
    expect(resolveTier1BountyMaxUsdCents('999999999')).toBe(5_000);
    expect(resolveTier1BountyMaxUsdCents('not-money')).toBe(5_000);
  });

  it('uses Tier 1 while SAP is paused and reserves Tier 2 for over-cap enabled posts', () => {
    expect(selectUsdcBountyTier({ rewardUsdCents: 5_000, escrowGateOpen: false })).toBe(1);
    expect(selectUsdcBountyTier({ rewardUsdCents: 5_001, escrowGateOpen: false })).toBe(1);
    expect(selectUsdcBountyTier({ rewardUsdCents: 5_000, escrowGateOpen: true })).toBe(1);
    expect(selectUsdcBountyTier({ rewardUsdCents: 5_001, escrowGateOpen: true })).toBe(2);
  });
});

describe('Tier-1 approval settlement', () => {
  const input = {
    bountyId: BOUNTY_ID,
    posterAvatarId: POSTER,
    hunterAvatarId: HUNTER,
    rewardUsdCents: 2_000,
  };

  it('uses the deterministic key, count-only exemption, and books only confirmed payment', async () => {
    let captured: AgentPayInput | undefined;
    let books = 0;
    const payment: Extract<AgentPayResult, { ok: true }> = {
      ok: true,
      paymentId: '44444444-4444-4444-8444-444444444444',
      status: 'settled',
      replay: false,
      txSignature: 'confirmed-signature',
      senderAvatarId: POSTER,
      recipientAvatarId: HUNTER,
      usdCents: 2_000,
      earnedVclaw: 2_000,
      earnedLedgerId: '55555555-5555-4555-8555-555555555555',
    };
    const result = await settleTier1Bounty(input, {
      pay: async (request) => {
        captured = request;
        return payment;
      },
      bookPaid: async () => {
        books += 1;
        return { replay: false };
      },
    });

    expect(result.ok).toBe(true);
    expect(captured).toEqual({
      senderAvatarId: POSTER,
      recipient: { kind: 'avatar', avatarId: HUNTER },
      usdCents: 2_000,
      idempotencyKey: `bounty:${BOUNTY_ID}:tier1-settle`,
      bountyHoldId: BOUNTY_ID,
      countCapExempt: true,
      platformMediatedMaxUsdCents: 5_000,
    });
    expect(books).toBe(1);
  });

  it('keeps booking untouched on settle failure so the open hold remains retryable', async () => {
    let books = 0;
    const result = await settleTier1Bounty(input, {
      pay: async () => ({
        ok: false,
        code: 'payai_unavailable',
        status: 'pending',
        detail: 'facilitator_circuit_open',
      }),
      bookPaid: async () => {
        books += 1;
        return { replay: false };
      },
    });
    expect(result).toMatchObject({ ok: false, payment: { code: 'payai_unavailable' } });
    expect(books).toBe(0);
  });

  it('propagates an idempotent payment or booking replay', async () => {
    const result = await settleTier1Bounty(input, {
      pay: async () => ({
        ok: true,
        paymentId: '44444444-4444-4444-8444-444444444444',
        status: 'settled',
        replay: true,
        txSignature: 'confirmed-signature',
        senderAvatarId: POSTER,
        recipientAvatarId: HUNTER,
        usdCents: 2_000,
        earnedVclaw: 2_000,
        earnedLedgerId: '55555555-5555-4555-8555-555555555555',
      }),
      bookPaid: async () => ({ replay: true }),
    });
    expect(result).toMatchObject({ ok: true, replay: true });
  });
});

describe('poster-scoped USDC spend admission', () => {
  function txWithState(state: {
    holds: bigint;
    liabilities: bigint;
    consumed?: bigint;
  }) {
    let call = 0;
    return {
      execute: async () => {
        call += 1;
        if (call === 1) return [];
        if (call === 2) return [{ public_key: 'poster-wallet' }];
        return [{
          open_holds: state.holds.toString(),
          outgoing_liabilities: state.liabilities.toString(),
          consumed_hold: state.consumed?.toString() ?? null,
        }];
      },
    };
  }

  it('ordinary sends reserve every open hold plus pending/settling liabilities', async () => {
    const tx = txWithState({ holds: 20_000_000n, liabilities: 5_000_000n });
    await expect(admitPosterUsdcSpend(tx as never, {
      posterAvatarId: POSTER,
      amountAtomic: 6_000_000n,
      readBalance: async () => 30_000_000n,
    })).rejects.toMatchObject({
      code: 'insufficient_usdc',
      detail: { requiredBaseUnits: '31000000' },
    } satisfies Partial<PosterUsdcSpendAdmissionError>);
  });

  it('settlement consumes exactly its own hold while every other dollar stays reserved', async () => {
    const tx = txWithState({
      holds: 30_000_000n,
      liabilities: 5_000_000n,
      consumed: 20_000_000n,
    });
    const admitted = await admitPosterUsdcSpend(tx as never, {
      posterAvatarId: POSTER,
      amountAtomic: 20_000_000n,
      consumeBountyHoldId: BOUNTY_ID,
      readBalance: async () => 35_000_000n,
    });
    expect(admitted.requiredAtomic).toBe(35_000_000n);
    expect(admitted.consumedHoldAtomic).toBe(20_000_000n);
  });

  it('blocks on an ambiguous agent-payment liability until operator resolution removes it', async () => {
    await expect(admitPosterUsdcSpend(
      txWithState({ holds: 0n, liabilities: 5_000_000n }) as never,
      {
        posterAvatarId: POSTER,
        amountAtomic: 6_000_000n,
        readBalance: async () => 10_000_000n,
      },
    )).rejects.toMatchObject({ code: 'insufficient_usdc' });

    const admitted = await admitPosterUsdcSpend(
      txWithState({ holds: 0n, liabilities: 0n }) as never,
      {
        posterAvatarId: POSTER,
        amountAtomic: 6_000_000n,
        readBalance: async () => 10_000_000n,
      },
    );
    expect(admitted.requiredAtomic).toBe(6_000_000n);
  });

  it('blocks on an ambiguous withdrawal liability until its terminal resolution', async () => {
    await expect(admitPosterUsdcSpend(
      txWithState({ holds: 2_000_000n, liabilities: 4_000_000n }) as never,
      {
        posterAvatarId: POSTER,
        amountAtomic: 5_000_000n,
        readBalance: async () => 10_000_000n,
      },
    )).rejects.toMatchObject({
      code: 'insufficient_usdc',
      detail: { requiredBaseUnits: '11000000' },
    });

    const admitted = await admitPosterUsdcSpend(
      txWithState({ holds: 2_000_000n, liabilities: 0n }) as never,
      {
        posterAvatarId: POSTER,
        amountAtomic: 5_000_000n,
        readBalance: async () => 10_000_000n,
      },
    );
    expect(admitted.requiredAtomic).toBe(7_000_000n);
  });
});

describe('Tier-1 approve/expiry race', () => {
  function lifecycleTx(state: {
    bounty: 'open' | 'expired' | 'cancelled';
    approved: boolean;
    currentAttempts?: number;
    active?: boolean;
    paymentAdmitted?: boolean;
  }) {
    return {
      execute: async () => [],
      update: () => ({
        set: (values: { status?: string }) => ({
          where: () => ({
            returning: async () => {
              if (values.status === 'expired') {
                if (state.bounty !== 'open' || state.approved) return [];
                state.bounty = 'expired';
                return [{ id: BOUNTY_ID }];
              }
              if (values.status === 'cancelled') {
                if (
                  state.bounty !== 'open'
                  || (state.currentAttempts ?? 0) !== 0
                  || state.active
                  || state.approved
                  || state.paymentAdmitted
                ) return [];
                state.bounty = 'cancelled';
                return [{ id: BOUNTY_ID }];
              }
              return state.bounty === 'open' ? [{ id: BOUNTY_ID }] : [];
            },
          }),
        }),
      }),
    };
  }

  it('expiry wins first: completed expiry makes approval refuse', async () => {
    const state = { bounty: 'open' as const, approved: false } as {
      bounty: 'open' | 'expired'; approved: boolean;
    };
    const tx = lifecycleTx(state);
    expect(await claimTier1BountyExpiry(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    })).toBe(true);
    await expect(assertTier1BountyApprovable(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    })).rejects.toBeInstanceOf(Tier1LifecycleConflictError);
  });

  it('approval wins first: approved-attempt reassertion makes expiry refuse', async () => {
    const state = { bounty: 'open' as const, approved: false } as {
      bounty: 'open' | 'expired'; approved: boolean;
    };
    const tx = lifecycleTx(state);
    await assertTier1BountyApprovable(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    });
    state.approved = true;
    expect(await claimTier1BountyExpiry(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    })).toBe(false);
    expect(state.bounty).toBe('open');
  });
});

describe('Tier-1 cancel/approve race', () => {
  function raceTx(state: {
    bounty: 'open' | 'cancelled';
    approved: boolean;
    currentAttempts: number;
    paymentAdmitted: boolean;
  }) {
    return {
      execute: async () => [],
      update: () => ({
        set: (values: { status?: string }) => ({
          where: () => ({
            returning: async () => {
              if (values.status === 'cancelled') {
                if (
                  state.bounty !== 'open'
                  || state.currentAttempts !== 0
                  || state.approved
                  || state.paymentAdmitted
                ) return [];
                state.bounty = 'cancelled';
                return [{ id: BOUNTY_ID }];
              }
              return state.bounty === 'open' ? [{ id: BOUNTY_ID }] : [];
            },
          }),
        }),
      }),
    };
  }

  it('cancel wins first: locked terminal CAS makes approval lose and permits release', async () => {
    const state = {
      bounty: 'open' as const,
      approved: false,
      currentAttempts: 0,
      paymentAdmitted: false,
    } as {
      bounty: 'open' | 'cancelled'; approved: boolean; currentAttempts: number; paymentAdmitted: boolean;
    };
    const tx = raceTx(state);
    const claimed = await claimTier1BountyCancellation(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    });
    expect(claimed).toBe(true);
    await expect(assertTier1BountyApprovable(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    })).rejects.toBeInstanceOf(Tier1LifecycleConflictError);
    expect(state.bounty).toBe('cancelled');
  });

  it('approval wins first: locked cancellation CAS refuses and the hold stays open', async () => {
    const state = {
      bounty: 'open' as const,
      approved: false,
      currentAttempts: 1,
      paymentAdmitted: false,
    } as {
      bounty: 'open' | 'cancelled'; approved: boolean; currentAttempts: number; paymentAdmitted: boolean;
    };
    const tx = raceTx(state);
    await assertTier1BountyApprovable(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    });
    state.approved = true;
    state.paymentAdmitted = true;
    expect(await claimTier1BountyCancellation(tx as never, {
      bountyId: BOUNTY_ID, posterAvatarId: POSTER, now: new Date(),
    })).toBe(false);
    expect(state.bounty).toBe('open');
  });
});

describe('Tier-1 bounded definitive settlement retry', () => {
  const failedPayment = {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'failed' as const,
    idempotencyKey: tier1SettlementIdempotencyKey(BOUNTY_ID, 1),
    capExempt: true,
    txSignature: null,
    reconcileTxSignature: null,
    settlePayer: null,
    failureReason: 'recipient_ata_missing',
  };

  it('rearms only a proven no-broadcast failure with the next attempt-scoped key', () => {
    expect(planTier1SettlementAttempt({
      bountyId: BOUNTY_ID,
      settlementAttempt: 1,
      payment: failedPayment,
    })).toEqual({
      kind: 'rearm',
      attempt: 2,
      idempotencyKey: `bounty:${BOUNTY_ID}:tier1-settle:2`,
      paymentId: failedPayment.id,
    });
  });

  it('freezes reconcile on its original key and never proposes another key', () => {
    expect(planTier1SettlementAttempt({
      bountyId: BOUNTY_ID,
      settlementAttempt: 1,
      payment: { ...failedPayment, status: 'reconcile', capExempt: false },
    })).toEqual({ kind: 'frozen', reason: 'ambiguous', paymentId: failedPayment.id });
  });

  it('stops after five total attempts and requires manual action', () => {
    expect(TIER1_SETTLEMENT_MAX_ATTEMPTS).toBe(5);
    expect(planTier1SettlementAttempt({
      bountyId: BOUNTY_ID,
      settlementAttempt: 5,
      payment: {
        ...failedPayment,
        idempotencyKey: tier1SettlementIdempotencyKey(BOUNTY_ID, 5),
      },
    })).toEqual({ kind: 'exhausted', attempt: 5, paymentId: failedPayment.id });
  });

  it('resume drives the prepared retry generation and books a successful retry', async () => {
    let drivenAttempt: number | undefined;
    const settled = await resumeTier1BountySettlements(1, {
      listCandidates: async () => [{
        bountyId: BOUNTY_ID,
        posterAvatarId: POSTER,
        hunterAvatarId: HUNTER,
        rewardUsdCents: 2_000,
      }],
      prepareAttempt: async () => ({
        kind: 'drive',
        attempt: 2,
        idempotencyKey: tier1SettlementIdempotencyKey(BOUNTY_ID, 2),
      }),
      settle: async (input) => {
        drivenAttempt = input.settlementAttempt;
        return {
          ok: true,
          replay: false,
          payment: {
            ok: true,
            paymentId: failedPayment.id,
            status: 'settled',
            replay: false,
            txSignature: 'retry-confirmed',
            senderAvatarId: POSTER,
            recipientAvatarId: HUNTER,
            usdCents: 2_000,
            earnedVclaw: 2_000,
            earnedLedgerId: '55555555-5555-4555-8555-555555555555',
          },
        };
      },
    });
    expect(settled).toBe(1);
    expect(drivenAttempt).toBe(2);
  });

  it('resume never calls settle for ambiguous or exhausted attempts and pages ops', async () => {
    let settleCalls = 0;
    const alerts: Array<{ message: string }> = [];
    await resumeTier1BountySettlements(1, {
      listCandidates: async () => [
        {
          bountyId: '66666666-6666-4666-8666-666666666666',
          posterAvatarId: POSTER,
          hunterAvatarId: HUNTER,
          rewardUsdCents: 2_000,
        },
        {
          bountyId: '77777777-7777-4777-8777-777777777777',
          posterAvatarId: POSTER,
          hunterAvatarId: HUNTER,
          rewardUsdCents: 2_000,
        },
      ],
      prepareAttempt: async (input) => input.bountyId.startsWith('6666')
        ? { kind: 'frozen', reason: 'ambiguous', paymentId: failedPayment.id }
        : { kind: 'exhausted', attempt: 5, paymentId: failedPayment.id },
      settle: async () => {
        settleCalls += 1;
        throw new Error('ambiguous payment must never be driven');
      },
      alert: async (input) => { alerts.push({ message: input.message }); },
      now: () => 2 * 60 * 60 * 1_000,
    });
    expect(settleCalls).toBe(0);
    expect(alerts[0]?.message).toContain('frozen (ambiguous)');
    expect(alerts[1]?.message).toContain('exhausted 5 definitive settlement attempts');
  });
});

describe('Tier-1 durable hold contracts', () => {
  const root = resolve(__dirname, '../../../../..');
  const migration = readFileSync(
    resolve(root, 'packages/database/migrations/0061_tier1_bounty_usdc_holds.sql'),
    'utf8',
  );
  const service = readFileSync(resolve(__dirname, '../bounty-tier1.ts'), 'utf8');
  const route = readFileSync(resolve(__dirname, '../../routes/bounties.ts'), 'utf8');
  const crank = readFileSync(resolve(__dirname, '../bounty-composition-worker.ts'), 'utf8');
  const resume = readFileSync(resolve(__dirname, '../agent-pay-resume.ts'), 'utf8');
  const admission = readFileSync(resolve(__dirname, '../usdc-spend-admission.ts'), 'utf8');
  const agentPay = readFileSync(resolve(__dirname, '../agent-pay.ts'), 'utf8');
  const withdraw = readFileSync(resolve(__dirname, '../wallet-withdraw-executor.ts'), 'utf8');

  it('ships an idempotent additive hold table and count-only agent-pay column', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "bounty_usdc_holds"');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "bounty_usdc_holds_poster_open_idx"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "count_cap_exempt"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "bounty_hold_id"');
    expect(migration).toContain('"settlement_attempt" integer NOT NULL DEFAULT 1');
  });

  it('uses one poster spend lock and one admission function on every USDC path', () => {
    expect(admission).toContain("POSTER_USDC_SPEND_LOCK_PREFIX = 'custodial-usdc-spend:'");
    expect(service).toContain('await admitPosterUsdcSpend(tx');
    expect(agentPay).toContain('await admitPosterUsdcSpend(tx');
    expect(withdraw).toContain('await d.db.admitUsdcWithdrawal');
    expect(withdraw).toContain('await admitPosterUsdcSpend(tx');
    expect(agentPay).toContain('bountyHoldId: input.bountyHoldId ?? null');
    expect(admission).toContain("p.status IN ('pending', 'settling')");
    expect(admission).toContain("p.status = 'reconcile' AND p.cap_exempt IS NOT TRUE");
    expect(admission).toContain("w.status IN ('pending', 'sending', 'reconcile')");
  });

  it('posts the hold in the bounty transaction and uses row-count CAS terminal writes', () => {
    expect(route).toContain('await insertTier1BountyHold(tx');
    expect(service).toContain("eq(bountyUsdcHolds.status, 'open')");
    expect(service).toContain("status: 'settled'");
    expect(service).toContain("status: 'released'");
    expect(service).toContain("action: 'bounty.tier1_settled'");
    expect(service).toContain("action: 'bounty.tier1_released'");
    expect(service).toContain('eq(bounties.currentAttempts, 0)');
    expect(service).toContain("IN ('claimed', 'in_progress', 'submitted', 'approved')");
    expect(route).toContain('await claimTier1BountyCancellation(tx');
  });

  it('keeps Tier-1 expiry off-chain and settlement retries on the existing workers', () => {
    expect(crank).toContain('sweepExpiredTier1Bounties');
    expect(crank).toContain("if (bountySettlementRail() !== 'sap-payai-composed') return");
    expect(resume).toContain('resumeTier1BountySettlements');
    expect(service).not.toContain('refundComposedBounty');
  });
});
