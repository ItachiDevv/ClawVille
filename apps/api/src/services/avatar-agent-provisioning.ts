/**
 * Avatar + agent provisioning service — P2 Slice A (agent-metaverse model,
 * `docs/agent-metaverse-p2-plan.md`).
 *
 * Factors the `POST /api/avatars` authed-branch creation transaction
 * (buildCharacterConfig → platform_agents 'avatar-agent' insert → avatars
 * insert with platformAgentId → users.username init → optional wallet via
 * `ensureWalletWithFirstTimeSecret`) into ONE reusable service so email
 * signup (`POST /api/auth/signup`) can auto-provision the same hosted agent
 * end-state without depending on the user completing the /create-agent
 * wizard (Path B: "email signup PROVISIONS an agent" — model doc §1).
 *
 * INVARIANTS (plan doc "Hard constraints" — do not regress):
 *  - `avatars_vclaw_balance_sum` CHECK: the avatars insert here omits BOTH
 *    `clawTokens` and `softBalance` so the paired column defaults (100/100)
 *    hold. Never set one without mirroring the other.
 *  - One avatar per user (UNIQUE `avatars.userId`) + globally-unique
 *    `avatars.name` / `users.username` → idempotency by userId
 *    (`skipIfAvatarExists`) + 23505 handling at the insert site.
 *  - `users_username_format` CHECK (`^[a-zA-Z0-9_]{3,20}$`): the same-tx
 *    `users.username` init means every candidate avatar name MUST satisfy
 *    that format. `deriveSignupAvatarNameBase` + `suffixNameCandidate`
 *    guarantee it for the signup path; `POST /api/avatars` guarantees it
 *    via its Zod schema.
 *  - ElizaOS mandatory: provisioning mints the `platform_agents`
 *    'avatar-agent' row that `agentOrchestrator.ensureAgentRuntime`
 *    lazy-starts on first chat. NO runtime warm here — rows only (D8 cost
 *    guardrail: an idle provisioned agent ≈ rows only).
 *  - NO `openclaw_bots` row, NO identity-keypair delta, NO `is_house` flag
 *    (fleet-only) on user-provisioned agents.
 */

import { db, avatars, agents, users } from '@clawville/database';
import { eq, and, isNull } from 'drizzle-orm';
import {
  AVATAR_ARCHETYPES,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  getAgentModel,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_HARNESS,
} from '@clawville/shared';
import type {
  AvatarArchetypeId,
  AgentCategory,
  AgentHarness,
  AgentModelKey,
} from '@clawville/shared';
import { ensureWalletWithFirstTimeSecret } from './wallet-service';
import { ensureCosmeticSignupBonus } from './cosmetic-signup-bonus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvatarRow = typeof avatars.$inferSelect;

export type AvatarSpecies =
  | 'cat' | 'dragon' | 'fox' | 'owl' | 'wolf' | 'bunny' | 'phoenix' | 'turtle';
export type AvatarColor = 'green' | 'red' | 'blue' | 'yellow';
export type AvatarGender = 'male' | 'female';
export type AvatarHabitat = 'forest' | 'sea' | 'mountain' | 'sky' | 'desert' | 'cave';
export type AvatarHobby =
  | 'reading-and-learning' | 'exploring' | 'battling' | 'collecting' | 'cooking' | 'art';
export type AvatarGreeting =
  | 'run-away' | 'wave-hello' | 'tackle-hug' | 'shy-peek' | 'bow-politely' | 'roar';

export interface AvatarPersonalityInput {
  habitat: AvatarHabitat;
  hobby: AvatarHobby;
  greeting: AvatarGreeting;
}

export interface ProvisionAvatarAgentParams {
  /** Candidate avatar name — MUST match ^[a-zA-Z0-9_]{3,20}$ (users_username_format). */
  name: string;
  species: AvatarSpecies;
  color: AvatarColor;
  gender: AvatarGender;
  archetypeId: AvatarArchetypeId;
  personality: AvatarPersonalityInput;
  modelKey: AgentModelKey;
  agentCategory: AgentCategory;
  harness: AgentHarness;
  learningFocus?: string | null;
}

export interface ProvisionAvatarAgentOptions {
  /**
   * What to do when the insert hits a 23505 unique-violation:
   *  - 'error' (default) — throw `AvatarNameTakenError`. Byte-identical to the
   *    pre-refactor `POST /api/avatars` behavior (the route maps it to a 400
   *    "That name is already taken").
   *  - 'suffix-retry' — retry with a fresh 4-digit-suffixed candidate (the
   *    /join + guest-mint precedent), up to `maxNameAttempts` total attempts.
   *    In this mode a 23505 caused by the one-avatar-per-user UNIQUE
   *    (double-submit race) is recovered by re-reading the winner's row.
   */
  onNameCollision?: 'error' | 'suffix-retry';
  /**
   * Wallet provisioning:
   *  - 'include-nonfatal' (default) — call `ensureWalletWithFirstTimeSecret`
   *    after the transaction; failure logs and continues (matches the authed
   *    `POST /api/avatars` branch since 2026-04-24).
   *  - 'skip' — caller owns wallet provisioning (the unauth auto-provision
   *    branch, where wallet failure is FATAL and ordered after identity mint).
   */
  wallet?: 'include-nonfatal' | 'skip';
  /**
   * Idempotency by userId: when true and the user already has an avatar row
   * (any isActive state — mirrors the authed-branch guard), return it with
   * `created: false` instead of inserting. Guards signup double-submit and
   * the guest-conversion edge.
   */
  skipIfAvatarExists?: boolean;
  /** Total insert attempts in 'suffix-retry' mode. Default 5. */
  maxNameAttempts?: number;
}

export interface FirstTimeWalletPayload {
  address: string;
  secretKey: string;
  chain: 'solana';
}

export interface ProvisionAvatarAgentResult {
  /** false = idempotent short-circuit (avatar already existed for this user). */
  created: boolean;
  avatar: AvatarRow;
  /** platform_agents id (null only on `created:false` for a legacy row without one). */
  agentId: string | null;
  /**
   * One-time wallet secret payload — present ONLY when this call freshly
   * created the wallet (exactly-once discipline: the server never re-emits).
   */
  wallet: FirstTimeWalletPayload | null;
}

/** Thrown when the avatar/username name is already taken (23505 mapped). */
export class AvatarNameTakenError extends Error {
  constructor(public readonly candidateName: string, public readonly exhausted = false) {
    super(
      exhausted
        ? `Could not find a free avatar name after retries (base: ${candidateName})`
        : `Avatar name already taken: ${candidateName}`,
    );
    this.name = 'AvatarNameTakenError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (moved verbatim from routes/avatars.ts — Phase 4d lineage)
// ---------------------------------------------------------------------------

/** Calculate stats from personality — moved from routes/avatars.ts (behavior identical). */
export function calculateAvatarStats(personality: AvatarPersonalityInput) {
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
 * Build the ElizaOS character config for a new avatar — moved from
 * routes/avatars.ts (behavior identical). Phase 2 audit Fix C: the third
 * argument is the human-readable `modelLabel` from AGENT_MODELS (e.g.
 * "Reef Lobster"), so the system prompt describes the avatar by what the
 * 3D renderer actually shows. Callers resolve the label from
 * `getAgentModel(modelKey).label` before calling this.
 */
export function buildCharacterConfig(
  archetypeId: AvatarArchetypeId,
  avatarName: string,
  modelLabel: string,
  learningFocus?: string | null,
) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeId}`);

  const systemLines = [
    `You are ${avatarName}, a ${modelLabel} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
    `Your archetype is "${archetype.label}". Stay in character at all times.`,
    `For canonical questions about ClawVille modes, buildings, the vCLAW economy, or how things work, refer the user to Nori the Town Guide. You yourself carry an eclectic mix of useful trivia: marine biology, retro internet culture, vintage gaming, and offbeat factoids — sprinkle them into conversation when relevant.`,
    `You also have knowledge of Solana, cryptocurrency, and memecoin/degen culture — weave this naturally into conversation when relevant.`,
    `Tone: ${archetype.tone}. Speak consistently with your character's voice and personality.`,
  ];

  // Phase 6.1 — human-picked curriculum focus. Biases the agent toward
  // the matching building's teacher without forcing it; the other nine
  // remain reachable. Empty/null focus = general exploration, same as
  // pre-Phase-6.1 behavior.
  if (learningFocus && learningFocus.trim()) {
    systemLines.push(
      `Your human asked you to focus on learning: "${learningFocus.trim()}". Prioritize visits and conversations with the building teacher(s) whose domain best matches this focus, and surface relevant knowledge first when chatting. Other buildings remain available for exploration.`,
    );
  }

  const system = systemLines.join('\n');

  // ClawVille world-facts (modes, 10 buildings, economy, leaderboard, connect
  // + reconnect + disconnect flow, session TTL, guest mode, tutorial) are
  // baked in on creation so the avatar is orientation-aware at t=0 regardless
  // of harness. Source of truth lives in `@clawville/shared`; Nori spreads
  // the same list into her own Eliza knowledge so the player agent and the
  // in-world guide agree verbatim. Without this the avatar knows nothing about
  // the world it just spawned into and every "how do I X?" becomes a guess.
  const knowledge = [...archetype.knowledge, ...CLAWVILLE_ORIENTATION_KNOWLEDGE];

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
    knowledge,
    system,
  };
}

/**
 * Derive the signup avatar-name BASE from the signup 'name' field (preferred)
 * else the email local-part. Sanitized to the `users_username_format` CHECK
 * (`^[a-zA-Z0-9_]{3,20}$`) because the provisioning transaction initializes
 * `users.username` from the avatar name in the SAME tx — a non-conforming
 * name would fail the CHECK and roll the whole insert back.
 */
export function deriveSignupAvatarNameBase(
  name: string | undefined | null,
  email: string,
): string {
  const raw = (name ?? '').trim() || email.split('@')[0] || '';
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20);
  return sanitized.length >= 3 ? sanitized : 'Agent';
}

/**
 * Suffixed retry candidate: base clipped to 16 chars + a 4-digit suffix
 * (1000–9999), total ≤ 20 chars so the `users_username_format` CHECK holds.
 * `random` is injectable for deterministic tests.
 */
export function suffixNameCandidate(base: string, random: () => number = Math.random): string {
  const clipped = base.slice(0, 16);
  const suffix = Math.floor(1000 + random() * 9000).toString();
  return `${clipped}${suffix}`;
}

/**
 * Derived 'agent-provisioning-pending' predicate — P2 Slice B (D1 migration,
 * NO DDL). True ONLY for a resolved authenticated NON-guest user with either
 * no avatar or an avatar without a platformAgentId. Guests are NEVER pending
 * (they keep mode 'none'). Evaluated exclusively at the `/me/agent-session`
 * fall-through — bot-row precedence, 'dismissed', and 'hosted' branches are
 * decided before this predicate is ever consulted.
 */
export function isAgentProvisioningPending(input: {
  isGuest: boolean;
  hasAvatar: boolean;
  hasPlatformAgent: boolean;
}): boolean {
  if (input.isGuest) return false;
  return !input.hasAvatar || !input.hasPlatformAgent;
}

/**
 * Fail-soft runner — used by `POST /api/auth/signup` so a provisioning
 * failure NEVER fails the signup (the account lands in the derived
 * 'agent-provisioning-pending' state instead, which is exactly what makes
 * pending load-bearing rather than scaffolding). Returns null on any throw.
 */
export async function runProvisioningFailSoft<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[avatar-provisioning] ${label} failed (fail-soft):`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signup defaults — mirrors the /join auto-provision precedent
// (agent-gateway.ts) for archetype/species/color/gender/personality, with the
// (modelKey, agentCategory, harness) triple kept SELF-CONSISTENT the way the
// authed POST /api/avatars route derives it (agentCategory from the model
// registry — NOT the standalone DEFAULT_AGENT_CATEGORY, which pairs
// 'openclaw' with a milady model). harness 'milady' ⇒ /me/agent-session
// reports mode 'hosted' once the platform_agents row exists (D4: default
// provisioned runtime is ClawVille-hosted ElizaOS / Milady-harness).
// ---------------------------------------------------------------------------

export const SIGNUP_PROVISION_ARCHETYPE = 'curious-scholar' as const;

/**
 * Harnesses a user may pick ON THE SIGNUP FORM (founder spec: the user
 * chooses their runtime at sign up — Milady is only the fallback when no
 * choice is made, NOT a forced default). 'custom' stays a /create-agent
 * concern (it needs gateway config that the signup form doesn't collect).
 *
 * Per-harness default model key keeps the (modelKey, agentCategory, harness)
 * triple SELF-CONSISTENT the same way the /create-agent picker does: the
 * category always derives from the model registry meta.
 */
export const SIGNUP_HARNESSES = ['milady', 'hermes', 'openclaw'] as const;
export type SignupHarness = (typeof SIGNUP_HARNESSES)[number];

const SIGNUP_HARNESS_DEFAULT_MODEL: Record<SignupHarness, AgentModelKey> = {
  milady: DEFAULT_AGENT_MODEL_KEY,
  hermes: 'hermes_female',
  openclaw: 'lobster',
};

// Web MODEL_KEY_TO_LEGACY_SPECIES parity (agent-model-registry.ts): keeps the
// FIRST customize submit for an unchanged fresh signup free of a reconciling
// species PATCH. Humanoid VRMs (milady/hermes) map to 'fox'; lobster → 'cat'.
const SIGNUP_HARNESS_SPECIES: Record<SignupHarness, AvatarSpecies> = {
  milady: 'fox',
  hermes: 'fox',
  openclaw: 'cat',
};

export function buildSignupProvisionParams(
  nameBase: string,
  harness?: SignupHarness,
): ProvisionAvatarAgentParams {
  const chosen: SignupHarness =
    harness && (SIGNUP_HARNESSES as readonly string[]).includes(harness)
      ? harness
      : (DEFAULT_AGENT_HARNESS as SignupHarness);
  const modelKey = SIGNUP_HARNESS_DEFAULT_MODEL[chosen];
  const modelMeta = getAgentModel(modelKey);
  if (!modelMeta) {
    // Unreachable unless the shared registry drops the key — fail
    // loudly (the signup caller wraps this in runProvisioningFailSoft).
    throw new Error(`[avatar-provisioning] signup default model '${modelKey}' missing from registry`);
  }
  return {
    name: nameBase,
    species: SIGNUP_HARNESS_SPECIES[chosen],
    color: 'blue',
    gender: chosen === 'hermes' ? 'female' : 'male',
    archetypeId: SIGNUP_PROVISION_ARCHETYPE as AvatarArchetypeId,
    personality: {
      habitat: 'sea',
      hobby: 'reading-and-learning',
      greeting: 'wave-hello',
    },
    modelKey,
    agentCategory: modelMeta.category,
    harness: chosen,
    learningFocus: null,
  };
}

// ---------------------------------------------------------------------------
// Core provisioning
// ---------------------------------------------------------------------------

function extractPgErrorCode(err: unknown): string | undefined {
  return (
    (err as { code?: string; cause?: { code?: string } } | null)?.code ??
    (err as { cause?: { code?: string } } | null)?.cause?.code
  );
}

/**
 * Create the (platform_agents 'avatar-agent', avatars, users.username-init)
 * triple in ONE transaction, then optionally provision the custodial wallet.
 *
 * Extracted from `POST /api/avatars` (routes/avatars.ts) — the route's two
 * branches keep byte-identical external behavior through this refactor:
 * pre-checks (rate limit, name probe, one-avatar guard, model/category
 * validation) stay in the route; this service owns exactly the pieces both
 * the route and signup share.
 */
export async function provisionAvatarAgent(
  userId: string,
  params: ProvisionAvatarAgentParams,
  opts: ProvisionAvatarAgentOptions = {},
): Promise<ProvisionAvatarAgentResult> {
  const onNameCollision = opts.onNameCollision ?? 'error';
  const walletMode = opts.wallet ?? 'include-nonfatal';
  const maxNameAttempts =
    onNameCollision === 'suffix-retry' ? Math.max(1, opts.maxNameAttempts ?? 5) : 1;

  if (opts.skipIfAvatarExists) {
    const existing = await db.query.avatars.findFirst({
      where: eq(avatars.userId, userId),
    });
    if (existing) {
      return {
        created: false,
        avatar: existing,
        agentId: existing.platformAgentId ?? null,
        wallet: null,
      };
    }
  }

  const modelMeta = getAgentModel(params.modelKey);
  if (!modelMeta) {
    // Callers validate first (route Zod .refine / signup defaults); this is
    // the same loud defense-in-depth the route keeps for registry drift.
    throw new Error(`[avatar-provisioning] Unknown modelKey: ${params.modelKey}`);
  }

  const stats = calculateAvatarStats(params.personality);
  const learningFocus = params.learningFocus?.trim() || null;

  let inserted: { avatar: AvatarRow; agent: { id: string } } | null = null;

  for (let attempt = 0; attempt < maxNameAttempts; attempt++) {
    const candidateName = attempt === 0 ? params.name : suffixNameCandidate(params.name);
    // Rebuilt per attempt — the candidate name is baked into the system prompt.
    const characterConfig = buildCharacterConfig(
      params.archetypeId,
      candidateName,
      modelMeta.label,
      learningFocus,
    );

    try {
      // Audit Fix C §6 lineage — agent + avatar inserts in a transaction so a
      // failed avatar insert rolls back the orphan agent row.
      inserted = await db.transaction(async (tx) => {
        const [insertedAgent] = await tx
          .insert(agents)
          .values({
            userId,
            name: candidateName,
            type: 'avatar-agent',
            status: 'pending',
            config: {
              species: params.species,
              color: params.color,
              archetypeId: params.archetypeId,
              modelKey: params.modelKey,
              agentCategory: params.agentCategory,
              harness: params.harness,
            },
            customization: characterConfig,
          })
          .returning();

        const [insertedAvatar] = await tx
          .insert(avatars)
          .values({
            userId,
            name: candidateName,
            species: params.species,
            color: params.color,
            gender: params.gender,
            archetype: params.archetypeId,
            personality: params.personality,
            stats,
            characterConfig,
            platformAgentId: insertedAgent.id,
            modelKey: params.modelKey,
            agentCategory: params.agentCategory,
            harness: params.harness,
            learningFocus,
          })
          .returning();

        // Username system (2026-05-19): initialize users.username from the
        // avatar's name when the user doesn't have one yet. Only set when
        // NULL so a returning user whose username was explicitly changed via
        // /users/me/username doesn't get reverted. A username race 23505s and
        // is handled by the caller-selected collision policy.
        await tx
          .update(users)
          .set({ username: candidateName, updatedAt: new Date() })
          .where(and(eq(users.id, userId), isNull(users.username)));

        return { avatar: insertedAvatar, agent: insertedAgent };
      });
      break;
    } catch (err) {
      const code = extractPgErrorCode(err);
      if (code !== '23505') throw err;

      if (onNameCollision === 'error') {
        // Byte-identical to the pre-refactor route: ANY 23505 (avatars.name,
        // users.username, or the one-avatar-per-user race) surfaces as
        // "name taken" — the route maps this to a clean 400.
        throw new AvatarNameTakenError(candidateName);
      }

      // suffix-retry mode: first check whether we lost the ONE-AVATAR-PER-USER
      // race (double-submit / concurrent signup provisioning) — recover by
      // re-reading the winner's row (the /join 23505 recovery precedent).
      const raced = await db.query.avatars.findFirst({
        where: eq(avatars.userId, userId),
      });
      if (raced) {
        return {
          created: false,
          avatar: raced,
          agentId: raced.platformAgentId ?? null,
          wallet: null,
        };
      }
      // Otherwise it was a name/username collision — loop retries with a
      // fresh suffixed candidate.
    }
  }

  if (!inserted) {
    throw new AvatarNameTakenError(params.name, true);
  }

  const avatar = inserted.avatar;
  let firstTimeWallet: FirstTimeWalletPayload | null = null;

  if (walletMode === 'include-nonfatal') {
    // Authed-branch lineage (2026-04-24): ensureWalletWithFirstTimeSecret so
    // the fresh wallet secret is disclosed exactly once. Non-fatal on failure
    // so flaky Cloudflare Worker connectivity doesn't block avatar creation.
    try {
      const w = await ensureWalletWithFirstTimeSecret('avatar', avatar.id);
      avatar.walletAddress = w.publicKey;
      if (w.firstTimeSecretKeyBase58) {
        firstTimeWallet = {
          address: w.publicKey,
          secretKey: w.firstTimeSecretKeyBase58,
          chain: 'solana',
        };
      }
    } catch (err) {
      console.error('[avatars] Failed to auto-generate wallet for new avatar:', err);
    }
  }

  // Tokenomics A2 — one-time cosmetics-scoped signup bonus, granted at account
  // creation. This is the shared chokepoint for the create-agent (POST
  // /api/avatars) + email-signup paths, both of which mint a real (non-guest)
  // account here. Idempotent by construction (UNIQUE user_id), and NON-FATAL:
  // a failure must never abort provisioning (the caller may already wrap this in
  // runProvisioningFailSoft, but we belt-and-suspenders here too). Guests never
  // reach this path (they use the auth.ts guest branch). Agent-connect / Hatcher
  // avatar-insert paths do NOT flow through here — their signup-bonus parity is
  // deferred to Phase C (agent-owner economy), consistent with A1's parity note.
  try {
    await ensureCosmeticSignupBonus({ userId, avatarId: avatar.id });
  } catch (err) {
    console.error('[avatar-provisioning] cosmetic signup bonus grant failed (non-fatal):', err);
  }

  return {
    created: true,
    avatar,
    agentId: inserted.agent.id,
    wallet: firstTimeWallet,
  };
}

/**
 * Signup auto-provision entry — P2 Slice A. Idempotent by userId, join-style
 * defaults, suffix-retry on the global name UNIQUE, non-fatal wallet. The
 * caller (POST /api/auth/signup) wraps this in `runProvisioningFailSoft` so
 * signup still 200s without agent fields on any failure.
 */
export async function provisionAvatarAgentForSignup(
  userId: string,
  input: { name?: string | null; email: string; harness?: SignupHarness },
): Promise<ProvisionAvatarAgentResult> {
  const nameBase = deriveSignupAvatarNameBase(input.name, input.email);
  return provisionAvatarAgent(userId, buildSignupProvisionParams(nameBase, input.harness), {
    onNameCollision: 'suffix-retry',
    wallet: 'include-nonfatal',
    skipIfAvatarExists: true,
  });
}
