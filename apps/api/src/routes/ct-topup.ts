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
 * THE MONEY PATH. x402/PayAI (USDC/SOL) is the real-money boundary; this route
 * converts a SETTLED on-chain payment into internal ClawTokens via the audited
 * `claw-token-ledger`. ClawTokens are never written directly.
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
import { db, ctTopups, avatars, and, eq } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { loadX402Config } from '../services/x402-config';
import {
  buildTopupQuote,
  verifyAndSettle,
  usdToCt,
  type X402Asset,
  type X402Network,
} from '../services/x402-payai';
import { creditClawTokens } from '../services/claw-token-ledger';

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
 *  on-ramp to devnet when X402_TOPUP_NETWORK is unset. */
function resolveTopupNetwork(): X402Network {
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
  asset: z.enum(['usdc', 'sol']),
  // Positive integer cents. Upper bound caps a single top-up (defends against an
  // overflow / absurd quote); 1_000_000 cents = $10,000.
  usdCents: z.number().int().positive().max(1_000_000),
});

ctTopupRoutes.post('/quote', requireAuthOrAgentSession, async (c) => {
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

  const quote = buildTopupQuote({
    payTo: config.merchantWalletPubkey,
    asset,
    usdCents,
    network,
    resource: {
      url: '/api/ct/topup',
      description: `Buy ${amountCt} ClawTokens ($${(usdCents / 100).toFixed(2)} ${asset.toUpperCase()})`,
    },
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
  asset: z.enum(['usdc', 'sol']),
  usdCents: z.number().int().positive().max(1_000_000),
});

/** Raised inside the settle tx when the tx_signature OR idempotency unique index
 *  trips (23505). Caught OUTSIDE the (now-aborted) tx to replay the already-
 *  credited row — a clean idempotent replay, never a 500 / double-credit. */
class TopupReplay extends Error {
  constructor(public readonly kind: 'txsig' | 'idem') {
    super(`ct_topup_replay:${kind}`);
    this.name = 'TopupReplay';
  }
}

ctTopupRoutes.post('/settle', requireAuthOrAgentSession, async (c) => {
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

  // 3) FAST idempotency replay — BEFORE touching the facilitator. If THIS
  //    (avatarId, idempotencyKey) already settled, return the cached credit and
  //    never re-verify/re-settle. (The DB unique index is still the race-safe
  //    backstop inside the tx; this is the cheap common-case short-circuit.)
  const priorByKey = await db.query.ctTopups.findFirst({
    where: and(
      eq(ctTopups.avatarId, identity.avatarId),
      eq(ctTopups.idempotencyKey, idempotencyKey),
    ),
  });
  if (priorByKey && priorByKey.status === 'settled') {
    const bal = await currentBalance(identity.avatarId);
    return c.json({
      ctCredited: priorByKey.amountCt,
      balance: bal,
      txSignature: priorByKey.txSignature,
      replay: true,
    });
  }

  // 4) Load the pending row this settle targets. Bound to the CALLER'S avatar
  //    (identity.avatarId) so an agent/human can only settle ITS OWN top-up —
  //    a foreign topupId resolves to no row. We re-derive the credit amount from
  //    the SERVER-side row + the quote rate, never trusting the client's usdCents
  //    for the credit (we only sanity-check the client echo against the row).
  const pending = await db.query.ctTopups.findFirst({
    where: and(eq(ctTopups.id, topupId), eq(ctTopups.avatarId, identity.avatarId)),
  });
  if (!pending) {
    return c.json({ error: 'topup_not_found', code: 'topup_not_found' }, 404);
  }

  // Already-settled row (re-settle of a finished top-up) → idempotent replay of
  // the stored outcome. This covers a settle retry that reuses the topupId but a
  // NEW idempotency key after the first settle already finished.
  if (pending.status === 'settled') {
    const bal = await currentBalance(identity.avatarId);
    return c.json({
      ctCredited: pending.amountCt,
      balance: bal,
      txSignature: pending.txSignature,
      replay: true,
    });
  }
  // A 'failed' row is terminal — do not let it be re-settled / poisoned.
  if (pending.status !== 'pending') {
    return c.json({ error: 'topup_not_pending', code: 'topup_not_pending', status: pending.status }, 409);
  }

  // The amount to credit is the row's stored amountCt (set at quote time from the
  // row's usdCents). Re-derive from usdCents-on-the-row to be safe, and reject if
  // the client's echoed usdCents/asset disagree with the persisted quote — a
  // mismatch means a tampered/forged settle that must not credit the quoted CT.
  const meta = (pending.metadata ?? {}) as { asset?: string; usdCents?: number; network?: string };
  const rowUsdCents = typeof meta.usdCents === 'number' ? meta.usdCents : null;
  if (rowUsdCents === null || meta.asset !== asset || rowUsdCents !== usdCents) {
    return c.json({ error: 'quote_mismatch', code: 'quote_mismatch' }, 400);
  }
  const amountCt = usdToCt(rowUsdCents);
  // Internal consistency guard — the row's amountCt was computed from the SAME
  // rate at quote time; a divergence means a corrupted/edited row. Refuse.
  if (amountCt !== pending.amountCt) {
    console.error('[ct-topup] amountCt drift', { topupId, amountCt, rowAmountCt: pending.amountCt });
    return c.json({ error: 'quote_mismatch', code: 'quote_mismatch' }, 400);
  }

  // 5) Re-derive the EXACT requirements the quote issued — server-side, NOT from
  //    the client's payload `accepted` echo. The facilitator verify binds the
  //    payment to THESE (payTo / amount / network / asset); a forged or
  //    underpaid payment fails verify and never credits.
  const config = loadX402Config();
  if (!config.merchantWalletPubkey) {
    return c.json({ error: 'on_ramp_unconfigured', code: 'on_ramp_unconfigured' }, 503);
  }
  const network = (meta.network === 'mainnet' || meta.network === 'devnet'
    ? meta.network
    : resolveTopupNetwork()) as X402Network;
  const quote = buildTopupQuote({
    payTo: config.merchantWalletPubkey,
    asset,
    usdCents: rowUsdCents,
    network,
  });
  const requirements = quote.accepts[0];

  // 6) Verify → (only on valid) settle through the facilitator. NEVER throws;
  //    returns settled:false on any verify/settle failure → a clean 402, NEVER a
  //    5xx, and NEVER a credit.
  const result = await verifyAndSettle({ paymentHeader, requirements });
  if (!result.settled || !result.txSignature) {
    // Distinguish a DEFINITIVE rejection (the payment is invalid / settlement was
    // refused on-chain) from a TRANSIENT facilitator/network hiccup. A transient
    // failure must leave the row PENDING so the caller can retry the SAME topupId
    // once the facilitator recovers; only a definitive rejection poisons the row
    // to 'failed' (so a known-bad payment can't be re-attempted into a half state
    // and /dash can see real failed attempts).
    const reason = result.failureReason ?? 'unsettled';
    const transient = reason === 'facilitator_verify_error' || reason === 'facilitator_settle_error';
    if (!transient) {
      try {
        await db
          .update(ctTopups)
          .set({ status: 'failed', metadata: { ...meta, failureReason: reason } })
          .where(and(eq(ctTopups.id, topupId), eq(ctTopups.status, 'pending')));
      } catch (err) {
        console.warn('[ct-topup] mark-failed write failed (non-fatal):', (err as Error).message);
      }
    }
    return c.json(
      { error: 'payment_not_settled', code: 'payment_not_settled', reason, transient },
      402,
    );
  }

  const txSignature = result.txSignature;

  // 7) ATOMIC settle: flip the pending row → settled (claiming the tx_signature)
  //    + credit CT, in ONE transaction. The tx_signature UNIQUE index is the
  //    double-credit hard guard; a concurrent/duplicate settle of the SAME
  //    signature trips 23505, the tx (credit included) rolls back, and we replay
  //    the already-credited row OUTSIDE the aborted tx.
  let balanceAfter: number;
  let creditedCt: number;
  let settledTxSig: string;
  try {
    const out = await db.transaction(async (tx) => {
      // Re-read the row UNDER no lock is unnecessary — the UPDATE's WHERE
      // status='pending' is the optimistic guard, and the unique indexes are the
      // race-safe backstops. Flip pending→settled, claim the signature + idem key.
      let updated:
        | { id: string; amountCt: number }[]
        | undefined;
      try {
        updated = await tx
          .update(ctTopups)
          .set({
            status: 'settled',
            txSignature,
            usdBasisAtReceipt: (rowUsdCents / 100).toFixed(2),
            idempotencyKey,
            metadata: {
              ...meta,
              txSignature,
              asset,
              usdCents: rowUsdCents,
              settlePayer: result.payer ?? undefined,
              settleNetwork: result.network ?? undefined,
            },
          })
          .where(and(eq(ctTopups.id, topupId), eq(ctTopups.status, 'pending')))
          .returning({ id: ctTopups.id, amountCt: ctTopups.amountCt });
      } catch (err) {
        const pgCode = (err as { code?: string } | undefined)?.code;
        if (pgCode === '23505') {
          // Which unique index? The constraint name tells us, but either way the
          // outcome is the same: already credited → replay. Default to txsig.
          const constraint = (err as { constraint?: string } | undefined)?.constraint ?? '';
          throw new TopupReplay(constraint.includes('idem') ? 'idem' : 'txsig');
        }
        throw err;
      }

      if (!updated || updated.length === 0) {
        // The WHERE status='pending' matched nothing — a concurrent settle won
        // the row first. Signal a replay; the post-tx handler re-reads the now-
        // settled row and returns its cached credit.
        throw new TopupReplay('txsig');
      }

      // Credit CT in the SAME tx — credit + row-flip are atomic. Passing `tx`
      // composes into this transaction, so a later failure rolls BOTH back.
      const ledger = await creditClawTokens(
        {
          avatarId: identity.avatarId,
          amount: updated[0].amountCt,
          reason: 'topup_usdc',
          source: 'x402',
          metadata: { txSignature, asset, usdCents: rowUsdCents, topupId },
        },
        tx,
      );

      return { balanceAfter: ledger.balanceAfter, creditedCt: updated[0].amountCt };
    });
    balanceAfter = out.balanceAfter;
    creditedCt = out.creditedCt;
    settledTxSig = txSignature;
  } catch (err) {
    if (err instanceof TopupReplay) {
      // The settle tx rolled back on a unique-index collision (already credited
      // by a prior/concurrent settle). Re-read the colliding settled row OUTSIDE
      // the aborted tx and replay its cached credit — never double-credit.
      const replayed = await findSettledForReplay({
        avatarId: identity.avatarId,
        txSignature,
        idempotencyKey,
        kind: err.kind,
      });
      if (replayed && replayed.status === 'settled') {
        const bal = await currentBalance(identity.avatarId);
        return c.json({
          ctCredited: replayed.amountCt,
          balance: bal,
          txSignature: replayed.txSignature,
          replay: true,
        });
      }
      // Collision but no settled row found (extremely unlikely) — 409 rather than
      // a misleading replay or a double-credit.
      return c.json({ error: 'settle_in_flight', code: 'settle_in_flight' }, 409);
    }
    console.error('[ct-topup] settle transaction failed:', (err as Error).message);
    return c.json({ error: 'settle_failed', code: 'settle_failed' }, 500);
  }

  return c.json({
    ctCredited: creditedCt,
    balance: balanceAfter,
    txSignature: settledTxSig,
  });
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

/** Re-read the already-settled row a collision replays. Prefer the row carrying
 *  THIS tx signature (the double-credit guard); fall back to the idem-key row. */
async function findSettledForReplay(input: {
  avatarId: string;
  txSignature: string;
  idempotencyKey: string;
  kind: 'txsig' | 'idem';
}) {
  if (input.kind === 'idem') {
    return db.query.ctTopups.findFirst({
      where: and(
        eq(ctTopups.avatarId, input.avatarId),
        eq(ctTopups.idempotencyKey, input.idempotencyKey),
      ),
    });
  }
  // tx_signature is globally unique (partial index) — match on it directly.
  return db.query.ctTopups.findFirst({
    where: eq(ctTopups.txSignature, input.txSignature),
  });
}

export default ctTopupRoutes;
