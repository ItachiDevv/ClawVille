import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, pets, agents, petInventory } from '@clawville/database';
import { PET_ARCHETYPES, ARCHETYPE_IDS, getBookById } from '@clawville/shared';
import type { PetArchetypeId } from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { npcSimulation } from '../services/npc-simulation';
import type { AppContext } from '../types';
import { z } from 'zod';

export const petRoutes = new Hono<AppContext>();

petRoutes.use('*', sessionMiddleware);

// Create pet schema — archetype-based (no manual characterConfig)
const createPetSchema = z.object({
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
});

// Calculate stats from personality
function calculateStats(personality: z.infer<typeof createPetSchema>['personality']) {
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

function buildCharacterConfig(archetypeId: PetArchetypeId, petName: string, species: string) {
  const archetype = PET_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${petName}, a ${species} in the sea-themed world of ClawVille — a virtual pet adventure where agents learn OpenClaw skills.`,
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

// Create pet (one per user) - also creates ElizaOS agent
petRoutes.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = createPetSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Check if user already has a pet
  const existingPet = await db.query.pets.findFirst({
    where: eq(pets.userId, user.id),
  });

  if (existingPet) {
    throw new HTTPException(400, { message: 'You already have a pet' });
  }

  // Check name uniqueness
  const existingName = await db.query.pets.findFirst({
    where: eq(pets.name, result.data.name),
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
    type: 'pet-agent',
    status: 'pending',
    config: {
      species: result.data.species,
      color: result.data.color,
      archetypeId: result.data.archetypeId,
    },
    customization: characterConfig,
  }).returning();

  // Create pet linked to the agent
  const [pet] = await db.insert(pets).values({
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

  return c.json({ pet, agentId: agent.id });
});

// Get user's pet
petRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    return c.json({ pet: null });
  }

  return c.json({ pet });
});

// Update pet position
const updatePositionSchema = z.object({
  positionX: z.number().int().min(0),
  positionY: z.number().int().min(0),
});

petRoutes.patch('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = updatePositionSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  const [updated] = await db
    .update(pets)
    .set({
      positionX: result.data.positionX,
      positionY: result.data.positionY,
      updatedAt: new Date(),
    })
    .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)))
    .returning();

  if (!updated) {
    throw new HTTPException(404, { message: 'Pet not found' });
  }

  return c.json({ pet: updated });
});

// Check name availability
petRoutes.get('/check-name/:name', sessionMiddleware, async (c) => {
  const name = c.req.param('name');

  if (!name || name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9]+$/.test(name)) {
    return c.json({ available: false, reason: 'Name must be 3-20 alphanumeric characters' });
  }

  const existing = await db.query.pets.findFirst({
    where: eq(pets.name, name),
  });

  return c.json({ available: !existing });
});

// Chat with your pet
const petChatSchema = z.object({
  content: z.string().min(1).max(4000),
});

petRoutes.post('/me/chat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = petChatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }

  // Get user's pet
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'You do not have a pet yet' });
  }

  if (!pet.platformAgentId) {
    throw new HTTPException(400, { message: 'Pet does not have an agent configured' });
  }

  // Ensure agent runtime is running (lazy-start)
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    pet.platformAgentId,
    user.id
  );

  if (!runtime) {
    throw new HTTPException(500, { message: 'Failed to start pet agent runtime' });
  }

  // Build dynamic context for the pet
  const dynamicContextParts: string[] = [];

  // Token balance
  dynamicContextParts.push(`Your owner has ${pet.clawTokens} ClawTokens.`);

  // Knowledge / learned books
  const characterConfig = (pet.characterConfig as any) ?? {};
  const knowledgeCount = (characterConfig.knowledge as string[] | undefined)?.length ?? 0;
  if (knowledgeCount > 0) {
    dynamicContextParts.push(
      `You have studied ${knowledgeCount} knowledge entries and can discuss them knowledgeably.`
    );
  }

  // World state context (NPCs + activities)
  try {
    const snapshot = npcSimulation.getSnapshot();
    const npcSummaries = snapshot.npcs
      .filter((n: any) => !n.isDead)
      .slice(0, 8)
      .map((n: any) => `${n.name} is ${n.activity ?? 'idle'}${n.destinationBuildingId ? ` near ${n.destinationBuildingId}` : ''}`);
    if (npcSummaries.length > 0) {
      dynamicContextParts.push(`[World activity]\n${npcSummaries.join('. ')}.`);
    }
  } catch (_) {
    // NPC simulation may not be running
  }

  const dynamicContext = dynamicContextParts.join('\n');

  // Process message with dynamic context
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `pet-${pet.id}-${user.id}`,
    platform: 'clawville',
    dynamicContext,
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
  positionX: z.number().min(0).max(1280),
  positionY: z.number().min(0).max(800),
});

petRoutes.post('/me/heartbeat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = heartbeatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  // Update position + lastActiveAt in DB (fire and forget)
  db.update(pets)
    .set({
      positionX: Math.round(result.data.positionX),
      positionY: Math.round(result.data.positionY),
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)))
    .catch(() => {});

  return c.json({ ok: true });
});

// Daily login streak
petRoutes.post('/me/daily-login', requireAuth, async (c) => {
  const user = c.get('user');

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'No pet found' });
  }

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastLogin = pet.lastLoginDate;

  // Already claimed today
  if (lastLogin === today) {
    return c.json({
      streak: pet.loginStreak,
      tokensEarned: 0,
      totalTokens: pet.clawTokens,
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
      newStreak = (pet.loginStreak ?? 0) + 1;
    }
    // diffDays > 1 means gap, reset to 1
  }

  // Calculate reward: 10 + streak * 5, max 100
  const tokensEarned = Math.min(100, 10 + newStreak * 5);
  const totalTokens = (pet.clawTokens ?? 100) + tokensEarned;

  await db.update(pets)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      clawTokens: totalTokens,
      updatedAt: new Date(),
    })
    .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)));

  return c.json({ streak: newStreak, tokensEarned, totalTokens, alreadyClaimed: false });
});
