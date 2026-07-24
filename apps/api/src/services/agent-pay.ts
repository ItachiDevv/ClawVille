/**
 * Durable human/agent avatar-to-avatar USDC payment through PayAI x402.
 * Sender identity is middleware-resolved; the body can never select the payer.
 */
import { randomUUID } from 'crypto';
import { Connection } from '@solana/web3.js';
import {
  db,
  sql,
  eq,
  and,
  or,
  gte,
  inArray,
  isNull,
  agentPayments,
  wallets,
  avatars,
  agentBots,
  users,
  type AgentPayment,
} from '@clawville/database';
import { ensureSapIdentityQueued } from './sap/sap-identity-registrar';
import { decryptWalletRow } from './keypair-vault';
import {
  readAssociatedTokenAccountExists,
  readSplTokenBalance,
} from './solana-token-balance';
import { mintEarned, type LedgerTx } from './claw-token-ledger';
import {
  resolveFacilitatorFeePayer,
  usdCentsToUsdcAtomic,
  usdcMintForNetwork,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  isFacilitatorLevelFailure,
  type X402Network,
} from './x402-payai';
import { isHostedPayAiFacilitatorUrl, loadX402Config } from './x402-config';
import { claimX402Settlement } from './x402-settlement-receipts';
import {
  assertSettlementAmountsConserved,
  legacySettlementAmounts,
  type X402SettlementAmounts,
} from './x402-settlement-accounting';
import { withKeyedMutex } from './keyed-mutex';
import {
  prepareCustodialExactPayment,
  executePreparedExactPayment,
  type PreparedCustodialExactPayment,
  type ExecutePreparedExactPaymentOutcome,
} from './custodial-x402';
import { alertError } from './alert-error';
import {
  acquirePayAiCircuitPermit,
  recordPayAiCircuitAvailable,
  recordPayAiCircuitFailure,
  releasePayAiCircuitPermitWithoutObservation,
  resetPayAiFacilitatorCircuitForTests,
  type PayAiCircuitPermit,
} from './x402-facilitator-circuit';

export {
  resolveAgentPayBreakerCooldownMs,
  resolveAgentPayBreakerThreshold,
} from './x402-facilitator-circuit';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SAFE_AGENT_PAY_CENTS = 100_000_000;
const MIN_STALE_MS = 180_000;
const DEFAULT_MIN_USD_CENTS = 5;
const DEFAULT_DAILY_COUNT_CAP = 50;
const DEFAULT_DAILY_SEND_USD_CENTS = 2_000;
const DEFAULT_DAILY_RECEIVE_USD_CENTS = 2_000;
const MIN_DAILY_CAP_USD_CENTS = 100;
const COUNTED_DAILY_CAP_STATUSES = [
  'pending',
  'settling',
  'settled',
  'reconcile',
] as const satisfies readonly AgentPayment['status'][];

/** Test seam: production state intentionally lives for the process lifetime. */
export function resetAgentPayFacilitatorCircuitForTests(): void {
  resetPayAiFacilitatorCircuitForTests();
}

function formatUsdcAtomic(amount: bigint): string {
  if (amount < 0n) throw new Error('USDC atomic amount must be nonnegative');
  const whole = amount / 1_000_000n;
  const fractional = (amount % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fractional}`;
}

function netUsdcAtomicToVclaw(netUsdcAtomic: bigint): number {
  const coins = netUsdcAtomic / 10_000n;
  if (coins <= 0n || coins > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('net USDC produces an invalid vCLAW credit');
  }
  return Number(coins);
}

function resolveDailyUsdCents(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_DAILY_CAP_USD_CENTS
    ? parsed
    : fallback;
}

export function resolveAgentPayDailySendUsdCents(): number {
  return resolveDailyUsdCents(
    'AGENT_PAY_DAILY_SEND_USD_CENTS',
    DEFAULT_DAILY_SEND_USD_CENTS,
  );
}

export function resolveAgentPayDailyReceiveUsdCents(): number {
  return resolveDailyUsdCents(
    'AGENT_PAY_DAILY_RECEIVE_USD_CENTS',
    DEFAULT_DAILY_RECEIVE_USD_CENTS,
  );
}

function resolvePositiveInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function resolveAgentPayMinUsdCents(): number {
  return resolvePositiveInteger('AGENT_PAY_MIN_USD_CENTS', DEFAULT_MIN_USD_CENTS);
}

export function resolveAgentPayDailyCountCap(): number {
  return resolvePositiveInteger(
    'AGENT_PAY_DAILY_COUNT_CAP',
    DEFAULT_DAILY_COUNT_CAP,
  );
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function resolveAgentPayMaxUsdCents(): number {
  const raw = Number.parseInt(process.env.AGENT_PAY_MAX_USD_CENTS ?? '', 10);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= MAX_SAFE_AGENT_PAY_CENTS
    ? raw
    : 1_000;
}

export function resolveAgentPayStaleMs(): number {
  const raw = Number.parseInt(process.env.AGENT_PAY_STALE_MS ?? '', 10);
  return Number.isSafeInteger(raw) && raw >= MIN_STALE_MS ? raw : 300_000;
}

export type AgentPayRecipient =
  | { kind: 'avatar'; avatarId: string }
  | { kind: 'agent'; agentId: string };

export interface AgentPayInput {
  senderAvatarId: string;
  recipient: AgentPayRecipient;
  usdCents: number;
  idempotencyKey: string;
}

export type AgentPayErrorCode =
  | 'invalid_request'
  | 'amount_below_min'
  | 'amount_above_max'
  | 'recipient_not_found'
  | 'recipient_not_eligible'
  | 'sender_wallet_missing'
  | 'recipient_wallet_missing'
  | 'self_pay_forbidden'
  | 'daily_cap_exceeded'
  | 'idempotency_conflict'
  | 'insufficient_usdc'
  | 'payai_unavailable'
  | 'payment_in_flight'
  | 'payment_failed'
  | 'payment_reconcile'
  | 'fulfillment_pending'
  | 'internal';

export type AgentPayResult =
  | {
      ok: true;
      paymentId: string;
      status: 'settled';
      replay: boolean;
      txSignature: string;
      senderAvatarId: string;
      recipientAvatarId: string;
      usdCents: number;
      earnedVclaw: number;
      earnedLedgerId: string;
    }
  | {
      ok: false;
      code: 'daily_cap_exceeded';
      paymentId?: string;
      status?: AgentPayment['status'];
      detail: { cap: number; usedTodayUsdCents: number } | 'daily_count_cap';
    }
  | {
      ok: false;
      code: Exclude<AgentPayErrorCode, 'daily_cap_exceeded'>;
      paymentId?: string;
      status?: AgentPayment['status'];
      detail?: string;
    };

type ResolvedRecipient = { avatarId: string } | { error: 'not_found' | 'not_eligible' };
type SigningWallet = { publicKey: string; secretKey: Uint8Array };

export type AgentPaySettlementAccounting = X402SettlementAmounts & {
  facilitator: 'payai' | 'meridian';
};

export interface AgentPayDb {
  findByIdempotency(senderAvatarId: string, key: string): Promise<AgentPayment | null>;
  resolveRecipient(recipient: AgentPayRecipient): Promise<ResolvedRecipient>;
  findAvatarWallet(avatarId: string): Promise<{ publicKey: string } | null>;
  admitPending(
    input: typeof agentPayments.$inferInsert,
    limits: {
      sendUsdCents: number;
      receiveUsdCents: number;
      dailyCountCap: number;
    },
    dayStart: Date,
  ): Promise<
    | { kind: 'inserted'; row: AgentPayment }
    | { kind: 'existing'; row: AgentPayment }
    | { kind: 'daily_count_cap_exceeded' }
    | { kind: 'daily_cap_exceeded'; cap: number; usedTodayUsdCents: number }
  >;
  getById(id: string): Promise<AgentPayment | null>;
  claimPending(id: string, settlingId: string): Promise<AgentPayment | null>;
  captureSettled(
    id: string,
    settlingId: string,
    signature: string,
    payer: string | null,
    accounting?: AgentPaySettlementAccounting,
  ): Promise<'captured' | 'lost' | 'signature_conflict'>;
  markFailed(
    id: string,
    settlingId: string,
    reason: string,
    capExempt?: true,
  ): Promise<void>;
  markReconcile(
    id: string,
    settlingId: string | null,
    reason: string,
    observedSignature?: string | null,
    expectedTxSignature?: string | null,
    accounting?: AgentPaySettlementAccounting,
    capExempt?: true,
  ): Promise<boolean | void>;
  fulfillCaptured(
    id: string,
    mint: typeof mintEarned,
  ): Promise<
    | { kind: 'settled' | 'replay'; row: AgentPayment }
    | { kind: 'not_ready' }
    | { kind: 'already_settled' }
  >;
}

export interface AgentPayDeps {
  db?: AgentPayDb;
  readUsdcBalance?: (network: X402Network, owner: string) => Promise<bigint>;
  readRecipientAtaExists?: (
    network: X402Network,
    owner: string,
  ) => Promise<boolean | null>;
  loadSigningWallet?: (avatarId: string) => Promise<SigningWallet | null>;
  prepare?: typeof prepareCustodialExactPayment;
  execute?: (
    prep: PreparedCustodialExactPayment,
  ) => Promise<ExecutePreparedExactPaymentOutcome>;
  mintEarned?: typeof mintEarned;
  resolveFeePayer?: (network: X402Network) => Promise<string | null>;
  resolveRail?: () => {
    network: X402Network;
    rpcUrl: string;
    allowed: boolean;
  };
  alert?: typeof alertError;
  randomId?: () => string;
  now?: () => Date;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const defaultDb: AgentPayDb = {
  async findByIdempotency(senderAvatarId, key) {
    return (await db.query.agentPayments.findFirst({
      where: and(
        eq(agentPayments.senderAvatarId, senderAvatarId),
        eq(agentPayments.idempotencyKey, key),
      ),
    })) ?? null;
  },
  async resolveRecipient(recipient) {
    if (recipient.kind === 'avatar') {
      const [row] = await db
        .select({ avatarId: avatars.id, isGuest: users.isGuest })
        .from(avatars)
        .innerJoin(users, eq(users.id, avatars.userId))
        .where(and(eq(avatars.id, recipient.avatarId), eq(avatars.isActive, true)))
        .limit(1);
      if (!row) return { error: 'not_found' };
      return row.isGuest ? { error: 'not_eligible' } : { avatarId: row.avatarId };
    }
    const [row] = await db
      .select({ avatarId: avatars.id, isGuest: users.isGuest })
      .from(agentBots)
      .innerJoin(users, eq(users.id, agentBots.userId))
      .innerJoin(avatars, and(eq(avatars.userId, users.id), eq(avatars.isActive, true)))
      .where(eq(agentBots.agentId, recipient.agentId))
      .limit(1);
    if (!row) return { error: 'not_found' };
    return row.isGuest ? { error: 'not_eligible' } : { avatarId: row.avatarId };
  },
  async findAvatarWallet(avatarId) {
    const row = await db.query.wallets.findFirst({
      where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      columns: { publicKey: true },
    });
    return row ?? null;
  },
  async admitPending(input, limits, dayStart) {
    return db.transaction(async (tx) => {
      const subjectIds = [input.senderAvatarId, input.recipientAvatarId]
        .filter((value): value is string => typeof value === 'string')
        .sort();
      for (const avatarId of [...new Set(subjectIds)]) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`agent-pay-daily:${avatarId}`}, 0)
          )
        `);
      }

      // Replays always preserve the first request's result, even after either
      // subject has reached its cap. This read must happen under the same locks
      // as the usage check and insert; the unlocked read in payAgent is only a
      // fast path.
      const existing = await tx.query.agentPayments.findFirst({
        where: and(
          eq(agentPayments.senderAvatarId, input.senderAvatarId),
          eq(agentPayments.idempotencyKey, input.idempotencyKey),
        ),
      });
      if (existing) return { kind: 'existing' as const, row: existing };

      const [usage] = await tx
        .select({
          sent: sql<string>`COALESCE(SUM(CASE
            WHEN ${agentPayments.senderAvatarId} = ${input.senderAvatarId}
            THEN ${agentPayments.usdCents} ELSE 0 END), 0)`,
          received: sql<string>`COALESCE(SUM(CASE
            WHEN ${agentPayments.recipientAvatarId} = ${input.recipientAvatarId}
            THEN ${agentPayments.usdCents} ELSE 0 END), 0)`,
          sentCount: sql<string>`COALESCE(SUM(CASE
            WHEN ${agentPayments.senderAvatarId} = ${input.senderAvatarId}
            THEN 1 ELSE 0 END), 0)`,
        })
        .from(agentPayments)
        .where(and(
          gte(agentPayments.createdAt, dayStart),
          inArray(agentPayments.status, [...COUNTED_DAILY_CAP_STATUSES]),
          sql`${agentPayments.capExempt} IS NOT TRUE`,
          or(
            eq(agentPayments.senderAvatarId, input.senderAvatarId),
            eq(agentPayments.recipientAvatarId, input.recipientAvatarId),
          ),
        ));
      const sent = Number(usage?.sent ?? 0);
      const received = Number(usage?.received ?? 0);
      const sentCount = Number(usage?.sentCount ?? 0);
      if (!Number.isSafeInteger(sent) || sent < 0
        || !Number.isSafeInteger(received) || received < 0
        || !Number.isSafeInteger(sentCount) || sentCount < 0) {
        throw new Error('agent payment daily usage is outside safe integer range');
      }
      const usdCents = input.usdCents;
      if (typeof usdCents !== 'number') {
        throw new Error('agent payment admission requires integer usd cents');
      }
      if (sentCount >= limits.dailyCountCap) {
        return { kind: 'daily_count_cap_exceeded' as const };
      }
      if (sent > limits.sendUsdCents - usdCents) {
        return {
          kind: 'daily_cap_exceeded' as const,
          cap: limits.sendUsdCents,
          usedTodayUsdCents: sent,
        };
      }
      if (received > limits.receiveUsdCents - usdCents) {
        return {
          kind: 'daily_cap_exceeded' as const,
          cap: limits.receiveUsdCents,
          usedTodayUsdCents: received,
        };
      }

      const [row] = await tx
        .insert(agentPayments)
        .values(input)
        .onConflictDoNothing({
          target: [agentPayments.senderAvatarId, agentPayments.idempotencyKey],
        })
        .returning();
      if (row) return { kind: 'inserted' as const, row };

      // Defensive compatibility with a rolling deploy whose older process did
      // not take the admission advisory lock but won the unique-key race.
      const replay = await tx.query.agentPayments.findFirst({
        where: and(
          eq(agentPayments.senderAvatarId, input.senderAvatarId),
          eq(agentPayments.idempotencyKey, input.idempotencyKey),
        ),
      });
      if (replay) return { kind: 'existing' as const, row: replay };
      throw new Error('agent payment admission insert returned no row');
    });
  },
  async getById(id) {
    return (await db.query.agentPayments.findFirst({ where: eq(agentPayments.id, id) })) ?? null;
  },
  async claimPending(id, settlingId) {
    const [row] = await db
      .update(agentPayments)
      .set({ status: 'settling', settlingId, settlingStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentPayments.id, id), eq(agentPayments.status, 'pending')))
      .returning();
    return row ?? null;
  },
  async captureSettled(id, settlingId, signature, payer, accounting) {
    const existingAmounts = accounting ?? null;
    try {
      const rows = await db
        .update(agentPayments)
        .set({
          txSignature: signature,
          settlePayer: payer,
          ...(existingAmounts
            ? {
                facilitator: existingAmounts.facilitator,
                grossUsdcAtomic: existingAmounts.grossUsdcAtomic.toString(),
                platformFeeUsdcAtomic:
                  existingAmounts.platformFeeUsdcAtomic.toString(),
                treasuryFeeUsdcAtomic:
                  existingAmounts.treasuryFeeUsdcAtomic.toString(),
                netUsdcAtomic: existingAmounts.netUsdcAtomic.toString(),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(agentPayments.id, id),
          eq(agentPayments.status, 'settling'),
          eq(agentPayments.settlingId, settlingId),
        ))
        .returning({ id: agentPayments.id });
      return rows.length === 1 ? 'captured' : 'lost';
    } catch (err) {
      if (isUniqueViolation(err)) return 'signature_conflict';
      throw err;
    }
  },
  async markFailed(id, settlingId, reason, capExempt) {
    await db.update(agentPayments).set({
      status: 'failed', failureReason: reason, settlingId: null,
      settlingStartedAt: null, updatedAt: new Date(),
      ...(capExempt ? { capExempt: true } : {}),
    }).where(and(
      eq(agentPayments.id, id), eq(agentPayments.status, 'settling'),
      eq(agentPayments.settlingId, settlingId),
    ));
  },
  async markReconcile(
    id,
    settlingId,
    reason,
    observedSignature = null,
    expectedTxSignature,
    accounting,
    capExempt,
  ) {
    const conditions = [eq(agentPayments.id, id), eq(agentPayments.status, 'settling')];
    if (settlingId) conditions.push(eq(agentPayments.settlingId, settlingId));
    if (expectedTxSignature !== undefined) {
      conditions.push(expectedTxSignature === null
        ? isNull(agentPayments.txSignature)
        : eq(agentPayments.txSignature, expectedTxSignature));
    }
    const x402SettlementAccounting = accounting
      ? {
          facilitator: accounting.facilitator,
          grossUsdcAtomic: accounting.grossUsdcAtomic.toString(),
          platformFeeUsdcAtomic: accounting.platformFeeUsdcAtomic.toString(),
          treasuryFeeUsdcAtomic: accounting.treasuryFeeUsdcAtomic.toString(),
          netUsdcAtomic: accounting.netUsdcAtomic.toString(),
        }
      : null;
    const rows = await db.update(agentPayments).set({
      status: 'reconcile', failureReason: reason,
      reconcileTxSignature: observedSignature, settlingId: null,
      settlingStartedAt: null, updatedAt: new Date(),
      ...(capExempt ? { capExempt: true } : {}),
      ...(x402SettlementAccounting
        ? {
            metadata: sql`COALESCE(${agentPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
              x402SettlementAccounting,
            })}::jsonb`,
          }
        : {}),
    }).where(and(...conditions)).returning({ id: agentPayments.id });
    return rows.length === 1;
  },
  async fulfillCaptured(id, mint) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      const [row] = await tx.select().from(agentPayments).where(eq(agentPayments.id, id)).limit(1);
      if (!row) return { kind: 'not_ready' as const };
      if (row.status === 'settled') return { kind: 'replay' as const, row };
      if (row.status !== 'settling' || !row.txSignature) return { kind: 'not_ready' as const };

      const settlementAmounts: X402SettlementAmounts =
        row.grossUsdcAtomic !== null &&
        row.platformFeeUsdcAtomic !== null &&
        row.treasuryFeeUsdcAtomic !== null &&
        row.netUsdcAtomic !== null
          ? {
              grossUsdcAtomic: BigInt(row.grossUsdcAtomic),
              platformFeeUsdcAtomic: BigInt(row.platformFeeUsdcAtomic),
              treasuryFeeUsdcAtomic: BigInt(row.treasuryFeeUsdcAtomic),
              netUsdcAtomic: BigInt(row.netUsdcAtomic),
            }
          : legacySettlementAmounts(BigInt(row.usdcAtomic));
      assertSettlementAmountsConserved(settlementAmounts);
      const receipt = await claimX402Settlement({
        txSignature: row.txSignature,
        rail: 'agent_payment',
        kind: 'agent_payment',
        referenceId: row.id,
        subjectId: row.recipientAvatarId,
        amountUsdcAtomic: settlementAmounts.grossUsdcAtomic,
        ...settlementAmounts,
      }, tx as LedgerTx);
      if (receipt.kind === 'foreign_owner') return { kind: 'already_settled' as const };

      // PayAI transfers the full quoted amount directly to the recipient, NOT
      // to house custody. The EARNED is spendable but explicitly UNBACKED and
      // can never cross E3. A future cashable ④ must route the dollar through
      // purpose='earned-backing' and deliver only the EARNED receipt.
      const usdBasis = formatUsdcAtomic(settlementAmounts.netUsdcAtomic);
      const earnedVclaw = netUsdcAtomicToVclaw(
        settlementAmounts.netUsdcAtomic,
      );
      const minted = await mint({
        avatarId: row.recipientAvatarId,
        amount: earnedVclaw,
        reason: 'agent_payai_settlement',
        source: 'x402',
        usdBasis,
        backing: {
          kind: 'none',
          mintRef: `agent-pay:${row.id}`,
          reason: 'recipient_received_usdc_directly',
        },
        metadata: {
          agentPaymentId: row.id,
          txSignature: row.txSignature,
          senderAvatarId: row.senderAvatarId,
        },
      }, tx as LedgerTx);

      const [settled] = await tx.update(agentPayments).set({
        status: 'settled', earnedVclaw, earnedUsdBasis: usdBasis,
        earnedLedgerId: minted.ledgerId, fulfilledAt: new Date(),
        settlingId: null, settlingStartedAt: null, updatedAt: new Date(),
      }).where(and(
        eq(agentPayments.id, id),
        eq(agentPayments.status, 'settling'),
        eq(agentPayments.txSignature, row.txSignature),
      )).returning();
      if (!settled) throw new Error('agent payment fulfillment CAS lost');
      return { kind: 'settled' as const, row: settled };
    });
  },
};

export interface AgentPayRail {
  network: X402Network;
  rpcUrl: string;
  allowed: boolean;
}

/** Resolve the exact network/RPC used by the agent-pay rail. */
export function resolveAgentPayRail(): AgentPayRail {
  const cfg = loadX402Config();
  const network: X402Network | null =
    cfg.network === SOLANA_MAINNET_CAIP2 ? 'mainnet'
      : cfg.network === SOLANA_DEVNET_CAIP2 ? 'devnet' : null;
  if (!network) return { network: 'mainnet', rpcUrl: '', allowed: false };
  const rpcUrl = process.env.AGENT_PAY_RPC_URL?.trim()
    || (network === 'mainnet'
      ? process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com'
      : process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  return { network, rpcUrl, allowed: isHostedPayAiFacilitatorUrl(cfg.facilitatorUrl) };
}

function deps(input?: AgentPayDeps) {
  return {
    db: input?.db ?? defaultDb,
    readUsdcBalance: input?.readUsdcBalance ?? (async (network: X402Network, owner: string) => {
      const rail = (input?.resolveRail ?? resolveAgentPayRail)();
      const balance = await readSplTokenBalance(
        new Connection(rail.rpcUrl, 'confirmed'), usdcMintForNetwork(network), owner,
      );
      return balance.amountAtomic;
    }),
    readRecipientAtaExists: input?.readRecipientAtaExists
      ?? (async (network: X402Network, owner: string) => {
        try {
          const rail = (input?.resolveRail ?? resolveAgentPayRail)();
          return await readAssociatedTokenAccountExists(
            new Connection(rail.rpcUrl, 'confirmed'),
            usdcMintForNetwork(network),
            owner,
          );
        } catch {
          return null;
        }
      }),
    loadSigningWallet: input?.loadSigningWallet ?? (async (avatarId: string) => {
      const row = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      });
      if (!row) return null;
      const keypair = await decryptWalletRow(row);
      const publicKey = keypair.publicKey.toBase58();
      if (publicKey !== row.publicKey) throw new Error('custodial wallet pubkey mismatch');
      return { publicKey, secretKey: keypair.secretKey };
    }),
    prepare: input?.prepare ?? prepareCustodialExactPayment,
    execute: input?.execute ?? ((prep: PreparedCustodialExactPayment) => executePreparedExactPayment(prep)),
    mintEarned: input?.mintEarned ?? mintEarned,
    resolveFeePayer: input?.resolveFeePayer ?? resolveFacilitatorFeePayer,
    resolveRail: input?.resolveRail ?? resolveAgentPayRail,
    alert: input?.alert ?? alertError,
    randomId: input?.randomId ?? randomUUID,
    now: input?.now ?? (() => new Date()),
  };
}

async function withAdmissionMutexes<T>(
  senderAvatarId: string,
  recipientAvatarId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set([senderAvatarId, recipientAvatarId])]
    .sort()
    .map((avatarId) => `agent-pay-daily:${avatarId}`);

  const acquire = (index: number): Promise<T> => {
    const key = keys[index];
    return key
      ? withKeyedMutex(key, () => acquire(index + 1))
      : operation();
  };
  return acquire(0);
}

function recipientIdentity(recipient: AgentPayRecipient): { kind: 'avatar' | 'agent'; ref: string } {
  return recipient.kind === 'avatar'
    ? { kind: 'avatar', ref: recipient.avatarId }
    : { kind: 'agent', ref: recipient.agentId };
}

function requestMatches(row: AgentPayment, input: AgentPayInput): boolean {
  const target = recipientIdentity(input.recipient);
  return row.recipientKind === target.kind
    && row.recipientRef === target.ref
    && row.usdCents === input.usdCents;
}

function success(row: AgentPayment, replay: boolean): AgentPayResult {
  if (!row.txSignature || !row.earnedLedgerId) {
    return { ok: false, code: 'internal', paymentId: row.id, status: row.status };
  }
  return {
    ok: true, paymentId: row.id, status: 'settled', replay,
    txSignature: row.txSignature, senderAvatarId: row.senderAvatarId,
    recipientAvatarId: row.recipientAvatarId, usdCents: row.usdCents,
    earnedVclaw: row.earnedVclaw, earnedLedgerId: row.earnedLedgerId,
  };
}

async function fulfill(paymentId: string, d: ReturnType<typeof deps>): Promise<AgentPayResult> {
  try {
    const result = await d.db.fulfillCaptured(paymentId, d.mintEarned);
    if (result.kind === 'already_settled') {
      await d.db.markReconcile(paymentId, null, 'global_signature_conflict');
      return {
        ok: false,
        code: 'payment_reconcile',
        paymentId,
        status: 'reconcile',
        detail: 'already_settled',
      };
    }
    if (result.kind === 'not_ready') {
      return { ok: false, code: 'fulfillment_pending', paymentId, status: 'settling' };
    }
    return success(result.row, result.kind === 'replay');
  } catch {
    return {
      ok: false, code: 'fulfillment_pending', paymentId, status: 'settling',
      detail: 'captured_settlement_awaiting_fulfillment',
    };
  }
}

/**
 * Resume the service's own captured-payment fulfillment path. Reconciliation
 * calls this only after a verified signature has been durably captured on a
 * `settling` row; the advisory lock, ledger mint, and settle CAS remain owned
 * by `AgentPayDb.fulfillCaptured`.
 */
export async function fulfillReconciledAgentPayment(
  paymentId: string,
  injected?: Pick<AgentPayDeps, 'db' | 'mintEarned'>,
): Promise<AgentPayResult> {
  return fulfill(paymentId, deps(injected));
}

/**
 * Forward-only quarantine seam for recovery workers. The underlying DB method
 * re-asserts `status='settling'` and, when present, the original settling id.
 */
export async function markAgentPaymentReconcile(
  paymentId: string,
  settlingId: string | null,
  reason: string,
  observedSignature?: string | null,
  expectedTxSignature?: string | null,
): Promise<boolean> {
  return (await defaultDb.markReconcile(
    paymentId,
    settlingId,
    reason,
    observedSignature,
    expectedTxSignature,
  )) !== false;
}

async function dispatchExisting(
  row: AgentPayment,
  input: AgentPayInput,
  d: ReturnType<typeof deps>,
  permit?: PayAiCircuitPermit,
): Promise<AgentPayResult> {
  if (!requestMatches(row, input)) {
    return { ok: false, code: 'idempotency_conflict', paymentId: row.id, status: row.status };
  }
  if (row.status === 'settled') return success(row, true);
  if (row.status === 'failed') {
    return { ok: false, code: 'payment_failed', paymentId: row.id, status: row.status, detail: row.failureReason ?? undefined };
  }
  if (row.status === 'reconcile') {
    return { ok: false, code: 'payment_reconcile', paymentId: row.id, status: row.status, detail: row.failureReason ?? undefined };
  }
  if (row.status === 'settling') {
    if (row.txSignature) return fulfill(row.id, d);
    const started = row.settlingStartedAt ? new Date(row.settlingStartedAt).getTime() : 0;
    if (Date.now() - started >= resolveAgentPayStaleMs()) {
      await d.db.markReconcile(row.id, row.settlingId, 'stale_settling');
      return {
        ok: false, code: 'payment_reconcile', paymentId: row.id,
        status: 'reconcile', detail: 'stale_settling',
      };
    }
    return { ok: false, code: 'payment_in_flight', paymentId: row.id, status: row.status };
  }
  return executePending(row, d, permit);
}

function circuitOpenResult(row?: AgentPayment): AgentPayResult {
  return {
    ok: false,
    code: 'payai_unavailable',
    ...(row ? { paymentId: row.id, status: row.status } : {}),
    detail: 'facilitator_circuit_open',
  };
}

async function executePending(
  row: AgentPayment,
  d: ReturnType<typeof deps>,
  acquiredPermit?: PayAiCircuitPermit,
): Promise<AgentPayResult> {
  const permit = acquiredPermit ?? acquirePayAiCircuitPermit(d.now().getTime());
  if (!permit) return circuitOpenResult(row);
  try {
    return await executePendingWithPermit(row, d, permit);
  } finally {
    releasePayAiCircuitPermitWithoutObservation(permit, d.now().getTime());
  }
}

async function executePendingWithPermit(
  row: AgentPayment,
  d: ReturnType<typeof deps>,
  permit: PayAiCircuitPermit,
): Promise<AgentPayResult> {
  const rail = d.resolveRail();
  if (!rail.allowed || !rail.rpcUrl || row.network !== rail.network) {
    return { ok: false, code: 'payai_unavailable', paymentId: row.id, status: row.status };
  }
  const required = BigInt(row.usdcAtomic);
  try {
    if (await d.readUsdcBalance(rail.network, row.senderWallet) < required) {
      return { ok: false, code: 'insufficient_usdc', paymentId: row.id, status: 'pending' };
    }
  } catch {
    return { ok: false, code: 'payai_unavailable', paymentId: row.id, status: 'pending', detail: 'balance_unavailable' };
  }

  let recipientAtaExists: boolean | null;
  try {
    recipientAtaExists = await d.readRecipientAtaExists(
      rail.network,
      row.recipientWallet,
    );
  } catch {
    recipientAtaExists = null;
  }
  if (recipientAtaExists === false) {
    const settlingId = d.randomId();
    const claimed = await d.db.claimPending(row.id, settlingId);
    if (!claimed) {
      const current = await d.db.getById(row.id);
      return current
        ? dispatchExisting(current, {
            senderAvatarId: row.senderAvatarId,
            recipient: row.recipientKind === 'avatar'
              ? { kind: 'avatar', avatarId: row.recipientRef }
              : { kind: 'agent', agentId: row.recipientRef },
            usdCents: row.usdCents, idempotencyKey: row.idempotencyKey,
          }, d, permit)
        : { ok: false, code: 'internal', paymentId: row.id };
    }
    await d.db.markFailed(
      row.id,
      settlingId,
      'recipient_ata_missing',
      true,
    );
    return {
      ok: false,
      code: 'payment_failed',
      paymentId: row.id,
      status: 'failed',
      detail: 'recipient_ata_missing',
    };
  }

  let prep: PreparedCustodialExactPayment;
  try {
    const [wallet, feePayer] = await Promise.all([
      d.loadSigningWallet(row.senderAvatarId), d.resolveFeePayer(rail.network),
    ]);
    if (!wallet || wallet.publicKey !== row.senderWallet) {
      return { ok: false, code: 'sender_wallet_missing', paymentId: row.id, status: 'pending' };
    }
    if (!feePayer) {
      // `/supported` is facilitator-wide and independent of this payment. Its
      // resolver deliberately returns null for network/5xx/malformed responses.
      recordPayAiCircuitFailure(permit, d.now().getTime(), d.alert);
      return { ok: false, code: 'payai_unavailable', paymentId: row.id, status: 'pending', detail: 'fee_payer_unavailable' };
    }
    prep = await d.prepare({
      payerSecretKey: wallet.secretKey, payerPubkey: wallet.publicKey,
      payTo: row.recipientWallet, amountBaseUnits: required,
      network: rail.network, rpcUrl: rail.rpcUrl, feePayer,
      resource: {
        url: `clawville://agent-pay/${row.id}`,
        description: `ClawVille agent payment ${row.id}`,
      },
      purpose: 'clawville-agent-pay',
      extra: {
        paymentId: row.id, senderAvatarId: row.senderAvatarId,
        recipientAvatarId: row.recipientAvatarId,
      },
    });
  } catch {
    return { ok: false, code: 'payai_unavailable', paymentId: row.id, status: 'pending', detail: 'prepare_failed' };
  }

  const settlingId = d.randomId();
  const claimed = await d.db.claimPending(row.id, settlingId);
  if (!claimed) {
    const current = await d.db.getById(row.id);
    return current
      ? dispatchExisting(current, {
          senderAvatarId: row.senderAvatarId,
          recipient: row.recipientKind === 'avatar'
            ? { kind: 'avatar', avatarId: row.recipientRef }
            : { kind: 'agent', agentId: row.recipientRef },
          usdCents: row.usdCents, idempotencyKey: row.idempotencyKey,
        }, d, permit)
      : { ok: false, code: 'internal', paymentId: row.id };
  }

  let outcome: ExecutePreparedExactPaymentOutcome;
  try {
    outcome = await d.execute(prep);
  } catch (err) {
    if (isFacilitatorLevelFailure(err)) {
      recordPayAiCircuitFailure(permit, d.now().getTime(), d.alert);
    }
    // The claim is already held and the facilitator may have accepted the
    // transaction. Never retry an exception after send; require reconciliation.
    try {
      await d.db.markReconcile(row.id, settlingId, 'facilitator_execute_threw');
    } catch {
      // A DB outage leaves the durable row in settling. Replay cannot re-claim it
      // and the stale-settling guard will move it to reconciliation later.
    }
    return {
      ok: false, code: 'payment_reconcile', paymentId: row.id,
      status: 'reconcile', detail: 'facilitator_execute_threw',
    };
  }
  // Observe only the PayAI leg. A direct Meridian settlement has no bearing on
  // provider health and must leave the shared circuit unchanged.
  if (outcome.payAi.attempted) {
    if (outcome.payAi.providerFailure) {
      recordPayAiCircuitFailure(permit, d.now().getTime(), d.alert);
    } else {
      // A successful settlement or payment-specific rejection proves the
      // facilitator is responsive and breaks the consecutive-failure streak.
      recordPayAiCircuitAvailable(permit);
    }
  }
    if (outcome.kind === 'meridian_failure') {
      if (outcome.ambiguous) {
        await d.db.markReconcile(
          row.id,
          settlingId,
          `meridian:${outcome.reason}`,
          outcome.signature,
        );
        return {
          ok: false,
          code: 'payment_reconcile',
          paymentId: row.id,
          status: 'reconcile',
          detail: outcome.reason,
        };
      }
      await d.db.markFailed(
        row.id,
        settlingId,
        `meridian_${outcome.stage}:${outcome.reason}`,
      );
      return {
        ok: false,
        code: 'payment_failed',
        paymentId: row.id,
        status: 'failed',
        detail: outcome.reason,
      };
    }
  if (outcome.kind === 'definitive_failure') {
    await d.db.markFailed(
      row.id,
      settlingId,
      `${outcome.stage}:${outcome.reason}`,
      outcome.noBroadcast,
    );
    return { ok: false, code: 'payment_failed', paymentId: row.id, status: 'failed', detail: outcome.reason };
  }
    if (outcome.kind !== 'settled' && outcome.kind !== 'meridian_settled') {
    const reason = outcome.kind === 'ambiguous' ? outcome.reason : 'unexpected_verify_only';
    await d.db.markReconcile(
      row.id,
      settlingId,
      reason,
      outcome.kind === 'ambiguous' ? outcome.signature : null,
      undefined,
      undefined,
      outcome.kind === 'verify_only' ? true : undefined,
    );
    return { ok: false, code: 'payment_reconcile', paymentId: row.id, status: 'reconcile', detail: reason };
  }

    const capturedAccounting =
      outcome.kind === 'meridian_settled'
        ? { facilitator: 'meridian' as const, ...outcome.amounts }
        : {
            facilitator: 'payai' as const,
            ...legacySettlementAmounts(required),
          };
    let captured: 'captured' | 'lost' | 'signature_conflict';
  try {
      captured = await d.db.captureSettled(
        row.id,
        settlingId,
        outcome.signature,
        outcome.payer,
        capturedAccounting,
      );
  } catch {
    // Settlement succeeded but its signature could not be durably captured.
    // Preserve the observed signature for an operator and never send again.
    try {
      await d.db.markReconcile(
        row.id,
        settlingId,
        'settlement_capture_failed',
        outcome.signature,
        undefined,
        capturedAccounting,
      );
    } catch {
      // See the stale-settling note above; retry remains prevented by the claim.
    }
    return {
      ok: false, code: 'payment_reconcile', paymentId: row.id,
      status: 'reconcile', detail: 'settlement_capture_failed',
    };
  }
  if (captured !== 'captured') {
    if (captured === 'lost') {
      const current = await d.db.getById(row.id);
      if (current?.status === 'settled') return success(current, true);
      if (current?.status === 'settling' && current.txSignature) {
        return fulfill(current.id, d);
      }
      if (current?.status === 'failed') {
        return {
          ok: false, code: 'payment_failed', paymentId: current.id,
          status: 'failed', detail: current.failureReason ?? undefined,
        };
      }
      if (current?.status === 'reconcile') {
        return {
          ok: false, code: 'payment_reconcile', paymentId: current.id,
          status: 'reconcile', detail: current.failureReason ?? undefined,
        };
      }
    }
    await d.db.markReconcile(
      row.id, settlingId,
      captured, outcome.signature, undefined, capturedAccounting,
    );
    return { ok: false, code: 'payment_reconcile', paymentId: row.id, status: 'reconcile', detail: captured };
  }
  return fulfill(row.id, d);
}

async function payAgentLocked(
  input: AgentPayInput,
  injected?: AgentPayDeps,
): Promise<AgentPayResult> {
  const d = deps(injected);
  if (!input.senderAvatarId || !IDEMPOTENCY_RE.test(input.idempotencyKey ?? '')) {
    return { ok: false, code: 'invalid_request' };
  }
  if (!Number.isInteger(input.usdCents) || input.usdCents < 1) {
    return { ok: false, code: 'amount_below_min' };
  }
  if (input.usdCents > resolveAgentPayMaxUsdCents()) {
    return { ok: false, code: 'amount_above_max' };
  }
  const target = recipientIdentity(input.recipient);
  if (!target.ref) return { ok: false, code: 'invalid_request' };

  const existing = await d.db.findByIdempotency(input.senderAvatarId, input.idempotencyKey);
  if (existing && existing.status !== 'pending') {
    return dispatchExisting(existing, input, d);
  }
  if (!existing && input.usdCents < resolveAgentPayMinUsdCents()) {
    return { ok: false, code: 'amount_below_min' };
  }

  const permit = acquirePayAiCircuitPermit(d.now().getTime());
  if (!permit) return circuitOpenResult(existing ?? undefined);
  try {
    if (existing) return await dispatchExisting(existing, input, d, permit);

    const recipient = await d.db.resolveRecipient(input.recipient);
    if ('error' in recipient) {
      return { ok: false, code: recipient.error === 'not_found' ? 'recipient_not_found' : 'recipient_not_eligible' };
    }
    if (recipient.avatarId === input.senderAvatarId) {
      return { ok: false, code: 'self_pay_forbidden' };
    }
    const [senderWallet, recipientWallet] = await Promise.all([
      d.db.findAvatarWallet(input.senderAvatarId), d.db.findAvatarWallet(recipient.avatarId),
    ]);
    if (!senderWallet) return { ok: false, code: 'sender_wallet_missing' };
    if (!recipientWallet) return { ok: false, code: 'recipient_wallet_missing' };
    if (senderWallet.publicKey === recipientWallet.publicKey) {
      return { ok: false, code: 'self_pay_forbidden' };
    }
    const rail = d.resolveRail();
    if (!rail.allowed || !rail.rpcUrl) return { ok: false, code: 'payai_unavailable' };

    const atomic = usdCentsToUsdcAtomic(input.usdCents);
    const admission = await withAdmissionMutexes(
      input.senderAvatarId,
      recipient.avatarId,
      () => d.db.admitPending({
        senderAvatarId: input.senderAvatarId,
        recipientAvatarId: recipient.avatarId,
        recipientKind: target.kind,
        recipientRef: target.ref,
        senderWallet: senderWallet.publicKey,
        recipientWallet: recipientWallet.publicKey,
        usdCents: input.usdCents,
        usdcAtomic: atomic,
        network: rail.network,
        idempotencyKey: input.idempotencyKey,
        metadata: { trustedInternalPayaiEligibility: true },
      }, {
        sendUsdCents: resolveAgentPayDailySendUsdCents(),
        receiveUsdCents: resolveAgentPayDailyReceiveUsdCents(),
        dailyCountCap: resolveAgentPayDailyCountCap(),
      }, utcMidnight(d.now())),
    );
    if (admission.kind === 'daily_count_cap_exceeded') {
      return {
        ok: false,
        code: 'daily_cap_exceeded',
        detail: 'daily_count_cap',
      };
    }
    if (admission.kind === 'daily_cap_exceeded') {
      return {
        ok: false,
        code: 'daily_cap_exceeded',
        detail: {
          cap: admission.cap,
          usedTodayUsdCents: admission.usedTodayUsdCents,
        },
      };
    }
    if (admission.kind === 'existing') {
      return await dispatchExisting(admission.row, input, d, permit);
    }
    ensureSapIdentityQueued(input.senderAvatarId, 'agent-pay.sender');
    ensureSapIdentityQueued(recipient.avatarId, 'agent-pay.recipient');
    return await executePending(admission.row, d, permit);
  } finally {
    releasePayAiCircuitPermitWithoutObservation(permit, d.now().getTime());
  }
}

export async function payAgent(
  input: AgentPayInput,
  injected?: AgentPayDeps,
): Promise<AgentPayResult> {
  if (!input.senderAvatarId || !IDEMPOTENCY_RE.test(input.idempotencyKey ?? '')) {
    return payAgentLocked(input, injected);
  }
  // This lock is deliberately separate from the short-lived daily-cap locks:
  // only identical same-process retries wait for the first facilitator flow,
  // while unrelated payments release their subject admission locks immediately
  // after the pending row commits.
  return withKeyedMutex(
    `agent-pay-idempotency:${input.senderAvatarId}:${input.idempotencyKey}`,
    () => payAgentLocked(input, injected),
  );
}
