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
import { randomBytes, createHash } from 'crypto';
import { eq, and, desc, count, gte } from 'drizzle-orm';
import {
  db,
  openclawBots,
  avatars,
  events,
  questRewards,
  tutorialQuestClaims,
  sql,
} from '@clawville/database';
import {
  NPC_IDS,
  DEFAULT_HATCHER_MODEL_KEY,
  KNOWLEDGE_BOOKS,
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
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
} from '../services/agent-session-config';
import { npcSimulation, OverrideTargetUnavailableError } from '../services/npc-simulation';
import { OpenClawClient } from '../services/openclaw-client';
import { ensureWallet } from '../services/wallet-service';
import { resolveOrCreateUserByIdentity } from '../services/identity-service';
import { computeSessionExpiresAt } from '../services/openclaw-session-sweeper';
import { notifyHatcherSessionEnded } from '../services/hatcher-session-webhook';
import { logEvent } from '../services/event-logger';
import { sessionDigest, sha256Hex } from '../services/session-digest';
import { withKeyedMutex } from '../services/keyed-mutex';
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
// Per-partner daily NEW-registration cap (2026-06-12)
// ---------------------------------------------------------------------------
// Caps how many NEW agents (fresh `hatcher:`-namespaced rows) the Hatcher
// partner can register per UTC day. Re-register / PATCH of an EXISTING agentId
// never counts — the cap is checked ONLY on the insert branch, so a partner can
// keep updating their existing fleet without limit. The count is read straight
// from the DB (createdAt of `hatcher` rows since UTC midnight), so it survives
// an API restart with no extra table. Single partner today, so "per-partner" ==
// "all hatcher rows"; when a real `partner_api_keys` table lands (Phase C) this
// becomes a per-key count.
const DEFAULT_PARTNER_DAILY_REGISTRATION_CAP = 50;

/** Resolve the daily registration cap from env (default 50, floor 1). */
function resolvePartnerDailyRegistrationCap(): number {
  const raw = process.env.PARTNER_DAILY_REGISTRATION_CAP;
  if (!raw) return DEFAULT_PARTNER_DAILY_REGISTRATION_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PARTNER_DAILY_REGISTRATION_CAP;
  return n;
}

/** Start-of-day (UTC midnight) for "today" — the daily cap window boundary. */
function utcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Deterministic 63-bit advisory-lock key for the per-(partner, UTC-day)
 * registration cap (#7, 2026-06-12). The daily NEW-registration cap was
 * count-then-insert with NO lock, so N concurrent registers all read below the
 * cap and all inserted, blowing past it. We serialize the count+insert under a
 * Postgres TRANSACTION-scoped advisory lock (`pg_advisory_xact_lock`) keyed on
 * this value, so concurrent registers for the same partner+day queue instead of
 * racing — the (k+1)th sees the k already-committed rows and is rejected.
 *
 * The key is `sha256(partnerId + ':' + utcMidnightEpochMs)` folded to a signed
 * 63-bit BigInt (Postgres advisory-lock keys are `bigint`). A new day or a new
 * partner derives a different key, so different (partner, day) buckets never
 * contend with each other. There is exactly one partner (`hatcher`) today, but
 * keying on partnerId keeps this correct if more are added. No new table, no
 * migration — the existing count-from-DB rule is unchanged, only made atomic.
 */
function dailyRegistrationLockKey(partnerId: string, day: Date): bigint {
  const digest = createHash('sha256')
    .update(`${partnerId}:${day.getTime()}`)
    .digest();
  // Take the low 8 bytes as an unsigned 64-bit, then clear the top bit so it
  // fits a signed bigint (pg advisory-lock keys are signed int8).
  const u64 = digest.readBigUInt64BE(0);
  return u64 & 0x7fff_ffff_ffff_ffffn;
}

/**
 * Deterministic 63-bit advisory-lock key for the per-AGENT register/PATCH
 * critical section (P4-1, 2026-06-12). Two concurrent registers (or PATCHes) for
 * the SAME `hatcher:<id>` row used to race: both cleaned stale sessions, both
 * minted a different bearer, both wrote a different `session_key_hash`, both
 * `registerOpenClaw`d — the later DB write won the hash, so the earlier (still
 * 200-OK) bearer immediately failed `validateLiveAgentSession` (present-and-
 * mismatch), and avatar mode spawned DUPLICATE bodies (the in-memory Map is keyed
 * by sessionId, not agentId). We serialize the WHOLE read/upsert + hash-write
 * under `pg_advisory_xact_lock(agentLockKey)` (cross-process) PLUS an in-process
 * `withKeyedMutex(namespacedAgentId)` (same-process, covers the post-commit
 * in-memory spawn the DB lock can't), so only one register/PATCH for a given
 * agentId is ever in its critical section at a time.
 *
 * The key namespace string is `hatcher-agent:<namespacedAgentId>` so it can NEVER
 * collide with the daily-cap key (`hatcher:<epochMs>` shape) — distinct prefixes,
 * distinct hash inputs. DEADLOCK SAFETY: every path acquires the AGENT lock FIRST
 * (it wraps the entire critical section), and only the insert branch then acquires
 * the cap lock INSIDE that agent-locked transaction. The acquire order is always
 * agent → cap; no path takes cap before agent, so the two locks can never be
 * acquired in opposite orders. Folded to a signed 63-bit BigInt like the cap key.
 */
function agentCriticalSectionLockKey(namespacedAgentId: string): bigint {
  const digest = createHash('sha256')
    .update(`hatcher-agent:${namespacedAgentId}`)
    .digest();
  const u64 = digest.readBigUInt64BE(0);
  return u64 & 0x7fff_ffff_ffff_ffffn;
}

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
  // An EMPTY body is valid for DELETE (the write challenge binds the
  // sha256 of the empty string; see the DELETE handler comment). Only a
  // present-but-malformed body is rejected. POST/PATCH handlers still get
  // schema enforcement via Zod on the parsed value (null fails Zod).
  if (raw === '') return { ok: true, raw, json: null };
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
  // Resolve the render model: prefer the persisted hatcher modelKey; validate
  // against the registry and fall back to the default Phanes avatar
  // (DEFAULT_HATCHER_MODEL_KEY) if absent or not a known hatcher key (mirrors
  // the register handler's species resolution).
  const resolvedModel =
    modelKey && getAgentModel(modelKey)?.category === 'hatcher'
      ? modelKey
      : DEFAULT_HATCHER_MODEL_KEY;
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

  // Resolve the render model. A Hatcher agent with no explicit species gets the
  // default Phanes avatar (persisted so reconnects keep the same). Existing
  // agents that previously persisted a hatcher_N placeholder keep it.
  const resolvedSpecies =
    data.species ?? (data.mode === 'avatar' ? DEFAULT_HATCHER_MODEL_KEY : null);

  // Mint the bearer up front so the row's `session_key_hash` can be written in
  // the SAME transaction as the upsert (atomic — the row + its bearer commitment
  // land together, no separate non-atomic write window). It is the X-Clawville-
  // Agent-Session credential the cove trusts for real CT; draw 24 bytes (~192
  // bits) from crypto.randomBytes (Codex dual-review 2026-06-03). `hat-` prefix
  // is log-readable; validation is Map membership + the row hash.
  const sessionId = `hat-${randomBytes(24).toString('base64url')}`;
  const sessionHash = sha256Hex(sessionId);

  // ── PER-AGENT SERIALIZATION (P4-1, 2026-06-12) ──────────────────────────────
  // Two concurrent registers for the SAME `hatcher:<id>` used to race: both
  // cleaned stale sessions, both minted a bearer, both wrote a hash, both spawned
  // — later DB write won the hash so the earlier 200-OK bearer was dead-on-arrival
  // (validateLiveAgentSession present-and-mismatch) and avatar mode left DUPLICATE
  // bodies (the sim Map is keyed by sessionId, not agentId). We serialize the
  // WHOLE critical section (upsert + hash-write + the post-commit in-memory
  // stale-cleanup + spawn) per agentId with an in-process `withKeyedMutex`
  // (same-process; covers the Map mutation a DB lock can't) wrapping a single
  // `pg_advisory_xact_lock(agentLockKey)` transaction (cross-process; re-reads the
  // row AFTER acquiring). DEADLOCK SAFETY: the agent lock is acquired FIRST and the
  // cap lock only inside it on the insert branch, so the order is always
  // agent → cap and the two can never be taken in opposite orders.
  //
  // COMMIT-FIRST-SPAWN-AFTER — NOT a bug (Codex pass-5 flagged the xact lock
  // releasing at commit BEFORE the post-commit spawn; reverted the held-tx detour
  // after the auditor proved it regresses safety). The xact-scoped advisory lock
  // guards ONLY the DB write; the spawn runs AFTER commit, still inside the
  // in-process `withKeyedMutex`. This is deliberately SAFER than holding the tx
  // open across the spawn: a held-tx (spawn-then-commit) can leave a PHANTOM live
  // `ledgerCapable` body if the commit fails after the Map mutation. Commit-first
  // is fail-closed — a failed commit means NO body spawned (spawn is post-commit),
  // and a failed post-commit spawn leaves a committed-but-body-less row that
  // `restoreAgentSessionFromRow` / a later PATCH re-spawns. The cross-process Map
  // race a held tx would target does NOT exist: ClawVille runs a SINGLE API replica
  // and `npcSimulation`'s Map is PROCESS-LOCAL (in-memory, never shared
  // cross-process — same single-process assumption as activity-room-manager.ts:6
  // and cove-slots.ts:197), so ONLY the DB write needs cross-process serialization
  // and the xact lock already gives it.
  const agentLockKey = agentCriticalSectionLockKey(namespacedAgentId);

  // Discriminated outcome surfaced OUT of the mutex so the response (and its HTTP
  // status) is decided by the outer handler, not from inside the tx callback.
  type RegisterOutcome =
    | { kind: 'ok'; row: typeof openclawBots.$inferSelect; avatarProvisioned: boolean; spawned: boolean }
    | { kind: 'conflict' }
    | { kind: 'cap'; cap: number }
    // P5-2: an OVERRIDE register whose body could not spawn (target NPC taken). The
    // row+hash are already committed (commit-first — the row is honest, just
    // body-less, and a later PATCH/restore heals it); we do NOT roll back. But the
    // RESPONSE must be a non-2xx with NO sessionId so the partner never holds a
    // bearer for a body that never took over the NPC. `targetTaken` → 409
    // override_target_unavailable (occupied, pick another NPC) else 503 spawn_failed.
    | { kind: 'override_spawn_failed'; targetTaken: boolean }
    // The upsert + atomic hash are ONE transaction, so a DB error and a
    // hash-persist failure are the SAME failure — both surface as persist_failed
    // (503, retryable, NO sessionId). There is no separate db_error kind.
    | { kind: 'persist_failed' };

  const outcome = await withKeyedMutex<RegisterOutcome>(namespacedAgentId, async () => {
    // Upsert + bearer-hash in ONE advisory-locked transaction. The lock is
    // transaction-scoped (auto-released at COMMIT/ROLLBACK). We RE-READ the row
    // after acquiring (it may have been inserted/mutated by a register that just
    // released the lock), so the existing/insert branch decision is made on the
    // post-lock state.
    let row: typeof openclawBots.$inferSelect;
    let capValue = 0;
    try {
      const txResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentLockKey})`);

        // Re-read UNDER the lock — the row state is now stable for this section.
        const existing = await tx.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, namespacedAgentId),
        });

        if (existing) {
          // OWNERSHIP GUARD: never mutate a row that isn't a Hatcher row. (With
          // namespacing this should be impossible, but defend in depth — a future
          // identityType that legitimately uses a `hatcher:` prefix, or a manual
          // DB edit, must not become a hijack vector.)
          if (existing.identityType !== 'hatcher') {
            return { status: 'conflict' as const };
          }
          const persistedSpecies = data.species ?? existing.species ?? resolvedSpecies;
          const [updated] = await tx
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
              // ATOMIC bearer-hash (P4-1/P4-2): commit the NEW bearer's hash in the
              // SAME write that upserts the row, so the row hash ALWAYS matches the
              // returned sessionId — no separate non-atomic post-write window where
              // a failure could leave a live body whose id mismatches a stale hash.
              sessionKeyHash: sessionHash,
              sessionExpiresAt: computeSessionExpiresAt(),
              sessionSweptAt: null,
              updatedAt: new Date(),
            })
            .where(eq(openclawBots.id, existing.id))
            .returning();
          return { status: 'row' as const, row: updated };
        }

        // ── insert branch ── per-partner daily NEW-registration cap (#7). Only a
        // fresh row counts. We are ALREADY holding the per-agent lock; acquire the
        // per-(partner, day) cap lock NESTED INSIDE it (consistent agent → cap
        // order, no deadlock) so concurrent NEW registers across DIFFERENT agentIds
        // still serialize the count+insert and can't blow past the cap.
        const cap = resolvePartnerDailyRegistrationCap();
        capValue = cap;
        const capLockKey = dailyRegistrationLockKey('hatcher', utcMidnight());
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${capLockKey})`);

        const [todayCount] = await tx
          .select({ n: count() })
          .from(openclawBots)
          .where(
            and(
              eq(openclawBots.identityType, 'hatcher'),
              gte(openclawBots.createdAt, utcMidnight()),
            ),
          );
        if (Number(todayCount?.n ?? 0) >= cap) {
          return { status: 'cap' as const };
        }

        const [inserted] = await tx
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
            // ATOMIC bearer-hash on INSERT too — the new row commits already
            // bound to this register's bearer.
            sessionKeyHash: sessionHash,
            sessionExpiresAt: computeSessionExpiresAt(),
          })
          .returning();
        return { status: 'row' as const, row: inserted };
      });

      if (txResult.status === 'conflict') return { kind: 'conflict' };
      if (txResult.status === 'cap') return { kind: 'cap', cap: capValue };
      row = txResult.row;
    } catch (err) {
      // The upsert + atomic hash write are one transaction — a throw rolled BOTH
      // back, so there is no committed row whose hash diverges from the bearer.
      // We return a retryable error and NEVER surface a sessionId (P4-2): a bearer
      // whose hash didn't commit is neither live nor restorable, so it must not
      // ride out on a success response.
      console.error('[Hatcher/register] upsert+hash transaction failed:', err);
      return { kind: 'persist_failed' };
    }

    // ── post-commit (still inside the per-agent in-process mutex) ──────────────
    // The row + its bearer hash are committed atomically. Everything below is
    // best-effort side-effect work; the bearer is already valid + restorable.

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

    // Spawn / take over the in-world body. Remove any stale live session for this
    // agent first so a re-register doesn't leave an orphaned body. This runs
    // INSIDE the per-agent mutex, so a concurrent register for the same agentId
    // cannot interleave its cleanup+spawn with ours — no duplicate bodies.
    try {
      for (const stale of npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId])) {
        npcSimulation.unregisterOpenClaw(stale);
      }
    } catch (err) {
      console.error('[Hatcher/register] stale session cleanup failed (non-fatal):', err);
    }

    const stats = row.metadata?.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };
    let spawned = false;
    // P5-2: an OVERRIDE spawn failure must surface a non-2xx (the partner must not
    // get a bearer for a body that never took over the NPC). `overrideTargetTaken`
    // distinguishes the occupied case (409) from a transient (503). Avatar spawn
    // failure stays best-effort (the row+bearer are committed + restorable).
    let overrideSpawnFailed = false;
    let overrideTargetTaken = false;
    try {
      let config: OpenClawRegistration;
      // Ledger-capability (Codex auth-lens fix #2/#3, 2026-06-03): the Hatcher
      // partner path is reached only through the ed25519 partner-SIGNED guard on
      // this route, so the caller's ownership of the agent is cryptographically
      // proven. These sessions ARE real-CT-trusted — set `ledgerCapable: true` so
      // the cove gate honors them (parity with the owned-token /connect flow).
      //
      // Built via the SHARED config-builder (agent-session-config.ts) so the
      // spawn-relevant config is byte-identical to what restore rebuilds from the
      // row (diagnostic-2026-06-12 D1). `identityType: 'hatcher'` makes
      // `resolveAgentSpecies` apply DEFAULT_HATCHER_MODEL_KEY (NOT the Milady
      // default). `protocolOverride: 'hatcher-proxy'` is explicit since the public
      // connect identity enum excludes 'hatcher'.
      if (data.mode === 'override' && data.targetNpcId) {
        config = buildOverrideSessionConfig({
          mode: 'override',
          // In-world/session tracking uses the namespaced id (matches the row);
          // the proxy callback uses the raw id via buildHatcherClient below.
          agentId: namespacedAgentId,
          sessionId,
          identityType: 'hatcher',
          storedProtocol: 'hatcher-proxy',
          autonomyMode: 'server-managed',
          targetNpcId: data.targetNpcId,
          ledgerCapable: true,
          // Proven owner (partner-signed) — re-validated against the live row at
          // spend time (rebind backstop, hardening round 2). Use `row.userId` (what
          // was actually PERSISTED) not the request-local `userId`.
          boundUserId: row.userId ?? null,
          protocolOverride: 'hatcher-proxy',
        });
      } else {
        config = buildAvatarSessionConfig({
          mode: 'avatar',
          agentId: namespacedAgentId,
          sessionId,
          identityType: 'hatcher',
          storedProtocol: 'hatcher-proxy',
          autonomyMode: 'server-managed',
          name: data.name ?? rawAgentId.slice(0, 24),
          species: row.species,
          color: data.color,
          stats,
          homeX: row.metadata?.homeX ?? 2560,
          homeY: row.metadata?.homeY ?? 2560,
          patrolRadius: row.metadata?.patrolRadius ?? 100,
          personality: data.personality ?? '',
          ledgerCapable: true,
          boundUserId: row.userId ?? null,
          protocolOverride: 'hatcher-proxy',
        });
      }
      const client = buildHatcherClient(config, urlCheck.url, data.cognition.scopedToken, rawAgentId);
      // The row hash already commits to this exact bearer (written atomically in
      // the tx above), so the body is always consistent with the row — spawn it.
      npcSimulation.registerOpenClaw(config, client);
      spawned = true;
    } catch (err) {
      console.error('[Hatcher/register] in-world spawn failed:', err);
      // P5-2: AVATAR mode is best-effort — a fresh `oc-<sessionId>` body never
      // collides, so a throw is an unexpected transient; the row + bearer are
      // committed + restore-healable, so we keep ok:true with spawned:false (the
      // avatar body re-registers lazily on the next register/restore — that bearer
      // is honest). OVERRIDE mode is NOT best-effort: the targetNpcId was validated
      // against NPC_IDS before the tx (L663), so the only reachable throw is the
      // "already overridden" case (npc-simulation.ts:573) — the NPC is taken by
      // ANOTHER agent. restore re-attempts registerOpenClaw for an override row and
      // throws → null while the NPC stays held, so a 200+sessionId here would be a
      // PERMANENTLY DEAD bearer (Codex pass-5 auditor). We do NOT roll the committed
      // row back (commit-first keeps it honest — a body-less row a later
      // DELETE-incumbent + re-register/PATCH re-seats; the idempotent re-register,
      // totalSessions++, and wallet/avatar provisioning all want the row kept);
      // instead the OUTER handler returns 409 with NO sessionId.
      if (data.mode === 'override') {
        overrideSpawnFailed = true;
        // Typed sentinel (not message-string matching) so the 409-vs-503 split never
        // silently degrades if the sim's error text is reworded (Codex pass-5 nit #1).
        overrideTargetTaken = err instanceof OverrideTargetUnavailableError;
      }
    }

    if (overrideSpawnFailed) {
      return { kind: 'override_spawn_failed', targetTaken: overrideTargetTaken };
    }
    return { kind: 'ok', row, avatarProvisioned, spawned };
  });

  // Map the serialized outcome to a response (decided OUTSIDE the mutex).
  if (outcome.kind === 'conflict') return c.json({ error: 'agent_id_conflict' }, 409);
  if (outcome.kind === 'cap') {
    return c.json(
      { error: 'daily_registration_cap', code: 'daily_registration_cap', cap: outcome.cap },
      429,
    );
  }
  // P4-2: the upsert+hash transaction rolled back, so no committed row's hash
  // matches the bearer. Return a retryable 503 and NO sessionId — never hand the
  // partner a credential that is neither live nor restorable in a success body.
  if (outcome.kind === 'persist_failed') {
    return c.json({ error: 'session_persist_failed' }, 503);
  }
  // P5-2: OVERRIDE register whose body could not spawn. The row is committed +
  // honest (body-less, restorable) but we return a non-2xx with NO sessionId — an
  // OCCUPIED target is a client-actionable 409 (retry against another/freed NPC);
  // any other transient is a retryable 503. Never ok:true+spawned:false handing the
  // partner a bearer for a body that never took over the NPC.
  if (outcome.kind === 'override_spawn_failed') {
    return outcome.targetTaken
      ? c.json({ error: 'override_target_unavailable', code: 'override_target_unavailable' }, 409)
      : c.json({ error: 'spawn_failed', code: 'spawn_failed' }, 503);
  }

  const { row, avatarProvisioned, spawned } = outcome;

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

  // Validate + encrypt a rotated cognition token if provided. Use the
  // DNS-resolving SSRF guard (one-time round-trip acceptable on patch). Done
  // OUTSIDE the per-agent mutex (no shared agent state) so a slow DNS resolve
  // does not hold the lock.
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

  // ── PER-AGENT SERIALIZATION (P4-1, 2026-06-12) ──────────────────────────────
  // A PATCH races the same way a register does: two concurrent PATCHes for one
  // agentId could both read the row, both update, both mint/preserve a session,
  // both registerOpenClaw (duplicate bodies + a later hash overwriting the one the
  // other just returned). Serialize the WHOLE critical section (re-read + update +
  // mint/preserve + spawn) under the SAME in-process withKeyedMutex (keyed by
  // namespacedAgentId) + pg_advisory_xact_lock(agentLockKey) the register path
  // uses, so a register and a PATCH for one agent also mutually exclude. The
  // existing-row read + override-target validation move INSIDE the lock because
  // nextMode / nextTargetNpcId derive from the row read under the lock.
  const agentLockKey = agentCriticalSectionLockKey(namespacedAgentId);

  type PatchOutcome =
    | {
        kind: 'ok';
        row: typeof openclawBots.$inferSelect;
        propagated: boolean;
        rotatedSessionId: string | null;
        rotatedSessionExpiresAt: Date | null;
      }
    | { kind: 'not_found' }
    | { kind: 'bad_target' }
    // P5-2: an OVERRIDE PATCH whose re-register failed (target NPC taken). The DB
    // update is already committed (commit-first); we do NOT roll it back, but we
    // RESTORED the prior live body (no orphan) and return a non-2xx so the partner
    // knows the override did not take. `targetTaken` → 409 override_target_unavailable
    // (occupied) else 503 propagation_failed.
    | { kind: 'override_spawn_failed'; targetTaken: boolean }
    | { kind: 'update_failed' };

  const outcome = await withKeyedMutex<PatchOutcome>(namespacedAgentId, async () => {
    let row: typeof openclawBots.$inferSelect;
    let nextMode: typeof openclawBots.$inferSelect['mode'];
    let nextTargetNpcId: string | null;
    // P6-2: prior body-defining fields captured in the tx, used to compensate the
    // committed row back to the prior body on an override re-register failure.
    let priorSnapshot: Pick<
      typeof openclawBots.$inferSelect,
      | 'name'
      | 'species'
      | 'color'
      | 'mode'
      | 'targetNpcId'
      | 'metadata'
      | 'proxyUrl'
      | 'proxyTokenEnc'
      | 'proxyTokenIv'
      | 'proxyTokenTag'
    >;
    try {
      const txResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentLockKey})`);

        // Re-read UNDER the lock so the update is computed from the post-lock row.
        // 404 on both "no row" AND "row is not a Hatcher row" — a Hatcher key must
        // never read/mutate (or even confirm the existence of) another framework's
        // agent. (Namespacing already makes a cross-framework hit impossible; this
        // is defense-in-depth against a manual DB edit or future prefix reuse.)
        const existing = await tx.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, namespacedAgentId),
        });
        if (!existing || existing.identityType !== 'hatcher') {
          return { status: 'not_found' as const };
        }

        // Override target validation (mode may flip to override). Derived from the
        // locked row read.
        const computedMode = data.mode ?? existing.mode;
        let computedTarget: string | null = data.targetNpcId ?? existing.targetNpcId;
        if (computedMode === 'override') {
          if (!computedTarget || !NPC_IDS.includes(computedTarget)) {
            return { status: 'bad_target' as const };
          }
        } else {
          computedTarget = null;
        }

        // P6-2 (2026-06-12): snapshot the PRIOR body-defining row fields BEFORE the
        // update commits. On an OVERRIDE re-register failure below we restore the
        // prior LIVE body from in-memory snapshots, but the committed row would still
        // describe the FAILED new override target, so restore-after-restart / idle-
        // despawn would re-attempt the failed target (or a later restore would
        // "succeed" into a PATCH the partner was told 409-failed). We capture every
        // field this .set() can mutate so a compensating write can make the persisted
        // row match the restored prior body. (Bearer-lifecycle fields,
        // sessionKeyHash / sessionExpiresAt, are NOT snapshotted here; they are
        // handled separately and only written on a successful mint.)
        const priorSnapshot = {
          name: existing.name,
          species: existing.species,
          color: existing.color,
          mode: existing.mode,
          targetNpcId: existing.targetNpcId,
          metadata: existing.metadata,
          proxyUrl: existing.proxyUrl,
          proxyTokenEnc: existing.proxyTokenEnc,
          proxyTokenIv: existing.proxyTokenIv,
          proxyTokenTag: existing.proxyTokenTag,
        } satisfies Partial<typeof openclawBots.$inferSelect>;

        const [updated] = await tx
          .update(openclawBots)
          .set({
            name: data.name ?? existing.name,
            species: data.species ?? existing.species,
            color: data.color ?? existing.color,
            mode: computedMode,
            targetNpcId: computedTarget,
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
        return {
          status: 'row' as const,
          row: updated,
          mode: computedMode,
          target: computedTarget,
          priorSnapshot,
        };
      });

      if (txResult.status === 'not_found') return { kind: 'not_found' };
      if (txResult.status === 'bad_target') return { kind: 'bad_target' };
      row = txResult.row;
      nextMode = txResult.mode;
      nextTargetNpcId = txResult.target;
      priorSnapshot = txResult.priorSnapshot;
    } catch (err) {
      console.error('[Hatcher/patch] DB update transaction failed:', err);
      return { kind: 'update_failed' };
    }

    // Propagate to the LIVE in-world entity. We re-register so name/species/
    // personality/mode + a rotated cognition token take effect on the spawned
    // body. We need the DECRYPTED token to rebuild the client — use the freshly-
    // supplied plaintext, else decrypt the stored row. All in-memory Map mutation
    // here is inside the per-agent mutex, so no concurrent PATCH/register can
    // interleave its cleanup+spawn — no duplicate bodies.
    let propagated = false;
    // Session-id PRESERVATION (#4, 2026-06-12). The PATCH re-register used to ALWAYS
    // mint a fresh sessionId + evict the prior in-memory session, silently orphaning
    // the partner who was still holding the connect-era bearer (and the response
    // never returned the new id). We now PREFER to reuse the existing live
    // sessionId, so the partner's bearer keeps working across a PATCH and nothing
    // is orphaned — the less-disruptive option the reviewer asked us to take when
    // available. We only MINT a new id when there is NO live session to reuse
    // (e.g. the Map was wiped by a restart, so the partner's bearer can no longer
    // be honored from memory anyway); in that single case the new id is RETURNED in
    // the response (+ sessionExpiresAt) so the partner can adopt it. `rotated` is
    // true ONLY when a new id was minted — when we preserve, the row's
    // session_key_hash already matches the live bearer and must NOT be rewritten.
    let rotatedSessionId: string | null = null;
    let rotatedSessionExpiresAt: Date | null = null;
    // P5-2: an OVERRIDE re-register failure (target NPC taken) must surface a
    // non-2xx + restore the prior body (no orphan). These flag it out of the try.
    let overrideSpawnFailed = false;
    let overrideTargetTaken = false;
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
          // Capture any live session(s) for this agent BEFORE tearing them down so
          // we can reuse the existing bearer rather than orphan it AND, on an
          // override re-register failure, RESTORE the prior body (P5-2 no-orphan).
          // A single agent has at most one live body in practice; if there were
          // several we reuse the first and evict the rest (they were duplicates).
          const liveSessions = npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId]);
          const preservedSessionId = liveSessions[0] ?? null;
          const restoreSnapshots = liveSessions
            .map((sid) => {
              const cfg = npcSimulation.getOpenClawBotConfig(sid);
              const cl = npcSimulation.getOpenClawClientBySession(sid);
              return cfg && cl ? { config: cfg, client: cl } : null;
            })
            .filter((s): s is { config: OpenClawRegistration; client: OpenClawClient } => s !== null);
          for (const stale of liveSessions) {
            npcSimulation.unregisterOpenClaw(stale);
          }
          // Preserve the live bearer when one exists; otherwise mint a fresh
          // crypto-strong id (Codex dual-review, 2026-06-03: this is the real-CT
          // bearer credential, not a display handle).
          const sessionId = preservedSessionId ?? `hat-${randomBytes(24).toString('base64url')}`;
          const minted = preservedSessionId === null;
          const stats = row.metadata?.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };
          // Ledger-capable: partner-signed path (proven ownership), same as the
          // /register mint above (auth-lens fix #2/#3, 2026-06-03).
          let config: OpenClawRegistration;
          // boundUserId = the partner-bound owner on the row — re-validated against
          // the live row at spend time (rebind backstop, hardening round 2).
          // Built via the SHARED config-builder (agent-session-config.ts) for
          // byte-identical parity with the /register mint + restore (D1).
          if (nextMode === 'override' && nextTargetNpcId) {
            config = buildOverrideSessionConfig({
              mode: 'override',
              agentId: namespacedAgentId,
              sessionId,
              identityType: 'hatcher',
              storedProtocol: 'hatcher-proxy',
              autonomyMode: 'server-managed',
              targetNpcId: nextTargetNpcId,
              ledgerCapable: true,
              boundUserId: row.userId ?? null,
              protocolOverride: 'hatcher-proxy',
            });
          } else {
            config = buildAvatarSessionConfig({
              mode: 'avatar',
              agentId: namespacedAgentId,
              sessionId,
              identityType: 'hatcher',
              storedProtocol: 'hatcher-proxy',
              autonomyMode: 'server-managed',
              name: row.name ?? rawAgentId.slice(0, 24),
              species: row.species,
              color: row.color,
              stats,
              homeX: row.metadata?.homeX ?? 2560,
              homeY: row.metadata?.homeY ?? 2560,
              patrolRadius: row.metadata?.patrolRadius ?? 100,
              personality: row.metadata?.personality ?? '',
              ledgerCapable: true,
              boundUserId: row.userId ?? null,
              protocolOverride: 'hatcher-proxy',
            });
          }
          const client = buildHatcherClient(config, urlCheck.url, plaintextToken, rawAgentId);
          // Restart survival (2026-06-11) + R2-2 atomic-hash follow-up (2026-06-12):
          // when we MINTED a new bearer, persist its restorable hash to the row
          // BEFORE registering the live in-memory session. The earlier order
          // (register, then non-fatal hash write) had a gap: if the write threw, a
          // LIVE session existed whose id no longer matched the row's (stale) hash,
          // and validateLiveAgentSession's present-and-mismatch check (R2-2) then
          // rejected that bearer permanently — bricking the agent until the next
          // PATCH/register. Now the hash is committed first; only on success do we
          // register the body and surface the minted id. On persist failure we skip
          // propagation entirely (no live session, partner reconnects) rather than
          // leave a dead-on-arrival body. When we PRESERVED the live bearer (#4), the
          // row hash already commits to that same id, so no rewrite is needed.
          let hashConsistent = true;
          if (minted) {
            const expiresAt = computeSessionExpiresAt();
            try {
              await db
                .update(openclawBots)
                .set({
                  sessionKeyHash: sha256Hex(sessionId),
                  sessionExpiresAt: expiresAt,
                  sessionSweptAt: null,
                  updatedAt: new Date(),
                })
                .where(eq(openclawBots.id, row.id));
              rotatedSessionId = sessionId;
              rotatedSessionExpiresAt = expiresAt;
            } catch (err) {
              console.error('[Hatcher/patch] session_key_hash persist failed — skipping propagation:', err);
              hashConsistent = false;
            }
          }
          if (hashConsistent) {
            try {
              npcSimulation.registerOpenClaw(config, client);
              propagated = true;
            } catch (spawnErr) {
              // P5-2: re-register failed (override target occupied, or transient).
              // RESTORE the prior body so the agent's old working session is intact
              // (no orphan). For OVERRIDE this is a hard failure → non-2xx (the
              // committed row now says override+target but the body didn't take it;
              // a later PATCH/restore reconciles). AVATAR mode stays best-effort: a
              // fresh `oc-<sessionId>` body never collides, so a throw is an
              // unexpected transient; we keep ok with propagated:false and the avatar
              // re-registers lazily on the next PATCH/restore.
              console.error('[Hatcher/patch] re-register failed:', spawnErr);
              for (const snap of restoreSnapshots) {
                try {
                  npcSimulation.registerOpenClaw(snap.config, snap.client);
                } catch (restoreErr) {
                  console.error('[Hatcher/patch] prior-body restore failed:', restoreErr);
                }
              }
              if (nextMode === 'override') {
                overrideSpawnFailed = true;
                // Typed sentinel (not message-string matching) — see register path.
                overrideTargetTaken = spawnErr instanceof OverrideTargetUnavailableError;
                // P6-2 (2026-06-12): the in-memory prior body was just restored above
                // (restoreSnapshots), but the committed row still describes the FAILED
                // new override target. Compensate: write the PRIOR body-defining fields
                // back so the persisted row matches the restored live body. Without
                // this, a restart/idle-despawn restore re-attempts the failed target
                // (throws then null, NPC stays held), or a later restore "succeeds" into
                // a PATCH the partner was told 409-failed: stats + restore both lie.
                // Fail-closed-ISH: the response is already a 409/503; if THIS write
                // throws we keep that failure and log loudly, never upgrading to a
                // success on a compensation failure.
                //
                // Terminal-transition invariant (team-lead + auditor, 2026-06-12):
                // when this PATCH MINTED a new bearer (no live session existed to
                // preserve, so restoreSnapshots is empty and the failed spawn left NO
                // live body), the minted id's hash was committed to the row at the
                // mint step above but its body never spawned and the id is never
                // surfaced to the partner. That is a terminal state for that bearer,
                // so null its hash here to match DELETE / expiry / sweep (which all
                // null sessionKeyHash on a terminal/failed transition). This is for
                // CONSISTENCY/honesty, not security (the dangling hash is inert — the
                // id never entered the sim Map and nobody holds it). We do NOT null it
                // in the PRESERVED-bearer case (minted === false): there the prior body
                // was restored and is LIVE, the row hash was never rewritten in this
                // PATCH, and it correctly still commits to that live preserved bearer.
                try {
                  await db
                    .update(openclawBots)
                    .set({
                      name: priorSnapshot.name,
                      species: priorSnapshot.species,
                      color: priorSnapshot.color,
                      mode: priorSnapshot.mode,
                      targetNpcId: priorSnapshot.targetNpcId,
                      metadata: priorSnapshot.metadata,
                      proxyUrl: priorSnapshot.proxyUrl,
                      proxyTokenEnc: priorSnapshot.proxyTokenEnc,
                      proxyTokenIv: priorSnapshot.proxyTokenIv,
                      proxyTokenTag: priorSnapshot.proxyTokenTag,
                      // Only the minted-and-never-lived bearer is terminal here; the
                      // preserved-bearer case keeps its still-valid hash.
                      ...(minted ? { sessionKeyHash: null } : {}),
                      updatedAt: new Date(),
                    })
                    .where(eq(openclawBots.id, row.id));
                } catch (compensateErr) {
                  console.error(
                    '[Hatcher/patch] P6-2 row compensation after override spawn failure FAILED; persisted row may describe the failed target until the next successful PATCH/restore:',
                    compensateErr,
                  );
                }
              } else {
                // Avatar: discard the minted id (its body did not spawn) so we never
                // advertise a sessionId whose body is absent. The hash committed (if
                // minted) — the partner restores lazily — but we don't surface it.
                rotatedSessionId = null;
                rotatedSessionExpiresAt = null;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[Hatcher/patch] live-entity propagation failed (non-fatal):', err);
    }

    if (overrideSpawnFailed) {
      return { kind: 'override_spawn_failed', targetTaken: overrideTargetTaken };
    }
    return { kind: 'ok', row, propagated, rotatedSessionId, rotatedSessionExpiresAt };
  });

  if (outcome.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (outcome.kind === 'bad_target') {
    return c.json({ error: 'Unknown or missing targetNpcId for override mode' }, 400);
  }
  if (outcome.kind === 'update_failed') return c.json({ error: 'update_failed' }, 500);
  // P5-2: override re-register failed; prior body restored (no orphan). An OCCUPIED
  // target is a client-actionable 409 (retry against another/freed NPC); anything
  // else is a retryable 503.
  if (outcome.kind === 'override_spawn_failed') {
    return outcome.targetTaken
      ? c.json({ error: 'override_target_unavailable', code: 'override_target_unavailable' }, 409)
      : c.json({ error: 'propagation_failed', code: 'propagation_failed' }, 503);
  }

  // When a NEW bearer was minted (no live session to preserve), return it (+ its
  // expiry) so the partner adopts it instead of being silently orphaned holding
  // the old id. When the live bearer was preserved (or the mint-hash persist
  // failed), these are omitted — never surface a bearer whose hash didn't commit
  // (#4 + P4-2, 2026-06-12). Mirrors the connect/register response shape.
  return c.json({
    ok: true,
    propagated: outcome.propagated,
    ...(outcome.rotatedSessionId
      ? {
          sessionId: outcome.rotatedSessionId,
          sessionExpiresAt: outcome.rotatedSessionExpiresAt,
        }
      : {}),
    agent: publicAgentRecord(outcome.row),
  });
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

  // Serialize the lookup -> body-removal -> tombstone span per agentId under the
  // SAME in-process withKeyedMutex used by register/PATCH (Codex pass-4 follow-up:
  // DELETE was the one mutating handler still outside the lock, so a concurrent
  // register/PATCH could re-create the body/row while we tombstoned it, leaving a
  // live body with a tombstoned row or vice-versa — the same race class P4-1
  // closed for register/PATCH). Sig-verify + rate-limit stay OUTSIDE the lock (no
  // crypto held under the mutex); the fire-and-forget logEvent + partner webhook
  // run AFTER release on the returned outcome.
  type DeleteOutcome =
    | { status: 'not_found' }
    | { status: 'delete_failed' }
    | { status: 'ok'; removedBodies: number; userId: string | null; identityType: string };

  const outcome = await withKeyedMutex<DeleteOutcome>(namespacedAgentId, async () => {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, namespacedAgentId),
      columns: { id: true, userId: true, identityType: true },
    });
    // 404 on missing OR non-hatcher row — a Hatcher key cannot tombstone/scrub
    // another framework's agent (cross-namespace impossible; this guards manual
    // DB edits / future prefix reuse).
    if (!existing || existing.identityType !== 'hatcher') {
      return { status: 'not_found' };
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
    // Set BOTH sessionExpiresAt AND sessionSweptAt to the SAME `now` (matching
    // expireSession in openclaw-session-sweeper.ts) so the 5-min sweep's pickup
    // query (sessionSweptAt IS NULL OR sessionSweptAt < sessionExpiresAt) SKIPS
    // this row. Without sessionSweptAt, the sweeper would re-pick this just-deleted
    // row minutes later and fire a DUPLICATE `ttl_expired` session-webhook (+ a
    // duplicate agent.session.expired event) for an agent the partner already
    // explicitly deleted (we already fire one `disconnected` webhook below). Also
    // hardens restore: restore.ts refuses any row where sweptAt >= expiresAt.
    const tombstonedAt = new Date();
    try {
      await db.update(openclawBots)
        .set({
          sessionExpiresAt: tombstonedAt,
          sessionSweptAt: tombstonedAt,
          // Scrub the restorable session-bearer hash on this TERMINAL lifecycle
          // transition (#8, 2026-06-12). Restore already fails closed on the
          // expired TTL + the sweptAt>=expiresAt guard, so a stale hash is not a
          // live bypass — but a deleted row must not retain a bearer commitment a
          // future change could re-honor. Null it here, the same as the
          // disconnect/TTL-expiry paths in openclaw-session-sweeper.ts.
          sessionKeyHash: null,
          cognitionBackend: null,
          proxyUrl: null,
          proxyTokenEnc: null,
          proxyTokenIv: null,
          proxyTokenTag: null,
          updatedAt: tombstonedAt,
        })
        .where(eq(openclawBots.id, existing.id));
    } catch (err) {
      console.error('[Hatcher/delete] tombstone failed:', err);
      return { status: 'delete_failed' };
    }

    return {
      status: 'ok',
      removedBodies,
      userId: existing.userId,
      identityType: existing.identityType,
    };
  });

  if (outcome.status === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (outcome.status === 'delete_failed') return c.json({ error: 'delete_failed' }, 500);

  void logEvent({
    eventType: 'agent.session.disconnected',
    userId: outcome.userId,
    agentId: namespacedAgentId,
    payload: { via: 'partner-delete', removedBodies: outcome.removedBodies },
  });

  // Notify the partner this session ended (env-gated, fail-open). The DELETE
  // already proved a hatcher row (identityType guard above), so notify
  // unconditionally with the de-namespaced id resolved inside the helper.
  void notifyHatcherSessionEnded({
    identityType: outcome.identityType,
    agentId: namespacedAgentId,
    reason: 'disconnected',
  });

  return c.json({ ok: true, removedBodies: outcome.removedBodies });
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
      // Pull-side expiry visibility (2026-06-12) — the ISO timestamp the
      // session's sliding 24h TTL expires at (null for a never-connected /
      // pre-column row). `active` above is just `sessionExpiresAt > now`.
      sessionExpiresAt: row.sessionExpiresAt ? row.sessionExpiresAt.toISOString() : null,
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
