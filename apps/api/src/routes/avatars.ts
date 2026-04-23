import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql } from 'drizzle-orm';
import { db, avatars, agents, avatarInventory, users } from '@clawville/database';
import {
  AVATAR_ARCHETYPES,
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

export const avatarRoutes = new Hono<AppContext>();

// Phase 4d — rate limit for unauth POST /api/avatars. Mirrors the budget
// of `connectRateLimiter` in agent-gateway.ts: 5 new account mints per
// IP per minute. Protects against name squatting + Cloudflare Worker
// quota drain (each auto-provision wraps an identity + wallet key).
// Only gates the auto-provision branch — authed callers are unlimited
// since they're already session-bound.
const autoProvisionRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

avatarRoutes.use('*', sessionMiddleware);

// Create avatar schema — archetype-based (no manual characterConfig)
// Phase 2: modelKey / agentCategory / harness are optional on the wire so
// older clients still work, but when present they're validated against the
// shared AGENT_MODELS registry. Server applies the defaults if omitted.
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

/**
 * Build the ElizaOS character config for a new avatar. Phase 2 audit Fix C:
 * the third argument is now the human-readable `modelLabel` from
 * AGENT_MODELS (e.g. "Reef Lobster") instead of the legacy `species`
 * enum value (e.g. "cat"), so the system prompt describes the avatar by
 * what the 3D renderer actually shows rather than the legacy fantasy
 * animal. Callers resolve the label from `getAgentModel(modelKey).label`
 * before calling this.
 */
function buildCharacterConfig(archetypeId: PetArchetypeId, avatarName: string, modelLabel: string) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const system = [
    `You are ${avatarName}, a ${modelLabel} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
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

// Create avatar (one per user) - also creates ElizaOS agent.
//
// Phase 4d (2026-04-23): this route no longer requires a pre-existing
// Lucia session. When called without a session, we auto-provision a new
// user (identity keypair + custodial wallet) and attach a fresh Lucia
// session via Set-Cookie — same model as POST /api/agent/join, but for
// humans who hit /create-agent directly in the browser. Brand Identity:
// "agent creation IS signup." No email required at signup; it's an
// optional recovery vector bolted on later.
avatarRoutes.post('/', async (c) => {
  const sessionUser = c.get('user'); // populated by sessionMiddleware (nullable)
  const isAutoProvision = !sessionUser;
  const body = await c.req.json();
  const result = createAvatarSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0].message });
  }

  // Audit CRITICAL #1 — rate limit the auto-provision branch. Each mint
  // creates a user row, an ed25519 keypair (2 CF Worker wraps), a Solana
  // wallet row, an agent row, a avatar row, and a Lucia session. Unbounded
  // callers could DoS the Worker + fill the `users`/`wallets` tables +
  // grief the project by squatting desirable avatar names. 5/min/IP matches
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
  const existingName = await db.query.avatars.findFirst({
    where: eq(avatars.name, result.data.name),
  });

  if (existingName) {
    throw new HTTPException(400, { message: 'That name is already taken' });
  }

  // The ID the rest of this handler uses — either the existing session
  // user's id, or the freshly auto-provisioned one. On the auto-
  // provision path the users row is created NOW, but identity keypair +
  // wallet + Lucia session are deferred until AFTER the avatar insert
  // succeeds (audit CRITICAL #2 — the /join reference only issues
  // secrets post-success; doing otherwise leaks/loses the plaintext
  // identity secret if the avatar transaction later fails).
  let ownerId: string;

  if (isAutoProvision) {
    // Anonymous identity — unique per submission, so each /create-agent
    // POST without a session produces its own fresh user row.
    const identityKey = crypto.randomUUID();
    const resolved = await resolveOrCreateUserByIdentity('anonymous', identityKey);
    ownerId = resolved.id;
  } else {
    // Existing-session path — guard against creating a second avatar.
    const existingPet = await db.query.avatars.findFirst({
      where: eq(avatars.userId, sessionUser.id),
    });

    if (existingPet) {
      throw new HTTPException(400, { message: 'You already have a avatar' });
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
  // enum value. The system prompt now describes the avatar by what the 3D
  // renderer actually shows.
  const characterConfig = buildCharacterConfig(
    result.data.archetypeId as PetArchetypeId,
    result.data.name,
    modelMeta.label,
  );

  // Audit Fix C §6 — wrap the agent + avatar inserts in a transaction so a
  // failed avatar insert rolls back the orphan agent row.
  //
  // Audit HIGH #6 (2026-04-23) — catch the 23505 unique-violation on
  // avatar name race INSIDE the try/catch so the caller gets a clean 400
  // instead of a 500. Only maps 23505 → 400; any other error rethrows.
  let avatar, agent;
  try {
    const txResult = await db.transaction(async (tx) => {
      const [insertedAgent] = await tx
        .insert(agents)
        .values({
          userId: ownerId,
          name: result.data.name,
          type: 'avatar-agent',
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
        .insert(avatars)
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

      return { avatar: insertedPet, agent: insertedAgent };
    });
    avatar = txResult.avatar;
    agent = txResult.agent;
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code === '23505') {
      // A concurrent signup claimed `avatars.name` (or `agents.name`) in the
      // window between our SELECT and INSERT. Surface as 400 — the orphan
      // `users` row on the auto-provision path is harmless (no identity,
      // no wallet, no session bound to it yet).
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
    throw err;
  }

  // --- Post-success: identity + wallet + session (auto-provision only) ---
  //
  // Audit CRITICAL #2 — all three of these happen AFTER the avatar exists.
  // If any of them throw here, we respond with 500 and the avatar lives;
  // next request with a session cookie (if created) OR a recovery flow
  // can resume. Crucially we never leak a plaintext identity secret
  // into a response whose partner avatar row failed to insert.
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
      console.error('[avatars] auto-provision identity not first-time for fresh user', ownerId);
    }

    // 2. Provision the Solana avatar wallet — FATAL on auto-provision path
    //    (audit CRITICAL #3). If Cloudflare Worker is down we'd rather
    //    500 than leave the user with a avatar that has no wallet + no
    //    way to recover the plaintext secret later.
    const w = await ensureWalletWithFirstTimeSecret('avatar', avatar.id);
    avatar.walletAddress = w.publicKey;
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

    // 4. Audit HIGH #5 — emit `identity.issued` with `avatarId` populated,
    //    mirroring agent-gateway /join so /dash tiles aggregate cleanly.
    await logEvent({
      eventType: 'identity.issued',
      userId: ownerId,
      avatarId: avatar.id,
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
      const wallet = await ensureWallet('avatar', avatar.id);
      avatar.walletAddress = wallet.publicKey;
    } catch (err) {
      console.error('[avatars] Failed to auto-generate wallet for new avatar:', err);
    }
  }

  return c.json({
    avatar,
    agentId: agent.id,
    // Phase 4d — first-time identity + wallet disclosure. Present only
    // when the avatar was created by an auto-provisioned (unauth) call.
    // Subsequent /api/avatars POSTs by the same user would 400 ("already
    // have a avatar"), so these are truly one-time.
    ...(firstTimeIdentity ? { identity: firstTimeIdentity } : {}),
    ...(firstTimeWallet ? { wallet: firstTimeWallet } : {}),
  });
});

// Get user's avatar
avatarRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    return c.json({ avatar: null });
  }

  // Phase 5.1 — surface the 'scape account-linking state onto the avatar
  // response so the frontend avatar-settings modal can render the correct
  // linked/unlinked branch without a second round-trip to /api/auth/me.
  // These columns live on the `users` table (see plan §15.3 + schema
  // users.ts), not on avatars — we pull just the two fields the UI needs.
  const userScape = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: {
      linkedScapePrincipalId: true,
      linkedScapeDisplayName: true,
    },
  });

  return c.json({
    avatar: {
      ...avatar,
      linkedScapePrincipalId: userScape?.linkedScapePrincipalId ?? null,
      linkedScapeDisplayName: userScape?.linkedScapeDisplayName ?? null,
    },
  });
});

// Update avatar position
const updatePositionSchema = z.object({
  positionX: z.number().int().min(0).max(5120),
  positionY: z.number().int().min(0).max(5120),
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
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
    .returning();

  if (!updated) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  return c.json({ avatar: updated });
});

// ---------------------------------------------------------------------------
// Phase 4c Layer 1 — in-game appearance edits (avatar / color / gender).
// ---------------------------------------------------------------------------
// Purely cosmetic, no runtime restart needed. modelKey swap is constrained
// to the current harness's pool so a user can't promote a self-hosted avatar
// to a hosted Milady by swapping avatars. Color + gender are independent.
//
// Not bundled into the existing PATCH /me (position heartbeat) because that
// route is a hot path and conflating it with appearance edits would make
// it easier to accidentally overwrite fields on a partial body.
// ---------------------------------------------------------------------------
const appearanceSchema = z.object({
  modelKey: z.string()
    .refine((k): k is AgentModelKey => (AGENT_MODEL_KEYS as readonly string[]).includes(k), {
      message: `modelKey must be one of: ${AGENT_MODEL_KEYS.join(', ')}`,
    })
    .optional(),
  color: z.enum(['green', 'red', 'blue', 'yellow']).optional(),
  gender: z.enum(['male', 'female']).optional(),
});

avatarRoutes.patch('/me/appearance', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = appearanceSchema.safeParse(body);

  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? 'Invalid appearance payload',
    });
  }

  const hasEdit = parsed.data.modelKey || parsed.data.color || parsed.data.gender;
  if (!hasEdit) {
    throw new HTTPException(400, { message: 'No fields to update' });
  }

  // Find current avatar — need its harness to validate the modelKey swap.
  const current = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });
  if (!current) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  // Harness-pool guard — a Milady-harness avatar can only swap between
  // Milady VRM avatars; a non-Milady avatar can only pick non-Milady
  // avatars. Prevents a user from bypassing the Milady-only hosting
  // contract by swapping avatars mid-game.
  if (parsed.data.modelKey) {
    const newModel = getAgentModel(parsed.data.modelKey);
    if (!newModel) {
      throw new HTTPException(400, { message: `Unknown modelKey: ${parsed.data.modelKey}` });
    }
    const currentlyMilady = current.harness === 'milady';
    const newIsMilady = newModel.category === 'milady';
    if (currentlyMilady !== newIsMilady) {
      throw new HTTPException(400, {
        message: currentlyMilady
          ? 'Milady-hosted agents can only swap between Milady avatars'
          : 'Self-hosted agents cannot pick a Milady avatar — their framework runs externally',
      });
    }
  }

  // Build the update set — only include fields the client asked to change.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  let newModelLabel: string | null = null;
  if (parsed.data.modelKey) {
    patch.modelKey = parsed.data.modelKey;
    // Derive agentCategory from the new model so (modelKey, category) stay
    // self-consistent. Harness is NOT touched.
    const newModel = getAgentModel(parsed.data.modelKey)!;
    patch.agentCategory = newModel.category;
    newModelLabel = newModel.label;
    // Legacy `species` enum is deliberately NOT synced here — it only
    // feeds the PixiJS 2D fallback and diverging from the modelKey is
    // harmless. The 3D world reads modelKey directly.
  }
  if (parsed.data.color) patch.color = parsed.data.color;
  if (parsed.data.gender) patch.gender = parsed.data.gender;

  // Audit follow-up — when modelKey changes, regenerate the system
  // prompt so it references the NEW creature rather than keeping the
  // creation-time "You are X, a Reef Lobster..." string forever.
  // Preserves every other characterConfig field (bio, lore, knowledge,
  // topics, style, etc.) so hand-tuned or learned content survives.
  // Eliza runtimes lazy-start on first chat + idle-stop at 30min, so
  // the new prompt is picked up naturally on the next runtime boot
  // without an explicit restart.
  if (newModelLabel && current.characterConfig && typeof current.characterConfig === 'object') {
    const archetype = AVATAR_ARCHETYPES.find((a) => a.id === current.archetype);
    if (archetype) {
      const newSystem = [
        `You are ${current.name}, a ${newModelLabel} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
        `Your archetype is "${archetype.label}". Stay in character at all times.`,
        `You exist in ClawVille and have deep knowledge of LegacyTheme lore, culture, and locations.`,
        `You also have knowledge of Solana, cryptocurrency, and memecoin/degen culture — weave this naturally into conversation when relevant.`,
        `Tone: ${archetype.tone}. Speak consistently with your character's voice and personality.`,
      ].join('\n');
      patch.characterConfig = {
        ...(current.characterConfig as unknown as Record<string, unknown>),
        system: newSystem,
      };
    }
  }

  // Transactional update — keep avatars + agents.config in lockstep so
  // the agent-row mirror doesn't drift from the avatars row. Before this
  // a modelKey edit left agents.config.modelKey pointing at the old
  // value; harmless today (no downstream reader) but defense in depth
  // for Phase 4e exports + any future orchestrator path that reads
  // the agents table as a source of truth.
  const updated = await db.transaction(async (tx) => {
    const [updatedPet] = await tx
      .update(avatars)
      .set(patch)
      .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
      .returning();

    // Audit fix — a concurrent deactivation between the SELECT above
    // and this UPDATE would produce zero returned rows. Without this
    // guard the handler returned { avatar: undefined }.
    if (!updatedPet) {
      throw new HTTPException(404, { message: 'Avatar not found or inactive' });
    }

    // Mirror modelKey / agentCategory / customization onto the linked
    // agents row if the avatar has one. Harness / archetype are NOT
    // touched here — they're Layer 2+ concerns.
    const needsAgentMirror =
      !!current.platformAgentId && (patch.modelKey || patch.characterConfig);
    if (needsAgentMirror) {
      const [agentRow] = await tx
        .select()
        .from(agents)
        .where(eq(agents.id, current.platformAgentId!))
        .limit(1);
      if (agentRow) {
        const nextAgentConfig = {
          ...((agentRow.config ?? {}) as Record<string, unknown>),
          ...(patch.modelKey ? { modelKey: patch.modelKey } : {}),
          ...(patch.agentCategory ? { agentCategory: patch.agentCategory } : {}),
        };
        const agentPatch: Record<string, unknown> = {
          config: nextAgentConfig,
          updatedAt: new Date(),
        };
        if (patch.characterConfig) {
          agentPatch.customization = patch.characterConfig;
        }
        await tx
          .update(agents)
          .set(agentPatch)
          .where(eq(agents.id, agentRow.id));
      }
    }

    return updatedPet;
  });

  // Audit fix — emit `avatar.appearance.changed` so /dash can aggregate
  // edit volume alongside the existing identity.issued / skill_md.fetched
  // counters. Payload carries only the fields that actually changed, so
  // downstream analyses can count avatar swaps vs. color tweaks vs.
  // gender flips independently.
  const changed: Record<string, unknown> = {};
  if (patch.modelKey && patch.modelKey !== current.modelKey) {
    changed.modelKey = { from: current.modelKey, to: patch.modelKey };
  }
  if (patch.color && patch.color !== current.color) {
    changed.color = { from: current.color, to: patch.color };
  }
  if (patch.gender && patch.gender !== current.gender) {
    changed.gender = { from: current.gender, to: patch.gender };
  }
  if (Object.keys(changed).length > 0) {
    logEvent({
      eventType: 'avatar.appearance.changed',
      userId: user.id,
      avatarId: updated.id,
      payload: { changed, harness: current.harness },
    }).catch((err) => {
      // Event logging is best-effort — a logger outage should never
      // turn a successful edit into a 500. The event-logger has its
      // own three-tier fallback (see apps/api/src/services/event-logger.ts).
      console.error('[avatars] appearance event log failed:', err);
    });
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
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
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

  // Build state for Providers + Actions
  const services = { db, creditClawTokens, debitClawTokens } as ClawvilleServices;

  let worldSnapshot: any = null;
  try {
    worldSnapshot = npcSimulation.getSnapshot();
  } catch { /* NPC simulation may not be running */ }

  let inventory: any[] = [];
  try {
    inventory = await db.query.avatarInventory.findMany({
      where: eq(avatarInventory.avatarId, avatar.id),
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
        eq(questSubmissions.avatarId, avatar.id),
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
    avatarId: avatar.id,
    userId: user.id,
    services,
    petData: avatar,
    worldSnapshot,
    inventory,
    activeQuests,
    availableQuests,
    characterConfig: (avatar.characterConfig as any) ?? {},
  };

  // Process message — Providers inject avatar/world/inventory/quest/knowledge
  // context automatically; no manual dynamicContext needed for avatar chat
  const response = await runtime.processMessage(result.data.content, {
    userId: user.id,
    roomId: `avatar-${avatar.id}-${user.id}`,
    platform: 'clawville',
    state,
  });

  void logEvent({
    eventType: 'agent.chat.turn',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      chatType: 'avatar',
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

avatarRoutes.post('/me/heartbeat', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = heartbeatSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  const positionX = Math.round(result.data.positionX);
  const positionY = Math.round(result.data.positionY);

  // Update position + lastActiveAt in DB (fire and forget)
  db.update(avatars)
    .set({
      positionX,
      positionY,
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
    .catch(() => {});

  // Phase 2: Ensure avatar is registered in the simulation bridge and
  // report user activity so the avatar snaps back to user control.
  const bridge = npcSimulation.petAutonomyManager;
  if (!bridge.isRegistered(user.id)) {
    // Lazy-load avatar data on first heartbeat (fire-and-forget)
    db.query.avatars
      .findFirst({
        where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      })
      .then((avatar) => {
        if (!avatar) return;
        bridge.register({
          avatarId: avatar.id,
          userId: user.id,
          name: avatar.name,
          species: avatar.species,
          color: avatar.color,
          archetype: avatar.archetype ?? 'curious',
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
avatarRoutes.post('/me/daily-login', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastLogin = avatar.lastLoginDate;

  // Already claimed today
  if (lastLogin === today) {
    return c.json({
      streak: avatar.loginStreak,
      tokensEarned: 0,
      totalTokens: avatar.clawTokens,
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
      newStreak = (avatar.loginStreak ?? 0) + 1;
    }
    // diffDays > 1 means gap, reset to 1
  }

  // Calculate reward: 10 + streak * 5, max 100
  const tokensEarned = Math.min(100, 10 + newStreak * 5);

  // Update streak metadata first — the token credit goes through the ledger
  await db.update(avatars)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)));

  // Atomic + audited token credit
  const { balanceAfter: totalTokens } = await creditClawTokens({
    avatarId: avatar.id,
    amount: tokensEarned,
    reason: 'daily_login',
    source: 'daily_login',
    metadata: { streak: newStreak, date: today },
  });

  return c.json({ streak: newStreak, tokensEarned, totalTokens, alreadyClaimed: false });
});
