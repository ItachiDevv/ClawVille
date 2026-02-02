import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, pets, agents, eq } from '@legacyapp/database';
import { json, error, requireAuth } from '@/lib/api-utils';

const characterConfigSchema = z.object({
  bio: z.string().min(10).max(500),
  greeting: z.string().min(1).max(200),
  personality: z.string().min(10).max(300),
  tone: z.enum(['formal', 'casual', 'friendly', 'playful']),
  topics: z.array(z.string().max(50)).min(1).max(10),
  adjectives: z.array(z.string().max(30)).min(1).max(10),
  rules: z.array(z.string().max(100)).max(5).default([]),
  style: z.array(z.string().max(100)).max(5).default([]),
});

const createPetSchema = z.object({
  name: z.string().min(3).max(20).regex(/^[a-zA-Z0-9]+$/, 'Name must be alphanumeric'),
  species: z.enum(['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle']),
  color: z.enum(['green', 'red', 'blue', 'yellow']),
  gender: z.enum(['male', 'female']),
  personality: z.object({
    habitat: z.enum(['forest', 'sea', 'mountain', 'sky', 'desert', 'cave']),
    hobby: z.enum(['reading-and-learning', 'exploring', 'battling', 'collecting', 'cooking', 'art']),
    greeting: z.enum(['run-away', 'wave-hello', 'tackle-hug', 'shy-peek', 'bow-politely', 'roar']),
  }),
  characterConfig: characterConfigSchema,
});

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

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const body = await request.json();
    const result = createPetSchema.safeParse(body);

    if (!result.success) {
      return error(result.error.issues[0].message, 400);
    }

    // Check if user already has a pet
    const existingPet = await db.query.pets.findFirst({
      where: eq(pets.userId, user.id),
    });

    if (existingPet) {
      return error('You already have a pet', 400);
    }

    // Check name uniqueness
    const existingName = await db.query.pets.findFirst({
      where: eq(pets.name, result.data.name),
    });

    if (existingName) {
      return error('That name is already taken', 400);
    }

    const stats = calculateStats(result.data.personality);

    // Create the platform agent record first
    const [agent] = await db.insert(agents).values({
      userId: user.id,
      name: result.data.name,
      type: 'pet-agent',
      status: 'pending',
      config: {
        species: result.data.species,
        color: result.data.color,
      },
      customization: result.data.characterConfig,
    }).returning();

    // Create pet linked to the agent
    const [pet] = await db.insert(pets).values({
      userId: user.id,
      name: result.data.name,
      species: result.data.species,
      color: result.data.color,
      gender: result.data.gender,
      personality: result.data.personality,
      stats,
      characterConfig: result.data.characterConfig,
      platformAgentId: agent.id,
    }).returning();

    return json({ pet, agentId: agent.id });
  } catch (err) {
    console.error('Create pet error:', err);
    return error('Internal server error', 500);
  }
}
