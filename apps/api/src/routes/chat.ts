import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, locationAgents, avatars } from '@legacyapp/database';
import { MAP_LOCATIONS, BUILDING_CRYPTO_THEMES, getBooksForBuilding, isShopBuilding } from '@legacyapp/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
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

  // Get visitor's avatar info
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
  });

  if (avatar) {
    dynamicContextParts.push(`The visitor has a avatar named ${avatar.name} (a ${avatar.species}).`);
  }

  // Shop-specific context
  if (isShopBuilding(locationId)) {
    const books = getBooksForBuilding(locationId);
    if (books.length > 0) {
      const bookList = books.map((b) => `${b.name} (${b.price} ClawTokens)`).join(', ');
      dynamicContextParts.push(`Your shop sells: ${bookList}. Recommend items naturally in conversation when relevant.`);
    }
  }

  // Crypto theme context
  const cryptoTheme = BUILDING_CRYPTO_THEMES[locationId];
  if (cryptoTheme) {
    dynamicContextParts.push(
      `You specialize in ${cryptoTheme.focus}. Share crypto insights and alpha naturally when relevant.`
    );
  }

  const dynamicContext = dynamicContextParts.length > 0
    ? dynamicContextParts.join('\n')
    : undefined;

  // Process message with dynamic context
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `${locationId}-${user.id}`,
    platform: 'legacyapp',
    dynamicContext,
  });

  // Award +1 ClawToken for chatting with a location agent
  if (avatar) {
    await db
      .update(avatars)
      .set({
        clawTokens: avatar.clawTokens + 1,
        updatedAt: new Date(),
      })
      .where(eq(avatars.id, avatar.id));
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
