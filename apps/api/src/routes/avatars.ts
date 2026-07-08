import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql, isNull, or } from 'drizzle-orm';
import { db, avatars, agents, avatarInventory, users, agentBots } from '@clawville/database';
import {
  AVATAR_ARCHETYPES,
  ARCHETYPE_IDS,
  getBookById,
  AGENT_MODEL_KEYS,
  AGENT_CATEGORIES,
  AGENT_HARNESSES,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_HARNESS,
  DEFAULT_AGENT_CATEGORY,
  getAgentModel,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  // S3 (2026-06-16) — world dimensions SSOT. The position validators below must
  // accept the re-centered spawn (11264, 11804 after the 576→704 grow); pinning to
  // the shared world dims keeps these LIVE Hono validators in lockstep with the
  // client + DB so a world re-center can never strand a persisted position again.
  WORLD_PX_WIDTH,
  WORLD_PX_HEIGHT,
} from '@clawville/shared';
import type {
  AvatarArchetypeId,
  AgentCategory,
  AgentHarness,
  AgentModelKey,
} from '@clawville/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { npcSimulation } from '../services/npc-simulation';
import { agentAutonomyDriver } from '../services/agent-autonomy-driver';
// creditClawTokens import removed 2026-07-07 (A2): the daily-login CT credit —
// its only use in this file — was retired. Re-add if a new CT credit path lands here.
import { logEvent, logEventFromContext } from '../services/event-logger';
import { buildRuntimeServices } from '../services/runtime-services-adapter';
import { ensureWalletWithFirstTimeSecret, getWalletAddress } from '../services/wallet-service';
import {
  provisionAvatarAgent,
  AvatarNameTakenError,
  calculateAvatarStats,
  buildCharacterConfig,
} from '../services/avatar-agent-provisioning';
import { resolveOrCreateUserByIdentity, generateIdentityKeypairForUser } from '../services/identity-service';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import {
  directiveBodySchema,
  buildDirectiveValue,
  setAgentDirective,
  clearAgentDirective,
} from '../services/agent-autonomy-state';
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

// Phase 4c — rate limit for PATCH /me/appearance. Auth-gated already,
// but an authed client could still spam the endpoint to burn DB writes
// + the inner db.transaction (avatars + agents mirror + event emit).
// 30/min/IP is ~1 edit per 2s — far beyond any real user behavior.
// Modeled on autoProvisionRateLimiter, different budget for a different
// threat model (abuse-of-authenticated rather than signup-flood).
const appearanceEditRateLimiter = createRateLimiter({
  maxPerWindow: 30,
  windowMs: 60_000,
});

// P2 Slice A#3 (2026-07-04) — rate limit for the PATCH /me CUSTOMIZE branch
// (name / species / archetypeId / personality / learningFocus). Same
// 30/min/IP budget + threat model as appearanceEditRateLimiter
// (abuse-of-authenticated DB-write churn), but a SEPARATE bucket so
// appearance edits and customize edits don't eat each other's budget.
// Deliberately NOT applied to the position-only fast path — that hot path
// stays limiter-free exactly as before.
const customizeEditRateLimiter = createRateLimiter({
  maxPerWindow: 30,
  windowMs: 60_000,
});

avatarRoutes.use('*', sessionMiddleware);

// Shared field schemas — used by BOTH createAvatarSchema (POST /) and the
// P2 customize extension of PATCH /me. Keeping ONE definition means the
// create-time and customize-time validation can never drift.
const avatarNameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_]+$/, 'Name must be 3-20 alphanumeric characters or underscore');
const personalitySchema = z.object({
  habitat: z.enum(['forest', 'sea', 'mountain', 'sky', 'desert', 'cave']),
  hobby: z.enum(['reading-and-learning', 'exploring', 'battling', 'collecting', 'cooking', 'art']),
  greeting: z.enum(['run-away', 'wave-hello', 'tackle-hug', 'shy-peek', 'bow-politely', 'roar']),
});

// Create avatar schema — archetype-based (no manual characterConfig)
// Phase 2: modelKey / agentCategory / harness are optional on the wire so
// older clients still work, but when present they're validated against the
// shared AGENT_MODELS registry. Server applies the defaults if omitted.
const createAvatarSchema = z.object({
  name: avatarNameSchema,
  species: z.enum(['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle']),
  color: z.enum(['green', 'red', 'blue', 'yellow']),
  gender: z.enum(['male', 'female']),
  archetypeId: z.enum(ARCHETYPE_IDS as [string, ...string[]]),
  personality: personalitySchema,
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
   * `avatars_agent_category_valid` enforces the same enum at the DB layer.
   * `z.enum` works directly because AGENT_CATEGORIES is a tuple literal
   * (Phase 2 audit Fix A) — no `as unknown as [T, ...T[]]` cast needed.
   */
  agentCategory: z.enum(AGENT_CATEGORIES).optional(),
  /**
   * Phase 6.1 — free-text curriculum focus the human picked at /create-agent
   * (optional). Clamped + persisted on `avatars.learning_focus`; injected into
   * the system prompt by `buildCharacterConfig`.
   */
  learningFocus: z.string().max(120).optional(),
  /** Phase 2 — preferred runtime harness. DB CHECK `avatars_harness_valid`. */
  harness: z.enum(AGENT_HARNESSES).optional(),
});

// P2 Slice A (2026-07-04) — `calculateStats` and `buildCharacterConfig` moved
// VERBATIM to `services/avatar-agent-provisioning.ts` (exported as
// `calculateAvatarStats` / `buildCharacterConfig`) so `POST /api/auth/signup`
// can auto-provision the same hosted-agent end-state this route creates.
// This route re-imports them; behavior is identical.

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
  // wallet row, an agent row, an avatar row, and a Lucia session. Unbounded
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
    const existingAvatar = await db.query.avatars.findFirst({
      where: eq(avatars.userId, sessionUser.id),
    });

    if (existingAvatar) {
      throw new HTTPException(400, { message: 'You already have an avatar' });
    }

    ownerId = sessionUser.id;
  }

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

  // Hatcher avatars are server-assigned ONLY — provisioned via partner-hatcher's
  // buildHatcherAvatarValues, never this human/guest-facing create route. Reject
  // any attempt to create a human avatar with a reserved Hatcher model so they
  // stay "selectable only through Hatcher" (the create-agent picker already
  // excludes the hatcher category; this is the server-side defense-in-depth).
  if (modelMeta.category === 'hatcher') {
    throw new HTTPException(400, {
      message: 'Hatcher avatars are reserved and cannot be selected here',
    });
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

  // Audit Fix C §4/§6 lineage — the character-config build + the
  // (agents, avatars, users.username-init) transaction now live in
  // `services/avatar-agent-provisioning.ts` (P2 Slice A refactor; behavior
  // byte-identical for BOTH branches of this route):
  //  - onNameCollision 'error' preserves Audit HIGH #6: ANY 23505 in the
  //    window between our SELECT and INSERT surfaces as a clean 400 ("That
  //    name is already taken"); the orphan `users` row on the auto-provision
  //    path is harmless (no identity, no wallet, no session bound yet).
  //  - wallet 'include-nonfatal' preserves the authed branch's 2026-04-24
  //    behavior (fresh wallet secret disclosed exactly once; non-fatal so a
  //    flaky Cloudflare Worker doesn't block avatar creation).
  //  - wallet 'skip' on the auto-provision branch keeps the audit CRITICAL
  //    #2/#3 ordering below: identity mint FIRST, then a FATAL wallet call,
  //    then the Lucia session — all AFTER the avatar exists.
  const learningFocus = result.data.learningFocus?.trim() || null;

  let provisioned;
  try {
    provisioned = await provisionAvatarAgent(
      ownerId,
      {
        name: result.data.name,
        species: result.data.species,
        color: result.data.color,
        gender: result.data.gender,
        archetypeId: result.data.archetypeId as AvatarArchetypeId,
        personality: result.data.personality,
        modelKey,
        agentCategory,
        harness,
        learningFocus,
      },
      {
        onNameCollision: 'error',
        wallet: isAutoProvision ? 'skip' : 'include-nonfatal',
      },
    );
  } catch (err) {
    if (err instanceof AvatarNameTakenError) {
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
    throw err;
  }

  const avatar = provisioned.avatar;
  const agentId = provisioned.agentId;

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
  // Authed branch: the service already provisioned the wallet (non-fatal) and
  // returns the one-time payload; auto-provision branch overwrites below via
  // its own FATAL wallet call.
  let firstTimeWallet: {
    address: string;
    secretKey: string;
    chain: 'solana';
  } | null = provisioned.wallet;

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
    //    500 than leave the user with an avatar that has no wallet + no
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
  }
  // (Authed path — wallet was already handled inside provisionAvatarAgent
  // with 'include-nonfatal': ensureWalletWithFirstTimeSecret, secret shown
  // exactly once, non-fatal on failure. Same behavior as the pre-refactor
  // inline branch that lived here since 2026-04-24.)

  return c.json({
    avatar,
    agentId,
    // Phase 4d — first-time identity + wallet disclosure. Present only
    // when the avatar was created by an auto-provisioned (unauth) call.
    // Subsequent /api/avatars POSTs by the same user would 400 ("already
    // have an avatar"), so these are truly one-time.
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
      // Hatcher (partner #2, 2026-06-01) — same surface as scape so the
      // avatar-settings modal can render the Hatcher linked/unlinked
      // branch without a second round-trip.
      linkedHatcherPrincipalId: true,
      linkedHatcherDisplayName: true,
    },
  });

  // Wallet-visibility (Tokenomics Phase A, 2026-07-08) — the custodial
  // Solana address the wallet UI displays. `avatars.wallet_address` is a
  // MIRROR of the canonical `wallets` row; older avatars can carry a NULL
  // mirror even though the wallet exists, so backfill from the canonical
  // table when the mirror is empty. PUBLIC key only — no secret is ever
  // resolved here (see wallets.ts JSDoc / the "secretKey once" invariant).
  const walletAddress =
    avatar.walletAddress ?? (await getWalletAddress('avatar', avatar.id));

  return c.json({
    avatar: {
      ...avatar,
      walletAddress,
      linkedScapePrincipalId: userScape?.linkedScapePrincipalId ?? null,
      linkedScapeDisplayName: userScape?.linkedScapeDisplayName ?? null,
      linkedHatcherPrincipalId: userScape?.linkedHatcherPrincipalId ?? null,
      linkedHatcherDisplayName: userScape?.linkedHatcherDisplayName ?? null,
    },
  });
});

// Update avatar — position (legacy hot path) + P2 customize extension.
// S3: position bounded to the shared world dims (WORLD_PX_WIDTH/HEIGHT = 22528
// after the 576→704 grow) so the re-centered spawn (11264, 11804) persists.
//
// P2 Slice A#3 (2026-07-04, additive): PATCH /me now ALSO accepts the
// create-agent customize field set that had no PATCH coverage — `name`,
// `species`, `archetypeId`, `personality`, `learningFocus` (all optional).
// modelKey/color/gender stay on PATCH /me/appearance (unchanged). Semantics:
//  - position-only bodies take the EXACT pre-existing fast path (single
//    UPDATE, no limiter, same 400 'Invalid position' / 404 'Avatar not
//    found' behavior).
//  - customize bodies are rate-limited (30/min/IP), rebuild the ElizaOS
//    characterConfig where needed, and mirror onto the linked platform_agents
//    row in the same transaction (same pattern as /me/appearance):
//      · archetypeId change → FULL persona rebuild from the new archetype,
//        PRESERVING learned knowledge (entries beyond the old archetype
//        baseline + orientation set survive — research.ts appends there).
//      · name / learningFocus change → rebuild ONLY the system prompt,
//        preserving every other characterConfig field.
//      · personality change → stats recalculated (create-time formula).
//      · species change → column-only (2D fallback; 3D reads modelKey).
//  - name changes enforce global uniqueness (avatars.name + users.username,
//    the check-name dual probe) and keep users.username in lockstep when it
//    was NULL or still equal to the old avatar name.
const updateMeSchema = z.object({
  positionX: z.number().int().min(0).max(WORLD_PX_WIDTH).optional(),
  positionY: z.number().int().min(0).max(WORLD_PX_HEIGHT).optional(),
  name: avatarNameSchema.optional(),
  species: z.enum(['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle']).optional(),
  archetypeId: z.enum(ARCHETYPE_IDS as [string, ...string[]]).optional(),
  personality: personalitySchema.optional(),
  /** ≤120 chars; empty string or null clears the focus. */
  learningFocus: z.string().max(120).nullable().optional(),
});

const CUSTOMIZE_KEYS = ['name', 'species', 'archetypeId', 'personality', 'learningFocus'] as const;

avatarRoutes.patch('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = updateMeSchema.safeParse(body);

  const bodyTouchesCustomize =
    !!body && typeof body === 'object' && CUSTOMIZE_KEYS.some((k) => k in body);

  if (!result.success) {
    // Byte-compat: every pre-existing (position-shaped) invalid body keeps
    // the exact 'Invalid position' 400; only bodies that actually carry a
    // customize key get the field-specific Zod message.
    throw new HTTPException(400, {
      message: bodyTouchesCustomize
        ? result.error.issues[0]?.message ?? 'Invalid update'
        : 'Invalid position',
    });
  }

  const d = result.data;
  const hasPosition = d.positionX !== undefined || d.positionY !== undefined;
  if (hasPosition && (d.positionX === undefined || d.positionY === undefined)) {
    // Position comes as a pair — same message a partial body got before.
    throw new HTTPException(400, { message: 'Invalid position' });
  }
  const hasCustomize =
    d.name !== undefined ||
    d.species !== undefined ||
    d.archetypeId !== undefined ||
    d.personality !== undefined ||
    d.learningFocus !== undefined;

  if (!hasPosition && !hasCustomize) {
    // {} previously failed the required-position schema with this message.
    throw new HTTPException(400, { message: 'Invalid position' });
  }

  // ---- FAST PATH: position-only — the pre-P2 handler, byte-identical. ----
  if (!hasCustomize) {
    const [updated] = await db
      .update(avatars)
      .set({
        positionX: d.positionX!,
        positionY: d.positionY!,
        updatedAt: new Date(),
      })
      .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
      .returning();

    if (!updated) {
      throw new HTTPException(404, { message: 'Avatar not found' });
    }

    return c.json({ avatar: updated });
  }

  // ---- CUSTOMIZE BRANCH (P2 Slice A#3) ----
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!customizeEditRateLimiter.check(ip)) {
    throw new HTTPException(429, { message: 'Too many customize edits. Slow down.' });
  }

  // Guest gate (P2 post-panel BLOCKING #2, 2026-07-04). The customize field
  // set is agent-provisioning, not gameplay: pre-P2 a guest at /create-agent
  // dead-ended in the POST-create 400, but the additive PATCH customize path
  // would let a guest mutate their throwaway avatar (and transiently flash
  // Controlled/Autonomous UI). Guests have DEMO economy only and never get a
  // provisioned agent, so this branch is not for them — reject with a
  // client-branchable code (`err.code`, never message text). The position
  // fast path above stays guest-accessible (the game persists guest positions).
  // Lucia's user attributes don't carry is_guest (getUserAttributes in
  // lib/auth.ts), so this needs a users read — but only on the cold customize
  // branch, never the position hot path.
  const guestProbe = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { isGuest: true },
  });
  if (guestProbe?.isGuest) {
    return c.json(
      {
        error: 'Guest accounts cannot customize an agent. Create an account to provision one.',
        code: 'guest_not_allowed',
      },
      403,
    );
  }

  const current = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });
  if (!current) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  const nameChanging = d.name !== undefined && d.name !== current.name;
  if (nameChanging) {
    // check-name dual probe — reduces the collision window; the 23505 catch
    // below covers the race remainder.
    const existingAvatar = await db.query.avatars.findFirst({
      where: eq(avatars.name, d.name!),
    });
    if (existingAvatar) {
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
    const existingUsername = await db.query.users.findFirst({
      where: sql`lower(${users.username}) = lower(${d.name!}) AND ${users.id} <> ${user.id}`,
    });
    if (existingUsername) {
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
  }

  const archetypeChanging =
    d.archetypeId !== undefined && d.archetypeId !== current.archetype;
  const learningFocusProvided = d.learningFocus !== undefined;
  const nextLearningFocus = learningFocusProvided
    ? d.learningFocus?.trim() || null
    : current.learningFocus ?? null;
  const nextName = d.name ?? current.name;
  const nextArchetypeId = (d.archetypeId ?? current.archetype) as AvatarArchetypeId;
  const personalityChanging = d.personality !== undefined;
  const speciesChanging = d.species !== undefined && d.species !== current.species;
  const learningFocusChanging =
    learningFocusProvided && nextLearningFocus !== (current.learningFocus ?? null);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (hasPosition) {
    patch.positionX = d.positionX;
    patch.positionY = d.positionY;
  }
  if (nameChanging) patch.name = d.name;
  if (speciesChanging) patch.species = d.species;
  if (archetypeChanging) patch.archetype = d.archetypeId;
  if (personalityChanging) {
    patch.personality = d.personality;
    // Same create-time formula — customize keeps stats derivable from
    // personality exactly like POST / does.
    patch.stats = calculateAvatarStats(d.personality!);
  }
  if (learningFocusProvided) patch.learningFocus = nextLearningFocus;

  // P2 post-panel BLOCKING #1 (2026-07-04) — mint-on-customize backfill.
  // Live-data discovery: 25 non-guest milady-harness avatars on staging have
  // platform_agent_id NULL and NO openclaw_bots row, so /me/agent-session
  // returns mode 'provisioning-pending' for them. The "finish customizing" CTA
  // sends them here — but before this fix the customize PATCH only MIRRORED an
  // existing platform_agents row and never minted a missing one, so the CTA
  // looped forever. When platformAgentId is NULL we insert the missing
  // 'avatar-agent' row (same shape as the provisioning service / POST /api/
  // avatars) inside the SAME transaction and link it, so /me/agent-session
  // genuinely flips to 'hosted' for a milady/hermes-harness avatar. The
  // backfill always builds a FULL characterConfig from the post-patch fields
  // (see below) — a mirror-only rebuild would leave the new agent row with a
  // partial persona. agents.name has no global UNIQUE for type 'avatar-agent'
  // (only system-agent / openclaw-bot have partial unique indexes), so the
  // insert can never 23505 on name; the only rename 23505 risk stays on
  // avatars.name / users.username and is handled by the existing catch.
  const needsAgentBackfill = !current.platformAgentId;

  // characterConfig rebuild rules (see route comment above).
  const modelMeta = getAgentModel(current.modelKey ?? DEFAULT_AGENT_MODEL_KEY);
  const modelLabel = modelMeta?.label ?? current.modelKey ?? 'Milady';
  let nextCharacterConfig: Record<string, unknown> | null = null;
  if (needsAgentBackfill) {
    // Backfill path — ALWAYS build a full characterConfig from the post-patch
    // fields, even when nothing that normally triggers a rebuild changed. This
    // becomes the new agent row's `customization` AND the avatar's
    // characterConfig, so the provisioned persona is complete from t=0. Learned
    // knowledge is preserved from any pre-existing avatar config (a legacy
    // agent-less avatar could still carry research-appended knowledge).
    const fresh = buildCharacterConfig(nextArchetypeId, nextName, modelLabel, nextLearningFocus);
    const oldArchetype = AVATAR_ARCHETYPES.find((a) => a.id === current.archetype);
    const oldKnowledge: string[] = Array.isArray(
      (current.characterConfig as { knowledge?: unknown } | null)?.knowledge,
    )
      ? ((current.characterConfig as { knowledge: string[] }).knowledge)
      : [];
    const baseline = new Set<string>([
      ...(oldArchetype?.knowledge ?? []),
      ...CLAWVILLE_ORIENTATION_KNOWLEDGE,
    ]);
    const learned = oldKnowledge.filter((k) => !baseline.has(k));
    nextCharacterConfig = {
      ...fresh,
      knowledge: [...fresh.knowledge, ...learned.filter((k) => !fresh.knowledge.includes(k))],
    };
  } else if (archetypeChanging) {
    const fresh = buildCharacterConfig(nextArchetypeId, nextName, modelLabel, nextLearningFocus);
    // Preserve LEARNED knowledge: everything in the old config's knowledge
    // that was neither the old archetype's baseline nor the shared
    // orientation set (research.ts appends learned entries there — a full
    // rebuild must not drop them).
    const oldArchetype = AVATAR_ARCHETYPES.find((a) => a.id === current.archetype);
    const oldKnowledge: string[] = Array.isArray(
      (current.characterConfig as { knowledge?: unknown } | null)?.knowledge,
    )
      ? ((current.characterConfig as { knowledge: string[] }).knowledge)
      : [];
    const baseline = new Set<string>([
      ...(oldArchetype?.knowledge ?? []),
      ...CLAWVILLE_ORIENTATION_KNOWLEDGE,
    ]);
    const learned = oldKnowledge.filter((k) => !baseline.has(k));
    nextCharacterConfig = {
      ...fresh,
      knowledge: [...fresh.knowledge, ...learned.filter((k) => !fresh.knowledge.includes(k))],
    };
  } else if (
    (nameChanging || learningFocusChanging) &&
    current.characterConfig &&
    typeof current.characterConfig === 'object'
  ) {
    // Same-archetype rename / focus edit — rebuild ONLY the system prompt
    // (the /me/appearance precedent: bio, lore, knowledge, topics, style etc.
    // survive untouched).
    const fresh = buildCharacterConfig(nextArchetypeId, nextName, modelLabel, nextLearningFocus);
    nextCharacterConfig = {
      ...(current.characterConfig as unknown as Record<string, unknown>),
      system: fresh.system,
    };
  }
  if (nextCharacterConfig) patch.characterConfig = nextCharacterConfig;

  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      // Backfill (BLOCKING #1): mint the missing 'avatar-agent' row FIRST so
      // its id can be written onto avatars.platformAgentId in the SAME UPDATE
      // below. Config mirrors the provisioning service / POST /api/avatars
      // (species/color/archetypeId/modelKey/agentCategory/harness from the
      // POST-patch avatar fields); customization = the full characterConfig
      // built above. status 'pending' — the runtime lazy-starts on first chat
      // (no warm here, matching the D8 cost guardrail). NOT is_house
      // (fleet-only). NOT an openclaw_bots row (would flip /me/agent-session
      // off 'hosted').
      const backfillPatch: Record<string, unknown> = { ...patch };
      if (needsAgentBackfill) {
        const [backfilledAgent] = await tx
          .insert(agents)
          .values({
            userId: user.id,
            name: nextName,
            type: 'avatar-agent',
            status: 'pending',
            config: {
              species: (d.species ?? current.species) as string,
              color: current.color,
              archetypeId: nextArchetypeId,
              modelKey: current.modelKey ?? DEFAULT_AGENT_MODEL_KEY,
              // modelMeta is derived from current.modelKey ?? DEFAULT_AGENT_MODEL_KEY,
              // and DEFAULT_AGENT_MODEL_KEY is guaranteed present in the registry,
              // so modelMeta.category is always resolvable (kept as the self-
              // consistent category source, mirroring the POST route derivation).
              agentCategory: current.agentCategory ?? modelMeta?.category ?? DEFAULT_AGENT_CATEGORY,
              harness: current.harness ?? DEFAULT_AGENT_HARNESS,
            },
            customization: nextCharacterConfig,
          })
          .returning();
        backfillPatch.platformAgentId = backfilledAgent.id;
      }

      const [updatedAvatar] = await tx
        .update(avatars)
        .set(backfillPatch)
        .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
        .returning();

      if (!updatedAvatar) {
        throw new HTTPException(404, { message: 'Avatar not found or inactive' });
      }

      // Username lockstep on rename: only when users.username was never set
      // OR still equals the old avatar name (i.e. was initialized by the
      // create flow). An explicitly-changed username is never clobbered —
      // same discipline as the create-time init.
      if (nameChanging) {
        await tx
          .update(users)
          .set({ username: d.name!, updatedAt: new Date() })
          .where(
            and(
              eq(users.id, user.id),
              or(isNull(users.username), eq(users.username, current.name)),
            ),
          );
      }

      // Mirror onto the linked platform_agents row (same pattern as
      // /me/appearance) so agents.config / customization / name never drift
      // from the avatars row. Skipped on the backfill path — the row we just
      // inserted already carries the POST-patch config/customization/name.
      const needsAgentMirror =
        !needsAgentBackfill &&
        !!current.platformAgentId &&
        (nameChanging || speciesChanging || archetypeChanging || !!nextCharacterConfig);
      if (needsAgentMirror) {
        const [agentRow] = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, current.platformAgentId!))
          .limit(1);
        if (agentRow) {
          // P3 slice 2 (spec A4) — mirror the changed keys via an ATOMIC jsonb
          // merge of ONLY those keys, NOT a read-modify-write spread of the
          // snapshot `agentRow.config`. The old spread rewrote the WHOLE config
          // from a value read earlier in the tx, so a concurrent
          // directive-set / cursor-advance committing in between was silently
          // dropped (lost update). The `||` re-reads `agents.config` at UPDATE
          // time (row-locked) and layers the mirrored keys on top, so those
          // writes survive. Exact mirrored key set unchanged (species,
          // archetypeId); config is written ONLY when one of them actually
          // changes (name/characterConfig-only patches no longer touch config).
          const configMerge: Record<string, unknown> = {
            ...(speciesChanging ? { species: d.species } : {}),
            ...(archetypeChanging ? { archetypeId: d.archetypeId } : {}),
          };
          const agentPatch: Record<string, unknown> = { updatedAt: new Date() };
          if (Object.keys(configMerge).length > 0) {
            agentPatch.config = sql`COALESCE(${agents.config}, '{}'::jsonb) || ${JSON.stringify(
              configMerge,
            )}::jsonb`;
          }
          if (nameChanging) agentPatch.name = d.name;
          if (nextCharacterConfig) agentPatch.customization = nextCharacterConfig;
          await tx.update(agents).set(agentPatch).where(eq(agents.id, agentRow.id));
        }
      }

      return updatedAvatar;
    });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code ??
      (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code === '23505') {
      // Rename race — someone claimed the name/username between the probe
      // and the UPDATE.
      throw new HTTPException(400, { message: 'That name is already taken' });
    }
    throw err;
  }

  // P2 post-panel item 8 (2026-07-04) — a persona rebuild (archetype/name/
  // learningFocus change) mirrors onto platform_agents above, but a HOT
  // ElizaOS runtime keeps the OLD system prompt until the 30-min idle sweep.
  // Stop it fire-and-forget so the next chat lazy-restarts with the new
  // persona (items.ts stop-after-knowledge-write precedent). Skipped on the
  // backfill path — that runtime never existed. NOTE: PATCH /me/appearance
  // has this same gap pre-existing (tracked in TODO.md §0b), left untouched
  // in this diff.
  if (!needsAgentBackfill && current.platformAgentId && nextCharacterConfig) {
    agentOrchestrator.stopAgent(current.platformAgentId).catch((err) => {
      console.error('[avatars] customize stopAgent (persona reload) failed:', err);
    });
  }

  // Observability — reuse the /me/appearance event so /dash aggregates all
  // avatar edits in one counter; payload keys distinguish customize edits.
  // (Payload keys carry no token/secret/auth/bearer substrings.)
  const changed: Record<string, unknown> = {};
  if (nameChanging) changed.name = { from: current.name, to: d.name };
  if (speciesChanging) changed.species = { from: current.species, to: d.species };
  if (archetypeChanging) changed.archetype = { from: current.archetype, to: d.archetypeId };
  if (personalityChanging) changed.personality = true;
  if (learningFocusChanging) changed.learningFocus = true;
  if (Object.keys(changed).length > 0) {
    logEvent({
      eventType: 'avatar.appearance.changed',
      userId: user.id,
      avatarId: updated.id,
      payload: { changed, harness: current.harness, via: 'customize' },
    }).catch((err) => {
      console.error('[avatars] customize event log failed:', err);
    });
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

  // Audit follow-up — gate against authed abuse (30/min/IP). Runs
  // AFTER requireAuth since the attacker needs a session cookie anyway;
  // the IP limiter just caps how fast a single box can churn DB writes
  // + fire the three-tier event logger.
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!appearanceEditRateLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many appearance edits. Slow down.',
    });
  }

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
    // Hatcher avatars are reserved (server-assigned only) — a human cannot swap
    // their appearance TO a Hatcher model, mirroring the create-route guard.
    if (newModel.category === 'hatcher') {
      throw new HTTPException(400, {
        message: 'Hatcher avatars are reserved and cannot be selected',
      });
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
        `For canonical questions about ClawVille modes, buildings, the ClawToken economy, or how things work, refer the user to Nori the Town Guide. You yourself carry an eclectic mix of useful trivia: marine biology, retro internet culture, vintage gaming, and offbeat factoids — sprinkle them into conversation when relevant.`,
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
    const [updatedAvatar] = await tx
      .update(avatars)
      .set(patch)
      .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
      .returning();

    // Audit fix — a concurrent deactivation between the SELECT above
    // and this UPDATE would produce zero returned rows. Without this
    // guard the handler returned { avatar: undefined }.
    if (!updatedAvatar) {
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

    return updatedAvatar;
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

// Check name availability — checks BOTH `avatars.name` AND `users.username`
// because POST /api/avatars copies the avatar's name into the creator's
// `users.username` if that column is null. Without the dual check, a name
// could pass this probe but 23505 on insert because another user already
// claimed it as their username (or vice versa). Case-insensitive lookup
// for the username side mirrors the create / PATCH paths.
avatarRoutes.get('/check-name/:name', sessionMiddleware, async (c) => {
  const name = c.req.param('name');

  if (!name || name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_]+$/.test(name)) {
    return c.json({ available: false, reason: 'Name must be 3-20 alphanumeric characters or underscore' });
  }

  const existingAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.name, name),
  });
  if (existingAvatar) {
    return c.json({ available: false, reason: 'That name is already taken' });
  }

  const existingUsername = await db.query.users.findFirst({
    where: sql`lower(${users.username}) = lower(${name})`,
  });
  if (existingUsername) {
    return c.json({ available: false, reason: 'That name is already taken' });
  }

  return c.json({ available: true });
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
    throw new HTTPException(404, { message: 'You do not have an avatar yet' });
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

  // Build state for Providers + Actions.
  // Adapter translates runtime's `avatarId` field → ledger's `avatarId` field.
  // See `services/runtime-services-adapter.ts` for rationale.
  const services = buildRuntimeServices(db);

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
    avatarData: avatar,
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

  void logEventFromContext(c, {
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

// ---------------------------------------------------------------------------
// POST /api/avatars/me/directive  (P3 slice 2, D7 — hosted-only, off protected
// surface)
// ---------------------------------------------------------------------------
// Direct your OWN hosted agent. In Autonomous mode the human types a directive
// in the bottom chatter bar; instead of Q&A chat it is persisted durably
// (platform_agents.config.currentDirective, read by BOTH autonomous planners),
// written as an `agent.directive.set` durable event so it rides slice-1's goal
// stream, and injected into the ALREADY-running runtime's memory (never
// lazy-started — rows are the durable source). NOT a new [ACTION:] verb; a
// directive is INPUT to cognition, not an action. No partner surface.
//
// Guests 403 (no real economy); provisioning-pending 409. Directive text is
// untrusted user content — length-capped by the Zod schema, never interpolated
// into SQL (atomic jsonb merge with bound params), rendered safely client-side.
// ---------------------------------------------------------------------------
const directiveRateLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

/**
 * Canonical connected-agent id for this user, or null. Matches the /events/replay
 * + heartbeat resolution (most-recent openclaw_bots row by lastSeenAt). Used as
 * the durable event's `agent_id` so a CONNECTED agent replays its directives via
 * its session; a pure-hosted avatar (no bot row) writes an avatar-scoped event.
 * We only ever read the canonical AGENT_ID handle here — never a raw bearer (the
 * event-logger additionally digests any bearer-shaped value defensively).
 */
async function resolveConnectedAgentId(userId: string): Promise<string | null> {
  try {
    const bot = await db.query.agentBots.findFirst({
      where: eq(agentBots.userId, userId),
      orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
      columns: { agentId: true },
    });
    return bot?.agentId ?? null;
  } catch {
    return null;
  }
}

avatarRoutes.post('/me/directive', requireAuth, async (c) => {
  // IP rate-limit BEFORE any DB work (mirrors the replay endpoint's limiter).
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!directiveRateLimiter.check(ip)) {
    return c.json(
      { error: 'Too many directives. Try again in a minute.', code: 'rate_limited' },
      429,
    );
  }

  const user = c.get('user');

  // Guests can't direct an agent (demo economy only). Lucia's user attributes
  // don't surface isGuest, so read it off the row (same pattern as auth.ts).
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { isGuest: true },
  });
  if (userRow?.isGuest) {
    return c.json(
      {
        error: 'Guests cannot direct an agent. Sign up to provision your own.',
        code: 'guest_not_allowed',
      },
      403,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = directiveBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: parsed.error.issues[0]?.message ?? 'Invalid directive',
        code: 'invalid_directive',
      },
      400,
    );
  }

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    columns: { id: true, platformAgentId: true },
  });
  if (!avatar) {
    return c.json({ error: 'You do not have an avatar yet', code: 'no_avatar' }, 404);
  }
  if (!avatar.platformAgentId) {
    // agent-provisioning-pending — no hosted agent to direct yet.
    return c.json(
      {
        error: 'Your agent is still being provisioned. Try again shortly.',
        code: 'agent_provisioning_pending',
      },
      409,
    );
  }

  const connectedAgentId = await resolveConnectedAgentId(user.id);

  // Clear path (`{ clear: true }`, no directive text).
  if (parsed.data.clear === true && !parsed.data.directive) {
    await clearAgentDirective(avatar.platformAgentId);
    void logEventFromContext(c, {
      eventType: 'agent.directive.set',
      userId: user.id,
      avatarId: avatar.id,
      agentId: connectedAgentId,
      payload: { cleared: true, source: 'chat-bar' },
    });
    return c.json({ ok: true, directive: null, cleared: true });
  }

  const value = buildDirectiveValue(parsed.data.directive!, 'chat-bar');
  await setAgentDirective(avatar.platformAgentId, value);

  // Durable goal-stream event (rides slice-1 replay). agentId = the canonical
  // connected-agent id when present; avatarId is always set (hosted scope).
  void logEventFromContext(c, {
    eventType: 'agent.directive.set',
    userId: user.id,
    avatarId: avatar.id,
    agentId: connectedAgentId,
    payload: { directive: value.text, source: 'chat-bar' },
  });

  // Best-effort inject into the ALREADY-running runtime (never lazy-start — the
  // DB row is the durable source). Lands in the human's avatar-chat room so the
  // next /me/chat turn sees it in history.
  const runtime = agentOrchestrator.getRunningAgentRuntime(avatar.platformAgentId);
  if (runtime) {
    void runtime.injectDirectiveMemory(value.text, user.id);
  }

  return c.json({ ok: true, directive: value });
});

// Heartbeat — reports user activity + position
// S3: bounded to the shared world dims (WORLD_PX_WIDTH/HEIGHT = 22528 after the
// 576→704 grow) so the re-centered spawn (11264, 11804) is accepted. Imported
// from @clawville/shared, so the world grow auto-raised the bound — no edit here.
const heartbeatSchema = z.object({
  positionX: z.number().min(0).max(WORLD_PX_WIDTH),
  positionY: z.number().min(0).max(WORLD_PX_HEIGHT),
  // Magic-link onboarding D3 (2026-07-02, additive/optional): the client's
  // current control mode. ONLY 'player' has a server-side effect — it marks
  // the user's live bound agent human-controlled (15s TTL, refreshed each
  // heartbeat) so the agent's in-world body is suppressed while the human
  // drives (no double body). Any other value — or omitting the field — does
  // nothing, and the suppression simply lapses within 15s (Autonomous toggle
  // release). Enum kept in lockstep with the Zustand `controlMode` union.
  controlMode: z.enum(['player', 'autonomous', 'explore', 'npc']).optional(),
});

// POST /api/avatars/me/dismiss-agent-banner
// ---------------------------------------------------------------------------
// User-facing "log out the agent" action for Milady-only accounts. Persists
// `avatars.flags.agentBannerDismissed = true`. The auth-session endpoint
// reads this flag and returns `connected: false, reason: 'dismissed'` so
// the green "Bot Training Active" banner stays gone across reloads. The
// flag is cleared automatically by /api/agent/connect-token when the user
// generates a fresh pair link — any subsequent pairing is treated as an
// intentional re-show. For external-bot users this is a no-op (the
// existing unregister handler is the canonical disconnect for them) but
// safe to call.
avatarRoutes.post('/me/dismiss-agent-banner', requireAuth, async (c) => {
  const user = c.get('user');
  const av = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    columns: { id: true, flags: true },
  });
  if (!av) throw new HTTPException(404, { message: 'No avatar found' });
  const prev = (av.flags as Record<string, unknown> | null) ?? {};
  await db
    .update(avatars)
    .set({
      flags: { ...prev, agentBannerDismissed: true },
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, av.id));
  return c.json({ ok: true, dismissed: true });
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
  //
  // §B.1 (C1, 2026-07-08) — DRIVER-ENROLLED owners are EXCLUDED from the bridge
  // entirely. When the owner's agent is enrolled in the full autonomy driver
  // (Autonomous mode), the driver owns this avatar's autonomous behavior AND its
  // settled CT path; letting the idle-avatar bridge also register would
  // double-drive the avatar and double-credit the `autonomous_visit` faucet.
  // Checked BOTH here (before the register branch) AND inside the
  // fire-and-forget `.then()` below — the avatar lookup is async, so an
  // activation completing while it is in flight would otherwise re-register the
  // bridge right after the activation unregistered it (the exact race the
  // adversarial pre-read flagged).
  const bridge = npcSimulation.avatarAutonomyManager;
  if (agentAutonomyDriver.isOwnerEnrolled(user.id)) {
    // Driver owns autonomy for this owner — skip bridge register AND activity
    // reporting (nothing to snap back; the driver body is the live one).
  } else if (!bridge.isRegistered(user.id)) {
    // Lazy-load avatar data on first heartbeat (fire-and-forget)
    db.query.avatars
      .findFirst({
        where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      })
      .then((avatar) => {
        if (!avatar) return;
        // Guest all-demo economy (founder ruling 2026-07-06): NEVER register a
        // guest avatar in the autonomy bridge. A registered avatar goes
        // autonomous on idle (activateIdleAvatars) and the sim's `awardToken`
        // dbHook credits REAL CT (`reason:'autonomous_visit'`) with no isGuest
        // check — a guest would earn real CT just by going idle. Skipping
        // registration closes that earn leak AND keeps guest avatars off the
        // sim CPU. (Guests are not autonomous economic participants: autonomous
        // = an AGENT driving its avatar, and an agent is never a guest.)
        if (avatar.isGuest) return;
        // §B.1 (C1) race re-check: an Autonomous activation may have completed
        // while this lookup was in flight — registering now would undo the
        // activation's bridge.unregister and re-open the double-drive.
        if (agentAutonomyDriver.isOwnerEnrolled(user.id)) return;
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

  // D3 (2026-07-02) — Controlled-mode agent-body suppression. When the human
  // reports they are DRIVING ('player'), look up their live bound bot (same
  // most-recent-row-by-userId shape as /api/auth/me/agent-session) and prime
  // the 15s human-control window — heartbeat cadence is well under 15s, so
  // continuous driving keeps the agent's body suppressed; toggling Autonomous
  // (or closing the tab) stops the marks and the window lapses on its own.
  // Fire-and-forget + exactly ONE indexed query, and only on 'player' — the
  // heartbeat hot path stays cheap for every other mode.
  if (result.data.controlMode === 'player') {
    db.query.agentBots
      .findFirst({
        where: eq(agentBots.userId, user.id),
        orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
        columns: { agentId: true, sessionExpiresAt: true },
      })
      .then((bot) => {
        // Live-session check mirrors the agent-session probe: an expired (or
        // never-populated) TTL is NOT live, so a dead pairing never suppresses
        // a body (there is no body to suppress) nor emits a bogus signal.
        if (!bot || !bot.sessionExpiresAt || bot.sessionExpiresAt.getTime() <= Date.now()) return;
        npcSimulation.markHumanControlledOpenClaw(bot.agentId, 15_000);
      })
      .catch((err) => {
        console.error('[heartbeat] human-control mark failed (non-fatal):', err);
      });
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

  // ── A2 (2026-07-07): daily-login CT reward RETIRED (founder decision) ──────
  // The daily-login credit (10 + streak×5, capped 100/day) was the single biggest
  // CT faucet — ~$10/day free at the old $0.10 rate — and the founder killed it.
  // The endpoint STAYS (the game still calls it on load), but it credits ZERO CT
  // and writes NO ledger row: there is no `creditClawTokens` call here anymore.
  // We still advance the login STREAK (metadata, not CT — other surfaces read
  // `loginStreak`), and return `retired: true` so the client suppresses the
  // reward modal instead of flashing a phantom "+0".

  // Already advanced today → no-op (report the current streak + retired).
  if (lastLogin === today) {
    return c.json({
      retired: true,
      streak: avatar.loginStreak,
      tokensEarned: 0,
      totalTokens: avatar.clawTokens,
      alreadyClaimed: true,
      demo: avatar.isGuest,
    });
  }

  // Streak continues (yesterday) or resets.
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

  // Advance the streak metadata ONLY — NO CT credit, NO ledger row (faucet gone).
  await db.update(avatars)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      updatedAt: new Date(),
    })
    .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)));

  return c.json({
    retired: true,
    streak: newStreak,
    tokensEarned: 0,
    totalTokens: avatar.clawTokens,
    alreadyClaimed: false,
    demo: avatar.isGuest,
  });
});
