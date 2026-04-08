import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  db,
  pets,
  agents,
  petInventory,
  agentConfigs,
} from '@legacyapp/database';
import { eq, and, asc, desc, count } from 'drizzle-orm';
import {
  PET_ARCHETYPES,
  ARCHETYPE_IDS,
  KNOWLEDGE_BOOKS,
  getBooksForBuilding,
  BUILDING_OPENCLAW_THEMES,
} from '@legacyapp/shared';
import type { PetArchetypeId } from '@legacyapp/shared';
import type { AgentConfigExport } from '@legacyapp/database';

export const agentSetupRoutes = new Hono<AppContext>();
agentSetupRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_AGENTS = 6;
const MAX_EQUIPPED_SKILLS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label = 'Resource') {
  if (!uuidRegex.test(id)) {
    throw new HTTPException(404, { message: `${label} not found` });
  }
}

async function getUserAgents(userId: string) {
  return db.query.pets.findMany({
    where: eq(pets.userId, userId),
    orderBy: asc(pets.slotIndex),
  });
}

function calculateStats(personality: {
  habitat: string;
  hobby: string;
  greeting: string;
}) {
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
    `You are ${petName}, a ${species} in the world of LegacyApp — a LegacyTheme-themed virtual pet universe on Solana.`,
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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createAgentSchema = z.object({
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

const loadoutSchema = z.object({
  equippedSkills: z.array(z.string()).max(MAX_EQUIPPED_SKILLS),
});

const importSchema = z.object({
  configData: z.object({
    version: z.number(),
    name: z.string(),
    species: z.string(),
    color: z.string(),
    archetype: z.string(),
    personality: z.any(),
    stats: z.any(),
    characterConfig: z.any(),
    equippedSkills: z.array(z.string()),
    totalXp: z.number(),
    exportedAt: z.string(),
  }),
  slotIndex: z.number().int().min(0).max(5).optional(),
});

// ---------------------------------------------------------------------------
// ROUTE ORDER: Static paths MUST come before /:id param routes to avoid
// "configs" or "roster" being matched as a UUID parameter.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. GET /roster — Get all user's agents ordered by slotIndex
// ---------------------------------------------------------------------------
agentSetupRoutes.get('/roster', requireAuth, async (c) => {
  const user = c.get('user');
  const userAgents = await getUserAgents(user.id);

  return c.json({
    agents: userAgents.map((a) => ({
      id: a.id,
      name: a.name,
      species: a.species,
      color: a.color,
      gender: a.gender,
      archetype: a.archetype,
      slotIndex: a.slotIndex,
      isActive: a.isActive,
      totalXp: a.totalXp,
      equippedSkills: a.equippedSkills ?? [],
      clawTokens: a.clawTokens,
      stats: a.stats,
      createdAt: a.createdAt.toISOString(),
    })),
    maxSlots: MAX_AGENTS,
  });
});

// ---------------------------------------------------------------------------
// 9. GET /configs — List user's saved configs
//    (Defined BEFORE /:id routes to avoid route conflict)
// ---------------------------------------------------------------------------
agentSetupRoutes.get('/configs', requireAuth, async (c) => {
  const user = c.get('user');

  const rows = await db
    .select({
      id: agentConfigs.id,
      name: agentConfigs.name,
      description: agentConfigs.description,
      isPublic: agentConfigs.isPublic,
      downloadCount: agentConfigs.downloadCount,
      configData: agentConfigs.configData,
      createdAt: agentConfigs.createdAt,
    })
    .from(agentConfigs)
    .where(eq(agentConfigs.userId, user.id))
    .orderBy(desc(agentConfigs.createdAt));

  const configs = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isPublic: r.isPublic,
    downloadCount: r.downloadCount,
    species: (r.configData as AgentConfigExport)?.species ?? null,
    archetype: (r.configData as AgentConfigExport)?.archetype ?? null,
    totalXp: (r.configData as AgentConfigExport)?.totalXp ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ configs });
});

// ---------------------------------------------------------------------------
// 10. GET /configs/public — Browse public configs from other users
//     (Defined BEFORE /:id routes to avoid route conflict)
// ---------------------------------------------------------------------------
agentSetupRoutes.get('/configs/public', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)),
  );
  const offset = (page - 1) * pageSize;

  // Count total public configs
  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(agentConfigs)
    .where(eq(agentConfigs.isPublic, true));

  // Fetch public configs
  const rows = await db
    .select({
      id: agentConfigs.id,
      name: agentConfigs.name,
      description: agentConfigs.description,
      downloadCount: agentConfigs.downloadCount,
      configData: agentConfigs.configData,
      createdAt: agentConfigs.createdAt,
    })
    .from(agentConfigs)
    .where(eq(agentConfigs.isPublic, true))
    .orderBy(desc(agentConfigs.downloadCount))
    .limit(pageSize)
    .offset(offset);

  const configs = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    downloadCount: r.downloadCount,
    species: (r.configData as AgentConfigExport)?.species ?? null,
    archetype: (r.configData as AgentConfigExport)?.archetype ?? null,
    totalXp: (r.configData as AgentConfigExport)?.totalXp ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ configs, total: totalCount, page, pageSize });
});

// ---------------------------------------------------------------------------
// 2. POST /create — Create a new agent in next available slot
// ---------------------------------------------------------------------------
agentSetupRoutes.post('/create', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = createAgentSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Check agent count
  const userAgents = await getUserAgents(user.id);
  if (userAgents.length >= MAX_AGENTS) {
    throw new HTTPException(400, {
      message: `Maximum ${MAX_AGENTS} agents allowed. Delete one to create a new agent.`,
    });
  }

  // Check name uniqueness
  const existingName = await db.query.pets.findFirst({
    where: eq(pets.name, result.data.name),
  });

  if (existingName) {
    throw new HTTPException(400, { message: 'That name is already taken' });
  }

  // Find next available slot (0-5)
  const usedSlots = new Set(userAgents.map((a) => a.slotIndex));
  let nextSlot = -1;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!usedSlots.has(i)) {
      nextSlot = i;
      break;
    }
  }

  if (nextSlot === -1) {
    throw new HTTPException(400, { message: 'No available agent slots' });
  }

  const isFirstAgent = userAgents.length === 0;
  const stats = calculateStats(result.data.personality);
  const characterConfig = buildCharacterConfig(
    result.data.archetypeId as PetArchetypeId,
    result.data.name,
    result.data.species,
  );

  // Create the platform agent record first
  const [agent] = await db
    .insert(agents)
    .values({
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
    })
    .returning();

  // Create pet linked to the agent
  const [pet] = await db
    .insert(pets)
    .values({
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
      slotIndex: nextSlot,
      isActive: isFirstAgent, // First agent is auto-activated
      equippedSkills: [],
      totalXp: 0,
    })
    .returning();

  return c.json({
    agent: {
      id: pet.id,
      name: pet.name,
      species: pet.species,
      color: pet.color,
      gender: pet.gender,
      archetype: pet.archetype,
      slotIndex: pet.slotIndex,
      isActive: pet.isActive,
      totalXp: pet.totalXp,
      equippedSkills: pet.equippedSkills ?? [],
      clawTokens: pet.clawTokens,
      stats: pet.stats,
      createdAt: pet.createdAt.toISOString(),
    },
    agentId: agent.id,
  });
});

// ---------------------------------------------------------------------------
// 3. PATCH /:id/activate — Set an agent as active (deactivate others)
// ---------------------------------------------------------------------------
agentSetupRoutes.patch('/:id/activate', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  validateUuid(id, 'Agent');

  // Verify agent belongs to user
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.id, id), eq(pets.userId, user.id)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  if (pet.isActive) {
    return c.json({ success: true, message: 'Agent is already active' });
  }

  // Deactivate all user's agents
  await db
    .update(pets)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(pets.userId, user.id));

  // Activate the selected agent
  const [updated] = await db
    .update(pets)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(pets.id, id))
    .returning();

  return c.json({
    success: true,
    agent: {
      id: updated.id,
      name: updated.name,
      isActive: updated.isActive,
      slotIndex: updated.slotIndex,
    },
  });
});

// ---------------------------------------------------------------------------
// 4. DELETE /:id — Delete an agent
// ---------------------------------------------------------------------------
agentSetupRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  validateUuid(id, 'Agent');

  // Verify agent belongs to user
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.id, id), eq(pets.userId, user.id)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Can't delete last agent
  const userAgents = await getUserAgents(user.id);
  if (userAgents.length <= 1) {
    throw new HTTPException(400, {
      message: 'Cannot delete your last agent. You must have at least one.',
    });
  }

  const wasActive = pet.isActive;

  // Delete the pet (cascade will handle inventory, etc.)
  await db.delete(pets).where(eq(pets.id, id));

  // If we deleted the active agent, activate the first remaining one
  if (wasActive) {
    const remaining = await getUserAgents(user.id);
    if (remaining.length > 0) {
      await db
        .update(pets)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(pets.id, remaining[0].id));
    }
  }

  // Also clean up the platform agent record if it existed
  if (pet.platformAgentId) {
    await db.delete(agents).where(eq(agents.id, pet.platformAgentId)).catch(() => {});
  }

  return c.json({
    success: true,
    message: 'Agent deleted',
    activatedAgentId: wasActive
      ? (await getUserAgents(user.id))[0]?.id ?? null
      : null,
  });
});

// ---------------------------------------------------------------------------
// 5. PATCH /:id/loadout — Update equipped skills
// ---------------------------------------------------------------------------
agentSetupRoutes.patch('/:id/loadout', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  validateUuid(id, 'Agent');

  const body = await c.req.json();
  const result = loadoutSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, {
      message: 'Invalid request: ' + result.error.issues.map((i) => i.message).join(', '),
    });
  }

  // Verify agent belongs to user
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.id, id), eq(pets.userId, user.id)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Verify all skill IDs exist in pet's inventory
  if (result.data.equippedSkills.length > 0) {
    const inventory = await db.query.petInventory.findMany({
      where: eq(petInventory.petId, pet.id),
    });

    const ownedItemIds = new Set(inventory.map((item) => item.itemId));

    for (const skillId of result.data.equippedSkills) {
      // Check both raw ID and "skill-" prefixed version (bazaar purchases use "skill-" prefix)
      if (!ownedItemIds.has(skillId) && !ownedItemIds.has(`skill-${skillId}`)) {
        throw new HTTPException(400, {
          message: `Skill "${skillId}" is not in your inventory`,
        });
      }
    }
  }

  const [updated] = await db
    .update(pets)
    .set({
      equippedSkills: result.data.equippedSkills,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, id))
    .returning();

  return c.json({
    success: true,
    equippedSkills: updated.equippedSkills ?? [],
  });
});

// ---------------------------------------------------------------------------
// 6. GET /:id/talent-tree — Get talent tree data
// ---------------------------------------------------------------------------
agentSetupRoutes.get('/:id/talent-tree', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  validateUuid(id, 'Agent');

  // Verify agent belongs to user
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.id, id), eq(pets.userId, user.id)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Get learned knowledge entries from characterConfig
  const characterConfig = (pet.characterConfig as any) ?? {};
  const learnedKnowledge: string[] = characterConfig.knowledge ?? [];
  const learnedKnowledgeSet = new Set(learnedKnowledge);

  // Build talent tree: 10 buildings, each with 2 books
  const buildingIds = Object.keys(BUILDING_OPENCLAW_THEMES);
  const buildings = buildingIds.map((buildingId) => {
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    const books = getBooksForBuilding(buildingId);

    return {
      id: buildingId,
      name: theme.label,
      category: theme.category,
      books: books.map((book) => {
        // A book is "learned" if any of its knowledge entries are in the pet's knowledge
        const learned = book.knowledgeEntries.some((entry) =>
          learnedKnowledgeSet.has(entry)
        );

        return {
          id: book.id,
          name: book.name,
          description: book.description,
          icon: book.icon,
          price: book.price,
          learned,
          knowledgeEntryCount: book.knowledgeEntries.length,
        };
      }),
    };
  });

  // Calculate summary stats
  const totalBooks = KNOWLEDGE_BOOKS.length;
  const learnedBooks = buildings.reduce(
    (sum, b) => sum + b.books.filter((bk) => bk.learned).length,
    0,
  );

  return c.json({
    buildings,
    summary: {
      totalBooks,
      learnedBooks,
      totalKnowledge: learnedKnowledge.length,
      totalXp: pet.totalXp,
    },
  });
});

// ---------------------------------------------------------------------------
// 7. POST /:id/export — Export agent config
// ---------------------------------------------------------------------------
agentSetupRoutes.post('/:id/export', requireAuth, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  validateUuid(id, 'Agent');

  // Verify agent belongs to user
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.id, id), eq(pets.userId, user.id)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  const configData: AgentConfigExport = {
    version: 1,
    name: pet.name,
    species: pet.species,
    color: pet.color,
    archetype: pet.archetype,
    personality: pet.personality,
    stats: pet.stats,
    characterConfig: pet.characterConfig,
    equippedSkills: (pet.equippedSkills as string[]) ?? [],
    totalXp: pet.totalXp,
    exportedAt: new Date().toISOString(),
  };

  // Save to agent_configs table
  const [config] = await db
    .insert(agentConfigs)
    .values({
      userId: user.id,
      petId: pet.id,
      name: `${pet.name} Export`,
      description: `Exported config for ${pet.name} (${pet.species}, ${pet.archetype})`,
      configData,
      isPublic: false,
    })
    .returning();

  return c.json({
    success: true,
    config: {
      id: config.id,
      name: config.name,
      configData,
      createdAt: config.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 8. POST /import — Import agent config
// ---------------------------------------------------------------------------
agentSetupRoutes.post('/import', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = importSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, {
      message: 'Invalid request: ' + result.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { configData, slotIndex: requestedSlot } = result.data;

  // Check agent count
  const userAgents = await getUserAgents(user.id);
  if (userAgents.length >= MAX_AGENTS) {
    throw new HTTPException(400, {
      message: `Maximum ${MAX_AGENTS} agents allowed. Delete one to import.`,
    });
  }

  // Generate a unique name (append a suffix if taken)
  let agentName = configData.name;
  const existingName = await db.query.pets.findFirst({
    where: eq(pets.name, agentName),
  });
  if (existingName) {
    // Append random suffix to make unique
    const suffix = Math.floor(Math.random() * 9000 + 1000);
    agentName = `${configData.name.slice(0, 16)}${suffix}`;
  }

  // Find slot
  const usedSlots = new Set(userAgents.map((a) => a.slotIndex));
  let targetSlot: number;

  if (requestedSlot !== undefined && !usedSlots.has(requestedSlot)) {
    targetSlot = requestedSlot;
  } else {
    // Auto-assign next available
    targetSlot = -1;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!usedSlots.has(i)) {
        targetSlot = i;
        break;
      }
    }
    if (targetSlot === -1) {
      throw new HTTPException(400, { message: 'No available agent slots' });
    }
  }

  const isFirstAgent = userAgents.length === 0;

  // Validate species/color/gender enums from the config
  const validSpecies = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'];
  const validColors = ['green', 'red', 'blue', 'yellow'];

  const species = validSpecies.includes(configData.species) ? configData.species : 'cat';
  const color = validColors.includes(configData.color) ? configData.color : 'green';

  // Create the platform agent record
  const [platformAgent] = await db
    .insert(agents)
    .values({
      userId: user.id,
      name: agentName,
      type: 'pet-agent',
      status: 'pending',
      config: {
        species,
        color,
        archetypeId: configData.archetype,
      },
      customization: configData.characterConfig ?? {},
    })
    .returning();

  // Create pet from imported config
  const [pet] = await db
    .insert(pets)
    .values({
      userId: user.id,
      name: agentName,
      species: species as any,
      color: color as any,
      gender: 'male', // default; imports may not have gender
      archetype: configData.archetype || 'brave-adventurer',
      personality: configData.personality ?? { habitat: 'sea', hobby: 'exploring', greeting: 'wave-hello' },
      stats: configData.stats ?? { strength: 5, defence: 5, movement: 5 },
      characterConfig: configData.characterConfig,
      platformAgentId: platformAgent.id,
      slotIndex: targetSlot,
      isActive: isFirstAgent,
      equippedSkills: configData.equippedSkills ?? [],
      totalXp: configData.totalXp ?? 0,
    })
    .returning();

  return c.json({
    success: true,
    agent: {
      id: pet.id,
      name: pet.name,
      species: pet.species,
      color: pet.color,
      gender: pet.gender,
      archetype: pet.archetype,
      slotIndex: pet.slotIndex,
      isActive: pet.isActive,
      totalXp: pet.totalXp,
      equippedSkills: pet.equippedSkills ?? [],
      clawTokens: pet.clawTokens,
      stats: pet.stats,
      createdAt: pet.createdAt.toISOString(),
    },
  });
});

