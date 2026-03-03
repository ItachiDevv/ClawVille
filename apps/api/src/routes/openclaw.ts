import { Hono } from 'hono';
import { z } from 'zod';
import { NPC_IDS, BUILDING_OPENCLAW_THEMES } from '@legacyapp/shared';
import type { OpenClawRegistration, OpenClawBotIdentity } from '@legacyapp/shared';
import { OpenClawClient } from '../services/openclaw-client';
import { npcSimulation } from '../services/npc-simulation';
import { db, avatars, openclawBots, eq, sql } from '@legacyapp/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import type { AppContext } from '../types';

import { generateSkillMd } from '../services/skill-generator';

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
// Routes
// ---------------------------------------------------------------------------

const openclawRoutes = new Hono<AppContext>();

const baseSchema = z.object({
  gatewayUrl: z.string().url(),
  authToken: z.string().min(1),
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
  protocol: z.enum(['openai-compat', 'anthropic', 'custom-webhook']).optional(),
  autonomyMode: z.enum(['server-managed', 'self-managed']).optional().default('server-managed'),
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

  // Register with simulation
  try {
    npcSimulation.registerOpenClaw(config, client, restoredState);
  } catch (err: any) {
    return c.json({ error: err.message || 'Registration failed' }, 400);
  }

  return c.json(identity);
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
            updatedAt: new Date(),
          }).where(eq(openclawBots.id, existing.id));
        }
      } catch (err) {
        console.error('[OpenClaw] Failed to save disconnect state:', err);
      }
    })();
  }

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
  petContext: z.object({
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

  const { sessionId, content, petContext } = parsed.data;
  const client = npcSimulation.getOpenClawClientBySession(sessionId);
  if (!client) {
    return c.json({ error: 'OpenClaw session not found. Bot may have disconnected.' }, 404);
  }

  const systemParts: string[] = [
    `You are ${petContext?.name ?? 'a ClawVille avatar'}, a ${petContext?.species ?? 'avatar'} exploring ClawVille World — a sea-themed game for training AI agents with OpenClaw knowledge.`,
  ];
  if (petContext?.archetype) {
    systemParts.push(`Your personality archetype is "${petContext.archetype}".`);
  }
  if (petContext?.clawTokens !== undefined) {
    systemParts.push(`You have ${petContext.clawTokens} ClawTokens.`);
  }
  if (petContext?.knowledge && petContext.knowledge.length > 0) {
    systemParts.push(`OpenClaw knowledge you've learned so far:\n${petContext.knowledge.slice(0, 20).map((k) => `- ${k}`).join('\n')}`);
  }

  try {
    const reply = await client.chat([
      { role: 'system', content: systemParts.join(' ') },
      { role: 'user', content },
    ]);

    // Fire-and-forget: increment message count
    const botCfg = npcSimulation.getOpenClawBotConfig(sessionId);
    if (botCfg) {
      db.update(openclawBots).set({
        totalMessages: sql`${openclawBots.totalMessages} + 1`,
        lastSeenAt: new Date(),
      }).where(eq(openclawBots.agentId, botCfg.agentId)).catch(() => {});
    }

    return c.json({
      message: {
        role: 'assistant',
        content: reply || '...',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[OpenClaw Chat] Error:', err);
    return c.json({ error: 'OpenClaw gateway error: ' + (err.message || 'unknown') }, 502);
  }
});

// POST /api/openclaw/location-chat
const locationChatSchema = z.object({
  sessionId: z.string().min(1),
  locationId: z.string().min(1),
  content: z.string().min(1).max(4000),
  petContext: z.object({
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

  const { sessionId, locationId, content, petContext } = parsed.data;
  const client = npcSimulation.getOpenClawClientBySession(sessionId);
  if (!client) {
    return c.json({ error: 'OpenClaw session not found. Bot may have disconnected.' }, 404);
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

  if (petContext?.name) {
    systemParts.push(`The visitor is ${petContext.name}, a ${petContext.species ?? 'avatar'}.`);
  }
  if (petContext?.clawTokens !== undefined) {
    systemParts.push(`They have ${petContext.clawTokens} ClawTokens.`);
  }
  if (petContext?.knowledge && petContext.knowledge.length > 0) {
    systemParts.push(`Their current OpenClaw knowledge:\n${petContext.knowledge.slice(0, 15).map((k) => `- ${k}`).join('\n')}`);
  }

  try {
    const reply = await client.chat([
      { role: 'system', content: systemParts.join(' ') },
      { role: 'user', content },
    ]);

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
    return c.json({ error: 'OpenClaw gateway error: ' + (err.message || 'unknown') }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /api/openclaw/knowledge-export/:avatarId
// Returns learned knowledge in SKILL.md-compatible format
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

export { openclawRoutes };
