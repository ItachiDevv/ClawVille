import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import {
  NPC_BUILDING_CENTERS,
  BUILDING_OPENCLAW_THEMES,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  NPC_IDS,
  type NpcActivity,
  type AgentPerception,
  type AgentStats,
  type OpenClawRegistration,
} from '@clawville/shared';
import { npcSimulation } from '../services/npc-simulation';
import { findPath } from '../services/pathfinding';
import { memoryService } from '../services/memory-service';
import { db, openclawBots, eq, sql } from '@clawville/database';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { getSessionAgent } from '../services/session-agent-map';
import { OpenClawClient } from '../services/openclaw-client';
import { ensureWallet } from '../services/wallet-service';
import { creditNeoTokens, debitNeoTokens } from '../services/neo-token-ledger';
import type { ClawvilleServices } from '@clawville/agent-runtime';

const agentGatewayRoutes = new Hono();

// ---------------------------------------------------------------------------
// POST /api/agent/connect  — Universal agent registration
// ---------------------------------------------------------------------------
// Single entry point for any external AI agent to join the ClawVille world.
// Supports 6 identity types and 4 wire protocols including `nanoclaw` — a
// self-managed pull mode where the agent has no HTTP gateway and instead
// consumes the /events SSE stream and pushes actions via REST.
//
// Identity model (runtime-trust for Milady, self-declared for others):
//   - openclaw / ironclaw  — present a gatewayUrl, chat routed via HTTP
//   - nanoclaw             — self-managed, pulls via SSE (no outbound chat)
//   - milady               — running inside a Milady app plugin; the plugin
//                            passes runtime.agentId as miladyAgentId and we
//                            trust the call. No external verification.
//   - custom               — any other framework with a compatible gateway
//   - anonymous            — no persistent identity, one-off test agents
//
// Kept alongside the legacy /api/openclaw/register endpoint (which remains
// for backwards compat). New integrations should use /api/agent/connect.
const connectSchema = z.object({
  // Identity signals (at least one required)
  agentId: z.string().min(1).max(200).optional(),

  // Milady identity — passed by the @clawville/app-clawville Milady plugin.
  // Runtime-trust: we don't verify these server-side; the plugin is the
  // trust boundary since it runs inside a curated Milady distribution.
  miladyAgentId: z.string().min(1).max(200).optional(),
  miladyCharacterName: z.string().min(1).max(100).optional(),

  // Avatar config
  name: z.string().min(1).max(24).optional(),
  species: z.string().min(1).max(50).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  personality: z.string().max(200).optional(),

  // Gateway config (required for chat-routing agents, ignored for nanoclaw/anonymous/milady)
  gatewayUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  protocol: z.enum(['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw']).optional(),
  autonomyMode: z.enum(['server-managed', 'self-managed']).optional(),

  // Spawn position / stats
  homeX: z.number().min(32).max(1248).optional(),
  homeY: z.number().min(32).max(768).optional(),
  patrolRadius: z.number().min(32).max(256).optional(),
  stats: z.object({
    hp: z.number().int().min(50).max(150),
    attack: z.number().int().min(5).max(25),
    defense: z.number().int().min(5).max(25),
    speed: z.number().int().min(5).max(25),
  }).optional(),

  // Mode — avatar spawns a new bot, override takes over an existing building NPC
  mode: z.enum(['avatar', 'override']).optional().default('avatar'),
  targetNpcId: z.string().optional(),

  // Identity type hint (inferred from other fields if omitted)
  identityType: z.enum(['openclaw', 'ironclaw', 'nanoclaw', 'milady', 'custom', 'anonymous']).optional(),
}).refine(
  (d) => d.agentId || d.miladyAgentId,
  { message: 'At least one identity signal required: agentId or miladyAgentId' }
);

agentGatewayRoutes.post('/connect', async (c) => {
  const body = await c.req.json();
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  let resolvedAgentId: string = data.agentId ?? '';

  // Step 1: Resolve Milady identity (runtime-trust — no external verification).
  //
  // The @clawville/app-clawville Milady plugin passes miladyAgentId +
  // miladyCharacterName directly from runtime.agentId + runtime.character.name.
  // We key on `milady:{miladyAgentId}` so a returning Milady user gets their
  // old pet, wallet, learned knowledge, and NeoToken balance across launches.
  // Matches how Babylon + Defense of the Agents trust the Milady runtime.
  if (data.miladyAgentId) {
    resolvedAgentId = `milady:${data.miladyAgentId}`;
  }

  // If still no agentId, generate a one-shot anonymous one
  if (!resolvedAgentId) {
    resolvedAgentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Validate override target before touching the DB
  if (data.mode === 'override' && data.targetNpcId && !NPC_IDS.includes(data.targetNpcId)) {
    return c.json({ error: `Unknown targetNpcId: ${data.targetNpcId}` }, 400);
  }

  // nanoclaw is an identity concept — on the wire it still speaks openai-compat shape
  // (or nothing, because it won't be POSTing anywhere)
  const wireProtocol = data.protocol ?? 'openai-compat';

  // Infer identity type
  const identityType = data.identityType
    ?? (data.miladyAgentId ? 'milady'
      : data.protocol === 'nanoclaw' ? 'nanoclaw'
      : data.gatewayUrl ? 'openclaw'
      : 'anonymous');

  // NanoClaw agents are always self-managed
  const autonomyMode = data.protocol === 'nanoclaw'
    ? 'self-managed'
    : (data.autonomyMode ?? 'server-managed');

  // Step 2: Upsert openclaw_bots row
  const sessionId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let isReturning = false;
  let totalSessions = 1;
  let knowledge: string[] = [];
  let uuid = '';
  let lastX: number | undefined;
  let lastY: number | undefined;
  const agentStats = data.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };

  try {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, resolvedAgentId),
    });

    if (existing) {
      isReturning = true;
      totalSessions = (existing.totalSessions ?? 0) + 1;
      knowledge = existing.knowledge ?? [];
      uuid = existing.id;
      const meta = existing.metadata as { lastX?: number; lastY?: number } | null;
      lastX = meta?.lastX;
      lastY = meta?.lastY;

      // For Milady agents, prefer the runtime-passed character name over
      // whatever's stored — Milady is the source of truth for agent naming.
      const preferredName = data.miladyCharacterName ?? data.name ?? existing.name;

      await db.update(openclawBots).set({
        identityType,
        gatewayUrl: data.gatewayUrl ?? existing.gatewayUrl,
        protocol: data.protocol ? wireProtocol : existing.protocol,
        mode: data.mode,
        name: preferredName,
        species: data.species ?? existing.species,
        color: data.color ?? existing.color,
        totalSessions,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(openclawBots.id, existing.id));
    } else {
      // First-time contact — use miladyCharacterName when present so the
      // bot is named from the Milady runtime rather than needing a separate
      // `name` field in the request body.
      const insertName = data.miladyCharacterName ?? data.name ?? null;

      const [inserted] = await db.insert(openclawBots).values({
        agentId: resolvedAgentId,
        identityType,
        gatewayUrl: data.gatewayUrl ?? null,
        protocol: wireProtocol,
        mode: data.mode,
        name: insertName,
        species: data.species ?? null,
        color: data.color ?? null,
        metadata: {
          personality: data.personality,
          homeX: data.homeX ?? 640,
          homeY: data.homeY ?? 400,
          patrolRadius: data.patrolRadius ?? 100,
          stats: agentStats,
        },
        totalSessions: 1,
      }).returning();
      uuid = inserted.id;
    }
  } catch (err) {
    console.error('[AgentConnect] DB error:', err);
    return c.json({ error: 'Database error during agent registration' }, 500);
  }

  // Step 2b: Ensure the bot has a custodial Solana wallet. Idempotent —
  // returning agents keep their existing wallet across launches. Failure
  // here is non-fatal (we log + continue without a wallet) because the
  // agent can still play the game; only Phase 4 x402 payment features
  // require the wallet.
  let walletAddress: string | null = null;
  try {
    const wallet = await ensureWallet('agent', uuid);
    walletAddress = wallet.publicKey;
  } catch (err) {
    console.error('[AgentConnect] Wallet auto-gen failed:', err);
  }

  // Step 3: Register in npc-simulation so the bot actually spawns in the world.
  // Override mode takes over an existing NPC — check it FIRST before falling
  // through to avatar mode. Avatar mode spawns a new bot (name + species).
  if (data.mode === 'override' && data.targetNpcId) {
    try {
      const config: OpenClawRegistration = {
        agentId: resolvedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: data.gatewayUrl ?? 'http://localhost:0',
        authToken: data.authToken ?? '',
        protocol: wireProtocol,
        mode: 'override',
        autonomyMode,
        targetNpcId: data.targetNpcId,
      } as OpenClawRegistration;
      const client = new OpenClawClient(config);
      npcSimulation.registerOpenClaw(config, client);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 409);
    }
  } else {
    // Avatar mode — spawn a new bot. Default species to 'lobster' and name
    // to agentId so agents ALWAYS spawn even if the caller omits optional fields.
    const spawnName = data.name ?? data.miladyCharacterName ?? resolvedAgentId.slice(0, 24);
    const spawnSpecies = data.species ?? 'lobster';
    try {
      const config: OpenClawRegistration = {
        agentId: resolvedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: data.gatewayUrl ?? 'http://localhost:0', // dummy for nanoclaw/anonymous
        authToken: data.authToken ?? '',
        protocol: wireProtocol,
        mode: 'avatar',
        autonomyMode,
        name: spawnName,
        species: spawnSpecies,
        color: data.color ?? 0x888888,
        stats: agentStats,
        homeX: data.homeX ?? 640,
        homeY: data.homeY ?? 400,
        patrolRadius: data.patrolRadius ?? 100,
        personality: data.personality ?? '',
      } as OpenClawRegistration;

      // Stub client — nanoclaw/anonymous agents don't use outbound chat routing
      // but the simulation still needs a client instance for its bot map.
      const client = new OpenClawClient(config);

      const restoredState = lastX != null && lastY != null
        ? { lastX, lastY, knowledge }
        : undefined;

      npcSimulation.registerOpenClaw(config, client, restoredState);
    } catch (err) {
      console.error('[AgentConnect] NPC registration error:', err);
      // Non-fatal — agent still gets a sessionId for REST polling
    }
  }

  return c.json({
    agentId: resolvedAgentId,
    sessionId,
    uuid,
    isReturning,
    totalSessions,
    knowledge,
    identityType,
    autonomyMode,
    walletAddress,
  });
});

// --- Middleware: validate session and resolve NPC ---

function resolveSession(sessionId: string) {
  if (!npcSimulation.isValidAgentSession(sessionId)) return null;
  const npcId = npcSimulation.getNpcIdForSession(sessionId);
  if (!npcId) return null;
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;
  return { npcId, npc };
}

// ---------------------------------------------------------------------------
// buildPerception — shared helper for GET /perception and SSE /events
// ---------------------------------------------------------------------------
function buildPerception(npcId: string): AgentPerception | null {
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;

  const allNpcs = npcSimulation.getAllNpcs();
  const PERCEPTION_RADIUS = 500;

  // Nearby NPCs within radius
  const nearbyNpcs = allNpcs
    .filter((other) => other.id !== npcId)
    .map((other) => {
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return { other, distance };
    })
    .filter(({ distance }) => distance <= PERCEPTION_RADIUS)
    .map(({ other, distance }) => ({
      npcId: other.id,
      name: other.name,
      x: other.x,
      y: other.y,
      distance: Math.round(distance),
      species: other.species,
      hp: other.hp,
      isDead: other.isDead,
      inCombat: other.inCombat,
      activity: other.activity,
      level: other.level,
      isOpenClaw: other.isOpenClaw,
    }));

  // Nearby buildings
  const nearbyBuildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][]).map(([buildingId, center]) => {
    const dx = center.x - npc.x;
    const dy = center.y - npc.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    return {
      buildingId,
      label: theme?.label ?? buildingId,
      cryptoFocus: theme?.focus ?? '',
      centerX: center.x,
      centerY: center.y,
      distance: Math.round(distance),
    };
  }).sort((a, b) => a.distance - b.distance);

  // Active conversations involving this NPC
  const conversations = npcSimulation.getActiveConversations();
  const activeConversations = conversations.map((conv) => ({
    id: conv.id,
    participants: [conv.npc1Id, conv.npc2Id],
    latestMessage: conv.messages.length > 0
      ? conv.messages[Math.min(conv.currentIndex, conv.messages.length - 1)].text
      : '',
    involvesMe: conv.npc1Id === npcId || conv.npc2Id === npcId,
  }));

  // Active combats
  const combats = npcSimulation.getActiveCombats();
  const activeCombats = combats.map((combat) => ({
    id: combat.id,
    attacker: combat.attacker,
    defender: combat.defender,
    involvesMe: combat.attacker === npcId || combat.defender === npcId,
    lastRound: combat.rounds.length > 0
      ? combat.rounds[combat.rounds.length - 1]
      : null,
  }));

  const arenaRound = npcSimulation.getMode() === 'arena'
    ? (() => {
        const snapshot = npcSimulation.getSnapshot();
        return snapshot.arenaRound;
      })()
    : null;

  return {
    self: {
      npcId: npc.id,
      x: npc.x,
      y: npc.y,
      hp: npc.hp,
      maxHp: npc.maxHp,
      level: npc.level,
      kills: npc.kills,
      xp: npc.xp,
      inventory: npc.inventory,
      activity: npc.activity,
      inCombat: npc.inCombat,
      isDead: npc.isDead,
      combatAction: npc.combatAction,
      direction: npc.direction,
    },
    nearbyNpcs,
    nearbyBuildings,
    activeConversations,
    activeCombats,
    gameMode: npcSimulation.getMode(),
    arenaRound,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/perception
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/perception', (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const perception = buildPerception(resolved.npcId);
  if (!perception) return c.json({ error: 'NPC state unavailable' }, 404);

  return c.json(perception);
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/move
// ---------------------------------------------------------------------------
const moveSchema = z.object({
  targetX: z.number().min(16).max(1264).optional(),
  targetY: z.number().min(16).max(784).optional(),
  buildingId: z.string().optional(),
}).refine(
  (d) => (d.targetX !== undefined && d.targetY !== undefined) || d.buildingId !== undefined,
  { message: 'Provide either targetX+targetY or buildingId' }
);

agentGatewayRoutes.post('/:sessionId/move', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { targetX, targetY, buildingId } = parsed.data;

  if (npc.isDead) return c.json({ error: 'NPC is dead, wait for respawn' }, 400);

  let destX: number;
  let destY: number;
  let destBuildingId: string | undefined;

  if (buildingId) {
    const center = NPC_BUILDING_CENTERS[buildingId];
    if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);
    destX = center.x + (Math.random() - 0.5) * 40;
    destY = center.y + 20 + Math.random() * 20;
    destBuildingId = buildingId;
  } else {
    destX = targetX!;
    destY = targetY!;
  }

  const path = findPath(npc.x, npc.y, destX, destY);
  if (path.length === 0) return c.json({ error: 'No path found to destination' }, 400);

  npcSimulation.setNpcPath(npcId, path, destBuildingId);
  return c.json({ success: true, pathLength: path.length, destination: { x: destX, y: destY } });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/chat
// ---------------------------------------------------------------------------
const chatSchema = z.object({
  message: z.string().min(1).max(500),
  targetNpcId: z.string().optional(),
});

agentGatewayRoutes.post('/:sessionId/chat', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;

  // Always inject into world simulation for visible chat bubbles
  npcSimulation.injectAgentChat(npcId, parsed.data.message);

  // Route through ElizaOS agent for memory + context (if agent exists)
  let elizaResponse: string | null = null;
  const elizaAgentId = getSessionAgent(sessionId);
  if (elizaAgentId) {
    try {
      const runtime = await agentOrchestrator.ensureAgentRuntime(elizaAgentId);
      if (runtime) {
        // Phase 4: inject services + bot data so Actions + Providers work
        const services = { db, creditNeoTokens, debitNeoTokens } as ClawvilleServices;

        // Look up the bot via its resolved agentId (e.g. milady:xxx), NOT npcId
        const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
        const bot = botConfig
          ? await db.query.openclawBots.findFirst({
              where: eq(openclawBots.agentId, botConfig.agentId),
            })
          : null;

        // World snapshot for WorldStateProvider
        let worldSnapshot: { npcs: any[] } | null = null;
        try {
          const allNpcs = npcSimulation.getAllNpcs();
          worldSnapshot = {
            npcs: allNpcs
              .filter((n: any) => !n.isDead && n.id !== npcId)
              .slice(0, 8)
              .map((n: any) => ({
                name: n.name,
                activity: n.activity ?? 'idle',
                destinationBuildingId: n.destinationBuildingId,
                isDead: n.isDead,
              })),
          };
        } catch { /* non-blocking */ }

        const state: Record<string, any> = {
          petId: bot?.id ?? npcId,
          userId: sessionId,
          services,
          petData: bot ? {
            id: bot.id,
            name: bot.name,
            species: bot.species ?? 'cat',
            neoTokens: (bot as any).neoTokens ?? 0,
            archetype: null,
          } : null,
          nearLocation: npc.destinationBuildingId ?? null,
          worldSnapshot,
          characterConfig: bot?.knowledge ? { knowledge: bot.knowledge } : {},
          userMessage: parsed.data.message,
        };

        const result = await runtime.processMessage(parsed.data.message, {
          userId: sessionId,
          roomId: `agent-gateway-${npcId}`,
          platform: 'clawville-gateway',
          dynamicContext: `You are ${npc.name} in the ClawVille world. Respond in character.`,
          state,
        });
        elizaResponse = result.content;
      }
    } catch (err) {
      console.error(`[AgentGateway] ElizaOS chat failed for ${npcId}:`, err);
    }
  }

  return c.json({ success: true, response: elizaResponse });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/visit-building
// ---------------------------------------------------------------------------
const visitSchema = z.object({
  buildingId: z.string().min(1),
});

agentGatewayRoutes.post('/:sessionId/visit-building', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = visitSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { buildingId } = parsed.data;

  const center = NPC_BUILDING_CENTERS[buildingId];
  if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);

  // Check proximity — relaxed to 2000px for early testing (TODO: tighten to 80px)
  const VISIT_RADIUS = 2000;
  const dx = npc.x - center.x;
  const dy = npc.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > VISIT_RADIUS) return c.json({ error: `Too far from ${buildingId} (${Math.round(dist)}px away, need <${VISIT_RADIUS}px)` }, 400);

  // Set building activity
  const activities = BUILDING_ACTIVITIES[buildingId] ?? ['thinking'];
  const picked = activities[Math.floor(Math.random() * activities.length)] as NpcActivity;
  npcSimulation.setNpcActivity(npcId, picked, ACTIVITY_EMOJIS[picked]);

  // Award token + extract knowledge
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  let knowledgeGained: string | null = null;
  if (theme) {
    knowledgeGained = `Visited ${theme.label}: learned about ${theme.focus.split(',')[0]}`;
  }

  // Create memory (fire-and-forget)
  memoryService.createMemory({
    entityId: npcId,
    entityType: 'npc',
    content: `Visited ${buildingId}${theme ? ` (${theme.label})` : ''}`,
    importance: 3,
    kind: 'observation',
    metadata: { buildingId, activity: picked },
  }).catch(() => {});

  // Persist knowledge to openclaw_bots table (fire-and-forget)
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig && knowledgeGained) {
    (async () => {
      try {
        const bot = await db.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, botConfig.agentId),
        });
        if (bot) {
          const current: string[] = bot.knowledge ?? [];
          if (!current.includes(knowledgeGained!)) {
            await db.update(openclawBots).set({
              knowledge: [...current, knowledgeGained!],
              updatedAt: new Date(),
            }).where(eq(openclawBots.id, bot.id));
          }
        }
      } catch (err) {
        console.error('[AgentGateway] Failed to persist knowledge:', err);
      }
    })();
  }

  return c.json({
    success: true,
    activity: picked,
    tokenAwarded: 1,
    knowledgeGained,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/combat-action
// ---------------------------------------------------------------------------
const combatActionSchema = z.object({
  action: z.enum(['attack', 'heavy', 'block', 'dodge', 'combo']),
});

agentGatewayRoutes.post('/:sessionId/combat-action', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = combatActionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  if (!npc.inCombat) return c.json({ error: 'NPC is not in combat' }, 400);

  npcSimulation.setNpcCombatAction(npcId, parsed.data.action);
  return c.json({ success: true, action: parsed.data.action });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/emote
// ---------------------------------------------------------------------------
const emoteSchema = z.object({
  activity: z.enum([
    'idle', 'walking', 'visiting', 'reading', 'sleeping',
    'eating', 'playing', 'shopping', 'chatting', 'thinking',
  ] as const),
});

agentGatewayRoutes.post('/:sessionId/emote', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = emoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId } = resolved;
  const activity = parsed.data.activity as NpcActivity;
  npcSimulation.setNpcActivity(npcId, activity, ACTIVITY_EMOJIS[activity]);
  return c.json({ success: true, activity });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/knowledge
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/knowledge', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!npcSimulation.isValidAgentSession(sessionId)) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ knowledge: [] });

  try {
    const bot = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, botConfig.agentId),
    });
    return c.json({ knowledge: bot?.knowledge ?? [] });
  } catch {
    return c.json({ knowledge: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/stats
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/stats', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId, npc } = resolved;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);

  let totalMessages = 0;
  let knowledgeLearned: string[] = [];
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        totalMessages = bot.totalMessages;
        knowledgeLearned = bot.knowledge ?? [];
      }
    } catch {}
  }

  const stats: AgentStats = {
    sessionId,
    npcId,
    tokensEarned: 0, // Tracked externally via visit-building calls
    knowledgeLearned,
    kills: npc.kills,
    level: npc.level,
    xp: npc.xp,
    totalMessages,
    sessionDuration: Date.now(), // Client can diff against their start time
  };

  return c.json(stats);
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/events  — SSE world-state push stream
// ---------------------------------------------------------------------------
// Primary subscription primitive for self-managed (nanoclaw) agents.
// Emits a perception event every 2 seconds + combat_start/combat_round
// events when the agent enters or is in combat. Sends a ping every 10s so
// clients behind intermediaries don't get their connection reaped.
//
// Session is re-validated each tick — if the bot is unregistered the stream
// ends cleanly.
agentGatewayRoutes.get('/:sessionId/events', (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId } = resolved;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (stream) => {
    let wasInCombat = false;
    let tickCount = 0;

    while (true) {
      await stream.sleep(2000);

      // Re-validate session each tick — break if expired
      const current = resolveSession(sessionId);
      if (!current) break;

      const npc = npcSimulation.getNpcById(npcId);
      if (!npc) break;

      // --- perception every 2s ---
      const perception = buildPerception(npcId);
      if (perception) {
        await stream.write(`event: perception\ndata: ${JSON.stringify(perception)}\n\n`);
      }

      // --- combat_start when inCombat flips to true ---
      if (npc.inCombat && !wasInCombat) {
        await stream.write(
          `event: combat_start\ndata: ${JSON.stringify({ npcId, combatTargetId: npc.combatTargetId ?? null })}\n\n`
        );
      }

      // --- combat_round when in combat ---
      if (npc.inCombat) {
        const combats = npcSimulation.getActiveCombats();
        const myCombat = combats.find(
          (cb) => cb.attacker === npcId || cb.defender === npcId
        );
        if (myCombat && myCombat.rounds.length > 0) {
          const lastRound = myCombat.rounds[myCombat.rounds.length - 1];
          await stream.write(
            `event: combat_round\ndata: ${JSON.stringify({ combatId: myCombat.id, round: lastRound })}\n\n`
          );
        }
      }

      wasInCombat = npc.inCombat;

      // --- ping every 10s (every 5 ticks at 2s cadence) ---
      tickCount++;
      if (tickCount % 5 === 0) {
        await stream.write(`event: ping\ndata: {}\n\n`);
      }
    }
  });
});

export { agentGatewayRoutes };
