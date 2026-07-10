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
  _resetComposedWedgeAlerts,
  type ResumeComposedBountyDeps,
} from '../../bounty-composition-worker';
import { computeV2ProtocolFee, type EscrowGateResult, type EscrowGateErrorCode } from '../escrow-gate';
import type { SapWriteResult } from '../sap-client';
// MED-1: the create route's delete-vs-keep classification for a LEG-1 open failure.
import { PRE_BROADCAST_NO_CUSTODY } from '../../../routes/bounties';

// ─── fixtures ────────────────────────────────────────────────────────────────

const BOUNTY_ID = '550e8400-e29b-41d4-a716-446655440000';
// A SECOND, distinct bounty UUID (different nonce ⇒ different vault PDA) for the
// house-pricing serialization test — same house avatar ⇒ same pricing mutex key.
const BOUNTY_ID_2 = '660f9500-f30c-42e5-b827-557766551111';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const HUNTER = '22222222-2222-4222-8222-222222222222';
const HOUSE = '33333333-3333-4333-8333-333333333333';
const VAULT_PDA = 'VaultPda1111111111111111111111111111111111';
const VAULT_PDA_2 = 'VaultPda2222222222222222222222222222222222';
const PAYOUT_PDA = 'PayoutPda111111111111111111111111111111111';
const AUDIT_ROOT = 'a'.repeat(64);
const REWARD = 100; // 100 whole USDC

// A passing house-pricing-tier publish (the LEG-1 open prerequisite). Live-shaped
// SapWriteResult success — the escrow-open slice republishes the menu at the bounty
// price under the house mutex before every create.
function pricingOk(): SapWriteResult {
  return { ok: true, dryRun: false, signature: 'PRICINGSIG', accounts: {} };
}

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
        updateAgentPricingUsdc: async () => pricingOk(),
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

  it('publishes the house tier at the bounty price (tier=bounty-usdc, price=reward) BEFORE opening the vault', async () => {
    // THE 6148 FIX: create_escrow_v2 rejects PricingTierNotFound unless the escrow's
    // price_per_call matches a tier in the house menu. The escrow-open slice must
    // (re)publish that tier at the bounty's exact price, and must do so BEFORE the
    // create — else the vault funds against a menu the create can't consume.
    const order: string[] = [];
    let pricingInput: any = null;
    const opened = await openComposedBountyEscrow(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD },
      {
        resolveHouseAvatarId: async () => HOUSE,
        updateAgentPricingUsdc: async (input) => {
          pricingInput = input;
          order.push('pricing');
          return pricingOk();
        },
        openEscrowV2: async (input) => {
          order.push('open');
          expect(input.pricePerCall).toBe(usdcRewardBaseUnits(REWARD)); // create price == published tier price
          return openOk(VAULT_PDA);
        },
      },
    );
    expect(opened.ok).toBe(true);
    expect(order).toEqual(['pricing', 'open']); // pricing strictly precedes create
    expect(pricingInput.workerAvatarId).toBe(HOUSE);
    expect(pricingInput.tierId).toBe('bounty-usdc');
    expect(pricingInput.pricePerCall).toBe(usdcRewardBaseUnits(REWARD)); // 100_000_000 for a $100 bounty
  });

  it('tier publish FAILURE ⇒ typed `internal` failure and the vault is NEVER opened (no 6148-doomed vault)', async () => {
    let openCalled = false;
    const opened = await openComposedBountyEscrow(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD },
      {
        resolveHouseAvatarId: async () => HOUSE,
        updateAgentPricingUsdc: async () => ({ ok: false, code: 'rpc_unreachable', message: 'no rpc' }),
        openEscrowV2: async () => {
          openCalled = true;
          return openOk(VAULT_PDA);
        },
      },
    );
    expect(opened.ok).toBe(false);
    // 'internal' (NOT the raw 'rpc_unreachable') so the create route's
    // PRE_BROADCAST_NO_CUSTODY classifier DELETES the phantom bounty — a tier-publish
    // failure never reaches openEscrowV2, so there is provably no vault to orphan.
    if (opened.ok === false) {
      expect(opened.code).toBe('internal');
      expect(opened.message).toContain('rpc_unreachable'); // underlying sap error preserved for diagnostics
    }
    expect(openCalled).toBe(false); // never fund a vault the create would reject
  });

  it('fails closed (no fund) when the house is not provisioned', async () => {
    const opened = await openComposedBountyEscrow(
      { bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD },
      { resolveHouseAvatarId: async () => null },
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) expect(opened.code).toBe('internal');
  });

  it('replays idempotently (same nonce ⇒ re-publish tier + the gate replays the open — no double fund)', async () => {
    let opens = 0;
    let priceUpdates = 0;
    const deps: ComposedBountyDeps = {
      resolveHouseAvatarId: async () => HOUSE,
      updateAgentPricingUsdc: async () => {
        priceUpdates += 1;
        return pricingOk();
      },
      openEscrowV2: async () => {
        opens += 1;
        // The gate's claim-first insert returns replay:true on the 2nd identical open.
        return { ok: true, phase: 'open', settlement: { escrowPda: VAULT_PDA } as any, chain: null, replay: opens > 1 };
      },
    };
    const a = await openComposedBountyEscrow({ bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD }, deps);
    const b = await openComposedBountyEscrow({ bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: REWARD }, deps);
    expect(a.ok && b.ok).toBe(true);
    // A retry re-publishes the tier (whole-menu replace is idempotent in effect) and
    // replays the escrow open — harmless, no double-fund.
    expect(priceUpdates).toBe(2);
    if (b.ok && 'replay' in b) expect(b.replay).toBe(true);
  });

  it('serializes two concurrent opens (different rewards) under the house-pricing mutex — no menu overwrite between a tier-set and its create', async () => {
    // Two DIFFERENT bounties (distinct nonce ⇒ distinct vault PDA) posted against the
    // SAME house avatar ⇒ SAME pricing mutex key. Because update_agent replaces the
    // whole menu, bounty B's tier-set must NOT land between bounty A's tier-set and
    // A's create (that would make A create at B's price ⇒ 6148). The real
    // withKeyedMutex (NOT injected) must serialize each (set → create) as a unit.
    const events: string[] = [];
    const depsFor = (label: string, vault: string, reward: number): ComposedBountyDeps => ({
      resolveHouseAvatarId: async () => HOUSE,
      updateAgentPricingUsdc: async (input) => {
        events.push(`update-${label}:${input.pricePerCall}`);
        // Yield across a real timer so a NON-serialized impl would interleave the
        // other call's tier-set here (proving the mutex actually holds).
        await new Promise((r) => setTimeout(r, 15));
        return pricingOk();
      },
      openEscrowV2: async () => {
        events.push(`open-${label}`);
        return openOk(vault);
      },
    });
    const rewardA = 50;
    const rewardB = 250;
    const [a, b] = await Promise.all([
      openComposedBountyEscrow({ bountyId: BOUNTY_ID, creatorAvatarId: CREATOR, tokenReward: rewardA }, depsFor('A', VAULT_PDA, rewardA)),
      openComposedBountyEscrow({ bountyId: BOUNTY_ID_2, creatorAvatarId: CREATOR, tokenReward: rewardB }, depsFor('B', VAULT_PDA_2, rewardB)),
    ]);
    expect(a.ok && b.ok).toBe(true);
    // Each call's create must immediately follow its OWN tier-set with nothing between
    // — i.e. the other call's update never interleaved. Adjacency proves serialization.
    const aUpdate = events.indexOf(`update-A:${usdcRewardBaseUnits(rewardA)}`);
    const aOpen = events.indexOf('open-A');
    const bUpdate = events.indexOf(`update-B:${usdcRewardBaseUnits(rewardB)}`);
    const bOpen = events.indexOf('open-B');
    expect(aUpdate).toBeGreaterThanOrEqual(0);
    expect(bUpdate).toBeGreaterThanOrEqual(0);
    expect(aOpen).toBe(aUpdate + 1); // A: set → create adjacent
    expect(bOpen).toBe(bUpdate + 1); // B: set → create adjacent
    expect(events).toHaveLength(4); // exactly two (set, create) pairs, fully serialized
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. CREATE — orphaned-vault safety (MED-1): delete ONLY on a provably
//     pre-broadcast open failure; KEEP (vault_pending) on any possible-custody code.
// ═══════════════════════════════════════════════════════════════════════════
//
// The composed CREATE route (routes/bounties.ts) inserts the bounty stamped
// composition_state='vault_pending', opens the LEG-1 vault, and on an open FAILURE
// decides delete-vs-keep off THIS exact set: a code IN the set was provably NEVER
// broadcast (no on-chain vault ⇒ nothing to orphan ⇒ safe to delete); anything NOT in
// it — 'funding_unconfirmed' (the one broadcast-unknown code) OR any unknown/new code —
// MAY have funded the vault, so the row is KEPT as vault_pending for ops reconciliation,
// NEVER deleted (a delete would orphan the creator's USDC). No pure DB/route harness
// exists in this unit file, so we lock the money-critical classification the KEEP-vs-
// DELETE branch switches on (`PRE_BROADCAST_NO_CUSTODY.has(opened.code)`).

describe('composed create — orphaned-vault safety (MED-1 classification)', () => {
  it("KEEPS the bounty on 'funding_unconfirmed' — it is NOT deletable (a possibly-funded vault is never orphaned)", () => {
    // The ONLY broadcast-unknown code openEscrowV2 returns (chain.broadcast===true but
    // the confirm never landed; the gate persisted a funding_unknown row + signature ⇒
    // the creator's USDC MAY be in the vault). Excluding it from the delete-set is the
    // fix: the row survives as vault_pending, it is not deleted.
    expect(PRE_BROADCAST_NO_CUSTODY.has('funding_unconfirmed')).toBe(false);
  });

  it('DELETES only on a provably pre-broadcast (no-custody) code — and the set is EXACTLY those codes', () => {
    // Every code openEscrowV2 (escrow-gate.ts) can return strictly BEFORE broadcasting
    // the fund tx: validation guards, wallet/PDA lookups, the ledger-insert failure, the
    // dry-run/broadcast===false passthrough (gate already deleted its own row), and the
    // self-gate short-circuits. On any of these the create may safely delete the row.
    const expected = [
      'release_rail_forbidden',
      'self_dealing_forbidden',
      'invalid_amount',
      'wallet_pubkey_missing',
      'invalid_pubkey',
      'invalid_mint',
      'internal',
      // V2 coverage-preflight rejections — return BEFORE the L1234 chain send (no custody).
      'stake_below_coverage',
      'escrow_coverage_exceeded',
      'on_chain_error',
      'sap_disabled',
      'sap_escrow_disabled',
      'sap_usdc_escrow_disabled',
      'gate_disabled',
    ];
    for (const code of expected) {
      expect(PRE_BROADCAST_NO_CUSTODY.has(code)).toBe(true);
    }
    // Completeness — no EXTRA code silently widened the delete-set. A wider set is a
    // money risk: it could delete a possibly-funded vault.
    expect(PRE_BROADCAST_NO_CUSTODY.size).toBe(expected.length);
  });

  it('FAILS CLOSED — an unknown / newly-added failure code is NOT deletable ⇒ KEEP (assume possible custody)', () => {
    expect(PRE_BROADCAST_NO_CUSTODY.has('some_future_unmapped_code')).toBe(false);
    // 'funding_unknown' is the DB row status, not the return code — must also KEEP.
    expect(PRE_BROADCAST_NO_CUSTODY.has('funding_unknown')).toBe(false);
    expect(PRE_BROADCAST_NO_CUSTODY.has('')).toBe(false);
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

  it('skips terminal states (paid / refunded)', async () => {
    for (const s of ['paid', 'refunded']) {
      const out = await resumeComposedBounty(BOUNTY_ID, { loadContext: async () => ctx({ compositionState: s }) });
      expect(out).toEqual({ resumed: false, reason: 'not_resumable' });
    }
  });

  // ── L-1: vault_held is resumable ONLY WITH an approved attempt ───────────────
  it('L-1 — RESUMES a vault_held bounty that HAS an approved attempt (the wedge self-heal), threading vault_held as the →paid CAS prior', async () => {
    // The wedge: an approve whose settle failed pre-settle left composition_state
    // 'vault_held' WITH an approved winner. loadResumeContext resolves hunterAvatarId
    // FROM the approved attempt row (the provenance guard); here that yields HUNTER.
    let applied: any = null;
    const out = await resumeComposedBounty(BOUNTY_ID, {
      loadContext: async () => ctx({ compositionState: 'vault_held', hunterAvatarId: HUNTER }),
      applyOutcome: async (input) => {
        applied = input;
        return { ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true };
      },
    } as ResumeComposedBountyDeps);
    expect(out).toEqual({ resumed: true, phase: 'paid' });
    // Winning hunter resolved from the approved attempt, NOT from any caller input.
    expect(applied.hunterAvatarId).toBe(HUNTER);
    // CAS prior threaded = the observed 'vault_held' — IDENTICAL to the approve route's
    // bookComposedBountyPaid({ expectedPriorState: 'vault_held' }), so the vault_held→paid
    // flip fires for EXACTLY ONE of {approve, sweep}; the other's CAS matches 0 rows.
    expect(applied.expectedPriorState).toBe('vault_held');
  });

  it('L-1 — NEVER touches a vault_held bounty with NO approved attempt (no_winner — a refund-path row, never settled)', async () => {
    let applyCalled = false;
    const out = await resumeComposedBounty(BOUNTY_ID, {
      loadContext: async () => ctx({ compositionState: 'vault_held', hunterAvatarId: null }),
      applyOutcome: async () => {
        applyCalled = true;
        return { ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true };
      },
    } as ResumeComposedBountyDeps);
    expect(out).toEqual({ resumed: false, reason: 'no_winner' });
    expect(applyCalled).toBe(false); // the money invariant: an unapproved vault_held bounty is NEVER settled
  });

  it('L-1 — concurrent approve + sweep cannot double-book: the sweep feeds the CAS the SAME vault_held prior the approve route uses', async () => {
    // The approve route settles a just-approved bounty synchronously with
    // bookComposedBountyPaid({ expectedPriorState: 'vault_held' }); the sweep drives the
    // SAME bounty via resumeComposedBounty. Double-book is impossible because BOTH feed the
    // atomic CAS (`WHERE composition_state='vault_held' AND != 'paid'`) the IDENTICAL prior,
    // so the vault_held→paid flip fires once. This pins the sweep's author-side prior; the
    // CAS atomicity itself lives in bookComposedBountyPaid (unchanged) + staging integration.
    const priors: string[] = [];
    const drive = () =>
      resumeComposedBounty(BOUNTY_ID, {
        loadContext: async () => ctx({ compositionState: 'vault_held', hunterAvatarId: HUNTER }),
        applyOutcome: async (input) => {
          priors.push(input.expectedPriorState);
          return { ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true };
        },
      } as ResumeComposedBountyDeps);
    await Promise.all([drive(), drive()]);
    expect(priors).toEqual(['vault_held', 'vault_held']); // == the approve route's literal
  });

  it('L-3c — a FAILED vault_held resume pages ops ONCE, deduped on the next pass (persistent-wedge alert)', async () => {
    _resetComposedWedgeAlerts(); // isolate the module-level throttle Map
    const alerts: Array<{ source: string; context: any }> = [];
    const deps = {
      loadContext: async () => ctx({ compositionState: 'vault_held', hunterAvatarId: HUNTER }),
      // The wedge: settle keeps failing PRE-settle → phase 'failed', funds still custodied.
      applyOutcome: async () =>
        ({ ok: false, phase: 'failed', escrowPda: VAULT_PDA, code: 'settle_unconfirmed', message: 'vault gone' }) as any,
      alertError: async (p: any) => {
        alerts.push({ source: p.source, context: p.context });
      },
    } as ResumeComposedBountyDeps;

    const first = await resumeComposedBounty(BOUNTY_ID, deps);
    const second = await resumeComposedBounty(BOUNTY_ID, deps); // same 5-min-cadence bounty, within the 1h window
    expect(first).toEqual({ resumed: true, phase: 'failed' });
    expect(second).toEqual({ resumed: true, phase: 'failed' });
    // Alerted EXACTLY ONCE (deduped on the second pass), with the wedge provenance.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source).toBe('bounty-composition');
    expect(alerts[0].context).toMatchObject({ bountyId: BOUNTY_ID, escrowPda: VAULT_PDA, code: 'settle_unconfirmed' });
  });

  it('L-3c — a vault_held resume that HEALS does not alert (and clears any prior throttle)', async () => {
    _resetComposedWedgeAlerts();
    let alerted = false;
    const out = await resumeComposedBounty(BOUNTY_ID, {
      loadContext: async () => ctx({ compositionState: 'vault_held', hunterAvatarId: HUNTER }),
      applyOutcome: async () =>
        ({ ok: true, phase: 'paid', escrowPda: VAULT_PDA, payoutEscrowPda: PAYOUT_PDA, auditRootHex: AUDIT_ROOT, dryRun: true }) as any,
      alertError: async () => {
        alerted = true;
      },
    } as ResumeComposedBountyDeps);
    expect(out).toEqual({ resumed: true, phase: 'paid' });
    expect(alerted).toBe(false); // a healed resume never pages
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
