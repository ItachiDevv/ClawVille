/**
 * E3 EARNED redemption service (GATED DARK).
 *
 * Every exported entrypoint re-asserts TOKENOMICS_REDEEM_ENABLED === 'true'.
 * The route performs the same check, so importing/calling this module cannot
 * bypass the legal launch gate.
 *
 * Durable flow:
 * requested -> debited -> buy_queued -> bought -> delivering -> delivered
 *                                                        \-> reconcile
 *
 * `debited` is one DB transaction: eligible backed lots are locked and
 * revalidated; the EARNED-only ledger debit, lot/backing consumption, exact
 * 444-bps retained fee, and redemption transition commit together.
 * `buy_queued` is a second resumable transaction composed with enqueueClvBuy.
 * Funding is a real earned-backing -> clv-swap USDC transfer recorded in
 * clv_swap_funding. Delivery is swap-wallet -> the server-resolved custodial
 * CLV ATA. Both sends claim first, capture before send, and quarantine every
 * ambiguous/captured state for reconciliation; a captured tx is never resent.
 */
import { randomUUID } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { ne } from 'drizzle-orm';
import {
  and,
  asc,
  db,
  earnEvents,
  earnedBackings,
  earnedMintLots,
  earnedRedemptions,
  clvBuyQueue,
  clvSwapFunding,
  treasuryWallets,
  wallets,
  avatars,
  eq,
  gt,
  isNull,
  lte,
  sql,
  type EarnedRedemption,
} from '@clawville/database';
import {
  debitEarnedForRedemption,
  reconcileUnaccountedEarnedLedger,
  type LedgerTx,
} from './claw-token-ledger';
import { enqueueClvBuy, getClvSwapWalletPubkey } from './clv-swap-executor';
import { executeQueuedClvBuy } from './clv-swap-live';
import { getClvMainnetConnection, loadClvSwapKeypair } from './clv-swap-custody';
import { decryptSecretKey } from './keypair-vault';
import { readSplTokenBalance } from './solana-token-balance';
import { CLV_MINT } from './clv-price-oracle';
import { USDC_MINT_MAINNET } from './x402-payai';
import {
  calculateEarnedBackingSolvency,
  earnedBackingIntegrityQuery,
  earnedBackingCustodyLockKey,
  earnedBackingCustodyMutexKey,
  summarizeEarnedBackingIntegrity,
  type EarnedBackingIntegrityCounts,
  type EarnedFundingPrincipal,
} from './earned-solvency';
import { withKeyedMutex } from './keyed-mutex';
export { calculateEarnedBackingSolvency } from './earned-solvency';

export const REDEEM_EXIT_FEE_BPS = 444;
export const MICRO_USD_PER_VCLAW = 10_000n;
export const EXIT_FEE_MICRO_USD_PER_VCLAW = 444n;
export const BUY_MICRO_USD_PER_VCLAW = 9_556n;
export const MAX_REDEMPTION_VCLAW = 1_000_000; // enqueueClvBuy's $10k hard ceiling
export const CLV_DECIMALS = 6;
const TOKEN_ACCOUNT_BYTES = 165;
const DELIVERY_FEE_LAMPORTS = 5_000n;
export const BACKING_FUNDING_SOL_RESERVE_LAMPORTS = 5_000_000n;
export const SWAP_DELIVERY_SOL_RESERVE_LAMPORTS = 4_000_000n;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export class RedeemDisabledError extends Error {
  readonly code = 'redeem_disabled' as const;
  constructor() {
    super("TOKENOMICS_REDEEM_ENABLED is not 'true'");
    this.name = 'RedeemDisabledError';
  }
}

export function isTokenomicsRedeemEnabled(): boolean {
  return process.env.TOKENOMICS_REDEEM_ENABLED === 'true';
}

export function requireTokenomicsRedeemEnabled(): void {
  if (!isTokenomicsRedeemEnabled()) throw new RedeemDisabledError();
}

export function resolveMinRedemptionVclaw(): number {
  const raw = process.env.TOKENOMICS_REDEEM_MIN_VCLAW;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 100;
}

export function exactRedemptionMoney(amountVclaw: number): {
  grossUsdcAtomic: bigint;
  exitFeeUsdcAtomic: bigint;
  buyUsdcAtomic: bigint;
} {
  if (!Number.isSafeInteger(amountVclaw) || amountVclaw <= 0) {
    throw new Error('amount_vclaw_invalid');
  }
  const amount = BigInt(amountVclaw);
  return {
    grossUsdcAtomic: amount * MICRO_USD_PER_VCLAW,
    exitFeeUsdcAtomic: amount * EXIT_FEE_MICRO_USD_PER_VCLAW,
    buyUsdcAtomic: amount * BUY_MICRO_USD_PER_VCLAW,
  };
}

function microToUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export interface RedemptionSubject {
  kind: 'user' | 'agent';
  avatarId: string;
  userId: string;
  agentId?: string | null;
}

export type RedemptionErrorCode =
  | 'redeem_disabled'
  | 'amount_below_min'
  | 'amount_above_max'
  | 'idempotency_conflict'
  | 'redemption_not_found'
  | 'insufficient_redeemable_earned'
  | 'backing_wallet_missing'
  | 'backing_wallet_mixed'
  | 'funding_pending'
  | 'buy_pending'
  | 'delivery_pending'
  | 'reconcile'
  | 'internal';

export type RedemptionResult =
  | { ok: true; redemption: EarnedRedemption; replay: boolean }
  | { ok: false; code: RedemptionErrorCode; redemption?: EarnedRedemption; detail?: string };

function sameTerms(row: EarnedRedemption, amountVclaw: number): boolean {
  return row.amountVclaw === amountVclaw;
}

export function classifyDurableRedemptionStatus(
  status: string,
  failureReason: string | null,
): { ok: true } | { ok: false; code: RedemptionErrorCode } {
  if (status === 'reconcile') return { ok: false, code: 'reconcile' };
  if (status === 'refused') {
    const allowed: RedemptionErrorCode[] = [
      'insufficient_redeemable_earned',
      'backing_wallet_missing',
      'backing_wallet_mixed',
    ];
    return {
      ok: false,
      code: allowed.includes(failureReason as RedemptionErrorCode)
        ? (failureReason as RedemptionErrorCode)
        : 'internal',
    };
  }
  return { ok: true };
}

function classifyExistingRedemption(
  row: EarnedRedemption,
  amountVclaw: number,
): RedemptionResult {
  if (!sameTerms(row, amountVclaw)) {
    return { ok: false, code: 'idempotency_conflict', redemption: row };
  }
  const durable = classifyDurableRedemptionStatus(row.status, row.failureReason);
  if (!durable.ok) {
    return {
      ok: false,
      code: durable.code,
      redemption: row,
      detail: row.status === 'reconcile'
        ? row.failureReason ?? undefined
        : 'durable_refusal_replay',
    };
  }
  return { ok: true, redemption: row, replay: true };
}

const CURRENT_EXTERNAL_WALLET_SQL = sql`NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.public_key IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  ) AND NOT EXISTS (
    SELECT 1 FROM treasury_wallets tw
    WHERE tw.public_key IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  ) AND NOT EXISTS (
    SELECT 1 FROM vanity_keypairs vk
    WHERE vk.public_key IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  ) AND NOT EXISTS (
    SELECT 1 FROM avatars av
    WHERE av.wallet_address IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  ) AND NOT EXISTS (
    SELECT 1 FROM openclaw_bots ob
    WHERE ob.wallet_address IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  ) AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.identity_pubkey IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
       OR u.linked_wallet_pubkey IN (earn_events.payer_wallet, earn_events.first_funder_wallet)
  )`;

async function getSubjectRow(
  id: string,
  subject: RedemptionSubject,
): Promise<EarnedRedemption | null> {
  const [row] = await db
    .select()
    .from(earnedRedemptions)
    .where(
      and(
        eq(earnedRedemptions.id, id),
        eq(earnedRedemptions.subjectType, subject.kind),
        eq(earnedRedemptions.avatarId, subject.avatarId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getEarnedRedemption(
  id: string,
  subject: RedemptionSubject,
): Promise<EarnedRedemption | null> {
  requireTokenomicsRedeemEnabled();
  return getSubjectRow(id, subject);
}

export interface EarnedRedemptionRequestInput {
  subject: RedemptionSubject;
  amountVclaw: number;
  idempotencyKey: string;
}

export interface EarnedRedemptionRequestStore {
  findByIdempotency(input: EarnedRedemptionRequestInput): Promise<EarnedRedemption | null>;
  insert(input: EarnedRedemptionRequestInput, money: ReturnType<typeof exactRedemptionMoney>): Promise<EarnedRedemption | null>;
  debit(id: string): Promise<RedemptionErrorCode | null>;
  enqueue(id: string): Promise<void>;
  get(id: string, subject: RedemptionSubject): Promise<EarnedRedemption | null>;
}

/**
 * Durable request/idempotency orchestration. Production injects the Drizzle
 * store below; tests use an in-memory transactional adapter so replay, race,
 * and eligibility refusals exercise this exact service path without a DB.
 */
export async function requestEarnedRedemptionWithStore(
  input: EarnedRedemptionRequestInput,
  store: EarnedRedemptionRequestStore,
): Promise<RedemptionResult> {
  requireTokenomicsRedeemEnabled();
  const min = resolveMinRedemptionVclaw();
  if (!Number.isSafeInteger(input.amountVclaw) || input.amountVclaw < min) {
    return { ok: false, code: 'amount_below_min', detail: `min=${min}` };
  }
  if (input.amountVclaw > MAX_REDEMPTION_VCLAW) {
    return { ok: false, code: 'amount_above_max', detail: `max=${MAX_REDEMPTION_VCLAW}` };
  }
  const existing = await store.findByIdempotency(input);
  if (existing) {
    return classifyExistingRedemption(existing, input.amountVclaw);
  }

  const money = exactRedemptionMoney(input.amountVclaw);
  const inserted = await store.insert(input, money);
  if (!inserted) {
    const winner = await store.findByIdempotency(input);
    if (!winner) return { ok: false, code: 'internal', detail: 'idem_race_unresolved' };
    return classifyExistingRedemption(winner, input.amountVclaw);
  }

  // HTTP acceptance stops at durable debit + enqueue. Custody/swap/delivery can
  // clip/sleep and therefore belong exclusively to the gated resume worker.
  const debitError = await store.debit(inserted.id);
  if (debitError) {
    const refused = await store.get(inserted.id, input.subject);
    return { ok: false, code: debitError, ...(refused ? { redemption: refused } : {}) };
  }
  await store.enqueue(inserted.id).catch((err) => {
    console.error(JSON.stringify({
      event: 'earned_redemption_enqueue_failed',
      redemptionId: inserted.id,
      error: (err as Error).message,
    }));
  });
  const row = await store.get(inserted.id, input.subject);
  return row
    ? { ok: true, redemption: row, replay: false }
    : { ok: false, code: 'internal', detail: 'redemption_disappeared' };
}

export async function requestEarnedRedemption(
  input: EarnedRedemptionRequestInput,
): Promise<RedemptionResult> {
  const store: EarnedRedemptionRequestStore = {
    findByIdempotency: async (request) => {
      const [row] = await db
        .select()
        .from(earnedRedemptions)
        .where(and(
          eq(earnedRedemptions.subjectType, request.subject.kind),
          eq(earnedRedemptions.avatarId, request.subject.avatarId),
          eq(earnedRedemptions.idempotencyKey, request.idempotencyKey),
        ))
        .limit(1);
      return row ?? null;
    },
    insert: async (request, money) => {
      const [row] = await db
        .insert(earnedRedemptions)
        .values({
          subjectType: request.subject.kind,
          avatarId: request.subject.avatarId,
          idempotencyKey: request.idempotencyKey,
          amountVclaw: request.amountVclaw,
          grossUsdcAtomic: money.grossUsdcAtomic.toString(),
          exitFeeUsdcAtomic: money.exitFeeUsdcAtomic.toString(),
          buyUsdcAtomic: money.buyUsdcAtomic.toString(),
          metadata: {
            requestedBy: request.subject.kind,
            ...(request.subject.agentId ? { agentId: request.subject.agentId } : {}),
          },
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
    debit: debitRequested,
    enqueue: enqueueDebited,
    get: getSubjectRow,
  };
  return requestEarnedRedemptionWithStore(input, store);
}

export interface EligibleAllocation {
  mintLotId: string;
  vclawAmount: number;
}

export interface RedeemableLotCandidate {
  mintLotId: string;
  remainingVclaw: number;
  backingKind: 'backed' | 'none';
  backingNetwork: 'mainnet' | 'devnet';
  custodyWalletId: string | null;
  backingRemainingUsdcAtomic: string | null;
  payerVerification: 'pending' | 'verified' | 'rejected';
  vestsAt: Date | null;
  clawedBackAt: Date | null;
}

export type RedeemableAllocationPlan =
  | { ok: true; allocations: EligibleAllocation[]; backingUsdcAtomic: bigint }
  | {
      ok: false;
      code: 'insufficient_redeemable_earned';
      ineligibleReasons: Array<
        'unbacked' | 'wrong_backing_network' | 'pending_verification' | 'rejected_verification' | 'unvested' |
        'clawed_back' | 'backing_wallet_mismatch' | 'backing_shortfall'
      >;
    };

/**
 * Oldest-first eligibility/conservation kernel used by production preflight
 * and debit selection. An allocation is admitted only when a backed dollar is
 * present for every selected vCLAW (10,000 micro-USDC exactly).
 */
export function planRedeemableEarnedAllocations(input: {
  amountVclaw: number;
  custodyWalletId: string;
  now: Date;
  lots: RedeemableLotCandidate[];
}): RedeemableAllocationPlan {
  let remaining = input.amountVclaw;
  let backingUsdcAtomic = 0n;
  const allocations: EligibleAllocation[] = [];
  const reasons = new Set<
    'unbacked' | 'wrong_backing_network' | 'pending_verification' | 'rejected_verification' | 'unvested' |
    'clawed_back' | 'backing_wallet_mismatch' | 'backing_shortfall'
  >();

  for (const lot of input.lots) {
    if (remaining === 0) break;
    if (lot.remainingVclaw <= 0) continue;
    if (lot.backingKind !== 'backed' || lot.backingRemainingUsdcAtomic === null) {
      reasons.add('unbacked');
      continue;
    }
    if (lot.backingNetwork !== 'mainnet') {
      reasons.add('wrong_backing_network');
      continue;
    }
    if (lot.custodyWalletId !== input.custodyWalletId) {
      reasons.add('backing_wallet_mismatch');
      continue;
    }
    if (lot.payerVerification !== 'verified') {
      reasons.add(lot.payerVerification === 'pending' ? 'pending_verification' : 'rejected_verification');
      continue;
    }
    if (lot.vestsAt === null || lot.vestsAt.getTime() > input.now.getTime()) {
      reasons.add('unvested');
      continue;
    }
    if (lot.clawedBackAt !== null) {
      reasons.add('clawed_back');
      continue;
    }
    const backing = BigInt(lot.backingRemainingUsdcAtomic);
    // Never floor a malformed/short row into a partially cashable balance.
    // The row is either exact at 1 vCLAW = 10,000 micro-USDC or wholly ineligible.
    if (backing !== BigInt(lot.remainingVclaw) * MICRO_USD_PER_VCLAW) {
      reasons.add('backing_shortfall');
      continue;
    }
    const take = Math.min(remaining, lot.remainingVclaw);
    allocations.push({ mintLotId: lot.mintLotId, vclawAmount: take });
    backingUsdcAtomic += BigInt(take) * MICRO_USD_PER_VCLAW;
    remaining -= take;
  }

  if (remaining !== 0) {
    return {
      ok: false,
      code: 'insufficient_redeemable_earned',
      ineligibleReasons: [...reasons],
    };
  }
  return { ok: true, allocations, backingUsdcAtomic };
}

async function debitRequested(id: string): Promise<RedemptionErrorCode | null> {
  try {
    return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(earnedRedemptions)
      .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')))
      .for('update')
      .limit(1);
    if (!row) return null;

    // Global lock order is avatar -> EARNED lots. Ordinary spend uses the same
    // order; taking the avatar first prevents a redemption/spend deadlock.
    const [lockedAvatar] = await tx.select({ id: avatars.id }).from(avatars)
      .where(eq(avatars.id, row.avatarId)).for('update').limit(1);
    if (!lockedAvatar) {
      await tx.update(earnedRedemptions).set({ status: 'refused', failureReason: 'insufficient_redeemable_earned', updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')));
      return 'insufficient_redeemable_earned';
    }

    // Rollout bridge: convert any historical EARNED balance not yet represented
    // by mint lots before eligibility selection. The bridge preserves exact
    // ledger membership, marks legacy excess/unmatched credits unbacked, and
    // runs under this same avatar-locked debit transaction.
    await reconcileUnaccountedEarnedLedger(tx as LedgerTx, row.avatarId);

    // Partial UNIQUE in 0030 makes this structurally singleton. Refuse zero or
    // multiple rows anyway; no newest/first-row guessing on a money path.
    const custodyRows = await tx
      .select({ id: treasuryWallets.id })
      .from(treasuryWallets)
      .where(eq(treasuryWallets.purpose, 'earned-backing'));
    if (custodyRows.length !== 1) {
      await tx.update(earnedRedemptions).set({ status: 'refused', failureReason: 'backing_wallet_missing', updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')));
      return 'backing_wallet_missing';
    }
    const custodyWalletId = custodyRows[0].id;

    const [integrityRow] = await tx.execute<EarnedBackingIntegrityCounts>(
      earnedBackingIntegrityQuery(custodyWalletId),
    );
    const integrity = summarizeEarnedBackingIntegrity(integrityRow);
    if (integrity.mismatchCount !== 0) {
      await tx.update(earnedRedemptions).set({
        status: 'refused',
        failureReason: 'backing_wallet_mixed',
        metadata: sql`COALESCE(${earnedRedemptions.metadata}, '{}'::jsonb) || ${JSON.stringify({
          backingIntegrityReasons: integrity.reasons,
        })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')));
      return 'backing_wallet_mixed';
    }

    const lots = await tx
      .select({
        mintLotId: earnedMintLots.id,
        remainingVclaw: earnedMintLots.remainingVclaw,
        backingKind: earnedMintLots.backingKind,
        backingNetwork: earnEvents.backingNetwork,
        custodyWalletId: earnedBackings.custodyWalletId,
        backingRemainingUsdcAtomic: earnedBackings.remainingUsdcAtomic,
        payerVerification: earnEvents.payerVerification,
        vestsAt: earnEvents.vestsAt,
        clawedBackAt: earnEvents.clawedBackAt,
      })
      .from(earnedMintLots)
      .innerJoin(earnEvents, eq(earnEvents.id, earnedMintLots.earnEventId))
      .leftJoin(earnedBackings, eq(earnedBackings.mintLotId, earnedMintLots.id))
      .where(
        and(
          eq(earnedMintLots.avatarId, row.avatarId),
          gt(earnedMintLots.remainingVclaw, 0),
          CURRENT_EXTERNAL_WALLET_SQL,
        ),
      )
      .orderBy(asc(earnedMintLots.createdAt));

    const plan = planRedeemableEarnedAllocations({
      amountVclaw: row.amountVclaw,
      custodyWalletId,
      now: new Date(),
      lots,
    });
    if (!plan.ok) {
      // This is a policy refusal/race, not a pending request. Persist a
      // pre-money terminal row so worker/replay can never reinterpret it.
      await tx.update(earnedRedemptions).set({ status: 'refused', failureReason: 'insufficient_redeemable_earned', updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')));
      return 'insufficient_redeemable_earned';
    }

    const debit = await debitEarnedForRedemption(
      {
        avatarId: row.avatarId,
        amount: row.amountVclaw,
        redemptionId: row.id,
        allocations: plan.allocations,
        metadata: { redemptionId: row.id, exitFeeBps: REDEEM_EXIT_FEE_BPS },
        actorKind: row.subjectType === 'agent' ? 'agent' : 'human',
      },
      tx as LedgerTx,
    );
    const changed = await tx
      .update(earnedRedemptions)
      .set({
        status: 'debited',
        ledgerDebitId: debit.ledgerId,
        backingCustodyWalletId: custodyWalletId,
        exitFeeRetainedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')))
      .returning({ id: earnedRedemptions.id });
    if (!changed[0]) throw new Error('redemption_debit_transition_lost');
    return null;
    });
  } catch (err) {
    // The ledger primitive revalidates CURRENT eligibility after locking the
    // avatar/lots. If eligibility changed after our candidate read, its tx is
    // rolled back in full first; only then persist the durable refusal in a
    // separate tx. Never catch inside the debit tx (that could commit a partial
    // avatar mutation after a downstream lot check threw).
    const message = (err as Error).message;
    if (
      message.includes('is no longer eligible') ||
      message.includes('cannot debit') ||
      message.includes('allocations')
    ) {
      await db.update(earnedRedemptions)
        .set({ status: 'refused', failureReason: 'insufficient_redeemable_earned', updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'requested')));
      return 'insufficient_redeemable_earned';
    }
    throw err;
  }
}

async function enqueueDebited(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(earnedRedemptions)
      .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'debited')))
      .for('update')
      .limit(1);
    if (!row) return;
    const queued = await enqueueClvBuy(
      {
        amountUsdc: microToUsdc(BigInt(row.buyUsdcAtomic)),
        reason: 'earned_redemption',
        sourceRef: row.id,
        metadata: {
          redemptionId: row.id,
          grossUsdcAtomic: row.grossUsdcAtomic,
          exitFeeUsdcAtomic: row.exitFeeUsdcAtomic,
          backingCustodyWalletId: row.backingCustodyWalletId,
        },
      },
      tx as LedgerTx,
    );
    await tx
      .update(earnedRedemptions)
      .set({ status: 'buy_queued', clvBuyQueueId: queued.queueId, updatedAt: new Date() })
      .where(and(eq(earnedRedemptions.id, id), eq(earnedRedemptions.status, 'debited')));
  });
}

function findAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAtaIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferCheckedIx(source: PublicKey, destination: PublicKey, owner: PublicKey, mint: PublicKey, amount: bigint, decimals: number, tokenProgram: PublicKey) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function loadBackingKeypair(walletId: string): Promise<Keypair> {
  const rows = await db
    .select()
    .from(treasuryWallets)
    .where(and(eq(treasuryWallets.id, walletId), eq(treasuryWallets.purpose, 'earned-backing')));
  if (rows.length !== 1) throw new Error('earned_backing_wallet_missing_or_not_singleton');
  const row = rows[0];
  const kp = decryptSecretKey(row.encryptedSecretKey, row.encryptionIv, row.encryptionTag);
  if (kp.publicKey.toBase58() !== row.publicKey) throw new Error('earned_backing_pubkey_mismatch');
  return kp;
}

async function confirm(
  conn: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ outcome: 'confirmed' | 'failed'; slot: number }> {
  const out = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (out.value.err) return { outcome: 'failed', slot: out.context.slot };
  const statuses = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses.value[0];
  if (!status || status.err || !status.confirmationStatus || status.confirmationStatus === 'processed') {
    throw new Error('confirmed_signature_slot_indeterminate');
  }
  return { outcome: 'confirmed', slot: status.slot };
}

async function markRedemptionReconcile(id: string, reason: string): Promise<void> {
  await db
    .update(earnedRedemptions)
    .set({ status: 'reconcile', failureReason: reason, updatedAt: new Date() })
    .where(and(eq(earnedRedemptions.id, id), ne(earnedRedemptions.status, 'delivered')));
}

/** Testable settle ordering primitive: the durable claim commits before any
 * custody/key/signing preparation; the signature capture commits before send.
 * Release is permitted only while the exact claim remains unsigned. */
export async function claimThenPrepareAndCapture<T>(input: {
  claim: () => Promise<boolean>;
  prepare: () => Promise<T | null>;
  capture: (prepared: T) => Promise<boolean>;
  releaseUnsigned: () => Promise<void>;
}): Promise<T | null> {
  if (!(await input.claim())) return null;
  try {
    const prepared = await input.prepare();
    if (prepared === null) {
      await input.releaseUnsigned();
      return null;
    }
    if (!(await input.capture(prepared))) {
      await input.releaseUnsigned();
      return null;
    }
    return prepared;
  } catch {
    await input.releaseUnsigned();
    return null;
  }
}

async function fundQueuedRedemption(row: EarnedRedemption): Promise<'swept' | 'pending' | 'reconcile'> {
  if (!row.clvBuyQueueId || !row.backingCustodyWalletId) return 'pending';
  const amountUsdc = microToUsdc(BigInt(row.buyUsdcAtomic));
  const inserted = await db
    .insert(clvSwapFunding)
    .values({
      sourceRef: row.id,
      checkoutId: null,
      amountUsdc,
      metadata: { queueId: row.clvBuyQueueId, reason: 'earned_redemption', redemptionId: row.id },
    })
    .onConflictDoNothing({ target: clvSwapFunding.sourceRef })
    .returning();
  const funding = inserted[0] ?? (await db.select().from(clvSwapFunding).where(eq(clvSwapFunding.sourceRef, row.id)).limit(1))[0];
  if (!funding) return 'pending';
  const fundingMeta = (funding.metadata ?? {}) as Record<string, unknown>;
  if (
    funding.amountUsdc !== amountUsdc ||
    funding.checkoutId !== null ||
    fundingMeta.queueId !== row.clvBuyQueueId ||
    fundingMeta.reason !== 'earned_redemption' ||
    fundingMeta.redemptionId !== row.id
  ) {
    await markRedemptionReconcile(row.id, 'funding_binding_mismatch');
    return 'reconcile';
  }
  await db
    .update(earnedRedemptions)
    .set({ clvSwapFundingId: funding.id, updatedAt: new Date() })
    .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.status, 'buy_queued')));
  if (funding.status === 'swept') {
    if (!isConfirmedFundingSweep(funding)) {
      await markRedemptionReconcile(row.id, 'swept_funding_proof_missing');
      return 'reconcile';
    }
    return 'swept';
  }
  if (funding.status === 'reconcile' || funding.status === 'failed') {
    await markRedemptionReconcile(row.id, `funding_${funding.status}`);
    return 'reconcile';
  }
  if (funding.status === 'sweeping') {
    const observedClaimedAt = funding.claimedAt;
    if (observedClaimedAt === null) {
      return (await quarantineNullFundingClaim({
        claimedAt: observedClaimedAt,
        quarantineExactSnapshot: async () => {
          const [quarantined] = await db.update(clvSwapFunding)
            .set({ status: 'reconcile', failureReason: 'stale_funding_claim_shape_invalid' })
            .where(and(
              eq(clvSwapFunding.id, funding.id),
              eq(clvSwapFunding.status, 'sweeping'),
              funding.claimId === null
                ? isNull(clvSwapFunding.claimId)
                : eq(clvSwapFunding.claimId, funding.claimId),
              isNull(clvSwapFunding.claimedAt),
              funding.sweepTxSignature === null
                ? isNull(clvSwapFunding.sweepTxSignature)
                : eq(clvSwapFunding.sweepTxSignature, funding.sweepTxSignature),
            ))
            .returning({ id: clvSwapFunding.id });
          return Boolean(quarantined);
        },
        quarantineRedemption: () =>
          markRedemptionReconcile(row.id, 'stale_funding_claim_shape_invalid'),
      })) ?? 'pending';
    }
    if (observedClaimedAt.getTime() > Date.now() - 5 * 60_000) {
      return 'pending';
    }
    if (funding.sweepTxSignature) {
      const observedCapture = {
        claimId: funding.claimId,
        claimedAt: observedClaimedAt,
        sweepTxSignature: funding.sweepTxSignature,
      };
      const [currentCapture] = await db.select({
        status: clvSwapFunding.status,
        claimId: clvSwapFunding.claimId,
        claimedAt: clvSwapFunding.claimedAt,
        sweepTxSignature: clvSwapFunding.sweepTxSignature,
      }).from(clvSwapFunding).where(eq(clvSwapFunding.id, funding.id)).limit(1);
      if (!currentCapture || !sameCapturedFundingSnapshot(observedCapture, currentCapture)) {
        return 'pending';
      }
      const [quarantined] = await db.update(clvSwapFunding)
        .set({ status: 'reconcile', failureReason: 'stale_captured_funding' })
        .where(and(
          eq(clvSwapFunding.id, funding.id),
          eq(clvSwapFunding.status, 'sweeping'),
          observedCapture.claimId === null
            ? isNull(clvSwapFunding.claimId)
            : eq(clvSwapFunding.claimId, observedCapture.claimId),
          eq(clvSwapFunding.claimedAt, observedCapture.claimedAt),
          eq(clvSwapFunding.sweepTxSignature, observedCapture.sweepTxSignature),
        ))
        .returning({ id: clvSwapFunding.id });
      if (!quarantined) return 'pending';
      await markRedemptionReconcile(row.id, 'stale_captured_funding');
      return 'reconcile';
    }
    if (!funding.claimId || !funding.claimedAt) {
      const [quarantined] = await db.update(clvSwapFunding)
        .set({ status: 'reconcile', failureReason: 'stale_funding_claim_shape_invalid' })
        .where(and(
          eq(clvSwapFunding.id, funding.id),
          eq(clvSwapFunding.status, 'sweeping'),
          funding.claimId === null
            ? isNull(clvSwapFunding.claimId)
            : eq(clvSwapFunding.claimId, funding.claimId),
          funding.claimedAt === null
            ? isNull(clvSwapFunding.claimedAt)
            : eq(clvSwapFunding.claimedAt, funding.claimedAt),
          isNull(clvSwapFunding.sweepTxSignature),
        ))
        .returning({ id: clvSwapFunding.id });
      if (!quarantined) return 'pending';
      await markRedemptionReconcile(row.id, 'stale_funding_claim_shape_invalid');
      return 'reconcile';
    }
    const observedClaim = { claimId: funding.claimId, claimedAt: funding.claimedAt };
    const [currentClaim] = await db.select({
      claimId: clvSwapFunding.claimId,
      claimedAt: clvSwapFunding.claimedAt,
    }).from(clvSwapFunding).where(eq(clvSwapFunding.id, funding.id)).limit(1);
    if (!currentClaim || !sameFundingClaimSnapshot(observedClaim, currentClaim)) return 'pending';
    await db.update(clvSwapFunding).set({ status: 'pending', claimId: null, claimedAt: null })
      .where(and(
        eq(clvSwapFunding.id, funding.id),
        eq(clvSwapFunding.status, 'sweeping'),
        eq(clvSwapFunding.claimId, observedClaim.claimId),
        eq(clvSwapFunding.claimedAt, observedClaim.claimedAt),
        sql`${clvSwapFunding.sweepTxSignature} IS NULL`,
      ));
    return 'pending';
  }

  const custodyWalletId = row.backingCustodyWalletId;
  const mutexKey = earnedBackingCustodyMutexKey(custodyWalletId);
  const advisoryLockKey = earnedBackingCustodyLockKey(custodyWalletId);

  return withKeyedMutex(mutexKey, async () => {
    const claimId = randomUUID();
    const claimedAt = new Date();
    type PreparedFunding = {
      connection: Connection;
      serializedTransaction: Buffer;
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    };

    const releaseUnsigned = async (): Promise<void> => {
      await db.update(clvSwapFunding).set({ status: 'pending', claimId: null, claimedAt: null })
        .where(and(
          eq(clvSwapFunding.id, funding.id),
          eq(clvSwapFunding.status, 'sweeping'),
          eq(clvSwapFunding.claimId, claimId),
          eq(clvSwapFunding.claimedAt, claimedAt),
          isNull(clvSwapFunding.sweepTxSignature),
        ));
    };

    const captured = await claimThenPrepareAndCapture<PreparedFunding>({
      // Phase 1: commit a fresh claim before decrypting or signing anything.
      claim: async () => db.transaction(async (claimTx) => {
        await claimTx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryLockKey})`);
        const [claimed] = await claimTx.update(clvSwapFunding)
          .set({ status: 'sweeping', claimId, claimedAt })
          .where(and(
            eq(clvSwapFunding.id, funding.id),
            eq(clvSwapFunding.status, 'pending'),
            isNull(clvSwapFunding.sweepTxSignature),
          ))
          .returning({ id: clvSwapFunding.id });
        return Boolean(claimed);
      }),
      // Phase 2a: custody/key/RPC/signing work occurs only after claim commit.
      prepare: async () => {
        const backing = await loadBackingKeypair(custodyWalletId);
        const swapPubkeyString = await getClvSwapWalletPubkey();
        if (!swapPubkeyString) throw new Error('clv_swap_wallet_missing');
        const swapPubkey = new PublicKey(swapPubkeyString);
        const connection = getClvMainnetConnection();
        const amount = BigInt(row.buyUsdcAtomic);
        const balance = await readSplTokenBalance(
          connection,
          USDC_MINT_MAINNET,
          backing.publicKey.toBase58(),
        );
        if (balance.amountAtomic < amount) return null;

        const mint = new PublicKey(USDC_MINT_MAINNET);
        const sourceAta = findAta(backing.publicKey, mint, TOKEN_PROGRAM_ID);
        const destAta = findAta(swapPubkey, mint, TOKEN_PROGRAM_ID);
        const destExists = (await connection.getAccountInfo(destAta, 'confirmed')) !== null;
        const ataRent = destExists
          ? 0n
          : BigInt(await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES));
        const backingSol = BigInt(await connection.getBalance(backing.publicKey, 'confirmed'));
        if (backingSol < BACKING_FUNDING_SOL_RESERVE_LAMPORTS + DELIVERY_FEE_LAMPORTS + ataRent) {
          return null;
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const transfer = new Transaction({ feePayer: backing.publicKey, blockhash, lastValidBlockHeight })
          .add(createAtaIx(backing.publicKey, destAta, swapPubkey, mint, TOKEN_PROGRAM_ID))
          .add(transferCheckedIx(sourceAta, destAta, backing.publicKey, mint, amount, 6, TOKEN_PROGRAM_ID));
        transfer.sign(backing);
        if (!transfer.signature) throw new Error('funding_sign_missing');
        const signature = bs58.encode(transfer.signature);
        return {
          connection,
          serializedTransaction: transfer.serialize(),
          signature,
          blockhash,
          lastValidBlockHeight,
        };
      },
      // Phase 2b: persist the signature against the exact durable claim.
      capture: async (prepared) => db.transaction(async (captureTx) => {
        await captureTx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryLockKey})`);
        const [capture] = await captureTx.update(clvSwapFunding)
          .set({ sweepTxSignature: prepared.signature })
          .where(and(
            eq(clvSwapFunding.id, funding.id),
            eq(clvSwapFunding.status, 'sweeping'),
            eq(clvSwapFunding.claimId, claimId),
            eq(clvSwapFunding.claimedAt, claimedAt),
            isNull(clvSwapFunding.sweepTxSignature),
          ))
          .returning({ id: clvSwapFunding.id });
        return Boolean(capture);
      }),
      releaseUnsigned,
    });

    if (!captured) return 'pending';

    // Phase/transaction 3 reacquires the same cross-rail lock and holds it across
    // send + confirmation + swept-state commit. E1 cannot reserve newly arrived
    // backing against dollars being moved during this critical section.
    return db.transaction(async (sendTx): Promise<'swept' | 'pending' | 'reconcile'> => {
      await sendTx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryLockKey})`);
      const [fresh] = await sendTx
        .select()
        .from(clvSwapFunding)
        .where(eq(clvSwapFunding.id, funding.id))
        .limit(1);
      if (
        !fresh ||
        fresh.status !== 'sweeping' ||
        fresh.claimId !== claimId ||
        fresh.claimedAt?.getTime() !== claimedAt.getTime() ||
        fresh.sweepTxSignature !== captured.signature
      ) {
        return 'pending';
      }

      let sent = false;
      try {
        const echoed = await captured.connection.sendRawTransaction(
          captured.serializedTransaction,
          { skipPreflight: false },
        );
        if (echoed !== captured.signature) throw new Error('funding_signature_mismatch');
        sent = true;
        const confirmation = await confirm(
          captured.connection,
          captured.signature,
          captured.blockhash,
          captured.lastValidBlockHeight,
        );
        if (confirmation.outcome === 'failed') throw new Error('funding_tx_failed_on_chain');

        const [marked] = await sendTx
          .update(clvSwapFunding)
          .set({
            status: 'swept',
            sweptAt: new Date(),
            sweepConfirmedSlot: confirmation.slot,
          })
          .where(and(
            eq(clvSwapFunding.id, funding.id),
            eq(clvSwapFunding.claimId, claimId),
            eq(clvSwapFunding.claimedAt, claimedAt),
            eq(clvSwapFunding.status, 'sweeping'),
            eq(clvSwapFunding.sweepTxSignature, captured.signature),
          ))
          .returning({ id: clvSwapFunding.id });
        if (!marked) throw new Error('funding_swept_mark_missed');
      } catch {
        const reason = sent ? 'funding_confirm_ambiguous' : 'funding_send_ambiguous';
        await sendTx
          .update(clvSwapFunding)
          .set({ status: 'reconcile', failureReason: reason })
          .where(and(
            eq(clvSwapFunding.id, funding.id),
            eq(clvSwapFunding.status, 'sweeping'),
            eq(clvSwapFunding.claimId, claimId),
            eq(clvSwapFunding.claimedAt, claimedAt),
            eq(clvSwapFunding.sweepTxSignature, captured.signature),
          ));
        await sendTx
          .update(earnedRedemptions)
          .set({ status: 'reconcile', failureReason: reason, updatedAt: new Date() })
          .where(and(eq(earnedRedemptions.id, row.id), ne(earnedRedemptions.status, 'delivered')));
        return 'reconcile';
      }
      return 'swept';
    });
  });
}

export function sumConservativeQueueOutput(raw: unknown): bigint | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let total = 0n;
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null;
    const amount = (value as { outAmountAtomic?: unknown }).outAmountAtomic;
    if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) return null;
    total += BigInt(amount);
  }
  return total > 0n ? total : null;
}

function usdcStringToMicro(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,14}(\.\d{1,6})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

export function validateRedemptionQueueFills(
  raw: unknown,
  expectedInputMicro: bigint,
): bigint | null {
  const output = sumConservativeQueueOutput(raw);
  if (output === null || !Array.isArray(raw)) return null;
  let input = 0n;
  for (const fill of raw) {
    const parsed = usdcStringToMicro((fill as { amountUsdc?: unknown }).amountUsdc);
    if (parsed === null || parsed <= 0n) return null;
    input += parsed;
  }
  return input === expectedInputMicro ? output : null;
}

export function isConfirmedFundingSweep(input: {
  status: string;
  sweepTxSignature: string | null;
  sweepConfirmedSlot: number | null;
}): boolean {
  return input.status === 'swept' &&
    Boolean(input.sweepTxSignature) &&
    Number.isSafeInteger(input.sweepConfirmedSlot) &&
    (input.sweepConfirmedSlot ?? 0) > 0;
}

export function maxRequiredFundingContextSlot(
  principals: EarnedFundingPrincipal[],
): number {
  return principals.reduce((max, principal) =>
    principal.fundingStatus === 'swept' &&
    typeof principal.fundingConfirmedSlot === 'number' &&
    Number.isSafeInteger(principal.fundingConfirmedSlot) &&
    principal.fundingConfirmedSlot > max
      ? principal.fundingConfirmedSlot
      : max, 0);
}

export function fundingContextLagReason(
  actualSlot: number,
  minContextSlot: number,
): string | null {
  return minContextSlot > 0 && actualSlot < minContextSlot
    ? `custody_rpc_context_stale:${actualSlot}<${minContextSlot}`
    : null;
}

export function sameFundingClaimSnapshot(
  observed: { claimId: string; claimedAt: Date },
  current: { claimId: string | null; claimedAt: Date | null },
): boolean {
  return current.claimId === observed.claimId &&
    current.claimedAt?.getTime() === observed.claimedAt.getTime();
}

export function sameCapturedFundingSnapshot(
  observed: {
    claimId: string | null;
    claimedAt: Date;
    sweepTxSignature: string;
  },
  current: {
    status: string;
    claimId: string | null;
    claimedAt: Date | null;
    sweepTxSignature: string | null;
  },
): boolean {
  return current.status === 'sweeping' &&
    current.claimId === observed.claimId &&
    current.claimedAt?.getTime() === observed.claimedAt.getTime() &&
    current.sweepTxSignature === observed.sweepTxSignature;
}

/** Null `claimed_at` is malformed durable state, never an active claim that
 * may be reset or reclaimed. Exact-snapshot CAS stays supplied by production. */
export async function quarantineNullFundingClaim(input: {
  claimedAt: Date | null;
  quarantineExactSnapshot: () => Promise<boolean>;
  quarantineRedemption: () => Promise<void>;
}): Promise<'pending' | 'reconcile' | null> {
  if (input.claimedAt !== null) return null;
  if (!(await input.quarantineExactSnapshot())) return 'pending';
  await input.quarantineRedemption();
  return 'reconcile';
}

export type CapturedSendResult =
  | { ok: true; captured: true }
  | { ok: false; captured: boolean; code: 'capture_lost' | 'send_ambiguous' };

/** Shared/testable capture-before-send kernel. A successful capture is never
 * released or resent; every send/confirm/mark uncertainty calls reconcile. */
export async function executeCapturedSend(input: {
  signature: string;
  raw: Uint8Array;
  capture: () => Promise<boolean>;
  send: (raw: Uint8Array) => Promise<string>;
  confirm: () => Promise<'confirmed' | 'failed'>;
  markDelivered: () => Promise<boolean>;
  markReconcile: (reason: string) => Promise<void>;
}): Promise<CapturedSendResult> {
  if (!(await input.capture())) return { ok: false, captured: false, code: 'capture_lost' };
  let sent = false;
  try {
    const echoed = await input.send(input.raw);
    if (echoed !== input.signature) throw new Error('rpc_signature_mismatch');
    sent = true;
    const outcome = await input.confirm();
    if (outcome === 'failed') throw new Error('tx_failed_on_chain');
    if (!(await input.markDelivered())) throw new Error('delivered_mark_missed');
    return { ok: true, captured: true };
  } catch {
    await input.markReconcile(sent ? 'confirm_ambiguous' : 'send_ambiguous');
    return { ok: false, captured: true, code: 'send_ambiguous' };
  }
}

async function advanceBuy(row: EarnedRedemption): Promise<void> {
  const funding = await fundQueuedRedemption(row);
  if (funding !== 'swept' || !row.clvBuyQueueId) return;
  const expectedBuy = BigInt(row.buyUsdcAtomic);
  let [queue] = await db.select().from(clvBuyQueue).where(eq(clvBuyQueue.id, row.clvBuyQueueId)).limit(1);
  if (!queue) return;
  if (
    queue.reason !== 'earned_redemption' ||
    queue.sourceRef !== row.id ||
    usdcStringToMicro(queue.amountUsdc) !== expectedBuy
  ) {
    await markRedemptionReconcile(row.id, 'queue_binding_invalid');
    return;
  }
  if (queue.status === 'planned') {
    await executeQueuedClvBuy(row.clvBuyQueueId).catch((err) => {
      console.error(JSON.stringify({
        event: 'earned_redemption_clv_buy_failed',
        redemptionId: row.id,
        queueId: row.clvBuyQueueId,
        error: (err as Error).message,
      }));
    });
    [queue] = await db.select().from(clvBuyQueue).where(eq(clvBuyQueue.id, row.clvBuyQueueId)).limit(1);
  }
  if (!queue || queue.status !== 'executed') return;
  const amount = validateRedemptionQueueFills(queue.txSignatures, expectedBuy);
  if (amount === null) {
    await markRedemptionReconcile(row.id, 'executed_queue_fill_invalid');
    return;
  }
  await db.update(earnedRedemptions)
    .set({ status: 'bought', deliveryClvAtomic: amount.toString(), updatedAt: new Date() })
    .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.status, 'buy_queued'), eq(earnedRedemptions.clvBuyQueueId, queue.id)));
}

async function deliverBought(row: EarnedRedemption): Promise<void> {
  if (!row.deliveryClvAtomic || BigInt(row.deliveryClvAtomic) <= 0n) {
    await markRedemptionReconcile(row.id, 'delivery_amount_missing');
    return;
  }
  const claimId = randomUUID();
  const [claimed] = await db.update(earnedRedemptions)
    .set({ status: 'delivering', deliveryClaimId: claimId, deliveryClaimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.status, 'bought')))
    .returning();
  if (!claimed) return;
  let captured = false;
  try {
    const [wallet] = await db.select({ publicKey: wallets.publicKey })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, row.avatarId)))
      .limit(1);
    const [avatar] = await db.select({ walletAddress: avatars.walletAddress })
      .from(avatars).where(eq(avatars.id, row.avatarId)).limit(1);
    if (!wallet || (avatar?.walletAddress && avatar.walletAddress !== wallet.publicKey)) {
      await markRedemptionReconcile(row.id, 'delivery_wallet_missing_or_mismatch');
      return;
    }
    const destination = new PublicKey(wallet.publicKey);
    const swap = await loadClvSwapKeypair();
    const conn = getClvMainnetConnection();
    const amount = BigInt(row.deliveryClvAtomic);
    const clvBalance = await readSplTokenBalance(conn, CLV_MINT, swap.publicKey.toBase58());
    if (clvBalance.amountAtomic < amount) {
      await db.update(earnedRedemptions)
        .set({ status: 'bought', deliveryClaimId: null, deliveryClaimedAt: null, updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.deliveryClaimId, claimId), sql`${earnedRedemptions.deliveryTxSignature} IS NULL`));
      return;
    }
    const mint = new PublicKey(CLV_MINT);
    const sourceAta = findAta(swap.publicKey, mint, TOKEN_2022_PROGRAM_ID);
    const destAta = findAta(destination, mint, TOKEN_2022_PROGRAM_ID);
    const destExists = (await conn.getAccountInfo(destAta, 'confirmed')) !== null;
    const rent = destExists ? 0n : BigInt(await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES));
    const sol = BigInt(await conn.getBalance(swap.publicKey, 'confirmed'));
    if (sol < SWAP_DELIVERY_SOL_RESERVE_LAMPORTS + DELIVERY_FEE_LAMPORTS + rent) {
      await db.update(earnedRedemptions)
        .set({ status: 'bought', deliveryClaimId: null, deliveryClaimedAt: null, updatedAt: new Date() })
        .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.deliveryClaimId, claimId), sql`${earnedRedemptions.deliveryTxSignature} IS NULL`));
      return;
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: swap.publicKey, blockhash, lastValidBlockHeight })
      .add(createAtaIx(swap.publicKey, destAta, destination, mint, TOKEN_2022_PROGRAM_ID))
      .add(transferCheckedIx(sourceAta, destAta, swap.publicKey, mint, amount, CLV_DECIMALS, TOKEN_2022_PROGRAM_ID));
    tx.sign(swap);
    if (!tx.signature) throw new Error('delivery_sign_missing');
    const signature = bs58.encode(tx.signature);
    const sendResult = await executeCapturedSend({
      signature,
      raw: tx.serialize(),
      capture: async () => {
        const cap = await db.update(earnedRedemptions)
          .set({ deliveryTxSignature: signature, deliveryWalletPubkey: wallet.publicKey, updatedAt: new Date() })
          .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.status, 'delivering'), eq(earnedRedemptions.deliveryClaimId, claimId), sql`${earnedRedemptions.deliveryTxSignature} IS NULL`))
          .returning({ id: earnedRedemptions.id });
        return cap.length === 1;
      },
      send: (raw) => conn.sendRawTransaction(raw, { skipPreflight: false }),
      confirm: async () => (await confirm(conn, signature, blockhash, lastValidBlockHeight)).outcome,
      markDelivered: async () => {
        const marked = await db.update(earnedRedemptions)
          .set({ status: 'delivered', deliveredAt: new Date(), updatedAt: new Date() })
          .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.status, 'delivering'), eq(earnedRedemptions.deliveryClaimId, claimId), eq(earnedRedemptions.deliveryTxSignature, signature)))
          .returning({ id: earnedRedemptions.id });
        return marked.length === 1;
      },
      markReconcile: async (reason) => markRedemptionReconcile(row.id, `delivery_${reason}`),
    });
    captured = sendResult.captured;
    return;
  } catch {
    if (captured) {
      await markRedemptionReconcile(row.id, 'delivery_post_capture_error');
      return;
    }
    await db.update(earnedRedemptions)
      .set({ status: 'bought', deliveryClaimId: null, deliveryClaimedAt: null, updatedAt: new Date() })
      .where(and(eq(earnedRedemptions.id, row.id), eq(earnedRedemptions.deliveryClaimId, claimId), sql`${earnedRedemptions.deliveryTxSignature} IS NULL`));
  }
}

export async function advanceEarnedRedemption(id: string): Promise<RedemptionResult> {
  requireTokenomicsRedeemEnabled();
  let [row] = await db.select().from(earnedRedemptions).where(eq(earnedRedemptions.id, id)).limit(1);
  if (!row) return { ok: false, code: 'redemption_not_found' };
  if (row.status === 'requested') {
    const err = await debitRequested(id);
    if (err) {
      const [refused] = await db.select().from(earnedRedemptions)
        .where(eq(earnedRedemptions.id, id)).limit(1);
      return { ok: false, code: err, ...(refused ? { redemption: refused } : {}) };
    }
  }
  [row] = await db.select().from(earnedRedemptions).where(eq(earnedRedemptions.id, id)).limit(1);
  if (row?.status === 'debited') await enqueueDebited(id);
  [row] = await db.select().from(earnedRedemptions).where(eq(earnedRedemptions.id, id)).limit(1);
  if (row?.status === 'buy_queued') await advanceBuy(row);
  [row] = await db.select().from(earnedRedemptions).where(eq(earnedRedemptions.id, id)).limit(1);
  if (row?.status === 'bought') await deliverBought(row);
  [row] = await db.select().from(earnedRedemptions).where(eq(earnedRedemptions.id, id)).limit(1);
  if (!row) return { ok: false, code: 'redemption_not_found' };
  const durable = classifyDurableRedemptionStatus(row.status, row.failureReason);
  return durable.ok
    ? { ok: true, redemption: row, replay: false }
    : {
        ok: false,
        code: durable.code,
        redemption: row,
        detail: row.status === 'reconcile'
          ? row.failureReason ?? undefined
          : 'durable_refusal',
      };
}

export type DeliveryOnChainVerdict = 'delivered' | 'not_delivered' | 'indeterminate';

export interface ReconcileDeliveryRow {
  id: string;
  status: string;
  failureReason: string | null;
  deliveryTxSignature: string | null;
  deliveryClvAtomic: string | null;
  deliveryWalletPubkey: string | null;
  deliveredAt: Date | null;
  updatedAt: Date;
}

type DeliveryVerificationConnection = Pick<Connection, 'getTransaction'>;

function parseTokenBalanceAtomic(value: string | undefined): bigint | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Proves the captured delivery signature credited the exact expected CLV
 * amount to the captured earner wallet. This helper never mutates durable
 * state and treats absent/malformed/mismatched chain evidence as indeterminate.
 */
export async function verifyDeliveryOnChain(
  conn: DeliveryVerificationConnection,
  row: ReconcileDeliveryRow,
  swapWalletPubkey?: string | null,
): Promise<DeliveryOnChainVerdict> {
  if (
    !row.deliveryTxSignature ||
    !row.deliveryWalletPubkey ||
    !row.deliveryClvAtomic ||
    !/^[1-9]\d*$/.test(row.deliveryClvAtomic)
  ) {
    return 'indeterminate';
  }

  const tx = await conn.getTransaction(row.deliveryTxSignature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) return 'indeterminate';
  if (tx.meta?.err != null) return 'not_delivered';
  if (!tx.meta || !Array.isArray(tx.meta.preTokenBalances) || !Array.isArray(tx.meta.postTokenBalances)) {
    return 'indeterminate';
  }

  const expected = BigInt(row.deliveryClvAtomic);
  const preByIndex = new Map(tx.meta.preTokenBalances.map((balance) => [balance.accountIndex, balance]));
  const postByIndex = new Map(tx.meta.postTokenBalances.map((balance) => [balance.accountIndex, balance]));

  const destinationCredited = tx.meta.postTokenBalances.some((post) => {
    if (post.mint !== CLV_MINT || post.owner !== row.deliveryWalletPubkey) return false;
    const postAmount = parseTokenBalanceAtomic(post.uiTokenAmount.amount);
    if (postAmount === null) return false;
    const pre = preByIndex.get(post.accountIndex);
    if (pre && pre.mint !== CLV_MINT) return false;
    const preAmount = pre ? parseTokenBalanceAtomic(pre.uiTokenAmount.amount) : 0n;
    return preAmount !== null && postAmount - preAmount === expected;
  });
  if (!destinationCredited) return 'indeterminate';

  const sourceOwner = swapWalletPubkey === undefined
    ? await getClvSwapWalletPubkey()
    : swapWalletPubkey;
  if (!sourceOwner) return 'indeterminate';
  let exactSwapDebit = false;
  let sourceEvidencePresent = false;
  for (const pre of tx.meta.preTokenBalances) {
    if (pre.mint !== CLV_MINT) continue;
    const post = postByIndex.get(pre.accountIndex);
    if (post && post.mint !== CLV_MINT) return 'indeterminate';
    const preAmount = parseTokenBalanceAtomic(pre.uiTokenAmount.amount);
    const postAmount = post ? parseTokenBalanceAtomic(post.uiTokenAmount.amount) : 0n;
    if (preAmount === null || postAmount === null) return 'indeterminate';
    const debit = preAmount - postAmount;
    if (pre.owner === sourceOwner) sourceEvidencePresent = true;
    if (debit <= 0n) continue;
    sourceEvidencePresent = true;
    if (pre.owner === sourceOwner && debit === expected) exactSwapDebit = true;
  }
  if (exactSwapDebit) return 'delivered';
  if (sourceEvidencePresent) return 'indeterminate';

  // Destination-only proof is allowed only when the transaction metadata has
  // no identifiable CLV debit side at all. A post-only swap owner is malformed
  // source evidence, not proof that the swap wallet funded the credit.
  const postOnlySwapOwner = tx.meta.postTokenBalances.some((post) =>
    post.mint === CLV_MINT &&
    post.owner === sourceOwner &&
    preByIndex.get(post.accountIndex)?.owner !== sourceOwner);
  return postOnlySwapOwner ? 'indeterminate' : 'delivered';
}

const RECONCILE_DELIVERY_SWEEP_LIMIT = 20;
const RECONCILE_DELIVERY_REASONS = new Set([
  'delivery_confirm_ambiguous',
  'stale_captured_delivery',
]);

function isReconcileDeliveryCandidate(row: ReconcileDeliveryRow): boolean {
  return row.status === 'reconcile' &&
    row.deliveryTxSignature !== null &&
    row.deliveredAt === null &&
    row.failureReason !== null &&
    RECONCILE_DELIVERY_REASONS.has(row.failureReason);
}

export interface ReconcileDeliverySweepInput {
  limit?: number;
  connection?: DeliveryVerificationConnection;
  loadCandidates?: (limit: number) => Promise<ReconcileDeliveryRow[]>;
  resolveSwapWalletPubkey?: () => Promise<string | null>;
  markDelivered?: (row: ReconcileDeliveryRow) => Promise<boolean>;
}

/**
 * Promote-only reconciliation for captured deliveries. It can prove and mark
 * `reconcile -> delivered`; it has no send, reset-to-bought, or signature-clear
 * capability. Every non-proof and every row-local error leaves the row intact.
 */
export async function runReconcileDeliverySweep(
  input: ReconcileDeliverySweepInput = {},
): Promise<void> {
  const limit = Math.max(1, Math.min(input.limit ?? RECONCILE_DELIVERY_SWEEP_LIMIT, RECONCILE_DELIVERY_SWEEP_LIMIT));
  const loadCandidates = input.loadCandidates ?? (async (batchLimit: number) => db
    .select({
      id: earnedRedemptions.id,
      status: earnedRedemptions.status,
      failureReason: earnedRedemptions.failureReason,
      deliveryTxSignature: earnedRedemptions.deliveryTxSignature,
      deliveryClvAtomic: earnedRedemptions.deliveryClvAtomic,
      deliveryWalletPubkey: earnedRedemptions.deliveryWalletPubkey,
      deliveredAt: earnedRedemptions.deliveredAt,
      updatedAt: earnedRedemptions.updatedAt,
    })
    .from(earnedRedemptions)
    .where(and(
      eq(earnedRedemptions.status, 'reconcile'),
      sql`${earnedRedemptions.deliveryTxSignature} IS NOT NULL`,
      isNull(earnedRedemptions.deliveredAt),
      sql`${earnedRedemptions.failureReason} IN ('delivery_confirm_ambiguous', 'stale_captured_delivery')`,
    ))
    .orderBy(asc(earnedRedemptions.updatedAt))
    .limit(batchLimit));

  let loaded: ReconcileDeliveryRow[];
  try {
    loaded = await loadCandidates(limit);
  } catch {
    console.error(JSON.stringify({ event: 'earned_redemption_reconcile_sweep_load_failed' }));
    return;
  }

  const rows = loaded
    .filter(isReconcileDeliveryCandidate)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .slice(0, limit);
  for (const row of rows) {
    try {
      const conn = input.connection ?? getClvMainnetConnection();
      const swapWalletPubkey = await (input.resolveSwapWalletPubkey ?? getClvSwapWalletPubkey)();
      const verdict = await verifyDeliveryOnChain(conn, row, swapWalletPubkey);
      if (verdict !== 'delivered') {
        console.log(JSON.stringify({
          event: 'earned_redemption_reconcile_skip',
          redemptionId: row.id,
          verdict,
        }));
        continue;
      }

      const markDelivered = input.markDelivered ?? (async (candidate: ReconcileDeliveryRow) => {
        if (
          !candidate.deliveryTxSignature ||
          !candidate.deliveryClvAtomic ||
          !candidate.deliveryWalletPubkey
        ) return false;
        const marked = await db.update(earnedRedemptions)
          .set({ status: 'delivered', deliveredAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(earnedRedemptions.id, candidate.id),
            eq(earnedRedemptions.status, 'reconcile'),
            eq(earnedRedemptions.deliveryTxSignature, candidate.deliveryTxSignature),
            eq(earnedRedemptions.deliveryClvAtomic, candidate.deliveryClvAtomic),
            eq(earnedRedemptions.deliveryWalletPubkey, candidate.deliveryWalletPubkey),
            isNull(earnedRedemptions.deliveredAt),
          ))
          .returning({ id: earnedRedemptions.id });
        return marked.length === 1;
      });
      await markDelivered(row);
    } catch {
      console.error(JSON.stringify({
        event: 'earned_redemption_reconcile_row_failed',
        redemptionId: row.id,
        error: 'reconcile_sweep_row_error',
      }));
    }
  }
}

/** Gated worker: bounded oldest-first reconcile proof + progress + stale quarantine. */
export async function runEarnedRedemptionTick(limit = 10): Promise<void> {
  requireTokenomicsRedeemEnabled();
  await runReconcileDeliverySweep();
  const staleCutoff = new Date(Date.now() - 5 * 60_000);
  await db.update(earnedRedemptions)
    .set({ status: 'bought', deliveryClaimId: null, deliveryClaimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(earnedRedemptions.status, 'delivering'),
      lte(earnedRedemptions.deliveryClaimedAt, staleCutoff),
      isNull(earnedRedemptions.deliveryTxSignature),
    ));
  await db.update(earnedRedemptions)
    .set({ status: 'reconcile', failureReason: 'stale_captured_delivery', updatedAt: new Date() })
    .where(and(
      eq(earnedRedemptions.status, 'delivering'),
      lte(earnedRedemptions.deliveryClaimedAt, staleCutoff),
      sql`${earnedRedemptions.deliveryTxSignature} IS NOT NULL`,
    ));
  const rows = await db.select({ id: earnedRedemptions.id }).from(earnedRedemptions)
    .where(sql`${earnedRedemptions.status} IN ('requested','debited','buy_queued','bought')`)
    .orderBy(asc(earnedRedemptions.createdAt)).limit(Math.max(1, Math.min(limit, 50)));
  for (const row of rows) {
    try {
      await advanceEarnedRedemption(row.id);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'earned_redemption_worker_row_failed',
        redemptionId: row.id,
        error: (err as Error).message,
      }));
    }
  }
}

let redemptionWorkerTimer: ReturnType<typeof setInterval> | null = null;
let redemptionWorkerRunning = false;

/** Start the real, gated resume worker. Index calls this only when the literal
 * flag is true; this function independently re-asserts it and is idempotent. */
export function startEarnedRedemptionWorker(): () => void {
  requireTokenomicsRedeemEnabled();
  if (redemptionWorkerTimer) return () => undefined;
  const tick = async () => {
    if (redemptionWorkerRunning) return;
    redemptionWorkerRunning = true;
    try {
      await runEarnedRedemptionTick();
    } catch (err) {
      console.error(`[earned-redemption] worker tick failed: ${(err as Error).message}`);
    } finally {
      redemptionWorkerRunning = false;
    }
  };
  void tick();
  redemptionWorkerTimer = setInterval(() => void tick(), 15_000);
  redemptionWorkerTimer.unref?.();
  return () => {
    if (redemptionWorkerTimer) clearInterval(redemptionWorkerTimer);
    redemptionWorkerTimer = null;
  };
}

/** Physical solvency by the exact singleton custody wallet. */
export async function auditEarnedBackingSolvency(): Promise<{
  walletPubkey: string;
  onchainUsdcAtomic: string;
  outstandingBackingUsdcAtomic: string;
  retainedExitFeesUsdcAtomic: string;
  unsweptBuyPrincipalUsdcAtomic: string;
  requiredUsdcAtomic: string;
  integrityMismatchCount: number;
  integrityReasons: string[];
  indeterminateFundingCount: number;
  indeterminateReasons: string[];
  solvent: boolean;
}> {
  requireTokenomicsRedeemEnabled();
  const custody = await db.select({ id: treasuryWallets.id, publicKey: treasuryWallets.publicKey })
    .from(treasuryWallets).where(eq(treasuryWallets.purpose, 'earned-backing'));
  if (custody.length !== 1) throw new Error('earned_backing_wallet_missing_or_not_singleton');
  const [integrityRow] = await db.execute<EarnedBackingIntegrityCounts>(
    earnedBackingIntegrityQuery(custody[0].id),
  );
  const integrity = summarizeEarnedBackingIntegrity(integrityRow);
  const [backing] = await db.select({ total: sql<string>`COALESCE(SUM(${earnedBackings.remainingUsdcAtomic}), 0)` })
    .from(earnedBackings)
    .innerJoin(earnedMintLots, eq(earnedMintLots.id, earnedBackings.mintLotId))
    .innerJoin(earnEvents, eq(earnEvents.id, earnedMintLots.earnEventId))
    .where(and(
      eq(earnedBackings.custodyWalletId, custody[0].id),
      eq(earnEvents.backingNetwork, 'mainnet'),
    ));
  const [fees] = await db.select({ total: sql<string>`COALESCE(SUM(${earnedRedemptions.exitFeeUsdcAtomic}), 0)` })
    .from(earnedRedemptions).where(and(eq(earnedRedemptions.backingCustodyWalletId, custody[0].id), sql`${earnedRedemptions.exitFeeRetainedAt} IS NOT NULL`));
  const principalRows = await db.select({
    redemptionId: earnedRedemptions.id,
    buyUsdcAtomic: earnedRedemptions.buyUsdcAtomic,
    fundingStatus: clvSwapFunding.status,
    fundingSignature: clvSwapFunding.sweepTxSignature,
    fundingConfirmedSlot: clvSwapFunding.sweepConfirmedSlot,
  }).from(earnedRedemptions)
    .leftJoin(clvSwapFunding, eq(clvSwapFunding.id, earnedRedemptions.clvSwapFundingId))
    .where(and(
      eq(earnedRedemptions.backingCustodyWalletId, custody[0].id),
      sql`${earnedRedemptions.exitFeeRetainedAt} IS NOT NULL`,
    ));
  const outstanding = BigInt(backing?.total ?? '0');
  const retained = BigInt(fees?.total ?? '0');
  const minContextSlot = maxRequiredFundingContextSlot(principalRows);
  const chain = await readSplTokenBalance(
    getClvMainnetConnection(),
    USDC_MINT_MAINNET,
    custody[0].publicKey,
    minContextSlot > 0 ? { minContextSlot } : {},
  );
  const calculated = calculateEarnedBackingSolvency({
    onchainUsdcAtomic: chain.amountAtomic,
    outstandingBackingUsdcAtomic: outstanding,
    retainedExitFeesUsdcAtomic: retained,
    principals: principalRows,
  });
  const contextLag = fundingContextLagReason(chain.contextSlot, minContextSlot);
  const fundingReasons = contextLag
    ? [...calculated.indeterminateReasons, contextLag]
    : calculated.indeterminateReasons;
  const indeterminateReasons = [...integrity.reasons, ...fundingReasons];
  return {
    walletPubkey: custody[0].publicKey,
    onchainUsdcAtomic: chain.amountAtomic.toString(),
    outstandingBackingUsdcAtomic: outstanding.toString(),
    retainedExitFeesUsdcAtomic: retained.toString(),
    unsweptBuyPrincipalUsdcAtomic: calculated.unsweptBuyPrincipalUsdcAtomic.toString(),
    requiredUsdcAtomic: calculated.requiredUsdcAtomic.toString(),
    integrityMismatchCount: integrity.mismatchCount,
    integrityReasons: integrity.reasons,
    indeterminateFundingCount: fundingReasons.length,
    indeterminateReasons,
    solvent: integrity.mismatchCount === 0 && calculated.solvent && contextLag === null,
  };
}
