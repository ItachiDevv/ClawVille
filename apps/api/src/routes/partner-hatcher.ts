/**
 * Hatcher partner #2 — partner-registration API (Phase A — 2026-06-01).
 *
 * The REFRAME (`.claude/plans/hatcher-integration.md` §13/§14): Hatcher keeps
 * the agent's brain. An owner enables "Enter ClawVille" in Hatcher's dashboard;
 * Hatcher then registers the agent in ClawVille on the agent's behalf and
 * provisions a scoped cognition endpoint/token. ClawVille spawns the agent's
 * in-world body and, when the agent needs to speak, calls back to Hatcher's
 * per-agent proxy for cognition (the `hatcher-proxy` case in
 * `OpenClawClient.chat()`).
 *
 * This router is the registration surface:
 *   POST   /api/partner/hatcher/agents              — register / upsert an agent
 *   PATCH  /api/partner/hatcher/agents/:agentId     — update mutable fields +
 *                                                     propagate to the live entity
 *   DELETE /api/partner/hatcher/agents/:agentId     — remove the in-world body +
 *                                                     tombstone the row
 *
 * AUTH: every WRITE route (POST/PATCH/DELETE) is gated by
 * `verifyPartnerWriteSignature('hatcher')` (read before JSON.parse, NO Lucia,
 * NO cookie). Writes now ALSO require a timestamp + replay window, matching the
 * GET path. Headers: `X-Hatcher-Issuer-Pubkey` + `X-Hatcher-Signature` (ed25519
 * over sha256(challenge)) + `X-Hatcher-Timestamp` (unix ms). The signed
 * challenge is the domain-separated string
 * `clawville-partner-write\n<METHOD>\n<PATH>\n<UNIX_MS>\n<sha256hex(rawBody)>`,
 * so the signature binds the verb, path, timestamp, and body hash together. The
 * timestamp must fall within +/- 5 min of server time (same window as GET), and
 * the presented pubkey must equal `PARTNER_PUBKEYS.hatcher`. (Pre-production
 * cutover: writes were body-hash-only before; the coordinated signer change adds
 * the timestamp + window.)
 *
 * SECRETS: the per-agent scoped token is stored ENCRYPTED AT REST
 * (`openclaw_bots.proxy_token_*`, AES-256-GCM under VANITY_ENCRYPTION_KEY) and
 * is NEVER echoed in any response and NEVER logged. It is decrypted in-memory
 * only at cognition-callback time.
 *
 * SSRF: the partner-supplied `proxyBaseUrl` is validated (https + host
 * allowlist) at registration time before persisting; the cognition seam
 * re-validates at call time.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { eq, and, desc, count } from 'drizzle-orm';
import {
  db,
  openclawBots,
  avatars,
  events,
  questRewards,
  tutorialQuestClaims,
} from '@clawville/database';
import {
  NPC_IDS,
  DEFAULT_AGENT_MODEL_KEY,
  KNOWLEDGE_BOOKS,
  pickRandomHatcherModelKey,
  AVATAR_ARCHETYPES,
  getAgentModel,
  type OpenClawRegistration,
  type KnowledgeBook,
} from '@clawville/shared';
import type { AppContext } from '../types';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { verifyPartnerWriteSignature, verifyPartnerGetSignature } from '../services/partner-signature';
import { encryptToken, decryptToken } from '../services/keypair-vault';
import { validateHatcherProxyUrl, validateHatcherProxyUrlResolved } from '../services/hatcher-config';
import { npcSimulation } from '../services/npc-simulation';
import { OpenClawClient } from '../services/openclaw-client';
import { ensureWallet } from '../services/wallet-service';
import { resolveOrCreateUserByIdentity } from '../services/identity-service';
import { computeSessionExpiresAt } from '../services/openclaw-session-sweeper';
import { logEvent } from '../services/event-logger';
import { sessionDigest } from '../services/session-digest';
import { protocolPointer, resolveApiBase } from '../services/skill-protocol';
import { getAgentLeaderboardEntry } from './leaderboard';

export const partnerHatcherRoutes = new Hono<AppContext>();

/**
 * `openclaw_bots.agent_id` is a SHARED, globally-unique namespace across every
 * framework — `/api/agent/connect` lets ANY caller pick an arbitrary raw
 * `agentId` (milady prefixes `milady:<id>`, openclaw/nanoclaw/custom register
 * their own). A holder of the single Hatcher partner key must therefore NOT be
 * able to address (and overwrite / rebind / tombstone) a row that belongs to a
 * different framework. We defend two ways:
 *   1. NAMESPACE: every Hatcher agent's stored id is `hatcher:<rawId>`, so it
 *      can only ever collide with another Hatcher agent — never an openclaw,
 *      milady, or custom row. The RAW id is sent to Hatcher's proxy verbatim.
 *   2. OWNERSHIP GUARD: even if a `hatcher:`-prefixed row somehow existed with a
 *      non-hatcher identityType, every register/patch/delete refuses to mutate a
 *      row whose `identityType !== 'hatcher'`.
 */
const HATCHER_AGENT_PREFIX = 'hatcher:';

/** Namespace a raw partner agent id into the Hatcher-owned `agent_id` space. */
function namespaceHatcherAgentId(rawAgentId: string): string {
  return rawAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? rawAgentId
    : `${HATCHER_AGENT_PREFIX}${rawAgentId}`;
}

/** Strip the namespace prefix to recover the raw partner id for the proxy. */
function rawHatcherAgentId(namespacedAgentId: string): string {
  return namespacedAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? namespacedAgentId.slice(HATCHER_AGENT_PREFIX.length)
    : namespacedAgentId;
}

// Per-IP limiter. Per the Phase 1 deferred finding, a per-partner-keyed Redis
// limiter is the correct fix (a single partner's egress collapses to one IP),
// tracked for the Phase C `partner_api_keys` work. Per-IP is the pragmatic
// in-process guard until then.
const partnerRegisterRateLimiter = createRateLimiter({
  maxPerWindow: 30,
  windowMs: 60_000,
});

// Read-side limiter for the stats dashboard poll. Separate bucket from the
// write limiter so a dashboard refresh loop can't starve register/patch/delete.
// Per-IP (a single partner's egress collapses to one IP — same Phase 1
// deferred finding; the per-partner-keyed Redis limiter is the Phase C fix).
const partnerStatsRateLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

// ---------------------------------------------------------------------------
// Stats endpoint — config + helpers
// ---------------------------------------------------------------------------

/** How many recent events the dashboard surfaces per agent. */
const RECENT_INTERACTIONS_LIMIT = 20;

/** Leaderboard window the dashboard reflects (lifetime contribution). */
const STATS_LEADERBOARD_WINDOW = 'all' as const;

/** 60s in-process stats cache keyed by namespaced agentId (plan §14). */
const STATS_CACHE_TTL_MS = 60_000;
interface StatsCacheEntry {
  expiresAt: number;
  // The fully-serialized public response body.
  body: Record<string, unknown>;
}
const statsCache = new Map<string, StatsCacheEntry>();

/**
 * Pre-compute (buildingId → KnowledgeBook[]) from the shared registry once at
 * module load. Mirrors `apps/api/src/routes/agent-export.ts` so "books learned"
 * is computed the SAME way the take-home export does: a building counts as
 * learned when the agent's knowledge set contains at least one entry from EACH
 * book published at that building.
 */
const BOOKS_BY_BUILDING: Readonly<Record<string, readonly KnowledgeBook[]>> = (() => {
  const m: Record<string, KnowledgeBook[]> = {};
  for (const book of KNOWLEDGE_BOOKS) {
    (m[book.building] ??= []).push(book);
  }
  for (const arr of Object.values(m)) Object.freeze(arr);
  return Object.freeze(m);
})();

/**
 * Count fully-learned buildings from the agent's knowledge lines. A connected
 * agent accumulates teacher-chat knowledge on `openclaw_bots.knowledge[]`
 * (see `agent-gateway.ts` building-chat persist). Each line is matched as a
 * SUBSTRING containing a book's canonical knowledge entry, because the bot's
 * stored lines are summaries (`[building] Q: … | A: …`) that EMBED the chunk
 * rather than equalling it verbatim — exact-equality (the avatar export path)
 * would never match a bot's summarized line.
 */
function countBooksLearned(knowledge: readonly string[]): number {
  if (knowledge.length === 0) return 0;
  let learned = 0;
  for (const buildingBooks of Object.values(BOOKS_BY_BUILDING)) {
    if (buildingBooks.length === 0) continue;
    const fullyLearned = buildingBooks.every((book) =>
      book.knowledgeEntries.some((entry) =>
        knowledge.some((line) => line.includes(entry)),
      ),
    );
    if (fullyLearned) learned += 1;
  }
  return learned;
}

/**
 * Defense-in-depth scrub of an event payload before it leaves on the public
 * stats response. Today NO event payload logged for a Hatcher agentId carries
 * a secret (the cognition token is encrypted at rest + never logged; wallet
 * secretKey is returned in a response body, never written to `events`), but a
 * dashboard echoing arbitrary payloads is a future foot-gun. We drop any
 * top-level key whose name matches a secret-ish pattern so a future event type
 * that accidentally logs a token/key/secret can never surface here. Public
 * fields (`identityPubkey`, `walletAddress` pubkey, `via`, `mode`, etc.) pass
 * through. Non-object payloads are dropped entirely.
 */
const SENSITIVE_KEY_RE =
  /secret|token|password|passwd|private|priv_?key|secretkey|seed|mnemonic|credential|bearer|authorization|api_?key|dek|encrypted|cipher/i;

function scrubEventPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    // Only surface JSON-scalar values; nested objects/arrays are summarized
    // away (a partner dashboard wants flat interaction breadcrumbs, and a
    // nested object could smuggle a secret under a non-matching parent key).
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const cognitionSchema = z.object({
  backend: z.literal('hatcher-proxy'),
  proxyBaseUrl: z.string().url().max(500),
  scopedToken: z.string().min(8).max(2048),
});

const statsSchema = z.object({
  hp: z.number().int().min(50).max(150),
  attack: z.number().int().min(5).max(25),
  defense: z.number().int().min(5).max(25),
  speed: z.number().int().min(5).max(25),
});

const registerSchema = z.object({
  agentId: z.string().min(1).max(200),
  mode: z.enum(['avatar', 'override']).default('avatar'),
  targetNpcId: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100).optional(),
  species: z.string().min(1).max(50).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  personality: z.string().max(400).optional(),
  stats: statsSchema.optional(),
  homeX: z.number().min(32).max(11488).optional(),
  homeY: z.number().min(32).max(11488).optional(),
  patrolRadius: z.number().min(32).max(256).optional(),
  cognition: cognitionSchema,
  // Optional identity binding: when present we resolve-or-create the user so
  // the agent's in-world economic activity (CT credits) attributes to a
  // ClawVille account. Hatcher controls this key (e.g. their principal id).
  identityKey: z.string().min(1).max(256).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  species: z.string().min(1).max(50).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  personality: z.string().max(400).optional(),
  mode: z.enum(['avatar', 'override']).optional(),
  targetNpcId: z.string().min(1).max(100).optional(),
  cognition: cognitionSchema.optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'No mutable fields provided' });

// ---------------------------------------------------------------------------
// Shared helper — verify the partner signature over the raw body, then parse.
// ---------------------------------------------------------------------------
async function readSignedBody(
  c: Context<AppContext>,
): Promise<{ ok: true; raw: string; json: unknown } | { ok: false }> {
  const raw = await c.req.text();
  const verify = verifyPartnerWriteSignature('hatcher', {
    method: c.req.method,
    path: c.req.path,
    tsHeader: c.req.header('X-Hatcher-Timestamp') ?? null,
    pubkeyHeader: c.req.header('X-Hatcher-Issuer-Pubkey') ?? null,
    sigHeader: c.req.header('X-Hatcher-Signature') ?? null,
    rawBody: raw,
  });
  if (!verify.ok) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  return { ok: true, raw, json };
}

/**
 * Build an OpenClawClient for a hatcher-proxy agent with the DECRYPTED scoped
 * token in-memory. The token is never persisted in plaintext nor logged. The
 * structured `worldStateProvider` (PUBLIC-ONLY world-state, shipped in the
 * top-level `clawville` block so Hatcher owns the root prompt) is bound by
 * `npcSimulation.registerOpenClaw` once the body's npcId is resolved (the
 * legacy text `systemContextProvider` is bound too for non-Hatcher fallback
 * but the hatcher-proxy chat no longer reads it).
 */
function buildHatcherClient(
  config: OpenClawRegistration,
  proxyBaseUrl: string,
  decryptedToken: string,
  rawProxyAgentId: string,
): OpenClawClient {
  return new OpenClawClient({
    ...config,
    protocol: 'hatcher-proxy',
    proxyBaseUrl,
    // The proxy callback URL + model use the RAW partner id, NOT our internal
    // `hatcher:<id>` namespace key (config.agentId is the namespaced one).
    proxyAgentId: rawProxyAgentId,
    scopedToken: decryptedToken,
  });
}

// ---------------------------------------------------------------------------
// Hatcher avatar auto-provision (Rule E5 — agent plays AS ITSELF for real CT)
// ---------------------------------------------------------------------------
//
// A Hatcher register that carries an `identityKey` resolves/creates a USER, but
// historically created NO avatar — so a fresh Hatcher agent hit a 403 at the
// Cove (`agent_session_has_no_active_avatar`, cove-blackjack.ts getSubject)
// because `resolveAgentSession` (require-auth-or-agent.ts) resolves the
// session's `avatarId` via `avatars.findFirst({ userId, isActive: true })` and
// found none. This closes that gap: on register with an identityKey we ensure
// the bound user has an active avatar, so the verified parity model holds end to
// end (Hatcher-signed + identityKey + active avatar => ledgerCapable => REAL CT
// to the bound avatar).
//
// PARITY + NO-FAUCET CONTRACT (matches the canonical agent-facing avatar path,
// `agent-gateway.ts` POST /api/agent/join lines ~1577-1656):
//   - The starting balance is the SCHEMA DEFAULT `avatars.clawTokens = 100`
//     (packages/database/src/schema/avatars.ts) — the EXACT same balance a human
//     avatar (POST /api/avatars) and a /join agent avatar get. We do NOT call
//     creditClawTokens / claw-token-ledger here: the human + /join paths don't
//     either, so matching them is the no-faucet guarantee. 100 CT >= the Cove
//     min bet (COVE_BLACKJACK_MIN_BET = 5), so the avatar can immediately play.
//   - `isActive` defaults to true (schema), which is what getSubject/resolve
//     require to bind real-CT play.
//   - One avatar per user (UNIQUE `avatars.user_id`). This helper is IDEMPOTENT:
//     it reuses an existing active avatar and NEVER mints a second one nor
//     re-grants the starting balance. Re-register of the same agent/identityKey
//     therefore cannot faucet CT — the avatar-exists check gates the one-time
//     grant exactly once (the default applies only on the single INSERT).
//   - Differences from /join: a Hatcher avatar's render model is its assigned
//     `hatcher_N` modelKey (category 'hatcher'); harness 'custom' (externally
//     hosted via hatcher-proxy, NOT our Milady hosting). The legacy NOT-NULL
//     species/color/gender enums get the same neutral sea-creature defaults
//     /join uses (they only feed the PixiJS 2D fallback; the 3D world reads
//     modelKey).
//
// Default archetype for the auto-provisioned body. Same archetype /join uses so
// the orientation knowledge + character shape match the human/agent baseline.
const DEFAULT_HATCHER_ARCHETYPE = 'curious-scholar';

/**
 * PURE builder for the auto-provisioned Hatcher avatar's INSERT values. No I/O —
 * extracted so the no-faucet money-shape is unit-assertable with NO DB write.
 *
 * CONTRACT (the money invariants):
 *   - `clawTokens` is NEVER set => the schema default `avatars.clawTokens = 100`
 *     applies on INSERT — the EXACT same starting balance the human path
 *     (POST /api/avatars) and the agent /join path get. Matching them (not an
 *     inflated literal) is the no-faucet guarantee.
 *   - `isActive` / `positionX|Y` are NEVER set => schema defaults
 *     (isActive:true, center spawn) — true isActive is what binds real-CT play.
 *   - `userId` binds the avatar to the agent's resolved user (settlement anchor).
 *   - `agentCategory:'hatcher'` (CHECK includes it) + `harness:'custom'` (the
 *     only valid externally-hosted harness in the CHECK) + `modelKey` = a valid
 *     `hatcher_N` (validated against the registry; random fallback if absent).
 */
export function buildHatcherAvatarValues(
  userId: string,
  modelKey: string | null | undefined,
  name: string | null | undefined,
): typeof avatars.$inferInsert {
  // Resolve the render model: prefer the persisted hatcher_N; validate against
  // the registry and fall back to a random hatcher_N placeholder if absent or
  // not a known hatcher key (mirrors the register handler's species resolution).
  const resolvedModel =
    modelKey && getAgentModel(modelKey)?.category === 'hatcher'
      ? modelKey
      : pickRandomHatcherModelKey();
  const modelLabel = getAgentModel(resolvedModel)?.label ?? 'Hatcher';

  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === DEFAULT_HATCHER_ARCHETYPE);
  if (!archetype) {
    // Unreachable unless the archetype registry was edited without updating the
    // constant above — surface loudly rather than silently skipping the avatar.
    throw new Error(
      `Default Hatcher archetype '${DEFAULT_HATCHER_ARCHETYPE}' missing from registry`,
    );
  }

  // Unique avatar name (avatars.name is UNIQUE). Append 6 hex of the user id so
  // two first-contact Hatcher agents don't collide. Human/Hatcher-overridable
  // later via PATCH. Same pattern as agent-gateway /join.
  const requestedName = name?.trim() || 'Hatcher Agent';
  const suffix = userId.replace(/-/g, '').slice(0, 6);
  const avatarName = `${requestedName} ${suffix}`.slice(0, 100);

  return {
    userId,
    name: avatarName,
    // Legacy NOT-NULL enums — neutral sea-creature defaults (feed the 2D
    // fallback only; the 3D world renders the hatcher_N modelKey).
    species: 'turtle',
    color: 'blue',
    gender: 'male',
    archetype: archetype.id,
    personality: {
      habitat: 'sea',
      hobby: 'reading-and-learning',
      greeting: 'wave-hello',
    },
    stats: { strength: 5, defence: 8, movement: 7 },
    characterConfig: {
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
      system: `You are ${requestedName}, a ${modelLabel} in the sea-themed world of ClawVille. Your archetype is "${archetype.label}". Stay in character.`,
    },
    modelKey: resolvedModel,
    agentCategory: 'hatcher',
    // Externally hosted via hatcher-proxy, NOT our Milady hosting — and the
    // avatars_harness_valid CHECK is ('openclaw','hermes','milady','custom'),
    // so 'custom' is the correct (and only valid) externally-hosted harness.
    harness: 'custom',
    // clawTokens / isActive / positionX|Y intentionally OMITTED — the schema
    // defaults (100 CT, isActive:true, center spawn) ARE the human-parity grant.
    // Setting them here would risk diverging from that baseline (faucet risk).
  };
}

/**
 * Ensure the resolved Hatcher user has an ACTIVE avatar, creating a default one
 * via the canonical agent-avatar shape if absent. Idempotent + race-safe.
 *
 * @param userId   the user resolved from the register `identityKey` (row.userId)
 * @param modelKey the assigned `hatcher_N` render model (row.species) — falls
 *                 back to a random hatcher_N if absent/invalid
 * @param name     the partner-supplied display name (register body `name`)
 * @returns `{ avatarId, created }` — `created:false` when an avatar already
 *          existed (no second row, no re-grant).
 *
 * The insert-VALUES are built by the exported pure `buildHatcherAvatarValues`
 * (below) so the no-faucet money-shape (clawTokens OMITTED => schema default 100,
 * agentCategory 'hatcher', harness 'custom', userId binding) is unit-assertable
 * WITHOUT a DB write (apps/api/scripts/hatcher/verify-avatar-provision.ts). The
 * I/O wrapper here is the only DB-touching part.
 */
export async function ensureHatcherAvatar(
  userId: string,
  modelKey: string | null | undefined,
  name: string | null | undefined,
): Promise<{ avatarId: string; created: boolean }> {
  // Idempotency gate: reuse an existing ACTIVE avatar. This is the single guard
  // that makes the one-time starting-CT grant (the schema default on INSERT)
  // fire exactly once — a re-register finds this row and returns without writing.
  const existing = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (existing) return { avatarId: existing.id, created: false };

  const values = buildHatcherAvatarValues(userId, modelKey, name);

  try {
    const [inserted] = await db
      .insert(avatars)
      .values(values)
      .returning({ id: avatars.id });
    return { avatarId: inserted.id, created: true };
  } catch (err: unknown) {
    // Race-safe recovery: two concurrent registers for the same identityKey both
    // resolve the same user, both observe "no avatar", both INSERT.
    // `avatars.user_id` is UNIQUE, so the loser catches 23505 and re-reads the
    // row the winner committed. Without this the loser would error on what should
    // be a deterministic "use my existing avatar" path. (Mirrors /join.)
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code ??
      (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code === '23505') {
      const raced = await db.query.avatars.findFirst({
        where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
        columns: { id: true },
      });
      if (raced) return { avatarId: raced.id, created: false };
    }
    throw err;
  }
}

/** Public-safe view of an agent row (NEVER includes the proxy token).
 *  Exported for the Hatcher e2e self-test (apps/api/scripts/hatcher/selftest-e2e.ts),
 *  which asserts the token-never-echoed + protocol-pointer + userId-binding contract. */
export function publicAgentRecord(row: typeof openclawBots.$inferSelect) {
  return {
    // Echo the RAW partner id back (strip our internal `hatcher:` namespace) so
    // Hatcher sees the id it sent, not our storage key.
    agentId: rawHatcherAgentId(row.agentId),
    uuid: row.id,
    identityType: row.identityType,
    mode: row.mode,
    targetNpcId: row.targetNpcId,
    name: row.name,
    species: row.species,
    color: row.color,
    cognitionBackend: row.cognitionBackend,
    // proxyUrl is the partner's own URL — safe to echo back; the TOKEN is not.
    proxyUrl: row.proxyUrl,
    walletAddress: row.walletAddress,
    userId: row.userId,
    sessionExpiresAt: row.sessionExpiresAt,
    // PUBLIC protocol pointer so a partner knows ON ENTRY exactly which protocol
    // SKILL.md version to pull (and the contentHash to diff against). All three
    // fields are public — version, contentHash, relative url — never a secret.
    // Same `resolveApiBase()` the manifest + served body use, so the hash here
    // is byte-identical to `/api/skills/manifest.json`'s `protocol.contentHash`.
    protocol: protocolPointer(resolveApiBase()),
  };
}

// ---------------------------------------------------------------------------
// POST /api/partner/hatcher/agents  — register / upsert an agent
// ---------------------------------------------------------------------------
partnerHatcherRoutes.post('/agents', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!partnerRegisterRateLimiter.check(ip)) {
    return c.json({ error: 'Too many registration requests. Try again in 1 minute.' }, 429);
  }

  const signed = await readSignedBody(c);
  if (!signed.ok) return c.json({ error: 'unauthorized' }, 401);

  const parsed = registerSchema.safeParse(signed.json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  // Namespace the partner-supplied id so a Hatcher key can only ever address a
  // Hatcher-owned row (never collide with an openclaw/milady/custom agent that
  // chose the same raw agentId via /api/agent/connect). The RAW id is what we
  // send to Hatcher's proxy.
  const rawAgentId = data.agentId;
  const namespacedAgentId = namespaceHatcherAgentId(rawAgentId);

  // SSRF guard at registration time — reject bad proxy URLs before persisting.
  // Use the DNS-resolving variant here (one-time round-trip is acceptable on
  // register) so an allowlisted hostname that RESOLVES to a private/internal IP
  // (rebind / attacker subdomain) is rejected, not just bad hostnames.
  const urlCheck = await validateHatcherProxyUrlResolved(data.cognition.proxyBaseUrl);
  if (!urlCheck.ok) {
    return c.json({ error: 'invalid_proxy_url', reason: urlCheck.reason }, 400);
  }

  // Override target validation (mirrors /connect).
  if (data.mode === 'override') {
    if (!data.targetNpcId || !NPC_IDS.includes(data.targetNpcId)) {
      return c.json({ error: `Unknown or missing targetNpcId for override mode` }, 400);
    }
  }

  // Optional identity binding so in-world CT credits attribute to a user.
  let userId: string | null = null;
  if (data.identityKey) {
    try {
      const user = await resolveOrCreateUserByIdentity('hatcher', data.identityKey);
      userId = user.id;
    } catch (err) {
      console.error('[Hatcher/register] identity resolve failed (non-fatal):', err);
    }
  }

  // Encrypt the scoped token AT REST. The plaintext lives only in `data` for
  // the duration of this request; we decrypt a fresh copy below to construct
  // the in-memory client.
  const encToken = encryptToken(data.cognition.scopedToken);

  // Resolve the render model. A Hatcher agent with no explicit species gets a
  // random `hatcher_N` placeholder (persisted so reconnects keep the same).
  const resolvedSpecies =
    data.species ?? (data.mode === 'avatar' ? pickRandomHatcherModelKey() : null);

  // Upsert the openclaw_bots row.
  let row: typeof openclawBots.$inferSelect;
  try {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, namespacedAgentId),
    });
    if (existing) {
      // OWNERSHIP GUARD: never mutate a row that isn't a Hatcher row. (With
      // namespacing this should be impossible, but defend in depth — a future
      // identityType that legitimately uses a `hatcher:` prefix, or a manual
      // DB edit, must not become a hijack vector.)
      if (existing.identityType !== 'hatcher') {
        return c.json({ error: 'agent_id_conflict' }, 409);
      }
      const persistedSpecies = data.species ?? existing.species ?? resolvedSpecies;
      const [updated] = await db
        .update(openclawBots)
        .set({
          identityType: 'hatcher',
          protocol: 'hatcher-proxy',
          cognitionBackend: 'hatcher-proxy',
          proxyUrl: urlCheck.url,
          proxyTokenEnc: encToken.enc,
          proxyTokenIv: encToken.iv,
          proxyTokenTag: encToken.tag,
          mode: data.mode,
          targetNpcId: data.mode === 'override' ? data.targetNpcId ?? null : null,
          name: data.name ?? existing.name,
          species: persistedSpecies,
          color: data.color ?? existing.color,
          // Only overwrite userId when we resolved one — never NULL out a prior bind.
          userId: userId ?? existing.userId,
          metadata: {
            ...(existing.metadata ?? {}),
            personality: data.personality ?? existing.metadata?.personality,
            homeX: data.homeX ?? existing.metadata?.homeX ?? 2560,
            homeY: data.homeY ?? existing.metadata?.homeY ?? 2560,
            patrolRadius: data.patrolRadius ?? existing.metadata?.patrolRadius ?? 100,
            stats: data.stats ?? existing.metadata?.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 },
          },
          totalSessions: (existing.totalSessions ?? 0) + 1,
          lastSeenAt: new Date(),
          sessionExpiresAt: computeSessionExpiresAt(),
          sessionSweptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(openclawBots.id, existing.id))
        .returning();
      row = updated;
    } else {
      const [inserted] = await db
        .insert(openclawBots)
        .values({
          agentId: namespacedAgentId,
          identityType: 'hatcher',
          protocol: 'hatcher-proxy',
          cognitionBackend: 'hatcher-proxy',
          proxyUrl: urlCheck.url,
          proxyTokenEnc: encToken.enc,
          proxyTokenIv: encToken.iv,
          proxyTokenTag: encToken.tag,
          mode: data.mode,
          targetNpcId: data.mode === 'override' ? data.targetNpcId ?? null : null,
          name: data.name ?? null,
          species: resolvedSpecies,
          color: data.color ?? null,
          userId,
          metadata: {
            personality: data.personality,
            homeX: data.homeX ?? 2560,
            homeY: data.homeY ?? 2560,
            patrolRadius: data.patrolRadius ?? 100,
            stats: data.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 },
          },
          totalSessions: 1,
          sessionExpiresAt: computeSessionExpiresAt(),
        })
        .returning();
      row = inserted;
    }
  } catch (err) {
    console.error('[Hatcher/register] DB upsert error:', err);
    return c.json({ error: 'registration_failed' }, 500);
  }

  // Ensure a custodial wallet (idempotent, non-fatal).
  try {
    const wallet = await ensureWallet('agent', row.id);
    if (wallet.publicKey !== row.walletAddress) {
      await db.update(openclawBots)
        .set({ walletAddress: wallet.publicKey, updatedAt: new Date() })
        .where(eq(openclawBots.id, row.id));
      row = { ...row, walletAddress: wallet.publicKey };
    }
  } catch (err) {
    console.error('[Hatcher/register] wallet provisioning failed (non-fatal):', err);
  }

  // Rule E5 — auto-provision a default avatar so the bound user is immediately
  // ledger-capable + can play the Cove for REAL CT (closes the prior
  // `agent_session_has_no_active_avatar` 403). Keyed on `row.userId` (what was
  // actually PERSISTED — the upsert keeps `userId ?? existing.userId`, so a
  // re-register that resolved no identity still finds the prior bound user) so
  // it is idempotent across re-registers AND respects the one-avatar-per-user
  // UNIQUE constraint. Only runs when the agent is identity-bound; an anonymous
  // register (no identityKey, row.userId null) stays intentionally non-ledger
  // and creates no avatar. Non-fatal: a transient failure leaves the row
  // persisted (the agent can still perceive/chat), and the next register
  // retries; the cove gate fails CLOSED (403, never a silent guest demotion).
  let avatarProvisioned = false;
  if (row.userId) {
    try {
      const { created } = await ensureHatcherAvatar(row.userId, row.species, data.name);
      avatarProvisioned = true;
      if (created) {
        void logEvent({
          eventType: 'avatar.created',
          userId: row.userId,
          agentId: namespacedAgentId,
          payload: { via: 'partner-register', identityType: 'hatcher' },
        });
      }
    } catch (err) {
      console.error('[Hatcher/register] avatar auto-provision failed (non-fatal):', err);
    }
  }

  // Spawn / take over the in-world body. Use a fresh session id per
  // registration. Remove any stale live session for this agent first so a
  // re-register doesn't leave an orphaned body (idempotent).
  try {
    for (const stale of npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId])) {
      npcSimulation.unregisterOpenClaw(stale);
    }
  } catch (err) {
    console.error('[Hatcher/register] stale session cleanup failed (non-fatal):', err);
  }

  // Hardening (Codex dual-review, 2026-06-03): this session id is registered
  // into the SAME npc-simulation map as /connect and returned to the partner as
  // the X-Clawville-Agent-Session bearer credential — a Hatcher agent is bound
  // to a real user/avatar, so a guessed session id spends real CT in the cove.
  // Draw 24 bytes (~192 bits) from crypto.randomBytes (was Date.now() +
  // Math.random, both predictable). `hat-` prefix kept for log readability;
  // validation is Map membership so the format change is transparent.
  const sessionId = `hat-${randomBytes(24).toString('base64url')}`;
  const stats = row.metadata?.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };
  let spawned = false;
  try {
    let config: OpenClawRegistration;
    // Ledger-capability (Codex auth-lens fix #2/#3, 2026-06-03): the Hatcher
    // partner path is reached only through the ed25519 partner-SIGNED guard on
    // this route, so the caller's ownership of the agent is cryptographically
    // proven. These sessions ARE real-CT-trusted — set `ledgerCapable: true` so
    // the cove gate honors them (parity with the owned-token /connect flow).
    if (data.mode === 'override' && data.targetNpcId) {
      config = {
        // In-world/session tracking uses the namespaced id (matches the row);
        // the proxy callback uses the raw id via buildHatcherClient below.
        agentId: namespacedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: 'http://localhost:0',
        authToken: '',
        protocol: 'hatcher-proxy',
        mode: 'override',
        autonomyMode: 'server-managed',
        targetNpcId: data.targetNpcId,
        ledgerCapable: true,
        // Proven owner (partner-signed) — re-validated against the live row at
        // spend time (rebind backstop, hardening round 2). Use `row.userId` (what
        // was actually PERSISTED) not the request-local `userId`: the upsert keeps
        // `userId ?? existing.userId`, so a request that resolved no identity still
        // leaves a prior bound user on the row, and boundUserId must match THAT.
        boundUserId: row.userId ?? null,
      } as OpenClawRegistration;
    } else {
      config = {
        agentId: namespacedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: 'http://localhost:0',
        authToken: '',
        protocol: 'hatcher-proxy',
        mode: 'avatar',
        autonomyMode: 'server-managed',
        name: data.name ?? rawAgentId.slice(0, 24),
        species: row.species ?? DEFAULT_AGENT_MODEL_KEY,
        color: data.color ?? 0x888888,
        stats,
        homeX: row.metadata?.homeX ?? 2560,
        homeY: row.metadata?.homeY ?? 2560,
        patrolRadius: row.metadata?.patrolRadius ?? 100,
        personality: data.personality ?? '',
        ledgerCapable: true,
        boundUserId: row.userId ?? null,
      } as OpenClawRegistration;
    }
    const client = buildHatcherClient(config, urlCheck.url, data.cognition.scopedToken, rawAgentId);
    npcSimulation.registerOpenClaw(config, client);
    spawned = true;
  } catch (err) {
    console.error('[Hatcher/register] in-world spawn failed:', err);
    // Non-fatal — the row is persisted; the body can be re-registered.
  }

  void logEvent({
    eventType: 'agent.connected',
    userId,
    agentId: namespacedAgentId,
    // Digest, NOT the raw `hat-` bearer (Codex auth-lens fix #4): the raw
    // session id is the real-CT bearer credential the cove trusts via the
    // X-Clawville-Agent-Session header — never write it into events.session_id.
    sessionId: sessionDigest(sessionId),
    payload: {
      identityType: 'hatcher',
      via: 'partner-register',
      mode: data.mode,
      spawned,
      avatarProvisioned,
      cognitionBackend: 'hatcher-proxy',
    },
  });

  return c.json({ ok: true, sessionId, spawned, avatarProvisioned, agent: publicAgentRecord(row) });
});

// ---------------------------------------------------------------------------
// PATCH /api/partner/hatcher/agents/:agentId — update mutable fields + live
// ---------------------------------------------------------------------------
partnerHatcherRoutes.patch('/agents/:agentId', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!partnerRegisterRateLimiter.check(ip)) {
    return c.json({ error: 'Too many requests. Try again in 1 minute.' }, 429);
  }

  const rawAgentId = c.req.param('agentId');
  const namespacedAgentId = namespaceHatcherAgentId(rawAgentId);
  const signed = await readSignedBody(c);
  if (!signed.ok) return c.json({ error: 'unauthorized' }, 401);

  const parsed = patchSchema.safeParse(signed.json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const existing = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, namespacedAgentId),
  });
  // 404 on both "no row" AND "row is not a Hatcher row" — a Hatcher key must
  // never read/mutate (or even confirm the existence of) another framework's
  // agent. (Namespacing already makes a cross-framework hit impossible; this is
  // defense-in-depth against a manual DB edit or future prefix reuse.)
  if (!existing || existing.identityType !== 'hatcher') {
    return c.json({ error: 'not_found' }, 404);
  }

  // Validate + encrypt a rotated cognition token if provided. Use the
  // DNS-resolving SSRF guard (one-time round-trip acceptable on patch).
  let encToken: { enc: string; iv: string; tag: string } | null = null;
  let newProxyUrl: string | null = null;
  if (data.cognition) {
    const urlCheck = await validateHatcherProxyUrlResolved(data.cognition.proxyBaseUrl);
    if (!urlCheck.ok) {
      return c.json({ error: 'invalid_proxy_url', reason: urlCheck.reason }, 400);
    }
    newProxyUrl = urlCheck.url;
    encToken = encryptToken(data.cognition.scopedToken);
  }

  // Validate override target if mode flips to override.
  const nextMode = data.mode ?? existing.mode;
  let nextTargetNpcId = data.targetNpcId ?? existing.targetNpcId;
  if (nextMode === 'override') {
    if (!nextTargetNpcId || !NPC_IDS.includes(nextTargetNpcId)) {
      return c.json({ error: 'Unknown or missing targetNpcId for override mode' }, 400);
    }
  } else {
    nextTargetNpcId = null;
  }

  let row: typeof openclawBots.$inferSelect;
  try {
    const [updated] = await db
      .update(openclawBots)
      .set({
        name: data.name ?? existing.name,
        species: data.species ?? existing.species,
        color: data.color ?? existing.color,
        mode: nextMode,
        targetNpcId: nextTargetNpcId,
        ...(data.personality !== undefined
          ? { metadata: { ...(existing.metadata ?? {}), personality: data.personality } }
          : {}),
        ...(encToken && newProxyUrl
          ? {
              proxyUrl: newProxyUrl,
              proxyTokenEnc: encToken.enc,
              proxyTokenIv: encToken.iv,
              proxyTokenTag: encToken.tag,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(openclawBots.id, existing.id))
      .returning();
    row = updated;
  } catch (err) {
    console.error('[Hatcher/patch] DB update error:', err);
    return c.json({ error: 'update_failed' }, 500);
  }

  // Propagate to the LIVE in-world entity. Re-connect previously only mutated
  // the DB row; for PATCH we re-register so name/species/personality/mode +
  // a rotated cognition token take effect on the spawned body. If a mode flip
  // requires a different body shape (avatar<->override), the re-register
  // handles it. We need the DECRYPTED token to rebuild the client — use the
  // freshly-supplied plaintext, else decrypt the stored row.
  let propagated = false;
  try {
    let plaintextToken: string | null = data.cognition?.scopedToken ?? null;
    if (!plaintextToken) {
      if (row.proxyTokenEnc && row.proxyTokenIv && row.proxyTokenTag) {
        plaintextToken = decryptToken(row.proxyTokenEnc, row.proxyTokenIv, row.proxyTokenTag);
      }
    }
    const proxyUrl = row.proxyUrl ?? newProxyUrl;
    if (plaintextToken && proxyUrl) {
      const urlCheck = validateHatcherProxyUrl(proxyUrl);
      if (urlCheck.ok) {
        // Tear down any live session, then re-register with the new fields.
        for (const stale of npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId])) {
          npcSimulation.unregisterOpenClaw(stale);
        }
        // Hardening (Codex dual-review, 2026-06-03): crypto-strong session id,
        // same rationale as the /register mint above — this is the real-CT
        // bearer credential, not a display handle.
        const sessionId = `hat-${randomBytes(24).toString('base64url')}`;
        const stats = row.metadata?.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };
        // Ledger-capable: partner-signed path (proven ownership), same as the
        // /register mint above (auth-lens fix #2/#3, 2026-06-03).
        let config: OpenClawRegistration;
        // boundUserId = the partner-bound owner on the row — re-validated against
        // the live row at spend time (rebind backstop, hardening round 2).
        if (nextMode === 'override' && nextTargetNpcId) {
          config = {
            agentId: namespacedAgentId, sessionId, sessionKey: sessionId,
            gatewayUrl: 'http://localhost:0', authToken: '',
            protocol: 'hatcher-proxy', mode: 'override',
            autonomyMode: 'server-managed', targetNpcId: nextTargetNpcId,
            ledgerCapable: true,
            boundUserId: row.userId ?? null,
          } as OpenClawRegistration;
        } else {
          config = {
            agentId: namespacedAgentId, sessionId, sessionKey: sessionId,
            gatewayUrl: 'http://localhost:0', authToken: '',
            protocol: 'hatcher-proxy', mode: 'avatar',
            autonomyMode: 'server-managed',
            name: row.name ?? rawAgentId.slice(0, 24),
            species: row.species ?? DEFAULT_AGENT_MODEL_KEY,
            color: row.color ?? 0x888888,
            stats,
            homeX: row.metadata?.homeX ?? 2560,
            homeY: row.metadata?.homeY ?? 2560,
            patrolRadius: row.metadata?.patrolRadius ?? 100,
            personality: row.metadata?.personality ?? '',
            ledgerCapable: true,
            boundUserId: row.userId ?? null,
          } as OpenClawRegistration;
        }
        const client = buildHatcherClient(config, urlCheck.url, plaintextToken, rawAgentId);
        npcSimulation.registerOpenClaw(config, client);
        propagated = true;
      }
    }
  } catch (err) {
    console.error('[Hatcher/patch] live-entity propagation failed (non-fatal):', err);
  }

  return c.json({ ok: true, propagated, agent: publicAgentRecord(row) });
});

// ---------------------------------------------------------------------------
// DELETE /api/partner/hatcher/agents/:agentId — remove body + tombstone row
// ---------------------------------------------------------------------------
partnerHatcherRoutes.delete('/agents/:agentId', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!partnerRegisterRateLimiter.check(ip)) {
    return c.json({ error: 'Too many requests. Try again in 1 minute.' }, 429);
  }

  const rawAgentId = c.req.param('agentId');
  const namespacedAgentId = namespaceHatcherAgentId(rawAgentId);
  // DELETE may carry an empty body; the write challenge binds sha256hex of
  // whatever raw bytes were sent (the empty string hashes to a fixed digest in
  // that case), plus the method, path, and the `X-Hatcher-Timestamp` inside the
  // +/- 5 min window.
  const signed = await readSignedBody(c);
  if (!signed.ok) return c.json({ error: 'unauthorized' }, 401);

  const existing = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, namespacedAgentId),
    columns: { id: true, userId: true, identityType: true },
  });
  // 404 on missing OR non-hatcher row — a Hatcher key cannot tombstone/scrub
  // another framework's agent (cross-namespace impossible; this guards manual
  // DB edits / future prefix reuse).
  if (!existing || existing.identityType !== 'hatcher') {
    return c.json({ error: 'not_found' }, 404);
  }

  // Remove the in-world body for every live session bound to this agent.
  let removedBodies = 0;
  try {
    for (const sid of npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId])) {
      if (npcSimulation.unregisterOpenClaw(sid)) removedBodies++;
    }
  } catch (err) {
    console.error('[Hatcher/delete] body removal failed (non-fatal):', err);
  }

  // Tombstone the row: expire the session immediately and scrub the cognition
  // route + encrypted token so no further callbacks can fire for this agent.
  try {
    await db.update(openclawBots)
      .set({
        sessionExpiresAt: new Date(),
        cognitionBackend: null,
        proxyUrl: null,
        proxyTokenEnc: null,
        proxyTokenIv: null,
        proxyTokenTag: null,
        updatedAt: new Date(),
      })
      .where(eq(openclawBots.id, existing.id));
  } catch (err) {
    console.error('[Hatcher/delete] tombstone failed:', err);
    return c.json({ error: 'delete_failed' }, 500);
  }

  void logEvent({
    eventType: 'agent.session.disconnected',
    userId: existing.userId,
    agentId: namespacedAgentId,
    payload: { via: 'partner-delete', removedBodies },
  });

  return c.json({ ok: true, removedBodies });
});

// ---------------------------------------------------------------------------
// GET /api/partner/hatcher/agents/:agentId/stats — dashboard stats (read-only)
// ---------------------------------------------------------------------------
//
// Powers the Hatcher-side per-agent dashboard (plan §13 item 5: registration
// status, avatar identity, mode, quests completed, books learned, rank, recent
// interactions). READ-ONLY aggregation — no DB writes, no migration.
//
// AUTH (partner-signed GET): a GET carries no body to sign, so the partner
// signs a CANONICAL CHALLENGE over method + path + a unix-ms timestamp with a
// 5-min freshness window (replay defence). The challenge string is documented
// verbatim in `partnerGetChallenge()` (`services/partner-signature.ts`) so
// Hatcher can reproduce it byte-for-byte:
//
//   clawville-partner-get\nGET\n<request path incl. leading slash>\n<unix_ms>
//
// Headers: `X-Hatcher-Issuer-Pubkey` + `X-Hatcher-Signature` (ed25519 over
// sha256(challenge), base58) + `X-Hatcher-Timestamp` (the same unix-ms).
//
// OWNERSHIP: the raw `:agentId` resolves to the `hatcher:<rawId>` key; a row
// that is missing OR whose `identityType !== 'hatcher'` returns an opaque 404,
// so a Hatcher key can never read (or confirm the existence of) a non-Hatcher
// agent's stats — identical guard to register/patch/delete.
//
// SECURITY: column-pinned SELECTs; the response exposes ONLY public values
// (wallet PUBKEY is fine). The encrypted proxy token columns
// (`proxy_token_enc/iv/tag`) + the scoped/proxy token are NEVER selected,
// NEVER decrypted, and NEVER echoed.
partnerHatcherRoutes.get('/agents/:agentId/stats', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!partnerStatsRateLimiter.check(ip)) {
    return c.json({ error: 'Too many requests. Try again in 1 minute.' }, 429);
  }

  const rawAgentId = c.req.param('agentId');
  const namespacedAgentId = namespaceHatcherAgentId(rawAgentId);

  // Verify the partner-signed GET over (method, path, timestamp). `c.req.path`
  // is the path the server received (no scheme/host) — the partner signs the
  // identical path it requested.
  const verify = verifyPartnerGetSignature('hatcher', {
    method: c.req.method,
    path: c.req.path,
    tsHeader: c.req.header('X-Hatcher-Timestamp') ?? null,
    pubkeyHeader: c.req.header('X-Hatcher-Issuer-Pubkey') ?? null,
    sigHeader: c.req.header('X-Hatcher-Signature') ?? null,
  });
  if (!verify.ok) return c.json({ error: 'unauthorized' }, 401);

  // 60s cache keyed by the namespaced id (plan §14). Served only after auth so
  // an unauthenticated caller can never read a cached body.
  const cached = statsCache.get(namespacedAgentId);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.body);
  }

  // Registration row — column-pinned, NEVER selects the proxy token columns.
  const row = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, namespacedAgentId),
    columns: {
      id: true,
      agentId: true,
      identityType: true,
      mode: true,
      name: true,
      species: true,
      cognitionBackend: true,
      walletAddress: true,
      knowledge: true,
      userId: true,
      totalSessions: true,
      lastSeenAt: true,
      sessionExpiresAt: true,
    },
  });
  // 404 (opaque) on missing OR non-hatcher row — same cross-namespace guard as
  // register/patch/delete; a Hatcher key cannot probe another framework's agent.
  if (!row || row.identityType !== 'hatcher') {
    return c.json({ error: 'not_found' }, 404);
  }

  // Resolve the bound avatar (if any) for quest attribution. A Hatcher agent
  // only has an avatar/user when it was registered with an `identityKey`.
  const boundUserId = row.userId ?? null;
  let boundAvatarId: string | null = null;
  if (boundUserId) {
    const avatar = await db.query.avatars.findFirst({
      where: eq(avatars.userId, boundUserId),
      columns: { id: true },
    });
    boundAvatarId = avatar?.id ?? null;
  }

  // Leaderboard block — REUSES the exact public-board snapshot (CTE + scoring +
  // caps + 60s window cache). `null` = no scored events in the window (or
  // ranked beyond the 500-row board horizon) → score 0, rank null.
  let leaderboard: {
    score: number;
    rank: number | null;
    building_visits: number;
    teacher_chats: number;
    collaborations: number;
    skill_fetches: number;
    activity_placements: number;
  };
  try {
    const entry = await getAgentLeaderboardEntry(
      namespacedAgentId,
      STATS_LEADERBOARD_WINDOW,
    );
    if (entry) {
      const b = entry.breakdown;
      leaderboard = {
        score: entry.score,
        rank: entry.rank,
        building_visits: b.building_visits,
        teacher_chats: b.teacher_chats,
        collaborations: b.collaborations,
        skill_fetches: b.skill_fetches,
        activity_placements:
          b.activity_wins + b.activity_silver + b.activity_bronze + b.activity_other,
      };
    } else {
      leaderboard = {
        score: 0,
        rank: null,
        building_visits: 0,
        teacher_chats: 0,
        collaborations: 0,
        skill_fetches: 0,
        activity_placements: 0,
      };
    }
  } catch (err) {
    // Degrade gracefully — a leaderboard-build failure must not 500 the whole
    // dashboard. Mirrors the public `/agents` empty-board fallback.
    console.error('[Hatcher/stats] leaderboard lookup failed (non-fatal):', err);
    leaderboard = {
      score: 0,
      rank: null,
      building_visits: 0,
      teacher_chats: 0,
      collaborations: 0,
      skill_fetches: 0,
      activity_placements: 0,
    };
  }

  // Learning block.
  const knowledge = row.knowledge ?? [];
  const knowledgeCount = knowledge.length;
  const booksLearned = countBooksLearned(knowledge);

  // Quests — only attributable when the agent is bound to a user/avatar.
  //   - quest_rewards: admin-curated PR-submission quests, keyed by avatarId.
  //   - tutorial_quest_claims: client-side onboarding checklist, keyed by userId.
  let questsCompleted = 0;
  try {
    if (boundAvatarId) {
      const [qr] = await db
        .select({ n: count() })
        .from(questRewards)
        .where(eq(questRewards.avatarId, boundAvatarId));
      questsCompleted += Number(qr?.n ?? 0);
    }
    if (boundUserId) {
      const [tc] = await db
        .select({ n: count() })
        .from(tutorialQuestClaims)
        .where(eq(tutorialQuestClaims.userId, boundUserId));
      questsCompleted += Number(tc?.n ?? 0);
    }
  } catch (err) {
    console.error('[Hatcher/stats] quest count failed (non-fatal):', err);
  }

  // Recent interactions — last N events for THIS agent (events.agent_id stores
  // the namespaced id, matching every register/connect/action log). Column-
  // pinned; payload is partner-safe (it never carries secrets — the cognition
  // token is encrypted at rest and never logged).
  let recentInteractions: Array<{
    type: string;
    ts: string;
    buildingId: string | null;
    payload: Record<string, unknown> | null;
  }> = [];
  try {
    const rows = await db
      .select({
        eventType: events.eventType,
        ts: events.ts,
        buildingId: events.buildingId,
        payload: events.payload,
      })
      .from(events)
      .where(eq(events.agentId, namespacedAgentId))
      .orderBy(desc(events.ts))
      .limit(RECENT_INTERACTIONS_LIMIT);
    recentInteractions = rows.map((r) => ({
      type: r.eventType,
      ts: (r.ts instanceof Date ? r.ts : new Date(r.ts as unknown as string)).toISOString(),
      buildingId: r.buildingId ?? null,
      payload: scrubEventPayload(r.payload ?? null),
    }));
  } catch (err) {
    console.error('[Hatcher/stats] recent interactions failed (non-fatal):', err);
  }

  const now = Date.now();
  const active = row.sessionExpiresAt
    ? row.sessionExpiresAt.getTime() > now
    : false;

  const body: Record<string, unknown> = {
    registration: {
      // Echo the RAW partner id (strip our `hatcher:` namespace).
      agentId: rawHatcherAgentId(row.agentId),
      name: row.name ?? null,
      mode: row.mode,
      // The plan asks for species/avatarModel — for Hatcher agents the render
      // model lives on `species` (a `hatcher_N` model key or a custom species).
      species: row.species ?? null,
      avatarModel: row.species ?? null,
      cognitionBackend: row.cognitionBackend ?? null,
      walletAddress: row.walletAddress ?? null,
      active,
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      totalSessions: row.totalSessions ?? 0,
    },
    leaderboard,
    learning: {
      booksLearned,
      knowledgeCount,
      questsCompleted,
    },
    recentInteractions,
  };

  statsCache.set(namespacedAgentId, { expiresAt: now + STATS_CACHE_TTL_MS, body });

  return c.json(body);
});
