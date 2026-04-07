import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, pets, agents, eq } from '@legacyapp/database';
import { PET_ARCHETYPES, ARCHETYPE_IDS } from '@legacyapp/shared';
import type { PetArchetypeId } from '@legacyapp/shared';
import { json, error, requireAuth } from '@/lib/api-utils';

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
    `You are ${petName}, a ${species} in the world of ClawVille — a LegacyTheme-themed virtual pet universe on Solana.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `You exist in The Depths and have deep knowledge of LegacyTheme lore, culture, and locations.`,
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

    return json({ pet, agentId: agent.id });
  } catch (err) {
    console.error('Create pet error:', err);
    return error('Internal server error', 500);
  }
}
