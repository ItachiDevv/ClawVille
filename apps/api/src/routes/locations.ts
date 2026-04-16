import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, mapLocations, locationAgents, platformAgents } from '@clawville/database';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import type { AppContext } from '../types';
import { z } from 'zod';
import { getSystemNpcAgent } from '../services/system-npc-seeder';

export const locationRoutes = new Hono<AppContext>();

locationRoutes.use('*', sessionMiddleware);

// Get all locations
locationRoutes.get('/', async (c) => {
  const locations = await db.query.mapLocations.findMany();
  return c.json({ locations });
});

// Get the active agent config for a location. Prefers the caller's
// personal override; falls back to the system-owned NPC (Gary, Patrick,
// etc.) so every building always reports a chattable agent. The response
// includes an `isSystemNpc` flag so the client can distinguish "the
// canonical character" from "the user's custom override".
locationRoutes.get('/:id/agent', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');

  const personal = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  if (personal) {
    return c.json({ agent: { ...personal, isSystemNpc: false } });
  }

  const system = await getSystemNpcAgent(locationId);
  if (system) {
    return c.json({ agent: { ...system.locationAgent, isSystemNpc: true } });
  }

  return c.json({ agent: null });
});

// Create/update agent for location
const agentConfigSchema = z.object({
  agentName: z.string().min(1).max(100),
  characterConfig: z.object({
    name: z.string().min(1).max(100),
    personality: z.string().min(1).max(1000),
    bio: z.string().min(1).max(2000),
    greeting: z.string().min(1).max(500),
    tone: z.enum(['formal', 'casual', 'friendly', 'professional']),
    topics: z.array(z.string()).max(20),
    rules: z.array(z.string()).max(20),
    style: z.array(z.string()).max(20),
  }),
});

locationRoutes.post('/:id/agent', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');
  const body = await c.req.json();
  const result = agentConfigSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Verify location exists
  const location = await db.query.mapLocations.findFirst({
    where: eq(mapLocations.id, locationId),
  });

  if (!location) {
    throw new HTTPException(404, { message: 'Location not found' });
  }

  // Check if agent already exists for this user+location
  const existing = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  if (existing) {
    // Update existing
    const [updated] = await db
      .update(locationAgents)
      .set({
        agentName: result.data.agentName,
        characterConfig: result.data.characterConfig,
        updatedAt: new Date(),
      })
      .where(eq(locationAgents.id, existing.id))
      .returning();

    return c.json({ agent: updated });
  }

  // Create platform agent record
  const [platformAgent] = await db.insert(platformAgents).values({
    userId: user.id,
    name: result.data.agentName,
    type: 'location-agent',
    status: 'stopped',
    customization: result.data.characterConfig,
    config: { locationId },
  }).returning();

  // Create location agent
  const [agent] = await db.insert(locationAgents).values({
    userId: user.id,
    locationId,
    agentName: result.data.agentName,
    characterConfig: result.data.characterConfig,
    platformAgentId: platformAgent.id,
  }).returning();

  return c.json({ agent });
});

// Delete agent from location
locationRoutes.delete('/:id/agent', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');

  const existing = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  if (!existing) {
    throw new HTTPException(404, { message: 'No agent configured for this location' });
  }

  // Delete platform agent if exists
  if (existing.platformAgentId) {
    await db.delete(platformAgents).where(eq(platformAgents.id, existing.platformAgentId));
  }

  await db.delete(locationAgents).where(eq(locationAgents.id, existing.id));

  return c.json({ success: true });
});
