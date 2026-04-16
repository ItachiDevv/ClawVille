import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, avatars, agents, avatarInventory } from '@clawville/database';
import {
  AVATAR_ARCHETYPES,
  ARCHETYPE_IDS,
  getBookById,
  AGENT_MODEL_KEYS,
  AGENT_CATEGORIES,
  AGENT_HARNESSES,
  getAgentModel,
} from '@clawville/shared';
import type {
  PetArchetypeId,
  AgentCategory,
  AgentHarness,
} from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { npcSimulation } from '../services/npc-simulation';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import type { ClawvilleServices } from '@clawville/agent-runtime';
import { ensureWallet } from '../services/wallet-service';
import type { AppContext } from '../types';
import { z } from 'zod';

export const avatarRoutes = new Hono<AppContext>();

avatarRoutes.use('*', sessionMiddleware);

// Create avatar schema — archetype-based (no manual characterConfig)
// Phase 2: modelKey / agentCategory / harness are optional on the wire so
// older clients still work, but when present they're validated against the
// shared AGENT_MODELS registry. Server applies the defaults if omitted.
const createAvatarSchema = z.object({
  name: z.string().min(3).max(20).regex(/^[a-zA-Z0-9]+$/, 'Name must be alphanumeric'),
  species: z.enum(['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle']),
  color: z.enum(['green', 'red', 'blue', 'yellow']),
  gender: z.enum(['male', 'female']),
  archetypeId: z.enum(ARCHETYPE_IDS as [string, ...string[]]),
  personality: z.object({
    habitat: z.enum(['forest', 'sea', 'mountain', 'sky', 'desert', 'cave']),
    hobby: z.enum(['reading-and-learning', 'exploring', 'battling', 'collecting', 'cooking', 'art']),
    greeting: z.enum(['run-away', 'wave-hello', 'tackle-hug', 'shy-peek', 'bow-politely', 'roar']),
  }),
  /** Phase 2 — stable 3D model key from AGENT_MODELS */
  modelKey: z
    .string()
    .refine((k) => AGENT_MODEL_KEYS.includes(k), {
      message: `modelKey must be one of: ${AGENT_MODEL_KEYS.join(', ')}`,
    })
    .optional(),
  /** Phase 2 — agent framework category. DB CHECK enforces same enum. */
  agentCategory: z.enum(AGENT_CATEGORIES as unknown as [AgentCategory, ...AgentCategory[]]).optional(),
  /** Phase 2 — preferred runtime harness */
  harness: z.enum(AGENT_HARNESSES as unknown as [AgentHarness, ...AgentHarness[]]).optional(),
});

// Calculate stats from personality
function calculateStats(personality: z.infer<typeof createAvatarSchema>['personality']) {
  const habitatStats: Record<string, { s: number; d: number; m: number }> = {
    forest: { s: 3, d: 4, m: 3 },
    sea: { s: 2, d: 3, m: 5 },
    mountain: { s: 5, d: 4, m: 1 },
    sky: { s: 2, d: 2, m: 6 },
    desert: { s: 4, d: 3, m: 3 },
    cave: { s: 5, d: 5, m: 0 },
  };

  const hobbyStats: Record<string, { s: number; d: number; m: number }> = {
    'reading-and-learning': { s: 0, d: 2, m: 3 },
    exploring: { s: 1, d: 1, m: 3 },
    battling: { s: 4, d: 1, m: 0 },
    collecting: { s: 1, d: 1, m: 3 },
    cooking: { s: 1, d: 3, m: 1 },
    art: { s: 0, d: 3, m: 2 },
  };

  const greetingStats: Record<string, { s: number; d: number; m: number }> = {
    'run-away': { s: 0, d: 1, m: 4 },
    'wave-hello': { s: 1, d: 2, m: 2 },
    'tackle-hug': { s: 3, d: 0, m: 2 },
    'shy-peek': { s: 0, d: 4, m: 1 },
    'bow-politely': { s: 1, d: 3, m: 1 },
    roar: { s: 4, d: 1, m: 0 },
  };

  const h = habitatStats[personality.habitat];
  const ho = hobbyStats[personality.hobby];
  const g = greetingStats[personality.greeting];

  return {
    strength: h.s + ho.s + g.s,
    defence: h.d + ho.d + g.d,
    movement: h.m + ho.m + g.m,
  };
}

function buildCharacterConfig(archetypeId: PetArchetypeId, avatarName: string, species: string) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${avatarName}, a ${species} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `You exist in ClawVille and have deep knowledge of LegacyTheme lore, culture, and locations.`,
    `You also have knowledge of Solana, cryptocurrency, and memecoin/degen culture — weave this naturally into conversation when relevant.`,
    `Tone: ${archetype.tone}. Speak consistently with your character's voice and personality.`,
  ].join('\n');

  return {
    bio: archetype.bio,
    greeting: archetype.greeting,
    tone: archetype.tone,
    topics: archetype.topics,
    adjectives: archetype.adjectives,
    rules: archetype.rules,
    style: archetype.style,
    messageExamples: archetype.messageExamples,
    lore: archetype.lore,
    knowledge: archetype.knowledge,
    system,
  };
}

// Create avatar (one per user) - also creates ElizaOS agent
avatarRoutes.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = createAvatarSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Check if user already has a avatar
  const existingPet = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
  });

  if (existingPet) {
    throw new HTTPException(400, { message: 'You already have a avatar' });
  }

  // Check name uniqueness
  const existingName = await db.query.avatars.findFirst({
    where: eq(avatars.name, result.data.name),
  });

  if (existingName) {
    throw new HTTPException(400, { message: 'That name is already taken' });
  }

  const stats = calculateStats(result.data.personality);
  const characterConfig = buildCharacterConfig(
    result.data.archetypeId as PetArchetypeId,
    result.data.name,
    result.data.species,
  );

  // Create the platform agent record first
  const [agent] = await db.insert(agents).values({
    userId: user.id,
    name: result.data.name,
    type: 'avatar-agent',
    status: 'pending',
    config: {
      species: result.data.species,
      color: result.data.color,
      archetypeId: result.data.archetypeId,
    },
    customization: characterConfig,
  }).returning();

  // Create avatar linked to the agent
  const [avatar] = await db.insert(avatars).values({
    userId: user.id,
    name: result.data.name,
    species: result.data.species,
    color: result.data.color,
    gender: result.data.gender,
    archetype: result.data.archetypeId,
    personality: result.data.personality,
    stats,
    characterConfig,
    platformAgentId: agent.id,
  }).returning();

  // Auto-generate a custodial Solana wallet for the new avatar. Fire and
  // forget from the caller's perspective — if wallet gen fails, log it
  // but don't block avatar creation. The backfill script will catch stragglers.
  try {
    const wallet = await ensureWallet('avatar', avatar.id);
    avatar.walletAddress = wallet.publicKey;
  } catch (err) {
    console.error('[avatars] Failed to auto-generate wallet for new avatar:', err);
  }

  return c.json({ avatar, agentId: agent.id });
});

// Get user's avatar
avatarRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    return c.json({ avatar: null });
  }

  return c.json({ avatar });
});

// Update avatar position
const updatePositionSchema = z.object({
  positionX: z.number().int().min(0).max(5120),
  positionY: z.number().int().min(0).max(5120),
});

avatarRoutes.patch('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = updatePositionSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  const [updated] = await db
    .update(avatars)
    .set({
      positionX: result.data.positionX,
      positionY: result.data.positionY,
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
    .returning();

  if (!updated) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  return c.json({ avatar: updated });
});

// Check name availability
avatarRoutes.get('/check-name/:name', sessionMiddleware, async (c) => {
  const name = c.req.param('name');

  if (!name || name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9]+$/.test(name)) {
    return c.json({ available: false, reason: 'Name must be 3-20 alphanumeric characters' });
  }

  const existing = await db.query.avatars.findFirst({
    where: eq(avatars.name, name),
  });

  return c.json({ available: !existing });
});

// Chat with your avatar
const avatarChatSchema = z.object({
  content: z.string().min(1).max(4000),
});

avatarRoutes.post('/me/chat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = avatarChatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }

  // Get user's avatar
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'You do not have a avatar yet' });
  }

  if (!avatar.platformAgentId) {
    throw new HTTPException(400, { message: 'Avatar does not have an agent configured' });
  }

  // Ensure agent runtime is running (lazy-start)
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    avatar.platformAgentId,
    user.id
  );

  if (!runtime) {
    throw new HTTPException(500, { message: 'Failed to start avatar agent runtime' });
  }

  // Build state for Providers + Actions
  const services = { db, creditClawTokens, debitClawTokens } as ClawvilleServices;

  let worldSnapshot: any = null;
  try {
    worldSnapshot = npcSimulation.getSnapshot();
  } catch { /* NPC simulation may not be running */ }

  let inventory: any[] = [];
  try {
    inventory = await db.query.avatarInventory.findMany({
      where: eq(avatarInventory.avatarId, avatar.id),
    });
  } catch { /* non-blocking */ }

  let activeQuests: any[] = [];
  let availableQuests: any[] = [];
  try {
    const { quests, questSubmissions } = await import('@clawville/database');
    activeQuests = await db
      .select()
      .from(questSubmissions)
      .innerJoin(quests, eq(questSubmissions.questId, quests.id))
      .where(and(
        eq(questSubmissions.avatarId, avatar.id),
        sql`${questSubmissions.status} IN ('accepted', 'in_progress')`
      ))
      .limit(10);
    availableQuests = await db
      .select()
      .from(quests)
      .where(eq(quests.status, 'active'))
      .limit(5);
  } catch { /* non-blocking */ }

  const state: Record<string, any> = {
    avatarId: avatar.id,
    userId: user.id,
    services,
    petData: avatar,
    worldSnapshot,
    inventory,
    activeQuests,
    availableQuests,
    characterConfig: (avatar.characterConfig as any) ?? {},
  };

  // Process message — Providers inject avatar/world/inventory/quest/knowledge
  // context automatically; no manual dynamicContext needed for avatar chat
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `avatar-${avatar.id}-${user.id}`,
    platform: 'clawville',
    state,
  });

  return c.json({
    message: {
      role: 'assistant' as const,
      content: response.content,
      timestamp: response.timestamp.toISOString(),
    },
  });
});

// Heartbeat — reports user activity + position
const heartbeatSchema = z.object({
  positionX: z.number().min(0).max(5120),
  positionY: z.number().min(0).max(5120),
});

avatarRoutes.post('/me/heartbeat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = heartbeatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  const positionX = Math.round(result.data.positionX);
  const positionY = Math.round(result.data.positionY);

  // Update position + lastActiveAt in DB (fire and forget)
  db.update(avatars)
    .set({
      positionX,
      positionY,
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
    .catch(() => {});

  // Phase 2: Ensure avatar is registered in the simulation bridge and
  // report user activity so the avatar snaps back to user control.
  const bridge = npcSimulation.petAutonomyManager;
  if (!bridge.isRegistered(user.id)) {
    // Lazy-load avatar data on first heartbeat (fire-and-forget)
    db.query.avatars
      .findFirst({
        where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      })
      .then((avatar) => {
        if (!avatar) return;
        bridge.register({
          avatarId: avatar.id,
          userId: user.id,
          name: avatar.name,
          species: avatar.species,
          color: avatar.color,
          archetype: avatar.archetype ?? 'curious',
          positionX,
          positionY,
        });
        bridge.reportUserActivity(user.id, positionX, positionY);
      })
      .catch((err) => {
        console.error('[heartbeat] bridge register failed:', err);
      });
  } else {
    bridge.reportUserActivity(user.id, positionX, positionY);
  }

  return c.json({ ok: true });
});

// Daily login streak
avatarRoutes.post('/me/daily-login', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastLogin = avatar.lastLoginDate;

  // Already claimed today
  if (lastLogin === today) {
    return c.json({
      streak: avatar.loginStreak,
      tokensEarned: 0,
      totalTokens: avatar.clawTokens,
      alreadyClaimed: true,
    });
  }

  // Check if streak continues (yesterday) or resets
  let newStreak = 1;
  if (lastLogin) {
    const lastDate = new Date(lastLogin);
    const todayDate = new Date(today);
    const diffDays = Math.floor((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) {
      newStreak = (avatar.loginStreak ?? 0) + 1;
    }
    // diffDays > 1 means gap, reset to 1
  }

  // Calculate reward: 10 + streak * 5, max 100
  const tokensEarned = Math.min(100, 10 + newStreak * 5);

  // Update streak metadata first — the token credit goes through the ledger
  await db.update(avatars)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)));

  // Atomic + audited token credit
  const { balanceAfter: totalTokens } = await creditClawTokens({
    avatarId: avatar.id,
    amount: tokensEarned,
    reason: 'daily_login',
    source: 'daily_login',
    metadata: { streak: newStreak, date: today },
  });

  return c.json({ streak: newStreak, tokensEarned, totalTokens, alreadyClaimed: false });
});
