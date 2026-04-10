import { Hono } from 'hono';
import { z } from 'zod';
import {
  NPC_BUILDING_CENTERS,
  BUILDING_OPENCLAW_THEMES,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  type NpcActivity,
  type AgentPerception,
  type AgentStats,
} from '@clawville/shared';
import { npcSimulation } from '../services/npc-simulation';
import { findPath } from '../services/pathfinding';
import { memoryService } from '../services/memory-service';
import { db, openclawBots, eq, sql } from '@clawville/database';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { getSessionAgent } from '../services/session-agent-map';

const agentGatewayRoutes = new Hono();

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
// GET /api/agent/:sessionId/perception
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/perception', (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId, npc } = resolved;
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

  const perception: AgentPerception = {
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
        const result = await runtime.processMessage(parsed.data.message, {
          userId: sessionId,
          roomId: `agent-gateway-${npcId}`,
          platform: 'clawville-gateway',
          dynamicContext: `You are ${npc.name} in the ClawVille world. You are chatting in the open world. Respond in character.`,
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

export { agentGatewayRoutes };
