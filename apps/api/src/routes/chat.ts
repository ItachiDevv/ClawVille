import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, locationAgents, pets } from '@clawville/database';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES, getBooksForBuilding, isShopBuilding } from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { awardXp } from '../services/xp-service';
import { shouldCollaborate, collaborateOnQuery } from '../services/agent-collaboration';
import { miladyGateway } from '../services/milady-gateway';
import { creditClawTokens } from '../services/neo-token-ledger';
import type { AppContext } from '../types';
import { z } from 'zod';

export const chatRoutes = new Hono<AppContext>();

chatRoutes.use('*', sessionMiddleware);

// Send message to location agent
const chatSchema = z.object({
  content: z.string().min(1).max(4000),
});

chatRoutes.post('/:id/chat', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');
  const body = await c.req.json();
  const result = chatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }

  // Find agent for this location
  const locationAgent = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  if (!locationAgent || !locationAgent.platformAgentId) {
    throw new HTTPException(404, { message: 'No agent configured for this location' });
  }

  // Ensure agent runtime is running
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    locationAgent.platformAgentId,
    user.id
  );

  if (!runtime) {
    throw new HTTPException(500, { message: 'Failed to start agent runtime' });
  }

  // Build dynamic context for the location agent
  const dynamicContextParts: string[] = [];
  const location = MAP_LOCATIONS.find((l) => l.id === locationId);

  // Get visitor's pet info
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (pet) {
    dynamicContextParts.push(`The visitor has a pet named ${pet.name} (a ${pet.species}).`);
  }

  // Shop-specific context
  if (isShopBuilding(locationId)) {
    const books = getBooksForBuilding(locationId);
    if (books.length > 0) {
      const bookList = books.map((b) => `${b.name} (${b.price} ClawTokens)`).join(', ');
      dynamicContextParts.push(`Your shop sells: ${bookList}. Recommend items naturally in conversation when relevant.`);
    }
  }

  // OpenClaw theme context
  const openClawTheme = BUILDING_OPENCLAW_THEMES[locationId];
  if (openClawTheme) {
    dynamicContextParts.push(
      `You specialize in ${openClawTheme.focus}. Share OpenClaw insights and expertise naturally when relevant.`
    );
  }

  // Agent collaboration: consult specialists if question spans domains
  if (shouldCollaborate(result.data.content, locationId)) {
    try {
      const collab = await collaborateOnQuery({
        message: result.data.content,
        sourceBuildingId: locationId,
        maxExperts: 2,
        timeoutMs: 4000,
      });
      if (collab.combinedContext) {
        dynamicContextParts.push(collab.combinedContext);
      }
    } catch {
      // Non-blocking — collaboration failure doesn't break chat
    }
  }

  // Milady knowledge enrichment (if gateway available)
  if (miladyGateway.isAvailable()) {
    try {
      const insights = await miladyGateway.fetchMiladyInsights(result.data.content, locationId);
      if (insights.length > 0) {
        dynamicContextParts.push(`[Milady Knowledge]\n${insights.join('\n')}`);
      }
    } catch {
      // Non-blocking
    }
  }

  const dynamicContext = dynamicContextParts.length > 0
    ? dynamicContextParts.join('\n')
    : undefined;

  // Process message with dynamic context
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `${locationId}-${user.id}`,
    platform: 'clawville',
    dynamicContext,
  });

  // Award +1 ClawToken for chatting with a location agent (atomic + audited)
  if (pet) {
    await creditClawTokens({
      petId: pet.id,
      amount: 1,
      reason: 'location_chat',
      source: 'api',
      metadata: { locationId },
    }).catch((err) => console.error('[chat] creditClawTokens failed:', err));

    // Award +5 XP for NPC chat (non-blocking)
    awardXp(pet.id, 5, 'npc-chat').catch(console.error);
  }

  return c.json({
    message: {
      role: 'assistant' as const,
      content: response.content,
      timestamp: response.timestamp.toISOString(),
    },
  });
});

// Get chat history for a location
chatRoutes.get('/:id/chat/history', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');

  const locationAgent = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  if (!locationAgent || !locationAgent.platformAgentId) {
    return c.json({ messages: [] });
  }

  // Get history from agent runtime if available
  const runtime = agentOrchestrator.getRunningAgentRuntime(locationAgent.platformAgentId);

  if (!runtime) {
    return c.json({ messages: [] });
  }

  // For now, return empty - history is loaded from ElizaOS memories
  // which the runtime handles internally
  return c.json({ messages: [] });
});
