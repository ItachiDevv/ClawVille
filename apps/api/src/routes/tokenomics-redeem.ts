// FEATURE_GATE: tokenomics_earned_redemption
// Status: BUILT-GATED — route + service refuse typed `redeem_disabled` unless
//   TOKENOMICS_REDEEM_ENABLED === 'true' (literal; default OFF).
// Metric to graduate (G2): funded adversarial devnet smoke proves EARNED
//   wash/cycling arbitrage is unprofitable with first-funder cluster caps,
//   verification, vesting, claw-back, and the 444-bps exit fee active.
// Legal gate (G3): founder records written clearance covering MSB/money-
//   transmitter treatment plus exit-side KYC and sanctions controls.
// Current reading: G2/G3 not signed off; zero redemptions; route stays dark.
// Review deadline: 2026-08-14.
// On deadline: remain dark or delete; never open on schedule alone.
// Reference: docs/money-rails.md E3 runbook; ARCHITECTURE.md entry (25).
//
// UN-GATE CHECKLIST (all required before any env flip):
// [ ] G2 funded adversarial devnet wash-arb smoke attached and reviewed.
// [ ] G3 founder legal clearance attached (MSB/MT + KYC + sanctions).
// [ ] earned-backing singleton funded; physical solvency audit is green.
// [ ] backing + swap wallet gas floors funded; swap wallet CLV ATA verified.
// [ ] migrations 0030a -> 0030b -> 0031 passed CI migration gate on staging.
// [ ] Fable + Codex real-money adversarial reviews clear every blocker.
// [ ] staging E2E: backing sweep -> CLV buy -> custodial delivery + reconcile.
// [ ] operator rollback is flag OFF; no captured transaction is auto-retried.

/**
 * POST /api/tokenomics/redeem       — request/replay an EARNED redemption.
 * GET  /api/tokenomics/redeem/:id   — owner-scoped durable status.
 *
 * PARITY (Rule E5): human path = Lucia cookie; connected/hosted-agent path =
 * the SAME endpoints with X-Clawville-Agent-Session. Both bind settlement to
 * middleware identity.avatarId. Agent sessions must be ledgerCapable; guests
 * and ownership-unproven sessions are refused. No subject/destination wallet
 * is accepted from the body.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import {
  getEarnedRedemption,
  isTokenomicsRedeemEnabled,
  RedeemDisabledError,
  requestEarnedRedemption,
  resolveMinRedemptionVclaw,
  type RedemptionErrorCode,
  type RedemptionSubject,
} from '../services/earned-redemption';

export const tokenomicsRedeemRoutes = new Hono<ActivityAuthContext>();

// Gate FIRST: while dark, every route is a deterministic typed 503 and does no
// auth/DB/custody work. The service repeats the gate for direct callers.
tokenomicsRedeemRoutes.use('*', async (c, next) => {
  if (!isTokenomicsRedeemEnabled()) {
    return c.json({ ok: false, error: 'redeem_disabled', code: 'redeem_disabled' }, 503);
  }
  await next();
});
tokenomicsRedeemRoutes.use('*', sessionMiddleware);

const bodySchema = z.object({ amountVclaw: z.number().int().positive() }).strict();
const idemSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/);

function subjectFromIdentity(identity: ActivityIdentity):
  | { subject: RedemptionSubject }
  | { error: 'agent_session_not_ledger_authorized' } {
  if (identity.kind === 'agent' && identity.ledgerCapable !== true) {
    return { error: 'agent_session_not_ledger_authorized' };
  }
  return {
    subject: {
      kind: identity.kind === 'agent' ? 'agent' : 'user',
      avatarId: identity.avatarId,
      userId: identity.userId,
      agentId: identity.agentId,
    },
  };
}

function errorStatus(code: RedemptionErrorCode): 400 | 404 | 409 | 500 | 503 {
  switch (code) {
    case 'redeem_disabled':
    case 'funding_pending':
    case 'buy_pending':
    case 'delivery_pending':
      return 503;
    case 'amount_below_min':
    case 'amount_above_max':
      return 400;
    case 'redemption_not_found':
      return 404;
    case 'idempotency_conflict':
    case 'insufficient_redeemable_earned':
    case 'backing_wallet_missing':
    case 'backing_wallet_mixed':
    case 'reconcile':
      return 409;
    case 'internal':
    default:
      return 500;
  }
}

tokenomicsRedeemRoutes.post(
  '/',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    const resolved = subjectFromIdentity(c.get('identity'));
    if ('error' in resolved) {
      return c.json({ ok: false, error: resolved.error, code: resolved.error }, 403);
    }
    const idem = idemSchema.safeParse(c.req.header('Idempotency-Key'));
    if (!idem.success) {
      return c.json(
        {
          ok: false,
          error: 'idempotency_key_required',
          code: 'idempotency_key_required',
          message: 'Idempotency-Key must be 8-64 safe characters.',
        },
        400,
      );
    }
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'invalid_request', code: 'invalid_request' }, 400);
    }
    let result: Awaited<ReturnType<typeof requestEarnedRedemption>>;
    try {
      result = await requestEarnedRedemption({
        subject: resolved.subject,
        amountVclaw: parsed.data.amountVclaw,
        idempotencyKey: idem.data,
      });
    } catch (err) {
      if (err instanceof RedeemDisabledError) {
        return c.json({ ok: false, error: 'redeem_disabled', code: 'redeem_disabled' }, 503);
      }
      throw err;
    }
    if (!result.ok) {
      return c.json(
        {
          ok: false,
          error: result.code,
          code: result.code,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.redemption ? { redemption: result.redemption } : {}),
          minRedemptionVclaw: resolveMinRedemptionVclaw(),
        },
        errorStatus(result.code),
      );
    }
    return c.json({ ok: true, redemption: result.redemption, replay: result.replay }, 200);
  },
);

tokenomicsRedeemRoutes.get(
  '/:id',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  noStorePrivate,
  async (c) => {
    const resolved = subjectFromIdentity(c.get('identity'));
    if ('error' in resolved) {
      return c.json({ ok: false, error: resolved.error, code: resolved.error }, 403);
    }
    const id = z.string().uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ ok: false, error: 'invalid_id', code: 'invalid_id' }, 400);
    let redemption: Awaited<ReturnType<typeof getEarnedRedemption>>;
    try {
      redemption = await getEarnedRedemption(id.data, resolved.subject);
    } catch (err) {
      if (err instanceof RedeemDisabledError) {
        return c.json({ ok: false, error: 'redeem_disabled', code: 'redeem_disabled' }, 503);
      }
      throw err;
    }
    if (!redemption) {
      // Owner-scoped 404: never disclose another subject's redemption id.
      return c.json({ ok: false, error: 'redemption_not_found', code: 'redemption_not_found' }, 404);
    }
    return c.json({ ok: true, redemption }, 200);
  },
);

export default tokenomicsRedeemRoutes;
