/**
 * General resident-to-resident USDC payment surface.
 *
 * Rule E5 parity: a Lucia human and a connected/hosted agent call the same
 * endpoint and both bind the sender to `identity.avatarId`. The recipient is a
 * public avatar/agent identifier resolved by the service; no wallet address or
 * sender id is accepted from the request body.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import {
  payAgent,
  resolveAgentPayMaxUsdCents,
  type AgentPayErrorCode,
} from '../services/agent-pay';

const idempotencyKeySchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/);

const agentPayBodySchema = z
  .object({
    recipient: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('avatar'), avatarId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal('agent'), agentId: z.string().trim().min(1).max(160) }).strict(),
    ]),
    usdCents: z.number().int().min(1),
  })
  .strict();

function failureStatus(code: AgentPayErrorCode): 400 | 403 | 404 | 409 | 500 | 502 | 503 {
  switch (code) {
    case 'invalid_request':
    case 'amount_below_min':
    case 'amount_above_max':
    case 'insufficient_usdc':
      return 400;
    case 'recipient_not_found':
    case 'sender_wallet_missing':
    case 'recipient_wallet_missing':
      return 404;
    case 'recipient_not_eligible':
      return 403;
    case 'self_pay_forbidden':
    case 'idempotency_conflict':
    case 'payment_in_flight':
    case 'payment_reconcile':
    case 'fulfillment_pending':
      return 409;
    case 'payment_failed':
      return 502;
    case 'payai_unavailable':
      return 503;
    case 'internal':
    default:
      return 500;
  }
}

export const agentPayRoutes = new Hono<ActivityAuthContext>();
agentPayRoutes.use('*', sessionMiddleware);

agentPayRoutes.post(
  '/',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');

    // `requireAuthOrAgentSession` proves liveness/binding but intentionally does
    // not grant custody authority. Real-money agent routes must fail closed on
    // a perception-only/unproven session before any wallet lookup or decrypt.
    if (identity.kind === 'agent' && identity.ledgerCapable !== true) {
      return c.json(
        {
          ok: false,
          error: 'agent_session_not_ledger_authorized',
          code: 'agent_session_not_ledger_authorized',
        },
        403,
      );
    }

    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header('Idempotency-Key'),
    );
    if (!idempotencyKey.success) {
      return c.json(
        {
          ok: false,
          error: 'idempotency_key_required',
          code: 'idempotency_key_required',
          message: 'Idempotency-Key must be 1-64 letters, digits, dots, underscores, colons, or hyphens.',
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = agentPayBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: 'invalid_request',
          code: 'invalid_request',
          message: 'Provide usdCents and one recipient {kind, avatarId|agentId}.',
        },
        400,
      );
    }

    const maxUsdCents = resolveAgentPayMaxUsdCents();
    if (parsed.data.usdCents > maxUsdCents) {
      return c.json(
        {
          ok: false,
          error: 'amount_above_max',
          code: 'amount_above_max',
          maxUsdCents,
        },
        400,
      );
    }

    try {
      const result = await payAgent({
        senderAvatarId: identity.avatarId,
        recipient: parsed.data.recipient,
        usdCents: parsed.data.usdCents,
        idempotencyKey: idempotencyKey.data,
      });

      if (result.ok) return c.json(result, 200);

      return c.json(
        {
          ...result,
          error: result.code,
        },
        failureStatus(result.code),
      );
    } catch {
      // Never serialize or log a custody/facilitator error object: nested causes
      // can contain signed payload details. The service normally returns a
      // typed failure; this is the last-resort route boundary.
      console.error('[agent-pay] unhandled payment service failure');
      return c.json({ ok: false, error: 'internal', code: 'internal' }, 500);
    }
  },
);
