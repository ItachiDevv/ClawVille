import { Hono } from 'hono';
import { z } from 'zod';
import { NPC_IDS } from '@elizapets/shared';
import type { OpenClawRegistration } from '@elizapets/shared';
import { OpenClawClient } from '../services/openclaw-client';
import { npcSimulation } from '../services/npc-simulation';
import type { AppContext } from '../types';

const openclawRoutes = new Hono<AppContext>();

const baseSchema = z.object({
  gatewayUrl: z.string().url(),
  authToken: z.string().min(1),
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
});

const overrideSchema = baseSchema.extend({
  mode: z.literal('override'),
  targetNpcId: z.enum(NPC_IDS as [string, ...string[]]),
});

const avatarSchema = baseSchema.extend({
  mode: z.literal('avatar'),
  name: z.string().min(1).max(24),
  species: z.string().min(1),
  color: z.number().int().min(0).max(0xffffff),
  stats: z.object({
    hp: z.number().int().min(50).max(150),
    attack: z.number().int().min(5).max(25),
    defense: z.number().int().min(5).max(25),
    speed: z.number().int().min(5).max(25),
  }),
  personality: z.string().min(1).max(200),
  homeX: z.number().min(32).max(1248),
  homeY: z.number().min(32).max(768),
  patrolRadius: z.number().min(32).max(256),
});

const registerSchema = z.discriminatedUnion('mode', [overrideSchema, avatarSchema]);

// POST /api/openclaw/register
openclawRoutes.post('/register', async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const sessionId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const config: OpenClawRegistration = {
    ...data,
    sessionId,
  } as OpenClawRegistration;

  // Test connectivity
  const client = new OpenClawClient(config);
  const alive = await client.ping();
  if (!alive) {
    return c.json({ error: 'Cannot connect to OpenClaw gateway. Check URL and auth token.' }, 502);
  }

  // Register with simulation
  try {
    npcSimulation.registerOpenClaw(config, client);
  } catch (err: any) {
    return c.json({ error: err.message || 'Registration failed' }, 400);
  }

  return c.json({ sessionId, mode: data.mode });
});

// DELETE /api/openclaw/unregister/:sessionId
openclawRoutes.delete('/unregister/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const removed = npcSimulation.unregisterOpenClaw(sessionId);
  if (!removed) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json({ success: true });
});

// GET /api/openclaw/active
openclawRoutes.get('/active', (c) => {
  const bots = npcSimulation.getActiveOpenClawBots();
  return c.json({ bots });
});

export { openclawRoutes };
