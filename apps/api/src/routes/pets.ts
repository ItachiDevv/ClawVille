import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, pets, agents, petInventory } from '@clawville/database';
import {
  PET_ARCHETYPES,
  ARCHETYPE_IDS,
  getBookById,
  AGENT_MODEL_KEYS,
  AGENT_CATEGORIES,
  AGENT_HARNESSES,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_HARNESS,
  getAgentModel,
} from '@clawville/shared';
import type {
  PetArchetypeId,
  AgentCategory,
  AgentHarness,
  AgentModelKey,
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

export const petRoutes = new Hono<AppContext>();

petRoutes.use('*', sessionMiddleware);

// Create pet schema — archetype-based (no manual characterConfig)
// Phase 2: modelKey / agentCategory / harness are optional on the wire so
// older clients still work, but when present they're validated against the
// shared AGENT_MODELS registry. Server applies the defaults if omitted.
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
  /**
   * Phase 2 — stable 3D model key from AGENT_MODELS. We use `.refine`
   * instead of `z.enum` because modelKey is a `string` (not a literal
   * union tuple) in shared, and `.refine` against the typed
   * AGENT_MODEL_KEYS array gives both a runtime check and a clean error
   * message. Cast-to-AgentModelKey happens inside the handler after
   * validation narrows the value.
   */
  modelKey: z
    .string()
    .refine((k): k is AgentModelKey => (AGENT_MODEL_KEYS as readonly string[]).includes(k), {
      message: `modelKey must be one of: ${AGENT_MODEL_KEYS.join(', ')}`,
    })
    .optional(),
  /**
   * Phase 2 — agent framework category. Drizzle CHECK constraint
   * `pets_agent_category_valid` enforces the same enum at the DB layer.
   * `z.enum` works directly because AGENT_CATEGORIES is a tuple literal
   * (Phase 2 audit Fix A) — no `as unknown as [T, ...T[]]` cast needed.
   */
  agentCategory: z.enum(AGENT_CATEGORIES).optional(),
  /** Phase 2 — preferred runtime harness. DB CHECK `pets_harness_valid`. */
  harness: z.enum(AGENT_HARNESSES).optional(),
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

/**
 * Build the ElizaOS character config for a new pet. Phase 2 audit Fix C:
 * the third argument is now the human-readable `modelLabel` from
 * AGENT_MODELS (e.g. "Reef Lobster") instead of the legacy `species`
 * enum value (e.g. "cat"), so the system prompt describes the pet by
 * what the 3D renderer actually shows rather than the legacy fantasy
 * animal. Callers resolve the label from `getAgentModel(modelKey).label`
 * before calling this.
 */
function buildCharacterConfig(archetypeId: PetArchetypeId, petName: string, modelLabel: string) {
  const archetype = PET_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${petName}, a ${modelLabel} in the sea-themed world of ClawVille — a virtual pet adventure where agents learn OpenClaw skills.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `You exist in Neopia Central and have deep knowledge of Neopets lore, culture, and locations.`,
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

  // Phase 2 — resolve agent framework identity BEFORE inserting
  // anything. Client-omitted fields fall back to the DEFAULT_* constants
  // in @clawville/shared, which match the DB column defaults so
  // round-trip is stable. Zod already rejected unknown modelKeys via
  // `.refine` against AGENT_MODEL_KEYS (audit Fix C §5 — the
  // defense-in-depth `getAgentModel` recheck below is kept because it
  // resolves the full metadata record we need for `modelMeta.label` and
  // for cross-validating category; the previous defense-in-depth ONLY
  // check is gone).
  const modelKey = result.data.modelKey ?? DEFAULT_AGENT_MODEL_KEY;
  const harness: AgentHarness = result.data.harness ?? DEFAULT_AGENT_HARNESS;

  const modelMeta = getAgentModel(modelKey);
  if (!modelMeta) {
    // Unreachable if Zod .refine stayed in sync with the registry, but
    // we keep the check so a shared-package registry rebuild without a
    // corresponding API deploy fails loudly instead of inserting a bad
    // row.
    throw new HTTPException(400, { message: `Unknown modelKey: ${modelKey}` });
  }

  // Audit Fix C §3 — cross-validate the client's category claim against
  // the registry. A payload like `{ modelKey: 'priestess', agentCategory:
  // 'openclaw' }` is semantically broken (priestess is a milady model);
  // reject it rather than trusting the client. When the client omits
  // agentCategory, derive it from the model so the DB always gets a
  // self-consistent triple.
  if (
    result.data.agentCategory &&
    result.data.agentCategory !== modelMeta.category
  ) {
    throw new HTTPException(400, {
      message: `modelKey '${modelKey}' belongs to category '${modelMeta.category}', not '${result.data.agentCategory}'`,
    });
  }
  const agentCategory: AgentCategory =
    result.data.agentCategory ?? modelMeta.category;

  // Audit Fix C §4 — pass the model's display label (e.g. "Reef Lobster")
  // to the character-config builder instead of the legacy `species`
  // enum value. The system prompt now describes the pet by what the 3D
  // renderer actually shows.
  const characterConfig = buildCharacterConfig(
    result.data.archetypeId as PetArchetypeId,
    result.data.name,
    modelMeta.label,
  );

  // Audit Fix C §6 — wrap the agent + pet inserts in a transaction so a
  // failed pet insert rolls back the orphan agent row. Before this
  // change a DB constraint violation on `pets` (e.g. name race with a
  // concurrent signup) would leave a stray `platform_agents` row tied
  // to no pet, requiring manual cleanup.
  const { pet, agent } = await db.transaction(async (tx) => {
    const [insertedAgent] = await tx
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
          // Phase 2 — also persist modelKey/category/harness on the
          // agent config so downstream readers of agents.config don't
          // rely on the legacy species field alone. Keeps the pet row
          // + agent config in sync from creation.
          modelKey,
          agentCategory,
          harness,
        },
        customization: characterConfig,
      })
      .returning();

    const [insertedPet] = await tx
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
        platformAgentId: insertedAgent.id,
        modelKey,
        agentCategory,
        harness,
      })
      .returning();

    return { pet: insertedPet, agent: insertedAgent };
  });

  // Auto-generate a custodial Solana wallet for the new pet. Fire and
  // forget from the caller's perspective — if wallet gen fails, log it
  // but don't block pet creation. The backfill script will catch stragglers.
  // Outside the transaction intentionally: wallet gen hits an external
  // keypair store, and a slow external call shouldn't hold a pg
  // transaction open.
  try {
    const wallet = await ensureWallet('pet', pet.id);
    pet.walletAddress = wallet.publicKey;
  } catch (err) {
    console.error('[pets] Failed to auto-generate wallet for new pet:', err);
  }

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
  positionX: z.number().int().min(0).max(5120),
  positionY: z.number().int().min(0).max(5120),
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

  // Build state for Providers + Actions
  const services = { db, creditClawTokens, debitClawTokens } as ClawvilleServices;

  let worldSnapshot: any = null;
  try {
    worldSnapshot = npcSimulation.getSnapshot();
  } catch { /* NPC simulation may not be running */ }

  let inventory: any[] = [];
  try {
    inventory = await db.query.petInventory.findMany({
      where: eq(petInventory.petId, pet.id),
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
        eq(questSubmissions.petId, pet.id),
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
    petId: pet.id,
    userId: user.id,
    services,
    petData: pet,
    worldSnapshot,
    inventory,
    activeQuests,
    availableQuests,
    characterConfig: (pet.characterConfig as any) ?? {},
  };

  // Process message — Providers inject pet/world/inventory/quest/knowledge
  // context automatically; no manual dynamicContext needed for pet chat
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `pet-${pet.id}-${user.id}`,
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

petRoutes.post('/me/heartbeat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = heartbeatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  const positionX = Math.round(result.data.positionX);
  const positionY = Math.round(result.data.positionY);

  // Update position + lastActiveAt in DB (fire and forget)
  db.update(pets)
    .set({
      positionX,
      positionY,
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)))
    .catch(() => {});

  // Phase 2: Ensure pet is registered in the simulation bridge and
  // report user activity so the pet snaps back to user control.
  const bridge = npcSimulation.petAutonomyManager;
  if (!bridge.isRegistered(user.id)) {
    // Lazy-load pet data on first heartbeat (fire-and-forget)
    db.query.pets
      .findFirst({
        where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
      })
      .then((pet) => {
        if (!pet) return;
        bridge.register({
          petId: pet.id,
          userId: user.id,
          name: pet.name,
          species: pet.species,
          color: pet.color,
          archetype: pet.archetype ?? 'curious',
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

  // Update streak metadata first — the token credit goes through the ledger
  await db.update(pets)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      updatedAt: new Date(),
    })
    .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)));

  // Atomic + audited token credit
  const { balanceAfter: totalTokens } = await creditClawTokens({
    petId: pet.id,
    amount: tokensEarned,
    reason: 'daily_login',
    source: 'daily_login',
    metadata: { streak: newStreak, date: today },
  });

  return c.json({ streak: newStreak, tokensEarned, totalTokens, alreadyClaimed: false });
});
