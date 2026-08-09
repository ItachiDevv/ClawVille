/**
 * Seabed salvage REST surface (`/api/land/salvage`) — Land gamification P7b.
 *
 * RULE E5 PARITY. Every route here runs the full three-stage chain
 * `requireAuthOrAgentSession -> requireLedgerCapableIdentity ->
 * requireNonGuestIdentity`, so a connected agent claims AS ITSELF against its
 * bound avatar with REAL material settlement, exactly as a human does. There is
 * no guest fallback and no demotion: an unbound or ownership-unproven agent is
 * REFUSED, never quietly downgraded to a demo claim. The user-hosted
 * (autonomous) path reaches the same settlement service through the
 * `salvage_node` executor verb, so all three subject paths are one
 * implementation.
 *
 * PARITY: human path: POST /api/land/salvage/:nodeId/claim (Lucia session);
 * agent path (connected): the same route with `X-Clawville-Agent-Session`;
 * agent path (hosted): `[ACTION: salvage_node(nodeId)]`; settlement binds to
 * `identity.avatarId` / the executor's re-resolved bound avatar in all three.
 *
 * THE APPROACH GATE IS REQUIRED ON THIS SURFACE. A claim carries an
 * `approachToken` earned from `POST /:nodeId/approach` after dwelling in range.
 * The hosted executor path does NOT use a token — it reads the agent's
 * server-owned simulation body position directly, which is a STRONGER proximity
 * check than a client-reported one, not a weaker one. Both paths enforce
 * proximity; neither can be used to bypass the other.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  SALVAGE_APPROACH_RANGE_WU,
  SALVAGE_AVATAR_DAILY_CLAIM_CAP,
  SALVAGE_LAYOUT_VERSION,
  SALVAGE_NODE_COOLDOWN_MS,
  SALVAGE_OWNER_DAILY_CLAIM_CAP,
  isSalvageNodeId,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  resolveAgentSession,
} from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { logEventFromContext } from '../services/event-logger';
import {
  readSalvageState,
  settleSalvageClaim,
  type SalvageRefusalCode,
} from '../services/salvage-settlement';
import {
  issueApproachToken,
  verifyApproachToken,
} from '../services/salvage-approach';

export const landSalvageRoutes = new Hono<ActivityAuthContext>();
landSalvageRoutes.use('*', sessionMiddleware);

// The approach probe is the chattiest surface here (a client polls it while
// walking in), so it gets its own allowance. Claims are bounded by the daily
// caps anyway; this limit only stops a client from hammering the settlement
// transaction.
const approachLimiter = createRateLimiter({ maxPerWindow: 120, windowMs: 60_000 });
const claimLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });

const nodeIdSchema = z.string().min(1).max(64);

const approachBodySchema = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
});

const claimBodySchema = z.object({
  approachToken: z.string().min(1).max(256),
  /**
   * REQUIRED. Durable replay protection lives in `salvage_claim_receipts`, and
   * a client that omits a key would get a second real claim on every retry.
   */
  idempotencyKey: z.string().min(8).max(64),
});

/**
 * Refusal -> HTTP. Cap refusals are 429 (retry tomorrow), cooldown is 429
 * (retry later), binding/eligibility failures are 403, and the two idempotency
 * outcomes are 409. Nothing here is a 500: every code below is a decision the
 * server made deliberately.
 */
function refusalStatus(code: SalvageRefusalCode): 400 | 403 | 409 | 429 {
  switch (code) {
    case 'node_unknown':
      return 400;
    case 'house_excluded':
    case 'owner_unresolved':
    case 'binding_drift':
      return 403;
    case 'idempotency_key_conflict':
    case 'concurrent_retry':
      return 409;
    case 'owner_daily_cap':
    case 'avatar_daily_cap':
    case 'node_on_cooldown':
      return 429;
  }
}

// ---------------------------------------------------------------------------
// GET /state — one closed-field payload for the HUD and for hosted perception
// ---------------------------------------------------------------------------
landSalvageRoutes.get(
  '/state',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  noStorePrivate,
  async (c) => {
    const identity = c.get('identity');
    const state = await readSalvageState({
      avatarId: identity.avatarId,
      userId: identity.userId,
    });
    return c.json({
      ...state,
      // Rules the client renders rather than re-deriving, so the HUD can never
      // advertise a cap or cooldown the server does not enforce.
      rules: {
        approachRangeWu: SALVAGE_APPROACH_RANGE_WU,
        cooldownMs: SALVAGE_NODE_COOLDOWN_MS,
        avatarDailyClaimCap: SALVAGE_AVATAR_DAILY_CLAIM_CAP,
        ownerDailyClaimCap: SALVAGE_OWNER_DAILY_CLAIM_CAP,
        layoutVersion: SALVAGE_LAYOUT_VERSION,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// POST /:nodeId/approach — advance the anchor, issue a token after dwell
// ---------------------------------------------------------------------------
landSalvageRoutes.post(
  '/:nodeId/approach',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    if (!approachLimiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const identity = c.get('identity');
    const nodeId = nodeIdSchema.safeParse(c.req.param('nodeId'));
    if (!nodeId.success || !isSalvageNodeId(nodeId.data)) {
      return c.json({ ok: false, error: 'node_unknown' }, 400);
    }

    const PARSE_FAILED = Symbol('parse_failed');
    const raw: unknown = await c.req.json().catch(() => PARSE_FAILED);
    if (raw === PARSE_FAILED) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const body = approachBodySchema.safeParse(raw);
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    // The anchor is keyed on the AVATAR, not the session: reconnecting an agent
    // or re-logging a human must not reset the movement history and hand out a
    // free teleport.
    const verdict = issueApproachToken({
      subject: identity.avatarId,
      nodeId: nodeId.data,
      x: body.data.x,
      z: body.data.z,
    });

    if (!verdict.ok) {
      return c.json(
        { ok: false, error: verdict.code, retryAfterMs: verdict.retryAfterMs ?? null },
        // Every approach refusal is a "not yet", never a permanent failure, so
        // 429 is the honest status for all of them.
        verdict.code === 'node_unknown' ? 400 : 429,
      );
    }
    return c.json({ ok: true, approachToken: verdict.token, expiresAt: verdict.expiresAt });
  },
);

// ---------------------------------------------------------------------------
// POST /:nodeId/claim — the money path
// ---------------------------------------------------------------------------
landSalvageRoutes.post(
  '/:nodeId/claim',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    if (!claimLimiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const identity = c.get('identity');
    const nodeIdParsed = nodeIdSchema.safeParse(c.req.param('nodeId'));
    if (!nodeIdParsed.success || !isSalvageNodeId(nodeIdParsed.data)) {
      return c.json({ ok: false, error: 'node_unknown' }, 400);
    }
    const nodeId = nodeIdParsed.data;

    const PARSE_FAILED = Symbol('parse_failed');
    const raw: unknown = await c.req.json().catch(() => PARSE_FAILED);
    if (raw === PARSE_FAILED) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const bodyParsed = claimBodySchema.safeParse(raw);
    if (!bodyParsed.success) {
      const missingKey = bodyParsed.error.issues.some(
        (issue) => issue.path.length === 1 && issue.path[0] === 'idempotencyKey',
      );
      return c.json(
        { ok: false, error: missingKey ? 'idempotency_key_required' : 'invalid_body' },
        400,
      );
    }
    const body = bodyParsed.data;

    // Approach gate BEFORE any lock or settlement work. A token is bound to the
    // avatar AND the node, so it cannot be earned at a near node and spent at a
    // far one, nor borrowed from another player.
    const approach = verifyApproachToken({
      token: body.approachToken,
      subject: identity.avatarId,
      nodeId,
    });
    if (!approach.ok) {
      return c.json({ ok: false, error: approach.code }, 403);
    }

    const outcome = await settleSalvageClaim({
      actor: {
        kind: identity.kind,
        userId: identity.userId,
        avatarId: identity.avatarId,
        agentId: identity.kind === 'agent' ? identity.agentId : null,
        sessionId: identity.kind === 'agent' ? identity.sessionId : null,
      },
      bindings: {
        expectedAvatarId: identity.avatarId,
        expectedUserId: identity.userId,
        expectedAgentId: identity.kind === 'agent' ? identity.agentId : null,
      },
      nodeId,
      idempotencyKey: body.idempotencyKey,
      // A Lucia human has no bearer that can rotate mid-request, so only the
      // agent path re-resolves. Passing the resolver unconditionally would
      // charge every human claim a pointless session lookup under two locks.
      revalidateBinding:
        identity.kind === 'agent'
          ? () => resolveAgentSession(identity.sessionId)
          : undefined,
    });

    if (outcome.kind === 'refused') {
      return c.json(
        {
          ok: false,
          error: outcome.code,
          nextClaimAt: outcome.nextClaimAt ?? null,
        },
        refusalStatus(outcome.code),
      );
    }

    if (outcome.kind === 'settled') {
      // Fire-and-forget. `logEventFromContext` persists the anti-farm fp_hash +
      // ip_prefix_hash; it is explicitly NOT part of claim acceptance, so a
      // dropped event never un-settles a committed claim.
      void logEventFromContext(c, {
        eventType: 'land.salvage.claimed',
        userId: identity.userId,
        avatarId: identity.avatarId,
        payload: {
          nodeId,
          layoutVersion: outcome.payload.layoutVersion,
          materialsGranted: outcome.payload.materialsGranted,
          flavour: outcome.payload.flavour,
          subjectKind: identity.kind,
          surface: 'rest',
        },
      });
    }

    return c.json({
      ok: true,
      replay: outcome.kind === 'replay',
      ...outcome.payload,
    });
  },
);
