/**
 * Quest-board restore read (2026-07-29) — routing-integrity tests.
 *
 * GET /api/quests/tutorial/claims is the read-back the client uses to restore
 * its tutorial-ladder completion display after the auth-transition identity
 * sweep wipes localStorage (session expiry / account switch). Following the
 * quests-agent-parity precedent, the authed read path itself is not
 * re-harnessed here; what this file locks in is the routing contract that
 * resolves BEFORE any database touch:
 *
 *   1. The route exists and rejects zero-auth-material requests with 401. As
 *      of P6 (2026-08-09) it accepts EITHER a Lucia cookie or an agent-session
 *      bearer, same as the claim write — never public, never guest.
 *   2. It is matched as its own route — the 401 (not a 404, not the public
 *      GET /:id quest lookup's shape) proves `/tutorial/claims` is not
 *      captured by a param route.
 */

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { questRoutes } from '../quests';

const app = new Hono();
app.route('/api/quests', questRoutes);

describe('GET /api/quests/tutorial/claims — quest-board restore read', () => {
  it('rejects zero-auth requests with 401 (authed surface, no public fallback)', async () => {
    const res = await app.request('/api/quests/tutorial/claims');
    expect(res.status).toBe(401);
    // Both credentials are first-class here since P6.
    expect(await res.text()).toContain('X-Clawville-Agent-Session');
  });

  it('is not shadowed by the public GET /:id quest lookup', async () => {
    const res = await app.request('/api/quests/tutorial/claims');
    // The public /:id handler would 404-or-500 through the DB path — a 401
    // here can only come from the auth chain on the dedicated route.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
