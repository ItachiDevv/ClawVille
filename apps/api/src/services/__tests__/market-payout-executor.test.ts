/**
 * MARKET PAYOUT EXECUTOR — unit tests (Tokenomics GoLive executors, 2026-07-07).
 *
 * Proves the payout money discipline WITHOUT chain or Postgres (all I/O
 * through the injectable MarketPayoutDeps):
 *
 *   1. GATES: default-OFF flag + mainnet/real-facilitator network guard.
 *   2. ORDERING: deed precondition (deed first, payout second); atomic claim
 *      BEFORE custody; capture-before-send on BOTH legs.
 *   3. E5 PARITY: agent seller → custodial avatar wallet; human seller →
 *      stamped pubkey re-validated against the CURRENT linked wallet
 *      (mismatch = terminal); guest ALWAYS refused.
 *   4. CONSERVATION: exact-integer floor math; sellerClv + rakeClv ≤ Σ fills
 *      of THIS settlement's executed C3 buy — violation refuses with ZERO
 *      sends and no custody.
 *   5. EXACTLY-ONCE: double-claim refuses; ambiguous send → TERMINAL
 *      reconcile (never retried); definitive on-chain failure → reconcile;
 *      restart-after-send-before-mark RESUMES (chain-check, forward-only) and
 *      NEVER re-sends a captured signature.
 *
 * Env preamble mirrors clv-swap-live.test.ts (the module imports
 * assertMainnetRealMoneyContext from clv-swap-live → routes/ct-topup graph).
 */

// Crash-loud module-load env BEFORE imports (the ct-topup import graph).
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
delete process.env.X402_ENABLED;
delete process.env.X402_MOCK_FACILITATOR;
delete process.env.X402_FACILITATOR_PRESET;
delete process.env.X402_TOPUP_NETWORK;
delete process.env.CLV_SWAP_EXECUTE; // module-load gate on the import graph
delete process.env.MARKET_PAYOUT_EXECUTE;

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type {
  BuyQueueExecution,
  MarketPayoutDb,
  MarketPayoutDeps,
  PayoutSettlementRow,
  SellerIdentity,
} from '../market-payout-executor';

const {
  executeMarketPayout,
  resumeMarketPayout,
  runMarketPayoutTick,
  requireMarketPayoutExecution,
  parseExecutedRateToPico,
  clvAtomicForUsdMicro,
  resolveMarketRakeTreasuryPubkey,
} = await import('../market-payout-executor');

if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const SETT = '33333333-3333-4333-8333-333333333333';
const swapKp = Keypair.generate();
const agentKp = Keypair.generate(); // the agent's custodial avatar wallet
const humanKp = Keypair.generate(); // the human's proven linked wallet
const rakeKp = Keypair.generate(); // the env-pinned rake treasury
const AGENT_WALLET = agentKp.publicKey.toBase58();
const HUMAN_WALLET = humanKp.publicKey.toBase58();
const RAKE_WALLET = rakeKp.publicKey.toBase58();

// $5.00 basis at the ¢-peg 444 bps split; executed rate $0.00007/CLV.
// sellerClv = 4_778_000µ × 1e12 / 7e7 pico = 68_257_142_857 atomic (floored)
// rakeClv   =   222_000µ × 1e12 / 7e7 pico =  3_171_428_571 atomic (floored)
const RATE = '0.000070000000';
const SELLER_CLV = 68_257_142_857n;
const RAKE_CLV = 3_171_428_571n;

function settlementOf(over: Partial<PayoutSettlementRow> = {}): PayoutSettlementRow {
  return {
    id: SETT,
    listingId: 'list-1',
    sellerAvatarId: 'seller-av',
    buyerAvatarId: 'buyer-av',
    clvBuyQueueId: 'queue-1',
    sellerPayoutUsd: '4.778000',
    rakeUsd: '0.222000',
    usdBasis: '5.000000',
    payoutStatus: 'pending_review',
    sellerPayoutPubkey: AGENT_WALLET,
    deedTransferredAt: new Date(),
    payoutClaimId: null,
    payoutClaimedAt: null,
    payoutSellerTxSignature: null,
    payoutRakeTxSignature: null,
    payoutClvAtomic: null,
    payoutRakeClvAtomic: null,
    payoutExecutedRate: null,
    payoutFailureReason: null,
    ...over,
  };
}

// ── the injectable harness ───────────────────────────────────────────────────
interface Harness {
  deps: MarketPayoutDeps;
  log: string[];
  settlements: Map<string, PayoutSettlementRow & { rakeClvMeta?: string }>;
  sentRaw: Uint8Array[];
}

function makeHarness(opts: {
  settlement?: Partial<PayoutSettlementRow>;
  subjectKind?: 'user' | 'agent' | null;
  identity?: Partial<SellerIdentity>;
  buy?: Partial<BuyQueueExecution> | null;
  swapClvAtomic?: bigint;
  sendThrows?: boolean;
  confirmOutcome?: 'confirmed' | 'failed';
  sigStatus?: Record<string, 'confirmed' | 'failed' | 'not_found'>;
  sigStatusThrows?: boolean;
  stealClaimBeforeSellerCapture?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const settlements = new Map<string, PayoutSettlementRow & { rakeClvMeta?: string }>([
    [SETT, settlementOf(opts.settlement)],
  ]);
  const subjectKind = opts.subjectKind === undefined ? 'agent' : opts.subjectKind;
  const identity: SellerIdentity = {
    walletAddress: AGENT_WALLET,
    avatarIsGuest: false,
    userIsGuest: false,
    linkedWalletPubkey: HUMAN_WALLET,
    ...opts.identity,
  };
  const buy: BuyQueueExecution | null =
    opts.buy === null
      ? null
      : {
          status: 'executed',
          executedPrice: RATE,
          fills: [{ outAmountAtomic: '40000000000' }, { outAmountAtomic: '32000000000' }],
          ...opts.buy,
        };
  const sentRaw: Uint8Array[] = [];

  const dbApi: MarketPayoutDb = {
    async listEligibleSettlements(limit) {
      return [...settlements.values()]
        .filter((s) => s.payoutStatus === 'pending_review' && s.deedTransferredAt)
        .slice(0, limit)
        .map((s) => ({ ...s }));
    },
    async listStaleSending(cutoff, limit) {
      return [...settlements.values()]
        .filter(
          (s) =>
            s.payoutStatus === 'sending' &&
            s.payoutClaimedAt !== null &&
            s.payoutClaimedAt < cutoff,
        )
        .slice(0, limit)
        .map((s) => ({ ...s }));
    },
    async getSettlement(id) {
      log.push('getSettlement');
      const s = settlements.get(id);
      return s ? { ...s } : null;
    },
    async claimPayout(id, claimId) {
      log.push('claimPayout');
      const s = settlements.get(id);
      if (!s || s.payoutStatus !== 'pending_review' || !s.deedTransferredAt) return null;
      s.payoutStatus = 'sending';
      s.payoutClaimId = claimId;
      s.payoutClaimedAt = new Date();
      return { ...s };
    },
    async takeoverStaleClaim(id, claimId, cutoff) {
      log.push('takeoverStaleClaim');
      const s = settlements.get(id);
      if (
        !s ||
        s.payoutStatus !== 'sending' ||
        s.payoutClaimedAt === null ||
        s.payoutClaimedAt >= cutoff
      ) {
        return null;
      }
      s.payoutClaimId = claimId;
      s.payoutClaimedAt = new Date();
      return { ...s };
    },
    async releasePayoutClaim(id, claimId) {
      log.push('releaseClaim');
      const s = settlements.get(id);
      if (
        s &&
        s.payoutClaimId === claimId &&
        s.payoutStatus === 'sending' &&
        s.payoutSellerTxSignature === null
      ) {
        s.payoutStatus = 'pending_review';
        s.payoutClaimId = null;
        s.payoutClaimedAt = null;
      }
    },
    async captureSellerSignature(id, claimId, signature, sellerClvAtomic, executedRate) {
      log.push('captureSeller');
      const s = settlements.get(id);
      if (opts.stealClaimBeforeSellerCapture) return false;
      if (
        !s ||
        s.payoutClaimId !== claimId ||
        s.payoutStatus !== 'sending' ||
        s.payoutSellerTxSignature !== null
      ) {
        return false;
      }
      s.payoutSellerTxSignature = signature;
      s.payoutClvAtomic = sellerClvAtomic;
      s.payoutExecutedRate = executedRate;
      return true;
    },
    async captureRakeSignature(id, claimId, signature, rakeClvAtomic) {
      log.push('captureRake');
      const s = settlements.get(id);
      if (
        !s ||
        s.payoutClaimId !== claimId ||
        s.payoutStatus !== 'sending' ||
        s.payoutRakeTxSignature !== null
      ) {
        return false;
      }
      s.payoutRakeTxSignature = signature;
      s.rakeClvMeta = rakeClvAtomic;
      // Mirrors the real defaultDb, which merges the amount into the row's
      // jsonb metadata (surfaced back as payoutRakeClvAtomic by toPayoutRow).
      s.payoutRakeClvAtomic = rakeClvAtomic;
      return true;
    },
    async markPaid(id, claimId) {
      log.push('markPaid');
      const s = settlements.get(id);
      if (!s || s.payoutClaimId !== claimId || s.payoutStatus !== 'sending') return false;
      s.payoutStatus = 'paid';
      return true;
    },
    async markReconcile(id, claimId, reason) {
      log.push('markReconcile');
      const s = settlements.get(id);
      if (s && s.payoutClaimId === claimId && s.payoutStatus === 'sending') {
        s.payoutStatus = 'reconcile';
        s.payoutFailureReason = reason;
      }
    },
    async getListingPayoutContext(_listingId) {
      log.push('getListingContext');
      return {
        itemKind: 'land_deed',
        sellerSubjectKind: subjectKind,
        sellerWalletPubkey: settlements.get(SETT)?.sellerPayoutPubkey ?? null,
      };
    },
    async getSellerIdentity(_avatarId) {
      log.push('getSellerIdentity');
      return { ...identity };
    },
    async getBuyQueueExecution(_queueId) {
      log.push('getBuyQueue');
      return buy ? { ...buy, fills: buy.fills ? buy.fills.map((f) => ({ ...f })) : buy.fills } : null;
    },
  };

  const fakeConn = {
    getLatestBlockhash: async () => ({
      blockhash: bs58.encode(new Uint8Array(32).fill(7)),
      lastValidBlockHeight: 500,
    }),
  } as unknown as Connection;

  const deps: MarketPayoutDeps = {
    db: dbApi,
    loadSwapKeypair: async () => {
      log.push('loadSwapKeypair');
      return swapKp;
    },
    connection: () => fakeConn,
    readTokenBalance: async () => {
      log.push('readBalance');
      return { amountAtomic: opts.swapClvAtomic ?? 1_000_000_000_000n };
    },
    sendRawTransaction: async (_conn, raw) => {
      log.push('sendRaw');
      if (opts.sendThrows) throw new Error('boom: transport died mid-send');
      sentRaw.push(raw);
      return 'rpc-echo-sig';
    },
    confirmTransaction: async () => {
      log.push('confirm');
      return opts.confirmOutcome ?? 'confirmed';
    },
    getSignatureStatus: async (_conn, signature) => {
      log.push('sigStatus');
      if (opts.sigStatusThrows) throw new Error('boom: rpc status check died');
      return opts.sigStatus?.[signature] ?? 'not_found';
    },
  };

  return { deps, log, settlements, sentRaw };
}

beforeEach(() => {
  process.env.MARKET_PAYOUT_EXECUTE = 'true';
  process.env.X402_TOPUP_NETWORK = 'mainnet';
  process.env.X402_FACILITATOR_PRESET = 'payai';
  process.env.MARKET_RAKE_TREASURY_PUBKEY = RAKE_WALLET;
  delete process.env.X402_MOCK_FACILITATOR;
  delete process.env.MARKET_PAYOUT_STALE_MS;
});

afterAll(() => {
  delete process.env.MARKET_PAYOUT_EXECUTE;
  delete process.env.X402_TOPUP_NETWORK;
  delete process.env.X402_FACILITATOR_PRESET;
  delete process.env.MARKET_RAKE_TREASURY_PUBKEY;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GATES — the executor is dark by default', () => {
  it('every entrypoint refuses when MARKET_PAYOUT_EXECUTE is not "true"', async () => {
    delete process.env.MARKET_PAYOUT_EXECUTE;
    const h = makeHarness();
    expect(() => requireMarketPayoutExecution()).toThrow(/DARK/);
    await expect(executeMarketPayout(SETT, h.deps)).rejects.toThrow(/DARK/);
    await expect(resumeMarketPayout(SETT, h.deps)).rejects.toThrow(/DARK/);
    await expect(runMarketPayoutTick(h.deps)).rejects.toThrow(/DARK/);
    expect(h.log.length).toBe(0);
  });

  it('NETWORK GUARD: devnet/mock can never reach a real CLV send', async () => {
    const h = makeHarness();
    process.env.X402_TOPUP_NETWORK = 'devnet';
    await expect(executeMarketPayout(SETT, h.deps)).rejects.toThrow(/mainnet-only/);
    process.env.X402_TOPUP_NETWORK = 'mainnet';
    process.env.X402_MOCK_FACILITATOR = 'true';
    await expect(executeMarketPayout(SETT, h.deps)).rejects.toThrow(/MOCK x402 facilitator/);
    expect(h.log.length).toBe(0);
  });

  it('rake treasury pin: unset env resolves null (fail closed)', () => {
    delete process.env.MARKET_RAKE_TREASURY_PUBKEY;
    expect(resolveMarketRakeTreasuryPubkey()).toBeNull();
    process.env.MARKET_RAKE_TREASURY_PUBKEY = 'not-base58!!!';
    expect(resolveMarketRakeTreasuryPubkey()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ORDERING — deed first; claim before custody; capture before send', () => {
  it('DEED PRECONDITION: an untransferred deed refuses with NO claim taken', async () => {
    const h = makeHarness({ settlement: { deedTransferredAt: null } });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'deed_not_transferred' });
    expect(h.log).not.toContain('claimPayout');
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('pending_review');
  });

  it('HAPPY PATH (agent seller): claim → resolve → custody → capture → send ×2 → paid', async () => {
    const h = makeHarness({ subjectKind: 'agent' });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.replay).toBe(false);
    expect(res.sellerDestination).toBe(AGENT_WALLET); // E5: the agent's custodial wallet
    expect(res.rakeDestination).toBe(RAKE_WALLET);
    expect(res.sellerClvAtomic).toBe(SELLER_CLV.toString());
    expect(res.rakeClvAtomic).toBe(RAKE_CLV.toString());

    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('paid');
    expect(s.payoutClvAtomic).toBe(SELLER_CLV.toString());
    expect(s.payoutExecutedRate).toBe(RATE);
    expect(s.rakeClvMeta).toBe(RAKE_CLV.toString());
    expect(typeof s.payoutSellerTxSignature).toBe('string');
    expect(typeof s.payoutRakeTxSignature).toBe('string');
    expect(s.payoutSellerTxSignature).not.toBe(s.payoutRakeTxSignature);

    // ORDERING: claim precedes custody; each leg's capture precedes its send.
    const idx = (name: string) => h.log.indexOf(name);
    expect(idx('claimPayout')).toBeLessThan(idx('loadSwapKeypair'));
    const captures = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'captureSeller' || l === 'captureRake')
      .map(([, i]) => i);
    const sends = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'sendRaw')
      .map(([, i]) => i);
    expect(captures.length).toBe(2);
    expect(sends.length).toBe(2);
    expect(captures[0]).toBeLessThan(sends[0]);
    expect(captures[1]).toBeLessThan(sends[1]);
    // Seller leg confirmed BEFORE the rake leg starts.
    expect(h.log.indexOf('captureRake')).toBeGreaterThan(h.log.indexOf('confirm'));
  });

  it('replay: a paid settlement replays idempotently (no claim, no sends)', async () => {
    const h = makeHarness({ subjectKind: 'agent' });
    const first = await executeMarketPayout(SETT, h.deps);
    expect(first.ok).toBe(true);
    const sendsAfterFirst = h.log.filter((l) => l === 'sendRaw').length;

    const second = await executeMarketPayout(SETT, h.deps);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.replay).toBe(true);
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(sendsAfterFirst);
    // The replay reports the REAL captured rake (durable metadata stamp) —
    // not a hardcoded '0' (2026-07-08, Codex re-review).
    expect(second.rakeClvAtomic).toBe(RAKE_CLV.toString());
    expect(second.sellerClvAtomic).toBe(SELLER_CLV.toString());
  });

  it('DOUBLE-CLAIM: a row already in "sending" refuses (payout_in_flight)', async () => {
    const h = makeHarness({
      settlement: { payoutStatus: 'sending', payoutClaimId: 'live', payoutClaimedAt: new Date() },
    });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'payout_in_flight' });
    expect(h.log).not.toContain('loadSwapKeypair');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E5 PARITY — the destination branch must exist; guests never paid', () => {
  it('HUMAN seller: stamped pubkey re-validated against the CURRENT linked wallet', async () => {
    const h = makeHarness({
      subjectKind: 'user',
      settlement: { sellerPayoutPubkey: HUMAN_WALLET },
      identity: { linkedWalletPubkey: HUMAN_WALLET },
    });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.sellerDestination).toBe(HUMAN_WALLET);
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('paid');
  });

  it('HUMAN mismatch (re-linked wallet): TERMINAL reconcile, zero custody/sends', async () => {
    const h = makeHarness({
      subjectKind: 'user',
      settlement: { sellerPayoutPubkey: HUMAN_WALLET },
      identity: { linkedWalletPubkey: Keypair.generate().publicKey.toBase58() },
    });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'payout_destination_mismatch' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('reconcile');
    expect(s.payoutFailureReason).toBe('human_linked_wallet_mismatch');
    expect(h.log).not.toContain('loadSwapKeypair');
    expect(h.log).not.toContain('sendRaw');
  });

  it('AGENT with no custodial wallet: TERMINAL (destination missing)', async () => {
    const h = makeHarness({ subjectKind: 'agent', identity: { walletAddress: null } });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'payout_destination_missing' });
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('reconcile');
    expect(h.log).not.toContain('sendRaw');
  });

  it('GUEST seller is ALWAYS refused — terminal, loud, zero sends', async () => {
    for (const identity of [{ avatarIsGuest: true }, { userIsGuest: true }]) {
      const h = makeHarness({ identity });
      const res = await executeMarketPayout(SETT, h.deps);
      expect(res).toMatchObject({ ok: false, code: 'guest_seller_refused' });
      const s = h.settlements.get(SETT)!;
      expect(s.payoutStatus).toBe('reconcile');
      expect(s.payoutFailureReason).toBe('guest_seller_refused');
      expect(h.log).not.toContain('loadSwapKeypair');
      expect(h.log).not.toContain('sendRaw');
    }
  });

  it('unresolvable seller subject kind: TERMINAL (never guess the branch)', async () => {
    const h = makeHarness({ subjectKind: null });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'seller_subject_unresolvable' });
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('reconcile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CONSERVATION — never pay CLV that was not bought', () => {
  it('exact-integer floor math (house-favorable)', () => {
    expect(parseExecutedRateToPico(RATE)).toBe(70_000_000n);
    expect(parseExecutedRateToPico('1.5')).toBe(1_500_000_000_000n);
    expect(parseExecutedRateToPico('0')).toBeNull();
    expect(parseExecutedRateToPico('0.000000000000')).toBeNull();
    expect(parseExecutedRateToPico('abc')).toBeNull();
    expect(parseExecutedRateToPico('-1')).toBeNull();

    expect(clvAtomicForUsdMicro(4_778_000n, 70_000_000n)).toBe(SELLER_CLV);
    expect(clvAtomicForUsdMicro(222_000n, 70_000_000n)).toBe(RAKE_CLV);
    // FLOOR: $0.000001 at $3/CLV would be 0.33 atomic → floors to 0.
    expect(clvAtomicForUsdMicro(1n, 3_000_000_000_000n)).toBe(0n);
  });

  it('seller+rake exceeding the recorded fills: TERMINAL, zero custody, zero sends', async () => {
    const h = makeHarness({ buy: { fills: [{ outAmountAtomic: '1000' }] } });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'conservation_violated' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('reconcile');
    expect(s.payoutFailureReason).toBe('conservation_violated');
    expect(h.log).not.toContain('loadSwapKeypair');
    expect(h.log).not.toContain('sendRaw');
  });

  it('C3 buy not executed yet: claim RELEASED for a clean later retry', async () => {
    const h = makeHarness({ buy: { status: 'planned', executedPrice: null } });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'clv_buy_not_executed' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('pending_review'); // released, retryable
    expect(s.payoutClaimId).toBeNull();
  });

  it('no recorded fills: TERMINAL (the buy cannot prove what it bought)', async () => {
    const h = makeHarness({ buy: { fills: [] } });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'no_recorded_fills' });
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('reconcile');
  });

  it('ZERO rake (rake_bps 0): one send only, rakeTxSignature null, paid', async () => {
    const h = makeHarness({
      settlement: { rakeUsd: '0.000000', sellerPayoutUsd: '5.000000' },
    });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.rakeTxSignature).toBeNull();
    expect(res.rakeDestination).toBeNull();
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('paid');
  });

  it('insufficient swap-wallet CLV: claim released PRE-capture (retry once funded)', async () => {
    const h = makeHarness({ swapClvAtomic: 10n });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'insufficient_swap_wallet_clv' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('pending_review');
    expect(h.log).not.toContain('captureSeller');
    expect(h.log).not.toContain('sendRaw');
  });

  it('rake treasury unpinned: claim released BEFORE custody (fail closed)', async () => {
    delete process.env.MARKET_RAKE_TREASURY_PUBKEY;
    const h = makeHarness();
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'rake_treasury_unpinned' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('pending_review');
    expect(h.log).not.toContain('loadSwapKeypair');
    expect(h.log).not.toContain('sendRaw');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('EXACTLY-ONCE — ambiguous never retried; resume never re-sends', () => {
  it('AMBIGUOUS seller send: signature captured, TERMINAL reconcile, retry refused', async () => {
    const h = makeHarness({ sendThrows: true });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'send_ambiguous', detail: 'seller_send' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('reconcile');
    expect(s.payoutFailureReason).toBe('seller_send_ambiguous');
    expect(typeof s.payoutSellerTxSignature).toBe('string'); // durable BEFORE send
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);

    // A retry finds the terminal row — no second send attempt, ever.
    const res2 = await executeMarketPayout(SETT, h.deps);
    expect(res2).toMatchObject({ ok: false, code: 'payout_terminal' });
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
  });

  it('DEFINITIVE seller on-chain failure: reconcile (no CLV moved), never auto-retried', async () => {
    const h = makeHarness({ confirmOutcome: 'failed' });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'seller_tx_failed' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('reconcile');
    expect(s.payoutFailureReason).toBe('seller_tx_failed_on_chain');
  });

  it('capture lost (claim stolen): abort WITHOUT sending', async () => {
    const h = makeHarness({ stealClaimBeforeSellerCapture: true });
    const res = await executeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'capture_lost', detail: 'seller' });
    expect(h.log).not.toContain('sendRaw');
  });

  it('RESTART-AFTER-SEND-BEFORE-MARK: seller sig confirmed on chain → RESUME runs ONLY the rake leg (no re-send)', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const h = makeHarness({
      settlement: {
        payoutStatus: 'sending',
        payoutClaimId: 'dead-claim',
        payoutClaimedAt: stale,
        payoutSellerTxSignature: 'seller-sig-1',
        payoutClvAtomic: SELLER_CLV.toString(),
        payoutExecutedRate: RATE,
      },
      sigStatus: { 'seller-sig-1': 'confirmed' },
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.resumed).toBe(true);
    expect(res.sellerTxSignature).toBe('seller-sig-1'); // the ORIGINAL capture
    expect(res.rakeClvAtomic).toBe(RAKE_CLV.toString()); // recomputed at the STAMPED rate

    // THE keystone: exactly ONE send happened — the rake. The seller leg was
    // proven on chain and NEVER re-sent.
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('paid');
    expect(s.payoutSellerTxSignature).toBe('seller-sig-1');
    expect(typeof s.payoutRakeTxSignature).toBe('string');
  });

  it('resume with BOTH signatures confirmed: mark paid with ZERO sends', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const h = makeHarness({
      settlement: {
        payoutStatus: 'sending',
        payoutClaimId: 'dead-claim',
        payoutClaimedAt: stale,
        payoutSellerTxSignature: 'seller-sig-1',
        payoutRakeTxSignature: 'rake-sig-1',
        payoutClvAtomic: SELLER_CLV.toString(),
        payoutRakeClvAtomic: RAKE_CLV.toString(), // the durable metadata stamp
        payoutExecutedRate: RATE,
      },
      sigStatus: { 'rake-sig-1': 'confirmed' },
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(0);
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('paid');
    // Case-A reporting surfaces the REAL captured rake, not a hardcoded '0'.
    expect(res.rakeClvAtomic).toBe(RAKE_CLV.toString());
    expect(res.sellerClvAtomic).toBe(SELLER_CLV.toString());
  });

  it('resume with a captured sig NOT provable on chain: TERMINAL reconcile, no re-send', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const h = makeHarness({
      settlement: {
        payoutStatus: 'sending',
        payoutClaimId: 'dead-claim',
        payoutClaimedAt: stale,
        payoutSellerTxSignature: 'seller-sig-1',
        payoutClvAtomic: SELLER_CLV.toString(),
        payoutExecutedRate: RATE,
      },
      sigStatus: { 'seller-sig-1': 'not_found' },
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'resume_unresolved' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('reconcile');
    expect(s.payoutFailureReason).toBe('seller_resume_unresolved');
    expect(h.log).not.toContain('sendRaw');
  });

  it('resume with NOTHING captured: nothing was sent → clean release for re-claim', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const h = makeHarness({
      settlement: { payoutStatus: 'sending', payoutClaimId: 'dead-claim', payoutClaimedAt: stale },
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'released_for_retry' });
    const s = h.settlements.get(SETT)!;
    expect(s.payoutStatus).toBe('pending_review');
    expect(s.payoutClaimId).toBeNull();
    expect(h.log).not.toContain('sendRaw');
  });

  it('resume never steals a LIVE claim (fresh payout_claimed_at → in_flight)', async () => {
    const h = makeHarness({
      settlement: {
        payoutStatus: 'sending',
        payoutClaimId: 'live-claim',
        payoutClaimedAt: new Date(),
        payoutSellerTxSignature: 'seller-sig-1',
      },
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'payout_in_flight' });
    expect(h.log).not.toContain('sigStatus');
  });

  it('resume chain-check transport error: transient — row stays "sending" for later', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const h = makeHarness({
      settlement: {
        payoutStatus: 'sending',
        payoutClaimId: 'dead-claim',
        payoutClaimedAt: stale,
        payoutSellerTxSignature: 'seller-sig-1',
      },
      sigStatusThrows: true,
    });
    const res = await resumeMarketPayout(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'resume_transient' });
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('sending');
    expect(h.log).not.toContain('sendRaw');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('runMarketPayoutTick — resume stale, then execute fresh', () => {
  it('a fresh eligible settlement executes end-to-end in one tick', async () => {
    const h = makeHarness({ subjectKind: 'agent' });
    const out = await runMarketPayoutTick(h.deps);
    expect(out.length).toBe(1);
    expect(out[0].result.ok).toBe(true);
    expect(h.settlements.get(SETT)!.payoutStatus).toBe('paid');
  });

  it('deed-untransferred settlements are NOT eligible (structurally unpayable)', async () => {
    const h = makeHarness({ settlement: { deedTransferredAt: null } });
    const out = await runMarketPayoutTick(h.deps);
    expect(out.length).toBe(0);
    expect(h.log).not.toContain('claimPayout');
  });
});
