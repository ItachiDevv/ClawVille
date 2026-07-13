// FEATURE_GATE: x402_payment_middleware → ct_topup
// Status: USDC→CT on-ramp (Phase A) — quote + settle wired through the x402/
//   PayAI facilitator primitive (x402-payai.ts) onto the LIVE `ct_topups`
//   table. Devnet-first (X402_NETWORK / quote network default devnet). Human +
//   connected-agent parity via requireAuthOrAgentSession.
// Metric to graduate: settled top-up volume > 0 on /dash (a real settled USDC→CT
//   top-up against the PayAI devnet facilitator, then a mainnet config flip).
// Current reading: 0 (route just shipped; mock-harness GREEN, no live settle yet).
// Review deadline: 2026-08-21.
// On deadline: if no settled top-up volume, keep gated (do NOT enable mainnet);
//   re-evaluate whether the on-ramp graduates or the @x402 stack is ripped.
// Reference: PLAN.md §2 Phase A · CLAUDE.md Priority #3 · improvements.md §7.

/**
 * USDC→CT on-ramp routes.
 *
 *   POST /api/ct/topup/quote   — issue a 402 payment challenge + a pending row.
 *   POST /api/ct/topup/settle  — verify+settle the payment, credit CT EXACTLY ONCE.
 *
 * THE MONEY PATH. x402/PayAI (USDC) is the real-money boundary; this route
 * converts a SETTLED on-chain payment into internal vCLAW via the audited
 * `claw-token-ledger`. vCLAW is never written directly.
 *
 * TOKENOMICS F2/A3 — the credit is tagged BOUGHT (provenance:'bought'),
 * non-cashable V-Bucks, with `usd_basis` = the dollars paid stamped on the ledger
 * row. The store buy-price is the ¢-peg $1 = 100 vCLAW ($0.01/coin,
 * `CT_PER_USDC=100` after the A3 redenomination). BOUGHT can never be cashed out
 * (only EARNED is, via the separate mintEarned chokepoint) — this on-ramp is
 * one-way buy power, never a withdrawal right.
 *
 * PARITY (Rule E5): both a logged-in human (Lucia cookie) AND a connected/hosted
 * agent (X-Clawville-Agent-Session → its bound avatar) reach BOTH routes through
 * `requireAuthOrAgentSession`. An agent tops up ITS OWN avatar (identity.avatarId)
 * for REAL CT + leaderboard consequence — never a guest demotion, never a body-
 * supplied avatarId. Unbound/expired agent ⇒ the middleware 401/403s.
 *
 * DOUBLE-CREDIT INVARIANT (R-doublecredit, Critical): one settled tx signature
 * credits CT EXACTLY ONCE. Enforced by the DB, not by application logic:
 *   - `ct_topups_txsig_unique` (partial UNIQUE on tx_signature WHERE NOT NULL):
 *     the settle UPDATE that writes the signature + the `creditClawTokens` call
 *     run in ONE transaction. A second settle of the SAME signature trips the
 *     index (23505) → the whole tx (including the credit) rolls back → we replay
 *     the already-credited row. No SELECT-then-act TOCTOU window.
 *   - `ct_topups_idem_unique` (partial UNIQUE on (avatar_id, idempotency_key)):
 *     a reused Idempotency-Key replays the cached credit; a DIFFERENT key for the
 *     same settled tx still can't double-credit (the txSignature guard wins).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, ctTopups, avatars, and, eq, isNull, inArray, sql } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { loadX402Config } from '../services/x402-config';
import {
  buildTopupQuote,
  resolveFacilitatorFeePayer,
  verifyAndSettle,
  usdToCt,
  type X402Asset,
  type X402Network,
} from '../services/x402-payai';
import { creditClawTokens } from '../services/claw-token-ledger';
import { withKeyedMutex } from '../services/keyed-mutex';

export const ctTopupRoutes = new Hono<ActivityAuthContext>();

// Populate `c.get('user')` from the Lucia cookie BEFORE requireAuthOrAgentSession
// runs (it reads `c.get('user')` for the human path). The agent path reads the
// X-Clawville-Agent-Session header directly, so a null user here is harmless for
// agents. Mirrors coveBlackjackRouter.use('*', sessionMiddleware).
ctTopupRoutes.use('*', sessionMiddleware);

/** Max length on the Idempotency-Key header (Stripe convention; matches cove). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Resolve the on-ramp network from env. Devnet-first; mainnet is a config flip
 *  AFTER a funded settled smoke (the plan's devnet-first rule). The x402 config
 *  default `X402_NETWORK` is mainnet (legacy demo default), so we read it but map
 *  anything that isn't the mainnet CAIP-2 to devnet, and EXPLICITLY default the
 *  on-ramp to devnet when X402_TOPUP_NETWORK is unset.
 *
 *  EXPORTED (Tokenomics C checkout stage, 2026-07-07): the generic x402
 *  checkout (`services/x402-checkout.ts`) settles on the SAME merchant wallet
 *  and MUST live on the SAME network as the top-up on-ramp — one env var
 *  (`X402_TOPUP_NETWORK`) flips the whole USDC-in family together, never one
 *  surface at a time. */
export function resolveTopupNetwork(): X402Network {
  const explicit = process.env.X402_TOPUP_NETWORK?.trim().toLowerCase();
  if (explicit === 'mainnet') return 'mainnet';
  if (explicit === 'devnet') return 'devnet';
  // Unset ⇒ devnet-first. We deliberately do NOT inherit the x402-config mainnet
  // default for the money on-ramp; mainnet must be turned on intentionally.
  return 'devnet';
}

// ---------------------------------------------------------------------------
// POST /quote — issue a 402 challenge + a pending ct_topups row
// ---------------------------------------------------------------------------
// A signed-in human or a connected agent asks to buy `usdCents` worth of CT.
// We persist a PENDING row (so /settle has something to flip + the quote is
// auditable) and return the x402 v2 requirements in a 402 response, plus the
// topupId + amountCt the caller will see credited.
// ---------------------------------------------------------------------------

const quoteSchema = z.object({
  // USDC-ONLY: `sol` was accepted but `buildTopupQuote` always quotes the USDC
  // mint, so a `sol` quote was a mis-quote. Reject `sol` at the boundary until
  // native-SOL settlement exists (x402-payai.ts X402Asset narrowed to 'usdc').
  asset: z.enum(['usdc']),
  // Positive integer cents. Upper bound caps a single top-up (defends against an
  // overflow / absurd quote); 1_000_000 cents = $10,000.
  usdCents: z.number().int().positive().max(1_000_000),
});

ctTopupRoutes.post('/quote', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }
  const { asset, usdCents } = parsed.data as { asset: X402Asset; usdCents: number };

  const config = loadX402Config();
  if (!config.merchantWalletPubkey) {
    // No payout pubkey configured — refuse to issue a quote rather than mint a
    // requirement with an empty payTo (which would credit nobody / be unsettleable).
    return c.json(
      { error: 'on_ramp_unconfigured', code: 'on_ramp_unconfigured' },
      503,
    );
  }

  const network = resolveTopupNetwork();
  const amountCt = usdToCt(usdCents);

  // Zero-CT guard: `usdToCt` floors, so any USD amount that maps to 0 vCLAW (only
  // possible at a future fractional rate — at the A3 ¢-peg CT_PER_USDC=100, even 1
  // cent → 1 vCLAW) would let the buyer pay real USDC for nothing. settle's
  // creditClawTokens rejects a non-positive amount, so the tx rolls back and the
  // row sticks pending while the USDC sits in the merchant wallet. Reject here,
  // BEFORE persisting a row or issuing the payment requirement.
  if (amountCt <= 0) {
    return c.json({ error: 'amount_too_small', code: 'amount_too_small' }, 400);
  }

  // Persist the pending top-up BEFORE returning the quote so /settle can flip an
  // existing row + the quote is auditable. status defaults to 'pending'; the
  // tx_signature + usd_basis stay null until settle. metadata carries the asset +
  // USD cents (no new columns — the live schema convergence rule).
  let topupId: string;
  try {
    const [row] = await db
      .insert(ctTopups)
      .values({
        avatarId: identity.avatarId,
        userId: identity.userId,
        rail: 'x402',
        amountCt,
        status: 'pending',
        metadata: {
          asset,
          usdCents,
          network,
          kind: identity.kind, // 'user' | 'agent' — provenance for the parity audit
        },
      })
      .returning({ id: ctTopups.id });
    topupId = row.id;
  } catch (err) {
    console.error('[ct-topup] pending insert failed:', (err as Error).message);
    return c.json({ error: 'quote_failed', code: 'quote_failed' }, 500);
  }

  // Facilitator gas signer: REQUIRED by real SVM facilitators (PayAI /verify →
  // 400 missing_fee_payer without it) and by the paying client's exact-scheme
  // signer. null (mock/unreachable facilitator) → omitted, as before.
  const feePayer = await resolveFacilitatorFeePayer(network);
  const quote = buildTopupQuote({
    payTo: config.merchantWalletPubkey,
    asset,
    usdCents,
    network,
    resource: {
      url: '/api/ct/topup',
      description: `Buy ${amountCt} vCLAW ($${(usdCents / 100).toFixed(2)} ${asset.toUpperCase()})`,
    },
    feePayer: feePayer ?? undefined,
  });

  // Surface the requirements both as the base64 PAYMENT-REQUIRED header (x402
  // wire convention) AND in the JSON body (so non-x402-aware clients can read
  // them). 402 = "payment required"; the caller pays, then calls /settle.
  c.header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(quote), 'utf8').toString('base64'));
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED');
  return c.json(
    {
      topupId,
      amountCt,
      asset,
      usdCents,
      network,
      accepts: quote.accepts,
      x402Version: quote.x402Version,
    },
    402,
  );
});

// ---------------------------------------------------------------------------
// POST /settle — verify+settle the payment, credit CT EXACTLY ONCE
// ---------------------------------------------------------------------------

const settleSchema = z.object({
  topupId: z.string().uuid(),
  // USDC-ONLY (see quoteSchema): reject `sol` until native-SOL settlement exists.
  asset: z.enum(['usdc']),
  usdCents: z.number().int().positive().max(1_000_000),
});

/** Thrown inside the credit tx when the settling→settled flip matches no row (a
 *  concurrent resume already credited it) → caught outside → idempotent replay.
 *  The facilitator is NEVER re-called on this path. */
class TopupCreditAlreadyDone extends Error {
  constructor() {
    super('ct_topup_credit_already_done');
    this.name = 'TopupCreditAlreadyDone';
  }
}

/** A `settling` row with NO signature older than this is a DEAD claim (its
 *  process died before the facilitator returned) → reconcile, NEVER an auto-retry
 *  of the facilitator. The floor MUST exceed the facilitator settle timeout
 *  (~120s) PLUS margin so a live in-flight settle is never mis-reconciled while
 *  still working — Codex round-2 HIGH: floor 180_000. Default 300_000. */
const TOPUP_SETTLING_STALE_MS_DEFAULT = 5 * 60_000;
const TOPUP_SETTLING_STALE_MS_FLOOR = 180_000;
function resolveTopupSettlingStaleMs(): number {
  const raw = process.env.CT_TOPUP_SETTLING_STALE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= TOPUP_SETTLING_STALE_MS_FLOOR ? n : TOPUP_SETTLING_STALE_MS_DEFAULT;
}

/** A ct-topup settle outcome the route maps straight to a JSON response. Keeps
 *  the durable-machine helpers (dispatch / credit / reconcile) decoupled from the
 *  Hono context. */
type TopupOutcome = {
  httpStatus: 200 | 400 | 402 | 404 | 409 | 500 | 503;
  json: Record<string, unknown>;
};
/** The x402_checkouts row shape ct_topups mirrors for the settle machine. */
type TopupRow = NonNullable<Awaited<ReturnType<typeof db.query.ctTopups.findFirst>>>;

ctTopupRoutes.post('/settle', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');

  // 1) Idempotency-Key header is REQUIRED on settle (terminal money action).
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json({ error: 'idempotency_key_required', code: 'idempotency_key_required' }, 400);
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    return c.json({ error: 'idempotency_key_too_long', code: 'idempotency_key_too_long' }, 400);
  }

  // 2) Payment header (PAYMENT-SIGNATURE preferred, X-PAYMENT fallback — same
  //    order @x402/hono reads). Missing ⇒ 402 (pay first).
  const paymentHeader = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT');
  if (!paymentHeader) {
    return c.json({ error: 'payment_header_required', code: 'payment_required' }, 402);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = settleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }
  const { topupId, asset, usdCents } = parsed.data as {
    topupId: string;
    asset: X402Asset;
    usdCents: number;
  };

  // SERIALIZE per-topupId (FIX-5, payer-loss). Without this, two concurrent
  // settles of the SAME topupId carrying DIFFERENT valid payments could BOTH pass
  // the external verify→settle (each moves USDC on-chain), then race on the
  // pending→settled UPDATE: one credits, the other's UPDATE matches no 'pending'
  // row and 409s with NO CT — the second payer paid real USDC for nothing. The
  // `ct_topups_txsig_unique` index only stops a double-CREDIT of the SAME
  // signature; it does NOT stop two DIFFERENT signatures from both settling
  // externally. The in-process mutex makes the read-pending → verifyAndSettle →
  // credit section atomic per topupId: the second concurrent settle waits, then
  // sees status==='settled' and replays (no second external settle).
  //
  // Single-node scope: this serializes within ONE API process. The
  // `ct_topups_txsig_unique` index remains the cross-process double-CREDIT
  // backstop; cross-process concurrent settles of one topupId with different
  // payments remain a (much narrower, multi-instance-only) residual.
  return withKeyedMutex(`ct-topup-settle:${topupId}`, async () => {
    // 1) Load the row BOUND TO THE CALLER'S avatar — the ONLY replay lookup
    //    (scoped by topupId): an agent/human settles ITS OWN top-up; a foreign
    //    id resolves to no row. A settled/settling/failed/reconcile row
    //    dispatches to terminal/resume handling and NEVER re-settles.
    const row = await db.query.ctTopups.findFirst({
      where: and(eq(ctTopups.id, topupId), eq(ctTopups.avatarId, identity.avatarId)),
    });
    if (!row) {
      return c.json({ error: 'topup_not_found', code: 'topup_not_found' }, 404);
    }
    if (row.status !== 'pending') {
      const o = await dispatchExistingTopup(row, identity.avatarId);
      return c.json(o.json, o.httpStatus);
    }

    // 2) Client-echo validation (ct-topup-specific): reject a tampered/forged
    //    settle whose asset/usdCents disagree with the persisted quote. The
    //    CREDIT amount always comes from the server-side row, never the client.
    const meta = (row.metadata ?? {}) as { asset?: string; usdCents?: number; network?: string };
    const rowUsdCents = typeof meta.usdCents === 'number' ? meta.usdCents : null;
    if (rowUsdCents === null || meta.asset !== asset || rowUsdCents !== usdCents) {
      return c.json({ error: 'quote_mismatch', code: 'quote_mismatch' }, 400);
    }
    const amountCt = usdToCt(rowUsdCents);
    if (amountCt !== row.amountCt) {
      console.error('[ct-topup] amountCt drift', { topupId, amountCt, rowAmountCt: row.amountCt });
      return c.json({ error: 'quote_mismatch', code: 'quote_mismatch' }, 400);
    }

    // 3) On-ramp must be configured BEFORE we claim.
    const config = loadX402Config();
    if (!config.merchantWalletPubkey) {
      return c.json({ error: 'on_ramp_unconfigured', code: 'on_ramp_unconfigured' }, 503);
    }

    // 4) DB-BACKED CLAIM (cross-process): pending → settling. Only the winner of
    //    `WHERE status='pending'` calls the facilitator; every other settle sees
    //    'settling' and never double-calls verify→settle. The claim stakes the
    //    idempotency key — a reuse on a DIFFERENT top-up 23505s to a clean
    //    conflict BEFORE any money moves.
    const settlingId = randomUUID();
    let claimed: { id: string }[];
    try {
      claimed = await db
        .update(ctTopups)
        .set({ status: 'settling', settlingId, settlingStartedAt: new Date(), idempotencyKey })
        .where(and(eq(ctTopups.id, topupId), eq(ctTopups.status, 'pending')))
        .returning({ id: ctTopups.id });
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === '23505') {
        return c.json({ error: 'idempotency_key_conflict', code: 'idempotency_key_conflict' }, 409);
      }
      throw err;
    }
    if (claimed.length === 0) {
      const reread = await db.query.ctTopups.findFirst({
        where: and(eq(ctTopups.id, topupId), eq(ctTopups.avatarId, identity.avatarId)),
      });
      if (!reread) return c.json({ error: 'topup_not_found', code: 'topup_not_found' }, 404);
      const o = await dispatchExistingTopup(reread, identity.avatarId);
      return c.json(o.json, o.httpStatus);
    }

    // 5) Re-derive the EXACT requirements the quote issued — server-side.
    const network = (meta.network === 'mainnet' || meta.network === 'devnet'
      ? meta.network
      : resolveTopupNetwork()) as X402Network;
    const settleFeePayer = await resolveFacilitatorFeePayer(network);
    const quote = buildTopupQuote({
      payTo: config.merchantWalletPubkey,
      asset,
      usdCents: rowUsdCents,
      network,
      feePayer: settleFeePayer ?? undefined,
    });
    const requirements = quote.accepts[0];

    // 6) Verify → (only on valid) settle. MONEY MAY MOVE HERE. Failure
    //    classification is money-state-critical (Codex round-2 BLOCKING): a
    //    SETTLE-phase error is AMBIGUOUS (the /settle call was attempted and
    //    threw — it MAY have landed on-chain) and must NEVER release to pending;
    //    a VERIFY-phase error happened before /settle was ever called (no money).
    const result = await verifyAndSettle({ paymentHeader, requirements });
    if (!result.settled || !result.txSignature) {
      const reason = result.failureReason ?? 'unsettled';
      if (reason === 'facilitator_settle_error') {
        // AMBIGUOUS — money-state UNKNOWN. Reconcile (never pending, never failed).
        console.error(
          `[ct-topup] AMBIGUOUS SETTLE — facilitator /settle threw; money-state unknown; ` +
            `topup=${topupId} → reconcile (no re-settle)`,
        );
        await markTopupReconcile(topupId, settlingId, 'settle_ambiguous', null, result);
        return c.json(
          { error: 'topup_reconciliation', code: 'topup_reconciliation', status: 'reconcile' },
          409,
        );
      }
      if (reason === 'facilitator_verify_error') {
        // Verify-phase transport error — /settle was NEVER called, NO money moved.
        // Release the claim so a retry can re-claim the SAME topup.
        await releaseTopupClaim(topupId, settlingId);
        return c.json({ error: 'payment_not_settled', code: 'payment_not_settled', reason, transient: true }, 402);
      }
      // Definitive rejection — the facilitator reported no settlement, no money
      // moved → terminal failed (checked to our claim).
      await db
        .update(ctTopups)
        .set({ status: 'failed', settlingId: null, settlingStartedAt: null, metadata: { ...meta, failureReason: reason } })
        .where(and(eq(ctTopups.id, topupId), eq(ctTopups.status, 'settling'), eq(ctTopups.settlingId, settlingId)));
      return c.json({ error: 'payment_not_settled', code: 'payment_not_settled', reason, transient: false }, 402);
    }

    // 7) CAPTURE: persist the tx signature IMMEDIATELY in its OWN committed
    //    UPDATE, BEFORE the credit. The money proof is now durable, so a later
    //    credit failure can NEVER lose it and re-settle real USDC on retry. The
    //    tx_signature partial-UNIQUE makes the capture the single exactly-once
    //    claim of this on-chain payment.
    const txSignature = result.txSignature;
    const usdBasis = (rowUsdCents / 100).toFixed(2);
    const captureMeta: Record<string, unknown> = {
      ...meta,
      txSignature,
      asset,
      usdCents: rowUsdCents,
      settlePayer: result.payer ?? undefined,
      settleNetwork: result.network ?? undefined,
    };
    let captured: { id: string }[];
    try {
      captured = await db
        .update(ctTopups)
        .set({ txSignature, usdBasisAtReceipt: usdBasis, metadata: captureMeta })
        .where(
          and(
            eq(ctTopups.id, topupId),
            eq(ctTopups.status, 'settling'),
            eq(ctTopups.settlingId, settlingId),
            isNull(ctTopups.txSignature),
          ),
        )
        .returning({ id: ctTopups.id });
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === '23505') {
        // The settled signature is ALREADY owned by a DIFFERENT top-up: the same
        // on-chain payment maps to another row. NEVER credit this one on that
        // signature — reconcile, recording the spent signature in metadata.
        console.error(
          `[ct-topup] SIGNATURE CONFLICT — settled tx ${txSignature} already owned by another top-up; ` +
            `topup=${topupId} → reconcile (no credit)`,
        );
        await markTopupReconcile(topupId, settlingId, 'signature_conflict', txSignature, result, {
          allowExistingReconcile: true,
        });
        return c.json({ error: 'signature_conflict', code: 'signature_conflict', status: 'reconcile' }, 409);
      }
      console.error(
        `[ct-topup] CAPTURE FAILED AFTER USDC MOVED — signature not yet durable; topup=${topupId} ` +
          `tx=${txSignature} err=${(err as Error).message}`,
      );
      return c.json({ error: 'settle_failed', code: 'settle_failed', transient: true }, 500);
    }
    if (captured.length === 0) {
      const reread = await db.query.ctTopups.findFirst({
        where: and(eq(ctTopups.id, topupId), eq(ctTopups.avatarId, identity.avatarId)),
      });
      if (reread && reread.txSignature === txSignature) {
        const o =
          reread.status === 'settled'
            ? topupReplayOutcome(reread, await currentBalance(identity.avatarId))
            : reread.status === 'settling'
              ? await runTopupCredit(reread, identity.avatarId)
              : {
                  httpStatus: 409 as const,
                  json: { error: 'topup_reconciliation', code: 'topup_reconciliation', status: reread.status },
                };
        return c.json(o.json, o.httpStatus);
      }
      console.error(
        `[ct-topup] CAPTURE MATCHED NO ROW AFTER USDC MOVED — topup=${topupId} tx=${txSignature}; ` +
          `MANUAL reconcile required`,
      );
      await markTopupReconcile(topupId, settlingId, 'capture_lost', txSignature, result, {
        allowExistingReconcile: true,
      });
      return c.json({ error: 'topup_reconciliation', code: 'topup_reconciliation', status: 'reconcile' }, 409);
    }

    // 8) CREDIT (resumable). Re-read the captured row + run the shared credit
    //    (flip settling→settled + creditClawTokens BOUGHT, atomically). The
    //    facilitator is NEVER called again.
    const capturedRow = await db.query.ctTopups.findFirst({ where: eq(ctTopups.id, topupId) });
    if (!capturedRow) {
      return c.json({ error: 'settle_failed', code: 'settle_failed', transient: true }, 500);
    }
    const o = await runTopupCredit(capturedRow, identity.avatarId);
    return c.json(o.json, o.httpStatus);
  }); // end withKeyedMutex(`ct-topup-settle:${topupId}`) — per-topup in-process serialization
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Current CT balance for an avatar (read-only). */
async function currentBalance(avatarId: string): Promise<number> {
  const row = await db.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
    columns: { clawTokens: true },
  });
  return row?.clawTokens ?? 0;
}

/** Dispatch a NON-pending ct_topups row (loaded by topupId+avatar) to its
 *  terminal or RESUME outcome. Never calls the facilitator. */
async function dispatchExistingTopup(row: TopupRow, avatarId: string): Promise<TopupOutcome> {
  switch (row.status) {
    case 'settled':
      return topupReplayOutcome(row, await currentBalance(avatarId));
    case 'failed':
      return { httpStatus: 409, json: { error: 'topup_not_pending', code: 'topup_not_pending', status: 'failed' } };
    case 'reconcile':
      return { httpStatus: 409, json: { error: 'topup_reconciliation', code: 'topup_reconciliation', status: 'reconcile' } };
    case 'settling': {
      if (row.txSignature) {
        // CAPTURED — the money is durable, only the credit is incomplete. RESUME
        // it (never re-call the facilitator).
        return runTopupCredit(row, avatarId);
      }
      const startedAt = row.settlingStartedAt ? new Date(row.settlingStartedAt).getTime() : 0;
      const ageMs = Date.now() - startedAt;
      if (ageMs < resolveTopupSettlingStaleMs()) {
        // A concurrent settle holds a FRESH claim — let the caller retry shortly.
        return { httpStatus: 409, json: { error: 'settle_in_flight', code: 'settle_in_flight' } };
      }
      // STALE claim, no signature: money-state UNKNOWN. Do NOT re-call the
      // facilitator — a chain-check reconciler resolves whether the payment
      // landed. `requireNullSignature` guards a capture racing in right now.
      console.error(
        `[ct-topup] STALE SETTLING CLAIM — topup=${row.id} settling ${Math.round(ageMs / 1000)}s ` +
          `with no signature; money-state UNKNOWN → reconcile (no facilitator re-call)`,
      );
      await markTopupReconcile(row.id, row.settlingId, 'stale_settling', null, null, {
        requireNullSignature: true,
      });
      const after = await db.query.ctTopups.findFirst({
        where: and(eq(ctTopups.id, row.id), eq(ctTopups.avatarId, avatarId)),
      });
      if (after && after.status === 'settling' && after.txSignature) {
        return runTopupCredit(after, avatarId);
      }
      return { httpStatus: 409, json: { error: 'topup_reconciliation', code: 'topup_reconciliation', status: 'reconcile' } };
    }
    default:
      return { httpStatus: 409, json: { error: 'topup_not_pending', code: 'topup_not_pending', status: row.status } };
  }
}

/** Credit a CAPTURED top-up (settling + tx_signature): flip settling→settled +
 *  creditClawTokens BOUGHT, in ONE atomic tx. Resumable + exactly-once — a prior
 *  failed attempt rolled back ENTIRELY, so this credits exactly once; a
 *  concurrent resume that already settled is detected (0-row flip) and replayed.
 *  NEVER calls the facilitator. */
async function runTopupCredit(row: TopupRow, avatarId: string): Promise<TopupOutcome> {
  const topupId = row.id;
  const txSignature = row.txSignature;
  if (!txSignature) {
    console.error(`[ct-topup] runTopupCredit without a signature — topup=${topupId}`);
    return { httpStatus: 500, json: { error: 'settle_failed', code: 'settle_failed', transient: true } };
  }
  const meta = (row.metadata ?? {}) as { asset?: string; usdCents?: number };
  const rowUsdCents = typeof meta.usdCents === 'number' ? meta.usdCents : null;
  // usd_basis for the BOUGHT credit — prefer the persisted receipt column (set at
  // CAPTURE), else re-derive from the row's usdCents. Non-empty for the ledger.
  const usdBasis =
    typeof row.usdBasisAtReceipt === 'string' && row.usdBasisAtReceipt.length > 0
      ? row.usdBasisAtReceipt
      : rowUsdCents !== null
        ? (rowUsdCents / 100).toFixed(2)
        : undefined;

  try {
    const out = await db.transaction(async (tx) => {
      // Flip settling(+sig) → settled FIRST, checked. A concurrent resume that
      // already credited ⇒ 0 rows ⇒ TopupCreditAlreadyDone ⇒ replay (the credit
      // NEVER runs twice).
      const flipped = await tx
        .update(ctTopups)
        .set({ status: 'settled', settlingId: null, settlingStartedAt: null })
        .where(
          and(
            eq(ctTopups.id, topupId),
            eq(ctTopups.status, 'settling'),
            eq(ctTopups.txSignature, txSignature),
          ),
        )
        .returning({ id: ctTopups.id, amountCt: ctTopups.amountCt });
      if (flipped.length === 0) {
        throw new TopupCreditAlreadyDone();
      }

      // Credit vCLAW BOUGHT in the SAME tx — the flip + credit are atomic; any
      // failure rolls BOTH back (the row stays settling+sig, resumable, the
      // signature never lost). TOKENOMICS F2: on-ramp credits are BOUGHT
      // (non-cashable V-Bucks) with usd_basis = the dollars paid.
      const ledger = await creditClawTokens(
        {
          avatarId,
          amount: flipped[0].amountCt,
          reason: 'topup_usdc',
          source: 'x402',
          provenance: 'bought',
          usdBasis,
          metadata: { txSignature, asset: meta.asset, usdCents: rowUsdCents ?? undefined, topupId },
          actorKind: 'system',
        },
        tx,
      );
      return { balanceAfter: ledger.balanceAfter, creditedCt: flipped[0].amountCt };
    });
    return {
      httpStatus: 200,
      json: { ctCredited: out.creditedCt, balance: out.balanceAfter, txSignature },
    };
  } catch (err) {
    if (err instanceof TopupCreditAlreadyDone) {
      const settled = await db.query.ctTopups.findFirst({
        where: and(eq(ctTopups.id, topupId), eq(ctTopups.avatarId, avatarId)),
      });
      if (settled && settled.status === 'settled') {
        return topupReplayOutcome(settled, await currentBalance(avatarId));
      }
      return { httpStatus: 409, json: { error: 'settle_in_flight', code: 'settle_in_flight' } };
    }
    // POST-CAPTURE credit failure. The signature is DURABLE (captured), the row
    // stays settling+sig, so a retry RESUMES this credit and NEVER re-calls the
    // facilitator. Loud; transient.
    console.error(
      `[ct-topup] CREDIT TX FAILED AFTER USDC CAPTURED — row left settling+signature for idempotent ` +
        `resume (no facilitator re-call); topup=${topupId} tx=${txSignature} err=${(err as Error).message}`,
    );
    return { httpStatus: 500, json: { error: 'settle_failed', code: 'settle_failed', transient: true } };
  }
}

/**
 * Resume the existing captured-top-up credit machine after the reconciler has
 * durably moved a verified row to `settling+tx_signature`. Keeping this as a
 * narrow exported adapter avoids re-deriving ledger provenance, usd_basis, or
 * the flip+credit transaction outside the settle machine.
 */
export async function fulfillReconciledTopup(topupId: string): Promise<TopupOutcome> {
  const row = await db.query.ctTopups.findFirst({ where: eq(ctTopups.id, topupId) });
  if (!row || row.status !== 'settling' || !row.txSignature) {
    return {
      httpStatus: 409,
      json: { error: 'settle_in_flight', code: 'settle_in_flight' },
    };
  }
  return runTopupCredit(row, row.avatarId);
}

/** Release a settling claim back to pending (a transient, NO-money-moved
 *  facilitator failure) so a retry can re-claim. Checked to the claim holder. */
async function releaseTopupClaim(topupId: string, settlingId: string): Promise<void> {
  try {
    await db
      .update(ctTopups)
      .set({ status: 'pending', settlingId: null, settlingStartedAt: null, idempotencyKey: null })
      .where(and(eq(ctTopups.id, topupId), eq(ctTopups.status, 'settling'), eq(ctTopups.settlingId, settlingId)));
  } catch (err) {
    console.warn('[ct-topup] releaseTopupClaim failed (non-fatal):', (err as Error).message);
  }
}

/** Move a settling row to the terminal `reconcile` state, recording the spent
 *  signature (if any) for the chain-check reconciler. Codex round-2 HIGH: MERGE
 *  into the row's CURRENT metadata (jsonb `||`) and, in `allowExistingReconcile`
 *  mode, attach to a row a concurrent path already flipped to `reconcile` so the
 *  spent signature is NEVER dropped on the capture-lost interleaving. NEVER writes
 *  the tx_signature COLUMN. A miss is logged LOUD — money is never silently lost. */
async function markTopupReconcile(
  topupId: string,
  settlingId: string | null,
  reason: string,
  spentTxSignature: string | null,
  result: { payer?: string | null; network?: string | null } | null,
  opts: { requireNullSignature?: boolean; allowExistingReconcile?: boolean } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { reconcileReason: reason };
  // Chain-poll anchors for the reconciler (spent signature, or payer + amount +
  // window for the ambiguous/stale cases).
  if (result?.payer) patch.expectedPayer = result.payer;
  if (result?.network) patch.settleNetwork = result.network;
  if (spentTxSignature) patch.spentTxSignature = spentTxSignature;
  const statuses: Array<'settling' | 'reconcile'> = opts.allowExistingReconcile
    ? ['settling', 'reconcile']
    : ['settling'];
  const conds = [eq(ctTopups.id, topupId), inArray(ctTopups.status, statuses)];
  if (settlingId && !opts.allowExistingReconcile) conds.push(eq(ctTopups.settlingId, settlingId));
  if (opts.requireNullSignature) conds.push(isNull(ctTopups.txSignature));
  try {
    const updated = await db
      .update(ctTopups)
      .set({
        status: 'reconcile',
        settlingId: null,
        settlingStartedAt: null,
        metadata: sql`${ctTopups.metadata} || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(and(...conds))
      .returning({ id: ctTopups.id });
    if (updated.length === 0) {
      console.error(
        `[ct-topup] RECONCILE RECORD MISSED — topup=${topupId} reason=${reason} ` +
          `spentTx=${spentTxSignature ?? 'none'} — MANUAL reconciliation required`,
      );
    }
  } catch (err) {
    console.error(
      `[ct-topup] RECONCILE RECORD FAILED — topup=${topupId} reason=${reason} ` +
        `spentTx=${spentTxSignature ?? 'none'}: ${(err as Error).message}`,
    );
  }
}

/** Shape an already-settled row into the idempotent credit-replay outcome. A
 *  settled row ALWAYS carries a signature (DB CHECK); a settled-without-signature
 *  row is corruption and is REFUSED, never replayed as a credit. */
function topupReplayOutcome(row: TopupRow, balance: number): TopupOutcome {
  if (!row.txSignature) {
    console.error(`[ct-topup] settled row ${row.id} has NO tx_signature — refusing replay (corruption)`);
    return { httpStatus: 500, json: { error: 'settle_failed', code: 'settle_failed' } };
  }
  return {
    httpStatus: 200,
    json: { ctCredited: row.amountCt, balance, txSignature: row.txSignature, replay: true },
  };
}

export default ctTopupRoutes;
