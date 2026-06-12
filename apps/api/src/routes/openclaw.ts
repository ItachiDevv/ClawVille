import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { NPC_IDS, BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import type { OpenClawRegistration, OpenClawBotIdentity } from '@clawville/shared';
import { OpenClawClient } from '../services/openclaw-client';
import { npcSimulation } from '../services/npc-simulation';
import { db, avatars, users, npcMemories, activityLog, openclawBots, agents, eq, and, desc, sql } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { validateLiveAgentSession } from '../middleware/require-auth-or-agent';
import type { AppContext } from '../types';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { setSessionAgent, getSessionAgent, deleteSessionAgent } from '../services/session-agent-map';
import { buildRuntimeServices } from '../services/runtime-services-adapter';
import { generateSkillMd } from '../services/skill-generator';
import { computeSessionExpiresAt } from '../services/openclaw-session-sweeper';
import { sha256Hex } from '../services/session-digest';

/** Ensure a system user exists for OpenClaw bot agents (FK requirement) */
let _systemUserId: string | null = null;
async function getOrCreateSystemUserId(): Promise<string> {
  if (_systemUserId) return _systemUserId;
  const SYSTEM_EMAIL = 'openclaw-system@clawville.internal';
  const existing = await db.query.users.findFirst({
    where: eq(users.email, SYSTEM_EMAIL),
  });
  if (existing) {
    _systemUserId = existing.id;
    return existing.id;
  }
  const [created] = await db.insert(users).values({
    email: SYSTEM_EMAIL,
    name: 'OpenClaw System',
    emailVerified: true,
  }).returning();
  _systemUserId = created.id;
  return created.id;
}

/** Extract OpenClaw knowledge keywords from a conversation response */
function extractKnowledge(response: string, locationId: string): string[] {
  if (!response) return [];

  const theme = BUILDING_OPENCLAW_THEMES[locationId];
  if (!theme) return [];

  const openclawKeywords = [
    'openclaw', 'agent', 'runtime', 'plugin', 'skill', 'action', 'provider',
    'evaluator', 'cron', 'webhook', 'memory', 'vector', 'embedding', 'rag',
    'lancdb', 'discord', 'telegram', 'twitter', 'farcaster', 'channel',
    'tool', 'function calling', 'canvas', 'visualization', 'voice', 'speech',
    'stt', 'tts', 'security', 'rbac', 'permission', 'audit', 'config',
    'deployment', 'docker', 'fleet', 'orchestration', 'character json',
    'clawhub', 'marketplace', 'skill.md', 'elizaos',
  ];

  const lowerResponse = response.toLowerCase();
  const matchedKeywords = openclawKeywords.filter((kw) => lowerResponse.includes(kw));

  if (matchedKeywords.length >= 2) {
    return [`Learned about ${theme.focus.split(',')[0]} from ${theme.label}`];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up the ElizaOS agent ID for an OpenClaw session (cache-first) */
function findElizaAgentForSession(sessionId: string): string | undefined {
  return getSessionAgent(sessionId);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const openclawRoutes = new Hono<AppContext>();

const baseSchema = z.object({
  gatewayUrl: z.string().url(),
  authToken: z.string().optional().default(''),
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
  protocol: z.enum(['openai-compat', 'anthropic', 'custom-webhook']).optional(),
  autonomyMode: z.enum(['server-managed', 'self-managed']).optional().default('server-managed'),
  modelName: z.string().max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
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
  homeX: z.number().min(32).max(5088),
  homeY: z.number().min(32).max(5088),
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
  // Hardening (Codex dual-review, 2026-06-03): this legacy /openclaw/register
  // path registers into the SAME npc-simulation map as /connect and returns the
  // session id as the X-Clawville-Agent-Session bearer credential the cove
  // trusts for real-CT play. Mint it with crypto.randomBytes (~192 bits, was
  // Date.now() + Math.random — both predictable/forgeable). `oc-` prefix kept
  // for log readability; validation is Map membership so the change is
  // transparent and old in-memory ids age out with no migration.
  const sessionId = `oc-${randomBytes(24).toString('base64url')}`;

  // Ledger-capability (Codex auth-lens fix #2/#3, 2026-06-03): the legacy
  // /openclaw/register path is UNAUTHENTICATED and upserts by caller-supplied
  // agentId with no ownership proof, so it must NEVER mint a real-CT-trusted
  // session — anyone could register a known agentId and inherit a victim's
  // bound avatar's CT. Sessions from this path are non-ledger by default: they
  // can perceive/chat/move, but the cove getSubject rejects them with 403. A
  // real-CT-capable session is only minted via the owned-connection-token flow
  // on /api/agent/connect or the ed25519 partner-signed Hatcher path.
  //
  // Rebind hardening (round 2, 2026-06-03): `boundUserId: null` keeps these
  // fail-closed at the resolveAgentSession rebind backstop too. NOTE on Option B
  // (eviction): this path NEVER writes `openclaw_bots.userId` (see the upsert
  // below — neither branch sets it), so it can never REBIND a row's owner. We
  // therefore do NOT evict prior sessions here: a blanket eviction would let an
  // unauthenticated caller knock a victim's legitimate live (ledger-capable)
  // session out of the map just by re-registering the victim's known agentId — a
  // griefing/DoS vector. No rebind happens, so no eviction is warranted.
  const config: OpenClawRegistration = {
    ...data,
    sessionId,
    ledgerCapable: false,
    boundUserId: null,
  } as OpenClawRegistration;

  // Test connectivity (skip if skipPing query param is set — for testing)
  const client = new OpenClawClient(config);
  const skipPing = c.req.query('skipPing') === '1';
  if (!skipPing) {
    const alive = await client.ping();
    if (!alive) {
      return c.json({ error: 'Cannot connect to OpenClaw gateway. Check URL and auth token.' }, 502);
    }
  }

  // Upsert openclaw_bots by agentId
  let identity: OpenClawBotIdentity;
  let restoredState: { lastX?: number; lastY?: number; knowledge?: string[] } | undefined;

  try {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, data.agentId),
    });

    if (existing) {
      // Returning bot — increment sessions, update gateway
      await db.update(openclawBots).set({
        gatewayUrl: data.gatewayUrl,
        protocol: data.protocol ?? 'openai-compat',
        mode: data.mode,
        targetNpcId: data.mode === 'override' ? data.targetNpcId : null,
        name: data.mode === 'avatar' ? data.name : existing.name,
        species: data.mode === 'avatar' ? data.species : existing.species,
        color: data.mode === 'avatar' ? data.color : existing.color,
        totalSessions: (existing.totalSessions ?? 0) + 1,
        lastSeenAt: new Date(),
        // Phase 6 — fresh 24h TTL on every legacy /openclaw/register too.
        sessionExpiresAt: computeSessionExpiresAt(),
        // Restart survival (2026-06-11) — one-way hash of this register's
        // bearer so the session restores from the row after an API restart.
        sessionKeyHash: sha256Hex(sessionId),
        // Phase 6.1 — clear sweptAt so the next expiration emits exactly
        // one event. Same rationale as the /api/agent/connect path.
        sessionSweptAt: null,
        updatedAt: new Date(),
      }).where(eq(openclawBots.id, existing.id));

      const meta = existing.metadata as any;
      if (data.mode === 'avatar' && meta?.lastX != null && meta?.lastY != null) {
        restoredState = { lastX: meta.lastX, lastY: meta.lastY, knowledge: existing.knowledge ?? [] };
      }

      identity = {
        botId: existing.id,
        agentId: data.agentId,
        sessionId,
        mode: data.mode,
        isReturning: true,
        totalSessions: (existing.totalSessions ?? 0) + 1,
        knowledge: existing.knowledge ?? [],
      };
    } else {
      // New bot
      const avatarMeta = data.mode === 'avatar' ? {
        personality: data.personality,
        homeX: data.homeX,
        homeY: data.homeY,
        patrolRadius: data.patrolRadius,
        stats: data.stats,
      } : undefined;

      const [inserted] = await db.insert(openclawBots).values({
        agentId: data.agentId,
        gatewayUrl: data.gatewayUrl,
        protocol: data.protocol ?? 'openai-compat',
        mode: data.mode,
        targetNpcId: data.mode === 'override' ? data.targetNpcId : null,
        name: data.mode === 'avatar' ? data.name : null,
        species: data.mode === 'avatar' ? data.species : null,
        color: data.mode === 'avatar' ? data.color : null,
        metadata: avatarMeta,
        totalSessions: 1,
        // Phase 6 — initial 24h TTL so the sweeper reaps dormant rows.
        sessionExpiresAt: computeSessionExpiresAt(),
        // Restart survival (2026-06-11) — one-way hash of this register's
        // bearer so the session restores from the row after an API restart.
        sessionKeyHash: sha256Hex(sessionId),
      }).returning();

      identity = {
        botId: inserted.id,
        agentId: data.agentId,
        sessionId,
        mode: data.mode,
        isReturning: false,
        totalSessions: 1,
        knowledge: [],
      };
    }
  } catch (err: any) {
    console.error('[OpenClaw] DB upsert error:', err);
    // Fall back to ephemeral-only if DB fails
    identity = {
      botId: '',
      agentId: data.agentId,
      sessionId,
      mode: data.mode,
      isReturning: false,
      totalSessions: 0,
      knowledge: [],
    };
  }

  // Create/update platformAgents record for ElizaOS runtime
  let elizaAgentId: string | undefined;
  if (identity.botId) {
    try {
      const systemUserId = await getOrCreateSystemUserId();
      const agentName = data.mode === 'avatar' ? data.name : `oc-${data.agentId}`;
      const gatewayConfig = {
        gatewayUrl: data.gatewayUrl,
        authToken: data.authToken,
        agentId: data.agentId,
        protocol: data.protocol ?? 'openai-compat',
        modelName: data.modelName,
        timeoutMs: data.timeoutMs,
        maxTokens: data.maxTokens,
      };
      const customization: Record<string, unknown> = {
        personality: data.mode === 'avatar' ? data.personality : undefined,
        bio: [`An OpenClaw-connected bot: ${agentName}`],
        system: `You are ${agentName}, an AI agent connected via the OpenClaw gateway in ClawVille World — a sea-themed 3D game for training AI agents with OpenClaw knowledge.`,
        gateway: gatewayConfig,
      };
      const agentConfig: Record<string, unknown> = {
        openclawBotId: identity.botId,
      };

      // Find existing platformAgent by matching openclawBotId (stable across sessions)
      const allOcAgents = await db.select().from(agents).where(
        and(eq(agents.type, 'openclaw-bot'), eq(agents.userId, systemUserId))
      );
      const existingAgent = allOcAgents.find(
        (a) => (a.config as any)?.openclawBotId === identity.botId
      ) ?? null;

      if (existingAgent) {
        // Stop stale runtime if it's still cached in the orchestrator
        try { await agentOrchestrator.stopAgent(existingAgent.id); } catch { /* already stopped */ }

        await db.update(agents).set({
          name: agentName,
          customization,
          config: agentConfig,
          status: 'stopped',
          updatedAt: new Date(),
        }).where(eq(agents.id, existingAgent.id));
        elizaAgentId = existingAgent.id;
      } else {
        const [inserted] = await db.insert(agents).values({
          userId: systemUserId,
          name: agentName,
          type: 'openclaw-bot',
          status: 'pending',
          customization,
          config: agentConfig,
        }).returning();
        elizaAgentId = inserted.id;
      }

      // Cache the session→agent mapping
      setSessionAgent(sessionId, elizaAgentId);
      console.log(`[OpenClaw] Created/updated platformAgent ${elizaAgentId} for bot ${data.agentId}`);
    } catch (err: any) {
      console.error('[OpenClaw] Failed to create platformAgent:', err);
      // Non-fatal — bot can still work via direct client
    }
  }

  // Register with simulation
  try {
    npcSimulation.registerOpenClaw(config, client, restoredState);
  } catch (err: any) {
    return c.json({ error: err.message || 'Registration failed' }, 400);
  }

  return c.json({ ...identity, elizaAgentId });
});

// DELETE /api/openclaw/unregister/:sessionId
openclawRoutes.delete('/unregister/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  // Save avatar position before removing from simulation
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig) {
    const pos = botConfig.mode === 'avatar' ? npcSimulation.getOpenClawAvatarPosition(sessionId) : null;
    // Fire-and-forget: persist last position + update lastSeenAt
    (async () => {
      try {
        const existing = await db.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, botConfig.agentId),
        });
        if (existing) {
          const meta = (existing.metadata as any) ?? {};
          if (pos) {
            meta.lastX = pos.x;
            meta.lastY = pos.y;
          }
          await db.update(openclawBots).set({
            metadata: meta,
            lastSeenAt: new Date(),
            // Phase 6 — explicit unregister flips session to expired
            // immediately so /session-status answers 410 on the next
            // poll without waiting for the 24h TTL.
            sessionExpiresAt: new Date(),
            // Phase 6.1 — also stamp sweptAt so the sweeper doesn't
            // re-emit `agent.session.expired` for a row that was
            // explicitly disconnected (the unregister handler is the
            // canonical "gone" signal here).
            sessionSweptAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(openclawBots.id, existing.id));
        }
      } catch (err) {
        console.error('[OpenClaw] Failed to save disconnect state:', err);
      }
    })();
  }

  // Stop ElizaOS runtime for this bot (let it re-lazy-start next session)
  const elizaAgentId = getSessionAgent(sessionId);
  if (elizaAgentId) {
    agentOrchestrator.stopAgent(elizaAgentId).catch((err) => {
      console.error('[OpenClaw] Failed to stop ElizaOS agent on unregister:', err);
    });
    deleteSessionAgent(sessionId);
  }

  const removed = npcSimulation.unregisterOpenClaw(sessionId);
  if (!removed) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json({ success: true });
});

// GET /api/openclaw/active — PUBLIC world-view roster.
//
// SECURITY (Codex auth-lens fix #1, 2026-06-03): this endpoint is unauthenticated,
// so it must never leak a session id. The session id is the bearer credential the
// cove trusts for real-CT play; this previously returned the raw `sessionId` and
// also embedded it inside the avatar `npcId` (`oc-${sid}`), letting anyone harvest
// live bearer creds + spend a victim's real CT. `getActiveOpenClawBots()` now emits
// only non-secret identifiers (public `agentId` + override `targetNpcId`). Do NOT
// add the session id back to this shape.
openclawRoutes.get('/active', (c) => {
  const bots = npcSimulation.getActiveOpenClawBots();
  return c.json({ bots });
});

// GET /api/openclaw/bot/:agentId — public bot profile
openclawRoutes.get('/bot/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, agentId),
  });
  if (!bot) {
    return c.json({ error: 'Bot not found' }, 404);
  }
  return c.json({
    agentId: bot.agentId,
    name: bot.name,
    species: bot.species,
    mode: bot.mode,
    protocol: bot.protocol,
    totalSessions: bot.totalSessions,
    totalMessages: bot.totalMessages,
    knowledgeCount: (bot.knowledge ?? []).length,
    lastSeenAt: bot.lastSeenAt.toISOString(),
    createdAt: bot.createdAt.toISOString(),
  });
});

// POST /api/openclaw/chat
const chatSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1).max(4000),
  avatarContext: z.object({
    name: z.string(),
    species: z.string(),
    archetype: z.string().optional(),
    clawTokens: z.number().optional(),
    knowledge: z.array(z.string()).optional(),
  }).optional(),
});

openclawRoutes.post('/chat', async (c) => {
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { sessionId, content, avatarContext } = parsed.data;

  // Fail-closed liveness gate BEFORE the map-only client lookup or any TTL
  // slide (Codex auth-lens fix #2, 2026-06-03). The previous code trusted bare
  // Map membership (`getOpenClawClientBySession`) and then refreshed
  // `openclaw_bots.session_expires_at` at the end of the handler — so an
  // EXPIRED-but-still-in-memory session could call /chat to RESURRECT its 24h
  // TTL and then pass the cove's `session_expires_at > now` validation. Route
  // through the SAME shared validator every other bearer path uses (Map
  // membership AND DB `session_expires_at > now`, NULL = expired, unregisters a
  // stale body) so an expired session is rejected here and never slid forward.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json(
      {
        error: 'Agent session not found or expired. Reconnect your agent.',
        code: 'agent_session_not_found',
      },
      404,
    );
  }
  const client = npcSimulation.getOpenClawClientBySession(sessionId);
  if (!client) {
    return c.json(
      {
        error: 'Agent session not found. Your agent may have disconnected.',
        code: 'agent_session_not_found',
      },
      404,
    );
  }

  // Look up actual bot data from DB instead of trusting client avatarContext
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  const bot = botConfig
    ? await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      })
    : null;

  // Use DB data, fall back to client avatarContext only for display name/species
  const botName = bot?.name ?? avatarContext?.name ?? 'agent';
  const botKnowledge: string[] = bot?.knowledge ?? avatarContext?.knowledge ?? [];

  // Dynamic context — only non-Provider extras (archetype hint, no token/knowledge duplication)
  const contextParts: string[] = [];
  if (avatarContext?.archetype) {
    contextParts.push(`Personality archetype: "${avatarContext.archetype}".`);
  }

  // Try ElizaOS runtime first
  let reply: string | undefined;
  const elizaAgentId = findElizaAgentForSession(sessionId);
  if (elizaAgentId) {
    try {
      const runtime = await agentOrchestrator.ensureAgentRuntime(elizaAgentId);
      if (runtime) {
        const services = buildRuntimeServices(db);
        const state: Record<string, any> = {
          avatarId: bot?.id ?? sessionId,
          userId: botName,
          services,
          avatarData: bot ? {
            id: bot.id,
            name: bot.name,
            species: bot.species ?? avatarContext?.species ?? 'cat',
            clawTokens: (bot as any).clawTokens ?? 0,
          } : null,
          characterConfig: { knowledge: botKnowledge },
          userMessage: content,
        };
        const result = await runtime.processMessage(content, {
          userId: botName,
          dynamicContext: contextParts.length > 0 ? contextParts.join('\n') : undefined,
          state,
        });
        reply = result.content;
        console.log(`[OpenClaw Chat] Routed through ElizaOS agent ${elizaAgentId}`);
      }
    } catch (err) {
      console.warn(`[OpenClaw Chat] ElizaOS fallback for ${elizaAgentId}:`, err);
    }
  }

  // Fallback to direct client
  if (!reply) {
    const systemParts: string[] = [
      `You are ${avatarContext?.name ?? 'a ClawVille avatar'}, a ${avatarContext?.species ?? 'avatar'} exploring ClawVille World — a sea-themed 3D game for training AI agents with OpenClaw knowledge.`,
      ...contextParts,
    ];
    try {
      reply = await client.chat([
        { role: 'system', content: systemParts.join(' ') },
        { role: 'user', content },
      ]);
    } catch (err: any) {
      console.error('[OpenClaw Chat] Error:', err);
      return c.json({ error: 'Agent gateway error: ' + (err.message || 'unknown'), code: 'agent_gateway_error' }, 502);
    }
  }

  // Fire-and-forget: increment message count
  const botCfg = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botCfg) {
    db.update(openclawBots).set({
      totalMessages: sql`${openclawBots.totalMessages} + 1`,
      lastSeenAt: new Date(),
      // Phase 6 — slide the 24h session TTL forward on every chat.
      sessionExpiresAt: computeSessionExpiresAt(),
    }).where(eq(openclawBots.agentId, botCfg.agentId)).catch(() => {});
  }

  return c.json({
    message: {
      role: 'assistant',
      content: reply || '...',
      timestamp: new Date().toISOString(),
    },
  });
});

// POST /api/openclaw/location-chat
const locationChatSchema = z.object({
  sessionId: z.string().min(1),
  locationId: z.string().min(1),
  content: z.string().min(1).max(4000),
  avatarContext: z.object({
    name: z.string(),
    species: z.string(),
    archetype: z.string().optional(),
    clawTokens: z.number().optional(),
    knowledge: z.array(z.string()).optional(),
  }).optional(),
});

openclawRoutes.post('/location-chat', sessionMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = locationChatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { sessionId, locationId, content, avatarContext } = parsed.data;

  // Fail-closed liveness gate BEFORE the map-only client lookup or any TTL
  // slide (Codex auth-lens fix #2, 2026-06-03 — same vector as /chat). An
  // expired-but-in-map session must not be able to call /location-chat to
  // refresh `session_expires_at` and then pass cove validation.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json(
      {
        error: 'Agent session not found or expired. Reconnect your agent.',
        code: 'agent_session_not_found',
      },
      404,
    );
  }
  const client = npcSimulation.getOpenClawClientBySession(sessionId);
  if (!client) {
    return c.json(
      {
        error: 'Agent session not found. Your agent may have disconnected.',
        code: 'agent_session_not_found',
      },
      404,
    );
  }

  const buildingTheme = BUILDING_OPENCLAW_THEMES[locationId];
  const systemParts: string[] = [];

  if (buildingTheme) {
    systemParts.push(
      `You are a teacher at the ${buildingTheme.label} in ClawVille World — an OpenClaw agent training game.`,
      `Your specialty is: ${buildingTheme.focus}.`,
      `Teach the visitor about these topics through conversation. Be helpful and educational.`
    );
  } else {
    systemParts.push('You are an NPC in ClawVille World — an OpenClaw agent training game.');
  }

  // Look up actual bot data from DB (same as /chat endpoint)
  const locBotConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  const locBot = locBotConfig
    ? await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, locBotConfig.agentId),
      })
    : null;

  const locBotName = locBot?.name ?? avatarContext?.name ?? 'visitor';

  if (locBotName) {
    systemParts.push(`The visitor is ${locBotName}, a ${locBot?.species ?? avatarContext?.species ?? 'avatar'}.`);
  }
  // ClawTokens and knowledge are handled by Providers — no manual duplication

  let reply: string | undefined;

  // Try ElizaOS runtime first
  const elizaAgentId = findElizaAgentForSession(sessionId);
  if (elizaAgentId) {
    try {
      const runtime = await agentOrchestrator.ensureAgentRuntime(elizaAgentId);
      if (runtime) {
        const locServices = buildRuntimeServices(db);
        const locState: Record<string, any> = {
          avatarId: locBot?.id ?? sessionId,
          userId: locBotName,
          services: locServices,
          avatarData: locBot ? {
            id: locBot.id,
            name: locBot.name,
            species: locBot.species ?? 'cat',
            clawTokens: (locBot as any).clawTokens ?? 0,
          } : null,
          nearLocation: locationId,
          characterConfig: { knowledge: locBot?.knowledge ?? avatarContext?.knowledge ?? [] },
          userMessage: content,
        };
        const result = await runtime.processMessage(content, {
          userId: locBotName,
          dynamicContext: systemParts.join('\n'),
          state: locState,
        });
        reply = result.content;
        console.log(`[OpenClaw Location Chat] Routed through ElizaOS agent ${elizaAgentId}`);
      }
    } catch (err) {
      console.warn(`[OpenClaw Location Chat] ElizaOS fallback for ${elizaAgentId}:`, err);
    }
  }

  // Fallback to direct client
  if (!reply) {
    try {
      reply = await client.chat([
        { role: 'system', content: systemParts.join(' ') },
        { role: 'user', content },
      ]);
    } catch (err: any) {
      console.error('[OpenClaw Location Chat] Error:', err);
      return c.json({ error: 'Agent gateway error: ' + (err.message || 'unknown'), code: 'agent_gateway_error' }, 502);
    }
  }

  try {
    const knowledgeLearned = extractKnowledge(reply, locationId);

    if (knowledgeLearned.length > 0) {
      const user = c.get('user');
      if (user) {
        const avatar = await db.query.avatars.findFirst({
          where: eq(avatars.userId, user.id),
        });
        if (avatar) {
          const currentConfig = (avatar.characterConfig as any) ?? {};
          const currentKnowledge: string[] = currentConfig.knowledge ?? [];
          const newEntries = knowledgeLearned.filter(
            (entry) => !currentKnowledge.includes(entry)
          );
          if (newEntries.length > 0) {
            const mergedKnowledge = [...currentKnowledge, ...newEntries];
            await db.update(avatars).set({
              characterConfig: { ...currentConfig, knowledge: mergedKnowledge },
              updatedAt: new Date(),
            }).where(eq(avatars.id, avatar.id));
          }
        }
      }

      // Also persist knowledge to openclaw_bots table (fire-and-forget)
      const botCfg = npcSimulation.getOpenClawBotConfig(sessionId);
      if (botCfg) {
        (async () => {
          try {
            const bot = await db.query.openclawBots.findFirst({
              where: eq(openclawBots.agentId, botCfg.agentId),
            });
            if (bot) {
              const currentBotKnowledge: string[] = bot.knowledge ?? [];
              const newBotEntries = knowledgeLearned.filter((e) => !currentBotKnowledge.includes(e));
              if (newBotEntries.length > 0) {
                await db.update(openclawBots).set({
                  knowledge: [...currentBotKnowledge, ...newBotEntries],
                  updatedAt: new Date(),
                }).where(eq(openclawBots.id, bot.id));
              }
            }
          } catch (err) {
            console.error('[OpenClaw] Failed to persist bot knowledge:', err);
          }
        })();
      }
    }

    // Fire-and-forget: increment message count
    const locBotCfg = npcSimulation.getOpenClawBotConfig(sessionId);
    if (locBotCfg) {
      db.update(openclawBots).set({
        totalMessages: sql`${openclawBots.totalMessages} + 1`,
        lastSeenAt: new Date(),
        // Phase 6 — slide the 24h session TTL forward on every chat.
        sessionExpiresAt: computeSessionExpiresAt(),
      }).where(eq(openclawBots.agentId, locBotCfg.agentId)).catch(() => {});
    }

    return c.json({
      message: {
        role: 'assistant',
        content: reply || '...',
        timestamp: new Date().toISOString(),
      },
      knowledgeLearned,
    });
  } catch (err: any) {
    console.error('[OpenClaw Location Chat] Error:', err);
    return c.json({ error: 'Agent gateway error: ' + (err.message || 'unknown'), code: 'agent_gateway_error' }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /api/openclaw/knowledge-export/:avatarId
// Returns learned knowledge in SKILL.md-compatible format (upgraded)
// ---------------------------------------------------------------------------
openclawRoutes.get('/knowledge-export/:avatarId', async (c) => {
  const avatarId = c.req.param('avatarId');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(avatarId)) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const [avatar] = await db.select().from(avatars).where(eq(avatars.id, avatarId)).limit(1);
  if (!avatar) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const config = avatar.characterConfig;
  const knowledge: string[] = config?.knowledge ?? [];
  const topics: string[] = config?.topics ?? [];
  const lore: string[] = config?.lore ?? [];
  const bio: string[] = config?.bio ?? [];
  const style = config?.style;

  const { markdown, installPath, publishCommand } = generateSkillMd({
    avatarName: avatar.name,
    species: avatar.species,
    archetype: avatar.archetype ?? 'unknown',
    avatarId: avatar.id,
    clawTokens: avatar.clawTokens ?? 0,
    bio,
    knowledge,
    topics,
    lore,
    style,
  });

  const format = c.req.query('format');
  if (format === 'markdown' || format === 'md') {
    return c.text(markdown, 200, { 'Content-Type': 'text/markdown' });
  }

  return c.json({
    avatarId: avatar.id,
    avatarName: avatar.name,
    species: avatar.species,
    archetype: avatar.archetype,
    clawTokens: avatar.clawTokens,
    knowledge,
    topics,
    lore,
    bio,
    skillMd: markdown,
    installPath,
    publishCommand,
    exportedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/openclaw/generate-skill
// Generate a customized SKILL.md with user overrides
// ---------------------------------------------------------------------------
const generateSkillSchema = z.object({
  customName: z.string().max(60).optional(),
  customDescription: z.string().max(200).optional(),
  customInstructions: z.string().max(2000).optional(),
  selectedKnowledge: z.array(z.string()).optional(),
  format: z.enum(['elizaos', 'openclaw']).optional(),
});

openclawRoutes.post('/generate-skill', requireAuth, async (c) => {
  const body = await c.req.json();
  const parsed = generateSkillSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const user = c.get('user');
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
  });
  if (!avatar) {
    return c.json({ error: 'No avatar found' }, 404);
  }

  const config = avatar.characterConfig;
  const { customName, customDescription, customInstructions, selectedKnowledge, format } = parsed.data;

  const result = generateSkillMd({
    avatarName: avatar.name,
    species: avatar.species,
    archetype: avatar.archetype ?? 'unknown',
    avatarId: avatar.id,
    clawTokens: avatar.clawTokens ?? 0,
    bio: config?.bio ?? [],
    knowledge: config?.knowledge ?? [],
    topics: config?.topics ?? [],
    lore: config?.lore ?? [],
    style: config?.style,
    customName,
    customDescription,
    customInstructions,
    selectedKnowledge,
    format,
  });

  return c.json({
    skillMd: result.markdown,
    characterJson: result.characterJson,
    installPath: result.installPath,
    publishCommand: result.publishCommand,
  });
});

// ---------------------------------------------------------------------------
// GET /api/openclaw/memory-export/:avatarId
// Export avatar memories as daily logs + long-term MEMORY.md
// ---------------------------------------------------------------------------
openclawRoutes.get('/memory-export/:avatarId', sessionMiddleware, async (c) => {
  const avatarId = c.req.param('avatarId');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(avatarId)) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const [avatar] = await db.select().from(avatars).where(eq(avatars.id, avatarId)).limit(1);
  if (!avatar) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  // Fetch memories for this avatar
  const memories = await db
    .select()
    .from(npcMemories)
    .where(and(eq(npcMemories.entityId, avatarId), eq(npcMemories.entityType, 'avatar')))
    .orderBy(desc(npcMemories.createdAt))
    .limit(500);

  // Fetch activity log for this avatar
  const activities = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.avatarId, avatarId))
    .orderBy(desc(activityLog.createdAt))
    .limit(500);

  // Group memories and activities by date for daily logs
  const dailyMap = new Map<string, { memories: typeof memories; activities: typeof activities }>();

  for (const mem of memories) {
    const date = mem.createdAt.toISOString().split('T')[0];
    if (!dailyMap.has(date)) dailyMap.set(date, { memories: [], activities: [] });
    dailyMap.get(date)!.memories.push(mem);
  }

  for (const act of activities) {
    const date = act.createdAt.toISOString().split('T')[0];
    if (!dailyMap.has(date)) dailyMap.set(date, { memories: [], activities: [] });
    dailyMap.get(date)!.activities.push(act);
  }

  // Build daily logs
  const dailyLogs: Array<{ date: string; filename: string; content: string }> = [];
  const sortedDates = [...dailyMap.keys()].sort().reverse();

  for (const date of sortedDates) {
    const day = dailyMap.get(date)!;
    const logLines: string[] = [
      `# ${avatar.name} - Daily Log ${date}`,
      '',
    ];

    if (day.memories.length > 0) {
      logLines.push('## Conversations');
      logLines.push('');
      for (const mem of day.memories) {
        const time = mem.createdAt.toISOString().split('T')[1]?.slice(0, 5) ?? '00:00';
        logLines.push(`- [${time}] ${mem.content} (importance: ${mem.importance}/9)`);
      }
      logLines.push('');
    }

    if (day.activities.length > 0) {
      logLines.push('## Activities');
      logLines.push('');
      for (const act of day.activities) {
        const time = act.createdAt.toISOString().split('T')[1]?.slice(0, 5) ?? '00:00';
        const tokens = act.tokensEarned > 0 ? ` (+${act.tokensEarned} ClawTokens)` : '';
        logLines.push(`- [${time}] ${act.description}${tokens}`);
      }
      logLines.push('');
    }

    dailyLogs.push({
      date,
      filename: `memory/${date}.md`,
      content: logLines.join('\n'),
    });
  }

  // Build long-term MEMORY.md
  const ltLines: string[] = [
    `# ${avatar.name} — Long-Term Memory`,
    '',
    `> Species: ${avatar.species} | Archetype: ${avatar.archetype} | ClawTokens: ${avatar.clawTokens}`,
    '',
  ];

  // High-importance memories (>=7)
  const importantMemories = memories.filter((m) => m.importance >= 7);
  if (importantMemories.length > 0) {
    ltLines.push('## Key Memories');
    ltLines.push('');
    for (const mem of importantMemories.slice(0, 30)) {
      ltLines.push(`- ${mem.content}`);
    }
    ltLines.push('');
  }

  // Knowledge summary grouped by building theme
  const knowledge: string[] = avatar.characterConfig?.knowledge ?? [];
  if (knowledge.length > 0) {
    ltLines.push('## Knowledge Summary');
    ltLines.push('');

    const grouped: Record<string, string[]> = {};
    const ungrouped: string[] = [];
    for (const entry of knowledge) {
      const match = entry.match(/from\s+(.+)$/i);
      if (match) {
        const source = match[1].trim();
        if (!grouped[source]) grouped[source] = [];
        grouped[source].push(entry);
      } else {
        ungrouped.push(entry);
      }
    }

    for (const [source, entries] of Object.entries(grouped)) {
      ltLines.push(`### ${source}`);
      for (const e of entries) ltLines.push(`- ${e}`);
      ltLines.push('');
    }
    if (ungrouped.length > 0) {
      ltLines.push('### General');
      for (const e of ungrouped) ltLines.push(`- ${e}`);
      ltLines.push('');
    }
  }

  // Behavioral patterns
  const buildingVisits: Record<string, number> = {};
  let totalTokens = 0;
  for (const act of activities) {
    totalTokens += act.tokensEarned;
    if (act.activityType === 'visited_building') {
      const building = (act.metadata as any)?.buildingId ?? act.description;
      buildingVisits[building] = (buildingVisits[building] ?? 0) + 1;
    }
  }

  ltLines.push('## Behavioral Patterns');
  ltLines.push('');
  ltLines.push(`- Total activities: ${activities.length}`);
  ltLines.push(`- Total ClawTokens earned: ${totalTokens}`);
  ltLines.push(`- Total conversations remembered: ${memories.length}`);

  const topBuildings = Object.entries(buildingVisits)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (topBuildings.length > 0) {
    ltLines.push(`- Most visited: ${topBuildings.map(([b, c]) => `${b} (${c}x)`).join(', ')}`);
  }
  ltLines.push('');

  return c.json({
    avatarId: avatar.id,
    avatarName: avatar.name,
    dailyLogs,
    longTermMemory: ltLines.join('\n'),
    totalMemories: memories.length,
    totalActivities: activities.length,
  });
});

export { openclawRoutes };
