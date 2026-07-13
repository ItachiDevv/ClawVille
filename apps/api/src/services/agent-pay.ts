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
  agentPayments,
  wallets,
  avatars,
  agentBots,
  users,
  type AgentPayment,
} from '@clawville/database';
import { decryptWalletRow } from './keypair-vault';
import { readSplTokenBalance } from './solana-token-balance';
import { mintEarned, type LedgerTx } from './claw-token-ledger';
import {
  resolveFacilitatorFeePayer,
  usdCentsToUsdcAtomic,
  usdToCt,
  usdcMintForNetwork,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  type X402Network,
} from './x402-payai';
import { isHostedPayAiFacilitatorUrl, loadX402Config } from './x402-config';
import {
  prepareCustodialExactPayment,
  executePreparedExactPayment,
  type PreparedCustodialExactPayment,
  type ExecutePreparedExactPaymentOutcome,
} from './custodial-x402';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SAFE_AGENT_PAY_CENTS = 100_000_000;
const MIN_STALE_MS = 180_000;

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
      code: AgentPayErrorCode;
      paymentId?: string;
      status?: AgentPayment['status'];
      detail?: string;
    };

type ResolvedRecipient = { avatarId: string } | { error: 'not_found' | 'not_eligible' };
type SigningWallet = { publicKey: string; secretKey: Uint8Array };

export interface AgentPayDb {
  findByIdempotency(senderAvatarId: string, key: string): Promise<AgentPayment | null>;
  resolveRecipient(recipient: AgentPayRecipient): Promise<ResolvedRecipient>;
  findAvatarWallet(avatarId: string): Promise<{ publicKey: string } | null>;
  insertPending(input: typeof agentPayments.$inferInsert): Promise<AgentPayment | null>;
  getById(id: string): Promise<AgentPayment | null>;
  claimPending(id: string, settlingId: string): Promise<AgentPayment | null>;
  captureSettled(
    id: string,
    settlingId: string,
    signature: string,
    payer: string | null,
  ): Promise<'captured' | 'lost' | 'signature_conflict'>;
  markFailed(id: string, settlingId: string, reason: string): Promise<void>;
  markReconcile(
    id: string,
    settlingId: string | null,
    reason: string,
    observedSignature?: string | null,
  ): Promise<void>;
  fulfillCaptured(
    id: string,
    mint: typeof mintEarned,
  ): Promise<{ kind: 'settled' | 'replay'; row: AgentPayment } | { kind: 'not_ready' }>;
}

export interface AgentPayDeps {
  db?: AgentPayDb;
  readUsdcBalance?: (network: X402Network, owner: string) => Promise<bigint>;
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
  randomId?: () => string;
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
  async insertPending(input) {
    try {
      const [row] = await db.insert(agentPayments).values(input).returning();
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
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
  async captureSettled(id, settlingId, signature, payer) {
    try {
      const rows = await db
        .update(agentPayments)
        .set({ txSignature: signature, settlePayer: payer, updatedAt: new Date() })
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
  async markFailed(id, settlingId, reason) {
    await db.update(agentPayments).set({
      status: 'failed', failureReason: reason, settlingId: null,
      settlingStartedAt: null, updatedAt: new Date(),
    }).where(and(
      eq(agentPayments.id, id), eq(agentPayments.status, 'settling'),
      eq(agentPayments.settlingId, settlingId),
    ));
  },
  async markReconcile(id, settlingId, reason, observedSignature = null) {
    const conditions = [eq(agentPayments.id, id), eq(agentPayments.status, 'settling')];
    if (settlingId) conditions.push(eq(agentPayments.settlingId, settlingId));
    await db.update(agentPayments).set({
      status: 'reconcile', failureReason: reason,
      reconcileTxSignature: observedSignature, settlingId: null,
      settlingStartedAt: null, updatedAt: new Date(),
    }).where(and(...conditions));
  },
  async fulfillCaptured(id, mint) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      const [row] = await tx.select().from(agentPayments).where(eq(agentPayments.id, id)).limit(1);
      if (!row) return { kind: 'not_ready' as const };
      if (row.status === 'settled') return { kind: 'replay' as const, row };
      if (row.status !== 'settling' || !row.txSignature) return { kind: 'not_ready' as const };

      // PayAI transfers the full quoted amount directly to the recipient.
      // EARNED therefore records and mints against that same full USDC basis;
      // no uncollected fee/rake may reduce or misdescribe the settlement.
      const usdBasis = (row.usdCents / 100).toFixed(6);
      const earnedVclaw = usdToCt(row.usdCents);
      const minted = await mint({
        avatarId: row.recipientAvatarId,
        amount: earnedVclaw,
        reason: 'agent_payai_settlement',
        source: 'x402',
        usdBasis,
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

function defaultResolveRail(): { network: X402Network; rpcUrl: string; allowed: boolean } {
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
      const rail = (input?.resolveRail ?? defaultResolveRail)();
      const balance = await readSplTokenBalance(
        new Connection(rail.rpcUrl, 'confirmed'), usdcMintForNetwork(network), owner,
      );
      return balance.amountAtomic;
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
    resolveRail: input?.resolveRail ?? defaultResolveRail,
    randomId: input?.randomId ?? randomUUID,
  };
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

async function dispatchExisting(
  row: AgentPayment,
  input: AgentPayInput,
  d: ReturnType<typeof deps>,
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
  return executePending(row, d);
}

async function executePending(row: AgentPayment, d: ReturnType<typeof deps>): Promise<AgentPayResult> {
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

  let prep: PreparedCustodialExactPayment;
  try {
    const [wallet, feePayer] = await Promise.all([
      d.loadSigningWallet(row.senderAvatarId), d.resolveFeePayer(rail.network),
    ]);
    if (!wallet || wallet.publicKey !== row.senderWallet) {
      return { ok: false, code: 'sender_wallet_missing', paymentId: row.id, status: 'pending' };
    }
    if (!feePayer) {
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
        }, d)
      : { ok: false, code: 'internal', paymentId: row.id };
  }

  let outcome: ExecutePreparedExactPaymentOutcome;
  try {
    outcome = await d.execute(prep);
  } catch {
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
  if (outcome.kind === 'definitive_failure') {
    await d.db.markFailed(row.id, settlingId, `${outcome.stage}:${outcome.reason}`);
    return { ok: false, code: 'payment_failed', paymentId: row.id, status: 'failed', detail: outcome.reason };
  }
  if (outcome.kind !== 'settled') {
    const reason = outcome.kind === 'ambiguous' ? outcome.reason : 'unexpected_verify_only';
    await d.db.markReconcile(row.id, settlingId, reason);
    return { ok: false, code: 'payment_reconcile', paymentId: row.id, status: 'reconcile', detail: reason };
  }

  let captured: 'captured' | 'lost' | 'signature_conflict';
  try {
    captured = await d.db.captureSettled(row.id, settlingId, outcome.signature, outcome.payer);
  } catch {
    // Settlement succeeded but its signature could not be durably captured.
    // Preserve the observed signature for an operator and never send again.
    try {
      await d.db.markReconcile(
        row.id, settlingId, 'settlement_capture_failed', outcome.signature,
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
      captured, outcome.signature,
    );
    return { ok: false, code: 'payment_reconcile', paymentId: row.id, status: 'reconcile', detail: captured };
  }
  return fulfill(row.id, d);
}

export async function payAgent(input: AgentPayInput, injected?: AgentPayDeps): Promise<AgentPayResult> {
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
  if (existing) return dispatchExisting(existing, input, d);

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
  let row = await d.db.insertPending({
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
  });
  if (!row) {
    row = await d.db.findByIdempotency(input.senderAvatarId, input.idempotencyKey);
    if (!row) return { ok: false, code: 'internal' };
    return dispatchExisting(row, input, d);
  }
  return executePending(row, d);
}
