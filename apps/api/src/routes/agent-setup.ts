import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  db,
  avatars,
  agents,
  avatarInventory,
  agentConfigs,
} from '@clawville/database';
import { eq, and, asc, desc, count } from 'drizzle-orm';
import {
  AVATAR_ARCHETYPES,
  ARCHETYPE_IDS,
  KNOWLEDGE_BOOKS,
  getBooksForBuilding,
  BUILDING_OPENCLAW_THEMES,
  getAgentModel,
} from '@clawville/shared';
import type { AvatarArchetypeId } from '@clawville/shared';
import type { AgentConfigExport } from '@clawville/database';

export const agentSetupRoutes = new Hono<AppContext>();
agentSetupRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// FEATURE_GATE: multi_agent_roster
// Status: schema + routes support N agents; UI + this constant cap it at 1.
// Metric to graduate: median session length > 15min AND returning-day rate > 20%
//   (single-agent UX must be good before multi-agent adds value).
// Current reading: to fill from /dash after 2 weeks of instrumented traffic.
// Review deadline: 2026-06-21.
// On deadline: if metrics met, raise MAX_AGENTS to 6; if not, delete the
//   roster/loadout plumbing on lines 194–750 and keep single-avatar only.
// Reference: improvements.md §7 (Tier 2 deferred).
const MAX_AGENTS = 1;
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
  return db.query.avatars.findMany({
    where: eq(avatars.userId, userId),
    orderBy: asc(avatars.slotIndex),
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

function buildCharacterConfig(archetypeId: AvatarArchetypeId, avatarName: string, species: string) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${avatarName}, a ${species} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `For canonical questions about ClawVille modes, buildings, the vCLAW economy, or how things work, refer the user to Nori the Town Guide. You yourself carry an eclectic mix of useful trivia: marine biology, retro internet culture, vintage gaming, and offbeat factoids — sprinkle them into conversation when relevant.`,
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

// Species enum still matches the DB avatar_species pg_enum (8 land species from a
// pre-ocean-theme codebase). Converting to ocean species requires a full DB
// migration; for now the client LEGACY_SPECIES_REMAP in arena-npcs.tsx maps
// these land strings to actual ocean GLBs (cat→lobster, dragon→sweet_crab,
// fox→hermitcrab, owl→seahorse, wolf→octopus, bunny→jellyfish, phoenix→crayfish,
// turtle→lobster_plush). Follow-up: migrate avatar_species enum to ocean keys.
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
    // Phase 2 — optional on imports from older exports; fall back to
    // DB DEFAULTs at insert time if omitted.
    modelKey: z.string().optional(),
    // Keep in lockstep with AGENT_CATEGORIES (shared) + AgentConfigExport
    // (database) so an exported hatcher/chibi agent re-imports without a 400.
    agentCategory: z.enum(['openclaw', 'hermes', 'milady', 'other', 'hatcher', 'chibi']).optional(),
    harness: z.enum(['openclaw', 'hermes', 'milady', 'custom']).optional(),
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
  const existingName = await db.query.avatars.findFirst({
    where: eq(avatars.name, result.data.name),
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
    result.data.archetypeId as AvatarArchetypeId,
    result.data.name,
    result.data.species,
  );

  // Create the platform agent record first
  const [agent] = await db
    .insert(agents)
    .values({
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
    })
    .returning();

  // Create avatar linked to the agent
  // Phase 2: modelKey/agentCategory/harness rely on DB DEFAULTs here
  // ('lobster', 'openclaw', 'milady') since this route predates Phase 2
  // and doesn't collect those selections. New avatars created via the
  // primary /create-agent flow (POST /api/avatars) go through the Phase 2
  // wiring in avatars.ts:165-179.
  const [avatar] = await db
    .insert(avatars)
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
      id: avatar.id,
      name: avatar.name,
      species: avatar.species,
      color: avatar.color,
      gender: avatar.gender,
      archetype: avatar.archetype,
      slotIndex: avatar.slotIndex,
      isActive: avatar.isActive,
      totalXp: avatar.totalXp,
      equippedSkills: avatar.equippedSkills ?? [],
      clawTokens: avatar.clawTokens,
      stats: avatar.stats,
      createdAt: avatar.createdAt.toISOString(),
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
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, id), eq(avatars.userId, user.id)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  if (avatar.isActive) {
    return c.json({ success: true, message: 'Agent is already active' });
  }

  // Deactivate all user's agents
  await db
    .update(avatars)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(avatars.userId, user.id));

  // Activate the selected agent
  const [updated] = await db
    .update(avatars)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(avatars.id, id))
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
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, id), eq(avatars.userId, user.id)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Can't delete last agent
  const userAgents = await getUserAgents(user.id);
  if (userAgents.length <= 1) {
    throw new HTTPException(400, {
      message: 'Cannot delete your last agent. You must have at least one.',
    });
  }

  const wasActive = avatar.isActive;

  // Delete the avatar (cascade will handle inventory, etc.)
  await db.delete(avatars).where(eq(avatars.id, id));

  // If we deleted the active agent, activate the first remaining one
  if (wasActive) {
    const remaining = await getUserAgents(user.id);
    if (remaining.length > 0) {
      await db
        .update(avatars)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(avatars.id, remaining[0].id));
    }
  }

  // Also clean up the platform agent record if it existed
  if (avatar.platformAgentId) {
    await db.delete(agents).where(eq(agents.id, avatar.platformAgentId)).catch(() => {});
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
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, id), eq(avatars.userId, user.id)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Verify all skill IDs exist in avatar's inventory
  if (result.data.equippedSkills.length > 0) {
    const inventory = await db.query.avatarInventory.findMany({
      where: eq(avatarInventory.avatarId, avatar.id),
    });

    const ownedItemIds = new Set(inventory.map((item) => item.itemId));

    for (const skillId of result.data.equippedSkills) {
      // Check both raw ID and "skill-" prefixed version (legacy skill- inventory items from the removed peer-skill-commerce / quest-skill-reward paths)
      if (!ownedItemIds.has(skillId) && !ownedItemIds.has(`skill-${skillId}`)) {
        throw new HTTPException(400, {
          message: `Skill "${skillId}" is not in your inventory`,
        });
      }
    }
  }

  const [updated] = await db
    .update(avatars)
    .set({
      equippedSkills: result.data.equippedSkills,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, id))
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
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, id), eq(avatars.userId, user.id)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  // Get learned knowledge entries from characterConfig
  const characterConfig = (avatar.characterConfig as any) ?? {};
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
        // A book is "learned" if any of its knowledge entries are in the avatar's knowledge
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
      totalXp: avatar.totalXp,
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
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, id), eq(avatars.userId, user.id)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Agent not found' });
  }

  const configData: AgentConfigExport = {
    version: 1,
    name: avatar.name,
    species: avatar.species,
    color: avatar.color,
    archetype: avatar.archetype,
    personality: avatar.personality,
    stats: avatar.stats,
    characterConfig: avatar.characterConfig,
    equippedSkills: (avatar.equippedSkills as string[]) ?? [],
    totalXp: avatar.totalXp,
    exportedAt: new Date().toISOString(),
    // Phase 2 — propagate the framework-identity fields so a re-import
    // preserves the agent's 3D model and runtime harness.
    modelKey: avatar.modelKey,
    agentCategory: avatar.agentCategory,
    harness: avatar.harness,
  };

  // Save to agent_configs table
  const [config] = await db
    .insert(agentConfigs)
    .values({
      userId: user.id,
      avatarId: avatar.id,
      name: `${avatar.name} Export`,
      description: `Exported config for ${avatar.name} (${avatar.species}, ${avatar.archetype})`,
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
  const existingName = await db.query.avatars.findFirst({
    where: eq(avatars.name, agentName),
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
      type: 'avatar-agent',
      status: 'pending',
      config: {
        species,
        color,
        archetypeId: configData.archetype,
      },
      customization: configData.characterConfig ?? {},
    })
    .returning();

  // Create avatar from imported config
  // Phase 2: honor modelKey/agentCategory/harness from configData if
  // present, otherwise fall back to DB DEFAULTs ('lobster', 'openclaw',
  // 'milady'). Imports from older exports won't have these fields — the
  // safety net is the NOT NULL DEFAULT clause on the columns.
  const [avatar] = await db
    .insert(avatars)
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
      // Drop a hatcher-category modelKey from an imported config — reserved
      // Hatcher avatars are server-assigned only and must not be renderable by a
      // human import (world/join emits `modelKey || species`, so an imported
      // modelKey:'cronus' would render the reserved VRM). Falls back to the DB
      // default. (species is already whitelisted to the 2D enum above.)
      ...(configData.modelKey && getAgentModel(configData.modelKey)?.category !== 'hatcher'
        ? { modelKey: configData.modelKey }
        : {}),
      ...(configData.agentCategory ? { agentCategory: configData.agentCategory } : {}),
      ...(configData.harness ? { harness: configData.harness } : {}),
    })
    .returning();

  return c.json({
    success: true,
    agent: {
      id: avatar.id,
      name: avatar.name,
      species: avatar.species,
      color: avatar.color,
      gender: avatar.gender,
      archetype: avatar.archetype,
      slotIndex: avatar.slotIndex,
      isActive: avatar.isActive,
      totalXp: avatar.totalXp,
      equippedSkills: avatar.equippedSkills ?? [],
      clawTokens: avatar.clawTokens,
      stats: avatar.stats,
      createdAt: avatar.createdAt.toISOString(),
    },
  });
});

