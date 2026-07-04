import { Hono } from 'hono';
import { z } from 'zod';
import { npcSimulation } from '../services/npc-simulation';
import { db, openclawBots, eq } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext, AuthenticatedContext } from '../types';

const clawRoutes = new Hono<AppContext>();

// FEATURE_GATE: browser_claws
// Status: DEAD client feature (agent-metaverse model doc §7 B3) — the
//   /connect + /heartbeat endpoints below register "browser claws" into the
//   npc-simulation broadcast, but `browserClaws` has ZERO renderers/callers
//   in apps/web (verified 2026-07-04; live snapshot count 0). They are
//   unauthenticated writes into unbounded in-memory state, kept alive only
//   by this file. P2 Slice D adds the rate limiters below as the interim
//   cost cap; delete-vs-keep is decided in its own audited diff per B3.
// Metric to graduate: >0 legitimate claw connects/week from a real client
//   surface (grep npc-simulation browser-claw snapshot on /dash or logs).
// Current reading: 0 (no client caller exists in apps/web).
// Review deadline: 2026-08-15
// On deadline: delete POST /api/claws/connect|disconnect|heartbeat + the
//   npcSimulation browser-claw surface (registerBrowserClaw /
//   updateBrowserClawPosition / getBrowserClaw) in an audited diff.
// Reference: docs/agent-metaverse-p2-plan.md Slice D + docs/agent-metaverse-model.md §7 B3

// P2 Slice D (2026-07-04) — unauth cost holes: /connect (unbounded in-memory
// registration) and /heartbeat (unauth in-memory writes) get 10/min/IP.
// Separate buckets per route (rate-limit.ts guidance) so a burst against one
// doesn't eat the other's budget. Additive only — behavior unchanged below
// the limiter. NOTE: 10/min deliberately breaks any long-lived live claw
// (heartbeats would exceed it) — acceptable because the feature is DEAD (B3,
// see the FEATURE_GATE above); this is a cost cap, not a serving budget.
const clawConnectRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});
const clawHeartbeatRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

const clawConfigSchema = z.object({
  name: z.string().min(1).max(100),
  species: z.enum(['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle']),
  color: z.enum(['green', 'red', 'blue', 'yellow']),
  personality: z
    .object({
      tone: z.string().max(50).optional(),
      interests: z.array(z.string().max(100)).max(10).optional(),
      greeting: z.string().max(200).optional(),
    })
    .optional(),
  researchConfig: z
    .object({
      themes: z.record(z.object({ label: z.string(), focus: z.string() })).optional(),
      globalFocus: z.string().max(200).optional(),
      articleSources: z.array(z.string().url()).max(50).optional(),
    })
    .optional(),
  knowledge: z.array(z.string()).optional(),
});

// POST /api/claws/connect — Register a browser claw in the world (no auth required)
clawRoutes.post('/connect', sessionMiddleware, async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!clawConnectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many claw connections. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json();
  const parsed = clawConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid claw config', details: parsed.error.flatten() }, 400);
  }

  const sessionId = `claw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  npcSimulation.registerBrowserClaw(sessionId, parsed.data);

  return c.json({ sessionId, name: parsed.data.name });
});

// POST /api/claws/disconnect — Remove a browser claw from the world
clawRoutes.post('/disconnect', sessionMiddleware, async (c) => {
  const { sessionId } = await c.req.json();
  if (!sessionId || typeof sessionId !== 'string') {
    return c.json({ error: 'sessionId required' }, 400);
  }

  const removed = npcSimulation.unregisterBrowserClaw(sessionId);
  return c.json({ success: removed });
});

// POST /api/claws/heartbeat — Update position and keep alive
clawRoutes.post('/heartbeat', sessionMiddleware, async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!clawHeartbeatRateLimiter.check(ip)) {
    return c.json({ error: 'Too many heartbeats. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json();
  const { sessionId, x, y, direction, activity } = body;
  if (!sessionId || typeof x !== 'number' || typeof y !== 'number') {
    return c.json({ error: 'sessionId, x, y required' }, 400);
  }

  const updated = npcSimulation.updateBrowserClawPosition(sessionId, x, y, direction, activity);
  if (!updated) {
    return c.json({ error: 'Claw session not found' }, 404);
  }

  return c.json({ ok: true });
});

// POST /api/claws — Save claw to database (requires auth)
clawRoutes.post('/', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json();
  const parsed = clawConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid claw config', details: parsed.error.flatten() }, 400);
  }

  const agentId = `claw-${user.id}-${Date.now()}`;
  const [claw] = await db
    .insert(openclawBots)
    .values({
      agentId,
      gatewayUrl: '',
      protocol: 'openai-compat',
      mode: 'avatar',
      userId: user.id,
      name: parsed.data.name,
      species: parsed.data.species,
      color: 0,
      metadata: {
        personality: parsed.data.personality?.tone,
      },
      knowledge: parsed.data.knowledge ?? [],
    })
    .returning();

  return c.json({ claw });
});

// GET /api/claws/me — Get user's saved claws
clawRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const userClaws = await db.query.openclawBots.findMany({
    where: eq(openclawBots.userId, user.id),
    orderBy: (openclawBots: any, { desc }: { desc: any }) => [desc(openclawBots.updatedAt)],
  });
  return c.json({ claws: userClaws });
});

// PATCH /api/claws/:id — Update claw config
clawRoutes.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const clawId = c.req.param('id');

  const existing = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.id, clawId),
  });

  if (!existing || existing.userId !== user.id) {
    return c.json({ error: 'Claw not found' }, 404);
  }

  const body = await c.req.json();
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (body.name) updates.name = body.name;
  if (body.knowledge) updates.knowledge = body.knowledge;
  if (body.personality) {
    updates.metadata = {
      ...(existing.metadata ?? {}),
      personality: body.personality.tone,
    };
  }

  const [updated] = await db
    .update(openclawBots)
    .set(updates)
    .where(eq(openclawBots.id, clawId))
    .returning();

  return c.json({ claw: updated });
});

export { clawRoutes };
