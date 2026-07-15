/**
 * x402 SETTLE RECONCILER (Tokenomics C — Codex round-2 MEDIUM, pre-promotion).
 *
 * The durable settle machines (x402_checkouts + ct_topups + agent_payments) move a payment
 * to the terminal `reconcile` state whenever the money-state is UNKNOWN or a
 * settled signature could not be cleanly bound:
 *   - `settle_ambiguous` — the facilitator /settle call was attempted and threw;
 *     it MAY have landed on-chain (no signature captured).
 *   - `stale_settling`   — a settling claim died before the facilitator returned
 *     (no signature).
 *   - `capture_lost`     — WE settled (we hold the signature) but our row could
 *     not capture it (claim moved) — the money is ours, the item is undelivered.
 *   - `signature_conflict` — the SAME settled signature was already bound to
 *     ANOTHER checkout; this buyer's item was not delivered on this row.
 *
 * This is the RECONCILIATION SURFACE the money path needs before promotion:
 * manual-SQL triage of `reconcile` rows is not promotable. It enumerates every
 * reconcile row across all three tables, classifies each into a RESOLUTION
 * recommendation (pure `classifyReconcile`), and LOGS the finding + the
 * recommended READ-ONLY chain poll (by stored signature, or by payer + amount +
 * window). The runnable entry is `apps/api/scripts/x402/reconcile-checkouts.ts`.
 *
 * Apply is double-consent: the caller must request apply AND
 * `RECONCILE_APPLY=true`. Without both, the scan stays read-only. Reconciliation
 * never signs or sends refunds; it captures verified receipts, resumes the
 * settle machine's own fulfillment, or records a durable operator action.
 * Ambiguous/malformed chain reads are fail-soft and never mutate a row.
 */

import { randomUUID } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import {
  db,
  x402Checkouts,
  ctTopups,
  agentPayments,
  x402SettlementReceipts,
  and,
  eq,
  isNull,
  sql,
} from '@clawville/database';
import { alertError } from './alert-error';
import { loadX402Config } from './x402-config';
import { fulfillReconciledTopup } from '../routes/ct-topup';
import { fulfillReconciledCheckout } from './x402-checkout';
import { fulfillReconciledAgentPayment } from './agent-pay';
import {
  usdCentsToUsdcAtomic,
  usdcMintForNetwork,
  type X402Network,
} from './x402-payai';
import {
  createConnectionReconcileChainDeps,
  probeUsdcTransfers,
  resolveReconcileNetwork,
  verifyUsdcTransfer,
  type ChainVerification,
  type ReconcileChainDeps,
} from './x402-chain-verifier';

// The CLI imports this service without mounting the HTTP route, so register the
// exact same checkout fulfillers the route loads before any apply can resume.
import './checkout-fulfillers/cosmetic-purchase';
import './checkout-fulfillers/rent-prepay';
import './checkout-fulfillers/marketplace-purchase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconcileTable = 'x402_checkouts' | 'ct_topups' | 'agent_payments';

export interface ReconcileRow {
  table: ReconcileTable;
  id: string;
  usdCents: number;
  createdAt: string;
  settlingStartedAt: string | null;
  /** Agent payments settle directly to the recipient; other rows use merchant config. */
  destinationOwner?: string;
  metadata: {
    reconcileReason?: string;
    spentTxSignature?: string;
    expectedPayer?: string;
    settleNetwork?: string;
    [k: string]: unknown;
  };
}

export function normalizeAgentReconcileReason(
  failureReason: string | null,
  observedSignature: string | null,
): string {
  if (failureReason === 'signature_conflict') return 'signature_conflict';
  if (observedSignature) return 'capture_lost';
  if (failureReason === 'stale_settling') return 'stale_settling';
  return 'settle_ambiguous';
}

/** The recommended resolution for a reconcile row — the reconciler's core output. */
export type ReconcileResolution =
  | {
      kind: 'verify_signature';
      spentTxSignature: string;
      /** capture_fulfill = the money is ours, deliver the item; refund_required =
       *  contested (the signature belongs to another checkout), refund the buyer. */
      recommend: 'capture_fulfill' | 'refund_required';
      note: string;
    }
  | {
      kind: 'probe_merchant';
      expectedUsdcAtomic: string;
      expectedPayer: string | null;
      sinceIso: string;
      note: string;
    }
  | { kind: 'manual_review'; note: string };

// ---------------------------------------------------------------------------
// classifyReconcile — PURE (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Decide HOW a reconcile row should be resolved — no I/O. A row carrying a spent
 * signature is resolved by verifying THAT signature; a row without one
 * (ambiguous/stale) is resolved by probing the merchant wallet for a matching
 * inbound payment.
 */
export function classifyReconcile(row: ReconcileRow): ReconcileResolution {
  if (row.metadata?.reconcileResolution === 'refund_required') {
    return { kind: 'manual_review', note: 'refund already durably required; awaiting operator executor' };
  }
  const reason = typeof row.metadata?.reconcileReason === 'string' ? row.metadata.reconcileReason : 'unknown';
  const sig = typeof row.metadata?.spentTxSignature === 'string' ? row.metadata.spentTxSignature : null;
  const expectedPayer = typeof row.metadata?.expectedPayer === 'string' ? row.metadata.expectedPayer : null;
  const sinceIso = row.settlingStartedAt ?? row.createdAt;

  switch (reason) {
    case 'capture_lost':
    case 'independent_chain_unavailable':
      // We settled (hold the signature) but the row could not capture it. The
      // money is OURS → verify the signature landed, then capture + fulfill.
      return sig
        ? {
            kind: 'verify_signature',
            spentTxSignature: sig,
            recommend: 'capture_fulfill',
            note: 'settled but capture-lost; verify on-chain then capture + fulfill (money is ours)',
          }
        : { kind: 'manual_review', note: 'capture_lost without a recorded signature — manual review' };
    case 'signature_conflict':
      // The same on-chain payment was already bound to ANOTHER checkout; this
      // row's item was never delivered. Contested → refund (never re-fulfill on a
      // signature another checkout owns).
      return sig
        ? {
            kind: 'verify_signature',
            spentTxSignature: sig,
            recommend: 'refund_required',
            note: 'signature owned by another checkout; contested → refund-required-with-signature',
          }
        : { kind: 'manual_review', note: 'signature_conflict without a signature — manual review' };
    case 'settle_ambiguous':
    case 'stale_settling':
      // Money-state UNKNOWN, no signature. Probe the merchant wallet for a
      // matching inbound payment in the window: found → capture + fulfill; none
      // past a grace window → no-money terminal.
      return {
        kind: 'probe_merchant',
        expectedUsdcAtomic: usdCentsToUsdcAtomic(row.usdCents),
        expectedPayer,
        sinceIso,
        note: `${reason}: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)`,
      };
    default:
      return { kind: 'manual_review', note: `unrecognized reconcile reason '${reason}' — manual review` };
  }
}

// ---------------------------------------------------------------------------
// Row reader
// ---------------------------------------------------------------------------

export async function readReconcileRows(): Promise<ReconcileRow[]> {
  const checkouts = await db
    .select({
      id: x402Checkouts.id,
      usdCents: x402Checkouts.usdCents,
      createdAt: x402Checkouts.createdAt,
      settlingStartedAt: x402Checkouts.settlingStartedAt,
      metadata: x402Checkouts.metadata,
    })
    .from(x402Checkouts)
    .where(eq(x402Checkouts.status, 'reconcile'));
  const topups = await db
    .select({
      id: ctTopups.id,
      usdCents: ctTopups.amountCt, // ct_topups: amount_ct == usd_cents at the ¢-peg (usdToCt is identity)
      createdAt: ctTopups.createdAt,
      settlingStartedAt: ctTopups.settlingStartedAt,
      metadata: ctTopups.metadata,
    })
    .from(ctTopups)
    .where(eq(ctTopups.status, 'reconcile'));
  const payments = await db
    .select({
      id: agentPayments.id,
      usdCents: agentPayments.usdCents,
      createdAt: agentPayments.createdAt,
      settlingStartedAt: agentPayments.settlingStartedAt,
      failureReason: agentPayments.failureReason,
      reconcileTxSignature: agentPayments.reconcileTxSignature,
      senderWallet: agentPayments.senderWallet,
      recipientWallet: agentPayments.recipientWallet,
      network: agentPayments.network,
      metadata: agentPayments.metadata,
    })
    .from(agentPayments)
    .where(eq(agentPayments.status, 'reconcile'));

  const norm = (
    table: ReconcileTable,
    r: {
      id: string;
      usdCents: number;
      createdAt: Date | string;
      settlingStartedAt: Date | string | null;
      metadata: unknown;
    },
  ): ReconcileRow => ({
    table,
    id: r.id,
    usdCents: Number(r.usdCents),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    settlingStartedAt:
      r.settlingStartedAt == null
        ? null
        : r.settlingStartedAt instanceof Date
          ? r.settlingStartedAt.toISOString()
          : String(r.settlingStartedAt),
    metadata: (r.metadata ?? {}) as ReconcileRow['metadata'],
  });

  return [
    ...checkouts.map((r) => norm('x402_checkouts', r)),
    ...topups.map((r) => norm('ct_topups', r)),
    ...payments.map((r) => ({
      ...norm('agent_payments', {
        id: r.id,
        usdCents: r.usdCents,
        createdAt: r.createdAt,
        settlingStartedAt: r.settlingStartedAt,
        metadata: {
          ...(r.metadata ?? {}),
          reconcileReason: normalizeAgentReconcileReason(
            r.failureReason,
            r.reconcileTxSignature,
          ),
          agentReconcileReason: r.failureReason ?? 'unknown',
          ...(r.reconcileTxSignature ? { spentTxSignature: r.reconcileTxSignature } : {}),
          expectedPayer: r.senderWallet,
          settleNetwork: r.network,
        },
      }),
      destinationOwner: r.recipientWallet,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Apply store — every mutation is a status=reconcile CAS
// ---------------------------------------------------------------------------

export type CaptureClaimResult = 'captured' | 'lost' | 'signature_conflict';

export interface RefundEvidence {
  signature: string;
  payer: string | null;
  expectedUsdcAtomic: string;
  chainVerdict: string;
}

export interface ReconcileApplyStore {
  isSignatureBound(signature: string): Promise<boolean>;
  claimVerifiedCapture(
    row: ReconcileRow,
    signature: string,
    payer: string | null,
    settlingId: string,
    now: Date,
  ): Promise<CaptureClaimResult>;
  markRefundRequired(row: ReconcileRow, evidence: RefundEvidence, now: Date): Promise<boolean>;
  markNoMoneyFailed(row: ReconcileRow, now: Date): Promise<boolean>;
}

function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

async function defaultIsSignatureBound(signature: string): Promise<boolean> {
  const receipt = await db
    .select({ signature: x402SettlementReceipts.txSignature })
    .from(x402SettlementReceipts)
    .where(eq(x402SettlementReceipts.txSignature, signature))
    .limit(1);
  if (receipt.length > 0) return true;
  const checkout = await db
    .select({ id: x402Checkouts.id })
    .from(x402Checkouts)
    .where(eq(x402Checkouts.txSignature, signature))
    .limit(1);
  if (checkout.length > 0) return true;
  const topup = await db
    .select({ id: ctTopups.id })
    .from(ctTopups)
    .where(eq(ctTopups.txSignature, signature))
    .limit(1);
  if (topup.length > 0) return true;
  const payment = await db
    .select({ id: agentPayments.id })
    .from(agentPayments)
    .where(eq(agentPayments.txSignature, signature))
    .limit(1);
  return payment.length > 0;
}

const defaultApplyStore: ReconcileApplyStore = {
  isSignatureBound: defaultIsSignatureBound,

  async claimVerifiedCapture(row, signature, payer, settlingId, now) {
    try {
      return await db.transaction(async (tx) => {
        // Normal settle writers do not take our advisory lock. This table lock
        // waits out and blocks their ROW EXCLUSIVE capture updates while the
        // cross-table ownership check + bind runs. Apply is operator-only/rare.
        await tx.execute(
          sql`LOCK TABLE x402_settlement_receipts, x402_checkouts, ct_topups, agent_payments IN SHARE ROW EXCLUSIVE MODE`,
        );
        // Also serializes two reconciler captures of the same proof.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`x402-reconcile:${signature}`}, 0))`,
        );
        const receiptOwner = await tx
          .select({ signature: x402SettlementReceipts.txSignature })
          .from(x402SettlementReceipts)
          .where(eq(x402SettlementReceipts.txSignature, signature))
          .limit(1);
        if (receiptOwner.length > 0) return 'signature_conflict' as const;
        const checkoutOwner = await tx
          .select({ id: x402Checkouts.id })
          .from(x402Checkouts)
          .where(eq(x402Checkouts.txSignature, signature))
          .limit(1);
        const topupOwner = await tx
          .select({ id: ctTopups.id })
          .from(ctTopups)
          .where(eq(ctTopups.txSignature, signature))
          .limit(1);
        const agentOwner = await tx
          .select({ id: agentPayments.id })
          .from(agentPayments)
          .where(eq(agentPayments.txSignature, signature))
          .limit(1);
        if (checkoutOwner.length || topupOwner.length || agentOwner.length) {
          return 'signature_conflict' as const;
        }

        const settleNetwork = row.metadata.settleNetwork ?? row.metadata.network;
        const metadataPatch = {
          reconcileResolution: 'captured',
          reconcileEvidenceSignature: signature,
          settlePayer: payer,
          settleNetwork,
          reconciledAt: now.toISOString(),
        };
        if (row.table === 'x402_checkouts') {
          const claimed = await tx
            .update(x402Checkouts)
            .set({
              status: 'settling',
              txSignature: signature,
              usdBasisAtReceipt: (row.usdCents / 100).toFixed(2),
              settlingId,
              settlingStartedAt: now,
              metadata: sql`${x402Checkouts.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
            })
            .where(and(
              eq(x402Checkouts.id, row.id),
              eq(x402Checkouts.status, 'reconcile'),
              isNull(x402Checkouts.txSignature),
            ))
            .returning({ id: x402Checkouts.id });
          return claimed.length === 1 ? 'captured' as const : 'lost' as const;
        }
        if (row.table === 'ct_topups') {
          const claimed = await tx
            .update(ctTopups)
            .set({
              status: 'settling',
              txSignature: signature,
              usdBasisAtReceipt: (row.usdCents / 100).toFixed(2),
              settlingId,
              settlingStartedAt: now,
              metadata: sql`${ctTopups.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
            })
            .where(and(
              eq(ctTopups.id, row.id),
              eq(ctTopups.status, 'reconcile'),
              isNull(ctTopups.txSignature),
            ))
            .returning({ id: ctTopups.id });
          return claimed.length === 1 ? 'captured' as const : 'lost' as const;
        }
        const claimed = await tx
          .update(agentPayments)
          .set({
            status: 'settling',
            txSignature: signature,
            settlePayer: payer,
            settlingId,
            settlingStartedAt: now,
            failureReason: null,
            metadata: sql`${agentPayments.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
            updatedAt: now,
          })
          .where(and(
            eq(agentPayments.id, row.id),
            eq(agentPayments.status, 'reconcile'),
            isNull(agentPayments.txSignature),
          ))
          .returning({ id: agentPayments.id });
        return claimed.length === 1 ? 'captured' as const : 'lost' as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'signature_conflict';
      throw err;
    }
  },

  async markRefundRequired(row, evidence, now) {
    const patch = {
      reconcileResolution: 'refund_required',
      refundRequired: {
        payer: evidence.payer,
        expectedUsdcAtomic: evidence.expectedUsdcAtomic,
        evidenceSignature: evidence.signature,
        chainVerdict: evidence.chainVerdict,
        recordedAt: now.toISOString(),
      },
    };
    if (row.table === 'x402_checkouts') {
      const changed = await db.update(x402Checkouts).set({
        metadata: sql`${x402Checkouts.metadata} || ${JSON.stringify(patch)}::jsonb`,
      }).where(and(
        eq(x402Checkouts.id, row.id),
        eq(x402Checkouts.status, 'reconcile'),
        sql`${x402Checkouts.metadata}->>'reconcileResolution' IS DISTINCT FROM 'refund_required'`,
      )).returning({ id: x402Checkouts.id });
      return changed.length === 1;
    }
    if (row.table === 'ct_topups') {
      const changed = await db.update(ctTopups).set({
        metadata: sql`${ctTopups.metadata} || ${JSON.stringify(patch)}::jsonb`,
      }).where(and(
        eq(ctTopups.id, row.id),
        eq(ctTopups.status, 'reconcile'),
        sql`${ctTopups.metadata}->>'reconcileResolution' IS DISTINCT FROM 'refund_required'`,
      )).returning({ id: ctTopups.id });
      return changed.length === 1;
    }
    const changed = await db.update(agentPayments).set({
      failureReason: 'refund_required',
      reconcileTxSignature: evidence.signature,
      settlePayer: evidence.payer,
      metadata: sql`${agentPayments.metadata} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: now,
    }).where(and(
      eq(agentPayments.id, row.id),
      eq(agentPayments.status, 'reconcile'),
      sql`${agentPayments.metadata}->>'reconcileResolution' IS DISTINCT FROM 'refund_required'`,
    )).returning({ id: agentPayments.id });
    return changed.length === 1;
  },

  async markNoMoneyFailed(row, now) {
    const patch = {
      reconcileResolution: 'no_money',
      failureReason: 'reconcile_no_money',
      reconciledAt: now.toISOString(),
    };
    if (row.table === 'x402_checkouts') {
      const changed = await db.update(x402Checkouts).set({
        status: 'failed',
        settlingId: null,
        settlingStartedAt: null,
        metadata: sql`${x402Checkouts.metadata} || ${JSON.stringify(patch)}::jsonb`,
      }).where(and(
        eq(x402Checkouts.id, row.id),
        eq(x402Checkouts.status, 'reconcile'),
        isNull(x402Checkouts.txSignature),
      )).returning({ id: x402Checkouts.id });
      return changed.length === 1;
    }
    if (row.table === 'ct_topups') {
      const changed = await db.update(ctTopups).set({
        status: 'failed',
        settlingId: null,
        settlingStartedAt: null,
        metadata: sql`${ctTopups.metadata} || ${JSON.stringify(patch)}::jsonb`,
      }).where(and(
        eq(ctTopups.id, row.id),
        eq(ctTopups.status, 'reconcile'),
        isNull(ctTopups.txSignature),
      )).returning({ id: ctTopups.id });
      return changed.length === 1;
    }
    const changed = await db.update(agentPayments).set({
      status: 'failed',
      failureReason: 'reconcile_no_money',
      settlingId: null,
      settlingStartedAt: null,
      metadata: sql`${agentPayments.metadata} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: now,
    }).where(and(
      eq(agentPayments.id, row.id),
      eq(agentPayments.status, 'reconcile'),
      isNull(agentPayments.txSignature),
    )).returning({ id: agentPayments.id });
    return changed.length === 1;
  },
};

// ---------------------------------------------------------------------------
// Gated apply orchestration
// ---------------------------------------------------------------------------

export interface ReconcileRecommendation {
  table: ReconcileTable;
  id: string;
  reason: string;
  resolution: ReconcileResolution;
}

export type ReconcileAction =
  | 'dry_run'
  | 'applied_capture_fulfill'
  | 'applied_capture_pending'
  | 'applied_refund_required'
  | 'applied_no_money'
  | 'skipped'
  | 'manual_review';

export interface ReconcileRowVerdict extends ReconcileRecommendation {
  action: ReconcileAction;
  detail: string;
  signature?: string;
}

export interface ReconcileScanDeps {
  readRows?: () => Promise<ReconcileRow[]>;
  store?: ReconcileApplyStore;
  chain?: ReconcileChainDeps;
  verifyTransfer?: typeof verifyUsdcTransfer;
  probeTransfers?: typeof probeUsdcTransfers;
  loadConfig?: typeof loadX402Config;
  connectionForNetwork?: (network: X402Network) => Connection;
  fulfillCheckout?: typeof fulfillReconciledCheckout;
  fulfillTopup?: typeof fulfillReconciledTopup;
  fulfillAgentPayment?: typeof fulfillReconciledAgentPayment;
  alert?: typeof alertError;
  now?: () => Date;
  randomId?: () => string;
}

export interface ReconcileScanOptions {
  /** Apply requires this explicit consent plus RECONCILE_APPLY=true. */
  apply?: boolean;
  /** Optional `<table>:<id>` selector. */
  row?: string;
  deps?: ReconcileScanDeps;
}

export interface ReconcileScanResult {
  scanned: number;
  recommendations: ReconcileRecommendation[];
  verdicts: ReconcileRowVerdict[];
  summary: { applied: number; skipped: number; manual: number };
}

export function resolveReconcileProbeMaxSignatures(raw = process.env.RECONCILE_PROBE_MAX_SIGNATURES): number {
  const parsed = Number(raw ?? '500');
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : 500;
}

export function resolveReconcileNoMoneyGraceMs(raw = process.env.RECONCILE_NO_MONEY_GRACE_MS): number {
  if (raw == null || raw.trim() === '') return 86_400_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 86_400_000;
  return Math.max(3_600_000, Math.floor(parsed));
}

/** Kept for old callers: enabling the env no longer refuses a dry-run scan. */
export function assertNoReconcileApply(): void {
  // Mutation now requires explicit `runReconcileScan({ apply: true })` consent.
}

function assertApplyConsent(apply: boolean): void {
  if (apply && process.env.RECONCILE_APPLY !== 'true') {
    throw new Error('Apply requested but RECONCILE_APPLY=true is also required. Refusing mutation.');
  }
}

let devnetConnection: Connection | null = null;
async function defaultConnectionForNetwork(network: X402Network): Promise<Connection> {
  if (network === 'mainnet') {
    // Lazy import keeps custody/key decryption off dry-run and unit-test import
    // graphs while still reusing the audited shared mainnet connection source.
    const { getClvMainnetConnection } = await import('./clv-swap-custody');
    return getClvMainnetConnection();
  }
  if (!devnetConnection) {
    devnetConnection = new Connection(
      process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com',
      'confirmed',
    );
  }
  return devnetConnection;
}

function createDefaultChainDeps(store: ReconcileApplyStore): ReconcileChainDeps {
  return {
    async getParsedTransaction(network, signature) {
      const connection = await defaultConnectionForNetwork(network);
      return connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    },
    async getSignaturesForAddress(network, address, options) {
      const { PublicKey } = await import('@solana/web3.js');
      const connection = await defaultConnectionForNetwork(network);
      return connection.getSignaturesForAddress(new PublicKey(address), options, 'confirmed');
    },
    isSignatureBound: (signature) => store.isSignatureBound(signature),
  };
}

function selectorMatches(row: ReconcileRow, selector?: string): boolean {
  if (!selector) return true;
  return selector === `${row.table}:${row.id}`;
}

export function parseReconcileRowSelector(value: string): { table: ReconcileTable; id: string } {
  const separator = value.indexOf(':');
  const table = value.slice(0, separator) as ReconcileTable;
  const id = value.slice(separator + 1);
  if (
    separator < 1
    || !['x402_checkouts', 'ct_topups', 'agent_payments'].includes(table)
    || id.trim().length === 0
  ) {
    throw new Error(`Invalid --row '${value}'; expected <x402_checkouts|ct_topups|agent_payments>:<id>`);
  }
  return { table, id };
}

function logRecommendation(row: ReconcileRow, resolution: ReconcileResolution, reason: string): void {
  console.log(
    `[reconcile] ${row.table} ${row.id} reason=${reason} → ${resolution.kind}` +
      (resolution.kind === 'verify_signature'
        ? ` (${resolution.recommend}, sig=${resolution.spentTxSignature})`
        : '') +
      (resolution.kind === 'probe_merchant'
        ? ` (amount=${resolution.expectedUsdcAtomic} atomic, payer=${resolution.expectedPayer ?? 'unknown'}, since=${resolution.sinceIso})`
        : '') +
      ` — ${resolution.note}`,
  );
}

function structuredActionLog(verdict: ReconcileRowVerdict): void {
  console.log(JSON.stringify({
    event: 'x402_reconcile_action',
    table: verdict.table,
    rowId: verdict.id,
    action: verdict.action,
    detail: verdict.detail,
    signature: verdict.signature ?? null,
  }));
}

function targetForRow(
  row: ReconcileRow,
  loadConfig: typeof loadX402Config,
): { network: X402Network; mint: string; destinationOwner: string } | null {
  const network = resolveReconcileNetwork(row.metadata.settleNetwork ?? row.metadata.network);
  if (!network) return null;
  const destinationOwner = row.destinationOwner ?? loadConfig().merchantWalletPubkey;
  if (!destinationOwner) return null;
  return { network, mint: usdcMintForNetwork(network), destinationOwner };
}

async function fulfillCapturedRow(
  row: ReconcileRow,
  deps: Required<Pick<ReconcileScanDeps, 'fulfillCheckout' | 'fulfillTopup' | 'fulfillAgentPayment'>>,
): Promise<unknown> {
  if (row.table === 'x402_checkouts') return deps.fulfillCheckout(row.id);
  if (row.table === 'ct_topups') return deps.fulfillTopup(row.id);
  return deps.fulfillAgentPayment(row.id);
}

function fulfillmentSucceeded(row: ReconcileRow, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  if (row.table === 'ct_topups') {
    const status = (result as { httpStatus?: unknown }).httpStatus;
    return typeof status === 'number' && status >= 200 && status < 300;
  }
  return (result as { ok?: unknown }).ok === true;
}

async function recordRefundRequired(
  recommendation: ReconcileRecommendation,
  row: ReconcileRow,
  evidence: RefundEvidence,
  store: ReconcileApplyStore,
  now: Date,
  alert: typeof alertError,
): Promise<ReconcileRowVerdict> {
  const changed = await store.markRefundRequired(row, evidence, now);
  if (!changed) {
    return { ...recommendation, action: 'skipped', detail: 'refund_required CAS lost', signature: evidence.signature };
  }
  await alert({
    severity: 'critical',
    source: 'x402-reconcile',
    message: `Refund required for ${row.table}:${row.id}`,
    context: {
      table: row.table,
      rowId: row.id,
      payer: evidence.payer,
      expectedUsdcAtomic: evidence.expectedUsdcAtomic,
      evidenceSignature: evidence.signature,
      chainVerdict: evidence.chainVerdict,
    },
  });
  return {
    ...recommendation,
    action: 'applied_refund_required',
    detail: 'durable refund-required evidence recorded; no refund sent',
    signature: evidence.signature,
  };
}

async function captureAndFulfill(
  recommendation: ReconcileRecommendation,
  row: ReconcileRow,
  transfer: Extract<ChainVerification, { kind: 'confirmed_match' }>['transfer'],
  store: ReconcileApplyStore,
  now: Date,
  randomId: () => string,
  fulfillDeps: Required<Pick<ReconcileScanDeps, 'fulfillCheckout' | 'fulfillTopup' | 'fulfillAgentPayment'>>,
  alert: typeof alertError,
): Promise<ReconcileRowVerdict> {
  const claimed = await store.claimVerifiedCapture(
    row,
    transfer.signature,
    transfer.payer,
    randomId(),
    now,
  );
  if (claimed === 'signature_conflict') {
    return recordRefundRequired(
      recommendation,
      row,
      {
        signature: transfer.signature,
        payer: transfer.payer,
        expectedUsdcAtomic: usdCentsToUsdcAtomic(row.usdCents),
        chainVerdict: 'verified_signature_conflict',
      },
      store,
      now,
      alert,
    );
  }
  if (claimed === 'lost') {
    return { ...recommendation, action: 'skipped', detail: 'capture CAS lost', signature: transfer.signature };
  }
  try {
    const result = await fulfillCapturedRow(row, fulfillDeps);
    if (!fulfillmentSucceeded(row, result)) {
      await alert({
        severity: 'critical',
        source: 'x402-reconcile',
        message: `Captured ${row.table}:${row.id}; fulfillment remains pending`,
        context: { rowId: row.id, table: row.table, signature: transfer.signature, result },
      });
      return {
        ...recommendation,
        action: 'applied_capture_pending',
        detail: 'signature captured; settle-machine fulfillment returned non-success and remains resumable',
        signature: transfer.signature,
      };
    }
    return {
      ...recommendation,
      action: 'applied_capture_fulfill',
      detail: 'verified signature captured; settle-machine fulfillment invoked',
      signature: transfer.signature,
    };
  } catch (err) {
    await alert({
      severity: 'critical',
      source: 'x402-reconcile',
      message: `Captured ${row.table}:${row.id} but fulfillment threw`,
      context: { rowId: row.id, table: row.table, signature: transfer.signature, error: (err as Error).message },
    });
    return {
      ...recommendation,
      action: 'applied_capture_pending',
      detail: 'signature captured; fulfillment remains resumable after error',
      signature: transfer.signature,
    };
  }
}

/** Parse the operator CLI's argv (lives here so tests + the scripts/ entry can
 *  share it without importing across the tsconfig rootDir boundary). */
export function parseReconcileCliArgs(argv: string[]): ReconcileScanOptions {
  let apply = false;
  let row: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--row') {
      const value = argv[index + 1];
      if (!value) throw new Error('--row requires <table>:<id>');
      parseReconcileRowSelector(value);
      row = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'`);
  }
  if (apply && process.env.RECONCILE_APPLY !== 'true') {
    throw new Error('--apply also requires RECONCILE_APPLY=true');
  }
  return { apply, ...(row ? { row } : {}) };
}

/** Dry-run by default; live apply requires both an explicit option and env consent. */
export async function runReconcileScan(options: ReconcileScanOptions = {}): Promise<ReconcileScanResult> {
  const apply = options.apply === true;
  assertApplyConsent(apply);
  if (options.row) parseReconcileRowSelector(options.row);

  const injected = options.deps ?? {};
  const store = injected.store ?? defaultApplyStore;
  const chain = injected.chain ?? (
    injected.connectionForNetwork
      ? createConnectionReconcileChainDeps(
          injected.connectionForNetwork,
          (signature) => store.isSignatureBound(signature),
        )
      : createDefaultChainDeps(store)
  );
  const verifyTransfer = injected.verifyTransfer ?? verifyUsdcTransfer;
  const probeTransfers = injected.probeTransfers ?? probeUsdcTransfers;
  const loadConfig = injected.loadConfig ?? loadX402Config;
  const nowFn = injected.now ?? (() => new Date());
  const randomId = injected.randomId ?? randomUUID;
  const alert = injected.alert ?? alertError;
  const fulfillDeps = {
    fulfillCheckout: injected.fulfillCheckout ?? fulfillReconciledCheckout,
    fulfillTopup: injected.fulfillTopup ?? fulfillReconciledTopup,
    fulfillAgentPayment: injected.fulfillAgentPayment ?? fulfillReconciledAgentPayment,
  };
  const allRows = await (injected.readRows ?? readReconcileRows)();
  const rows = allRows.filter((row) => selectorMatches(row, options.row));
  const recommendations: ReconcileRecommendation[] = [];
  const verdicts: ReconcileRowVerdict[] = [];

  for (const row of rows) {
    const resolution = classifyReconcile(row);
    const reason = typeof row.metadata?.reconcileReason === 'string' ? row.metadata.reconcileReason : 'unknown';
    const recommendation = { table: row.table, id: row.id, reason, resolution };
    recommendations.push(recommendation);
    logRecommendation(row, resolution, reason);
    if (!apply) {
      verdicts.push({ ...recommendation, action: 'dry_run', detail: 'no state changed' });
      continue;
    }

    try {
      let verdict: ReconcileRowVerdict;
      if (resolution.kind === 'manual_review') {
        verdict = { ...recommendation, action: 'manual_review', detail: resolution.note };
      } else {
        const target = targetForRow(row, loadConfig);
        if (!target) {
          verdict = {
            ...recommendation,
            action: 'manual_review',
            detail: 'unresolvable settle network or destination',
          };
        } else if (resolution.kind === 'verify_signature') {
        const chainVerdict = await verifyTransfer({
          network: target.network,
          signature: resolution.spentTxSignature,
          expectedAtomic: usdCentsToUsdcAtomic(row.usdCents),
          expectedMint: target.mint,
          destinationOwner: target.destinationOwner,
          expectedPayer: typeof row.metadata.expectedPayer === 'string' ? row.metadata.expectedPayer : null,
        }, chain);
        if (chainVerdict.kind !== 'confirmed_match') {
          verdict = {
            ...recommendation,
            action: chainVerdict.kind === 'not_found' ? 'skipped' : 'manual_review',
            detail: `signature verification: ${chainVerdict.kind}`,
            signature: resolution.spentTxSignature,
          };
        } else if (resolution.recommend === 'refund_required') {
          verdict = await recordRefundRequired(
            recommendation,
            row,
            {
              signature: resolution.spentTxSignature,
              payer: chainVerdict.transfer.payer,
              expectedUsdcAtomic: usdCentsToUsdcAtomic(row.usdCents),
              chainVerdict: 'confirmed_match',
            },
            store,
            nowFn(),
            alert,
          );
        } else {
          verdict = await captureAndFulfill(
            recommendation,
            row,
            chainVerdict.transfer,
            store,
            nowFn(),
            randomId,
            fulfillDeps,
            alert,
          );
        }
        } else {
        const probe = await probeTransfers({
          network: target.network,
          expectedAtomic: resolution.expectedUsdcAtomic,
          expectedMint: target.mint,
          destinationOwner: target.destinationOwner,
          expectedPayer: resolution.expectedPayer,
          sinceIso: resolution.sinceIso,
          maxSignatures: resolveReconcileProbeMaxSignatures(),
        }, chain);
        if (probe.kind === 'match') {
          verdict = await captureAndFulfill(
            recommendation,
            row,
            probe.match,
            store,
            nowFn(),
            randomId,
            fulfillDeps,
            alert,
          );
        } else if (probe.kind === 'ambiguous') {
          verdict = { ...recommendation, action: 'manual_review', detail: 'multiple exact unbound transfers; refusing to guess' };
        } else if (probe.kind === 'indeterminate') {
          verdict = { ...recommendation, action: 'skipped', detail: `probe indeterminate: ${probe.reason}` };
        } else {
          const now = nowFn();
          const ageMs = now.getTime() - new Date(row.createdAt).getTime();
          if (!Number.isFinite(ageMs) || ageMs < resolveReconcileNoMoneyGraceMs()) {
            verdict = { ...recommendation, action: 'skipped', detail: 'no match, but row remains inside no-money grace window' };
          } else {
            const changed = await store.markNoMoneyFailed(row, now);
            verdict = changed
              ? { ...recommendation, action: 'applied_no_money', detail: 'no payment found after grace; reconcile→failed' }
              : { ...recommendation, action: 'skipped', detail: 'no-money CAS lost' };
          }
        }
        }
      }
      verdicts.push(verdict);
      structuredActionLog(verdict);
    } catch (err) {
      const verdict: ReconcileRowVerdict = {
        ...recommendation,
        action: 'skipped',
        detail: `fail-soft: ${(err as Error).message}`,
      };
      verdicts.push(verdict);
      structuredActionLog(verdict);
    }
  }

  if (!apply) {
    console.log(
      `[reconcile] scanned ${rows.length} reconcile row(s) across x402_checkouts + ct_topups + agent_payments (DRY-RUN — no state changed)`,
    );
  }
  const summary = {
    applied: verdicts.filter((v) => v.action.startsWith('applied_')).length,
    skipped: verdicts.filter((v) => v.action === 'skipped').length,
    manual: verdicts.filter((v) => v.action === 'manual_review').length,
  };
  return { scanned: rows.length, recommendations, verdicts, summary };
}
