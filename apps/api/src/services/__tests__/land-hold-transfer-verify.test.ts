/**
 * DOOR 2 (exact-dust transfer + auto-refund) — real-money coverage.
 *
 * The whole service is driven through injected `store` / `rpc` / keypair / clock
 * seams, so every test exercises the REAL orchestration code (attribution,
 * unique-amount minting, caps, grant, refund exactly-once) rather than a
 * re-implementation. The fake store enforces the same invariants the schema
 * does: the partial unique index over `lamports WHERE status = 'pending'`, the
 * unique index on `inbound_signature`, and every CAS the SQL performs.
 *
 * Trap coverage: T4 (mainnet RPC seam), T5 (per-user + global drain caps), T6
 * (exact-amount uniqueness), T7 (one signature, one challenge), T8 (finalized
 * only), T9 (fail closed on the grant, fail soft on the refund; forward-only,
 * never re-send), T10 (no secret ever logged, echoed, or returned).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { Keypair, LAMPORTS_PER_SOL, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { encryptSecretKey } from '../keypair-vault';
import {
  LandHoldVerifyError,
  REFUND_FEE_LAMPORTS,
  _landHoldVerifyAlertThrottleSizeForTest,
  _landHoldVerifyCompletedHarvestSizeForTest,
  _resetLandHoldVerifyDepsForTest,
  _setLandHoldVerifyDepsForTest,
  blockTimeInsideWindow,
  challengeMemo,
  getTransferDoorAvailability,
  insertWithUniqueAmount,
  landHoldVerifyBaseLamports,
  landHoldVerifyDailyRefundCapLamports,
  landHoldVerifyOrphanThresholdMs,
  landHoldVerifyRpcUrl,
  landHoldVerifyTtlMs,
  landHoldVerifyUserDailyAttempts,
  openTransferChallenge,
  pollTransferChallenge,
  probeTransaction,
  rotatedDestinationObligations,
  scanFactsOf,
  startLandHoldVerifySweeper,
  stopLandHoldVerifySweeper,
  submitTransferSignature,
  sweepTransferChallenges,
  receivedLamportsFrom,
  refundMemoText,
  transactionHasTopLevelTransferLeg,
  transactionMatchesTransferLeg,
  transactionSettlesChallenge,
  transactionSignedBySource,
  type ChallengeRow,
  type GrantOutcome,
  type LandHoldVerifyRpc,
  type LandHoldVerifyStore,
  type OpenChallengeOutcome,
  type OpenTransferChallengeResult,
  type ProbedMemo,
  type AttributeOutcome,
  type RefundAdmission,
  type RefundObligationInput,
  type RefundCaptureOutcome,
  type ScanFacts,
  type ScanLedgerRow,
  type SignatureRef,
  type TransferChallengeStatus,
  type TransferDoorAvailability,
  type TransferRefundState,
  type TransferRejectedReason,
  type VerifyWalletRow,
} from '../land-hold-transfer-verify';
import type { AlertErrorParams } from '../alert-error';

const SERVICE_PATH = resolve(import.meta.dir, '../land-hold-transfer-verify.ts');
/** Service source, for the structural invariants that guard money paths. */
const verifySource = readFileSync(SERVICE_PATH, 'utf8');

const ENV_KEYS = [
  'LAND_HOLD_VERIFY_BASE_LAMPORTS',
  'LAND_HOLD_VERIFY_TTL_MS',
  'LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL',
  'LAND_HOLD_VERIFY_USER_DAILY_ATTEMPTS',
  'HELIUS_API_KEY',
  'VANITY_ENCRYPTION_KEY',
] as const;
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pubkey = (): string => Keypair.generate().publicKey.toBase58();
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

/**
 * A deterministic, VALID base58 64-byte signature per fixture name. Submission
 * length-checks the signature before any RPC work, so a fixture cannot be a
 * friendly string like sig('sig-grant') any more.
 */
const signatureCache = new Map<string, string>();
function sig(name: string): string {
  const cached = signatureCache.get(name);
  if (cached) return cached;
  const bytes = Buffer.alloc(64);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (name.charCodeAt(i % name.length) * (i + 7) + name.length) % 256;
  }
  const encoded = bs58.encode(bytes);
  signatureCache.set(name, encoded);
  return encoded;
}
const USER_A = '11111111-2222-4333-8444-555555555555';
const USER_B = '99999999-8888-4777-8666-555555555555';

const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

interface TransferLeg {
  program?: string;
  type?: string;
  source?: string;
  destination?: string;
  lamports?: number;
  /** Renders an SPL Memo instruction instead of a system transfer. */
  memo?: string;
  /** Emit the memo in RAW (partially decoded) form: base58 instruction data. */
  memoRaw?: boolean;
  memoProgramId?: string;
}

function leg(l: TransferLeg): unknown {
  if (l.memo != null) {
    const programId = l.memoProgramId ?? MEMO_PROGRAM_V2;
    return l.memoRaw
      ? { programId, accounts: [], data: bs58.encode(Buffer.from(l.memo, 'utf8')) }
      : { program: 'spl-memo', programId, parsed: l.memo };
  }
  return {
    program: l.program ?? 'system',
    programId: '11111111111111111111111111111111',
    parsed: {
      type: l.type ?? 'transfer',
      info: {
        source: l.source,
        destination: l.destination,
        lamports: l.lamports,
      },
    },
  };
}

function parsedTx(opts: {
  err?: unknown;
  blockTimeMs?: number | null;
  signers?: string[];
  readonly?: string[];
  top?: TransferLeg[];
  inner?: TransferLeg[];
  opaqueTop?: boolean;
}): ParsedTransactionWithMeta {
  const accountKeys = [
    ...(opts.signers ?? []).map((pk) => ({ pubkey: pk, signer: true, writable: true })),
    ...(opts.readonly ?? []).map((pk) => ({ pubkey: pk, signer: false, writable: true })),
  ];
  const top: unknown[] = (opts.top ?? []).map(leg);
  if (opts.opaqueTop) {
    // A non-parsed (partially decoded) instruction, as an outer CPI wrapper.
    top.unshift({ programId: 'Vote111111111111111111111111111111111111111', accounts: [], data: 'aa' });
  }
  return {
    blockTime: opts.blockTimeMs == null ? null : Math.floor(opts.blockTimeMs / 1000),
    slot: 1,
    transaction: { message: { accountKeys, instructions: top }, signatures: ['sig'] },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      innerInstructions: opts.inner ? [{ index: 0, instructions: opts.inner.map(leg) }] : [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

// ---------------------------------------------------------------------------
// Fake store — mirrors every constraint + CAS the raw SQL relies on.
// ---------------------------------------------------------------------------

interface FakeUser {
  declaredWallet: string | null;
  verifiedAt: Date | null;
  verifiedMethod: string | null;
  verifiedPubkey: string | null;
  grandfatheredPubkey: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors LATE_ARRIVAL_GRACE_MS in the service. */
const LATE_GRACE_MS = 30 * 60 * 1000;
/** Mirrors UNCLAIMED_CLOSED_MARGIN_MS in the service. */
const CLOSED_MARGIN_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;

class FakeStore implements LandHoldVerifyStore {
  rows: ChallengeRow[] = [];
  users = new Map<string, FakeUser>();
  wallet: VerifyWalletRow | null = null;
  failWalletLookup = false;
  clock: () => number = () => Date.now();
  /** Durable scan ledger, keyed `${destination}\u0000${signature}`. */
  scans = new Map<string, ScanLedgerRow & { destination: string; matched: boolean }>();
  /** DB-owned daily cap policy, keyed by UTC day. */
  capPolicies = new Map<string, bigint>();
  /** Durable refund obligations, keyed by signature + recipient + reason. */
  obligations = new Map<string, RefundObligationInput & { state: string }>();
  private seq = 0;

  private scanKey(destination: string, signature: string): string {
    return `${destination}\u0000${signature}`;
  }

  private utcDay(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  declare(userId: string, walletPubkey: string | null): void {
    this.users.set(userId, {
      declaredWallet: walletPubkey,
      verifiedAt: null,
      verifiedMethod: null,
      verifiedPubkey: null,
      grandfatheredPubkey: null,
    });
  }

  user(userId: string): FakeUser {
    const u = this.users.get(userId);
    if (!u) throw new Error(`test user ${userId} not seeded`);
    return u;
  }

  row(id: string): ChallengeRow {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`test challenge ${id} not found`);
    return r;
  }

  seed(partial: Partial<ChallengeRow> & { userId: string; walletPubkey: string }): ChallengeRow {
    this.seq += 1;
    const now = this.clock();
    const row: ChallengeRow = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
      userId: partial.userId,
      walletPubkey: partial.walletPubkey,
      lamports: partial.lamports ?? 10_000_123,
      inboundLamports: partial.inboundLamports ?? null,
      destinationPubkey: partial.destinationPubkey ?? this.wallet?.publicKey ?? pubkey(),
      status: partial.status ?? 'pending',
      rejectedReason: partial.rejectedReason ?? null,
      refundCapDay: partial.refundCapDay ?? null,
      refundCapLamports: partial.refundCapLamports ?? null,
      refundAuthorizedAt: partial.refundAuthorizedAt ?? null,
      expiresAt: partial.expiresAt ?? new Date(now + 45 * 60 * 1000),
      createdAt: partial.createdAt ?? new Date(now),
      inboundSignature: partial.inboundSignature ?? null,
      refundState: partial.refundState ?? 'none',
      refundSignature: partial.refundSignature ?? null,
      refundClaimId: partial.refundClaimId ?? null,
      refundClaimedAt: partial.refundClaimedAt ?? null,
    };
    this.rows.push(row);
    return row;
  }

  async findVerifyWallet(): Promise<VerifyWalletRow | null> {
    if (this.failWalletLookup) throw new Error('treasury read failed');
    return this.wallet;
  }

  async openChallenge(input: {
    userId: string;
    declaredWallet: string;
    destination: string;
    baseLamports: number;
    ttlMs: number;
    attemptCap: number;
    graceMs: number;
  }): Promise<OpenChallengeOutcome> {
    const user = this.users.get(input.userId);
    if (!user || user.declaredWallet == null || user.declaredWallet !== input.declaredWallet) {
      return { kind: 'wallet_not_declared' };
    }
    const dayStart = Math.floor(this.clock() / DAY_MS) * DAY_MS;
    const used = this.rows.filter(
      (r) => r.userId === input.userId && r.createdAt.getTime() >= dayStart,
    ).length;
    if (used >= input.attemptCap) return { kind: 'attempt_cap', used, cap: input.attemptCap };

    const row = await insertWithUniqueAmount(input.baseLamports, async (lamports) => {
      // The partial unique index over `lamports WHERE status = 'pending'`, PLUS
      // the NOT EXISTS guard that keeps an amount reserved while a lapsed row is
      // still being scanned for a late arrival.
      const taken = this.rows.some(
        (r) =>
          r.lamports === lamports &&
          (r.status === 'pending' ||
            (r.inboundSignature == null &&
              r.status === 'expired' &&
              r.expiresAt.getTime() > this.clock() - input.graceMs)),
      );
      if (taken) return null;
      return this.seed({
        userId: input.userId,
        walletPubkey: input.declaredWallet,
        destinationPubkey: input.destination,
        lamports,
        expiresAt: new Date(this.clock() + input.ttlMs),
      });
    });
    return row ? { kind: 'ok', row } : { kind: 'amount_exhausted' };
  }

  async getChallengeForUser(challengeId: string, userId: string): Promise<ChallengeRow | null> {
    const row = this.rows.find((r) => r.id === challengeId && r.userId === userId);
    return row ? { ...row } : null;
  }

  async expireLapsedChallenges(): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (row.status === 'pending' && row.inboundSignature == null && row.expiresAt.getTime() < this.clock()) {
        row.status = 'expired';
        n += 1;
      }
    }
    return n;
  }

  async expireChallengeIfLapsed(challengeId: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === challengeId);
    if (
      !row ||
      row.status !== 'pending' ||
      row.inboundSignature != null ||
      row.expiresAt.getTime() >= this.clock()
    ) {
      return false;
    }
    row.status = 'expired';
    return true;
  }

  async listPendingChallenges(limit: number): Promise<ChallengeRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.status === 'pending' &&
          r.inboundSignature == null &&
          r.expiresAt.getTime() > this.clock(),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listScannableChallenges(
    limit: number,
    graceMs: number,
    closedForMs: number,
  ): Promise<ChallengeRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.inboundSignature == null &&
          (r.status === 'pending' || r.status === 'expired') &&
          // CLOSED only: a live window belongs to the user, who may submit.
          r.expiresAt.getTime() <= this.clock() - closedForMs &&
          r.expiresAt.getTime() > this.clock() - (graceMs + closedForMs),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listGrantableChallenges(limit: number): Promise<ChallengeRow[]> {
    return this.rows
      .filter((r) => r.status === 'observed')
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listRefundableChallenges(limit: number, staleMs: number): Promise<ChallengeRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.inboundSignature != null &&
          r.refundState === 'none' &&
          (r.refundClaimedAt == null || r.refundClaimedAt.getTime() < this.clock() - staleMs),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listUnresolvedRefunds(limit: number): Promise<ChallengeRow[]> {
    return this.rows
      .filter((r) => r.refundState === 'sending' && r.refundSignature != null)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async isSignatureAttributed(signature: string): Promise<boolean> {
    return this.rows.some((r) => r.inboundSignature === signature);
  }

  // ── Durable scan ledger ──────────────────────────────────────────────────

  async filterUnscannedSignatures(
    destination: string,
    signatures: string[],
  ): Promise<Set<string>> {
    return new Set(signatures.filter((s) => !this.scans.has(this.scanKey(destination, s))));
  }

  async recordScannedSignature(input: {
    destination: string;
    signature: string;
    blockTimeMs: number | null;
    facts: ScanFacts;
  }): Promise<void> {
    const key = this.scanKey(input.destination, input.signature);
    this.scans.set(key, {
      destination: input.destination,
      signature: input.signature,
      blockTimeMs: input.blockTimeMs,
      facts: input.facts,
      matched: this.scans.get(key)?.matched ?? false,
    });
  }

  async listScannedSignatures(input: {
    destination: string;
    fromMs: number;
    toMs: number;
    limit: number;
    oldestFirst?: boolean;
  }): Promise<ScanLedgerRow[]> {
    return [...this.scans.values()]
      .filter(
        (s) =>
          s.destination === input.destination &&
          (s.blockTimeMs == null ||
            (s.blockTimeMs >= input.fromMs && s.blockTimeMs <= input.toMs)),
      )
      .sort((a, b) => {
        const aTime = a.blockTimeMs;
        const bTime = b.blockTimeMs;
        if (aTime == null && bTime != null) return 1;
        if (aTime != null && bTime == null) return -1;
        const delta = (aTime ?? 0) - (bTime ?? 0);
        return input.oldestFirst ? delta : -delta;
      })
      .slice(0, input.limit)
      .map((s) => ({ signature: s.signature, blockTimeMs: s.blockTimeMs, facts: s.facts }));
  }

  async markSignatureMatched(destination: string, signature: string): Promise<void> {
    const entry = this.scans.get(this.scanKey(destination, signature));
    if (entry) entry.matched = true;
  }

  /** Mirrors the unique index, which is scoped by DESTINATION too. */
  private obligationKey(input: RefundObligationInput): string {
    return `${input.destination} ${input.signature} ${input.recipientPubkey} ${input.reason}`;
  }

  async recordRefundObligation(input: RefundObligationInput): Promise<boolean> {
    const key = this.obligationKey(input);
    if (this.obligations.has(key)) return false;
    this.obligations.set(key, { ...input, state: 'open' });
    return true;
  }

  async listRecentDestinations(): Promise<string[]> {
    return [...new Set(this.rows.map((r) => r.destinationPubkey))];
  }

  /**
   * Retired verify-wallet ROWS, shaped like `treasury_wallets`: each carries its
   * own `retiredAt`, and they persist beside exactly ONE active row (the
   * active-only singleton in 0060b). This models a state production can really
   * be in — a bare pubkey list described one the old unscoped index refused.
   */
  retiredWallets: Array<{ publicKey: string; retiredAt: Date }> = [];
  /** Simulates the destination lookup being unavailable (fail-closed tests). */
  failDestinationLookup = false;

  /** Retire the live wallet and install a new one, as `--rotate` does. */
  rotateVerifyWallet(nextPublicKey: string): void {
    if (this.wallet) {
      this.retiredWallets.push({
        publicKey: this.wallet.publicKey,
        retiredAt: new Date(this.clock()),
      });
    }
    this.wallet = this.wallet
      ? { ...this.wallet, publicKey: nextPublicKey }
      : { publicKey: nextPublicKey, encryptedSecretKey: '', encryptionIv: '', encryptionTag: '' };
  }

  async listVerifyDestinations(): Promise<string[]> {
    if (this.failDestinationLookup) throw new Error('treasury destination read failed');
    // Active first, then retired — the same order the SQL returns.
    const active = this.wallet ? [this.wallet.publicKey] : [];
    return [...active, ...this.retiredWallets.map((w) => w.publicKey)];
  }

  async readTodayCapPolicy(): Promise<bigint | null> {
    return this.capPolicies.get(this.utcDay()) ?? null;
  }

  async pruneScanLedger(olderThanMs: number): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.scans) {
      const at = entry.blockTimeMs ?? this.clock();
      if (at < this.clock() - olderThanMs) {
        this.scans.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async attributeInbound(input: {
    challengeId: string;
    userId: string;
    destination: string;
    signature: string;
    inboundLamports: number;
    nextStatus: 'observed' | 'expired' | 'rejected' | 'unclaimed';
    rejectedReason: TransferRejectedReason | null;
    onlyIfClosedForMs?: number;
    obligations?: RefundObligationInput[];
    legs?: ReadonlyArray<{ destination: string; source: string; lamports: number }>;
  }): Promise<AttributeOutcome> {
    const miss = { bound: false, refundQuarantined: false };
    // The unique index on inbound_signature — one signature, one challenge (T7).
    if (this.rows.some((r) => r.inboundSignature === input.signature)) return miss;
    const row = this.rows.find((r) => r.id === input.challengeId);
    if (!row || row.inboundSignature != null) return miss;
    // The SQL guard: the scan may ONLY terminalize a CLOSED challenge, so it can
    // never destroy a proof the user is still about to submit.
    if (
      input.onlyIfClosedForMs != null &&
      row.expiresAt.getTime() > this.clock() - input.onlyIfClosedForMs
    ) {
      return miss;
    }
    // The reason/status pairing CHECK the schema enforces.
    if ((input.nextStatus === 'rejected') !== (input.rejectedReason != null)) {
      throw new Error('rejected_reason pairing violated');
    }
    if (!(input.inboundLamports > 0)) throw new Error('inbound_lamports must be positive');
    row.inboundSignature = input.signature;
    row.inboundLamports = input.inboundLamports;
    row.status = input.nextStatus;
    row.rejectedReason = input.rejectedReason;
    // FRESH destination read, exactly as the SQL does it INSIDE the transaction:
    // a set captured earlier could be stale across a rotation.
    const knownDestinations = new Set(await this.listVerifyDestinations());
    const allObligations = [
      ...(input.obligations ?? []),
      ...rotatedDestinationObligations(
        input.legs ?? [],
        input.destination,
        knownDestinations,
        input.signature,
        input.challengeId,
      ),
    ];
    // ATOMIC with the attribution; the unique key carries the retry.
    for (const obligation of allObligations) {
      const key = this.obligationKey(obligation);
      if (!this.obligations.has(key)) {
        this.obligations.set(key, { ...obligation, state: 'open' });
      }
    }
    // DOUBLE-PAY GUARD: an operator already settled these funds by hand, so the
    // automatic refund is held at `reconcile` rather than paying them twice.
    const refundQuarantined = [...this.obligations.values()].some(
      (o) =>
        o.destination === input.destination &&
        o.signature === input.signature &&
        o.state === 'settled',
    );
    if (refundQuarantined && row.refundState === 'none') row.refundState = 'reconcile';
    // These funds are refunded THROUGH the challenge now, so an OPEN orphan
    // claim on them is not a debt. Scoped by DESTINATION as well.
    for (const [key, obligation] of this.obligations) {
      if (
        obligation.destination === input.destination &&
        obligation.signature === input.signature &&
        obligation.reason === 'unclaimed_inbound' &&
        obligation.state === 'open'
      ) {
        this.obligations.set(key, { ...obligation, state: 'void' });
      }
    }
    return { bound: true, refundQuarantined };
  }

  async grantVerification(input: {
    challengeId: string;
    userId: string;
    walletPubkey: string;
  }): Promise<GrantOutcome> {
    const user = this.users.get(input.userId);
    if (!user) return 'missing';
    const row = this.rows.find((r) => r.id === input.challengeId);
    if (user.declaredWallet !== input.walletPubkey) {
      if (row && row.status === 'observed') row.status = 'failed';
      return 'wallet_changed';
    }
    if (!row || row.status !== 'observed') return 'not_observed';
    row.status = 'verified';
    user.verifiedAt = new Date(this.clock());
    user.verifiedMethod = 'transfer';
    user.verifiedPubkey = input.walletPubkey;
    return 'granted';
  }

  async admitRefund(input: {
    challengeId: string;
    claimId: string;
    feeLamports: bigint;
    capLamports: bigint;
    staleMs: number;
  }): Promise<RefundAdmission> {
    // The DB owns the day's cap: first admission writes it, later ones must agree.
    const capDay = this.utcDay();
    if (!this.capPolicies.has(capDay)) this.capPolicies.set(capDay, input.capLamports);
    const recordedLamports = this.capPolicies.get(capDay)!;
    if (recordedLamports !== input.capLamports) {
      return {
        kind: 'cap_mismatch',
        capDay,
        recordedLamports,
        callLamports: input.capLamports,
      };
    }

    // Spend is summed over the AUTHORIZATION stamp, never over created_at.
    let used = 0n;
    for (const r of this.rows) {
      if (r.id === input.challengeId) continue;
      if (r.refundCapDay !== capDay) continue;
      const spending =
        r.refundState === 'sending' ||
        r.refundState === 'sent' ||
        r.refundState === 'reconcile' ||
        (r.refundState === 'none' &&
          r.refundClaimId != null &&
          r.refundClaimedAt != null &&
          r.refundClaimedAt.getTime() > this.clock() - input.staleMs);
      // FEE ONLY — the principal is the user's own dust going straight back.
      if (spending) used += input.feeLamports;
    }
    if (used + input.feeLamports > recordedLamports) {
      return { kind: 'cap', capDay, usedLamports: used, capLamports: recordedLamports };
    }
    const row = this.rows.find((r) => r.id === input.challengeId);
    if (
      !row ||
      row.inboundSignature == null ||
      row.refundState !== 'none' ||
      (row.refundClaimedAt != null && row.refundClaimedAt.getTime() >= this.clock() - input.staleMs)
    ) {
      return { kind: 'claim_lost' };
    }
    row.refundClaimId = input.claimId;
    row.refundClaimedAt = new Date(this.clock());
    row.refundCapDay = capDay;
    row.refundCapLamports = recordedLamports;
    row.refundAuthorizedAt = new Date(this.clock());
    return {
      kind: 'claimed',
      claimedAt: row.refundClaimedAt,
      capDay,
      capLamports: recordedLamports,
    };
  }

  async captureRefundSignature(input: {
    challengeId: string;
    claimId: string;
    signature: string;
  }): Promise<RefundCaptureOutcome> {
    const row = this.rows.find((r) => r.id === input.challengeId);
    if (!row || row.refundClaimId !== input.claimId || row.refundState !== 'none') return 'lost';
    // The unique index on refund_signature.
    if (this.rows.some((r) => r.id !== row.id && r.refundSignature === input.signature)) {
      return 'collision';
    }
    row.refundState = 'sending';
    row.refundSignature = input.signature;
    return 'captured';
  }

  async finishRefund(input: {
    challengeId: string;
    state: 'sent' | 'reconcile' | 'skipped';
    claimId?: string;
    signature?: string;
    obligations?: RefundObligationInput[];
  }): Promise<boolean> {
    const row = this.rows.find((r) => r.id === input.challengeId);
    if (!row) return false;
    // Ownership binding: the captured signature after capture, the claim before.
    if (input.signature != null) {
      if (row.refundState !== 'sending' || row.refundSignature !== input.signature) return false;
    } else if (input.claimId != null) {
      if (row.refundState !== 'none' || row.refundClaimId !== input.claimId) return false;
    } else {
      throw new Error('finishRefund requires either a claimId or the captured signature');
    }
    row.refundState = input.state as TransferRefundState;
    row.refundClaimId = null;
    row.refundClaimedAt = null;
    // ATOMIC with the terminalization: a `skipped` row is money still owed, and
    // refundable selection requires `refund_state = 'none'`, so nothing could
    // ever retry a `skipped` row whose obligation write had failed.
    for (const obligation of input.obligations ?? []) {
      const key = this.obligationKey(obligation);
      if (!this.obligations.has(key)) {
        this.obligations.set(key, { ...obligation, state: 'open' });
      }
    }
    return true;
  }

  async releaseRefundClaim(challengeId: string, claimId: string): Promise<void> {
    const row = this.rows.find((r) => r.id === challengeId);
    if (!row || row.refundClaimId !== claimId || row.refundState !== 'none') return;
    row.refundClaimId = null;
    row.refundClaimedAt = null;
  }
}

// ---------------------------------------------------------------------------
// Fake RPC
// ---------------------------------------------------------------------------

class FakeRpc implements LandHoldVerifyRpc {
  signatures: SignatureRef[] = [];
  txs = new Map<string, ParsedTransactionWithMeta | null>();
  statuses = new Map<string, { err: unknown; confirmationStatus?: string | null } | null>();
  sentRaw: string[] = [];
  sendThrows = false;
  confirmErr: unknown = null;
  confirmThrows = false;
  commitments: string[] = [];

  /** Verify-wallet float. Ample by default so the door reports open. */
  balance = 5 * LAMPORTS_PER_SOL;
  balanceThrows = false;

  async getSignaturesForAddress(
    _address: unknown,
    options: { limit: number; before?: string },
    commitment: 'finalized',
  ): Promise<SignatureRef[]> {
    this.commitments.push(`signatures:${commitment}`);
    // Real cursor semantics: `before` returns the page STRICTLY older than that
    // signature, so the eclipse test can prove pagination actually reaches back.
    const start = options.before
      ? this.signatures.findIndex((s) => s.signature === options.before) + 1
      : 0;
    if (start <= 0 && options.before) return [];
    return this.signatures.slice(start, start + options.limit);
  }

  async getBalance(): Promise<number> {
    if (this.balanceThrows) throw new Error('balance read failed');
    return this.balance;
  }

  async getParsedTransaction(
    signature: string,
    config: { commitment: 'finalized'; maxSupportedTransactionVersion: number },
  ): Promise<ParsedTransactionWithMeta | null> {
    this.commitments.push(`tx:${config.commitment}`);
    return this.txs.get(signature) ?? null;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 500 };
  }

  async sendRawTransaction(raw: Buffer): Promise<string> {
    this.sentRaw.push(raw.toString('base64'));
    if (this.sendThrows) throw new Error('RPC response lost after send');
    return 'sent';
  }

  async confirmTransaction(): Promise<{ value: { err: unknown } }> {
    if (this.confirmThrows) throw new Error('confirmation timed out');
    return { value: { err: this.confirmErr } };
  }

  async getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: Array<{ err: unknown; confirmationStatus?: string | null } | null> }> {
    return { value: signatures.map((s) => this.statuses.get(s) ?? null) };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let store: FakeStore;
let rpc: FakeRpc;
let alerts: AlertErrorParams[];
let logs: string[];
let clockMs: number;
let verifyKeypair: Keypair;
const realWarn = console.warn;
const realLog = console.log;

function useHarness(opts: { walletMatches?: boolean } = {}): void {
  store = new FakeStore();
  rpc = new FakeRpc();
  alerts = [];
  logs = [];
  clockMs = Date.UTC(2026, 7, 10, 12, 0, 0);
  verifyKeypair = Keypair.generate();
  const encrypted = encryptSecretKey(verifyKeypair.secretKey);
  store.clock = () => clockMs;
  store.wallet = {
    publicKey:
      opts.walletMatches === false ? Keypair.generate().publicKey.toBase58() : verifyKeypair.publicKey.toBase58(),
    ...encrypted,
  };
  _resetLandHoldVerifyDepsForTest();
  _setLandHoldVerifyDepsForTest({
    store,
    rpc: () => rpc,
    alert: async (params) => {
      alerts.push(params);
    },
    now: () => clockMs,
  });
}

beforeEach(() => {
  process.env.VANITY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  for (const key of ENV_KEYS) {
    if (key === 'VANITY_ENCRYPTION_KEY') continue;
    delete process.env[key];
  }
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  useHarness();
});

afterEach(() => {
  stopLandHoldVerifySweeper();
  console.warn = realWarn;
  console.log = realLog;
  _resetLandHoldVerifyDepsForTest();
});

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Burn `count` refunds' worth of the GLOBAL fee budget with already-settled
 * rows. `lamports` is the principal, which must NOT count against the cap.
 */
function seedRefundedFees(count: number, lamports = 1_000): void {
  const filler = pubkey();
  // Spend counts against the AUTHORIZATION day, so the fixture must carry the
  // same immutable stamp a real admission would have written.
  const capDay = new Date(clockMs).toISOString().slice(0, 10);
  for (let i = 0; i < count; i += 1) {
    store.seed({
      userId: USER_B,
      walletPubkey: filler,
      lamports,
      status: 'verified',
      inboundSignature: `prior-inbound-${i}`,
      refundState: 'sent',
      refundSignature: `prior-refund-${i}`,
      refundCapDay: capDay,
      refundCapLamports: landHoldVerifyDailyRefundCapLamports(),
      refundAuthorizedAt: new Date(clockMs),
    });
  }
}

/**
 * The exact-signature fallback flow: publish the on-chain transaction, then
 * submit its signature. Poll and sweep use separate helpers in their tests.
 */
async function payAndSubmit(
  userId: string,
  opened: { challengeId: string; lamports: number; memo?: string },
  signature: string,
  opts: Partial<Parameters<typeof publishInbound>[1]> = {},
) {
  publishInbound(signature, {
    from: opts.from ?? store.user(userId).declaredWallet!,
    to: opts.to ?? store.wallet!.publicKey,
    lamports: opts.lamports ?? opened.lamports,
    memo: opts.memo === undefined ? opened.challengeId : opts.memo,
    ...opts,
  });
  return submitTransferSignature({ userId, challengeId: opened.challengeId, signature });
}

/**
 * Move the clock past a challenge's window + the terminalize margin, so the
 * REFUND scan is allowed to touch it. The scan refuses to terminalize a live
 * challenge, because the user may still be about to submit.
 */
function closeChallengeWindow(): void {
  clockMs += landHoldVerifyTtlMs() + 6 * 60 * 1000;
}

/** Open one challenge for a freshly declared wallet. */
async function openFor(userId: string, wallet: string) {
  store.declare(userId, wallet);
  return openTransferChallenge({ userId, declaredWallet: wallet });
}

/**
 * Publish a finalized inbound transfer that settles `lamports` from `from`.
 * `memo` defaults to the challenge id so historical wire-compat cases stay easy
 * to express. Settlement deliberately ignores it.
 */
function publishInbound(
  signature: string,
  opts: {
    from: string;
    to: string;
    lamports: number;
    memo?: string | null;
    memoRaw?: boolean;
    memoInner?: boolean;
    memoProgramId?: string;
    blockTimeMs?: number | null;
    err?: unknown;
    signed?: boolean;
    inner?: boolean;
  },
): void {
  const blockTimeMs = opts.blockTimeMs === undefined ? clockMs : opts.blockTimeMs;
  rpc.signatures.unshift({
    signature,
    err: opts.err ?? null,
    confirmationStatus: 'finalized',
    blockTime: blockTimeMs == null ? null : Math.floor(blockTimeMs / 1000),
  });
  const legs: TransferLeg[] = [
    { source: opts.from, destination: opts.to, lamports: opts.lamports },
  ];
  const memoLeg: TransferLeg[] =
    opts.memo == null
      ? []
      : [{ memo: opts.memo, memoRaw: opts.memoRaw, memoProgramId: opts.memoProgramId }];
  const transferInner = opts.inner === true;
  const memoInner = opts.memoInner === true;
  rpc.txs.set(
    signature,
    parsedTx({
      err: opts.err,
      blockTimeMs,
      signers: opts.signed === false ? [pubkey()] : [opts.from],
      readonly: opts.signed === false ? [opts.from] : [],
      top: [...(transferInner ? [] : legs), ...(memoInner ? [] : memoLeg)],
      inner:
        transferInner || memoInner
          ? [...(transferInner ? legs : []), ...(memoInner ? memoLeg : [])]
          : undefined,
      opaqueTop: transferInner,
    }),
  );
}

// ===========================================================================
// T4 — mainnet RPC seam
// ===========================================================================

// ===========================================================================
// Spec §9 — FROZEN signatures. The route layer was coded against these without
// waiting, so a drift here silently breaks it. These are compile-time proofs:
// they are checked by `tsc --noEmit` (this file is inside apps/api's include).
// ===========================================================================

// `memo` and `memo_missing` remain in the frozen shapes for historical wire and
// database compatibility even though no new attribution produces that reason.
type SpecDoorAvailability = { available: boolean; destination: string | null };
type SpecOpenResult = {
  challengeId: string;
  destination: string;
  lamports: number;
  amountSol: number;
  memo: string;
  expiresAt: string;
};
type SpecStatus = {
  challengeId: string;
  state: 'pending' | 'observed' | 'verified' | 'expired' | 'failed' | 'rejected' | 'unclaimed';
  rejectedReason: 'memo_missing' | 'source_not_signer' | 'transfer_not_top_level' | null;
  refundState: 'none' | 'sending' | 'sent' | 'reconcile' | 'skipped' | null;
  inboundSignature: string | null;
  refundSignature: string | null;
  destination: string;
  lamports: number;
  memo: string;
  expiresAt: string;
};
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _doorTypeIsExact: Exact<TransferDoorAvailability, SpecDoorAvailability> = true;
const _openTypeIsExact: Exact<OpenTransferChallengeResult, SpecOpenResult> = true;
const _statusTypeIsExact: Exact<TransferChallengeStatus, SpecStatus> = true;
const _getDoorMatches: () => Promise<SpecDoorAvailability> = getTransferDoorAvailability;
const _openMatches: (input: {
  userId: string;
  declaredWallet: string;
}) => Promise<SpecOpenResult> = openTransferChallenge;
const _pollMatches: (input: {
  userId: string;
  challengeId: string;
}) => Promise<SpecStatus> = pollTransferChallenge;
const _sweepMatches: () => Promise<void> = sweepTransferChallenges;

describe('spec §9 frozen signatures', () => {
  it('exports every frozen signature with the frozen shape', () => {
    expect([
      _doorTypeIsExact,
      _openTypeIsExact,
      _statusTypeIsExact,
      typeof _getDoorMatches === 'function',
      typeof _openMatches === 'function',
      typeof _pollMatches === 'function',
      typeof _sweepMatches === 'function',
    ]).toEqual([true, true, true, true, true, true, true]);
  });

  it('carries the frozen LandHoldVerifyError constructor shape', () => {
    const err = new LandHoldVerifyError('transfer_door_unavailable', 503, { reason: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('transfer_door_unavailable');
    expect(err.status).toBe(503);
    expect(err.detail).toEqual({ reason: 'x' });
    expect(new LandHoldVerifyError('verify_attempt_cap', 429).detail).toBeUndefined();
  });
});

describe('T4 mainnet RPC seam', () => {
  it('builds the Helius mainnet endpoint from HELIUS_API_KEY', () => {
    process.env.HELIUS_API_KEY = 'test-key';
    expect(landHoldVerifyRpcUrl()).toBe('https://mainnet.helius-rpc.com/?api-key=test-key');
  });

  it('falls back to public mainnet-beta, never a devnet endpoint', () => {
    delete process.env.HELIUS_API_KEY;
    expect(landHoldVerifyRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
  });

  it('never couples to cluster-selected RPC config', () => {
    const source = readFileSync(SERVICE_PATH, 'utf8');
    // Structural, not prose: a devnet/mainnet mismatch here means real user
    // dust lands at an address we never watch.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(/\bdevnet\b/i.test(code)).toBe(false);
    expect(code.includes('mainnet.helius-rpc.com')).toBe(true);
  });
});

// ===========================================================================
// Configuration clamps (spec §6)
// ===========================================================================

describe('configuration', () => {
  it('clamps every knob to its documented floor', () => {
    process.env.LAND_HOLD_VERIFY_BASE_LAMPORTS = '1';
    process.env.LAND_HOLD_VERIFY_TTL_MS = '1000';
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0';
    process.env.LAND_HOLD_VERIFY_USER_DAILY_ATTEMPTS = '0';
    expect(landHoldVerifyBaseLamports()).toBe(1_000_000);
    expect(landHoldVerifyTtlMs()).toBe(300_000);
    expect(landHoldVerifyDailyRefundCapLamports()).toBe(10_000_000n);
    expect(landHoldVerifyUserDailyAttempts()).toBe(1);
  });

  it('uses the documented defaults when unset or unparseable', () => {
    process.env.LAND_HOLD_VERIFY_BASE_LAMPORTS = 'not-a-number';
    expect(landHoldVerifyBaseLamports()).toBe(10_000_000);
    expect(landHoldVerifyTtlMs()).toBe(2_700_000);
    expect(landHoldVerifyDailyRefundCapLamports()).toBe(500_000_000n);
    expect(landHoldVerifyUserDailyAttempts()).toBe(5);
  });
});

// ===========================================================================
// Door availability
// ===========================================================================

describe('transfer door availability', () => {
  it('reports the provisioned verify address', async () => {
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: true,
      destination: store.wallet!.publicKey,
    });
  });

  it('reports unavailable when the verify wallet is unprovisioned and refuses to open', async () => {
    store.wallet = null;
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: false,
      destination: null,
    });
    store.declare(USER_A, pubkey());
    const wallet = store.user(USER_A).declaredWallet!;
    await expect(openTransferChallenge({ userId: USER_A, declaredWallet: wallet })).rejects.toMatchObject(
      { code: 'transfer_door_unavailable', status: 503 },
    );
  });

  it('fails soft to unavailable when the treasury read throws', async () => {
    store.failWalletLookup = true;
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: false,
      destination: null,
    });
  });
});

// ===========================================================================
// Opening a challenge
// ===========================================================================

describe('openTransferChallenge', () => {
  it('mints an exact dust amount bound to the declared wallet', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    expect(opened.destination).toBe(store.wallet!.publicKey);
    expect(opened.lamports).toBeGreaterThan(10_000_000);
    expect(opened.lamports).toBeLessThanOrEqual(10_000_000 + 9_999);
    expect(opened.amountSol).toBeCloseTo(opened.lamports / LAMPORTS_PER_SOL, 12);
    expect(new Date(opened.expiresAt).getTime()).toBe(clockMs + 2_700_000);
    expect(store.row(opened.challengeId).walletPubkey).toBe(wallet);
  });

  it('refuses when the account has not declared that wallet', async () => {
    store.declare(USER_A, pubkey());
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: pubkey() }),
    ).rejects.toMatchObject({ code: 'wallet_not_declared', status: 403 });
  });

  it('refuses a syntactically invalid wallet without touching the store', async () => {
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: 'not-a-pubkey' }),
    ).rejects.toMatchObject({ code: 'wallet_not_declared', status: 403 });
    expect(store.rows).toHaveLength(0);
  });
});

// ===========================================================================
// T5 — drain guard
// ===========================================================================

describe('T5 drain guard', () => {
  it('refuses the per-user daily attempt over the cap and pages ops once', async () => {
    process.env.LAND_HOLD_VERIFY_USER_DAILY_ATTEMPTS = '3';
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    for (let i = 0; i < 3; i += 1) {
      await openTransferChallenge({ userId: USER_A, declaredWallet: wallet });
    }
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
    ).rejects.toMatchObject({ code: 'verify_attempt_cap', status: 429 });
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
    ).rejects.toMatchObject({ code: 'verify_attempt_cap', status: 429 });
    expect(store.rows).toHaveLength(3);
    expect(alerts.filter((a) => a.message.includes('attempt cap'))).toHaveLength(1);
  });

  it('counts the cap per user, so one user cannot lock another out', async () => {
    process.env.LAND_HOLD_VERIFY_USER_DAILY_ATTEMPTS = '1';
    const a = pubkey();
    const b = pubkey();
    store.declare(USER_A, a);
    store.declare(USER_B, b);
    await openTransferChallenge({ userId: USER_A, declaredWallet: a });
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: a }),
    ).rejects.toMatchObject({ code: 'verify_attempt_cap' });
    await expect(
      openTransferChallenge({ userId: USER_B, declaredWallet: b }),
    ).resolves.toMatchObject({ destination: store.wallet!.publicKey });
  });

  it('counts ONLY our fee against the global cap, never the refunded principal', async () => {
    // Adversarial review 2026-08-10: counting the principal capped throughput at
    // ~49 refunds a day on the 0.5 SOL default, which ten accounts at the
    // per-user cap could saturate — parking ordinary users' money for a day.
    // The principal comes straight back to the sender; our cost is the fee.
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.01'; // 10_000_000 lamports
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // 10 SOL of already-refunded PRINCIPAL, a thousand times the cap.
    seedRefundedFees(10, LAMPORTS_PER_SOL);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: LAMPORTS_PER_SOL,
      status: 'observed',
      inboundSignature: 'inbound-big-principal',
    });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
    expect(alerts.filter((a) => a.message.includes('refund-fee cap'))).toHaveLength(0);
  });

  it('the global daily refund cap defers the send, pages ops, and never revokes verification', async () => {
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.01'; // 10_000_000 lamports
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // Exactly the whole rolling-24h FEE budget: 2000 refunds x 5000 lamports.
    seedRefundedFees(Number(10_000_000n / REFUND_FEE_LAMPORTS));
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: 1_000_500,
      status: 'verified',
      inboundSignature: 'inbound-capped',
    });
    store.user(USER_A).verifiedPubkey = wallet;

    await sweepTransferChallenges();

    // Deferred, not abandoned: no claim was taken, so the row heals itself.
    expect(store.row(target.id).refundState).toBe('none');
    expect(store.row(target.id).refundClaimId).toBeNull();
    expect(rpc.sentRaw).toHaveLength(0);
    expect(alerts.some((a) => a.severity === 'critical' && a.message.includes('refund-fee cap'))).toBe(true);

    // Once the next AUTHORIZATION day opens, the deferred refund goes out.
    clockMs += DAY_MS + 60_000;
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it('admits a refund that fits under the cap', async () => {
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.01';
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: 1_000_500,
      status: 'observed',
      inboundSignature: 'inbound-fits',
    });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });
});

// ===========================================================================
// T6 — exact-amount uniqueness
// ===========================================================================

describe('T6 exact-amount uniqueness', () => {
  it('regenerates a distinct amount on every collision', async () => {
    const offered: number[] = [];
    const result = await insertWithUniqueAmount(10_000_000, async (lamports) => {
      offered.push(lamports);
      return offered.length < 4 ? null : { lamports };
    });
    expect(result).toEqual({ lamports: offered[3]! });
    expect(offered).toHaveLength(4);
    expect(new Set(offered).size).toBe(4);
    for (const lamports of offered) {
      expect(lamports).toBeGreaterThan(10_000_000);
      expect(lamports).toBeLessThanOrEqual(10_009_999);
    }
  });

  it('gives up rather than reusing an amount when the space is saturated', async () => {
    let attempts = 0;
    const result = await insertWithUniqueAmount(
      1_000_000,
      async () => {
        attempts += 1;
        return null;
      },
      5,
    );
    expect(result).toBeNull();
    expect(attempts).toBe(5);
  });

  it('surfaces exhaustion as an unavailable door plus a critical page, never a reused amount', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // Saturate every candidate amount: the fake index rejects them all.
    const original = store.openChallenge.bind(store);
    store.openChallenge = async (input) => {
      const seen: number[] = [];
      const row = await insertWithUniqueAmount(input.baseLamports, async (lamports) => {
        seen.push(lamports);
        return null;
      });
      expect(row).toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      return { kind: 'amount_exhausted' };
    };
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
    ).rejects.toMatchObject({ code: 'transfer_door_unavailable', status: 503 });
    expect(alerts.some((a) => a.severity === 'critical')).toBe(true);
    store.openChallenge = original;
  });

  it('two concurrent challenges from the SAME sender get different amounts and attribute independently', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const [first, second] = await Promise.all([
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
    ]);
    expect(first.lamports).not.toBe(second.lamports);
    expect(first.challengeId).not.toBe(second.challengeId);

    // Only the SECOND challenge's amount is paid, and submitted.
    await payAndSubmit(USER_A, second, sig('sig-second'));

    expect(store.row(second.challengeId).status).toBe('verified');
    expect(store.row(second.challengeId).inboundSignature).toBe(sig('sig-second'));
    expect(store.row(first.challengeId).status).toBe('pending');
    expect(store.row(first.challengeId).inboundSignature).toBeNull();

    // Now the first amount is paid too, by a different signature.
    await payAndSubmit(USER_A, first, sig('sig-first'));
    expect(store.row(first.challengeId).status).toBe('verified');
    expect(store.row(first.challengeId).inboundSignature).toBe(sig('sig-first'));
  });
});

// ===========================================================================
// Attribution
// ===========================================================================

describe('attribution', () => {
  const CHALLENGE_ID = '00000000-0000-4000-8000-0000000abcde';

  it('settles on an exact single-instruction transfer signed by the declared wallet', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  it('IDENTIFIES a transfer nested in inner instructions, without treating it as proof', () => {
    // Inner legs must still be recognised so the money can be refunded; they
    // just cannot establish that the signer authored the payment.
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        opaqueTop: true,
        top: [{ source: from, destination: pubkey(), lamports: 1 }, { memo: CHALLENGE_ID }],
        inner: [
          { source: from, destination: pubkey(), lamports: 42 },
          { source: from, destination: to, lamports: 10_000_123 },
        ],
      }),
    );
    expect(transactionMatchesTransferLeg(probe, { from, to, lamports: 10_000_123 })).toBe(true);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('rejects an off-by-one lamport amount', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_122 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('rejects the same amount sent by a DIFFERENT wallet (wrong sender)', () => {
    const declared = pubkey();
    const attacker = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [attacker],
        top: [
          { source: attacker, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from: declared,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('rejects a transfer to a destination that is not our verify address', () => {
    const from = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: pubkey(), lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to: pubkey(),
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('rejects a FAILED transaction even when the transfer leg matches exactly', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        err: { InstructionError: [0, 'Custom'] },
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('rejects a matching transfer when the declared wallet did not sign', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [pubkey()],
        readonly: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('ignores transferWithSeed, whose source is signed for by a different base key', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { type: 'transferWithSeed', source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
      }),
    );
    expect(probe!.transfers).toHaveLength(0);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('settles an exact, correctly signed transfer that carries no memo', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({ signers: [from], top: [{ source: from, destination: to, lamports: 10_000_123 }] }),
    );
    expect(probe!.memos).toHaveLength(0);
    expect(transactionMatchesTransferLeg(probe, { from, to, lamports: 10_000_123 })).toBe(true);
    expect(transactionSignedBySource(probe, from)).toBe(true);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  it("ignores a different challenge's memo", () => {
    const from = pubkey();
    const to = pubkey();
    const other = '00000000-0000-4000-8000-0000000fedcb';
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [{ source: from, destination: to, lamports: 10_000_123 }, { memo: other }],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  // INVERTED 2026-08-10 (Codex adversarial money review). This case previously
  // asserted that an INNER memo proves intent. It does not, and accepting it
  // reopened the exact phishing hole the memo exists to close: an attacker who
  // declares a victim's wallet can induce the victim to sign an opaque call to
  // an attacker-controlled program, which CPIs BOTH the exact transfer AND a
  // memo naming the challenge. The victim never saw a memo. Only what the signer
  // put in the message they signed can be their statement of intent.
  it('ignores a CPI-emitted memo when the transfer itself is top level', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        opaqueTop: true,
        top: [{ source: from, destination: to, lamports: 10_000_123 }],
        inner: [{ memo: CHALLENGE_ID, memoRaw: true }],
      }),
    );
    // The memo remains parsed for historical scan facts but is not a predicate.
    expect(probe!.memos).toEqual([{ text: CHALLENGE_ID, topLevel: false }]);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  it('accepts a TOP-LEVEL memo in raw base58 form', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID, memoRaw: true },
        ],
      }),
    );
    expect(probe!.memos).toEqual([{ text: CHALLENGE_ID, topLevel: true }]);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  it('REFUSES a CPI-emitted transfer leg even with a top-level memo', () => {
    // The memo is the signer's, but the payment was emitted by a program they
    // invoked. Proof must be theirs end to end.
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        opaqueTop: true,
        top: [{ memo: CHALLENGE_ID }],
        inner: [{ source: from, destination: to, lamports: 10_000_123 }],
      }),
    );
    // Still IDENTIFIED, so the money is refundable...
    expect(transactionMatchesTransferLeg(probe, { from, to, lamports: 10_000_123 })).toBe(true);
    // ...but never proof.
    expect(transactionHasTopLevelTransferLeg(probe, { from, to, lamports: 10_000_123 })).toBe(
      false,
    );
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(false);
  });

  it('sums EVERY leg from the sender, so a double-paid transfer is fully refundable', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          { source: from, destination: to, lamports: 10_000_123 },
          { memo: CHALLENGE_ID },
        ],
        inner: [{ source: from, destination: to, lamports: 500 }],
      }),
    );
    expect(receivedLamportsFrom(probe, { from, to })).toBe(20_000_746);
    expect(receivedLamportsFrom(probe, { from, to: pubkey() })).toBe(0);
  });

  it('parses a decorated memo from the v1 program but does not depend on it', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10_000_123 },
          {
            memo: `ClawVille verify ${CHALLENGE_ID.toUpperCase()} `,
            memoProgramId: MEMO_PROGRAM_V1,
          },
        ],
      }),
    );
    expect(probe!.memos).toEqual([
      { text: `ClawVille verify ${CHALLENGE_ID.toUpperCase()} `, topLevel: true },
    ]);
    expect(
      transactionSettlesChallenge(probe, {
        from,
        to,
        lamports: 10_000_123,
        challengeId: CHALLENGE_ID,
      }),
    ).toBe(true);
  });

  it('does not use the challenge id as a settlement predicate', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [{ source: from, destination: to, lamports: 1 }, { memo: 'anything at all' }],
      }),
    );
    expect(
      transactionSettlesChallenge(probe, { from, to, lamports: 1, challengeId: '' }),
    ).toBe(true);
  });

  it('ignores a non-system program that mimics the parsed transfer shape', () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [{ program: 'spl-token', source: from, destination: to, lamports: 10_000_123 }],
      }),
    );
    expect(probe!.transfers).toHaveLength(0);
  });

  it('accepts only block times inside the challenge window', () => {
    const row = {
      createdAt: new Date(1_000_000),
      expiresAt: new Date(1_000_000 + 60_000),
    };
    expect(blockTimeInsideWindow(1_030_000, row)).toBe(true);
    expect(blockTimeInsideWindow(1_000_000 - 90_000, row)).toBe(false);
    expect(blockTimeInsideWindow(1_060_000 + 90_000, row)).toBe(false);
    expect(blockTimeInsideWindow(null, row)).toBe(false);
  });
});

// ===========================================================================
// T7 — one signature, one challenge
// ===========================================================================

describe('T7 one signature, one challenge', () => {
  it('a repeated scan of the same signature is a no-op', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('sig-once'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    closeChallengeWindow();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).inboundSignature).toBe(sig('sig-once'));
    // BigInt-safe snapshot: the cap stamp is a bigint column.
    const snapshot = () =>
      JSON.stringify(store.rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const before = snapshot();
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    expect(snapshot()).toBe(before);
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it('one signature cannot satisfy a second challenge with the same amount', async () => {
    const wallet = pubkey();
    const first = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_777 });
    const second = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_777 });
    store.declare(USER_A, wallet);
    // The explicit challenge id selects the row; the atomic signature guard
    // still prevents the same transfer from satisfying the other row.
    publishInbound(sig('sig-shared'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: 10_000_777,
      memo: second.id,
    });
    await submitTransferSignature({
      userId: USER_A,
      challengeId: second.id,
      signature: sig('sig-shared'),
    });
    const bound = [first, second].filter((r) => store.row(r.id).inboundSignature === sig('sig-shared'));
    expect(bound).toHaveLength(1);
    expect(bound[0]!.id).toBe(second.id);
    expect(store.row(second.id).status).toBe('verified');
    expect(store.row(first.id).status).toBe('pending');
    // T7 — the SAME signature can never settle the other row.
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: first.id,
        signature: sig('sig-shared'),
      }),
    ).rejects.toMatchObject({ code: 'signature_already_used', status: 409 });
  });

  it('binds one signature at most once across a poll and submit race', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const polled = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_888 });
    const submitted = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_888 });
    publishInbound(sig('poll-submit-race'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: 10_000_888,
      memo: null,
    });

    await Promise.allSettled([
      pollTransferChallenge({ userId: USER_A, challengeId: polled.id }),
      submitTransferSignature({
        userId: USER_A,
        challengeId: submitted.id,
        signature: sig('poll-submit-race'),
      }),
    ]);

    const bound = [polled, submitted].filter(
      (row) => store.row(row.id).inboundSignature === sig('poll-submit-race'),
    );
    expect(bound).toHaveLength(1);
    expect([store.row(polled.id).status, store.row(submitted.id).status]).toContain('verified');
  });

  it('pages ops when one transaction pays two challenges, so the unsettled dust is not silently kept', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const first = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_111 });
    const second = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_222 });
    rpc.signatures.unshift({
      signature: sig('sig-two-legs'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sig-two-legs'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: 10_000_111 },
          { source: wallet, destination: store.wallet!.publicKey, lamports: 10_000_222 },
          { memo: first.id },
        ],
      }),
    );
    await submitTransferSignature({
      userId: USER_A,
      challengeId: first.id,
      signature: sig('sig-two-legs'),
    });
    const settled = [first, second].filter((r) => store.row(r.id).inboundSignature != null);
    expect(settled).toHaveLength(1);
    // Both legs came from the SAME sender, so the received-total refund returns
    // all of it; nothing is retained and no obligation is needed.
    expect(store.row(first.id).inboundLamports).toBe(10_000_111 + 10_000_222);
    expect(store.obligations.size).toBe(0);
  });
});

// ===========================================================================
// T8 — finalized only
// ===========================================================================

describe('T8 finalized only', () => {
  it('reads signatures and transactions at finalized commitment', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('sig-finalized'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    await sweepTransferChallenges();
    expect(rpc.commitments).toContain('signatures:finalized');
    expect(rpc.commitments).toContain('tx:finalized');
    expect(rpc.commitments.every((c) => c.endsWith(':finalized'))).toBe(true);
  });

  it('never grants on a merely confirmed signature', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({ signature: sig('sig-confirmed'), err: null, confirmationStatus: 'confirmed' });
    rpc.txs.set(
      sig('sig-confirmed'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { memo: opened.challengeId },
        ],
      }),
    );
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('pending');
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
  });

  it('an expired-TTL challenge is refunded but NEVER verified', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // Well past the TTL (beyond the 60s block-time skew tolerance) but inside
    // the late-arrival grace window, so the money is still refunded.
    clockMs += landHoldVerifyTtlMs() + 5 * 60 * 1000;
    await payAndSubmit(USER_A, opened, sig('sig-late'), { blockTimeMs: clockMs });
    await sweepTransferChallenges();
    const row = store.row(opened.challengeId);
    expect(row.status).toBe('expired');
    expect(row.inboundSignature).toBe(sig('sig-late'));
    expect(store.user(USER_A).verifiedAt).toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
    // Fail SOFT on the money: the dust still goes home.
    expect(row.refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it('still verifies a transfer that lands inside the block-time skew tolerance', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    clockMs += landHoldVerifyTtlMs() + 30_000; // 30s late — inside the 60s skew
    await payAndSubmit(USER_A, opened, sig('sig-skew'), { blockTimeMs: clockMs });
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('expires a lapsed challenge with nothing attributed', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    clockMs += landHoldVerifyTtlMs() + 1_000;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('expired');
    expect(store.row(opened.challengeId).refundState).toBe('none');
    expect(rpc.sentRaw).toHaveLength(0);
  });
});

// ===========================================================================
// T9 — fail closed on the grant, fail soft on the refund
// ===========================================================================

describe('T9 grant and refund discipline', () => {
  it('grants verification with method transfer bound to the declared pubkey', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const status = await payAndSubmit(USER_A, opened, sig('sig-grant'));
    expect(status.state).toBe('verified');
    expect(status.inboundSignature).toBe(sig('sig-grant'));
    const user = store.user(USER_A);
    expect(user.verifiedMethod).toBe('transfer');
    expect(user.verifiedPubkey).toBe(wallet);
    expect(user.verifiedAt).not.toBeNull();
    // T2 — application code never writes a non-null grandfather stamp.
    expect(user.grandfatheredPubkey).toBeNull();
  });

  it('recovers an observed row on the next poll after the first grant attempt fails', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const realGrant = store.grantVerification.bind(store);
    let failOnce = true;
    store.grantVerification = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('grant unavailable');
      }
      return realGrant(input);
    };

    await expect(payAndSubmit(USER_A, opened, sig('grant-recover-poll'))).rejects.toThrow(
      'grant unavailable',
    );
    expect(store.row(opened.challengeId).status).toBe('observed');

    const status = await pollTransferChallenge({
      userId: USER_A,
      challengeId: opened.challengeId,
    });
    expect(status.state).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('recovers an observed row on the next sweep when the panel is closed', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const realGrant = store.grantVerification.bind(store);
    let failOnce = true;
    store.grantVerification = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('grant unavailable');
      }
      return realGrant(input);
    };

    await expect(payAndSubmit(USER_A, opened, sig('grant-recover-sweep'))).rejects.toThrow(
      'grant unavailable',
    );
    expect(store.row(opened.challengeId).status).toBe('observed');

    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('fails CLOSED when the declaration changed under an in-flight proof, and still refunds', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('sig-changed'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    store.user(USER_A).declaredWallet = pubkey(); // repointed mid-flight
    await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('sig-changed'),
    });
    await sweepTransferChallenges();
    const row = store.row(opened.challengeId);
    expect(row.status).toBe('failed');
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
    expect(row.refundState).toBe('sent');
    expect(alerts.some((a) => a.message.includes('declaration changed'))).toBe(true);
  });

  it('captures the refund signature BEFORE any send', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-capture-order',
    });
    const order: string[] = [];
    const realCapture = store.captureRefundSignature.bind(store);
    store.captureRefundSignature = async (input) => {
      order.push('captured');
      return realCapture(input);
    };
    rpc.sendRawTransaction = async (raw: Buffer) => {
      order.push('sent');
      rpc.sentRaw.push(raw.toString('base64'));
      return 'sent';
    };
    await sweepTransferChallenges();
    expect(order).toEqual(['captured', 'sent']);
    expect(store.row(target.id).refundSignature).not.toBeNull();
    expect(store.row(target.id).refundState).toBe('sent');
  });

  it('refunds exactly once across repeated sweeps (idempotent replay)', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-idempotent',
    });
    await sweepTransferChallenges();
    const signature = store.row(target.id).refundSignature;
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    expect(rpc.sentRaw).toHaveLength(1);
    expect(store.row(target.id).refundSignature).toBe(signature);
    expect(store.row(target.id).refundState).toBe('sent');
  });

  it('an ambiguous send goes to reconcile, pages ops, and is NEVER re-sent', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-ambiguous',
    });
    rpc.sendThrows = true;
    await sweepTransferChallenges();

    // Captured but unresolved: still `sending`, still owning the exact bytes.
    expect(store.row(target.id).refundState).toBe('sending');
    expect(store.row(target.id).refundSignature).not.toBeNull();
    expect(rpc.sentRaw).toHaveLength(1);
    expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(0);

    // Inside the resolve window the chain-check simply repeats.
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sending');
    expect(rpc.sentRaw).toHaveLength(1);

    // Past the resolve window with no signature history: quarantine + page.
    clockMs += 11 * 60 * 1000;
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('reconcile');
    expect(rpc.sentRaw).toHaveLength(1);
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('never re-sent')),
    ).toBe(true);

    // And a terminal reconcile row is never picked up again.
    await sweepTransferChallenges();
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it('an ambiguous send that actually LANDED resolves to sent without a second send', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-landed',
    });
    rpc.sendThrows = true;
    await sweepTransferChallenges();
    const signature = store.row(target.id).refundSignature!;
    rpc.statuses.set(signature, { err: null, confirmationStatus: 'finalized' });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it('a refund that landed REVERTED quarantines to reconcile rather than re-sending', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-reverted',
    });
    rpc.confirmErr = { InstructionError: [0, 'Custom'] };
    rpc.statuses.set('placeholder', null);
    await sweepTransferChallenges();
    const signature = store.row(target.id).refundSignature!;
    rpc.statuses.set(signature, { err: { InstructionError: [0, 'Custom'] } });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('reconcile');
    expect(rpc.sentRaw).toHaveLength(1);
    expect(alerts.some((a) => a.message.includes('reverted'))).toBe(true);
  });

  it('a refund failure never revokes an already-granted verification', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('sig-refund-fails'));
    rpc.sendThrows = true;
    await sweepTransferChallenges();
    clockMs += 11 * 60 * 1000;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('reconcile');
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('refuses to refund from a ROTATED verify wallet rather than spending the wrong treasury', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // The dust was paid to the PREVIOUS verify address; the live keypair is a
    // different treasury wallet, so it must never sign this refund.
    const paidTo = pubkey();
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: paidTo,
      status: 'observed',
      inboundSignature: 'inbound-rotated',
    });
    await sweepTransferChallenges();
    expect(rpc.sentRaw).toHaveLength(0);
    expect(store.row(target.id).refundState).toBe('skipped');
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('no longer matches')),
    ).toBe(true);
  });

  it('refuses to sign when the decrypted key does not match the stored public key', async () => {
    useHarness({ walletMatches: false });
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-mismatch',
    });
    await sweepTransferChallenges();
    expect(rpc.sentRaw).toHaveLength(0);
    expect(store.row(target.id).refundState).toBe('none');
    expect(store.row(target.id).refundClaimId).toBeNull();
    expect(logs.some((l) => l.includes('refusing to sign'))).toBe(true);
  });
});

// ===========================================================================
// Founder ruling 2026-08-11 — memo is deprecated and ignored
// ===========================================================================

describe('memo compatibility, end to end', () => {
  it('settles an exact transfer with no memo and refunds it', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const submitted = await payAndSubmit(USER_A, opened, sig('sig-no-memo'), { memo: null });
    expect(submitted.state).toBe('verified');
    expect(submitted.rejectedReason).toBeNull();
    await sweepTransferChallenges();

    const row = store.row(opened.challengeId);
    expect(row.status).toBe('verified');
    expect(row.rejectedReason).toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
    expect(row.inboundSignature).toBe(sig('sig-no-memo'));
    expect(row.refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });

  it("settles a transfer carrying another challenge's memo", async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('sig-wrong-memo'), {
      memo: '00000000-0000-4000-8000-0000000c0ffe',
    });
    await sweepTransferChallenges();

    const row = store.row(opened.challengeId);
    expect(row.status).toBe('verified');
    expect(row.rejectedReason).toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
    expect(row.refundState).toBe('sent');
  });

  it('ignores a CPI-emitted memo and settles the top-level transfer', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('sig-inner-memo'), {
      memoRaw: true,
      memoInner: true,
    });
    await sweepTransferChallenges();
    const row = store.row(opened.challengeId);
    expect(row.status).toBe('verified');
    expect(row.rejectedReason).toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
    expect(row.refundState).toBe('sent');
  });

  it('accepts a TOP-LEVEL memo end to end', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('sig-top-memo'), { memoRaw: true });
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('publishes the memo on the open result, the poll status and the challenge id', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    expect(opened.memo).toBe(challengeMemo(opened.challengeId));
    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status.memo).toBe(opened.memo);
    expect(status.rejectedReason).toBeNull();
  });

  it('tells a smart-wallet holder their wallet cannot be verified, instead of hanging pending', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // A Squads-style vault: the source is the declared wallet but a PROGRAM
    // signed for it, so the key holder never proved anything.
    await payAndSubmit(USER_A, opened, sig('sig-program-signed'), { signed: false });
    await sweepTransferChallenges();

    const row = store.row(opened.challengeId);
    expect(row.status).toBe('rejected');
    expect(row.rejectedReason).toBe('source_not_signer');
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
    expect(row.refundState).toBe('sent');
    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status.state).toBe('rejected');
    expect(status.rejectedReason).toBe('source_not_signer');
  });
});

// ===========================================================================
// RPC amplification + lease age (adversarial review 2026-08-10)
// ===========================================================================

describe('scan cost control', () => {
  it('keeps live polls from re-parsing signatures with an active defer', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const signature = sig('live-poll-active-parse-defer');
    publishInbound(signature, {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let parseCalls = 0;
    rpc.getParsedTransaction = async (candidate, config) => {
      parseCalls += 1;
      if (parseCalls === 1) return null;
      return realGetParsedTransaction(candidate, config);
    };

    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(parseCalls).toBe(1);
    expect(store.row(opened.challengeId).status).toBe('pending');

    clockMs += 5_001;
    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(parseCalls).toBe(1);
    expect([...store.scans.values()].some((entry) => entry.signature === signature)).toBe(false);
    expect(store.row(opened.challengeId).status).toBe('pending');
  });

  it('aborts the remaining harvest parse batch after a 429', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('parse-429-first'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
    });
    publishInbound(sig('parse-429-second'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
    });
    let parseCalls = 0;
    rpc.getParsedTransaction = async () => {
      parseCalls += 1;
      throw new Error('429 rate limit');
    };

    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(parseCalls).toBe(1);
    expect(store.row(opened.challengeId).status).toBe('pending');
  });

  it('shares one in-flight destination harvest across concurrent polls', async () => {
    const walletA = pubkey();
    const walletB = pubkey();
    const first = await openFor(USER_A, walletA);
    store.declare(USER_B, walletB);
    const second = await openTransferChallenge({ userId: USER_B, declaredWallet: walletB });
    let harvestCalls = 0;
    let releaseHarvest!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHarvest = resolve;
    });
    rpc.getSignaturesForAddress = async () => {
      harvestCalls += 1;
      signalStarted();
      await release;
      return [];
    };

    const firstPoll = pollTransferChallenge({ userId: USER_A, challengeId: first.challengeId });
    await started;
    const secondPoll = pollTransferChallenge({ userId: USER_B, challengeId: second.challengeId });
    releaseHarvest();
    await Promise.all([firstPoll, secondPoll]);

    expect(harvestCalls).toBe(1);
    expect(store.row(first.challengeId).status).toBe('pending');
    expect(store.row(second.challengeId).status).toBe('pending');
  });

  it('runs the broad seven-day harvest between narrow polls inside the destination floor', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('broad-after-narrow'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs - 6 * DAY_MS,
    });
    let harvestCalls = 0;
    const realGetSignaturesForAddress = rpc.getSignaturesForAddress.bind(rpc);
    rpc.getSignaturesForAddress = async (...args) => {
      harvestCalls += 1;
      return realGetSignaturesForAddress(...args);
    };

    // The live poll's narrow window sees the page but correctly skips parsing
    // the ancient transfer. It must not throttle the broader orphan sweep.
    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(store.obligations.size).toBe(0);
    await sweepTransferChallenges();
    expect(store.obligations.size).toBe(1);
    expect(harvestCalls).toBe(2);

    // Another narrow poll immediately after the broad pass is covered by it.
    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(harvestCalls).toBe(2);
  });

  it('bounds and lazily prunes completed harvest windows across one-off destinations', async () => {
    const wallet = pubkey();
    const destinationFor = (index: number): string => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(index + 1, 0);
      return bs58.encode(bytes);
    };

    for (let index = 0; index < 1_025; index += 1) {
      const row = store.seed({
        userId: USER_A,
        walletPubkey: wallet,
        destinationPubkey: destinationFor(index),
      });
      await pollTransferChallenge({ userId: USER_A, challengeId: row.id });
    }
    expect(_landHoldVerifyCompletedHarvestSizeForTest()).toBe(1_024);

    clockMs += 5_001;
    const next = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: destinationFor(1_025),
    });
    await pollTransferChallenge({ userId: USER_A, challengeId: next.id });
    expect(_landHoldVerifyCompletedHarvestSizeForTest()).toBe(1);
  });

  it('skips signatures outside the candidate window before spending a parse', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // Five unrelated transactions from LONG before this challenge existed.
    for (let i = 0; i < 5; i += 1) {
      rpc.signatures.push({
        signature: `sig-ancient-${i}`,
        err: null,
        confirmationStatus: 'finalized',
        blockTime: Math.floor((clockMs - 7 * DAY_MS) / 1000),
      });
      rpc.txs.set(
        `sig-ancient-${i}`,
        parsedTx({
          blockTimeMs: clockMs - 7 * DAY_MS,
          signers: [pubkey()],
          top: [{ source: pubkey(), destination: store.wallet!.publicKey, lamports: 12_345 }],
        }),
      );
    }
    await sweepTransferChallenges();
    clockMs += 5_001;
    await sweepTransferChallenges();
    // The CHALLENGE scan spends no parse on them (out of its window). The
    // obligation sweep does parse them once, because money that old can no
    // longer belong to any live challenge and has to be recorded as owed.
    expect(store.obligations.size).toBe(5);

    // A real payment inside the window is still parsed and settled.
    publishInbound(sig('sig-in-window'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    const parsedBefore = rpc.commitments.filter((c) => c === 'tx:finalized').length;
    closeChallengeWindow();
    await sweepTransferChallenges();
    // One harvest parse records the payment, then the shared attribution path
    // performs one authoritative full fetch. Ancient facts are already stored.
    expect(rpc.commitments.filter((c) => c === 'tx:finalized')).toHaveLength(parsedBefore + 2);
    // The closed scan full-fetches and settles through the shared attribution.
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('parses an OUTBOUND in-window signature once, however many passes run', async () => {
    const wallet = pubkey();
    await openFor(USER_A, wallet);
    // Outbound from the verify wallet — the shape of every refund we send. It
    // moves nothing TO the verify address, so it can never settle anything and
    // the decision is permanent.
    rpc.signatures.push({
      signature: sig('sig-outbound'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sig-outbound'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [store.wallet!.publicKey],
        top: [{ source: store.wallet!.publicKey, destination: pubkey(), lamports: 777 }],
      }),
    );
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    expect(rpc.commitments.filter((c) => c === 'tx:finalized')).toHaveLength(1);
    // Recorded in the DURABLE ledger, so the decision survives a restart too.
    expect(store.scans.size).toBe(1);
  });

  it('never caches an INBOUND miss, so another user’s payment is not blinded', async () => {
    // The poll path scans with a SINGLE candidate row and the sweeper is
    // bounded, so a transfer to the verify address that matches no row in THIS
    // pass may simply belong to a row this pass did not hold.
    const walletA = pubkey();
    const walletB = pubkey();
    const first = await openFor(USER_A, walletA);
    store.declare(USER_B, walletB);
    const second = await openTransferChallenge({ userId: USER_B, declaredWallet: walletB });
    publishInbound(sig('sig-other-user'), {
      from: walletB,
      to: store.wallet!.publicKey,
      lamports: second.lamports,
      memo: second.challengeId,
    });

    // A poll that only knows about USER_A's challenge sees the payment and must
    // NOT write it off.
    await pollTransferChallenge({ userId: USER_A, challengeId: first.challengeId });

    closeChallengeWindow();
    await sweepTransferChallenges();
    expect(store.row(second.challengeId).status).toBe('verified');
    expect(store.row(second.challengeId).inboundSignature).toBe(sig('sig-other-user'));
  });

  it('never re-parses our OWN refund, which lands on the verify address', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-own-refund',
    });
    await sweepTransferChallenges();
    const refundSignature = store.row(target.id).refundSignature!;
    expect(refundSignature).toBeTruthy();
    // The refund now shows up in the destination's signature page.
    rpc.signatures.unshift({
      signature: refundSignature,
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    const parsedBefore = rpc.commitments.filter((c) => c === 'tx:finalized').length;
    store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_321 });
    await sweepTransferChallenges();
    expect(rpc.commitments.filter((c) => c === 'tx:finalized')).toHaveLength(parsedBefore);
  });

  it('ages the resolve window from the lease it JUST took, not a pre-takeover stamp', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-stale-lease',
      // A crashed worker's ancient lease. `listRefundableChallenges` has no
      // upper age bound, so this row is picked up and its claim taken over.
      refundClaimId: '11111111-1111-4111-8111-111111111111',
      refundClaimedAt: new Date(clockMs - 6 * 60 * 60 * 1000),
    });
    rpc.sendThrows = true;
    await sweepTransferChallenges();

    // The ambiguous send must stay `sending` for the resolve window rather than
    // being finished as terminal `reconcile` on the very first pass.
    expect(store.row(target.id).refundState).toBe('sending');
    expect(alerts.filter((a) => a.severity === 'critical')).toHaveLength(0);

    // And it still quarantines once the window really has elapsed.
    clockMs += 11 * 60 * 1000;
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('reconcile');
    expect(rpc.sentRaw).toHaveLength(1);
  });
});

// ===========================================================================
// Amount reuse + multiple verify destinations (adversarial review 2026-08-10)
// ===========================================================================

describe('amount reuse and destination rotation', () => {
  it('never re-issues an amount a lapsed row is still being scanned for', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // Lapsed, unpaid, and still inside the late-arrival grace window, so the
    // sweeper is STILL watching for this exact amount.
    const lapsed = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: 10_000_808,
      status: 'expired',
      expiresAt: new Date(clockMs - 60_000),
    });
    let offered = 0;
    const outcome = await store.openChallenge({
      userId: USER_A,
      declaredWallet: wallet,
      destination: store.wallet!.publicKey,
      // Every draw is base + 1..9999, so the only candidate is the taken amount.
      baseLamports: lapsed.lamports - 1,
      ttlMs: 60_000,
      attemptCap: 99,
      graceMs: 30 * 60 * 1000,
    });
    if (outcome.kind === 'ok') offered = outcome.row.lamports;
    expect(offered).not.toBe(lapsed.lamports);
  });

  it('gives one transfer to the NEWEST matching challenge, not the lapsed one', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const lapsed = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: 10_000_909,
      status: 'expired',
      createdAt: new Date(clockMs - 60 * 60 * 1000),
      expiresAt: new Date(clockMs - 15 * 60 * 1000),
    });
    const fresh = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      lamports: 10_000_909,
      status: 'pending',
    });
    publishInbound(sig('sig-newest-wins'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: 10_000_909,
      memo: fresh.id,
    });
    closeChallengeWindow();
    await sweepTransferChallenges();
    expect(store.row(fresh.id).inboundSignature).toBe(sig('sig-newest-wins'));
    expect(store.row(fresh.id).status).toBe('verified');
    expect(store.row(lapsed.id).inboundSignature).toBeNull();
  });

  it('scans EVERY destination, so dust paid to a retired verify address is not stranded', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const retired = pubkey();
    const oldRow = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: retired,
      lamports: 10_000_444,
    });
    const currentRow = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: store.wallet!.publicKey,
      lamports: 10_000_555,
    });
    const scanned: string[] = [];
    rpc.getSignaturesForAddress = async (address: unknown) => {
      scanned.push(String(address));
      return rpc.signatures;
    };
    publishInbound(sig('sig-retired-destination'), {
      from: wallet,
      to: retired,
      lamports: oldRow.lamports,
      memo: oldRow.id,
    });
    closeChallengeWindow();
    await sweepTransferChallenges();

    expect(scanned).toContain(retired);
    expect(scanned).toContain(store.wallet!.publicKey);
    expect(store.row(oldRow.id).inboundSignature).toBe(sig('sig-retired-destination'));
    expect(store.row(currentRow.id).inboundSignature).toBeNull();
    // Refunding it needs the retired keypair, so it is quarantined for ops
    // rather than paid out of the CURRENT verify wallet.
    expect(store.row(oldRow.id).refundState).toBe('skipped');
    expect(rpc.sentRaw).toHaveLength(0);
  });
});

// ===========================================================================
// Codex adversarial money review 2026-08-10 — round 2 blockers
// ===========================================================================

describe('top-level transfer enforcement', () => {
  it('refuses the full attack shape because the payment is CPI-emitted', async () => {
    const victim = pubkey();
    const opened = await openFor(USER_A, victim);
    // The victim signed ONE opaque instruction to an attacker program. Both the
    // exact transfer and a memo naming the challenge were emitted by that
    // program, so nothing the victim actually saw named this account.
    rpc.signatures.unshift({
      signature: sig('sig-cpi-attack'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sig-cpi-attack'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [victim],
        opaqueTop: true,
        inner: [
          { source: victim, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { memo: opened.challengeId, memoRaw: true },
        ],
      }),
    );
    const submitted = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('sig-cpi-attack'),
    });
    expect(submitted.rejectedReason).toBe('transfer_not_top_level');
    await sweepTransferChallenges();

    const row = store.row(opened.challengeId);
    expect(row.status).toBe('rejected');
    expect(row.rejectedReason).toBe('transfer_not_top_level');
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
    // The victim's money still goes home.
    expect(row.refundState).toBe('sent');
  });

  it('rejects a CPI-emitted PAYMENT even when the memo is top level', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('sig-cpi-transfer'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sig-cpi-transfer'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        opaqueTop: true,
        top: [{ memo: opened.challengeId }],
        inner: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
        ],
      }),
    );
    const submitted = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('sig-cpi-transfer'),
    });
    expect(submitted.rejectedReason).toBe('transfer_not_top_level');
    await sweepTransferChallenges();
    const row = store.row(opened.challengeId);
    expect(row.status).toBe('rejected');
    expect(row.rejectedReason).toBe('transfer_not_top_level');
    expect(row.refundState).toBe('sent');
  });
});

describe('BLOCKER 2 — the refund-fee cap is bound to an authorization window', () => {
  it('an AGED backlog cannot spend past the cap when processing resumes', async () => {
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.01'; // 2000 fees
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // Backlog created LONG ago and never refunded. Counting spend by creation
    // time let every one of these age out of the window and then go out at once.
    const backlog = Array.from({ length: 4 }, (_, i) =>
      store.seed({
        userId: USER_A,
        walletPubkey: wallet,
        lamports: 1_000_000 + i,
        status: 'observed',
        inboundSignature: `aged-inbound-${i}`,
        createdAt: new Date(clockMs - 30 * DAY_MS),
        expiresAt: new Date(clockMs - 29 * DAY_MS),
      }),
    );
    // Today's budget is ALREADY spent by rows authorized today.
    seedRefundedFees(Number(10_000_000n / REFUND_FEE_LAMPORTS));

    await sweepTransferChallenges();

    // Age buys nothing: every one is deferred, because the cap is measured over
    // the day the refund would be AUTHORIZED, not the day the row was created.
    for (const row of backlog) {
      expect(store.row(row.id).refundState).toBe('none');
      expect(store.row(row.id).refundAuthorizedAt).toBeNull();
    }
    expect(rpc.sentRaw).toHaveLength(0);
    expect(alerts.some((a) => a.message.includes('refund-fee cap'))).toBe(true);
  });

  it('stamps the authorization day + policy immutably on the row it admits', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-stamped',
    });
    await sweepTransferChallenges();
    const row = store.row(target.id);
    expect(row.refundCapDay).toBe(new Date(clockMs).toISOString().slice(0, 10));
    expect(row.refundCapLamports).toBe(landHoldVerifyDailyRefundCapLamports());
    expect(row.refundAuthorizedAt).not.toBeNull();
  });

  it('refuses when this process disagrees with the day’s recorded cap policy', async () => {
    // A rolling deploy mid-day: the DB already owns today's number.
    const capDay = new Date(clockMs).toISOString().slice(0, 10);
    store.capPolicies.set(capDay, 999_000_000n);
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.5';
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-policy-mismatch',
    });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('none');
    expect(rpc.sentRaw).toHaveLength(0);
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('cap policy disagrees')),
    ).toBe(true);
  });
});

describe('BLOCKER 3 — cheap spam cannot eclipse a real deposit', () => {
  it('defers a null-parse head so the immediate broader pass reaches older entries', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const nullHead = Array.from({ length: 50 }, (_, index) => sig(`null-parse-head-${index}`));
    const olderSignature = sig('older-after-null-parse-head');
    rpc.signatures = [
      ...nullHead.map((signature) => ({
        signature,
        err: null,
        confirmationStatus: 'finalized' as const,
        blockTime: Math.floor(clockMs / 1000),
      })),
      {
        signature: olderSignature,
        err: null,
        confirmationStatus: 'finalized',
        blockTime: Math.floor(clockMs / 1000),
      },
    ];
    rpc.txs.set(
      olderSignature,
      parsedTx({
        blockTimeMs: clockMs,
        signers: [pubkey()],
        top: [{ source: pubkey(), destination: store.wallet!.publicKey, lamports: 1 }],
      }),
    );
    const parseCalls = new Map<string, number>();
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    rpc.getParsedTransaction = async (signature, config) => {
      parseCalls.set(signature, (parseCalls.get(signature) ?? 0) + 1);
      return realGetParsedTransaction(signature, config);
    };

    await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(nullHead.every((signature) => parseCalls.get(signature) === 1)).toBe(true);
    expect(parseCalls.has(olderSignature)).toBe(false);

    // The sweep's broader harvest runs immediately despite the narrow completed
    // floor. Deferred null heads consume no slots, so the older entry advances.
    await sweepTransferChallenges();
    expect(nullHead.every((signature) => parseCalls.get(signature) === 1)).toBe(true);
    expect(parseCalls.get(olderSignature)).toBe(1);
    expect([...store.scans.values()].some((entry) => entry.signature === olderSignature)).toBe(true);
  });

  it('finds a payment buried behind a page of newer spam, and parses each spam once', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // The real payment lands FIRST, then 120 newer one-lamport spam transfers
    // bury it well past the first page.
    publishInbound(sig('sig-buried-payment'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    const spammer = pubkey();
    for (let i = 0; i < 120; i += 1) {
      publishInbound(`sig-spam-${i}`, {
        from: spammer,
        to: store.wallet!.publicKey,
        lamports: 1,
        memo: null,
        blockTimeMs: clockMs + i + 1,
      });
    }

    // The work queue drains monotonically across passes instead of re-reading
    // the same newest page forever, so the buried payment IS reached. Before the
    // durable ledger it was never examined at all and the SOL was neither
    // attributed nor refunded.
    closeChallengeWindow();
    for (
      let pass = 0;
      pass < 5 && store.row(opened.challengeId).inboundSignature == null;
      pass += 1
    ) {
      clockMs += 5_001;
      await sweepTransferChallenges();
    }
    // Closed discovery reaches the buried payment and full-fetches it through
    // the same attribution path used by poll and submit.
    expect(store.row(opened.challengeId).inboundSignature).toBe(sig('sig-buried-payment'));
    expect(store.row(opened.challengeId).status).toBe('verified');

    // And every transaction cost exactly ONE parse, ever — bounded by the
    // 121 signatures that exist, not by passes x page size.
    const parsedTotal = rpc.commitments.filter((c) => c === 'tx:finalized').length;
    expect(parsedTotal).toBeLessThanOrEqual(122);
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    expect(rpc.commitments.filter((c) => c === 'tx:finalized')).toHaveLength(parsedTotal);
  });

  it('matches a challenge against facts parsed on an EARLIER pass, with no re-parse', async () => {
    // The parse cost is paid once; the matching opportunity never expires. This
    // is what keeps a BOUNDED candidate set from blinding us permanently: a
    // payment seen while its row was out of the batch still settles later.
    const walletA = pubkey();
    const walletB = pubkey();
    store.declare(USER_A, walletA);
    store.declare(USER_B, walletB);
    const rowA = store.seed({ userId: USER_A, walletPubkey: walletA, lamports: 10_000_654 });
    const rowB = store.seed({ userId: USER_B, walletPubkey: walletB, lamports: 10_000_655 });
    publishInbound(sig('sig-pass-a'), {
      from: walletA,
      to: store.wallet!.publicKey,
      lamports: rowA.lamports,
      memo: rowA.id,
    });
    publishInbound(sig('sig-pass-b'), {
      from: walletB,
      to: store.wallet!.publicKey,
      lamports: rowB.lamports,
      memo: rowB.id,
    });

    // Pass 1's candidate batch holds ONLY row A, but harvesting parses both.
    closeChallengeWindow();
    const all = store.listScannableChallenges.bind(store);
    store.listScannableChallenges = async () =>
      (await all(50, LATE_GRACE_MS, CLOSED_MARGIN_MS)).filter((r) => r.id === rowA.id);
    await sweepTransferChallenges();
    expect(store.row(rowA.id).status).toBe('verified');
    expect(store.row(rowB.id).inboundSignature).toBeNull();
    const parsedAfterFirst = rpc.commitments.filter((c) => c === 'tx:finalized').length;
    expect(parsedAfterFirst).toBe(3);

    // Pass 2 sees row B in the stored discovery facts and performs exactly one
    // authoritative full fetch before settling it.
    store.listScannableChallenges = all;
    clockMs += 5_001;
    await sweepTransferChallenges();
    expect(store.row(rowB.id).status).toBe('verified');
    expect(rpc.commitments.filter((c) => c === 'tx:finalized')).toHaveLength(parsedAfterFirst + 1);
  });
});

describe('BLOCKER 4 — duplicate refund signatures are quarantined, never double-sent', () => {
  it('carries a per-challenge memo so two refunds can never share bytes', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const first = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-unique-1',
    });
    const second = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-unique-2',
    });
    await sweepTransferChallenges();
    const a = store.row(first.id).refundSignature;
    const b = store.row(second.id).refundSignature;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(refundMemoText(first.id)).not.toBe(refundMemoText(second.id));
    expect(store.row(first.id).refundState).toBe('sent');
    expect(store.row(second.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(2);
  });

  it('quarantines a colliding signature UNSENT rather than recording two payments', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // Another row already owns the exact bytes this refund would produce.
    const owner = store.seed({
      userId: USER_B,
      walletPubkey: pubkey(),
      status: 'verified',
      inboundSignature: 'inbound-collision-owner',
      refundState: 'sending',
      refundSignature: 'shared-refund-signature',
    });
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-collision-target',
    });
    const realCapture = store.captureRefundSignature.bind(store);
    store.captureRefundSignature = async (input) =>
      realCapture({ ...input, signature: 'shared-refund-signature' });

    await sweepTransferChallenges();

    expect(store.row(target.id).refundState).toBe('reconcile');
    expect(rpc.sentRaw).toHaveLength(0);
    // The row that legitimately owns those bytes is untouched.
    expect(store.row(owner.id).refundSignature).toBe('shared-refund-signature');
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('SAME signature')),
    ).toBe(true);
  });
});

describe('BLOCKER 5 — every received leg is refunded', () => {
  it('refunds the FULL amount when one transaction pays the exact leg twice', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('sig-double-leg'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sig-double-leg'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { memo: opened.challengeId },
        ],
      }),
    );
    await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('sig-double-leg'),
    });

    const row = store.row(opened.challengeId);
    expect(row.status).toBe('verified');
    // We were paid twice, so we return twice — an alert is not a substitute for
    // giving the money back.
    expect(row.inboundLamports).toBe(opened.lamports * 2);
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
    expect(alerts.some((a) => a.message.includes('MORE than the challenge amount'))).toBe(true);
  });

  it('records the exact amount when the transaction pays exactly once', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('sig-single-leg'));
    expect(store.row(opened.challengeId).inboundLamports).toBe(opened.lamports);
    expect(alerts.some((a) => a.message.includes('MORE than the challenge amount'))).toBe(false);
  });
});

describe('HARDENING 6 — the door closes when the signer cannot pay', () => {
  it('reports unavailable and pages ops when the verify wallet has no float', async () => {
    rpc.balance = 1_000;
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: false,
      destination: null,
    });
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('signer is unusable')),
    ).toBe(true);
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    await expect(
      openTransferChallenge({ userId: USER_A, declaredWallet: wallet }),
    ).rejects.toMatchObject({ code: 'transfer_door_unavailable', status: 503 });
  });

  it('reports unavailable when the stored key does not decrypt to the stored pubkey', async () => {
    useHarness({ walletMatches: false });
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: false,
      destination: null,
    });
  });

  it('reports unavailable when the balance cannot be read at all', async () => {
    rpc.balanceThrows = true;
    await expect(getTransferDoorAvailability()).resolves.toMatchObject({ available: false });
  });

  it('stays open with a healthy signer and float', async () => {
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: true,
      destination: store.wallet!.publicKey,
    });
  });
});

describe('HARDENING 7 — only a confirmed status closes a refund as paid', () => {
  it('does NOT go terminal on a merely processed status', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-processed-only',
    });
    rpc.sendThrows = true;
    await sweepTransferChallenges();
    const signature = store.row(target.id).refundSignature!;

    // A `processed` status can still be dropped on a fork.
    rpc.statuses.set(signature, { err: null, confirmationStatus: 'processed' });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sending');

    // A status with no commitment at all is equally non-terminal.
    rpc.statuses.set(signature, { err: null, confirmationStatus: null });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sending');

    // Confirmed IS terminal.
    rpc.statuses.set(signature, { err: null, confirmationStatus: 'confirmed' });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('sent');
    expect(rpc.sentRaw).toHaveLength(1);
  });
});

describe('HARDENING 8 — terminal transitions are bound to their owner', () => {
  it('refuses a finish that names neither the claim nor the captured signature', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-unbound-finish',
      refundState: 'sending',
      refundSignature: 'some-signature',
    });
    await expect(
      store.finishRefund({ challengeId: target.id, state: 'reconcile' }),
    ).rejects.toThrow();
  });

  it('refuses a stale worker finishing a row another worker captured', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'observed',
      inboundSignature: 'inbound-stale-finish',
      refundState: 'sending',
      refundSignature: 'owner-signature',
    });
    // A worker holding an OLD claim id tries to skip the row mid-send.
    await expect(
      store.finishRefund({
        challengeId: target.id,
        state: 'skipped',
        claimId: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toBe(false);
    // And one holding the wrong signature cannot finish it either.
    await expect(
      store.finishRefund({ challengeId: target.id, state: 'sent', signature: 'other-signature' }),
    ).resolves.toBe(false);
    expect(store.row(target.id).refundState).toBe('sending');
    // The owner CAN.
    await expect(
      store.finishRefund({ challengeId: target.id, state: 'sent', signature: 'owner-signature' }),
    ).resolves.toBe(true);
  });
});

// ===========================================================================
// Exact-signature fallback
// ===========================================================================

describe('submitTransferSignature', () => {
  it('verifies from the signature the user hands us', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const status = await payAndSubmit(USER_A, opened, sig('submit-ok'));
    expect(status.state).toBe('verified');
    expect(status.inboundSignature).toBe(sig('submit-ok'));
    const user = store.user(USER_A);
    expect(user.verifiedMethod).toBe('transfer');
    expect(user.verifiedPubkey).toBe(wallet);
  });

  it('cannot settle ANOTHER account’s challenge with a stolen challenge id', async () => {
    const walletA = pubkey();
    const opened = await openFor(USER_A, walletA);
    store.declare(USER_B, pubkey());
    publishInbound(sig('submit-cross'), {
      from: walletA,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    await expect(
      submitTransferSignature({
        userId: USER_B,
        challengeId: opened.challengeId,
        signature: sig('submit-cross'),
      }),
    ).rejects.toMatchObject({ code: 'challenge_not_found', status: 404 });
    expect(store.row(opened.challengeId).inboundSignature).toBeNull();
  });

  it('refuses a transaction that pays a DIFFERENT challenge, without consuming this one', async () => {
    const wallet = pubkey();
    const first = await openFor(USER_A, wallet);
    const second = await openTransferChallenge({ userId: USER_A, declaredWallet: wallet });
    // Paid the SECOND challenge's amount, then submitted against the FIRST.
    publishInbound(sig('submit-wrong-challenge'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: second.lamports,
      memo: second.challengeId,
    });
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: first.challengeId,
        signature: sig('submit-wrong-challenge'),
      }),
    ).rejects.toMatchObject({ code: 'transfer_not_found', status: 422 });
    // The first challenge is untouched and still usable.
    expect(store.row(first.challengeId).status).toBe('pending');
    expect(store.row(first.challengeId).inboundSignature).toBeNull();
  });

  it('rejects a transfer whose source did not sign, and refunds it', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const status = await payAndSubmit(USER_A, opened, sig('submit-unsigned'), { signed: false });
    expect(status.state).toBe('rejected');
    expect(status.rejectedReason).toBe('source_not_signer');
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('refuses a transaction that is not finalized (or does not exist)', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('submit-unknown'),
      }),
    ).rejects.toMatchObject({ code: 'transaction_not_finalized', status: 404 });
    expect(store.row(opened.challengeId).status).toBe('pending');
  });

  it('treats a finalized transaction with null block time as retryable without consuming the challenge', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('submit-null-block-time'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: null,
    });

    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('submit-null-block-time'),
      }),
    ).rejects.toMatchObject({ code: 'transaction_not_finalized', status: 404 });
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'pending',
      inboundSignature: null,
    });
  });

  it('is idempotent on replay, and refuses a SECOND different signature', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const first = await payAndSubmit(USER_A, opened, sig('submit-replay'));
    expect(first.state).toBe('verified');
    // Same signature again: same answer, no second attribution.
    const replay = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('submit-replay'),
    });
    expect(replay.state).toBe('verified');
    expect(replay.inboundSignature).toBe(sig('submit-replay'));
    // A different signature against a settled challenge is refused outright.
    publishInbound(sig('submit-replay-2'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('submit-replay-2'),
      }),
    ).rejects.toMatchObject({ code: 'challenge_already_settled', status: 409 });
  });

  it('refuses an amount mismatch without consuming the challenge', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('submit-short'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports - 1,
      memo: opened.challengeId,
    });
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('submit-short'),
      }),
    ).rejects.toMatchObject({ code: 'transfer_not_found', status: 422 });
    expect(store.row(opened.challengeId).status).toBe('pending');
  });

  it('settles a memo-less transfer and refunds it', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const status = await payAndSubmit(USER_A, opened, sig('submit-no-memo'), { memo: null });
    expect(status.state).toBe('verified');
    expect(status.rejectedReason).toBeNull();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('refuses a malformed signature before any RPC work', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const before = rpc.commitments.length;
    for (const bad of ['', 'not-base58-0OIl', 'abc', 'x'.repeat(200)]) {
      await expect(
        submitTransferSignature({
          userId: USER_A,
          challengeId: opened.challengeId,
          signature: bad,
        }),
      ).rejects.toMatchObject({ code: 'invalid_signature', status: 400 });
    }
    expect(rpc.commitments).toHaveLength(before);
  });

  it('refuses a failed transaction', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('submit-failed-tx'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
      err: { InstructionError: [0, 'Custom'] },
    });
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('submit-failed-tx'),
      }),
    ).rejects.toMatchObject({ code: 'transaction_failed', status: 422 });
  });

  it('cannot be eclipsed: a payment behind thousands of newer signatures still verifies', async () => {
    // The scanner design failed exactly here. Submission does not care how much
    // traffic sits in front of the transaction.
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('submit-buried'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    const spammer = pubkey();
    for (let i = 0; i < 3_000; i += 1) {
      rpc.signatures.unshift({
        signature: `spam-${i}`,
        err: null,
        confirmationStatus: 'finalized',
        blockTime: Math.floor((clockMs + i) / 1000),
      });
    }
    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('submit-buried'),
    });
    expect(status.state).toBe('verified');
    expect(spammer).toBeTruthy();
  });
});

describe('ROUND 3 — refund obligations are DURABLE, never just an alert', () => {
  it('records an obligation for a deposit that arrives with no submission', async () => {
    const stranger = pubkey();
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // A closed challenge keeps the destination in the sweep's search space.
    store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      status: 'expired',
      expiresAt: new Date(clockMs - 4 * 60 * 60 * 1000),
      createdAt: new Date(clockMs - 5 * 60 * 60 * 1000),
    });
    // Money that arrived hours ago and was never submitted by anyone.
    publishInbound(sig('orphan-deposit'), {
      from: stranger,
      to: store.wallet!.publicKey,
      lamports: 7_654_321,
      memo: null,
      blockTimeMs: clockMs - 3 * 60 * 60 * 1000,
    });

    await sweepTransferChallenges();

    const obligation = [...store.obligations.values()].find(
      (o) => o.recipientPubkey === stranger,
    );
    expect(obligation).toBeDefined();
    expect(obligation!.reason).toBe('unclaimed_inbound');
    expect(obligation!.lamports).toBe(7_654_321);
    expect(obligation!.signature).toBe(sig('orphan-deposit'));
    // Idempotent: a second pass does not double-claim the same money.
    await sweepTransferChallenges();
    expect(
      [...store.obligations.values()].filter((o) => o.recipientPubkey === stranger),
    ).toHaveLength(1);
  });

  it('records an obligation for ANOTHER sender’s legs in a settled transaction', async () => {
    const wallet = pubkey();
    const other = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('two-senders'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('two-senders'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet, other],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { source: other, destination: store.wallet!.publicKey, lamports: 4_242 },
          { memo: opened.challengeId },
        ],
      }),
    );
    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('two-senders'),
    });
    expect(status.state).toBe('verified');
    // Our refund returns the submitter's legs; the OTHER sender's money cannot
    // be returned by this row, so it is recorded as owed.
    const obligation = [...store.obligations.values()].find((o) => o.recipientPubkey === other);
    expect(obligation).toBeDefined();
    expect(obligation!.reason).toBe('retained_leg');
    expect(obligation!.lamports).toBe(4_242);
  });

  it('records an obligation when the verify wallet rotated and we cannot sign', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const paidTo = pubkey();
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: paidTo,
      status: 'verified',
      inboundSignature: 'inbound-rotated-obligation',
    });
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('skipped');
    const obligation = [...store.obligations.values()].find(
      (o) => o.reason === 'destination_rotated',
    );
    expect(obligation).toBeDefined();
    expect(obligation!.recipientPubkey).toBe(wallet);
    expect(obligation!.destination).toBe(paidTo);
  });
});

describe('ROUND 3 — scan facts are stored WHOLE or not at all', () => {
  it('leaves an over-sized transaction unscanned and pages ops, never truncated', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const legs = Array.from({ length: 40 }, () => ({
      source: pubkey(),
      destination: store.wallet!.publicKey,
      lamports: 5,
    }));
    publishInbound(sig('too-large'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    rpc.txs.set(
      sig('too-large'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          ...legs,
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { memo: opened.challengeId },
        ],
      }),
    );
    await sweepTransferChallenges();

    // NOT recorded as scanned, so a later full parse can still retry it.
    expect(store.scans.has(`${store.wallet!.publicKey} ${sig('too-large')}`)).toBe(false);
    expect(alerts.some((a) => a.message.includes('too large to record whole'))).toBe(true);
    // And truncation is impossible by construction.
    const probe = probeTransaction(rpc.txs.get(sig('too-large'))!);
    expect(scanFactsOf(probe!, new Set([store.wallet!.publicKey]))).toBeNull();
  });

  it('stores facts whole when the transaction fits', async () => {
    const from = pubkey();
    const to = pubkey();
    const probe = probeTransaction(
      parsedTx({
        signers: [from],
        top: [
          { source: from, destination: to, lamports: 10 },
          { source: from, destination: to, lamports: 20 },
          { memo: 'note' },
        ],
      }),
    );
    const facts = scanFactsOf(probe!, new Set([to]));
    expect(facts).not.toBeNull();
    expect(facts!.transfers).toHaveLength(2);
    expect(facts!.memos).toEqual([{ text: 'note', topLevel: true }]);
  });
});

describe('ROUND 3 — cap-policy health closes the door', () => {
  it('closes the door when the recorded policy disagrees with this pod', async () => {
    // A wrong first writer wedges every correctly-configured pod's refunds for
    // the day. Leaving the door open would invite deposits into a pipeline that
    // healthy pods refuse to drain.
    store.capPolicies.set(new Date(clockMs).toISOString().slice(0, 10), 123_456_789n);
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: false,
      destination: null,
    });
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('signer is unusable')),
    ).toBe(true);
  });

  it('stays open when the recorded policy agrees', async () => {
    store.capPolicies.set(
      new Date(clockMs).toISOString().slice(0, 10),
      landHoldVerifyDailyRefundCapLamports(),
    );
    await expect(getTransferDoorAvailability()).resolves.toEqual({
      available: true,
      destination: store.wallet!.publicKey,
    });
  });
});

// ===========================================================================
// ROUND 4 — the scanner may never destroy a proof or invent a debt
// ===========================================================================

describe('submit versus sweep', () => {
  it('verifies an in-window payment when the closed sweep wins before a late submit', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('race-closed-sweep-first'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });

    closeChallengeWindow();
    clockMs += LATE_GRACE_MS - CLOSED_MARGIN_MS;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'verified',
      inboundSignature: sig('race-closed-sweep-first'),
    });

    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('race-closed-sweep-first'),
      }),
    ).resolves.toMatchObject({ state: 'verified' });
  });

  it('refunds an out-of-window closed payment without granting verification', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    closeChallengeWindow();
    publishInbound(sig('closed-out-of-window'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });

    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'expired',
      inboundSignature: sig('closed-out-of-window'),
      refundState: 'sent',
    });
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
  });

  it('preserves the unclaimed refund when a closed candidate full fetch is unavailable', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('closed-full-fetch-unavailable'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let reads = 0;
    rpc.getParsedTransaction = async (signature, config) => {
      reads += 1;
      if (reads === 1) return realGetParsedTransaction(signature, config);
      rpc.commitments.push(`tx:${config.commitment}`);
      return null;
    };

    closeChallengeWindow();
    clockMs += LATE_GRACE_MS - CLOSED_MARGIN_MS;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'unclaimed',
      inboundSignature: sig('closed-full-fetch-unavailable'),
      refundState: 'sent',
    });
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
  });

  it('keeps a post-grace row scannable after one thrown closed-row full fetch', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('closed-full-fetch-one-throw'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let reads = 0;
    rpc.getParsedTransaction = async (signature, config) => {
      reads += 1;
      if (reads === 1) return realGetParsedTransaction(signature, config);
      throw new Error('persistent full-fetch RPC failure');
    };

    closeChallengeWindow();
    clockMs += LATE_GRACE_MS - CLOSED_MARGIN_MS;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'expired',
      inboundSignature: null,
      refundState: 'none',
    });
    expect(store.row(opened.challengeId).refundAuthorizedAt).toBeNull();
    expect(reads).toBe(2);
  });

  it('writes unclaimed and authorizes its refund after three consecutive thrown full fetches', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('closed-full-fetch-three-throws'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let reads = 0;
    rpc.getParsedTransaction = async (signature, config) => {
      reads += 1;
      if (reads === 1) return realGetParsedTransaction(signature, config);
      throw new Error('persistent full-fetch RPC failure');
    };

    closeChallengeWindow();
    clockMs += LATE_GRACE_MS - CLOSED_MARGIN_MS;
    await sweepTransferChallenges();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'expired',
      inboundSignature: null,
      refundState: 'none',
    });
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'unclaimed',
      inboundSignature: sig('closed-full-fetch-three-throws'),
      refundState: 'sent',
    });
    expect(reads).toBe(4);
    expect(store.row(opened.challengeId).refundAuthorizedAt).not.toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBeNull();
  });

  it('counts one shared signature at most once per sweep across destination groups', async () => {
    const wallet = pubkey();
    const destinations = [store.wallet!.publicKey, pubkey(), pubkey()];
    store.retiredWallets = destinations.slice(1).map((publicKey) => ({
      publicKey,
      retiredAt: new Date(clockMs),
    }));
    const rows = destinations.map((destinationPubkey, index) =>
      store.seed({
        userId: USER_A,
        walletPubkey: wallet,
        destinationPubkey,
        lamports: 10_001 + index,
      }),
    );
    const signature = sig('closed-shared-signature-three-destinations');
    const probe = probeTransaction(
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: rows.map((row) => ({
          source: wallet,
          destination: row.destinationPubkey,
          lamports: row.lamports,
        })),
      }),
    )!;
    const facts = scanFactsOf(probe, new Set(destinations))!;
    for (const destination of destinations) {
      await store.recordScannedSignature({ destination, signature, blockTimeMs: clockMs, facts });
    }
    let reads = 0;
    rpc.getParsedTransaction = async () => {
      reads += 1;
      throw new Error('shared signature full-fetch outage');
    };

    closeChallengeWindow();
    clockMs += LATE_GRACE_MS - CLOSED_MARGIN_MS;
    await sweepTransferChallenges();
    expect(reads).toBe(3);
    expect(rows.every((row) => store.row(row.id).inboundSignature == null)).toBe(true);

    clockMs += SWEEP_INTERVAL_MS;
    await sweepTransferChallenges();
    expect(reads).toBe(6);
    expect(rows.every((row) => store.row(row.id).inboundSignature == null)).toBe(true);

    clockMs += SWEEP_INTERVAL_MS;
    await sweepTransferChallenges();
    expect(rows.filter((row) => store.row(row.id).status === 'unclaimed')).toHaveLength(1);
    expect(rows.filter((row) => store.row(row.id).inboundSignature === signature)).toHaveLength(1);
  });

  it('uses unclaimed fallback on a thrown fetch inside the final two sweep slots', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('closed-full-fetch-final-margin'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let reads = 0;
    rpc.getParsedTransaction = async (signature, config) => {
      reads += 1;
      if (reads === 1) return realGetParsedTransaction(signature, config);
      throw new Error('full-fetch RPC failure in final margin');
    };

    clockMs =
      new Date(opened.expiresAt).getTime() +
      LATE_GRACE_MS +
      CLOSED_MARGIN_MS -
      2 * SWEEP_INTERVAL_MS +
      1;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'unclaimed',
      inboundSignature: sig('closed-full-fetch-final-margin'),
      refundState: 'sent',
    });
    expect(reads).toBe(2);
    expect(store.row(opened.challengeId).refundAuthorizedAt).not.toBeNull();
  });

  it('retries the oldest defer before fifty newer defers consume the final-margin tail', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const signature = sig('closed-final-margin-parse-defer');
    const pageWalkSignature = sig('closed-final-margin-page-walk-budget');
    const newerDefers = Array.from({ length: 50 }, (_, index) =>
      sig(`closed-final-margin-newer-defer-${index}`),
    );
    publishInbound(pageWalkSignature, {
      from: pubkey(),
      to: store.wallet!.publicKey,
      lamports: 1,
      blockTimeMs: clockMs - 1,
    });
    publishInbound(signature, {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs,
    });

    const realGetSignaturesForAddress = rpc.getSignaturesForAddress.bind(rpc);
    let signatureReads = 0;
    rpc.getSignaturesForAddress = async (...args) => {
      signatureReads += 1;
      // Let broad orphan discovery complete without this new signature so the
      // first parse belongs to the retry-deferred closed-tail harvest.
      if (signatureReads === 1) return [];
      // Keep the unrelated older signature out of the first retry harvest. It
      // will prove the later retry page walk retains its independent budget.
      if (signatureReads === 2) {
        return (await realGetSignaturesForAddress(...args)).filter(
          (ref) => ref.signature === signature,
        );
      }
      return realGetSignaturesForAddress(...args);
    };
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    const parseCalls = new Map<string, number>();
    const secondSweepParseOrder: string[] = [];
    let trackingSecondSweep = false;
    rpc.getParsedTransaction = async (candidate, config) => {
      parseCalls.set(candidate, (parseCalls.get(candidate) ?? 0) + 1);
      if (trackingSecondSweep) secondSweepParseOrder.push(candidate);
      if (candidate === signature && parseCalls.get(candidate) === 1) return null;
      if (newerDefers.includes(candidate)) return null;
      return realGetParsedTransaction(candidate, config);
    };

    clockMs =
      new Date(opened.expiresAt).getTime() +
      LATE_GRACE_MS +
      CLOSED_MARGIN_MS -
      2 * SWEEP_INTERVAL_MS +
      1;
    await sweepTransferChallenges();
    expect(parseCalls.get(signature)).toBe(1);
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'expired',
      inboundSignature: null,
      refundState: 'none',
    });
    expect([...store.scans.values()].some((entry) => entry.signature === signature)).toBe(false);

    clockMs += SWEEP_INTERVAL_MS;
    for (const deferredSignature of newerDefers) {
      publishInbound(deferredSignature, {
        from: pubkey(),
        to: store.wallet!.publicKey,
        lamports: 1,
      });
    }
    expect(
      (await store.listScannableChallenges(50, LATE_GRACE_MS, CLOSED_MARGIN_MS)).some(
        (row) => row.id === opened.challengeId,
      ),
    ).toBe(true);
    trackingSecondSweep = true;
    await sweepTransferChallenges();

    // Broad non-retry coverage first creates fifty newer defers. The dedicated
    // retry budget then re-parses the older target first, and the ordinary page
    // walk skips all active defers without charging them against its own budget.
    expect(new Set(secondSweepParseOrder.slice(0, 50))).toEqual(new Set(newerDefers));
    expect(secondSweepParseOrder[50]).toBe(signature);
    expect(parseCalls.get(signature)).toBe(3);
    expect(parseCalls.get(pageWalkSignature)).toBe(1);
    expect(signatureReads).toBe(4);
    expect([...store.scans.values()].some((entry) => entry.signature === signature)).toBe(true);
    expect(
      [...store.scans.values()].some((entry) => entry.signature === pageWalkSignature),
    ).toBe(true);
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'verified',
      inboundSignature: signature,
      refundState: 'sent',
    });
    expect(store.row(opened.challengeId).refundAuthorizedAt).not.toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('scopes a multi-destination parse defer through final-margin attribution', async () => {
    const destinationA = pubkey();
    const destinationB = store.wallet!.publicKey;
    const wallet = pubkey();
    const signature = sig('closed-final-margin-multi-destination-defer');
    store.retiredWallets = [{ publicKey: destinationA, retiredAt: new Date(clockMs) }];
    store.seed({
      userId: USER_B,
      walletPubkey: pubkey(),
      destinationPubkey: destinationA,
      status: 'verified',
      inboundSignature: sig('multi-destination-history-a'),
      refundState: 'sent',
    });
    store.declare(USER_A, wallet);
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: destinationB,
    });
    rpc.signatures.unshift({
      signature,
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      signature,
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: destinationA, lamports: 1 },
          { source: wallet, destination: destinationB, lamports: target.lamports },
        ],
      }),
    );

    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let parseCalls = 0;
    rpc.getParsedTransaction = async (candidate, config) => {
      if (candidate !== signature) return realGetParsedTransaction(candidate, config);
      parseCalls += 1;
      if (parseCalls === 1) return null;
      return realGetParsedTransaction(candidate, config);
    };

    clockMs =
      target.expiresAt.getTime() +
      LATE_GRACE_MS +
      CLOSED_MARGIN_MS -
      2 * SWEEP_INTERVAL_MS +
      1;
    expect(
      (await store.listScannableChallenges(50, LATE_GRACE_MS, CLOSED_MARGIN_MS)).some(
        (row) => row.id === target.id,
      ),
    ).toBe(true);

    await sweepTransferChallenges();

    expect(parseCalls).toBe(3);
    expect(
      [...store.scans.values()]
        .filter((entry) => entry.signature === signature)
        .map((entry) => entry.destination),
    ).toEqual([destinationB]);
    expect(store.row(target.id)).toMatchObject({
      status: 'verified',
      inboundSignature: signature,
      refundState: 'sent',
    });
    expect(store.row(target.id).refundAuthorizedAt).not.toBeNull();
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('the sweep settles a live paid challenge when the panel is closed', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('race-still-open'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });

    // Sweep first, with no browser poll or signature submission.
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.row(opened.challengeId).inboundSignature).toBe(sig('race-still-open'));
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('a submission already settled beats a later sweep (opposite ordering)', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('race-submit-first'));
    expect(store.row(opened.challengeId).status).toBe('verified');

    // Even once the window closes, the sweep cannot overwrite a settled row.
    closeChallengeWindow();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('verified');
    expect(store.row(opened.challengeId).inboundSignature).toBe(sig('race-submit-first'));
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
  });

  it('enforces the closed-window rule in the STORE, not only in the batch query', async () => {
    // A stale batch row must not be able to terminalize a live challenge.
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const attributed = await store.attributeInbound({
      challengeId: opened.challengeId,
      userId: USER_A,
      destination: store.wallet!.publicKey,
      signature: sig('race-direct-guard'),
      inboundLamports: opened.lamports,
      nextStatus: 'unclaimed',
      rejectedReason: null,
      onlyIfClosedForMs: CLOSED_MARGIN_MS,
    });
    expect(attributed.bound).toBe(false);
    expect(store.row(opened.challengeId).status).toBe('pending');

    // Once genuinely closed, the same call is admitted.
    closeChallengeWindow();
    await expect(
      store.attributeInbound({
        challengeId: opened.challengeId,
        userId: USER_A,
        destination: store.wallet!.publicKey,
        signature: sig('race-direct-guard'),
        inboundLamports: opened.lamports,
        nextStatus: 'unclaimed',
        rejectedReason: null,
        onlyIfClosedForMs: CLOSED_MARGIN_MS,
      }),
    ).resolves.toMatchObject({ bound: true });
  });
});

describe('sweeper startup', () => {
  it('executes one pass immediately before the first interval tick', async () => {
    let startupReads = 0;
    const realListGrantableChallenges = store.listGrantableChallenges.bind(store);
    store.listGrantableChallenges = async (limit) => {
      startupReads += 1;
      return realListGrantableChallenges(limit);
    };
    let finishStartupPass!: () => void;
    const startupPassFinished = new Promise<void>((resolve) => {
      finishStartupPass = resolve;
    });
    const realPruneScanLedger = store.pruneScanLedger.bind(store);
    store.pruneScanLedger = async (olderThanMs) => {
      const removed = await realPruneScanLedger(olderThanMs);
      finishStartupPass();
      return removed;
    };

    startLandHoldVerifySweeper();
    expect(startupReads).toBe(1);
    await startupPassFinished;
    expect(startupReads).toBe(1);
    stopLandHoldVerifySweeper();
  });
});

describe('orphan threshold', () => {
  it('can NEVER be shorter than the configured challenge TTL', () => {
    for (const ttl of ['300000', '2700000', '3600000', 'not-a-number', '1']) {
      process.env.LAND_HOLD_VERIFY_TTL_MS = ttl;
      expect(landHoldVerifyOrphanThresholdMs()).toBeGreaterThan(landHoldVerifyTtlMs());
    }
    delete process.env.LAND_HOLD_VERIFY_TTL_MS;
    // And it clears the whole live window: TTL + late-arrival grace + margin.
    expect(landHoldVerifyOrphanThresholdMs()).toBe(
      landHoldVerifyTtlMs() + LATE_GRACE_MS + CLOSED_MARGIN_MS,
    );
  });

  it('does not book a LIVE challenge’s money as an orphan debt', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // Paid 40 minutes ago: older than the old 30-minute cutoff, still inside the
    // 45-minute TTL. The old threshold booked this as an obligation AND later
    // refunded it through the challenge, leaving a duplicate debt.
    const paidAtMs = clockMs + 60_000;
    publishInbound(sig('live-not-orphan'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
      blockTimeMs: paidAtMs,
    });
    // 40 minutes later: older than the OLD 30-minute cutoff, still inside the
    // 45-minute TTL.
    clockMs += 40 * 60 * 1000;
    await sweepTransferChallenges();
    expect(store.obligations.size).toBe(0);

    // And the user's submission still verifies it.
    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('live-not-orphan'),
    });
    expect(status.state).toBe('verified');
  });

  it('voids an orphan obligation if the challenge path later refunds the same funds', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    // An orphan claim already exists against this signature.
    await store.recordRefundObligation({
      destination: store.wallet!.publicKey,
      signature: sig('double-debt'),
      recipientPubkey: wallet,
      lamports: 10_000_123,
      reason: 'unclaimed_inbound',
      challengeId: null,
    });
    expect(store.obligations.size).toBe(1);

    const row = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 10_000_123 });
    await store.attributeInbound({
      challengeId: row.id,
      userId: USER_A,
      destination: store.wallet!.publicKey,
      signature: sig('double-debt'),
      inboundLamports: 10_000_123,
      nextStatus: 'unclaimed',
      rejectedReason: null,
    });

    // The same funds can never be owed twice: the challenge refund covers them,
    // so the orphan claim is voided rather than left open.
    const obligation = [...store.obligations.values()][0]!;
    expect(obligation.state).toBe('void');
  });
});

describe('obligation writes are atomic with the attribution', () => {
  it('records the retained leg in the SAME call that attributes the inbound', async () => {
    const wallet = pubkey();
    const other = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('atomic-retained'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('atomic-retained'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet, other],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { source: other, destination: store.wallet!.publicKey, lamports: 99 },
          { memo: opened.challengeId },
        ],
      }),
    );
    // A store that refuses standalone obligation writes proves the write rode
    // along with the attribution rather than following it.
    store.recordRefundObligation = async () => {
      throw new Error('standalone obligation write must not be used here');
    };
    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('atomic-retained'),
    });
    expect(status.state).toBe('verified');
    const obligation = [...store.obligations.values()].find((o) => o.recipientPubkey === other);
    expect(obligation).toBeDefined();
    expect(obligation!.lamports).toBe(99);
  });
});

// ===========================================================================
// ROUND 5 — obligations survive a crash, and no deposit is ever paid twice
// ===========================================================================

describe('rotated-destination obligation is atomic with the terminalization', () => {
  it('writes the obligation in the SAME call that marks the row skipped', async () => {
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const paidTo = pubkey();
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: paidTo,
      status: 'verified',
      inboundSignature: 'inbound-rotated-atomic',
    });
    // A store whose STANDALONE obligation write throws proves the obligation
    // rode along with `finishRefund` rather than following it.
    store.recordRefundObligation = async () => {
      throw new Error('standalone obligation write must not be used here');
    };
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('skipped');
    const obligation = [...store.obligations.values()].find(
      (o) => o.reason === 'destination_rotated',
    );
    expect(obligation).toBeDefined();
    expect(obligation!.recipientPubkey).toBe(wallet);
    expect(obligation!.destination).toBe(paidTo);
  });

  it('a crash between the two leaves NOTHING half-done', async () => {
    // The old shape terminalized first and inserted second, and refundable
    // selection requires refund_state='none', so a crash in between lost the
    // debt with nothing able to retry it. One transaction makes that impossible.
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    const paidTo = pubkey();
    const target = store.seed({
      userId: USER_A,
      walletPubkey: wallet,
      destinationPubkey: paidTo,
      status: 'verified',
      inboundSignature: 'inbound-rotated-crash',
    });
    const realFinish = store.finishRefund.bind(store);
    store.finishRefund = async () => {
      throw new Error('process died mid-terminalize');
    };
    await sweepTransferChallenges();
    // Neither side happened, so the row is still refundable and retryable.
    expect(store.row(target.id).refundState).toBe('none');
    expect(store.obligations.size).toBe(0);

    // The row is picked up again through the ordinary stale-claim takeover, and
    // this time both halves land together.
    store.finishRefund = realFinish;
    clockMs += 6 * 60 * 1000;
    await sweepTransferChallenges();
    expect(store.row(target.id).refundState).toBe('skipped');
    expect([...store.obligations.values()]).toHaveLength(1);
  });
});

describe('a settled obligation blocks a later double-pay', () => {
  it('quarantines the refund instead of paying the same deposit twice', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    // An operator already returned this money by hand.
    await store.recordRefundObligation({
      destination: store.wallet!.publicKey,
      signature: sig('already-settled'),
      recipientPubkey: wallet,
      lamports: opened.lamports,
      reason: 'unclaimed_inbound',
      challengeId: null,
    });
    const key = [...store.obligations.keys()][0]!;
    store.obligations.set(key, { ...store.obligations.get(key)!, state: 'settled' });

    const status = await payAndSubmit(USER_A, opened, sig('already-settled'));
    // The proof still stands...
    expect(status.state).toBe('verified');
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
    // ...but the automatic refund NEVER runs for funds already returned.
    expect(store.row(opened.challengeId).refundState).toBe('reconcile');
    await sweepTransferChallenges();
    expect(rpc.sentRaw).toHaveLength(0);
    expect(store.row(opened.challengeId).refundState).toBe('reconcile');
    expect(
      alerts.some((a) => a.severity === 'critical' && a.message.includes('already settled by hand')),
    ).toBe(true);
    // A settled obligation is never voided by the attribution either.
    expect(store.obligations.get(key)!.state).toBe('settled');
  });

  it('still refunds normally when the obligation is only OPEN', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await store.recordRefundObligation({
      destination: store.wallet!.publicKey,
      signature: sig('open-not-settled'),
      recipientPubkey: wallet,
      lamports: opened.lamports,
      reason: 'unclaimed_inbound',
      challengeId: null,
    });
    await payAndSubmit(USER_A, opened, sig('open-not-settled'));
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
    // The open orphan claim is voided, because the challenge refund covered it.
    expect([...store.obligations.values()][0]!.state).toBe('void');
  });
});

describe('one transaction funding two verify destinations', () => {
  it('DISCOVERS the retired-address debt end to end, with nothing inserted by hand', async () => {
    // The gap this closes: attributing consumes the signature GLOBALLY, so the
    // retired address's leg was never turned into an obligation. Nothing here is
    // pre-seeded — the debt has to come out of the parsed transaction itself.
    const retired = pubkey();
    store.retiredWallets = [{ publicKey: retired, retiredAt: new Date(clockMs) }];
    const wallet = pubkey();
    const stranger = pubkey();
    const opened = await openFor(USER_A, wallet);

    // ONE transaction: pays the live challenge at the CURRENT address, and also
    // pays a leg to the RETIRED address we can no longer sign for.
    rpc.signatures.unshift({
      signature: sig('discovers-retired'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('discovers-retired'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet, stranger],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { source: stranger, destination: retired, lamports: 5_000 },
          { memo: opened.challengeId },
        ],
      }),
    );

    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('discovers-retired'),
    });
    expect(status.state).toBe('verified');

    // The retired address's money is now a DEBT, discovered from the same
    // transaction rather than by any later scan of that address.
    const obligation = [...store.obligations.values()].find((o) => o.destination === retired);
    expect(obligation).toBeDefined();
    expect(obligation!.reason).toBe('destination_rotated');
    expect(obligation!.recipientPubkey).toBe(stranger);
    expect(obligation!.lamports).toBe(5_000);
    expect(obligation!.state).toBe('open');
    // And the submitter's own money is refunded normally through the challenge.
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('discovers it through the SWEEP too, not only through submission', async () => {
    const retired = pubkey();
    store.retiredWallets = [{ publicKey: retired, retiredAt: new Date(clockMs) }];
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('sweep-discovers-retired'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('sweep-discovers-retired'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          { source: wallet, destination: retired, lamports: 777 },
          { memo: opened.challengeId },
        ],
      }),
    );
    // Never submitted, so the closed sweep discovers and authoritatively settles it.
    closeChallengeWindow();
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('verified');
    const obligation = [...store.obligations.values()].find((o) => o.destination === retired);
    expect(obligation).toBeDefined();
    expect(obligation!.reason).toBe('destination_rotated');
    expect(obligation!.lamports).toBe(777);
  });

  it('records the retired debt even when the set was read BEFORE the rotation', async () => {
    // The stale-cache condition. A destination set captured before a rotation is
    // missing the address that was just retired-and-replaced, and attributing
    // against it consumes the signature globally with the debt never generated,
    // which is unrecoverable. The read has to be fresh AT ATTRIBUTION TIME.
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const originalAddress = store.wallet!.publicKey;

    // Warm every destination read there is, at the PRE-rotation state.
    await getTransferDoorAvailability();
    expect(await store.listVerifyDestinations()).toEqual([originalAddress]);

    // ROTATION happens now, after everything was warmed: a NEW wallet goes live
    // and the address this challenge points at becomes retired. Nothing read
    // before this moment knows the replacement address exists.
    const replacement = pubkey();
    store.rotateVerifyWallet(replacement);
    expect(await store.listVerifyDestinations()).toEqual([replacement, originalAddress]);

    // ONE transaction pays this challenge at its (now retired) address AND
    // leaves a leg at the replacement address. A set captured before the
    // rotation does not contain the replacement, so that leg would be invisible
    // and its debt never generated.
    rpc.signatures.unshift({
      signature: sig('stale-cache-rotation'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('stale-cache-rotation'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: originalAddress, lamports: opened.lamports },
          { source: wallet, destination: replacement, lamports: 6_100 },
          { memo: opened.challengeId },
        ],
      }),
    );

    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('stale-cache-rotation'),
    });
    expect(status.state).toBe('verified');

    // The debt at the OTHER address is recorded, because the destinations were
    // read fresh inside the attribution transaction rather than from a set
    // captured before the rotation.
    const obligation = [...store.obligations.values()].find(
      (o) => o.destination === replacement,
    );
    expect(obligation).toBeDefined();
    expect(obligation!.reason).toBe('destination_rotated');
    expect(obligation!.recipientPubkey).toBe(wallet);
    expect(obligation!.lamports).toBe(6_100);
  });

  it('derives rotated debts from a FRESH read, never a captured set', () => {
    // Structural companion to the behavioural test above: the derivation lives
    // inside the attribution transaction, so no caller can hand it a stale set.
    const attribute = verifySource.slice(
      verifySource.indexOf('async attributeInbound({'),
      verifySource.indexOf('async grantVerification('),
    );
    expect(attribute).toContain('SELECT public_key FROM treasury_wallets');
    expect(attribute).toContain('rotatedDestinationObligations(');
    // And nothing caches the destination set any more.
    expect(verifySource).not.toContain('knownDestinationsCache');
    // The CALLERS cannot hand in a set even if they wanted to: they pass raw
    // legs, and the only `rotatedDestinationObligations` call is the in-tx one.
    expect((verifySource.match(/rotatedDestinationObligations\(/g) ?? [])).toHaveLength(2);
    expect(verifySource).toContain('legs: probe.transfers,');
    // `knownVerifyDestinations` survives only for harvest scoping + the 503
    // health probe, never to compute a debt.
    const helper = verifySource.slice(
      verifySource.indexOf('async function knownVerifyDestinations('),
    );
    expect(helper.slice(0, 200)).toContain('listVerifyDestinations()');
    expect(verifySource).toContain('DELIBERATELY UNCACHED');
  });

  it('REFUSES to attribute when the destination set is unavailable (submit)', async () => {
    // Attribution consumes the signature globally, so a rotated-destination debt
    // we failed to GENERATE could never be recovered: ON CONFLICT cannot
    // resurrect a row nobody tried to insert. Fail closed and let the caller
    // retry rather than silently losing the debt.
    const retired = pubkey();
    store.retiredWallets = [{ publicKey: retired, retiredAt: new Date(clockMs) }];
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('closed-on-lookup-failure'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });

    store.failDestinationLookup = true;
    await expect(
      submitTransferSignature({
        userId: USER_A,
        challengeId: opened.challengeId,
        signature: sig('closed-on-lookup-failure'),
      }),
    ).rejects.toMatchObject({ code: 'destination_set_unavailable', status: 503 });
    // NOTHING was consumed, so the proof is still there to be made.
    expect(store.row(opened.challengeId).status).toBe('pending');
    expect(store.row(opened.challengeId).inboundSignature).toBeNull();

    // Once the lookup recovers, the same submission works and the debt lands.
    store.failDestinationLookup = false;
    const status = await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('closed-on-lookup-failure'),
    });
    expect(status.state).toBe('verified');
  });

  it('REFUSES to attribute when the destination set is unavailable (sweep)', async () => {
    const retired = pubkey();
    store.retiredWallets = [{ publicKey: retired, retiredAt: new Date(clockMs) }];
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('sweep-closed-on-failure'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    closeChallengeWindow();

    store.failDestinationLookup = true;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).inboundSignature).toBeNull();
    expect(
      alerts.some(
        (a) => a.severity === 'critical' && a.message.includes('destination set could not be read'),
      ),
    ).toBe(true);
    // No facts were persisted either: a row scoped to only the attributed
    // destination would have hidden the retired leg permanently.
    expect(store.scans.size).toBe(0);

    // The next sweep, with the lookup healthy, picks it up as normal.
    store.failDestinationLookup = false;
    clockMs += 5_001;
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).status).toBe('verified');
  });

  it('ignores legs paid to addresses that are not ours at all', async () => {
    const wallet = pubkey();
    const unrelated = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.signatures.unshift({
      signature: sig('unrelated-leg'),
      err: null,
      confirmationStatus: 'finalized',
      blockTime: Math.floor(clockMs / 1000),
    });
    rpc.txs.set(
      sig('unrelated-leg'),
      parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        top: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          // Someone else's address. Not our money, not our debt.
          { source: wallet, destination: unrelated, lamports: 12_345 },
          { memo: opened.challengeId },
        ],
      }),
    );
    await submitTransferSignature({
      userId: USER_A,
      challengeId: opened.challengeId,
      signature: sig('unrelated-leg'),
    });
    expect([...store.obligations.values()]).toHaveLength(0);
  });

  it('represents them as two INDEPENDENT debts, and voids only the right one', async () => {
    const retired = pubkey();
    const current = store.wallet!.publicKey;
    const senderA = pubkey();
    const senderB = pubkey();
    // The SAME signature funds both a retired and the current verify address.
    await store.recordRefundObligation({
      destination: retired,
      signature: sig('two-destinations'),
      recipientPubkey: senderA,
      lamports: 111,
      reason: 'unclaimed_inbound',
      challengeId: null,
    });
    await store.recordRefundObligation({
      destination: current,
      signature: sig('two-destinations'),
      recipientPubkey: senderB,
      lamports: 222,
      reason: 'unclaimed_inbound',
      challengeId: null,
    });
    // Without the destination in the key these could not coexist at all.
    expect(store.obligations.size).toBe(2);

    // Attributing at the CURRENT address must not erase the RETIRED address's
    // debt: it is a different pot of money that we still owe someone.
    const wallet = senderB;
    store.declare(USER_A, wallet);
    const row = store.seed({ userId: USER_A, walletPubkey: wallet, lamports: 222 });
    await store.attributeInbound({
      challengeId: row.id,
      userId: USER_A,
      destination: current,
      signature: sig('two-destinations'),
      inboundLamports: 222,
      nextStatus: 'unclaimed',
      rejectedReason: null,
    });
    const byDestination = new Map(
      [...store.obligations.values()].map((o) => [o.destination, o.state]),
    );
    expect(byDestination.get(current)).toBe('void');
    expect(byDestination.get(retired)).toBe('open');
  });
});

// ===========================================================================
// T10 — no secret material anywhere
// ===========================================================================

describe('T10 secret hygiene', () => {
  it('never logs, alerts, or returns the verify wallet secret', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('sig-secret-check'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: opened.challengeId,
    });
    rpc.sendThrows = true;
    await sweepTransferChallenges();
    clockMs += 11 * 60 * 1000;
    await sweepTransferChallenges();
    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });

    const secretB58 = bs58.encode(verifyKeypair.secretKey);
    const secretJson = JSON.stringify(Array.from(verifyKeypair.secretKey));
    const haystack = [
      JSON.stringify(alerts),
      logs.join('\n'),
      JSON.stringify(status),
      JSON.stringify(opened),
    ].join('\n');
    expect(haystack).not.toContain(secretB58);
    expect(haystack).not.toContain(secretJson);
    expect(haystack).not.toContain(store.wallet!.encryptedSecretKey);
    // The PUBLIC key is fine, and is what an operator needs.
    expect(status.destination).toBe(verifyKeypair.publicKey.toBase58());
  });
});

// ===========================================================================
// Polling
// ===========================================================================

describe('pollTransferChallenge', () => {
  it('refuses another account’s challenge', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await expect(
      pollTransferChallenge({ userId: USER_B, challengeId: opened.challengeId }),
    ).rejects.toMatchObject({ code: 'challenge_not_found', status: 404 });
  });

  it('refuses a malformed id without touching the store', async () => {
    let touched = 0;
    store.getChallengeForUser = async () => {
      touched += 1;
      return null;
    };
    await expect(
      pollTransferChallenge({ userId: USER_A, challengeId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(LandHoldVerifyError);
    expect(touched).toBe(0);
  });

  it('expires only the requested lapsed row on the GET path', async () => {
    const walletA = pubkey();
    const walletB = pubkey();
    const first = await openFor(USER_A, walletA);
    store.declare(USER_B, walletB);
    const second = await openTransferChallenge({ userId: USER_B, declaredWallet: walletB });
    clockMs += landHoldVerifyTtlMs() + 1_000;
    store.expireLapsedChallenges = async () => {
      throw new Error('table-wide expiry must not run on GET');
    };

    await expect(
      pollTransferChallenge({ userId: USER_A, challengeId: first.challengeId }),
    ).resolves.toMatchObject({ state: 'expired' });
    expect(store.row(second.challengeId).status).toBe('pending');
  });

  it('settles a memo-less exact transfer via scan discovery and full-fetch verification', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-memo-less'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
    });

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status.state).toBe('verified');
    expect(status.inboundSignature).toBe(sig('poll-memo-less'));
    expect(store.user(USER_A).verifiedPubkey).toBe(wallet);
    expect(rpc.commitments.filter((entry) => entry === 'tx:finalized')).toHaveLength(2);

    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('skips a poll candidate with null block time and leaves it pending for retry', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-null-block-time'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      blockTimeMs: null,
    });

    const status = await pollTransferChallenge({
      userId: USER_A,
      challengeId: opened.challengeId,
    });
    expect(status).toMatchObject({ state: 'pending', inboundSignature: null });
    expect(store.row(opened.challengeId)).toMatchObject({
      status: 'pending',
      inboundSignature: null,
    });
  });

  it('continues past an earlier null-block-time candidate and verifies the later payment', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-null-block-earliest'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      blockTimeMs: clockMs - 2_000,
    });
    publishInbound(sig('poll-valid-later'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      blockTimeMs: clockMs - 1_000,
    });
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    const readsBySignature = new Map<string, number>();
    rpc.getParsedTransaction = async (signature, config) => {
      const reads = (readsBySignature.get(signature) ?? 0) + 1;
      readsBySignature.set(signature, reads);
      if (signature === sig('poll-null-block-earliest') && reads > 1) {
        return parsedTx({
          blockTimeMs: null,
          signers: [wallet],
          top: [
            { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
          ],
        });
      }
      return realGetParsedTransaction(signature, config);
    };

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toMatchObject({
      state: 'verified',
      inboundSignature: sig('poll-valid-later'),
    });
    expect(readsBySignature.get(sig('poll-null-block-earliest'))).toBe(2);
    expect(readsBySignature.get(sig('poll-valid-later'))).toBe(2);
  });

  it('stops a multi-candidate batch after one destination-set attribution outage', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('destination-outage-first'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs - 2_000,
    });
    publishInbound(sig('destination-outage-second'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      blockTimeMs: clockMs - 1_000,
    });

    const realListVerifyDestinations = store.listVerifyDestinations.bind(store);
    let harvestLookupCompleted = false;
    let attributionDestinationAttempts = 0;
    store.listVerifyDestinations = async () => {
      if (!harvestLookupCompleted) {
        harvestLookupCompleted = true;
        return realListVerifyDestinations();
      }
      attributionDestinationAttempts += 1;
      throw new Error('destination set unavailable during attribution');
    };
    const realGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    const readsBySignature = new Map<string, number>();
    rpc.getParsedTransaction = async (signature, config) => {
      readsBySignature.set(signature, (readsBySignature.get(signature) ?? 0) + 1);
      return realGetParsedTransaction(signature, config);
    };

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toMatchObject({ state: 'pending', inboundSignature: null });
    expect(attributionDestinationAttempts).toBe(1);
    expect(readsBySignature.get(sig('destination-outage-first'))).toBe(2);
    expect(readsBySignature.get(sig('destination-outage-second'))).toBe(1);
  });

  it('attributes the earliest matching block time first', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-earliest'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      blockTimeMs: clockMs - 2_000,
    });
    publishInbound(sig('poll-later'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      blockTimeMs: clockMs - 1_000,
    });

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status.inboundSignature).toBe(sig('poll-earliest'));
  });

  it('attributes source_not_signer through the same poll path and refunds it', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-unsigned'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      signed: false,
    });

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toMatchObject({ state: 'rejected', rejectedReason: 'source_not_signer' });
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('attributes transfer_not_top_level through the same poll path and refunds it', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-inner-transfer'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
      inner: true,
    });

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toMatchObject({ state: 'rejected', rejectedReason: 'transfer_not_top_level' });
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('uses the full fetch when scan facts disagree and refunds a rejected candidate', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    publishInbound(sig('poll-facts-disagree'), {
      from: wallet,
      to: store.wallet!.publicKey,
      lamports: opened.lamports,
      memo: null,
    });
    const originalGetParsedTransaction = rpc.getParsedTransaction.bind(rpc);
    let reads = 0;
    rpc.getParsedTransaction = async (signature, config) => {
      reads += 1;
      if (reads === 1) return originalGetParsedTransaction(signature, config);
      return parsedTx({
        blockTimeMs: clockMs,
        signers: [wallet],
        opaqueTop: true,
        inner: [
          { source: wallet, destination: store.wallet!.publicKey, lamports: opened.lamports },
        ],
      });
    };

    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toMatchObject({ state: 'rejected', rejectedReason: 'transfer_not_top_level' });
    expect(reads).toBe(2);
    await sweepTransferChallenges();
    expect(store.row(opened.challengeId).refundState).toBe('sent');
  });

  it('does no scan or RPC work for a settled row', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    await payAndSubmit(USER_A, opened, sig('poll-settled'));
    const before = rpc.commitments.length;
    for (let i = 0; i < 6; i += 1) {
      await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    }
    expect(rpc.commitments).toHaveLength(before);
  });

  it('returns pending without throwing when scan RPC fails', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    rpc.getSignaturesForAddress = async () => {
      throw new Error('rpc unavailable');
    };

    await expect(
      pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId }),
    ).resolves.toMatchObject({ state: 'pending', inboundSignature: null });
    expect(store.row(opened.challengeId).status).toBe('pending');
  });

  it('reports the full frozen status shape', async () => {
    const wallet = pubkey();
    const opened = await openFor(USER_A, wallet);
    const status = await pollTransferChallenge({ userId: USER_A, challengeId: opened.challengeId });
    expect(status).toEqual({
      challengeId: opened.challengeId,
      state: 'pending',
      rejectedReason: null,
      refundState: 'none',
      inboundSignature: null,
      refundSignature: null,
      destination: opened.destination,
      lamports: opened.lamports,
      memo: opened.memo,
      expiresAt: opened.expiresAt,
    });
  });
});

// ===========================================================================
// Ops alerting
// ===========================================================================

describe('alert throttling', () => {
  it('collapses a repeated condition into one page per window', async () => {
    process.env.LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL = '0.01';
    const wallet = pubkey();
    store.declare(USER_A, wallet);
    seedRefundedFees(Number(10_000_000n / REFUND_FEE_LAMPORTS));
    for (let i = 0; i < 4; i += 1) {
      store.seed({
        userId: USER_A,
        walletPubkey: wallet,
        lamports: 1_000_000 + i,
        status: 'observed',
        inboundSignature: `inbound-cap-${i}`,
      });
    }
    await sweepTransferChallenges();
    expect(alerts.filter((a) => a.message.includes('refund-fee cap'))).toHaveLength(1);
    expect(_landHoldVerifyAlertThrottleSizeForTest()).toBeGreaterThan(0);
    expect(store.rows.filter((r) => r.refundState === 'none')).toHaveLength(4);
    expect(rpc.sentRaw).toHaveLength(0);
  });
});

// ===========================================================================
// Fee accounting
// ===========================================================================

describe('fee accounting', () => {
  it('charges our own base fee against the global cap on every refund', () => {
    expect(REFUND_FEE_LAMPORTS).toBe(5_000n);
  });
});
