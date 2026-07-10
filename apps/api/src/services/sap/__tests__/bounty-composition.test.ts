/**
 * Composed-bounty rail (SAP V2 vault → PayAI x402) — full-lifecycle unit tests.
 *
 * The money ORCHESTRATION (`openComposedBountyEscrow` / `settleComposedBounty` /
 * `refundComposedBounty` / `reclaimComposedBountyDust`) and the crank
 * (`resumeComposedBounty`) are driven with INJECTED SEAMS — every escrow-gate /
 * wallet / house-resolver leg is an in-memory fake — so the four-phase state
 * machine, money conservation, and per-leg idempotency are asserted with NO RPC,
 * NO custodial signer, and NO DB. This is where a wrong value would silently
 * mis-fund, so it is locked here rather than only on the staging smoke.
 */

import { describe, it, expect } from 'bun:test';
import {
  openComposedBountyEscrow,
  settleComposedBounty,
  refundComposedBounty,
  reclaimComposedBountyDust,
  bountyVaultDeposit,
  bountyReclaimDustBaseUnits,
  bountyEscrowNonce,
  bountyDisputeWindowSlots,
  usdcRewardBaseUnits,
  type ComposedBountyDeps,
} from '../../bounty-escrow-link';
import {
  resumeComposedBounty,
  type ResumeComposedBountyDeps,
} from '../../bounty-composition-worker';
import { computeV2ProtocolFee, type EscrowGateResult, type EscrowGateErrorCode } from '../escrow-gate';

// ─── fixtures ────────────────────────────────────────────────────────────────

const BOUNTY_ID = '550e8400-e29b-41d4-a716-446655440000';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const HUNTER = '22222222-2222-4222-8222-222222222222';
const HOUSE = '33333333-3333-4333-8333-333333333333';
const VAULT_PDA = 'VaultPda1111111111111111111111111111111111';
const PAYOUT_PDA = 'PayoutPda111111111111111111111111111111111';
const AUDIT_ROOT = 'a'.repeat(64);
const REWARD = 100; // 100 whole USDC

// ── gate-result builders (only the fields the orchestration reads) ────────────
function openOk(escrowPda: string): EscrowGateResult {
  return { ok: true, phase: 'open', settlement: { escrowPda } as any, chain: null, replay: false };
}
function approveOk(): EscrowGateResult {
  return { ok: true, phase: 'approved', settlement: {} as any, approvedCalls: '1' };
}
function settleV2Pending(auditRootHex: string | null, dryRun: boolean): EscrowGateResult {
  return {
    ok: true, phase: 'pending', settlement: { auditRootHex, dryRun } as any,
    chain: null, replay: false, next: 'finalize',
  };
}
function settleV2Replayed(auditRootHex: string | null, dryRun: boolean): EscrowGateResult {
  // A replayed V2 settle is already `settled` (finalize done on a prior pass).
  return { ok: true, phase: 'settled', settlement: { auditRootHex, dryRun } as any, chain: null, replay: true };
}
function settledOk(): EscrowGateResult {
  return { ok: true, phase: 'settled', settlement: {} as any, chain: null, replay: false };
}
function fail(code: EscrowGateErrorCode, message = 'boom'): EscrowGateResult {
  return { ok: false, code, message };
}

/** A full happy-path deps set: leg1a→1b(pending)→1c(finalized)→1d(reclaim)→leg2 all ok. */
function happyDeps(overrides: Partial<ComposedBountyDeps> = {}): ComposedBountyDeps {
  return {
    resolveHouseAvatarId: async () => HOUSE,
    approveJob: async () => approveOk(),
    settleJobV2: async () => settleV2Pending(AUDIT_ROOT, true),
    finalizeJobV2: async () => settledOk(),
    // leg 1d reclaim seam (fired inside settleComposedBounty after finalize)
    ensureWallet: async () => ({ publicKey: 'HouseWallet', alreadyExisted: true }) as any,
    withdrawEscrowV2Idempotent: async () => ({ ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: false }),
    openEscrow: async () => openOk(PAYOUT_PDA),
    settleJob: async () => settledOk(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. MONEY MATH — deposit / dust / nonce / conservation
// ═══════════════════════════════════════════════════════════════════════════

describe('composed bounty money math', () => {
  it('funds the vault at MAX(reward+fee, 1% create floor) = the 1% floor', () => {
    // principal 100_000_000; 1% floor = 1_000_000; 0.5% fee = 500_000 ⇒ floor wins.
    expect(bountyVaultDeposit(REWARD)).toBe(101_000_000n);
    expect(usdcRewardBaseUnits(REWARD)).toBe(100_000_000n);
    expect(computeV2ProtocolFee(100_000_000n)).toBe(500_000n);
  });

  it('reclaimable dust = deposit − principal − fee (the ~0.5% headroom spread)', () => {
    // 101_000_000 − 100_000_000 − 500_000 = 500_000
    expect(bountyReclaimDustBaseUnits(REWARD)).toBe(500_000n);
  });

  it('conserves exactly: creator deposit = hunter reward + treasury fee + creator dust', () => {
    const principal = usdcRewardBaseUnits(REWARD); // → hunter (leg 2)
    const fee = computeV2ProtocolFee(principal); // → treasury (settle)
    const dust = bountyReclaimDustBaseUnits(REWARD); // → creator (reclaim)
    expect(bountyVaultDeposit(REWARD)).toBe(principal + fee + dust);
  });

  it('dust is never negative for any valid reward (1% floor always > 0.5% fee)', () => {
    for (const r of [10, 1, 250, 1_000, 999_999]) {
      expect(bountyReclaimDustBaseUnits(r) >= 0n).toBe(true);
    }
  });

  it('nonce is a deterministic big-endian u64 of the bounty UUID', () => {
    expect(bountyEscrowNonce(BOUNTY_ID)).toBe(bountyEscrowNonce(BOUNTY_ID)); // stable
    expect(bountyEscrowNonce(BOUNTY_ID)).toBe(BigInt('0x550e8400e29b41d4'));
  });

  it('the composed dispute window defaults to the 1-slot minimum', () => {
    const prev = process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS;
    delete process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS;
    expect(bountyDisputeWindowSlots()).toBe(1n);
    process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS = '0'; // below floor → clamps to 1
    expect(bountyDisputeWindowSlots()).toBe(1n);
    process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS = '2160';
    expect(bountyDisputeWindowSlots()).toBe(2160n);
    if (prev === undefined) delete process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS;
    else process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS = prev;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CREATE (LEG 1 open) — post → vault_held
// ═══════════════════════════════════════════════════════════════════════════

describe('openComposedBountyEscrow (post → vault held)', () => {
  it('opens the V2 vault depositor=creator worker=house with the funded deposit + bounty nonce + window', async () => {
    let captured: any = null;
    const opened = await openComposedBountyEscrow(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD, expiresAt: new Date(2_000_000_000_000) },
      {
        resolveHouseAvatarId: async () => HOUSE,
        openEscrowV2: async (input) => {
          captured = input;
          return openOk(VAULT_PDA);
        },
      },
    );
    expect(opened.ok).toBe(true);
    expect(captured.depositorAvatarId).toBe(CREATOR);
    expect(captured.workerAvatarId).toBe(HOUSE);
    expect(captured.jobId).toBe(BOUNTY_ID);
    expect(captured.initialDeposit).toBe(bountyVaultDeposit(REWARD));
    expect(captured.pricePerCall).toBe(usdcRewardBaseUnits(REWARD));
    expect(captured.maxCalls).toBe(1n);
    expect(captured.escrowNonce).toBe(bountyEscrowNonce(BOUNTY_ID));
    expect(captured.disputeWindowSlots).toBe(bountyDisputeWindowSlots());
  });

  it('fails closed (no fund) when the house is not provisioned', async () => {
    const opened = await openComposedBountyEscrow(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD },
      { resolveHouseAvatarId: async () => null },
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) expect(opened.code).toBe('internal');
  });

  it('replays idempotently (same nonce ⇒ the gate replays the open — no double fund)', async () => {
    let opens = 0;
    const deps: ComposedBountyDeps = {
      resolveHouseAvatarId: async () => HOUSE,
      openEscrowV2: async () => {
        opens += 1;
        // The gate's claim-first insert returns replay:true on the 2nd identical open.
        return { ok: true, phase: 'open', settlement: { escrowPda: VAULT_PDA } as any, chain: null, replay: opens > 1 };
      },
    };
    const a = await openComposedBountyEscrow({ bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD }, deps);
    const b = await openComposedBountyEscrow({ bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD }, deps);
    expect(a.ok && b.ok).toBe(true);
    if (b.ok && 'replay' in b) expect(b.replay).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SETTLE (approve → settleV2 → finalizeV2 → payout) — the 4-phase machine
// ═══════════════════════════════════════════════════════════════════════════

describe('settleComposedBounty phase machine', () => {
  const input = { bountyId: BOUNTY_ID, escrowPda: VAULT_PDA, creatorAvatarId: CREATOR, hunterAvatarId: HUNTER, tokenReward: REWARD };

  it('PAID — leg1 finalizes + leg2 pays the hunter; carries both PDAs + provenance', async () => {
    const settled = await settleComposedBounty(input, happyDeps());
    expect(settled.ok).toBe(true);
    expect(settled.phase).toBe('paid');
    if (settled.phase === 'paid') {
      expect(settled.escrowPda).toBe(VAULT_PDA);
      expect(settled.payoutEscrowPda).toBe(PAYOUT_PDA);
      expect(settled.auditRootHex).toBe(AUDIT_ROOT);
      expect(settled.dryRun).toBe(true);
    }
  });

  it('AWAITING_FINALIZE — dispute window not elapsed ⇒ hunter UNPAID, leg 2 never runs', async () => {
    let leg2Opened = false;
    const settled = await settleComposedBounty(input, happyDeps({
      finalizeJobV2: async () => fail('finalize_not_ready', 'window not elapsed'),
      openEscrow: async () => {
        leg2Opened = true;
        return openOk(PAYOUT_PDA);
      },
    }));
    expect(settled.ok).toBe(false);
    expect(settled.phase).toBe('awaiting_finalize');
    if (settled.phase === 'awaiting_finalize') expect(settled.code).toBe('finalize_not_ready');
    expect(leg2Opened).toBe(false); // NO payout while the principal is unfinalized
  });

  it('RECONCILE_PAYOUT_FAILED — leg1 finalized (reward at house) but leg2 payout fails', async () => {
    const settled = await settleComposedBounty(input, happyDeps({
      settleJob: async () => fail('payai_release_failed', 'facilitator down'),
    }));
    expect(settled.ok).toBe(false);
    expect(settled.phase).toBe('reconcile_payout_failed');
    if (settled.phase === 'reconcile_payout_failed') {
      expect(settled.payoutEscrowPda).toBe(PAYOUT_PDA); // leg-2 escrow opened; retry target
      expect(settled.code).toBe('payai_release_failed');
    }
  });

  it('FAILED — leg1b cannot settle ⇒ funds stay fully in the vault, leg 2 never runs', async () => {
    let leg2Opened = false;
    const settled = await settleComposedBounty(input, happyDeps({
      settleJobV2: async () => fail('settle_unconfirmed', 'broadcast unknown'),
      openEscrow: async () => {
        leg2Opened = true;
        return openOk(PAYOUT_PDA);
      },
    }));
    expect(settled.ok).toBe(false);
    expect(settled.phase).toBe('failed');
    expect(leg2Opened).toBe(false);
  });

  it('leg 1d AUTO-RECLAIM fires after finalize — `${id}:reclaim` requestId + exact dust', async () => {
    let reclaimCall: any = null;
    const settled = await settleComposedBounty(input, happyDeps({
      withdrawEscrowV2Idempotent: async (w) => {
        reclaimCall = w;
        return { ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: false };
      },
    }));
    expect(settled.phase).toBe('paid');
    expect(reclaimCall?.requestId).toBe(`${BOUNTY_ID}:reclaim`);
    expect(reclaimCall?.amount).toBe(bountyReclaimDustBaseUnits(REWARD));
  });

  it('leg 1d reclaim does NOT run before finalize (awaiting_finalize path)', async () => {
    let reclaimRan = false;
    const settled = await settleComposedBounty(input, happyDeps({
      finalizeJobV2: async () => fail('finalize_not_ready'),
      withdrawEscrowV2Idempotent: async () => {
        reclaimRan = true;
        return { ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: false };
      },
    }));
    expect(settled.phase).toBe('awaiting_finalize');
    expect(reclaimRan).toBe(false);
  });

  it('leg 1d reclaim FAILURE is non-fatal — the settle still reaches paid', async () => {
    const settled = await settleComposedBounty(input, happyDeps({
      withdrawEscrowV2Idempotent: async () => ({ ok: false, code: 'withdraw_in_flight', message: 'busy' }),
    }));
    expect(settled.phase).toBe('paid'); // a reclaim failure never blocks the hunter payout
  });

  it('tolerates a job_not_open on approve REPLAY (the approval persisted on pass 1)', async () => {
    const settled = await settleComposedBounty(input, happyDeps({
      approveJob: async () => fail('job_not_open', 'already advanced'),
    }));
    expect(settled.phase).toBe('paid'); // approve replay is not a failure
  });

  it('fails closed (never settles) when the house is not provisioned', async () => {
    const settled = await settleComposedBounty(input, { resolveHouseAvatarId: async () => null });
    expect(settled.phase).toBe('failed');
    if (settled.phase === 'failed') expect(settled.code).toBe('internal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. IDEMPOTENT REPLAY of every leg (create/settle/payout/reclaim)
// ═══════════════════════════════════════════════════════════════════════════

describe('idempotent replay', () => {
  const input = { bountyId: BOUNTY_ID, escrowPda: VAULT_PDA, creatorAvatarId: CREATOR, hunterAvatarId: HUNTER, tokenReward: REWARD };

  it('a re-driven settle after PAID replays every leg and re-reaches paid (no double move)', async () => {
    // Second-pass fakes: leg1a approve replays job_not_open, leg1b settleV2 is
    // already `settled` (skips finalize), leg2 open/approve/settle all replay ok.
    let finalizeCalls = 0;
    const settled = await settleComposedBounty(input, {
      resolveHouseAvatarId: async () => HOUSE,
      approveJob: async () => fail('job_not_open'),
      settleJobV2: async () => settleV2Replayed(AUDIT_ROOT, true),
      finalizeJobV2: async () => {
        finalizeCalls += 1;
        return settledOk();
      },
      ensureWallet: async () => ({ publicKey: 'HouseWallet', alreadyExisted: true }) as any,
      withdrawEscrowV2Idempotent: async () => ({ ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: true }),
      openEscrow: async () => openOk(PAYOUT_PDA),
      settleJob: async () => settledOk(),
    });
    expect(settled.phase).toBe('paid');
    expect(finalizeCalls).toBe(0); // replayed-settled row skips a second finalize
  });

  it('reclaim uses a deterministic `${bountyId}:reclaim` requestId + the exact dust amount', async () => {
    let captured: any = null;
    const res = await reclaimComposedBountyDust(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD },
      {
        resolveHouseAvatarId: async () => HOUSE,
        ensureWallet: async () => ({ publicKey: 'HouseWallet', alreadyExisted: true }) as any,
        withdrawEscrowV2Idempotent: async (input) => {
          captured = input;
          return { ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: false };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(captured.requestId).toBe(`${BOUNTY_ID}:reclaim`);
    expect(captured.amount).toBe(bountyReclaimDustBaseUnits(REWARD));
    expect(captured.escrowNonce).toBe(bountyEscrowNonce(BOUNTY_ID));
  });

  it('refund uses a deterministic `${bountyId}:refund` requestId + the FULL deposit', async () => {
    let captured: any = null;
    const res = await refundComposedBounty(
      { bountyId: BOUNTY_ID, escrowPda: VAULT_PDA, creatorAvatarId: CREATOR, tokenReward: REWARD },
      {
        resolveHouseAvatarId: async () => HOUSE,
        ensureWallet: async () => ({ publicKey: 'HouseWallet', alreadyExisted: true }) as any,
        withdrawEscrowV2Idempotent: async (input) => {
          captured = input;
          return { ok: true, chain: { ok: true, dryRun: false, signature: 'SIG', accounts: {} }, replayed: false };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(captured.requestId).toBe(`${BOUNTY_ID}:refund`);
    expect(captured.amount).toBe(bountyVaultDeposit(REWARD)); // full deposit incl. headroom
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE CRANK — awaiting_finalize → resume → paid; guards on non-resumable rows
// ═══════════════════════════════════════════════════════════════════════════

describe('resumeComposedBounty (finalize/payout crank)', () => {
  function ctx(over: Partial<any> = {}) {
    return {
      compositionState: 'awaiting_finalize',
      escrowPda: VAULT_PDA,
      creatorAvatarId: CREATOR,
      hunterAvatarId: HUNTER,
      tokenReward: REWARD,
      ...over,
    };
  }

  it('advances an awaiting_finalize bounty to paid once the window has elapsed', async () => {
    let applied: any = null;
    const out = await resumeComposedBounty(BOUNTY_ID, {
      loadContext: async () => ctx(),
      applyOutcome: async (input) => {
        applied = input;
        return { ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true };
      },
    } as ResumeComposedBountyDeps);
    expect(out).toEqual({ resumed: true, phase: 'paid' });
    expect(applied.bountyId).toBe(BOUNTY_ID);
    expect(applied.escrowPda).toBe(VAULT_PDA);
    expect(applied.hunterAvatarId).toBe(HUNTER);
    // The observed prior state is threaded as the →paid CAS guard.
    expect(applied.expectedPriorState).toBe('awaiting_finalize');
  });

  it('re-drives a reconcile_payout_failed bounty (leg 2 retry) — threads reconcile as the CAS prior', async () => {
    let applied: any = null;
    const out = await resumeComposedBounty(BOUNTY_ID, {
      loadContext: async () => ctx({ compositionState: 'reconcile_payout_failed' }),
      applyOutcome: async (input) => {
        applied = input;
        return { ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true };
      },
    } as ResumeComposedBountyDeps);
    expect(out).toEqual({ resumed: true, phase: 'paid' });
    expect(applied.expectedPriorState).toBe('reconcile_payout_failed');
  });

  it('skips a non-composed bounty (composition_state null)', async () => {
    const out = await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => ctx({ compositionState: null }) });
    expect(out).toEqual({ resumed: false, reason: 'not_composed' });
  });

  it('skips terminal / never-approved states (paid / vault_held / refunded)', async () => {
    for (const s of ['paid', 'vault_held', 'refunded']) {
      const out = await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => ctx({ compositionState: s }) });
      expect(out).toEqual({ resumed: false, reason: 'not_resumable' });
    }
  });

  it('skips a missing bounty / missing winning hunter / missing vault', async () => {
    expect(await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => null }))
      .toEqual({ resumed: false, reason: 'not_found' });
    expect(await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => ctx({ hunterAvatarId: null }) }))
      .toEqual({ resumed: false, reason: 'no_winner' });
    expect(await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => ctx({ escrowPda: null }) }))
      .toEqual({ resumed: false, reason: 'no_escrow' });
  });
});
