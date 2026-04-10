import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, desc, inArray, isNull } from 'drizzle-orm';
import { db, pets, petInventory, publishedSkills, skillUpvotes, agents } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { npcSimulation } from '../services/npc-simulation';
import { agentOrchestrator } from '../services/agent-orchestrator';
import type { AppContext, AuthenticatedContext } from '../types';
import { z } from 'zod';

export const marketplaceRoutes = new Hono<AppContext>();

// Helper: get current user's pet (throws if not found)
async function getUserPet(userId: string) {
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, userId), eq(pets.isActive, true)),
  });
  if (!pet) throw new HTTPException(404, { message: 'No pet found' });
  return pet;
}

// ---------------------------------------------------------------------------
// POST /publish — publish a skill to the marketplace
// Supports both authenticated pets and anonymous claws
// ---------------------------------------------------------------------------
const publishSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(200),
  skillMd: z.string().min(1),
  locationId: z.string().max(50).optional(),
  clawSessionId: z.string().optional(),
});

marketplaceRoutes.post('/publish', sessionMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = publishSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request: ' + parsed.error.issues.map((i) => i.message).join(', ') });
  }

  const { name, description, skillMd, locationId, clawSessionId } = parsed.data;
  const user = c.get('user');

  // Anonymous claw publishing
  if (clawSessionId) {
    const claw = npcSimulation.getBrowserClaw(clawSessionId);
    if (!claw) {
      throw new HTTPException(404, { message: 'Claw session not found' });
    }

    const [skill] = await db
      .insert(publishedSkills)
      .values({
        authorClawName: claw.config.name,
        authorClawSpecies: claw.config.species,
        locationId: locationId ?? null,
        name,
        description,
        skillMd,
        price: 0,
      })
      .returning();

    return c.json({
      skill: {
        id: skill.id,
        authorPetId: null,
        authorPetName: claw.config.name,
        authorSpecies: claw.config.species,
        authorClawName: claw.config.name,
        authorClawSpecies: claw.config.species,
        locationId: skill.locationId,
        name: skill.name,
        description: skill.description,
        upvoteCount: skill.upvoteCount,
        downloadCount: skill.downloadCount,
        hasUpvoted: false,
        createdAt: skill.createdAt.toISOString(),
      },
    });
  }

  // Authenticated pet publishing
  if (!user) {
    throw new HTTPException(401, { message: 'Authentication or claw session required' });
  }

  const pet = await getUserPet(user.id);

  const [skill] = await db
    .insert(publishedSkills)
    .values({
      authorPetId: pet.id,
      locationId: locationId ?? null,
      name,
      description,
      skillMd,
      price: 0,
    })
    .returning();

  return c.json({
    skill: {
      id: skill.id,
      authorPetId: skill.authorPetId,
      authorPetName: pet.name,
      authorSpecies: pet.species,
      locationId: skill.locationId,
      name: skill.name,
      description: skill.description,
      upvoteCount: skill.upvoteCount,
      downloadCount: skill.downloadCount,
      hasUpvoted: false,
      createdAt: skill.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /skills — browse published skills with optional location filter
// Works for both authenticated and anonymous users
// ---------------------------------------------------------------------------
marketplaceRoutes.get('/skills', sessionMiddleware, async (c) => {
  const user = c.get('user');
  const sort = c.req.query('sort') || 'newest';
  const locationId = c.req.query('locationId');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
  const offset = (page - 1) * limit;

  let orderBy;
  switch (sort) {
    case 'upvotes':
      orderBy = desc(publishedSkills.upvoteCount);
      break;
    case 'downloads':
      orderBy = desc(publishedSkills.downloadCount);
      break;
    default:
      orderBy = desc(publishedSkills.createdAt);
  }

  // Build where condition
  const conditions = locationId
    ? eq(publishedSkills.locationId, locationId)
    : undefined;

  // Skills with pet authors (left join so we get claw-authored skills too)
  const allSkills = await db
    .select({
      id: publishedSkills.id,
      authorPetId: publishedSkills.authorPetId,
      authorClawName: publishedSkills.authorClawName,
      authorClawSpecies: publishedSkills.authorClawSpecies,
      locationId: publishedSkills.locationId,
      name: publishedSkills.name,
      description: publishedSkills.description,
      upvoteCount: publishedSkills.upvoteCount,
      downloadCount: publishedSkills.downloadCount,
      createdAt: publishedSkills.createdAt,
      authorPetName: pets.name,
      authorSpecies: pets.species,
    })
    .from(publishedSkills)
    .leftJoin(pets, eq(publishedSkills.authorPetId, pets.id))
    .where(conditions)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  // Check upvotes for current user's pet (if authenticated)
  let upvotedSet = new Set<string>();
  if (user) {
    const pet = await db.query.pets.findFirst({ where: and(eq(pets.userId, user.id), eq(pets.isActive, true)) });
    if (pet) {
      const skillIds = allSkills.map((s: any) => s.id);
      if (skillIds.length > 0) {
        const upvotes = await db
          .select({ skillId: skillUpvotes.skillId })
          .from(skillUpvotes)
          .where(
            and(
              eq(skillUpvotes.petId, pet.id),
              inArray(skillUpvotes.skillId, skillIds)
            )
          );
        upvotedSet = new Set(upvotes.map((u: { skillId: string }) => u.skillId));
      }
    }
  }

  const skills = allSkills.map((s: any) => ({
    id: s.id,
    authorPetName: s.authorPetName ?? s.authorClawName ?? 'Unknown',
    authorSpecies: s.authorSpecies ?? s.authorClawSpecies ?? 'cat',
    authorClawName: s.authorClawName,
    authorClawSpecies: s.authorClawSpecies,
    locationId: s.locationId,
    name: s.name,
    description: s.description,
    upvoteCount: s.upvoteCount,
    downloadCount: s.downloadCount,
    hasUpvoted: upvotedSet.has(s.id),
    createdAt: s.createdAt.toISOString(),
  }));

  return c.json({ skills, page, limit });
});

// ---------------------------------------------------------------------------
// GET /skills/:id — single skill detail
// ---------------------------------------------------------------------------
marketplaceRoutes.get('/skills/:id', sessionMiddleware, async (c) => {
  const user = c.get('user');
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const rows = await db
    .select({
      id: publishedSkills.id,
      authorPetId: publishedSkills.authorPetId,
      authorClawName: publishedSkills.authorClawName,
      authorClawSpecies: publishedSkills.authorClawSpecies,
      locationId: publishedSkills.locationId,
      name: publishedSkills.name,
      description: publishedSkills.description,
      skillMd: publishedSkills.skillMd,
      upvoteCount: publishedSkills.upvoteCount,
      downloadCount: publishedSkills.downloadCount,
      createdAt: publishedSkills.createdAt,
      authorPetName: pets.name,
      authorSpecies: pets.species,
    })
    .from(publishedSkills)
    .leftJoin(pets, eq(publishedSkills.authorPetId, pets.id))
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const s = rows[0];
  let hasUpvoted = false;

  if (user) {
    const pet = await db.query.pets.findFirst({ where: and(eq(pets.userId, user.id), eq(pets.isActive, true)) });
    if (pet) {
      const [upvote] = await db
        .select({ id: skillUpvotes.id })
        .from(skillUpvotes)
        .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.petId, pet.id)))
        .limit(1);
      hasUpvoted = !!upvote;
    }
  }

  return c.json({
    skill: {
      id: s.id,
      authorPetId: s.authorPetId,
      authorPetName: s.authorPetName ?? s.authorClawName ?? 'Unknown',
      authorSpecies: s.authorSpecies ?? s.authorClawSpecies ?? 'cat',
      authorClawName: s.authorClawName,
      authorClawSpecies: s.authorClawSpecies,
      locationId: s.locationId,
      name: s.name,
      description: s.description,
      skillMd: s.skillMd,
      upvoteCount: s.upvoteCount,
      downloadCount: s.downloadCount,
      hasUpvoted,
      createdAt: s.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /skills/:id/upvote — toggle upvote (supports pets and anonymous claws)
// ---------------------------------------------------------------------------
marketplaceRoutes.post('/skills/:id/upvote', sessionMiddleware, async (c) => {
  const skillId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  // Determine voter identity
  let petId: string | null = null;
  const clawSessionId: string | undefined = body.clawSessionId;

  if (user) {
    const pet = await db.query.pets.findFirst({ where: and(eq(pets.userId, user.id), eq(pets.isActive, true)) });
    if (pet) petId = pet.id;
  }

  if (!petId && !clawSessionId) {
    throw new HTTPException(401, { message: 'Authentication or claw session required to vote' });
  }

  // Check existing upvote
  let existingId: string | null = null;
  if (petId) {
    const [existing] = await db
      .select({ id: skillUpvotes.id })
      .from(skillUpvotes)
      .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.petId, petId)))
      .limit(1);
    if (existing) existingId = existing.id;
  } else if (clawSessionId) {
    const [existing] = await db
      .select({ id: skillUpvotes.id })
      .from(skillUpvotes)
      .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.clawSessionId, clawSessionId)))
      .limit(1);
    if (existing) existingId = existing.id;
  }

  let upvoted: boolean;
  let newCount: number;

  if (existingId) {
    await db.delete(skillUpvotes).where(eq(skillUpvotes.id, existingId));
    newCount = Math.max(0, skill.upvoteCount - 1);
    upvoted = false;
  } else {
    await db.insert(skillUpvotes).values({
      skillId,
      petId: petId ?? undefined,
      clawSessionId: clawSessionId ?? undefined,
    });
    newCount = skill.upvoteCount + 1;
    upvoted = true;
  }

  await db
    .update(publishedSkills)
    .set({ upvoteCount: newCount, updatedAt: new Date() })
    .where(eq(publishedSkills.id, skillId));

  return c.json({ upvoted, upvoteCount: newCount });
});

// ---------------------------------------------------------------------------
// Auth-required routes below
// ---------------------------------------------------------------------------

// POST /skills/:id/buy — purchase a skill (auth required)
marketplaceRoutes.post('/skills/:id/buy', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  if (skill.authorPetId === pet.id) {
    throw new HTTPException(400, { message: 'Cannot buy your own skill' });
  }

  const existing = await db.query.petInventory.findFirst({
    where: and(
      eq(petInventory.petId, pet.id),
      eq(petInventory.itemId, `skill-${skillId}`)
    ),
  });
  if (existing) {
    throw new HTTPException(400, { message: 'Already purchased this skill' });
  }

  await db.insert(petInventory).values({
    petId: pet.id,
    itemId: `skill-${skillId}`,
    quantity: 1,
  });

  await db
    .update(publishedSkills)
    .set({
      downloadCount: skill.downloadCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(publishedSkills.id, skillId));

  return c.json({
    success: true,
    clawTokens: pet.clawTokens,
    skill: { id: skill.id, name: skill.name },
  });
});

// POST /skills/:id/install — install a purchased skill (auth required)
marketplaceRoutes.post('/skills/:id/install', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const inventoryItem = await db.query.petInventory.findFirst({
    where: and(
      eq(petInventory.petId, pet.id),
      eq(petInventory.itemId, `skill-${skillId}`)
    ),
  });

  if (!inventoryItem || inventoryItem.quantity < 1) {
    throw new HTTPException(400, { message: 'Skill not in inventory. Purchase it first.' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const isElizaOs = skill.skillMd.includes('format: elizaos-character');
  const currentConfig = (pet.characterConfig as any) ?? {};

  let knowledgeEntries: string[] = [];
  let extraTopics: string[] = [];
  let extraLore: string[] = [];

  if (isElizaOs) {
    const jsonMatch = skill.skillMd.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const charData = JSON.parse(jsonMatch[1]);
        knowledgeEntries = charData.knowledge ?? [];
        extraTopics = charData.topics ?? [];
        extraLore = charData.lore ?? [];
      } catch { /* fallback to bullet parsing */ }
    }
  }

  if (knowledgeEntries.length === 0) {
    const lines = skill.skillMd.split('\n');
    let inKnowledge = false;
    for (const line of lines) {
      if (line.startsWith('## Core Knowledge')) { inKnowledge = true; continue; }
      if (inKnowledge && line.startsWith('## ')) break;
      if (inKnowledge && line.startsWith('- ')) {
        knowledgeEntries.push(line.slice(2).trim());
      }
    }
  }

  const currentKnowledge: string[] = currentConfig.knowledge ?? [];
  const newKnowledge = knowledgeEntries.filter((e) => !currentKnowledge.includes(e));
  const mergedKnowledge = [...currentKnowledge, ...newKnowledge];

  const currentTopics: string[] = currentConfig.topics ?? [];
  const mergedTopics = [...new Set([...currentTopics, ...extraTopics])];
  const currentLore: string[] = currentConfig.lore ?? [];
  const mergedLore = [...new Set([...currentLore, ...extraLore])];

  const updatedConfig = {
    ...currentConfig,
    knowledge: mergedKnowledge,
    ...(extraTopics.length > 0 ? { topics: mergedTopics } : {}),
    ...(extraLore.length > 0 ? { lore: mergedLore } : {}),
  };

  await db
    .update(pets)
    .set({ characterConfig: updatedConfig, updatedAt: new Date() })
    .where(eq(pets.id, pet.id));

  if (pet.platformAgentId) {
    await db
      .update(agents)
      .set({ customization: updatedConfig, updatedAt: new Date() })
      .where(eq(agents.id, pet.platformAgentId));

    await agentOrchestrator.stopAgent(pet.platformAgentId);
  }

  if (inventoryItem.quantity > 1) {
    await db
      .update(petInventory)
      .set({ quantity: inventoryItem.quantity - 1 })
      .where(eq(petInventory.id, inventoryItem.id));
  } else {
    await db.delete(petInventory).where(eq(petInventory.id, inventoryItem.id));
  }

  return c.json({
    success: true,
    skillName: skill.name,
    newKnowledgeCount: newKnowledge.length,
    totalKnowledge: mergedKnowledge.length,
  });
});

// GET /my-skills — skills published by current user's pet (auth required)
marketplaceRoutes.get('/my-skills', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

  const skills = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.authorPetId, pet.id))
    .orderBy(desc(publishedSkills.createdAt));

  return c.json({
    skills: skills.map((s: any) => ({
      id: s.id,
      authorPetName: pet.name,
      authorSpecies: pet.species,
      locationId: s.locationId,
      name: s.name,
      description: s.description,
      upvoteCount: s.upvoteCount,
      downloadCount: s.downloadCount,
      hasUpvoted: false,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});
