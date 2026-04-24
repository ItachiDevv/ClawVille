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
import { logEvent } from '../services/event-logger';
import { miladyGateway } from '../services/milady-gateway';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import { getSystemNpcAgent, getSystemAgent } from '../services/system-npc-seeder';
import { systemAgentRewardLimiter } from '../services/system-agent-reward-limiter';
import type { AppContext } from '../types';
import { z } from 'zod';
import type { ClawvilleServices } from '@clawville/agent-runtime';
import { characterRoomId } from '@clawville/agent-runtime';

export const chatRoutes = new Hono<AppContext>();

chatRoutes.use('*', sessionMiddleware);

// Send message to location agent
const chatSchema = z.object({
  content: z.string().min(1).max(4000),
});

// ───────────────────────────────────────────────────────────────────────────
// System-agent chat — POST /api/chat/system/:slug
// ───────────────────────────────────────────────────────────────────────────
// System agents are world-wide NPCs that aren't tied to a building (today:
// Town Guide at slug='town-guide'; future: arena host, quest giver, etc.).
// Each has a `platform_agents` row with `type='system-agent'` +
// `customization.slug=<slug>`, seeded on boot by `ensureSystemAgents()`.
//
// This route MUST be registered BEFORE `POST /:id/chat` so Hono matches the
// literal 'system' segment ahead of the `:id` wildcard.
//
// Auth: `requireAuth` — the guide is auth-gated because she rewards tokens
// and we need `user.id` for Phase 6 memory isolation (room derived from
// `characterRoomId(slug, user.id)`). Unauthenticated humans get 401.
// ───────────────────────────────────────────────────────────────────────────
chatRoutes.post('/system/:slug', requireAuth, async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const body = await c.req.json();
  const result = chatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }

  const agent = await getSystemAgent(slug);
  if (!agent) {
    // Set Retry-After so clients back off during the boot-race window
    // between container start and `ensureSystemAgents()` completing.
    c.header('Retry-After', '3');
    throw new HTTPException(503, {
      message: `System agent '${slug}' not seeded yet — try again in a moment`,
    });
  }

  const runtime = await agentOrchestrator.ensureAgentRuntime(
    agent.platformAgent.id,
    agent.systemUserId,
  );
  if (!runtime) {
    throw new HTTPException(500, { message: 'Failed to start system agent runtime' });
  }

  // Fetch visitor's pet (optional — enables personalized tutorials + XP/token
  // rewards; the system agent still responds when pet is absent).
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  const services = pet
    ? ({ db, creditClawTokens, debitClawTokens } as ClawvilleServices)
    : undefined;
  const state: Record<string, any> = {
    petId: pet?.id,
    userId: user.id,
    services,
    petData: pet ?? null,
    // NOTE: keep the bare slug here (no 'system:' prefix). Audit H3 — memory
    // continuity for existing Nori chats requires preserving the existing
    // room derivation: `characterRoomId('town-guide', userId)`.
    nearLocation: slug,
    characterConfig: (pet?.characterConfig as any) ?? {},
  };

  if (pet) {
    try {
      state.inventory = await db.query.petInventory.findMany({
        where: eq(petInventory.petId, pet.id),
      });
    } catch { /* non-blocking */ }
  }

  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    // Per-user memory isolation — each visitor has their own private room
    // with this system agent, scoped to the slug. Do NOT change this
    // derivation — it would orphan existing conversation memory.
    roomId: characterRoomId(slug, user.id),
    platform: 'clawville',
    state,
  });

  // Reward a token + XP for chatting, same economy as a building teacher —
  // but only once per (userId, slug) every 60s to stop spam mints.
  let tokenAwarded: 0 | 1 = 0;
  if (pet && systemAgentRewardLimiter.tryConsume(user.id, slug)) {
    tokenAwarded = 1;
    await creditClawTokens({
      petId: pet.id,
      amount: 1,
      reason: 'system_agent_chat',
      source: 'api',
      metadata: { slug },
    }).catch((err) => console.error('[chat/system] creditClawTokens failed:', err));

    awardXp(pet.id, 5, 'npc-chat').catch(console.error);
  }

  void logEvent({
    eventType: 'agent.chat.turn',
    userId: user.id,
    petId: pet?.id ?? null,
    // system-agent chats are not building visits — buildingId stays null
    // so the /dash buildings-by-visits chart doesn't attribute them to a
    // fake building id.
    buildingId: null,
    payload: {
      // Deliberately 'system-agent', NOT 'location'. Audit H1 — system
      // agents are not MiladyAI teachers; including them in the
      // teacher-chat metric would inflate that dashboard card.
      chatType: 'system-agent',
      agentSlug: slug,
      messageLength: result.data.content.length,
      tokenAwarded,
    },
  });

  return c.json({
    message: {
      role: 'assistant' as const,
      content: response.content,
      timestamp: response.timestamp.toISOString(),
    },
  });
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
    // Phase 6 — per-user memory isolation: stable v5 UUID scoped to
    // (locationId, userId) so every visitor has their own private chat
    // room with the character, while still sharing the character itself.
    roomId: characterRoomId(locationId, user.id),
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

  void logEvent({
    eventType: 'agent.chat.turn',
    userId: user.id,
    petId: pet?.id ?? null,
    buildingId: locationId,
    payload: {
      chatType: 'location',
      messageLength: result.data.content.length,
      tokenAwarded: pet ? 1 : 0,
      // Guest-pet carve-out (2026-04-23) — flag for /dash teacher-chat
      // metric so guest chats are excluded from the "real engagement"
      // count. The dashboard SQL filters `payload->>'isGuest' <> 'true'`.
      isGuest: pet?.isGuest ?? false,
    },
  });

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
