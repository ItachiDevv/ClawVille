import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, pets, agents, petInventory, users } from '@clawville/database';
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
import { logEvent } from '../services/event-logger';
import type { ClawvilleServices } from '@clawville/agent-runtime';
import { ensureWallet, ensureWalletWithFirstTimeSecret } from '../services/wallet-service';
import { resolveOrCreateUserByIdentity, generateIdentityKeypairForUser } from '../services/identity-service';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { lucia } from '../lib/auth';
import type { AppContext } from '../types';
import { z } from 'zod';

export const petRoutes = new Hono<AppContext>();

// Phase 4d — rate limit for unauth POST /api/pets. Mirrors the budget
// of `connectRateLimiter` in agent-gateway.ts: 5 new account mints per
// IP per minute. Protects against name squatting + Cloudflare Worker
// quota drain (each auto-provision wraps an identity + wallet key).
// Only gates the auto-provision branch — authed callers are unlimited
// since they're already session-bound.
const autoProvisionRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

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

// Create pet (one per user) - also creates ElizaOS agent.
//
// Phase 4d (2026-04-23): this route no longer requires a pre-existing
// Lucia session. When called without a session, we auto-provision a new
// user (identity keypair + custodial wallet) and attach a fresh Lucia
// session via Set-Cookie — same model as POST /api/agent/join, but for
// humans who hit /create-agent directly in the browser. Brand Identity:
// "agent creation IS signup." No email required at signup; it's an
// optional recovery vector bolted on later.
petRoutes.post('/', async (c) => {
  const sessionUser = c.get('user'); // populated by sessionMiddleware (nullable)
  const isAutoProvision = !sessionUser;
  const body = await c.req.json();
  const result = createPetSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Audit CRITICAL #1 — rate limit the auto-provision branch. Each mint
  // creates a user row, an ed25519 keypair (2 CF Worker wraps), a Solana
  // wallet row, an agent row, a pet row, and a Lucia session. Unbounded
  // callers could DoS the Worker + fill the `users`/`wallets` tables +
  // grief the project by squatting desirable pet names. 5/min/IP matches
  // `connectRateLimiter` in agent-gateway.ts.
  if (isAutoProvision) {
    const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
    if (!autoProvisionRateLimiter.check(ip)) {
      throw new HTTPException(429, {
        message: 'Too many signups from this IP. Try again in 1 minute.',
      });
    }
  }

  // Name uniqueness — check FIRST, before any writes. Reduces the
  // collision window so the transactional 23505 fallback below is rare.
  const existingName = await db.query.pets.findFirst({
    where: eq(pets.name, result.data.name),
  });

  if (existingName) {
    throw new HTTPException(400, { message: 'That name is already taken' });
  }

  // The ID the rest of this handler uses — either the existing session
  // user's id, or the freshly auto-provisioned one. On the auto-
  // provision path the users row is created NOW, but identity keypair +
  // wallet + Lucia session are deferred until AFTER the pet insert
  // succeeds (audit CRITICAL #2 — the /join reference only issues
  // secrets post-success; doing otherwise leaks/loses the plaintext
  // identity secret if the pet transaction later fails).
  let ownerId: string;

  if (isAutoProvision) {
    // Anonymous identity — unique per submission, so each /create-agent
    // POST without a session produces its own fresh user row.
    const identityKey = crypto.randomUUID();
    const resolved = await resolveOrCreateUserByIdentity('anonymous', identityKey);
    ownerId = resolved.id;
  } else {
    // Existing-session path — guard against creating a second pet.
    const existingPet = await db.query.pets.findFirst({
      where: eq(pets.userId, sessionUser.id),
    });

    if (existingPet) {
      throw new HTTPException(400, { message: 'You already have a pet' });
    }

    ownerId = sessionUser.id;
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
  // failed pet insert rolls back the orphan agent row.
  //
  // Audit HIGH #6 (2026-04-23) — catch the 23505 unique-violation on
  // pet name race INSIDE the try/catch so the caller gets a clean 400
  // instead of a 500. Only maps 23505 → 400; any other error rethrows.
  let pet, agent;
  try {
    const txResult = await db.transaction(async (tx) => {
      const [insertedAgent] = await tx
        .insert(agents)
        .values({
          userId: ownerId,
          name: result.data.name,
          type: 'pet-agent',
          status: 'pending',
          config: {
            species: result.data.species,
            color: result.data.color,
            archetypeId: result.data.archetypeId,
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
          userId: ownerId,
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
    pet = txResult.pet;
    agent = txResult.agent;
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code === '23505') {
      // A concurrent signup claimed `pets.name` (or `agents.name`) in the
      // window between our SELECT and INSERT. Surface as 400 — the orphan
      // `users` row on the auto-provision path is harmless (no identity,
      // no wallet, no session bound to it yet).
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
    throw err;
  }

  // --- Post-success: identity + wallet + session (auto-provision only) ---
  //
  // Audit CRITICAL #2 — all three of these happen AFTER the pet exists.
  // If any of them throw here, we respond with 500 and the pet lives;
  // next request with a session cookie (if created) OR a recovery flow
  // can resume. Crucially we never leak a plaintext identity secret
  // into a response whose partner pet row failed to insert.
  let firstTimeIdentity: {
    userId: string;
    publicKey: string;
    secretKey: string;
  } | null = null;
  let firstTimeWallet: {
    address: string;
    secretKey: string;
    chain: 'solana';
  } | null = null;

  if (isAutoProvision) {
    // 1. Mint ed25519 identity keypair. On race-loser we throw (rather
    //    than silently returning no identity), because a browser that
    //    just auto-provisioned a user with NO identity is stuck.
    const ident = await generateIdentityKeypairForUser(ownerId);
    if (ident.isFirstTime && ident.secretKey) {
      firstTimeIdentity = {
        userId: ownerId,
        publicKey: ident.publicKey,
        secretKey: ident.secretKey,
      };
    } else {
      // Should be unreachable — the user row was created in THIS request,
      // nothing else has touched it. But surface loudly if it happens.
      console.error('[pets] auto-provision identity not first-time for fresh user', ownerId);
    }

    // 2. Provision the Solana pet wallet — FATAL on auto-provision path
    //    (audit CRITICAL #3). If Cloudflare Worker is down we'd rather
    //    500 than leave the user with a pet that has no wallet + no
    //    way to recover the plaintext secret later.
    const w = await ensureWalletWithFirstTimeSecret('pet', pet.id);
    pet.walletAddress = w.publicKey;
    if (w.firstTimeSecretKeyBase58) {
      firstTimeWallet = {
        address: w.publicKey,
        secretKey: w.firstTimeSecretKeyBase58,
        chain: 'solana',
      };
    }

    // 3. Mint the Lucia session LAST, so the Set-Cookie header only
    //    ships when everything above succeeded. Lucia's
    //    createSessionCookie honors NODE_ENV (SameSite=None+Secure in
    //    prod, Lax+insecure in dev).
    const session = await lucia.createSession(ownerId, {});
    const cookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', cookie.serialize(), { append: true });

    // 4. Audit HIGH #5 — emit `identity.issued` with `petId` populated,
    //    mirroring agent-gateway /join so /dash tiles aggregate cleanly.
    await logEvent({
      eventType: 'identity.issued',
      userId: ownerId,
      petId: pet.id,
      payload: {
        identityType: 'anonymous',
        identityPubkey: firstTimeIdentity?.publicKey ?? ident.publicKey,
        via: 'create-agent',
      },
    });
  } else {
    // Authed path — just ensure the wallet exists (non-fatal on failure,
    // matches pre-Phase-4d behavior). Secret stays server-held; no
    // first-time disclosure.
    try {
      const wallet = await ensureWallet('pet', pet.id);
      pet.walletAddress = wallet.publicKey;
    } catch (err) {
      console.error('[pets] Failed to auto-generate wallet for new pet:', err);
    }
  }

  return c.json({
    pet,
    agentId: agent.id,
    // Phase 4d — first-time identity + wallet disclosure. Present only
    // when the pet was created by an auto-provisioned (unauth) call.
    // Subsequent /api/pets POSTs by the same user would 400 ("already
    // have a pet"), so these are truly one-time.
    ...(firstTimeIdentity ? { identity: firstTimeIdentity } : {}),
    ...(firstTimeWallet ? { wallet: firstTimeWallet } : {}),
  });
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

  // Phase 5.1 — surface the 'scape account-linking state onto the pet
  // response so the frontend pet-settings modal can render the correct
  // linked/unlinked branch without a second round-trip to /api/auth/me.
  // These columns live on the `users` table (see plan §15.3 + schema
  // users.ts), not on pets — we pull just the two fields the UI needs.
  const userScape = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: {
      linkedScapePrincipalId: true,
      linkedScapeDisplayName: true,
    },
  });

  return c.json({
    pet: {
      ...pet,
      linkedScapePrincipalId: userScape?.linkedScapePrincipalId ?? null,
      linkedScapeDisplayName: userScape?.linkedScapeDisplayName ?? null,
    },
  });
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

  void logEvent({
    eventType: 'agent.chat.turn',
    userId: user.id,
    petId: pet.id,
    payload: {
      chatType: 'pet',
      messageLength: result.data.content.length,
      tokenAwarded: 0,
    },
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
