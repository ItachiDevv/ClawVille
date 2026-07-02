/**
 * Phase 5.1 — admin identity recovery endpoint (stub).
 *
 * Future support-chat workflow will verify a user's identity against
 * in-game history (avatar name, last-seen building, last token amount)
 * and then hand back the envelope-encrypted identity secret so the
 * user's agent can reconnect on a fresh device.
 *
 * Until that workflow ships, this endpoint is a compiled-but-not-live
 * stub. The FEATURE_GATE comment below matches the format used in
 * `agent-setup.ts` and `x402-config.ts` — a durable contract with the
 * future reviewer about when to light it up.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';

export const adminIdentityRoutes = new Hono<AppContext>();

// FEATURE_GATE: admin_identity_recovery
// Status: endpoint returns 501. Support-chat workflow not launched;
//   identity-verification process not defined; admin approval UI not built.
// Metric to graduate: support.identity_recovery_requests > 5/week
//   (event_type='identity.recovery_requested' on the events table).
// Current reading: 0 (endpoint returns 501 Not Implemented).
// Review deadline: 2026-07-01.
// On deadline: ship if metric met AND support-chat service is live;
//   otherwise defer and keep stub.
adminIdentityRoutes.post(
  '/identity-recover',
  sessionMiddleware,
  adminOnly,
  async (c) => {
    return c.json(
      {
        error: 'not_implemented',
        detail:
          'Admin identity recovery is gated behind the support-chat verification workflow. '
          + 'See FEATURE_GATE: admin_identity_recovery in apps/api/src/routes/admin-identity.ts.',
      },
      501,
    );
  },
);
