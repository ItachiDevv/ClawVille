/**
 * x402 SETTLE RECONCILER (Tokenomics C — Codex round-2 MEDIUM, pre-promotion).
 *
 * The durable settle machines (x402_checkouts + ct_topups) move a top-up/checkout
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
 * reconcile row across BOTH tables, classifies each into a RESOLUTION
 * recommendation (pure `classifyReconcile`), and LOGS the finding + the
 * recommended READ-ONLY chain poll (by stored signature, or by payer + amount +
 * window). The runnable entry is `apps/api/scripts/x402/reconcile-checkouts.ts`.
 *
 * ── SAFETY: DRY-RUN ONLY (like the CLV swap executor) ───────────────────────
 * v1 NEVER mutates a row and NEVER signs/sends. `RECONCILE_APPLY` is a HARD GATE:
 * set to 'true' ⇒ the reconciler REFUSES to run (the apply path — capture+fulfill
 * a landed-but-uncaptured payment, queue a refund-with-signature, or terminal a
 * no-money row — is a Codex-review-gated follow-up whose live-chain parser must be
 * verified against the real chain first). Chain reads are fail-soft.
 */

import { db, x402Checkouts, ctTopups, eq } from '@clawville/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconcileTable = 'x402_checkouts' | 'ct_topups';

export interface ReconcileRow {
  table: ReconcileTable;
  id: string;
  usdCents: number;
  createdAt: string;
  settlingStartedAt: string | null;
  metadata: {
    reconcileReason?: string;
    spentTxSignature?: string;
    expectedPayer?: string;
    settleNetwork?: string;
    [k: string]: unknown;
  };
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

/** ¢ → USDC atomic (6-decimal): 1 cent = 10_000 atomic units (mirrors
 *  x402-payai.usdCentsToUsdcAtomic). */
function usdCentsToUsdcAtomic(usdCents: number): string {
  return String(Math.max(0, Math.floor(usdCents)) * 10_000);
}

/**
 * Decide HOW a reconcile row should be resolved — no I/O. A row carrying a spent
 * signature is resolved by verifying THAT signature; a row without one
 * (ambiguous/stale) is resolved by probing the merchant wallet for a matching
 * inbound payment.
 */
export function classifyReconcile(row: ReconcileRow): ReconcileResolution {
  const reason = typeof row.metadata?.reconcileReason === 'string' ? row.metadata.reconcileReason : 'unknown';
  const sig = typeof row.metadata?.spentTxSignature === 'string' ? row.metadata.spentTxSignature : null;
  const expectedPayer = typeof row.metadata?.expectedPayer === 'string' ? row.metadata.expectedPayer : null;
  const sinceIso = row.settlingStartedAt ?? row.createdAt;

  switch (reason) {
    case 'capture_lost':
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
  ];
}

// ---------------------------------------------------------------------------
// Apply gate (Codex-review-gated) + dry-run scan
// ---------------------------------------------------------------------------

const APPLY_REFUSAL =
  'RECONCILE_APPLY=true but the reconciler apply path (capture+fulfill / refund-with-signature / ' +
  'no-money terminal) is Codex-review-gated — the live-chain parser must be verified against the ' +
  'real chain first. Refusing.';

/** HARD GATE: v1 is DRY-RUN only. Throws if someone tries to enable apply. */
export function assertNoReconcileApply(): void {
  if (process.env.RECONCILE_APPLY === 'true') {
    throw new Error(APPLY_REFUSAL);
  }
}

export interface ReconcileRecommendation {
  table: ReconcileTable;
  id: string;
  reason: string;
  resolution: ReconcileResolution;
}

/**
 * DRY-RUN scan: enumerate reconcile rows, classify each, and log the resolution
 * recommendation. NEVER mutates a row.
 *
 * CODEX-GATED SEAM: live chain poll + apply. A reviewed slice would here — for
 * `verify_signature`, call connection.getSignatureStatuses([sig]); for
 * `probe_merchant`, scan the merchant wallet's inbound USDC transfers in the
 * window for a match — then (behind RECONCILE_APPLY) capture+fulfill / queue a
 * refund-with-signature / terminal the no-money row. v1 logs only.
 */
export async function runReconcileScan(): Promise<{
  scanned: number;
  recommendations: ReconcileRecommendation[];
}> {
  assertNoReconcileApply();
  const rows = await readReconcileRows();
  const recommendations: ReconcileRecommendation[] = [];
  for (const row of rows) {
    const resolution = classifyReconcile(row);
    const reason = typeof row.metadata?.reconcileReason === 'string' ? row.metadata.reconcileReason : 'unknown';
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
    recommendations.push({ table: row.table, id: row.id, reason, resolution });
  }
  console.log(
    `[reconcile] scanned ${rows.length} reconcile row(s) across x402_checkouts + ct_topups (DRY-RUN — no state changed)`,
  );
  return { scanned: rows.length, recommendations };
}
