import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, locationAgents, avatars, avatarInventory } from '@clawville/database';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES, getBooksForBuilding, isShopBuilding } from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { awardXp } from '../services/xp-service';
import { shouldCollaborate, collaborateOnQuery } from '../services/agent-collaboration';
import { logEvent, logEventFromContext } from '../services/event-logger';
import { miladyGateway } from '../services/milady-gateway';
import {
  creditBuildingChatRewardOncePerDay,
  humanBuildingChatRewardAvatarId,
} from '../services/building-reward';
import { isGuestUser } from '../middleware/require-non-guest';
import { buildRuntimeServices } from '../services/runtime-services-adapter';
import { getSystemNpcAgent } from '../services/system-npc-seeder';
import { conductSystemAgentChat } from '../services/system-agent-chat';
import { AGENT_SESSION_HEADER } from '../middleware/require-auth-or-agent';
import {
  moderateText,
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
  OUTPUT_REFUSAL_MESSAGE,
} from '../services/moderation-service';
import type { AppContext } from '../types';
import { z } from 'zod';
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
// Auth: Lucia cookie or live, ledger-authorized agent session. Both bind
// memory and the shared reward cooldown to the same canonical owner userId.
// ───────────────────────────────────────────────────────────────────────────
chatRoutes.post('/system/:slug', async (c) => {
  // sessionMiddleware preserves cookie precedence and humans without avatars.
  const user = c.get('user');
  const sessionId = c.req.header(AGENT_SESSION_HEADER);
  if (!user && !sessionId) {
    throw new HTTPException(401, { message: 'Authentication required — Lucia cookie or X-Clawville-Agent-Session header' });
  }
  const body = await c.req.json();
  const result = chatSchema.safeParse(body);
  if (!result.success) throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  try {
    return c.json(await conductSystemAgentChat({
      actor: user ? { kind: 'human', userId: user.id } : { kind: 'agent', sessionId: sessionId! },
      slug: c.req.param('slug'), content: result.data.content,
      fpHash: c.get('fpHash'), ipPrefixHash: c.get('ipPrefixHash'),
    }));
  } catch (error) {
    if (error instanceof HTTPException && error.status === 503) c.header('Retry-After', '3');
    if (error instanceof HTTPException && error.message === CONTENT_BLOCKED_MESSAGE) {
      return c.json({ error: CONTENT_BLOCKED_MESSAGE, code: CONTENT_BLOCKED_CODE }, 400);
    }
    throw error;
  }
});

chatRoutes.post('/:id/chat', requireAuth, async (c) => {
  const user = c.get('user');
  const locationId = c.req.param('id');
  const body = await c.req.json();
  const result = chatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }

  // Content guardrail (input) — before agent lookup/runtime so blocked text
  // never reaches the teacher LLM (saves tokens); fail-open never breaks chat.
  const inMod = await moderateText(result.data.content, { surface: 'location-chat', direction: 'input' });
  if (!inMod.allowed) {
    return c.json({ error: CONTENT_BLOCKED_MESSAGE, code: CONTENT_BLOCKED_CODE }, 400);
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

  // Get visitor's avatar info
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  // Build state object for Providers + Actions
  // Only inject services if avatar exists — actions require a avatarId to transact
  const services = avatar
    ? buildRuntimeServices(db, { actorKind: 'human' })
    : undefined;
  const state: Record<string, any> = {
    avatarId: avatar?.id,
    platformAgentId: locationAgent.platformAgentId!,
    userId: user.id,
    services,
    // Provider data
    avatarData: avatar ?? null,
    nearLocation: locationId,
    characterConfig: (avatar?.characterConfig as any) ?? {},
  };

  // Fetch inventory + quests for Providers (non-blocking on failure)
  if (avatar) {
    try {
      state.inventory = await db.query.avatarInventory.findMany({
        where: eq(avatarInventory.avatarId, avatar.id),
      });
    } catch { /* non-blocking */ }

    try {
      const { quests, questSubmissions } = await import('@clawville/database');
      state.activeQuests = await db
        .select()
        .from(questSubmissions)
        .innerJoin(quests, eq(questSubmissions.questId, quests.id))
        .where(and(
          eq(questSubmissions.avatarId, avatar.id),
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
        // The authenticated human owns this active avatar. Keep both fields so
        // event guest-resolution and the avatar-keyed scoring leg agree.
        ...(avatar
          ? { initiator: { kind: 'human' as const, userId: user.id, avatarId: avatar.id } }
          : {}),
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

  // Process message — Providers inject avatar/world/inventory/quest/knowledge
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
    // F3: live human↔teacher chat — keep replies short (tight token ceiling).
    // The teacher can still emit a single [ACTION:] (token award) within 320
    // tokens of prose+tag; the result text is appended AFTER generation, uncapped.
    conversational: true,
  });

  // Award +1 vCLAW once per (avatar, building, UTC day), shared with connected
  // and autonomous agent teacher-chat paths. The durable claim + mint are one tx.
  // Guest users run an ALL-DEMO economy: they NEVER touch the real CT ledger,
  // so BOTH the direct credit AND the `awardXp` level-up token leak (50 real CT
  // on level-up) are skipped for guests — gating the whole block is what closes
  // the XP leak (awardXp is only ever called from this file).
  let tokenAwarded: 0 | 1 = 0;
  // `users.is_guest` is the canonical security state. `avatars.is_guest` is a
  // denormalized mirror and may be stale/default-false, so it must not authorize
  // this mint (or the XP level-up mint reachable through awardXp).
  const canonicalGuest = avatar ? await isGuestUser(user.id) : false;
  const rewardAvatarId = humanBuildingChatRewardAvatarId(avatar?.id ?? null, canonicalGuest);
  if (rewardAvatarId) {
    try {
      tokenAwarded = (await creditBuildingChatRewardOncePerDay({
        avatarId: rewardAvatarId,
        buildingId: locationId,
        reason: 'location_chat',
        metadata: { locationId },
        actorKind: 'human',
      })) ? 1 : 0;
    } catch (err) {
      console.error('[chat] building-chat reward failed:', err);
    }

    // XP follows the same durable daily claim, so repeat chat cannot farm level
    // bonus mints through awardXp. Non-blocking behavior is preserved.
    if (tokenAwarded === 1) {
      awardXp(rewardAvatarId, 5, 'npc-chat').catch(console.error);
    }
  }

  void logEventFromContext(c, {
    eventType: 'agent.chat.turn',
    userId: user.id,
    avatarId: avatar?.id ?? null,
    buildingId: locationId,
    payload: {
      chatType: 'location',
      messageLength: result.data.content.length,
      // Guests earn NO real CT (all-demo economy) → tokenAwarded is 0 for them,
      // so this event field equals what was actually credited (conservation).
      tokenAwarded,
      // Guest-avatar carve-out (2026-04-23) — flag for /dash teacher-chat
      // metric so guest chats are excluded from the "real engagement"
      // count. The dashboard SQL filters `payload->>'isGuest' <> 'true'`.
      isGuest: canonicalGuest,
    },
  });

  // Content guardrail (output) — teacher reply is agent→human; moderate before
  // returning. A block substitutes a safe refusal; fail-open passes through.
  const outMod = await moderateText(response.content, { surface: 'location-chat', direction: 'output' });

  return c.json({
    message: {
      role: 'assistant' as const,
      content: outMod.allowed ? response.content : OUTPUT_REFUSAL_MESSAGE,
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
