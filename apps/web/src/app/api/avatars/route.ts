import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, avatars, agents, eq } from '@clawville/database';
import { AVATAR_ARCHETYPES, ARCHETYPE_IDS } from '@clawville/shared';
import type { AvatarArchetypeId } from '@clawville/shared';
import { json, error, requireAuth } from '@/lib/api-utils';

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

function buildCharacterConfig(archetypeId: AvatarArchetypeId, avatarName: string, species: string) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${avatarName}, a ${species} in the world of ClawVille — a sea-themed agent universe powered by OpenClaw.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `You exist in The Depths and have deep knowledge of ClawVille lore, culture, and locations.`,
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
    const result = createAvatarSchema.safeParse(body);

    if (!result.success) {
      return error(result.error.issues[0].message, 400);
    }

    // Check how many agents this user already has (max 6)
    const existingAvatars = await db.query.avatars.findMany({
      where: eq(avatars.userId, user.id),
    });

    if (existingAvatars.length >= 6) {
      return error('Maximum 6 agents allowed', 400);
    }

    // Check name uniqueness
    const existingName = await db.query.avatars.findFirst({
      where: eq(avatars.name, result.data.name),
    });

    if (existingName) {
      return error('That name is already taken', 400);
    }

    const stats = calculateStats(result.data.personality);
    const characterConfig = buildCharacterConfig(
      result.data.archetypeId as AvatarArchetypeId,
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
      slotIndex: existingAvatars.length,
      isActive: existingAvatars.length === 0,
    }).returning();

    return json({ avatar, agentId: agent.id });
  } catch (err) {
    console.error('Create avatar error:', err);
    return error('Internal server error', 500);
  }
}
