import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, locationAgents, pets, petInventory } from '@clawville/database';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES, getBooksForBuilding, isShopBuilding } from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { awardXp } from '../services/xp-service';
import { shouldCollaborate, collaborateOnQuery } from '../services/agent-collaboration';
import { miladyGateway } from '../services/milady-gateway';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import { getSystemNpcAgent } from '../services/system-npc-seeder';
import type { AppContext } from '../types';
import { z } from 'zod';
import type { ClawvilleServices } from '@clawville/agent-runtime';

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

  // Find agent for this location — first the caller's personal override,
  // then fall back to the system-owned NPC (Gary, Patrick, Sandy, etc.)
  // seeded on boot by `ensureSystemNpcs()`.
  let locationAgent = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, user.id),
      eq(locationAgents.locationId, locationId)
    ),
  });

  let runtimeOwnerUserId: string = user.id;

  if (!locationAgent || !locationAgent.platformAgentId) {
    const system = await getSystemNpcAgent(locationId);
    if (!system) {
      throw new HTTPException(404, { message: 'No agent available for this location' });
    }
    locationAgent = system.locationAgent;
    runtimeOwnerUserId = system.systemUserId;
  }

  // Ensure agent runtime is running — must pass the agent's owner userId
  // (not the caller) so the orchestrator's (id, userId) lookup succeeds.
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    locationAgent.platformAgentId!,
    runtimeOwnerUserId
  );

  if (!runtime) {
    throw new HTTPException(500, { message: 'Failed to start agent runtime' });
  }

  // Get visitor's pet info
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  // Build state object for Providers + Actions
  // Only inject services if pet exists — actions require a petId to transact
  const services = pet
    ? ({ db, creditClawTokens, debitClawTokens } as ClawvilleServices)
    : undefined;
  const state: Record<string, any> = {
    petId: pet?.id,
    userId: user.id,
    services,
    // Provider data
    petData: pet ?? null,
    nearLocation: locationId,
    characterConfig: (pet?.characterConfig as any) ?? {},
  };

  // Fetch inventory + quests for Providers (non-blocking on failure)
  if (pet) {
    try {
      state.inventory = await db.query.petInventory.findMany({
        where: eq(petInventory.petId, pet.id),
      });
    } catch { /* non-blocking */ }

    try {
      const { quests, questSubmissions } = await import('@clawville/database');
      state.activeQuests = await db
        .select()
        .from(questSubmissions)
        .innerJoin(quests, eq(questSubmissions.questId, quests.id))
        .where(and(
          eq(questSubmissions.petId, pet.id),
          sql`${questSubmissions.status} IN ('accepted', 'in_progress')`
        ))
        .limit(10);
      state.availableQuests = await db
        .select()
        .from(quests)
        .where(eq(quests.status, 'active'))
        .limit(5);
    } catch { /* non-blocking */ }
  }

  // Extra context that doesn't map to a Provider (collaboration + milady)
  const extraContextParts: string[] = [];

  // OpenClaw theme context
  const openClawTheme = BUILDING_OPENCLAW_THEMES[locationId];
  if (openClawTheme) {
    extraContextParts.push(
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
        extraContextParts.push(collab.combinedContext);
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
        extraContextParts.push(`[Milady Knowledge]\n${insights.join('\n')}`);
      }
    } catch {
      // Non-blocking
    }
  }

  const dynamicContext = extraContextParts.length > 0
    ? extraContextParts.join('\n')
    : undefined;

  // Process message — Providers inject pet/world/inventory/quest/knowledge
  // context automatically; dynamicContext carries collaboration + milady extras
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `${locationId}-${user.id}`,
    platform: 'clawville',
    dynamicContext,
    state,
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
