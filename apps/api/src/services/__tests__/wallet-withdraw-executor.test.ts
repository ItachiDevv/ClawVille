/**
 * CUSTODIAL WALLET WITHDRAW EXECUTOR — unit tests (2026-07-08).
 *
 * Proves the withdraw money discipline WITHOUT chain or Postgres (all I/O
 * through the injectable WalletWithdrawDeps):
 *
 *   1. GATES: default-OFF flag + the mainnet network guard (devnet/testnet/
 *      localhost connections can never reach a send).
 *   2. VALIDATION (before any claim/sign): positive-integer amounts (BigInt,
 *      u64-bounded), base58 32-byte ON-CURVE destinations (PDAs refused),
 *      self-send refused, balance + fee/rent headroom (SOL source never
 *      drains below rent-exempt + fee; token sends reserve dest-ATA rent),
 *      fail-CLOSED on balance-read failure, per-asset daily caps.
 *   3. EXACTLY-ONCE: idempotency replay (a retried key can NEVER create a
 *      second withdrawal); atomic double-claim refuses; CAPTURE-BEFORE-SEND
 *      ordering; ambiguous send/confirm → TERMINAL reconcile (never
 *      re-sent); definitive on-chain failure → 'failed'; resume is
 *      FORWARD-ONLY (confirmed→sent / failed→failed / not_found→reconcile /
 *      nothing-captured→release) and never re-signs a captured signature.
 *   4. ASSETS: SOL SystemProgram.transfer; USDC classic-SPL TransferChecked;
 *      CLV Token-2022 TransferChecked; idempotent dest-ATA create.
 *   5. E5 PARITY: agent subjects withdraw from THEIR avatar wallet; non-ledger
 *      agent sessions refused; route wires the guest gate (source-verified).
 *
 * Env preamble mirrors market-payout-executor.test.ts (the module imports
 * clv-swap-custody → clv-swap-executor / x402 config graph).
 */

// Crash-loud module-load env BEFORE imports (the x402/custody import graph).
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
delete process.env.WALLET_WITHDRAW_ENABLED;
delete process.env.WALLET_WITHDRAW_DAILY_CAP_SOL;
delete process.env.WALLET_WITHDRAW_DAILY_CAP_USDC;
delete process.env.WALLET_WITHDRAW_DAILY_CAP_CLV;

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { WithdrawalRow } from '@clawville/database';
import type {
  WalletWithdrawDb,
  WalletWithdrawDeps,
  WithdrawAsset,
  WithdrawSubject,
} from '../wallet-withdraw-executor';

const {
  requestWithdrawal,
  resumeWithdrawal,
  runWithdrawResumeTick,
  requireWalletWithdrawEnabled,
  assertMainnetWithdrawConnection,
  validateWithdrawStatic,
  resolveWithdrawSubject,
  parseUiAmountToAtomic,
  resolveWithdrawDailyCapAtomic,
  getCustodialWalletBalances,
  WalletWithdrawCustodyError,
  WITHDRAW_TX_FEE_LAMPORTS,
} = await import('../wallet-withdraw-executor');

if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const sourceKp = Keypair.generate(); // the avatar's custodial wallet
const destKp = Keypair.generate(); // the self-custody destination
const SOURCE = sourceKp.publicKey.toBase58();
const DEST = destKp.publicKey.toBase58();
const AVATAR = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const RENT_MIN_0 = 890_880n; // rent-exempt minimum, 0-byte system account
const ATA_RENT = 2_039_280n; // rent-exempt minimum, 165-byte token account
const FEE = WITHDRAW_TX_FEE_LAMPORTS; // 5_000n

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const userSubject: WithdrawSubject = { avatarId: AVATAR, userId: USER, kind: 'user', agentId: null };
const agentSubject: WithdrawSubject = {
  avatarId: AVATAR,
  userId: USER,
  kind: 'agent',
  agentId: 'agent-1',
};

/** A guaranteed OFF-CURVE address (a PDA) — assets sent there are unspendable. */
function offCurveAddress(): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('withdraw-test')],
    new PublicKey(TOKEN_PROGRAM),
  );
  return pda.toBase58();
}

// ── the injectable harness ───────────────────────────────────────────────────
interface HarnessOpts {
  rows?: Array<Partial<WithdrawalRow> & { id: string }>;
  walletPubkey?: string | null;
  solBalance?: bigint;
  tokenBalance?: bigint;
  destAtaExists?: boolean;
  solBalanceThrows?: boolean;
  blockhashThrows?: boolean;
  sendThrows?: boolean;
  confirmThrows?: boolean;
  confirmOutcome?: 'confirmed' | 'failed';
  sigStatus?: 'confirmed' | 'failed' | 'not_found';
  sigStatusThrows?: boolean;
  stealClaim?: boolean;
  stealCapture?: boolean;
  captureSigConflict?: boolean;
  loadKeypairThrows?: Error;
  endpoint?: string;
}

interface Harness {
  deps: WalletWithdrawDeps;
  log: string[];
  rows: Map<string, WithdrawalRow>;
  sentRaw: Uint8Array[];
}

function rowOf(over: Partial<WithdrawalRow> & { id: string }): WithdrawalRow {
  return {
    subjectType: 'user',
    avatarId: AVATAR,
    userId: USER,
    asset: 'SOL',
    amountAtomic: '1000000000',
    destination: DEST,
    status: 'pending',
    txSignature: null,
    claimId: null,
    claimedAt: null,
    sentAt: null,
    failureReason: null,
    idempotencyKey: 'key-seeded-000',
    network: 'mainnet',
    metadata: {},
    createdAt: new Date(),
    ...over,
  } as WithdrawalRow;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const log: string[] = [];
  const rows = new Map<string, WithdrawalRow>();
  for (const r of opts.rows ?? []) rows.set(r.id, rowOf(r));
  const sentRaw: Uint8Array[] = [];
  const walletPubkey = opts.walletPubkey === undefined ? SOURCE : opts.walletPubkey;

  const dbApi: WalletWithdrawDb = {
    async getWalletPubkey() {
      log.push('getWalletPubkey');
      return walletPubkey;
    },
    async insertWithdrawal(input) {
      log.push('insert');
      for (const r of rows.values()) {
        if (
          r.idempotencyKey === input.idempotencyKey &&
          r.subjectType === input.subjectType &&
          r.avatarId === input.avatarId
        ) {
          return null; // the partial-UNIQUE
        }
      }
      const row = rowOf({
        id: randomUUID(),
        subjectType: input.subjectType,
        avatarId: input.avatarId,
        userId: input.userId,
        asset: input.asset,
        amountAtomic: input.amountAtomic,
        destination: input.destination,
        idempotencyKey: input.idempotencyKey,
        network: input.network,
        metadata: input.metadata,
      });
      rows.set(row.id, row);
      return { ...row };
    },
    async findById(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async findByIdempotencyKey(subjectType, avatarId, key) {
      log.push('findByIdem');
      for (const r of rows.values()) {
        if (r.subjectType === subjectType && r.avatarId === avatarId && r.idempotencyKey === key) {
          return { ...r };
        }
      }
      return null;
    },
    async claimPending(id, claimId) {
      log.push('claim');
      if (opts.stealClaim) return null;
      const r = rows.get(id);
      if (!r || r.status !== 'pending') return null;
      r.status = 'sending';
      r.claimId = claimId;
      r.claimedAt = new Date();
      return { ...r };
    },
    async takeoverStaleClaim(id, claimId, cutoff) {
      log.push('takeover');
      const r = rows.get(id);
      if (!r || r.status !== 'sending' || r.claimedAt === null || r.claimedAt >= cutoff) {
        return null;
      }
      r.claimId = claimId;
      r.claimedAt = new Date();
      return { ...r };
    },
    async releaseClaim(id, claimId) {
      log.push('release');
      const r = rows.get(id);
      if (r && r.claimId === claimId && r.status === 'sending' && r.txSignature === null) {
        r.status = 'pending';
        r.claimId = null;
        r.claimedAt = null;
      }
    },
    async captureSignature(id, claimId, signature) {
      log.push('capture');
      if (opts.captureSigConflict) return 'sig_conflict';
      if (opts.stealCapture) return 'lost';
      const r = rows.get(id);
      if (!r || r.claimId !== claimId || r.status !== 'sending' || r.txSignature !== null) {
        return 'lost';
      }
      r.txSignature = signature;
      return 'captured';
    },
    async markSent(id, claimId) {
      log.push('markSent');
      const r = rows.get(id);
      if (!r || r.claimId !== claimId || r.status !== 'sending') return false;
      r.status = 'sent';
      r.sentAt = new Date();
      return true;
    },
    async markFailed(id, claimId, reason) {
      log.push('markFailed');
      const r = rows.get(id);
      if (r && r.claimId === claimId && r.status === 'sending') {
        r.status = 'failed';
        r.failureReason = reason;
      }
    },
    async markPendingFailed(id, reason) {
      log.push('markPendingFailed');
      const r = rows.get(id);
      if (r && r.status === 'pending' && r.txSignature === null) {
        r.status = 'failed';
        r.failureReason = reason;
      }
    },
    async markReconcile(id, claimId, reason) {
      log.push('markReconcile');
      const r = rows.get(id);
      if (r && r.claimId === claimId && r.status === 'sending') {
        r.status = 'reconcile';
        r.failureReason = reason;
      }
    },
    async sumSinceAtomic(avatarId, asset, since) {
      log.push('sumSince');
      let total = 0n;
      for (const r of rows.values()) {
        if (
          r.avatarId === avatarId &&
          r.asset === asset &&
          ['pending', 'sending', 'sent'].includes(r.status) &&
          r.createdAt >= since
        ) {
          total += BigInt(r.amountAtomic);
        }
      }
      return total;
    },
    async listStaleSending(cutoff, limit) {
      return [...rows.values()]
        .filter((r) => r.status === 'sending' && r.claimedAt !== null && r.claimedAt < cutoff)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
  };

  const fakeConn = {
    rpcEndpoint: opts.endpoint ?? 'https://api.mainnet-beta.solana.com',
  } as unknown as Connection;

  const deps: WalletWithdrawDeps = {
    db: dbApi,
    loadKeypair: async () => {
      log.push('loadKeypair');
      if (opts.loadKeypairThrows) throw opts.loadKeypairThrows;
      return sourceKp;
    },
    connection: () => fakeConn,
    getLatestBlockhash: async () => {
      log.push('blockhash');
      if (opts.blockhashThrows) throw new Error('boom: rpc blockhash died');
      return { blockhash: bs58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 999 };
    },
    getSolBalance: async () => {
      log.push('solBalance');
      if (opts.solBalanceThrows) throw new Error('boom: rpc balance died');
      return opts.solBalance ?? 10_000_000_000n; // 10 SOL default
    },
    getTokenBalance: async () => {
      log.push('tokenBalance');
      return { amountAtomic: opts.tokenBalance ?? 1_000_000_000n };
    },
    getAccountExists: async () => {
      log.push('ataProbe');
      return opts.destAtaExists ?? true;
    },
    getRentExemptMinimum: async (_conn, bytes) => (bytes === 0 ? RENT_MIN_0 : ATA_RENT),
    sendRawTransaction: async (_conn, raw) => {
      log.push('sendRaw');
      if (opts.sendThrows) throw new Error('boom: transport died mid-send');
      sentRaw.push(raw);
      return 'rpc-echo-sig';
    },
    confirmTransaction: async () => {
      log.push('confirm');
      if (opts.confirmThrows) throw new Error('boom: confirm died');
      return opts.confirmOutcome ?? 'confirmed';
    },
    getSignatureStatus: async () => {
      log.push('sigStatus');
      if (opts.sigStatusThrows) throw new Error('boom: rpc status check died');
      return opts.sigStatus ?? 'not_found';
    },
  };

  return { deps, log, rows, sentRaw };
}

function requestOf(over: Partial<{ subject: WithdrawSubject; asset: WithdrawAsset; amountAtomic: string; destination: string; idempotencyKey: string }> = {}) {
  return {
    subject: userSubject,
    asset: 'SOL' as WithdrawAsset,
    amountAtomic: '1000000000', // 1 SOL
    destination: DEST,
    idempotencyKey: 'key-abc-12345678',
    ...over,
  };
}

beforeEach(() => {
  process.env.WALLET_WITHDRAW_ENABLED = 'true';
  delete process.env.WALLET_WITHDRAW_DAILY_CAP_SOL;
  delete process.env.WALLET_WITHDRAW_DAILY_CAP_USDC;
  delete process.env.WALLET_WITHDRAW_DAILY_CAP_CLV;
  delete process.env.WALLET_WITHDRAW_STALE_MS;
});

afterAll(() => {
  delete process.env.WALLET_WITHDRAW_ENABLED;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GATES — dark by default; mainnet-only', () => {
  it('flag OFF: every entrypoint refuses with a clean typed withdraw_disabled', async () => {
    delete process.env.WALLET_WITHDRAW_ENABLED;
    const h = makeHarness();
    expect(() => requireWalletWithdrawEnabled()).toThrow(/DARK/);
    expect(await requestWithdrawal(requestOf(), h.deps)).toMatchObject({
      ok: false,
      code: 'withdraw_disabled',
    });
    expect(await resumeWithdrawal(randomUUID(), h.deps)).toMatchObject({
      ok: false,
      code: 'withdraw_disabled',
    });
    expect(await runWithdrawResumeTick(h.deps)).toEqual([]);
    expect(h.log.length).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it('NETWORK GUARD: devnet/testnet/localhost endpoints can never reach a send', async () => {
    for (const endpoint of [
      'https://api.devnet.solana.com',
      'https://api.testnet.solana.com',
      'http://localhost:8899',
      'http://127.0.0.1:8899/mainnet', // negative pattern wins even with "mainnet" in the path
    ]) {
      const h = makeHarness({ endpoint });
      await expect(requestWithdrawal(requestOf(), h.deps)).rejects.toThrow(/NETWORK GUARD/);
      expect(h.log).not.toContain('insert');
      expect(h.log).not.toContain('claim');
      expect(h.sentRaw.length).toBe(0);
    }
    expect(() =>
      assertMainnetWithdrawConnection({
        rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=x',
      } as unknown as Connection),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('VALIDATION — before any claim/sign; nothing persisted on refusal', () => {
  it('amounts: zero / non-integer / over-u64 refused as amount_invalid', async () => {
    for (const amountAtomic of ['0', '00']) {
      const h = makeHarness();
      expect(await requestWithdrawal(requestOf({ amountAtomic }), h.deps)).toMatchObject({
        ok: false,
        code: 'amount_invalid',
      });
      expect(h.rows.size).toBe(0);
    }
    // static validator directly (the route zod blocks these shapes earlier)
    expect(
      validateWithdrawStatic({ amountAtomic: '1.5', destination: DEST, sourcePubkey: SOURCE }),
    ).toMatchObject({ ok: false, code: 'amount_invalid' });
    expect(
      validateWithdrawStatic({ amountAtomic: '-5', destination: DEST, sourcePubkey: SOURCE }),
    ).toMatchObject({ ok: false, code: 'amount_invalid' });
    expect(
      validateWithdrawStatic({
        amountAtomic: '18446744073709551616', // u64max + 1
        destination: DEST,
        sourcePubkey: SOURCE,
      }),
    ).toMatchObject({ ok: false, code: 'amount_invalid', detail: 'exceeds_u64' });
  });

  it('destination: non-base58 / wrong length / OFF-CURVE (PDA) refused', async () => {
    const bad = [
      { destination: 'IIIIOOOO0000llll!!!!not-base58-at-all-xx', detail: 'not_base58' },
      { destination: bs58.encode(new Uint8Array(16).fill(3)), detail: 'not_32_bytes' },
      { destination: offCurveAddress(), detail: 'off_curve' },
    ];
    for (const { destination, detail } of bad) {
      const h = makeHarness();
      expect(await requestWithdrawal(requestOf({ destination }), h.deps)).toMatchObject({
        ok: false,
        code: 'invalid_destination',
        detail,
      });
      expect(h.rows.size).toBe(0);
      expect(h.sentRaw.length).toBe(0);
    }
  });

  it('self-send: destination == the caller custodial wallet refused', async () => {
    const h = makeHarness();
    expect(await requestWithdrawal(requestOf({ destination: SOURCE }), h.deps)).toMatchObject({
      ok: false,
      code: 'self_send',
    });
    expect(h.rows.size).toBe(0);
  });

  it('missing custodial wallet row: wallet_missing', async () => {
    const h = makeHarness({ walletPubkey: null });
    expect(await requestWithdrawal(requestOf(), h.deps)).toMatchObject({
      ok: false,
      code: 'wallet_missing',
    });
    expect(h.rows.size).toBe(0);
  });

  it('SOL over-balance: insufficient_balance', async () => {
    const h = makeHarness({ solBalance: 999_999_999n });
    expect(
      await requestWithdrawal(requestOf({ amountAtomic: '1000000000' }), h.deps),
    ).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(h.rows.size).toBe(0);
  });

  it('SOL rent-exempt + fee headroom: the source is NEVER drained below it', async () => {
    const amount = 1_000_000_000n;
    const reserve = FEE + RENT_MIN_0;
    const short = makeHarness({ solBalance: amount + reserve - 1n });
    expect(
      await requestWithdrawal(requestOf({ amountAtomic: amount.toString() }), short.deps),
    ).toMatchObject({ ok: false, code: 'insufficient_sol_for_fee' });
    expect(short.rows.size).toBe(0);

    const exact = makeHarness({ solBalance: amount + reserve });
    const res = await requestWithdrawal(requestOf({ amountAtomic: amount.toString() }), exact.deps);
    expect(res.ok).toBe(true);
  });

  it('token over-balance: insufficient_balance', async () => {
    const h = makeHarness({ tokenBalance: 10n });
    expect(
      await requestWithdrawal(requestOf({ asset: 'USDC', amountAtomic: '11' }), h.deps),
    ).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(h.rows.size).toBe(0);
  });

  it('token send with MISSING dest ATA reserves its rent in the fee headroom', async () => {
    // Without the ATA rent this balance would pass; with it, it must refuse.
    const short = makeHarness({
      destAtaExists: false,
      solBalance: FEE + RENT_MIN_0 + ATA_RENT - 1n,
    });
    expect(
      await requestWithdrawal(requestOf({ asset: 'USDC', amountAtomic: '100' }), short.deps),
    ).toMatchObject({ ok: false, code: 'insufficient_sol_for_fee' });

    // The same SOL balance is FINE when the dest ATA already exists.
    const okExisting = makeHarness({
      destAtaExists: true,
      solBalance: FEE + RENT_MIN_0 + ATA_RENT - 1n,
    });
    const res = await requestWithdrawal(
      requestOf({ asset: 'USDC', amountAtomic: '100' }),
      okExisting.deps,
    );
    expect(res.ok).toBe(true);
  });

  it('balance read failure: REFUSE (fail-closed), never fail-open', async () => {
    const h = makeHarness({ solBalanceThrows: true });
    expect(await requestWithdrawal(requestOf(), h.deps)).toMatchObject({
      ok: false,
      code: 'balance_unavailable',
    });
    expect(h.rows.size).toBe(0);
    expect(h.sentRaw.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DAILY CAP — per-asset env caps over the UTC day (fail closed)', () => {
  it('parseUiAmountToAtomic: decimals, floor, invalid → null', () => {
    expect(parseUiAmountToAtomic('1', 9)).toBe(1_000_000_000n);
    expect(parseUiAmountToAtomic('1.5', 6)).toBe(1_500_000n);
    expect(parseUiAmountToAtomic('0.0000001', 6)).toBe(0n); // floors sub-atomic
    expect(parseUiAmountToAtomic('abc', 6)).toBeNull();
    expect(parseUiAmountToAtomic(undefined, 6)).toBeNull();
    expect(parseUiAmountToAtomic('-1', 6)).toBeNull();
    delete process.env.WALLET_WITHDRAW_DAILY_CAP_SOL;
    expect(resolveWithdrawDailyCapAtomic('SOL')).toBeNull(); // unset = no cap
  });

  it('a second withdrawal that would exceed the cap fails closed (row marked failed)', async () => {
    process.env.WALLET_WITHDRAW_DAILY_CAP_SOL = '1'; // 1 SOL / day
    const h = makeHarness();
    const first = await requestWithdrawal(
      requestOf({ amountAtomic: '600000000', idempotencyKey: 'key-first-000001' }),
      h.deps,
    );
    expect(first.ok).toBe(true);

    const second = await requestWithdrawal(
      requestOf({ amountAtomic: '500000000', idempotencyKey: 'key-second-00001' }),
      h.deps,
    );
    expect(second).toMatchObject({ ok: false, code: 'daily_cap_exceeded' });
    // The over-cap row is terminal 'failed' — it can never be claimed/sent.
    const failed = [...h.rows.values()].find((r) => r.idempotencyKey === 'key-second-00001')!;
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('daily_cap_exceeded');
    // Only the FIRST withdrawal ever hit the wire.
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('HAPPY PATHS — each asset; capture-before-send ordering', () => {
  it('SOL: SystemProgram.transfer, claim→custody→capture→send→confirm→sent', async () => {
    const h = makeHarness();
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.withdrawal.status).toBe('sent');
    expect(res.withdrawal.txSignature).toBeTruthy();
    expect(res.withdrawal.network).toBe('mainnet');
    expect(res.replay).toBe(false);

    const row = [...h.rows.values()][0];
    expect(row.status).toBe('sent');
    expect(row.txSignature).toBe(res.withdrawal.txSignature!);

    // The wire tx: exactly one SystemProgram transfer for the exact lamports.
    expect(h.sentRaw.length).toBe(1);
    const tx = Transaction.from(h.sentRaw[0]);
    expect(tx.instructions.length).toBe(1);
    expect(tx.instructions[0].programId.equals(SystemProgram.programId)).toBe(true);
    expect(tx.feePayer!.toBase58()).toBe(SOURCE);
    // SystemProgram transfer data: u32 instruction (2) + u64le lamports.
    const data = tx.instructions[0].data;
    expect(data.readUInt32LE(0)).toBe(2);
    expect(data.readBigUInt64LE(4)).toBe(1_000_000_000n);

    // ORDERING: claim precedes custody; capture precedes send; send precedes confirm.
    const idx = (name: string) => h.log.indexOf(name);
    expect(idx('claim')).toBeGreaterThan(idx('insert'));
    expect(idx('loadKeypair')).toBeGreaterThan(idx('claim'));
    expect(idx('capture')).toBeGreaterThan(idx('loadKeypair'));
    expect(idx('capture')).toBeLessThan(idx('sendRaw'));
    expect(idx('sendRaw')).toBeLessThan(idx('confirm'));
    expect(idx('confirm')).toBeLessThan(idx('markSent'));
  });

  it('USDC: classic-SPL TransferChecked + idempotent dest-ATA create', async () => {
    const h = makeHarness();
    const res = await requestWithdrawal(
      requestOf({ asset: 'USDC', amountAtomic: '250000' }),
      h.deps,
    );
    expect(res.ok).toBe(true);
    const tx = Transaction.from(h.sentRaw[0]);
    expect(tx.instructions.length).toBe(2);
    expect(tx.instructions[0].programId.toBase58()).toBe(ATA_PROGRAM);
    expect(tx.instructions[0].data[0]).toBe(1); // CreateIdempotent
    expect(tx.instructions[1].programId.toBase58()).toBe(TOKEN_PROGRAM);
    const data = tx.instructions[1].data;
    expect(data[0]).toBe(12); // TransferChecked
    expect(data.readBigUInt64LE(1)).toBe(250_000n);
    expect(data[9]).toBe(6); // USDC decimals — enforced on-chain
  });

  it('CLV: Token-2022 TransferChecked (mint + 6 dp pinned)', async () => {
    const h = makeHarness();
    const res = await requestWithdrawal(
      requestOf({ asset: 'CLV', amountAtomic: '123456' }),
      h.deps,
    );
    expect(res.ok).toBe(true);
    const tx = Transaction.from(h.sentRaw[0]);
    expect(tx.instructions.length).toBe(2);
    expect(tx.instructions[0].programId.toBase58()).toBe(ATA_PROGRAM);
    expect(tx.instructions[1].programId.toBase58()).toBe(TOKEN_2022_PROGRAM);
    const data = tx.instructions[1].data;
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(123_456n);
    expect(data[9]).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('EXACTLY-ONCE — idempotency, claims, ambiguity, resume', () => {
  it('IDEMPOTENCY REPLAY: a retried key can never create a second withdrawal', async () => {
    const h = makeHarness();
    const first = await requestWithdrawal(requestOf(), h.deps);
    expect(first.ok).toBe(true);
    const sendsAfterFirst = h.log.filter((l) => l === 'sendRaw').length;
    expect(sendsAfterFirst).toBe(1);

    const second = await requestWithdrawal(requestOf(), h.deps);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.replay).toBe(true);
    expect(second.withdrawal.txSignature).toBe(
      first.ok ? first.withdrawal.txSignature : 'unreachable',
    );
    expect(h.rows.size).toBe(1);
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(sendsAfterFirst);
  });

  it('IDEMPOTENCY CONFLICT: a key reused with a DIFFERENT request refuses loudly', async () => {
    const h = makeHarness();
    const first = await requestWithdrawal(requestOf(), h.deps);
    expect(first.ok).toBe(true);
    const sends = h.log.filter((l) => l === 'sendRaw').length;

    // Same key, different amount → 409-class conflict, NOT a silent replay.
    const diffAmount = await requestWithdrawal(requestOf({ amountAtomic: '999' }), h.deps);
    expect(diffAmount).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    // Same key, different destination → same refusal.
    const diffDest = await requestWithdrawal(
      requestOf({ destination: Keypair.generate().publicKey.toBase58() }),
      h.deps,
    );
    expect(diffDest).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    // Same key, different asset → same refusal.
    const diffAsset = await requestWithdrawal(requestOf({ asset: 'USDC' }), h.deps);
    expect(diffAsset).toMatchObject({ ok: false, code: 'idempotency_conflict' });

    expect(h.rows.size).toBe(1); // no second row, ever
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(sends); // no second send
  });

  it('DOUBLE-CLAIM: a lost atomic claim refuses with zero custody/sends', async () => {
    const h = makeHarness({ stealClaim: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res.ok).toBe(false);
    expect(h.log).not.toContain('loadKeypair');
    expect(h.sentRaw.length).toBe(0);
  });

  it('replay of an in-flight (sending) row reports withdrawal_in_flight — no touch', async () => {
    const h = makeHarness({
      rows: [
        {
          id: randomUUID(),
          status: 'sending',
          claimId: randomUUID(),
          claimedAt: new Date(),
          idempotencyKey: 'key-abc-12345678',
        },
      ],
    });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'withdrawal_in_flight' });
    expect(h.log).not.toContain('claim');
    expect(h.sentRaw.length).toBe(0);
  });

  it('CAPTURE LOST: claim no longer ours at capture time ⇒ NOTHING is sent', async () => {
    const h = makeHarness({ stealCapture: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'capture_lost' });
    expect(h.sentRaw.length).toBe(0);
  });

  it('SIGNATURE CONFLICT at capture: released for a clean retry, nothing sent', async () => {
    const h = makeHarness({ captureSigConflict: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'transient_failure', detail: 'signature_conflict' });
    expect(h.sentRaw.length).toBe(0);
    const row = [...h.rows.values()][0];
    expect(row.status).toBe('pending'); // clean re-claim later
  });

  it('AMBIGUOUS SEND: terminal reconcile; a retry NEVER re-sends the captured sig', async () => {
    const h = makeHarness({ sendThrows: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'send_ambiguous' });
    if (res.ok) throw new Error('unreachable');
    expect(res.txSignature).toBeTruthy(); // the money proof is durable

    const row = [...h.rows.values()][0];
    expect(row.status).toBe('reconcile');
    expect(row.failureReason).toBe('send_ambiguous');
    expect(row.txSignature).toBeTruthy();

    // Retry with the SAME idempotency key: replays the terminal state — the
    // send attempt count does NOT grow.
    const attemptsAfterFirst = h.log.filter((l) => l === 'sendRaw').length;
    const retry = await requestWithdrawal(requestOf(), h.deps);
    expect(retry).toMatchObject({ ok: false, code: 'withdrawal_reconcile' });
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(attemptsAfterFirst);
    expect(h.rows.size).toBe(1);
  });

  it('AMBIGUOUS CONFIRM: terminal reconcile (money-state unknown)', async () => {
    const h = makeHarness({ confirmThrows: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'send_ambiguous', detail: 'confirm_ambiguous' });
    expect([...h.rows.values()][0].status).toBe('reconcile');
  });

  it('DEFINITIVE on-chain failure: terminal failed (no assets moved)', async () => {
    const h = makeHarness({ confirmOutcome: 'failed' });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'tx_failed' });
    const row = [...h.rows.values()][0];
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('tx_failed_on_chain');
  });

  it('CUSTODY refusal (pubkey mismatch): terminal failed, zero sends', async () => {
    const h = makeHarness({
      loadKeypairThrows: new WalletWithdrawCustodyError('mismatch', 'pubkey_mismatch'),
    });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'custody_failed', detail: 'pubkey_mismatch' });
    const row = [...h.rows.values()][0];
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('custody_pubkey_mismatch');
    expect(h.sentRaw.length).toBe(0);
  });

  it('PRE-CAPTURE transient failure: claim released; the SAME key then completes', async () => {
    const h = makeHarness({ blockhashThrows: true });
    const res = await requestWithdrawal(requestOf(), h.deps);
    expect(res).toMatchObject({ ok: false, code: 'transient_failure' });
    const row = [...h.rows.values()][0];
    expect(row.status).toBe('pending'); // released — nothing signed, nothing sent
    expect(h.sentRaw.length).toBe(0);

    // The retry with the same idempotency key re-executes the SAME row.
    h.deps.getLatestBlockhash = async () => ({
      blockhash: bs58.encode(new Uint8Array(32).fill(9)),
      lastValidBlockHeight: 999,
    });
    const retry = await requestWithdrawal(requestOf(), h.deps);
    expect(retry.ok).toBe(true);
    expect(h.rows.size).toBe(1);
    expect(h.sentRaw.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RESUME — forward-only; a captured signature is NEVER re-sent', () => {
  const staleClaim = () => ({
    id: randomUUID(),
    status: 'sending' as const,
    claimId: randomUUID(),
    claimedAt: new Date(Date.now() - 10 * 60_000),
  });

  it('captured + confirmed on chain → sent (zero sends)', async () => {
    const seed = { ...staleClaim(), txSignature: 'captured-sig-1' };
    const h = makeHarness({ rows: [seed], sigStatus: 'confirmed' });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.resumed).toBe(true);
    expect(h.rows.get(seed.id)!.status).toBe('sent');
    expect(h.sentRaw.length).toBe(0);
    expect(h.log).not.toContain('loadKeypair'); // resume never touches custody
  });

  it('captured + on-chain err → failed (definitive; zero sends)', async () => {
    const seed = { ...staleClaim(), txSignature: 'captured-sig-2' };
    const h = makeHarness({ rows: [seed], sigStatus: 'failed' });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'tx_failed' });
    expect(h.rows.get(seed.id)!.status).toBe('failed');
    expect(h.sentRaw.length).toBe(0);
  });

  it('captured + not_found → TERMINAL reconcile (the tx may still land — never re-send)', async () => {
    const seed = { ...staleClaim(), txSignature: 'captured-sig-3' };
    const h = makeHarness({ rows: [seed], sigStatus: 'not_found' });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'withdrawal_reconcile', detail: 'resume_unresolved' });
    expect(h.rows.get(seed.id)!.status).toBe('reconcile');
    expect(h.sentRaw.length).toBe(0);
  });

  it('nothing captured → nothing was ever sent → clean release to pending', async () => {
    const seed = { ...staleClaim(), txSignature: null };
    const h = makeHarness({ rows: [seed] });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'released_for_retry' });
    expect(h.rows.get(seed.id)!.status).toBe('pending');
    expect(h.log).not.toContain('sigStatus');
  });

  it('a LIVE (fresh) claim is never stolen', async () => {
    const seed = {
      id: randomUUID(),
      status: 'sending' as const,
      claimId: randomUUID(),
      claimedAt: new Date(), // fresh
      txSignature: 'captured-sig-4',
    };
    const h = makeHarness({ rows: [seed], sigStatus: 'confirmed' });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'withdrawal_in_flight' });
    expect(h.rows.get(seed.id)!.status).toBe('sending');
  });

  it('transient chain-check error: row stays sending for a later resume', async () => {
    const seed = { ...staleClaim(), txSignature: 'captured-sig-5' };
    const h = makeHarness({ rows: [seed], sigStatusThrows: true });
    const res = await resumeWithdrawal(seed.id, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'resume_transient' });
    expect(h.rows.get(seed.id)!.status).toBe('sending');
  });

  it('runWithdrawResumeTick sweeps stale claims', async () => {
    const seed = { ...staleClaim(), txSignature: 'captured-sig-6' };
    const h = makeHarness({ rows: [seed], sigStatus: 'confirmed' });
    const out = await runWithdrawResumeTick(h.deps);
    expect(out.length).toBe(1);
    expect(out[0].result.ok).toBe(true);
    expect(h.rows.get(seed.id)!.status).toBe('sent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E5 PARITY — agents withdraw as themselves; guests/non-ledger refused', () => {
  it('resolveWithdrawSubject: non-ledger agent session refused; ledger agent → its avatar', () => {
    const nonLedger = resolveWithdrawSubject({
      kind: 'agent',
      userId: USER,
      avatarId: AVATAR,
      agentId: 'agent-1',
      sessionId: 's1',
      ledgerCapable: false,
    });
    expect(nonLedger).toMatchObject({ error: 'agent_not_ledger_capable' });

    const ledger = resolveWithdrawSubject({
      kind: 'agent',
      userId: USER,
      avatarId: AVATAR,
      agentId: 'agent-1',
      sessionId: 's1',
      ledgerCapable: true,
    });
    expect(ledger).toMatchObject({
      subject: { avatarId: AVATAR, userId: USER, kind: 'agent', agentId: 'agent-1' },
    });

    const human = resolveWithdrawSubject({
      kind: 'user',
      userId: USER,
      avatarId: AVATAR,
      agentId: null,
    });
    expect(human).toMatchObject({ subject: { kind: 'user', avatarId: AVATAR } });
  });

  it('AGENT PARITY end-to-end: an agent subject withdraws from ITS avatar wallet', async () => {
    const h = makeHarness();
    const res = await requestWithdrawal(requestOf({ subject: agentSubject }), h.deps);
    expect(res.ok).toBe(true);
    const row = [...h.rows.values()][0];
    expect(row.subjectType).toBe('agent');
    expect(row.avatarId).toBe(AVATAR);
    expect((row.metadata as Record<string, unknown>).agentId).toBe('agent-1');
  });

  it('ROUTE WIRING (source-verified): auth + non-guest + strict zod + Idempotency-Key', () => {
    const routeSrc = readFileSync(
      resolve(__dirname, '../../routes/wallet-withdraw.ts'),
      'utf-8',
    );
    // Guests and unauthenticated callers are structurally refused on the write.
    expect(routeSrc).toMatch(/post\(\s*'\/withdraw',\s*requireAuthOrAgentSession,\s*requireNonGuestIdentity/);
    // The exactly-once retry contract is mandatory.
    expect(routeSrc).toContain("c.req.header('Idempotency-Key')");
    expect(routeSrc).toContain('idempotency_key_required');
    // Body is strict — unknown fields refused.
    expect(routeSrc).toContain('.strict()');
    // E5 non-ledger refusal is wired.
    expect(routeSrc).toContain('resolveWithdrawSubject');
  });

  it('LEDGER-UNTOUCHED (source-verified): no claw-token-ledger import anywhere', () => {
    for (const rel of ['../wallet-withdraw-executor.ts', '../../routes/wallet-withdraw.ts']) {
      const src = readFileSync(resolve(__dirname, rel), 'utf-8');
      expect(src).not.toMatch(/claw-token-ledger'/); // no import specifier
      expect(src).not.toMatch(/\.clawTokens\s*[:=]/); // no balance write
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /balances — read-only, live regardless of the flag', () => {
  it('reports all three assets (atomic + ui) off the custodial wallet', async () => {
    delete process.env.WALLET_WITHDRAW_ENABLED; // reads work while dark
    const h = makeHarness({ solBalance: 2_500_000_000n, tokenBalance: 750_000n });
    const res = await getCustodialWalletBalances(AVATAR, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.wallet).toBe(SOURCE);
    expect(res.network).toBe('mainnet');
    expect(res.withdrawEnabled).toBe(false);
    expect(res.balances.SOL).toMatchObject({ available: true, amountAtomic: '2500000000', decimals: 9 });
    expect(res.balances.USDC).toMatchObject({ available: true, amountAtomic: '750000', decimals: 6 });
    expect(res.balances.CLV).toMatchObject({ available: true, amountAtomic: '750000', decimals: 6 });
    expect(h.sentRaw.length).toBe(0); // read-only — nothing ever signs
  });

  it('missing wallet → wallet_missing; a failed read degrades per-asset', async () => {
    const missing = makeHarness({ walletPubkey: null });
    expect(await getCustodialWalletBalances(AVATAR, missing.deps)).toMatchObject({
      ok: false,
      code: 'wallet_missing',
    });

    const degraded = makeHarness({ solBalanceThrows: true });
    const res = await getCustodialWalletBalances(AVATAR, degraded.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.balances.SOL.available).toBe(false);
    expect(res.balances.USDC.available).toBe(true);
  });
});
