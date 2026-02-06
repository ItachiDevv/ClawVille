import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, avatars, agents } from '@legacyapp/database';
import { AVATAR_ARCHETYPES, ARCHETYPE_IDS } from '@legacyapp/shared';
import type { PetArchetypeId } from '@legacyapp/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import type { AppContext } from '../types';
import { z } from 'zod';

export const avatarRoutes = new Hono<AppContext>();

avatarRoutes.use('*', sessionMiddleware);

// Create avatar schema — archetype-based (no manual characterConfig)
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
    `You are ${avatarName}, a ${species} in the world of LegacyApp — a LegacyTheme-themed virtual avatar universe on Solana.`,
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

  return c.json({ avatar, agentId: agent.id });
});

// Get user's avatar
avatarRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
  });

  if (!avatar) {
    return c.json({ avatar: null });
  }

  return c.json({ avatar });
});

// Update avatar position
const updatePositionSchema = z.object({
  positionX: z.number().int().min(0),
  positionY: z.number().int().min(0),
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
    .where(eq(avatars.userId, user.id))
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
    where: eq(avatars.userId, user.id),
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

  // Process message
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `avatar-${avatar.id}-${user.id}`,
    platform: 'legacyapp',
  });

  return c.json({
    message: {
      role: 'assistant' as const,
      content: response.content,
      timestamp: response.timestamp.toISOString(),
    },
  });
});
