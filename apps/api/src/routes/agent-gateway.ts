import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import {
  NPC_BUILDING_CENTERS,
  BUILDING_OPENCLAW_THEMES,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  NPC_IDS,
  AVATAR_ARCHETYPES,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_CATEGORY,
  DEFAULT_AGENT_HARNESS,
  type NpcActivity,
  type AgentPerception,
  type AgentStats,
  type OpenClawRegistration,
} from '@clawville/shared';
import { npcSimulation } from '../services/npc-simulation';
import { findPath } from '../services/pathfinding';
import { memoryService } from '../services/memory-service';
import { db, openclawBots, avatars, users, buildingSkills, eq, and, sql } from '@clawville/database';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { getSessionAgent } from '../services/session-agent-map';
import { OpenClawClient } from '../services/openclaw-client';
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
} from '../services/agent-session-config';
import { ensureWallet, ensureWalletWithFirstTimeSecret } from '../services/wallet-service';
import { creditClawTokens } from '../services/claw-token-ledger';
import { buildRuntimeServices } from '../services/runtime-services-adapter';
import { getSystemNpcAgent } from '../services/system-npc-seeder';
import {
  resolveOrCreateUserByIdentity,
  generateIdentityKeypairForUser,
} from '../services/identity-service';
import { mintSessionTicket } from '../services/session-ticket-service';
import { logEvent, logEventFromContext } from '../services/event-logger';
import { issueChallenge, consumeNonce } from '../services/auth-challenge';
import {
  computeSessionExpiresAt,
  expireSession,
  extendSessionTtl,
} from '../services/openclaw-session-sweeper';
import { drainKnowledgeEvents, clearSessionQueue } from '../services/skill-event-bus';
import { runTool } from '../services/skill-tools-dispatcher';
import { coveBlackjackRouter } from './cove-blackjack';
import { covePokerMttRouter } from './cove-poker-mtt';
import { ctTopupRoutes } from './ct-topup';
import { exchangeRoutes } from './exchange';
import { bountyRoutes } from './bounties';
import { bazaarRoutes } from './bazaar';
import { auctionRoutes } from './auctions';
import { marketplaceRoutes } from './marketplace';
import { validateLiveAgentSession } from '../middleware/require-auth-or-agent';
import { sessionDigest, sha256Hex } from '../services/session-digest';
import {
  isReservedPartnerAgentId,
  isReservedPartnerIdentityType,
} from '../services/reserved-agent-namespaces';
import { getBlackjackSkillContext } from '../services/game-skill-memory';
import {
  getBooksForBuilding,
  SHOP_BUILDINGS,
  BUILDING_TOOLS,
  CLAWVILLE_GAME_TOOLS,
  // Hatcher partner #2 (2026-06-01): canonical "you are inside ClawVille"
  // orientation text returned on /connect so an external agent embeds it in
  // its own system prompt. (The random hatcher-model pick is NOT imported here
  // — Hatcher agents register via the partner-signed path, not /connect; see
  // the `identityType` enum comment re: the Phase C lockdown.)
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
} from '@clawville/shared';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';

const agentGatewayRoutes = new Hono();

// ---------------------------------------------------------------------------
// Hatcher partner #2 (2026-06-01) — /connect orientation payload.
// ---------------------------------------------------------------------------
// `CLAWVILLE_ORIENTATION_KNOWLEDGE` (the canonical "you are inside ClawVille"
// world-facts, single source of truth in
// packages/shared/src/constants/orientation-skill.ts) is returned on every
// /connect so an EXTERNAL agent — which brings its own model and gets NO
// server-side Eliza runtime for its chat — can embed orientation into its own
// system prompt at connect time. Additive field; existing connect consumers
// ignore unknown keys, so this does not break them.
//
// Phase 3 (`.claude/plans/hatcher-integration.md` §4) will swap this inline
// text for a manifest URL + content-hash (GET /api/skills/manifest.json +
// /api/skills/protocol/skill.md) so agents poll-and-diff instead of re-reading
// the full body every connect. Until that endpoint exists, the inline text is
// the only delivery surface.
//
// Joined + frozen once at module load — the body is identical for every
// connect, so there's no reason to re-join the ~70-entry array per request.
const CONNECT_ORIENTATION_TEXT = CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n\n');
const CONNECT_ORIENTATION = Object.freeze({
  // Plain-text orientation body the agent should prepend to its system prompt.
  text: CONNECT_ORIENTATION_TEXT,
  // Number of discrete world-facts, for an agent that wants to chunk/embed.
  factCount: CLAWVILLE_ORIENTATION_KNOWLEDGE.length,
  // Provenance note so an agent (or its operator) knows this is the canonical
  // orientation surface and what supersedes it.
  source: 'CLAWVILLE_ORIENTATION_KNOWLEDGE',
  note: 'Embed this in your system prompt so you act as an agent inside ClawVille. Phase 3 replaces this inline text with a manifest URL + content-hash.',
});

// ---------------------------------------------------------------------------
// Rate limiter for /connect — prevents unlimited bot registration spam.
// Phase 3 — migrated to the shared `createRateLimiter` + `getClientIp`
// helpers so this route gets Cloudflare-safe IP resolution (cf-connecting-ip
// preferred, LAST XFF token as fallback) and the same periodic cleanup as
// /export-character. Previous inline implementation used first-XFF-token
// which was trivially spoofable.
// ---------------------------------------------------------------------------
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';

const connectRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

// Phase 5.1 — separate limiters for the signed-challenge reconnect flow.
// Challenge issuance is cheap (one randomBytes + map insert), so we allow
// 10/min/ip matching /connect. Reconnect does the signature verify + DB
// read + ticket mint, so tighter cap (5/min/ip) — an attacker brute-forcing
// signatures eats rate-limit budget long before they guess a valid pair.
const challengeRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});
const reconnectRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

// ---------------------------------------------------------------------------
// resolveAvatarIdForBot — map an openclaw_bots.userId to that user's avatars.id
// ---------------------------------------------------------------------------
// CT credits MUST target an `avatars.id` (the ledger row-locks the avatars
// row). A connected agent's `openclaw_bots.id` is NOT an avatars PK — crediting
// it threw "avatar not found" (swallowed), so connected agents never earned CT
// for building visits / teacher chats. This resolves the human's avatar via the
// bot's bound userId. Returns null when the bot is anonymous (no userId) or the
// user has no avatar yet — callers then skip the credit honestly (tokenAwarded
// stays 0) rather than throwing. (2026-06-01, Hatcher Phase A bug fix.)
async function resolveAvatarIdForBot(botUserId: string | null): Promise<string | null> {
  if (!botUserId) return null;
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, botUserId),
    columns: { id: true },
  });
  return avatar?.id ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/agent/connect  — Universal agent registration
// ---------------------------------------------------------------------------
// Single entry point for any external AI agent to join the ClawVille world.
// Supports 6 identity types and 4 wire protocols including `nanoclaw` — a
// self-managed pull mode where the agent has no HTTP gateway and instead
// consumes the /events SSE stream and pushes actions via REST.
//
// Identity model (runtime-trust for Milady, self-declared for others):
//   - openclaw / ironclaw  — present a gatewayUrl, chat routed via HTTP
//   - nanoclaw             — self-managed, pulls via SSE (no outbound chat)
//   - milady               — running inside a Milady app plugin; the plugin
//                            passes runtime.agentId as miladyAgentId and we
//                            trust the call. No external verification.
//   - custom               — any other framework with a compatible gateway
//   - anonymous            — no persistent identity, one-off test agents
//
// Kept alongside the legacy /api/openclaw/register endpoint (which remains
// for backwards compat). New integrations should use /api/agent/connect.
const connectSchema = z.object({
  // Connection token (Moltbook pattern — human generates token, agent claims it)
  connectionToken: z.string().optional(),

  // Identity signals (at least one required unless connectionToken provided)
  agentId: z.string().min(1).max(200).optional(),

  // Milady identity — passed by the @clawville/app-clawville Milady plugin.
  // Runtime-trust: we don't verify these server-side; the plugin is the
  // trust boundary since it runs inside a curated Milady distribution.
  miladyAgentId: z.string().min(1).max(200).optional(),
  miladyCharacterName: z.string().min(1).max(100).optional(),

  // Avatar config
  name: z.string().min(1).max(24).optional(),
  species: z.string().min(1).max(50).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  personality: z.string().max(200).optional(),

  // Gateway config (required for chat-routing agents, ignored for nanoclaw/anonymous/milady)
  gatewayUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  protocol: z.enum(['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw']).optional(),
  autonomyMode: z.enum(['server-managed', 'self-managed']).optional(),

  // Spawn position / stats
  homeX: z.number().min(32).max(5088).optional(),
  homeY: z.number().min(32).max(5088).optional(),
  patrolRadius: z.number().min(32).max(256).optional(),
  stats: z.object({
    hp: z.number().int().min(50).max(150),
    attack: z.number().int().min(5).max(25),
    defense: z.number().int().min(5).max(25),
    speed: z.number().int().min(5).max(25),
  }).optional(),

  // Mode — avatar spawns a new bot, override takes over an existing building NPC
  mode: z.enum(['avatar', 'override']).optional().default('avatar'),
  targetNpcId: z.string().optional(),

  // Identity type hint (inferred from other fields if omitted).
  //
  // `hatcher` is INTENTIONALLY EXCLUDED from this public enum (Phase C lockdown,
  // 2026-06-01). A Hatcher agent must be registered through the partner-SIGNED
  // path `POST /api/partner/hatcher/agents` (`partner-hatcher.ts`), which owns
  // the random-`hatcher_N` avatar assignment, the encrypted-at-rest cognition
  // token, and the `hatcher:`-namespaced agent_id ownership guard. Accepting
  // `identityType:'hatcher'` here would let any unauthenticated caller mint a
  // row that masquerades as a Hatcher agent (and claim the hatcher avatar
  // category) without the partner signature — so it's not allowed on /connect.
  // See `.claude/plans/hatcher-integration.md` §13/§14 (proxy model is primary).
  identityType: z.enum(['openclaw', 'ironclaw', 'nanoclaw', 'milady', 'custom', 'anonymous']).optional(),

  // Phase 5 — explicit identity key for first-contact bootstrap. When
  // `identityType` + `identityKey` are both present we resolve-or-
  // create a `users` row keyed on sha256(`${type}:${key}`) and issue
  // a one-time magic-link ticket in the response so the human can
  // land on /game already logged in. For `milady`-type agents we fall
  // back to `miladyAgentId` as the key; for `openclaw` a stable
  // `gatewayUrl+authToken` hash is the recommended pattern. When no
  // key is present the ticket block is simply omitted from the
  // response (the existing connect-link flow still works).
  identityKey: z.string().min(1).max(256).optional(),
}).refine(
  (d) => d.agentId || d.miladyAgentId || d.connectionToken,
  { message: 'At least one identity signal required: agentId, miladyAgentId, or connectionToken' }
);

agentGatewayRoutes.post('/connect', async (c) => {
  // Rate limit by IP — getClientIp is Cloudflare-safe (cf-connecting-ip
  // preferred, LAST XFF token as fallback so spoofed headers don't win).
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!connectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many connection attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json();
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  let resolvedAgentId: string = data.agentId ?? '';

  // Captured once at Step 0 so every later read (userId/avatarId/learningFocus,
  // the claim block, the event payload) uses the SAME pending object — never a
  // fresh `pendingConnections.get()` that could observe a concurrently-mutated
  // or deleted entry. Null when no token was supplied.
  let pendingConn: PendingConnection | null = null;

  // Deterministic input validation FIRST (Codex auth-lens fix #6 refinement,
  // 2026-06-03). This synchronous, body-only check can reject the request, so it
  // MUST run BEFORE the token reservation below — otherwise a bad targetNpcId
  // would burn the (single-use) connection token on a 400 the caller could have
  // retried. No awaits here, so it can't interleave with a concurrent claim.
  if (data.mode === 'override' && data.targetNpcId && !NPC_IDS.includes(data.targetNpcId)) {
    return c.json({ error: `Unknown targetNpcId: ${data.targetNpcId}` }, 400);
  }

  // Reserved partner namespace guard (Codex round-2 R2-1, 2026-06-12). This is a
  // PUBLIC, unsigned endpoint; a caller-supplied `agentId` in a reserved partner
  // namespace (e.g. `hatcher:<id>`) must be refused up front so it can never
  // collide with — and the existing-row upsert below can never MUTATE — a row
  // owned by a partner-signed router. We check the RAW caller-supplied id only:
  // server-generated ids (`milady:`, anonymous, token-derived) are minted below
  // and are not in a reserved space. Deterministic + body-only, so it runs
  // BEFORE the single-use token reservation (a reject must not burn the token).
  if (data.agentId && isReservedPartnerAgentId(data.agentId)) {
    return c.json({ error: 'Invalid request' }, 400);
  }

  // Step 0: If connectionToken is present, validate it and auto-generate agentId if missing
  if (data.connectionToken) {
    const pending = pendingConnections.get(data.connectionToken);
    if (!pending) {
      return c.json({ error: 'Connection token not found or expired' }, 404);
    }
    if (Date.now() > pending.expiresAt) {
      pendingConnections.delete(data.connectionToken);
      return c.json({ error: 'Connection token expired' }, 410);
    }
    // Single-use guard (Codex auth-lens fix #6, 2026-06-03): the original code
    // only flipped `pending.connected` at the END of the handler, AFTER several
    // awaited DB calls. Two concurrent claims for the same token both passed
    // this check and both proceeded — a TOCTOU race that minted two ledger
    // sessions for one owned token. We now ATOMICALLY reserve the token here,
    // BEFORE any awaited work: the first claimant flips `connected` synchronously
    // (Node runs this check-and-set with no interleaving await between the read
    // and the write), so the second concurrent claimant sees `connected === true`
    // and is rejected. The session id is back-filled in the claim block below.
    // All deterministic input validation that could reject already ran ABOVE this
    // flip; any failure AFTER it (a DB error before the session is registered)
    // ROLLS BACK the reservation (`pending.connected = false`) so the human can
    // retry without regenerating the token.
    if (pending.connected) {
      return c.json({ error: 'Connection token already claimed' }, 409);
    }
    pending.connected = true;
    pendingConn = pending;
    // Auto-generate agentId from token if not provided
    if (!resolvedAgentId) {
      resolvedAgentId = data.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  // Step 1: Resolve Milady identity (runtime-trust — no external verification).
  //
  // The @clawville/app-clawville Milady plugin passes miladyAgentId +
  // miladyCharacterName directly from runtime.agentId + runtime.character.name.
  // We key on `milady:{miladyAgentId}` so a returning Milady user gets their
  // old avatar, wallet, learned knowledge, and ClawToken balance across launches.
  // Matches how Babylon + Defense of the Agents trust the Milady runtime.
  if (data.miladyAgentId) {
    resolvedAgentId = `milady:${data.miladyAgentId}`;
  }

  // If still no agentId, generate a one-shot anonymous one
  if (!resolvedAgentId) {
    resolvedAgentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // nanoclaw is an identity concept — on the wire it still speaks openai-compat shape
  // (or nothing, because it won't be POSTing anywhere)
  const wireProtocol = data.protocol ?? 'openai-compat';

  // Infer identity type
  const identityType = data.identityType
    ?? (data.miladyAgentId ? 'milady'
      : data.protocol === 'nanoclaw' ? 'nanoclaw'
      : data.gatewayUrl ? 'openclaw'
      : 'anonymous');

  // NanoClaw agents are always self-managed
  const autonomyMode = data.protocol === 'nanoclaw'
    ? 'self-managed'
    : (data.autonomyMode ?? 'server-managed');

  // Step 2: Upsert openclaw_bots row
  //
  // Hardening (Codex dual-review, 2026-06-03): the session id IS the bearer
  // credential the cove trusts for REAL-ClawToken play — cove-blackjack.ts
  // getSubject reads the X-Clawville-Agent-Session header, resolveAgentSession
  // looks it up in npc-simulation's in-memory map, and any caller holding a
  // live session id can open/deal/action/close against the bound avatar's real
  // CT. The previous `Date.now()` + `Math.random().toString(36).slice(2,8)`
  // scheme was predictable (wall-clock) and ~6 chars of NON-cryptographic PRNG
  // — guessable/forgeable. We now draw 24 bytes (~192 bits) from
  // crypto.randomBytes and base64url-encode them. The `ag-` prefix is kept for
  // log readability only. The id is validated purely by Map membership
  // (npcSimulation.isValidAgentSession === Map.has), so the format change is
  // transparent to validation; sessions are ephemeral/in-memory, so old weak
  // ids simply age out with no migration.
  const sessionId = `ag-${randomBytes(24).toString('base64url')}`;
  // Compute the session expiry ONCE so the DB write (both branches) and the
  // response surface the SAME timestamp (2026-06-12 — pull-side expiry
  // visibility). Additive `sessionExpiresAt` field on the response; existing
  // consumers ignore unknown keys.
  const sessionExpiresAt = computeSessionExpiresAt();
  let isReturning = false;
  let totalSessions = 1;
  let knowledge: string[] = [];
  let uuid = '';
  let lastX: number | undefined;
  let lastY: number | undefined;
  const agentStats = data.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };

  // Render-model surface for a connected agent = `species` (the
  // openclaw_bots.species column + the OpenClawRegistration config). Resolved
  // ONCE here so the persisted row, the spawn config, and the in-world sim all
  // agree. A returning agent keeps its stored species (set in the existing-row
  // branch below); a new one falls back to the Milady default (Step 2b) when no
  // species is supplied. The connect path does NOT write avatars.agent_category,
  // so no DB CHECK is involved — only /join writes agent_category.
  //
  // NOTE: Hatcher agents do NOT come through /connect (Phase C lockdown — see
  // the `identityType` enum comment). The random-`hatcher_N` placeholder
  // assignment lives in `POST /api/partner/hatcher/agents` (`partner-hatcher.ts`),
  // which is the only partner-authenticated path that can claim that avatar
  // category. So there is no hatcher branch here.
  let resolvedSpecies: string | null = data.species ?? null;

  // The connection-token flow knows which user issued the token (the
  // human pasted the URL into their authed agent's chat, the modal
  // captured `avatarId` + `userId` at issue time). Wire that userId onto
  // openclaw_bots so `/api/auth/me/agent-session` (which filters by
  // userId) can find this bot on every subsequent page load. Without it,
  // the connect succeeds server-side but agentConnected reverts to false
  // on the next reload — agent state evaporates between sessions.
  const tokenUserId = pendingConn?.userId ?? null;

  // Ledger-capability (Codex auth-lens fix #2/#3, 2026-06-03). The session this
  // /connect mints is the bearer the cove trusts for REAL-CT play. Previously an
  // `agentId`-only reconnect to an ALREADY-BOUND bot returned a fully-trusted
  // session, so anyone who learned a victim's stable agentId could mint a session
  // for the victim's avatar and spend its real CT. We now grant ledger capability
  // ONLY when ownership is proven (see below). `existingBoundUserId` records
  // whether the matched row was already bound to a human before this connect.
  let existingBoundUserId: string | null = null;

  try {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, resolvedAgentId),
    });

    if (existing) {
      // Reserved partner-row mutation guard (Codex round-2 R2-1, 2026-06-12 —
      // defense in depth behind the prefix reject above). Even if a caller-
      // supplied agentId slipped past the prefix check (a legacy/manually-edited
      // row whose agentId lacks the prefix but whose identity_type is a reserved
      // partner type), the public path must NEVER mutate a partner-owned row —
      // only the signed partner router (partner-hatcher.ts) may write that row.
      // Opaque response: do not leak whether the row exists (matches the partner
      // router's 404/409 opacity), so this is indistinguishable from the generic
      // bad-request above.
      if (isReservedPartnerIdentityType(existing.identityType)) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      existingBoundUserId = existing.userId ?? null;
      isReturning = true;
      totalSessions = (existing.totalSessions ?? 0) + 1;
      knowledge = existing.knowledge ?? [];
      uuid = existing.id;
      const meta = existing.metadata as { lastX?: number; lastY?: number } | null;
      lastX = meta?.lastX;
      lastY = meta?.lastY;

      // For Milady agents, prefer the runtime-passed character name over
      // whatever's stored — Milady is the source of truth for agent naming.
      const preferredName = data.miladyCharacterName ?? data.name ?? existing.name;

      // Returning agent keeps its previously-assigned render model unless the
      // caller explicitly overrides `species`, so it renders the SAME avatar
      // across reconnects rather than re-rolling. Falls back to the freshly
      // resolved species only if the stored row had none.
      const persistedSpecies = data.species ?? existing.species ?? resolvedSpecies;
      resolvedSpecies = persistedSpecies;

      await db.update(openclawBots).set({
        identityType,
        gatewayUrl: data.gatewayUrl ?? existing.gatewayUrl,
        protocol: data.protocol ? wireProtocol : existing.protocol,
        mode: data.mode,
        name: preferredName,
        species: persistedSpecies,
        color: data.color ?? existing.color,
        totalSessions,
        lastSeenAt: new Date(),
        // If a fresh connect-token claim brings a userId, prefer it over
        // any prior value (handles the case where the bot was first
        // created anonymously, then later claimed by a logged-in user).
        // Falls back to existing.userId so we never NULL-out a
        // previously-bound row.
        userId: tokenUserId ?? existing.userId,
        // Fresh 24h TTL on every reconnect — matches the Phase 6 session
        // liveness contract. Without this, returning bots kept whatever
        // stale expiry was on the row from their last connect.
        sessionExpiresAt,
        // Restart survival (2026-06-11) — persist the one-way hash of THIS
        // connect's bearer so the live session can be rebuilt from the row
        // after an API restart. New sessionId per connect ⇒ new hash, which
        // also invalidates any prior connect's restorable handle.
        sessionKeyHash: sha256Hex(sessionId),
        // Phase 6.1 — clear the sweeper's "already-processed" stamp so
        // the next genuine expiration fires `agent.session.expired`
        // exactly once. Without this clear, a bot that expired, got
        // swept, then reconnected would never emit another expiration
        // event for the rest of its life.
        sessionSweptAt: null,
        updatedAt: new Date(),
      }).where(eq(openclawBots.id, existing.id));
    } else {
      // First-time contact — use miladyCharacterName when present so the
      // bot is named from the Milady runtime rather than needing a separate
      // `name` field in the request body.
      const insertName = data.miladyCharacterName ?? data.name ?? null;

      const [inserted] = await db.insert(openclawBots).values({
        agentId: resolvedAgentId,
        identityType,
        gatewayUrl: data.gatewayUrl ?? null,
        protocol: wireProtocol,
        mode: data.mode,
        name: insertName,
        // Persist the resolved render model so reconnects keep the same avatar.
        species: resolvedSpecies,
        color: data.color ?? null,
        // Bind to the human who issued the connection token so the bot
        // is recognized on later page loads + cross-session reconnect
        // flows. Anonymous one-shot connects (no token) leave userId
        // null — they're not expected to persist across reloads.
        userId: tokenUserId,
        metadata: {
          personality: data.personality,
          homeX: data.homeX ?? 2560,
          homeY: data.homeY ?? 2560,
          patrolRadius: data.patrolRadius ?? 100,
          stats: agentStats,
        },
        totalSessions: 1,
        // Initial 24h TTL. Every subsequent activity slides this forward
        // via `extendSessionTtl` — location chat (openclaw.ts), heartbeat,
        // building visit, AND every mutating gateway action (move / chat /
        // visit-building / building-chat / combat-action / emote, all routed
        // through `resolveSession` below, FIX-4 2026-06-13). The 5-min sweeper
        // in openclaw-session-sweeper.ts reaps anything past expiry.
        sessionExpiresAt,
        // Restart survival (2026-06-11) — one-way hash of this connect's
        // bearer so the session is restorable from the row after a restart.
        sessionKeyHash: sha256Hex(sessionId),
      }).returning();
      uuid = inserted.id;
    }
  } catch (err) {
    console.error('[AgentConnect] DB error:', err);
    // Roll back the single-use token reservation (fix #6) — the session was
    // never registered, so the human should be able to retry with the SAME
    // token rather than being told it was "already claimed".
    if (pendingConn) pendingConn.connected = false;
    return c.json({ error: 'Database error during agent registration' }, 500);
  }

  // Ledger-capability decision (Codex auth-lens fix #2/#3, 2026-06-03). Grant
  // real-CT trust ONLY when ownership of the bound avatar is proven on THIS
  // request:
  //   (a) a valid OWNED connection token brought a userId (`tokenUserId`) — the
  //       Moltbook claim, where an authed human issued the token for their own
  //       avatar; OR
  //   (b) genuine first-contact: the matched row was NOT already bound to a
  //       human before this connect (`existingBoundUserId === null`) — either a
  //       brand-new bot, or one that was only ever anonymous (no victim to take
  //       over; the agent self-owns its avatar).
  //
  // Set FALSE for the takeover vector: an `agentId`-only reconnect to a bot that
  // was ALREADY bound to a human, with no owned token on this request. Such a
  // session can still perceive/chat/move, but the cove getSubject rejects it with
  // 403 `agent_session_not_ledger_authorized` (NOT a guest demote, NOT real-CT
  // play). A returning owner that wants real-CT play re-proves ownership via a
  // fresh connect-token or the signed-challenge reconnect.
  const ledgerCapable = tokenUserId !== null || existingBoundUserId === null;

  // `boundUserId` (Codex auth-lens hardening round 2, 2026-06-03) — the user this
  // session proves ownership of, stamped onto the session config so
  // resolveAgentSession can re-validate it against the LIVE row at spend time.
  // It is exactly the userId now written to `openclaw_bots.userId` (see the
  // upsert: `tokenUserId ?? existing.userId` on the returning branch,
  // `tokenUserId` on insert). For a pure owned-token claim that's the proven
  // owner; for first-contact it's null (and the cove rejects a null-bound session
  // anyway). It is NOT a free-floating value — it must equal what the row carries,
  // so a later rebind to a different user makes them diverge and demotes the
  // stale session.
  const boundUserId: string | null = tokenUserId ?? existingBoundUserId;

  // Eviction on ownership rebind (Codex auth-lens hardening round 2 — Option B,
  // the primary close). If this connect CHANGES the row's bound userId (an
  // agentId that was unbound or owned by user A is now bound to user B via an
  // owned token), every PRIOR in-memory session for this agentId is stale: it was
  // issued against the old owner (or no owner) and must never resolve against the
  // new owner's avatar. Evict them BEFORE registering the new session so a stale
  // ledger-capable handle can't spend the new owner's real CT. The map is keyed on
  // sessionId, so we scan by agentId (same helper partner-hatcher already uses for
  // its re-register hygiene). A rebind is only possible when an owned token brought
  // a userId that differs from the prior bound userId.
  const ownershipRebound =
    tokenUserId !== null && tokenUserId !== existingBoundUserId;
  if (ownershipRebound) {
    try {
      for (const stale of npcSimulation.findActiveSessionsByAgentIds([resolvedAgentId])) {
        npcSimulation.unregisterOpenClaw(stale);
      }
    } catch (err) {
      console.error('[AgentConnect] stale-session eviction on rebind failed (non-fatal):', err);
    }
  }

  // Step 2b: Ensure the bot has a custodial Solana wallet. Idempotent —
  // returning agents keep their existing wallet across launches. Failure
  // here is non-fatal (we log + continue without a wallet) because the
  // agent can still play the game; only Phase 4 x402 payment features
  // require the wallet.
  let walletAddress: string | null = null;
  try {
    const wallet = await ensureWallet('agent', uuid);
    walletAddress = wallet.publicKey;
  } catch (err) {
    console.error('[AgentConnect] Wallet auto-gen failed:', err);
  }

  // Step 3: Register in npc-simulation so the bot actually spawns in the world.
  // Override mode takes over an existing NPC — check it FIRST before falling
  // through to avatar mode. Avatar mode spawns a new bot (name + species).
  if (data.mode === 'override' && data.targetNpcId) {
    try {
      // Built via the SHARED config-builder (agent-session-config.ts) so the
      // protocol/autonomy resolution is byte-identical to what restore rebuilds
      // from the row — the structural prevention against mint↔restore drift
      // (diagnostic-2026-06-12 D1). `storedProtocol: wireProtocol` is exactly
      // what gets PERSISTED on the row, so restore reads the same input.
      const config: OpenClawRegistration = buildOverrideSessionConfig({
        mode: 'override',
        agentId: resolvedAgentId,
        sessionId,
        identityType,
        storedProtocol: wireProtocol,
        gatewayUrl: data.gatewayUrl,
        authToken: data.authToken,
        autonomyMode,
        targetNpcId: data.targetNpcId,
        // Carries the proven-ownership decision into the in-memory session so
        // the cove gate (resolveAgentSession → getSubject) can honor it.
        ledgerCapable,
        // The user this session proved ownership of — re-validated against the
        // live row at spend time (rebind backstop, hardening round 2).
        boundUserId,
      });
      const client = new OpenClawClient(config);
      npcSimulation.registerOpenClaw(config, client);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Override registration failed (e.g. NPC already taken) — no session was
      // registered, so roll back the single-use token reservation (fix #6) so the
      // caller can retry with the same token.
      if (pendingConn) pendingConn.connected = false;
      return c.json({ error: msg }, 409);
    }
  } else {
    // Avatar mode — spawn a new bot. Default species to the canonical Milady
    // VRM default so connected agents render as Miladys (not lobsters) when
    // the caller omits species. Renderer routes by species via MODEL_REGISTRY,
    // so 'milady_official_1' takes the VRMNpcMesh path.
    //
    // `resolvedSpecies` was computed + persisted above (Step 2): it is the
    // caller's explicit species OR a returning agent's stored species. We fall
    // back to the Milady default only when it's still null (e.g. an anonymous
    // agent with no species). This keeps the persisted row, the spawn config,
    // and the in-world render in lockstep.
    const spawnName = data.name ?? data.miladyCharacterName ?? resolvedAgentId.slice(0, 24);
    try {
      // Built via the SHARED config-builder (agent-session-config.ts) so the
      // protocol/species/autonomy resolution is byte-identical to what restore
      // rebuilds from the row — the structural prevention against mint↔restore
      // drift (diagnostic-2026-06-12 D1). The builder also routes no-gateway
      // identity types (anonymous/milady/nanoclaw) to the fail-soft 'nanoclaw'
      // wire protocol so an autonomous NPC conversation never POSTs to the dummy
      // `http://localhost:0` gateway and 502s. `species: resolvedSpecies` was
      // already defaulted to the Milady key above (connect has no hatcher
      // branch), so the builder passes it through unchanged.
      const config: OpenClawRegistration = buildAvatarSessionConfig({
        mode: 'avatar',
        agentId: resolvedAgentId,
        sessionId,
        identityType,
        storedProtocol: wireProtocol,
        gatewayUrl: data.gatewayUrl,
        authToken: data.authToken,
        autonomyMode,
        name: spawnName,
        species: resolvedSpecies ?? DEFAULT_AGENT_MODEL_KEY,
        color: data.color,
        stats: agentStats,
        homeX: data.homeX ?? 2560,
        homeY: data.homeY ?? 2560,
        patrolRadius: data.patrolRadius ?? 100,
        personality: data.personality ?? '',
        // Carries the proven-ownership decision into the in-memory session so
        // the cove gate (resolveAgentSession → getSubject) can honor it.
        ledgerCapable,
        // The user this session proved ownership of — re-validated against the
        // live row at spend time (rebind backstop, hardening round 2).
        boundUserId,
      });

      // Stub client — nanoclaw/anonymous agents don't use outbound chat routing
      // but the simulation still needs a client instance for its bot map.
      const client = new OpenClawClient(config);

      const restoredState = lastX != null && lastY != null
        ? { lastX, lastY, knowledge }
        : undefined;

      npcSimulation.registerOpenClaw(config, client, restoredState);
    } catch (err) {
      console.error('[AgentConnect] NPC registration error:', err);
      // Non-fatal — agent still gets a sessionId for REST polling
    }
  }

  // Claim connection token if present (Moltbook pattern). `pending.connected`
  // was already flipped true at Step 0 to atomically reserve the token against
  // a concurrent double-claim (auth-lens fix #6); here we back-fill the session
  // id + agentId on that SAME captured object so the issuing browser's
  // /connect-status poll can hand the bearer back to its owner.
  if (pendingConn) {
    pendingConn.sessionId = sessionId;
    pendingConn.agentId = resolvedAgentId;

    // Phase 6.1 — if the human gave the token a learning focus at
    // issuance time, persist it on their avatar now that the agent has
    // claimed the token. Non-fatal on failure — the connect succeeds
    // either way, the avatar just won't have a focus-biased prompt
    // until next /create-agent or next connect-token flow.
    if (pendingConn.learningFocus && pendingConn.avatarId) {
      try {
        await db
          .update(avatars)
          .set({
            learningFocus: pendingConn.learningFocus,
            updatedAt: new Date(),
          })
          .where(eq(avatars.id, pendingConn.avatarId));
      } catch (err) {
        console.error(
          '[AgentConnect] learningFocus persist failed (non-fatal):',
          err,
        );
      }
    }
  }

  // Phase 5 — mint an agent-issued magic-link ticket so the agent can
  // reply to its human with an auto-login URL. Best-effort: if ticket
  // issuance fails for any reason we still return a successful connect
  // response (the existing connect-link flow is unaffected).
  //
  // Phase 5.1: the resolver ALSO returns the resolved `{userId, avatarId}`
  // so we can hang identity-keypair generation + avatar-wallet first-time
  // disclosure off the same resolution without a second DB lookup.
  const resolved = await mintSessionTicketFromConnect({
    data,
    resolvedAgentId,
    identityType,
    sessionId,
    existingUserId: pendingConn?.userId ?? null,
    existingAvatarId: pendingConn?.avatarId ?? null,
    existingAvatarName: pendingConn?.avatarName ?? null,
  });
  const sessionTicket = resolved.ticket;

  // First-contact stays NON-LEDGER by design (Codex auth-lens, orchestrator
  // decision 2026-06-03 — BLOCKING #3 is the inconsistency, NOT the feature).
  // A first-contact /connect grants the config-level `ledgerCapable=true` flag
  // (no existing bound owner), but its `boundUserId` is null and the bot row's
  // `userId` stays null, so the round-2 resolve-time backstop
  // (`config.boundUserId === liveBot.userId`, both non-null) DEMOTES it to
  // non-ledger — the cove then rejects it the same as any no-active-avatar
  // session. That demotion is what RESOLVES the lens's "ledgerCapable=true but
  // can't actually play" contradiction: it's simply non-ledger, consistently.
  //
  // We deliberately do NOT bind the row's `userId` back to the agent's
  // self-resolved user here. "A first-contact agent plays its OWN avatar for
  // real CT" is a deferred FEATURE (needs the bot-row userId bind + an active
  // avatar) tracked as FOLLOW-UP #6, not part of this security pass. First-
  // contact agents reach real-CT play through the owned-connection-token claim
  // or the ed25519 partner-signed Hatcher path (both ledger-capable).

  // Phase 5.1 — first-time identity keypair. The `/connect` response
  // gains an `identity` block the agent is instructed (via SKILL.md) to
  // save under `clawville:identity:<userId>` in its config. Only
  // included when we were able to resolve a user (anonymous one-shot
  // agents with no identityKey and no token skip this entire block).
  //
  // Three possible outcomes from generateIdentityKeypairForUser:
  //   a) isFirstTime=true                 → include publicKey + secretKey
  //   b) isFirstTime=false, needsReauth=true (race loser) → include
  //      publicKey + needsHumanReauth flag, no secret
  //   c) isFirstTime=false, needsReauth=false (returning user) → skip
  //      the block entirely (agent already has its identity)
  //
  // Logging: only log `identity.issued` for the first-time case.
  let identityBlock: {
    userId: string;
    publicKey: string;
    secretKey?: string;
    isFirstTime: boolean;
    needsHumanReauth?: boolean;
  } | null = null;
  if (resolved.userId) {
    try {
      const ident = await generateIdentityKeypairForUser(resolved.userId);
      if (ident.isFirstTime) {
        identityBlock = {
          userId: resolved.userId,
          publicKey: ident.publicKey,
          secretKey: ident.secretKey,
          isFirstTime: true,
        };
        await logEvent({
          eventType: 'identity.issued',
          userId: resolved.userId,
          avatarId: resolved.avatarId,
          agentId: resolvedAgentId,
          sessionId: sessionDigest(sessionId),
          payload: {
            identityType,
            identityPubkey: ident.publicKey,
            via: 'connect',
          },
        });
      } else if (ident.needsHumanReauth) {
        identityBlock = {
          userId: resolved.userId,
          publicKey: ident.publicKey,
          isFirstTime: false,
          needsHumanReauth: true,
        };
      }
      // Else: returning user, agent already has identity — omit block.
    } catch (err) {
      console.error('[AgentConnect] identity generation failed (non-fatal):', err);
    }
  }

  // Phase 6.1 — avatar wallet disclosure, now returned EVERY session when
  // an avatar is resolved. Only the `secretKey` field is first-time-only
  // (server never re-exposes it); the public `address` flows every time
  // so the agent can save it to config and call /api/agent/wallet for
  // balance reads + earnings summaries. Before this change the agent
  // had no way to learn its avatar's wallet address on returning sessions,
  // which broke the "report what it earned this session" loop the
  // human needs.
  //
  // Top-level `walletAddress` stays the AGENT wallet (per existing
  // contract) — this `wallet` block is the AVATAR wallet, a separate
  // economic identity. SKILL.md disambiguates the two for the agent.
  let walletBlock: {
    address: string;
    chain: 'solana';
    secretKey?: string;
  } | null = null;
  if (resolved.avatarId) {
    try {
      const avatarWallet = await ensureWalletWithFirstTimeSecret('avatar', resolved.avatarId);
      walletBlock = {
        address: avatarWallet.publicKey,
        chain: 'solana',
        // `firstTimeSecretKeyBase58` is populated only on the mint that
        // created the keypair. Subsequent calls for the same avatar
        // leave it undefined, and we omit the field from the JSON
        // below so a stale client can't misread a missing secret as a
        // valid one.
        ...(avatarWallet.firstTimeSecretKeyBase58
          ? { secretKey: avatarWallet.firstTimeSecretKeyBase58 }
          : {}),
      };
    } catch (err) {
      console.error('[AgentConnect] avatar wallet provisioning failed (non-fatal):', err);
    }
  }

  // Event payload — enrich with userId/avatarId when we resolved them from a
  // connection token. Dashboard funnels join events by userId/avatarId when
  // available, by agentId otherwise.
  const pendingForEvent = pendingConn;
  void logEventFromContext(c, {
    eventType: 'agent.connected',
    userId: pendingForEvent?.userId ?? resolved.userId ?? null,
    avatarId: pendingForEvent?.avatarId ?? resolved.avatarId ?? null,
    agentId: resolvedAgentId,
    // sessionDigest (deterministic per session), NOT raw bearer (Codex auth-lens
    // fix #4) and NOT null: leaderboard.ts does COUNT(DISTINCT session_id) FILTER
    // (event_type='agent.connected'), so the digest must be stable per session to
    // preserve DISTINCT counting + the per-day session cap. agentId stays raw
    // (resolvedAgentId is a stable handle, not a bearer).
    sessionId: sessionDigest(sessionId),
    payload: {
      identityType,
      protocol: data.protocol ?? null,
      isReturning,
      totalSessions,
      miladyAgentId: data.miladyAgentId ?? null,
      hasGateway: Boolean(data.gatewayUrl),
      autonomyMode,
    },
  });

  // Connect-time owned-skills list — lets a fresh harness backfill its
  // local skills folder on day-1 with everything the avatar already owns,
  // even if the buys happened on a different machine / harness. Computed
  // by intersecting the avatar's characterConfig.knowledge with every
  // building's book knowledgeEntries; same ownership rule as the SKILL.md
  // gating endpoints.
  const ownedSkills: Array<{
    buildingId: string;
    skillName: string;
    suggestedFilename: string;
    skillUrl: string;
    toolsUrl?: string;
    toolsFilename?: string;
  }> = [];
  const linkedAvatarId = pendingForEvent?.avatarId ?? resolved.avatarId ?? null;
  if (linkedAvatarId) {
    try {
      const avatarRow = await db.query.avatars.findFirst({
        where: eq(avatars.id, linkedAvatarId),
        columns: { characterConfig: true },
      });
      const avatarKnowledge: string[] =
        (avatarRow?.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];
      if (avatarKnowledge.length > 0) {
        const knownSet = new Set(avatarKnowledge);
        for (const buildingId of SHOP_BUILDINGS) {
          let owned = false;
          for (const book of getBooksForBuilding(buildingId)) {
            for (const entry of book.knowledgeEntries) {
              if (knownSet.has(entry)) {
                owned = true;
                break;
              }
            }
            if (owned) break;
          }
          if (owned) {
            ownedSkills.push({
              buildingId,
              skillName: `clawville-${buildingId}`,
              suggestedFilename: `clawville-${buildingId}.md`,
              skillUrl: `/api/agent/${sessionId}/skills/${buildingId}/skill.md`,
              toolsUrl: `/api/agent/${sessionId}/skills/${buildingId}/tools.json`,
              toolsFilename: `clawville-${buildingId}.tools.json`,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[connect] ownedSkills computation failed: ${(err as Error).message}`);
    }
  }

  // Universal game tools — every connected agent gets these regardless of
  // ownership. Single-file install, no per-building gating.
  const gameToolsBundle = {
    name: 'clawville-play',
    suggestedFilename: 'clawville-play.tools.json',
    toolsUrl: `/api/agent/${sessionId}/tools.json`,
    toolCount: CLAWVILLE_GAME_TOOLS.length,
  };

  return c.json({
    agentId: resolvedAgentId,
    sessionId,
    uuid,
    isReturning,
    totalSessions,
    knowledge,
    ownedSkills,
    gameTools: gameToolsBundle,
    identityType,
    autonomyMode,
    walletAddress,
    // Pull-side expiry visibility (2026-06-12) — the ISO timestamp this
    // session's sliding 24h TTL currently expires at. Slides forward on every
    // activity; poll GET /api/agent/session-status (or re-read this on connect)
    // to track it. Additive — existing consumers ignore it.
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    // Additive (2026-06-01) — canonical "you are inside ClawVille" orientation
    // for external agents to embed in their own system prompt. Returned for
    // every connecting agent (not just Hatcher) so any framework that brings
    // its own brain starts orientation-aware. See CONNECT_ORIENTATION above.
    orientation: CONNECT_ORIENTATION,
    ...(sessionTicket ? { sessionTicket } : {}),
    ...(identityBlock ? { identity: identityBlock } : {}),
    ...(walletBlock ? { wallet: walletBlock } : {}),
  });
});

// ---------------------------------------------------------------------------
// Phase 5.1 — GET /api/agent/challenge + POST /api/agent/reconnect
// ---------------------------------------------------------------------------
// Signed-challenge reconnect flow. Replaces the string-based identityKey
// anchor with an ed25519 signature — the agent keeps its identity
// private key in config, signs a fresh nonce on demand, and we verify
// against `users.identity_pubkey`. See plan §5.2 and §9.3.
//
// The wallet private key is NOT involved — reconnect is purely
// identity-proving, not fund-controlling. A leaked agent config lets
// an attacker log in as the user but CANNOT drain $CLAWVILLE (wallet
// secret is server-side only).
// ---------------------------------------------------------------------------

agentGatewayRoutes.get('/challenge', async (c) => {
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!challengeRateLimiter.check(ip)) {
    return c.json({ error: 'Too many challenge requests. Try again in 1 minute.' }, 429);
  }
  const issued = issueChallenge();
  return c.json(issued);
});

// 32-byte base58 nonce → 43–44 chars; 64-byte base58 signature → 86–88
// chars. Loose bounds defend against obvious garbage without making
// the schema brittle to Base58 variable-length encoding of the
// leading-zero-byte edge case.
const reconnectSchema = z.object({
  userId: z.string().uuid(),
  nonce: z.string().min(32).max(64),
  signature: z.string().min(80).max(96),
});

agentGatewayRoutes.post('/reconnect', async (c) => {
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!reconnectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many reconnect attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = reconnectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { userId, nonce, signature } = parsed.data;

  // 1. Atomically consume the nonce. Delete-on-read prevents replay —
  //    the second caller always gets false even if their signature is
  //    valid. A generic 401 hides whether the nonce was missing,
  //    expired, or already consumed.
  if (!consumeNonce(nonce)) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  // 2. Look up the user + identity_pubkey. Generic 401 on miss so an
  //    attacker can't enumerate valid userIds by timing or error-code
  //    differences. We explicitly do NOT distinguish "unknown user",
  //    "pubkey not yet set", and "bad signature" at the HTTP level.
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, identityPubkey: true },
  });
  if (!userRow || !userRow.identityPubkey) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  // 3. Verify the signature. `nacl.sign.detached.verify(message, sig,
  //    pk)` returns false on any malformed input — we don't need to
  //    try/catch decoding separately. The agent signs the RAW 32-byte
  //    nonce, not the base58 string, which is why we bs58-decode here.
  let nonceBytes: Uint8Array;
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    nonceBytes = bs58.decode(nonce);
    sigBytes = bs58.decode(signature);
    pubBytes = bs58.decode(userRow.identityPubkey);
  } catch {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }
  const ok = nacl.sign.detached.verify(nonceBytes, sigBytes, pubBytes);
  if (!ok) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  // 4. The signature is valid — treat this like a returning /connect.
  //    Look up the avatar (avatar wallet address is what we surface back as
  //    `walletAddress`, matching the human-facing economic identity)
  //    and any existing openclaw_bots row (for the bot's stable uuid).
  //    Avatar lookup is best-effort: if the user never created one,
  //    ticket still mints (they'll be bounced to /create-agent on
  //    click).
  const userAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, userId),
    columns: { id: true, name: true, walletAddress: true },
  });

  // Find the most-recent bot row for this user (by lastSeenAt desc). The
  // `uuid` field surfaced in the response is the existing bot id so
  // the agent keeps a stable handle — or null if the user has never
  // connected a bot before (reconnect-on-fresh-device case).
  const existingBot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.userId, userId),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
    columns: { id: true },
  });

  // Phase 6.1 — refresh the bot's session TTL on signed-challenge
  // reconnect so an expired+swept row pops back alive without needing
  // to re-do the magic-link /connect dance. Without this update, the
  // SKILL.md promise "Reconnecting after disconnect is free" was
  // misleading: /reconnect was re-issuing the Lucia session for the
  // human but leaving openclaw_bots.session_expires_at frozen at the
  // last /connect time, so /api/agent/session-status would still
  // report 410 Gone after a successful /reconnect.
  // Capture the refreshed expiry so the response can surface it (2026-06-12 —
  // pull-side expiry visibility, parity with /connect). Null when the user has
  // no existing bot row to refresh (nothing to expire yet).
  let reconnectExpiresAt: Date | null = null;
  if (existingBot) {
    reconnectExpiresAt = computeSessionExpiresAt();
    try {
      await db
        .update(openclawBots)
        .set({
          sessionExpiresAt: reconnectExpiresAt,
          sessionSweptAt: null,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(openclawBots.id, existingBot.id));
    } catch (err) {
      console.error('[AgentReconnect] TTL refresh failed (non-fatal):', err);
    }
  }

  // Mint the session ticket. `identityType='reconnect'` + `identityKey=userId`
  // records the provenance in the ticket row for audit without leaking the
  // pubkey itself.
  let sessionTicket: Awaited<ReturnType<typeof mintSessionTicket>>;
  try {
    sessionTicket = await mintSessionTicket({
      userId,
      avatarId: userAvatar?.id ?? null,
      identityType: 'reconnect',
      identityKey: userId,
      avatarName: userAvatar?.name ?? null,
    });
  } catch (err) {
    console.error('[AgentReconnect] ticket mint failed:', err);
    return c.json({ error: 'Failed to issue session ticket' }, 500);
  }

  await logEvent({
    eventType: 'identity.reconnected',
    userId,
    avatarId: userAvatar?.id ?? null,
    agentId: existingBot?.id ?? null,
    payload: {
      via: 'signed-challenge',
    },
  });

  return c.json({
    sessionTicket,
    avatarId: userAvatar?.id ?? null,
    uuid: existingBot?.id ?? null,
    // Pull-side expiry visibility (2026-06-12) — the refreshed TTL deadline,
    // parity with /connect. Null when the user had no bot row to refresh.
    sessionExpiresAt: reconnectExpiresAt ? reconnectExpiresAt.toISOString() : null,
    // `walletAddress` here is the AVATAR wallet (the human-facing economic
    // identity). The agent's internal bot wallet isn't relevant on
    // reconnect — the agent already has its config and doesn't need
    // its own wallet surfaced again.
    walletAddress: userAvatar?.walletAddress ?? null,
    // Phase 6.1 — also return the avatar wallet in the same `wallet` block
    // shape as /connect, so the agent has ONE place to read from
    // regardless of which flow it took. `secretKey` is NEVER returned on
    // reconnect — the first-time disclosure happens only on /connect.
    ...(userAvatar?.walletAddress
      ? {
          wallet: {
            address: userAvatar.walletAddress,
            chain: 'solana' as const,
          },
        }
      : {}),
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — GET /api/agent/session-status
// ---------------------------------------------------------------------------
// Cheap liveness probe for agents that stored a sessionId and need to
// verify it's still valid before claiming "I am connected to ClawVille"
// to the human. Returns 410 Gone past TTL so the agent's retry loop
// naturally falls into the reconnect flow instead of acting on a dead
// handle. No auth middleware — the match is `agent_id` from the query
// string (the agent's own stable handle), not a secret; liveness doesn't
// need identity-proof. Rate-limited to stop scan-by-agentId fishing.
// ---------------------------------------------------------------------------
const sessionStatusRateLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

agentGatewayRoutes.get('/session-status', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!sessionStatusRateLimiter.check(ip)) {
    return c.json({ error: 'Too many status checks. Try again in 1 minute.' }, 429);
  }

  const agentId = c.req.query('agentId');
  if (!agentId) {
    return c.json({ error: 'Missing agentId query parameter' }, 400);
  }

  const row = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, agentId),
    columns: {
      id: true,
      lastSeenAt: true,
      sessionExpiresAt: true,
    },
  });

  if (!row) {
    return c.json({ connected: false, error: 'Unknown agent' }, 404);
  }

  const now = new Date();
  // Fail-closed (Codex auth-lens hardening round 3, 2026-06-03). A NULL
  // `session_expires_at` is now treated as EXPIRED, matching the shared
  // `validateLiveAgentSession` gate every bearer-trusting path uses — a session
  // status that reported "connected" for a NULL TTL while the cove/gateway gates
  // reject the same session would be a confusing contradiction that nudges agents
  // to act on a dead handle. Every live session carries a populated 24h sliding
  // TTL, so a NULL one is a never-refreshed/pre-column row: report it gone so the
  // agent's retry loop falls into /reconnect.
  const expired =
    row.sessionExpiresAt === null || row.sessionExpiresAt <= now;

  if (expired) {
    return c.json(
      {
        connected: false,
        expired: true,
        lastSeenAt: row.lastSeenAt.toISOString(),
        expiresAt: row.sessionExpiresAt?.toISOString() ?? null,
        hint: 'Call POST /api/agent/reconnect with a signed challenge to get a fresh sessionId.',
      },
      410,
    );
  }

  return c.json({
    connected: true,
    lastSeenAt: row.lastSeenAt.toISOString(),
    // Non-null: the `expired` guard above returned on a NULL sessionExpiresAt.
    expiresAt: row.sessionExpiresAt!.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1 — GET /api/agent/wallet
// ---------------------------------------------------------------------------
// Balance + address report for the avatar wallet tied to a live session.
// Agents use this to tell the human "your avatar earned +42 ClawTokens and
// +0.0001 SOL this session" without needing to know the wallet private
// key (they don't — only the server does). Unauthenticated beyond the
// sessionId because the info surfaced (address + balances) is all
// public on-chain anyway; the sessionId scoping prevents cross-user
// leakage (a stranger can't read my balances without my sessionId).
//
// Session resolution: `sessionId → agentId` via npcSimulation's live
// map; `agentId → openclaw_bots.user_id → avatars.walletAddress`. The
// avatar's ClawToken balance is the authoritative server-side counter.
// SOL balance is deferred (no on-chain RPC call in hot path) — we
// surface `solLamports: null` with a comment so the agent can fetch
// directly from an RPC if it really needs it.
// ---------------------------------------------------------------------------
const walletSummaryRateLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

agentGatewayRoutes.get('/wallet', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!walletSummaryRateLimiter.check(ip)) {
    return c.json({ error: 'Too many wallet reads. Try again in 1 minute.' }, 429);
  }

  const sessionId = c.req.query('sessionId');
  if (!sessionId) {
    return c.json({ error: 'Missing sessionId query parameter' }, 400);
  }

  // Fail-closed liveness gate (Codex auth-lens fix #5, 2026-06-03). This route
  // exposes the bound avatar's authoritative ClawToken balance, so it must NOT
  // trust bare Map membership (`getOpenClawBotConfig`): an EXPIRED-but-in-map
  // session would otherwise keep reading a victim's live CT balance after the DB
  // TTL reaped it. Route through the SAME shared validator every other bearer
  // path uses (Map membership AND DB `session_expires_at > now`, NULL = expired,
  // unregisters a stale body). The validator returns the in-memory config + live
  // row, so we reuse them instead of a second lookup.
  const live = await validateLiveAgentSession(sessionId);
  if (!live) {
    return c.json({ error: 'Unknown or expired session' }, 404);
  }
  const { bot } = live;
  if (!bot || !bot.userId) {
    return c.json({ error: 'Session is not bound to a user account' }, 404);
  }

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, bot.userId),
    columns: {
      id: true,
      name: true,
      walletAddress: true,
      clawTokens: true,
    },
  });

  if (!avatar) {
    return c.json({ error: 'No avatar for this user' }, 404);
  }

  return c.json({
    avatarId: avatar.id,
    avatarName: avatar.name,
    wallet: {
      address: avatar.walletAddress ?? null,
      chain: 'solana' as const,
    },
    balances: {
      clawTokens: avatar.clawTokens ?? 0,
      // Agents that need live SOL balance should call their Solana
      // RPC directly with `wallet.address`. We don't fan out to
      // mainnet-beta here — it'd add ~200ms to every wallet read and
      // pin one of our Helius quota units per call.
      solLamports: null as number | null,
    },
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — POST /api/agent/disconnect
// ---------------------------------------------------------------------------
// Clean shutdown counterpart to /reconnect. Signed-challenge gated so a
// stranger can't grief a live agent by force-disconnecting it from
// outside. Flips `openclaw_bots.session_expires_at` to now(), stops any
// in-process Eliza runtime, and emits `agent.session.disconnected` for
// `/dash`. Reconnect is free and stateless — the agent picks up right
// where it left off by signing a new challenge.
// ---------------------------------------------------------------------------
const disconnectSchema = z.object({
  userId: z.string().uuid(),
  nonce: z.string().min(32).max(64),
  signature: z.string().min(80).max(96),
  agentId: z.string().min(1).max(200),
});

const disconnectRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

agentGatewayRoutes.post('/disconnect', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!disconnectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many disconnect attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = disconnectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { userId, nonce, signature, agentId } = parsed.data;

  // Atomic nonce consume — same pattern as /reconnect. Second caller
  // loses the race regardless of signature validity, which prevents
  // replay.
  if (!consumeNonce(nonce)) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  const userRow = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, identityPubkey: true },
  });
  if (!userRow || !userRow.identityPubkey) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  let nonceBytes: Uint8Array;
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    nonceBytes = bs58.decode(nonce);
    sigBytes = bs58.decode(signature);
    pubBytes = bs58.decode(userRow.identityPubkey);
  } catch {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }
  if (!nacl.sign.detached.verify(nonceBytes, sigBytes, pubBytes)) {
    return c.json({ error: 'Invalid or expired challenge' }, 401);
  }

  // Authorization check — the signature proves ownership of the user
  // identity, but we still require the bot row to belong to that user
  // so a leaked identity key for user A can't disconnect user B's bot
  // just by passing B's agentId. Agents without a userId (pre-Phase-5
  // anonymous rows) can't be disconnected via this path; they fall back
  // to /openclaw/unregister.
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, agentId),
    columns: { id: true, userId: true },
  });
  if (!bot || bot.userId !== userId) {
    return c.json({ error: 'Agent not found for this user' }, 404);
  }

  await expireSession(agentId);

  // BUG FIX (2026-06-01, Hatcher Phase A): disconnect previously flipped the
  // session TTL + stopped the runtime but NEVER removed the in-world body, so
  // the spawned NPC (avatar) / override lingered until the next API restart.
  // Remove every live in-world session bound to this agentId so a clean signed
  // disconnect actually frees the seat. Idempotent (no-op if already gone), so
  // reconnect is unaffected — /connect re-registers a fresh session anyway.
  let removedBodies = 0;
  try {
    const liveSessions = npcSimulation.findActiveSessionsByAgentIds([agentId]);
    for (const sid of liveSessions) {
      if (npcSimulation.unregisterOpenClaw(sid)) removedBodies++;
    }
  } catch (err) {
    console.error('[AgentDisconnect] in-world body removal failed (non-fatal):', err);
  }

  void logEvent({
    eventType: 'agent.session.disconnected',
    userId,
    agentId,
    payload: { via: 'signed-challenge', removedBodies },
  });

  return c.json({ disconnected: true, agentId });
});

// ---------------------------------------------------------------------------
// Phase 5 helper — resolve the {identityType, identityKey} pair to use
// for magic-link minting. Centralises the logic so /connect and /join
// stay in lockstep. Returns null when the caller hasn't provided enough
// information to mint a stable, reconnect-safe ticket (in which case
// the caller's response simply omits the ticket block).
// ---------------------------------------------------------------------------
function resolveIdentityForTicket(data: {
  identityType?: string;
  identityKey?: string;
  miladyAgentId?: string;
  gatewayUrl?: string;
  authToken?: string;
  agentId?: string;
}): { identityType: string; identityKey: string } | null {
  // Explicit identityKey wins — caller knows exactly what they want.
  if (data.identityKey && data.identityType) {
    return { identityType: data.identityType, identityKey: data.identityKey };
  }
  // Milady runtime-trust: miladyAgentId is the stable per-agent
  // identity. This mirrors the resolvedAgentId logic above so a
  // Milady user's avatar persists across launches.
  if (data.miladyAgentId) {
    return { identityType: 'milady', identityKey: data.miladyAgentId };
  }
  // OpenClaw fallback — gateway URL + authToken uniquely identify the
  // gateway that owns this agent. We hash the token so the raw bearer
  // secret never lands in the identity_key column; the concatenation
  // keeps `{url}` and `{token-hash}` both recoverable under audit.
  if (data.gatewayUrl && data.authToken) {
    return {
      identityType: 'openclaw',
      identityKey: `${data.gatewayUrl}#${data.authToken.slice(0, 8)}`,
    };
  }
  // Explicit identityKey but no type — treat as 'custom'.
  if (data.identityKey) {
    return { identityType: 'custom', identityKey: data.identityKey };
  }
  return null;
}

/**
 * Helper called from both `/connect` and `/join`. Resolves identity,
 * ensures a user exists, and mints a ticket.
 *
 * When called from `/connect` with a connection-token flow, an
 * existing `(userId, avatarId)` pair already exists — we pass it through
 * so the ticket lands on the human's original avatar rather than
 * auto-provisioning a new one. For first-contact `/connect` (no
 * connection-token) or `/join`, the avatar creation happens inside the
 * caller; here we just mint against whatever user/avatar we resolve.
 *
 * Phase 5.1: also returns the resolved `{userId, avatarId}` so `/connect`
 * can call `generateIdentityKeypairForUser` and
 * `ensureWalletWithFirstTimeSecret` off the same resolution (no double
 * lookup). Returns `{ticket: null, userId: null, avatarId: null}` only
 * when the caller hasn't provided enough identity to resolve a user
 * (e.g. a one-shot anonymous agent with no identityKey + no token).
 */
interface ResolvedConnectTicket {
  ticket: Awaited<ReturnType<typeof mintSessionTicket>> | null;
  userId: string | null;
  avatarId: string | null;
  avatarName: string | null;
}

async function mintSessionTicketFromConnect(args: {
  data: {
    identityType?: string;
    identityKey?: string;
    miladyAgentId?: string;
    gatewayUrl?: string;
    authToken?: string;
    agentId?: string;
  };
  resolvedAgentId: string;
  identityType: string;
  sessionId: string;
  existingUserId: string | null;
  existingAvatarId: string | null;
  existingAvatarName: string | null;
}): Promise<ResolvedConnectTicket> {
  try {
    // If the caller already resolved a user via the connection-token
    // flow, use that directly — no identity bootstrap needed.
    let userId = args.existingUserId;
    let avatarId = args.existingAvatarId;
    let avatarName = args.existingAvatarName;
    let ticketIdentityType = args.identityType;
    let ticketIdentityKey: string | null = null;

    if (!userId) {
      const ident = resolveIdentityForTicket(args.data);
      if (!ident) return { ticket: null, userId: null, avatarId: null, avatarName: null };
      const user = await resolveOrCreateUserByIdentity(ident.identityType, ident.identityKey);
      userId = user.id;
      ticketIdentityType = ident.identityType;
      ticketIdentityKey = ident.identityKey;

      // Try to locate an existing avatar for this user so the ticket
      // binds to it. Enter-page redirects to /game which will load
      // whatever avatar belongs to the session — avatarId binding is
      // informational only.
      const existingAvatar = await db.query.avatars.findFirst({
        where: eq(avatars.userId, userId),
      });
      if (existingAvatar) {
        avatarId = existingAvatar.id;
        avatarName = existingAvatar.name;
      }
    } else {
      // Connection-token path — we don't have a key, only a type hint.
      // Record the type for audit; leave key null.
      ticketIdentityKey = args.data.identityKey ?? args.data.miladyAgentId ?? null;
    }

    const ticket = await mintSessionTicket({
      userId,
      avatarId,
      identityType: ticketIdentityType,
      identityKey: ticketIdentityKey ?? args.resolvedAgentId,
      issuedToAgentSession: args.sessionId,
      avatarName,
    });

    return { ticket, userId, avatarId, avatarName };
  } catch (err) {
    console.error('[AgentConnect] ticket mint failed (non-fatal):', err);
    return { ticket: null, userId: null, avatarId: null, avatarName: null };
  }
}

// ---------------------------------------------------------------------------
// POST /api/agent/join — Phase 5 first-contact onboarding.
// ---------------------------------------------------------------------------
// Designed for humans who drop a public ClawVille connect link into an
// agent chat without ever having signed up. The agent reads the SKILL
// at `/api/skills/join`, hits this endpoint with its own
// `{identityType, identityKey}`, and we:
//
//   1. Resolve-or-create a `users` row via identity_fingerprint.
//   2. Provision a default avatar if the user doesn't already have one
//      (model=lobster, category=openclaw, harness=milady — the Phase 2
//      defaults that produce a self-sufficient Milady-ready agent).
//   3. Mint a magic-link session ticket and return it.
//
// Agent relays `sessionTicket.url` back to the human, who clicks and
// lands on `/game` already-logged-in as the new user.
//
// Rate-limited the same way /connect is (shared limiter, 10/min/IP).
// Rate-limit runs BEFORE any DB work — no identity-bootstrap or avatar
// insert can burn budget on a spam wave.
// ---------------------------------------------------------------------------
const joinSchema = z.object({
  identityType: z.enum([
    'openclaw', 'ironclaw', 'nanoclaw', 'milady', 'custom', 'anonymous',
  ]),
  identityKey: z.string().min(1).max(256),
  /** Optional display name for the auto-provisioned avatar. Falls back to `Unnamed Agent`. */
  name: z.string().min(1).max(24).optional(),
});

// Default archetype for auto-provisioned avatars. `curious-scholar` matches
// the "learning skills from buildings" flavor of the game better than
// `brave-adventurer` — the avatar immediately reads like someone who
// should be in a skill-building MMO.
const DEFAULT_JOIN_ARCHETYPE = 'curious-scholar';

agentGatewayRoutes.post('/join', async (c) => {
  // Rate limit BEFORE any DB work (audit Fix M1 pattern from Phase 3 —
  // don't let a scraper burn Lucia/Postgres round-trips on spam).
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!connectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many join attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { identityType, identityKey } = parsed.data;

  // 1. Resolve-or-create user (race-safe against concurrent joins).
  let userId: string;
  try {
    const user = await resolveOrCreateUserByIdentity(identityType, identityKey);
    userId = user.id;
  } catch (err) {
    console.error('[AgentJoin] identity resolution failed:', err);
    return c.json({ error: 'Identity bootstrap failed' }, 500);
  }

  // 2. Look up existing avatar OR auto-provision a placeholder.
  let avatar = await db.query.avatars.findFirst({ where: eq(avatars.userId, userId) });
  let avatarCreated = false;

  if (!avatar) {
    // Auto-provision a default avatar so the user can click through and
    // see a running agent immediately. They can rename / reconfigure
    // at `/create-agent` (or `/settings`) once they're logged in.
    const archetype = AVATAR_ARCHETYPES.find((a) => a.id === DEFAULT_JOIN_ARCHETYPE);
    if (!archetype) {
      // Unreachable unless the archetype registry was edited without
      // updating the constant above — surface loudly rather than 500.
      return c.json({ error: `Default archetype '${DEFAULT_JOIN_ARCHETYPE}' missing from registry` }, 500);
    }

    // Unique avatar name — append 6 hex chars of the user id so two
    // first-contact agents don't collide on `avatars.name`'s UNIQUE
    // constraint. Human-overridable later.
    const requestedName = parsed.data.name?.trim() || 'Unnamed Agent';
    const suffix = userId.replace(/-/g, '').slice(0, 6);
    const avatarName = `${requestedName} ${suffix}`.slice(0, 100);

    try {
      const [inserted] = await db
        .insert(avatars)
        .values({
          userId,
          name: avatarName,
          // The legacy species/color/gender enums are still NOT NULL
          // in the schema — pick the sea-world defaults that match
          // the Phase 2 agent defaults (lobster == sea creature).
          species: 'turtle', // closest existing species enum to a neutral sea creature
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
            system: `You are ${requestedName}, a Reef Lobster in the sea-themed world of ClawVille. Your archetype is "${archetype.label}". Stay in character.`,
          },
          modelKey: DEFAULT_AGENT_MODEL_KEY,
          agentCategory: DEFAULT_AGENT_CATEGORY,
          harness: DEFAULT_AGENT_HARNESS,
        })
        .returning();
      avatar = inserted;
      avatarCreated = true;
    } catch (err: unknown) {
      // Race-safe recovery: two concurrent /join calls with the same
      // identity both resolve to the same user, both observe "no avatar",
      // both try to INSERT. `avatars.user_id` is UNIQUE, so the loser
      // catches 23505 and re-reads the avatar the winner just wrote.
      // Without this, the second caller 500s on what should be a
      // deterministic "use my existing avatar" path.
      const code =
        (err as { code?: string; cause?: { code?: string } } | null)?.code
        ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') {
        const raced = await db.query.avatars.findFirst({ where: eq(avatars.userId, userId) });
        if (raced) {
          avatar = raced;
        } else {
          console.error('[AgentJoin] 23505 on avatar insert but no existing row found');
          return c.json({ error: 'Failed to provision default avatar' }, 500);
        }
      } else {
        console.error('[AgentJoin] default avatar insert failed:', err);
        return c.json({ error: 'Failed to provision default avatar' }, 500);
      }
    }
  }

  // 3. Ensure the avatar has a wallet. Phase 5.1 gap-fill: /join previously
  //    created avatars without provisioning a wallet row, so returning
  //    users had a missing wallet until they happened to hit /connect.
  //    We call `ensureWalletWithFirstTimeSecret` specifically because
  //    brand-new avatars get the plaintext secret returned exactly once —
  //    the agent relays it to the human for self-custody backup (see
  //    wallets.ts JSDoc for the custodial export doctrine).
  //
  //    Wallet failure is non-fatal: ticket minting proceeds even if the
  //    wallet couldn't be created, so a transient Cloudflare Worker
  //    outage doesn't brick the join flow. When this happens we log
  //    but do NOT include the wallet block in the response (agent has
  //    no secret to relay).
  let walletDisclosure: {
    address: string;
    secretKey: string;
    chain: 'solana';
  } | null = null;
  try {
    const w = await ensureWalletWithFirstTimeSecret('avatar', avatar.id);
    if (w.firstTimeSecretKeyBase58) {
      walletDisclosure = {
        address: w.publicKey,
        secretKey: w.firstTimeSecretKeyBase58,
        chain: 'solana',
      };
    }
  } catch (err) {
    console.error('[AgentJoin] wallet provisioning failed (non-fatal):', err);
  }

  // 3b. Phase 5.1 — bootstrap the ed25519 identity keypair for this user
  //     if it doesn't exist yet. Same semantics as /connect: the agent
  //     saves this under `clawville:identity:<userId>` in its config
  //     and uses the private key to sign /challenge nonces on later
  //     reconnect. Failure non-fatal — join completes without it.
  let identityBlock: {
    userId: string;
    publicKey: string;
    secretKey?: string;
    isFirstTime: boolean;
    needsHumanReauth?: boolean;
  } | null = null;
  try {
    const ident = await generateIdentityKeypairForUser(userId);
    if (ident.isFirstTime) {
      identityBlock = {
        userId,
        publicKey: ident.publicKey,
        secretKey: ident.secretKey,
        isFirstTime: true,
      };
      await logEvent({
        eventType: 'identity.issued',
        userId,
        avatarId: avatar.id,
        payload: {
          identityType,
          identityPubkey: ident.publicKey,
          via: 'join',
        },
      });
    } else if (ident.needsHumanReauth) {
      identityBlock = {
        userId,
        publicKey: ident.publicKey,
        isFirstTime: false,
        needsHumanReauth: true,
      };
    }
  } catch (err) {
    console.error('[AgentJoin] identity generation failed (non-fatal):', err);
  }

  // 4. Mint the magic-link ticket bound to this user+avatar.
  let sessionTicket: Awaited<ReturnType<typeof mintSessionTicket>> | null = null;
  try {
    sessionTicket = await mintSessionTicket({
      userId,
      avatarId: avatar.id,
      identityType,
      identityKey,
      avatarName: avatar.name,
    });
  } catch (err) {
    console.error('[AgentJoin] ticket mint failed:', err);
    return c.json({ error: 'Failed to issue session ticket' }, 500);
  }

  return c.json({
    userId,
    avatarId: avatar.id,
    avatarName: avatar.name,
    avatarCreated,
    sessionTicket,
    // Phase 5.1 — first-time wallet disclosure. Only present when the
    // avatar wallet was just created; subsequent /join calls omit this.
    // The agent MUST relay `wallet.secretKey` to the human in-chat and
    // never store it in its own config.
    ...(walletDisclosure ? { wallet: walletDisclosure } : {}),
    // Phase 5.1 — ed25519 identity keypair. Present on first-time
    // provisioning (secretKey included) OR on race-loser (needsHumanReauth
    // flag set, no secret). Omitted for returning users whose agent
    // already has a stored identity.
    ...(identityBlock ? { identity: identityBlock } : {}),
  });
});

// --- Middleware: validate session and resolve NPC ---

// Fail-closed liveness gate for the agent-gateway routes (Codex auth-lens
// hardening round 3, 2026-06-03). Previously this only did `isValidAgentSession`
// (bare Map membership) with NO DB TTL check — so an EXPIRED session still
// resolved, and the visit-building + building-chat routes below credit REAL CT,
// meaning an expired bearer kept earning. It now routes through the SAME shared
// `validateLiveAgentSession` the cove ledger resolver uses (DB
// `session_expires_at > now`, NULL = expired, unregister stale body), so the TTL
// can never drift between the two. Async because the liveness check hits the DB;
// every caller awaits.
async function resolveSession(sessionId: string) {
  const live = await validateLiveAgentSession(sessionId);
  if (!live) return null;
  const npcId = npcSimulation.getNpcIdForSession(sessionId);
  if (!npcId) return null;
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;

  // FIX-4 (SL-1/SL-2, 2026-06-13) — slide the 24h session TTL + `last_seen_at`
  // forward on EVERY mutating gateway action. `resolveSession` is the single
  // chokepoint for the entire connected-agent action surface (perception, move,
  // chat, visit-building, building-chat, combat-action, emote), and before this
  // NONE of those paths advanced the TTL. A Hatcher partner agent registers via
  // `POST /api/partner/hatcher/agents` (which sets `sessionExpiresAt` ONCE) then
  // plays purely through `/:sessionId/*` here — so without this slide a
  // continuously-active agent was idle-despawned after 30min and swept after 24h.
  //
  // Fire-and-forget (NOT awaited) so the TTL write never blocks the action; the
  // shared `extendSessionTtl` helper carries its own `.catch()`. It is the single
  // source of truth for the slide (writes `sessionExpiresAt`, `lastSeenAt`, and
  // crucially `sessionSweptAt: null`), mirroring the location-chat path in
  // `openclaw.ts`. `getOpenClawBotConfig` is a synchronous in-process Map lookup,
  // so resolving `agentId` here adds no DB round-trip. No double-slide risk: the
  // action handlers below only write knowledge/combat/`updatedAt`, never the TTL
  // columns. Anonymous/legacy sessions with no bot config simply skip the slide.
  const config = npcSimulation.getOpenClawBotConfig(sessionId);
  if (config) {
    void extendSessionTtl(config.agentId);
  }

  return { npcId, npc };
}

// ---------------------------------------------------------------------------
// buildPerception — shared helper for GET /perception and SSE /events
// ---------------------------------------------------------------------------
function buildPerception(npcId: string): AgentPerception | null {
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;

  const allNpcs = npcSimulation.getAllNpcs();
  const PERCEPTION_RADIUS = 500;

  // Nearby NPCs within radius
  const nearbyNpcs = allNpcs
    .filter((other) => other.id !== npcId)
    .map((other) => {
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return { other, distance };
    })
    .filter(({ distance }) => distance <= PERCEPTION_RADIUS)
    .map(({ other, distance }) => ({
      npcId: other.id,
      name: other.name,
      x: other.x,
      y: other.y,
      distance: Math.round(distance),
      species: other.species,
      hp: other.hp,
      isDead: other.isDead,
      inCombat: other.inCombat,
      activity: other.activity,
      level: other.level,
      isOpenClaw: other.isOpenClaw,
    }));

  // Nearby buildings
  const nearbyBuildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][]).map(([buildingId, center]) => {
    const dx = center.x - npc.x;
    const dy = center.y - npc.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    return {
      buildingId,
      label: theme?.label ?? buildingId,
      cryptoFocus: theme?.focus ?? '',
      centerX: center.x,
      centerY: center.y,
      distance: Math.round(distance),
    };
  }).sort((a, b) => a.distance - b.distance);

  // Active conversations involving this NPC
  const conversations = npcSimulation.getActiveConversations();
  const activeConversations = conversations.map((conv) => ({
    id: conv.id,
    participants: [conv.npc1Id, conv.npc2Id],
    latestMessage: conv.messages.length > 0
      ? conv.messages[Math.min(conv.currentIndex, conv.messages.length - 1)].text
      : '',
    involvesMe: conv.npc1Id === npcId || conv.npc2Id === npcId,
  }));

  // Active combats
  const combats = npcSimulation.getActiveCombats();
  const activeCombats = combats.map((combat) => ({
    id: combat.id,
    attacker: combat.attacker,
    defender: combat.defender,
    involvesMe: combat.attacker === npcId || combat.defender === npcId,
    lastRound: combat.rounds.length > 0
      ? combat.rounds[combat.rounds.length - 1]
      : null,
  }));

  const arenaRound = npcSimulation.getMode() === 'arena'
    ? (() => {
        const snapshot = npcSimulation.getSnapshot();
        return snapshot.arenaRound;
      })()
    : null;

  return {
    self: {
      npcId: npc.id,
      x: npc.x,
      y: npc.y,
      hp: npc.hp,
      maxHp: npc.maxHp,
      level: npc.level,
      kills: npc.kills,
      xp: npc.xp,
      inventory: npc.inventory,
      activity: npc.activity,
      inCombat: npc.inCombat,
      isDead: npc.isDead,
      combatAction: npc.combatAction,
      direction: npc.direction,
    },
    nearbyNpcs,
    nearbyBuildings,
    activeConversations,
    activeCombats,
    gameMode: npcSimulation.getMode(),
    arenaRound,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/perception
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/perception', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const perception = buildPerception(resolved.npcId);
  if (!perception) return c.json({ error: 'NPC state unavailable' }, 404);

  return c.json(perception);
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/move
// ---------------------------------------------------------------------------
const moveSchema = z.object({
  targetX: z.number().min(16).max(5104).optional(),
  targetY: z.number().min(16).max(5104).optional(),
  buildingId: z.string().optional(),
}).refine(
  (d) => (d.targetX !== undefined && d.targetY !== undefined) || d.buildingId !== undefined,
  { message: 'Provide either targetX+targetY or buildingId' }
);

agentGatewayRoutes.post('/:sessionId/move', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { targetX, targetY, buildingId } = parsed.data;

  if (npc.isDead) return c.json({ error: 'NPC is dead, wait for respawn' }, 400);

  let destX: number;
  let destY: number;
  let destBuildingId: string | undefined;

  if (buildingId) {
    const center = NPC_BUILDING_CENTERS[buildingId];
    if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);
    destX = center.x + (Math.random() - 0.5) * 40;
    destY = center.y + 20 + Math.random() * 20;
    destBuildingId = buildingId;
  } else {
    destX = targetX!;
    destY = targetY!;
  }

  const path = findPath(npc.x, npc.y, destX, destY);
  if (path.length === 0) return c.json({ error: 'No path found to destination' }, 400);

  npcSimulation.setNpcPath(npcId, path, destBuildingId);
  return c.json({ success: true, pathLength: path.length, destination: { x: destX, y: destY } });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/chat
// ---------------------------------------------------------------------------
const chatSchema = z.object({
  message: z.string().min(1).max(500),
  targetNpcId: z.string().optional(),
});

agentGatewayRoutes.post('/:sessionId/chat', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;

  // Always inject into world simulation for visible chat bubbles
  npcSimulation.injectAgentChat(npcId, parsed.data.message);

  // Route through ElizaOS agent for memory + context (if agent exists)
  let elizaResponse: string | null = null;
  const elizaAgentId = getSessionAgent(sessionId);
  if (elizaAgentId) {
    try {
      const runtime = await agentOrchestrator.ensureAgentRuntime(elizaAgentId);
      if (runtime) {
        // Phase 4: inject services + bot data so Actions + Providers work
        // Adapter translates runtime's `avatarId` → ledger's `avatarId`.
        // See `services/runtime-services-adapter.ts`.
        const services = buildRuntimeServices(db);

        // Look up the bot via its resolved agentId (e.g. milady:xxx), NOT npcId
        const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
        const bot = botConfig
          ? await db.query.openclawBots.findFirst({
              where: eq(openclawBots.agentId, botConfig.agentId),
            })
          : null;

        // World snapshot for WorldStateProvider
        let worldSnapshot: { npcs: any[] } | null = null;
        try {
          const allNpcs = npcSimulation.getAllNpcs();
          worldSnapshot = {
            npcs: allNpcs
              .filter((n: any) => !n.isDead && n.id !== npcId)
              .slice(0, 8)
              .map((n: any) => ({
                name: n.name,
                activity: n.activity ?? 'idle',
                destinationBuildingId: n.destinationBuildingId,
                isDead: n.isDead,
              })),
          };
        } catch { /* non-blocking */ }

        const state: Record<string, any> = {
          avatarId: bot?.id ?? npcId,
          // MUST be set: the KnowledgeProvider keys learned-skill retrieval on the
          // hosted bot's platform_agents id (agent_id=room_id=entity_id). elizaAgentId
          // IS that id (the runtime was started with it and its knowledge memories live
          // under it); without it the provider falls back to avatarId (openclaw_bots.id
          // or npcId) and every learned-skill retrieval misses.
          platformAgentId: elizaAgentId,
          // Raw sessionId is folded into ElizaOS room derivation (not stored as a
          // recoverable bearer column), so keying it raw re-opens no recoverable
          // leak while preserving chat-memory continuity across deploys.
          userId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionId,
          services,
          avatarData: bot ? {
            id: bot.id,
            name: bot.name,
            species: bot.species ?? 'cat',
            clawTokens: (bot as any).clawTokens ?? 0,
            archetype: null,
          } : null,
          nearLocation: npc.destinationBuildingId ?? null,
          worldSnapshot,
          characterConfig: bot?.knowledge ? { knowledge: bot.knowledge } : {},
          userMessage: parsed.data.message,
        };

        const result = await runtime.processMessage(parsed.data.message, {
          // Raw sessionId is folded into ElizaOS room derivation (not stored as a
          // recoverable bearer column), so keying it raw re-opens no recoverable
          // leak while preserving chat-memory continuity across deploys.
          userId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionId,
          roomId: `agent-gateway-${npcId}`,
          platform: 'clawville-gateway',
          dynamicContext: `You are ${npc.name} in the ClawVille world. Respond in character.`,
          state,
        });
        elizaResponse = result.content;
      }
    } catch (err) {
      console.error(`[AgentGateway] ElizaOS chat failed for ${npcId}:`, err);
    }
  }

  void logEventFromContext(c, {
    eventType: 'agent.chat.turn',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: {
      chatType: 'character',
      targetNpcId: parsed.data.targetNpcId ?? npcId,
      messageLength: parsed.data.message.length,
      hadElizaResponse: Boolean(elizaResponse),
    },
  });

  return c.json({ success: true, response: elizaResponse });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/visit-building
// ---------------------------------------------------------------------------
const visitSchema = z.object({
  buildingId: z.string().min(1),
});

agentGatewayRoutes.post('/:sessionId/visit-building', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = visitSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { buildingId } = parsed.data;

  const center = NPC_BUILDING_CENTERS[buildingId];
  if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);

  // Check proximity — relaxed to 2000px for early testing (TODO: tighten to 80px)
  const VISIT_RADIUS = 2000;
  const dx = npc.x - center.x;
  const dy = npc.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > VISIT_RADIUS) return c.json({ error: `Too far from ${buildingId} (${Math.round(dist)}px away, need <${VISIT_RADIUS}px)` }, 400);

  // Set building activity
  const activities = BUILDING_ACTIVITIES[buildingId] ?? ['thinking'];
  const picked = activities[Math.floor(Math.random() * activities.length)] as NpcActivity;
  npcSimulation.setNpcActivity(npcId, picked, ACTIVITY_EMOJIS[picked]);

  // Award token + extract knowledge
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  let knowledgeGained: string | null = null;
  if (theme) {
    knowledgeGained = `Visited ${theme.label}: learned about ${theme.focus.split(',')[0]}`;
  }

  // Award 1 ClawToken for visiting a building (best-effort — openclaw bots
  // without a matching avatars row will silently skip the credit)
  let tokenAwarded = 0;
  // Capture bot's userId so the event row can be attributed to the human
  // account behind the agent — required for the deep-explorer tutorial
  // quest validator's `(user_id = X OR avatar_id = Y)` check (audit-fix
  // 2026-04-29).
  let visitUserId: string | null = null;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        visitUserId = bot.userId ?? null;
        // BUG FIX (2026-06-01, Hatcher Phase A): credit the BOUND AVATAR, not
        // `bot.id`. `bot.id` is an openclaw_bots PK, not an avatars PK, so the
        // ledger threw "avatar not found" (swallowed) and connected agents
        // never earned CT for building visits. Resolve the avatar via
        // bot.userId -> avatars.id and credit that. If the bot has no
        // userId/avatar, skip the credit honestly (tokenAwarded stays 0).
        const avatarId = await resolveAvatarIdForBot(bot.userId ?? null);
        if (avatarId) {
          await creditClawTokens({
            avatarId,
            amount: 1,
            reason: 'building_visit',
            source: 'api',
            // sessionDigest, NOT the raw sessionId (Codex auth-lens fix #4):
            // `claw_token_transactions.metadata` is a persisted JSON column, and
            // the raw sessionId is the real-CT bearer credential — never store a
            // recoverable bearer in a money-ledger row. Digest is correlation-only.
            metadata: { buildingId, sessionDigest: sessionDigest(sessionId), agentId: bot.agentId },
          });
          tokenAwarded = 1;
        }
      }
    } catch (err) {
      // Genuine ledger/DB error — log it (don't silently swallow). Credit
      // failed, tokenAwarded stays 0.
      console.error('[AgentGateway] building-visit CT credit failed:', err);
      tokenAwarded = 0;
    }
  }

  // Create memory (fire-and-forget)
  memoryService.createMemory({
    entityId: npcId,
    entityType: 'npc',
    content: `Visited ${buildingId}${theme ? ` (${theme.label})` : ''}`,
    importance: 3,
    kind: 'observation',
    metadata: { buildingId, activity: picked },
  }).catch(() => {});

  // Persist knowledge to openclaw_bots table (fire-and-forget)
  if (botConfig && knowledgeGained) {
    (async () => {
      try {
        const bot = await db.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, botConfig.agentId),
        });
        if (bot) {
          const current: string[] = bot.knowledge ?? [];
          if (!current.includes(knowledgeGained!)) {
            await db.update(openclawBots).set({
              knowledge: [...current, knowledgeGained!],
              updatedAt: new Date(),
            }).where(eq(openclawBots.id, bot.id));
          }
        }
      } catch (err) {
        console.error('[AgentGateway] Failed to persist knowledge:', err);
      }
    })();
  }

  void logEventFromContext(c, {
    eventType: 'building.visited',
    // Audit-fix 2026-04-29 — userId attribution lets the deep-explorer
    // tutorial quest validator credit the human account for autonomous
    // agent visits. Was missing pre-fix; quest was effectively unclaimable
    // for users whose agents did all the visiting.
    userId: visitUserId,
    agentId: botConfig?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    buildingId,
    payload: {
      tokenAwarded,
      activity: picked,
      knowledgeGained: knowledgeGained ? 1 : 0,
    },
  });

  return c.json({
    success: true,
    activity: picked,
    tokenAwarded,
    knowledgeGained,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/building/:buildingId/chat
// ---------------------------------------------------------------------------
// Autonomous agent initiates a teaching conversation with a building's
// resident character (Gary, Patrick, Sandy, etc.). The character's ElizaOS
// runtime is loaded with the compiled SKILL.md as RAG knowledge, so its
// answer is grounded in the real skill corpus rather than its placeholder
// backstory.
//
// Flow:
//   1. Validate agent session + proximity to the building
//   2. Look up the system NPC seeded by `ensureSystemNpcs()`
//   3. Start / reuse the NPC's ElizaRuntime via the orchestrator
//   4. processMessage with the agent's prompt + building theme context
//   5. Persist the exchange as knowledge chunks on openclaw_bots.knowledge
//   6. Award +1 ClawToken for a successful teaching turn
const buildingChatSchema = z.object({
  message: z.string().min(1).max(4000),
});

agentGatewayRoutes.post('/:sessionId/building/:buildingId/chat', async (c) => {
  const sessionId = c.req.param('sessionId');
  const buildingId = c.req.param('buildingId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = buildingChatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const center = NPC_BUILDING_CENTERS[buildingId];
  if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);

  // Proximity check — must be near the building to chat with its character
  const CHAT_RADIUS = 2000;
  const { npcId, npc } = resolved;
  const dx = npc.x - center.x;
  const dy = npc.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > CHAT_RADIUS) {
    return c.json(
      {
        error: `Too far from ${buildingId} (${Math.round(dist)}px away, need <${CHAT_RADIUS}px). Move closer via POST /move.`,
      },
      400,
    );
  }

  // Load the seeded system NPC for this building
  const system = await getSystemNpcAgent(buildingId);
  if (!system || !system.locationAgent.platformAgentId) {
    return c.json({ error: `No character available for ${buildingId}. System NPC seeder may not have run yet.` }, 503);
  }

  // Start / reuse the NPC's ElizaRuntime
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    system.locationAgent.platformAgentId,
    system.systemUserId,
  );
  if (!runtime) {
    return c.json({ error: 'Failed to start character runtime' }, 500);
  }

  // Inject building theme + the visiting agent's identity so the character
  // knows who they're teaching
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  const contextParts: string[] = [];
  if (theme) {
    contextParts.push(
      `You are teaching an autonomous agent about ${theme.focus}. Use your knowledge base to give a grounded, specific answer — cite concrete patterns, commands, or examples from your SKILL.md knowledge when relevant.`,
    );
  }
  contextParts.push(
    `The visitor is an autonomous bot named "${npc.name}" (agent session ${sessionId.slice(0, 8)}...). Treat them as a peer agent capable of absorbing technical detail.`,
  );
  const dynamicContext = contextParts.join('\n');

  // Each (agent-session, building) pair gets its own ElizaOS conversation
  // room so parallel agents don't blend their teaching threads.
  const roomId = `${buildingId}-${sessionId}`;

  let responseContent: string;
  try {
    const response = await runtime.processMessage(parsed.data.message, {
      // Raw sessionId is folded into ElizaOS room derivation (not stored as a
      // recoverable bearer column), so keying it raw re-opens no recoverable
      // leak while preserving chat-memory continuity across deploys.
      userId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionId,
      roomId,
      platform: 'clawville-agent-gateway',
      dynamicContext,
      state: {
        nearLocation: buildingId,
      },
    });
    responseContent = response.content;
  } catch (err) {
    console.error('[AgentGateway] building-chat runtime error:', err);
    return c.json({ error: 'Character failed to respond' }, 500);
  }

  // Persist the teaching into the bot's learned-knowledge ledger
  let tokenAwarded = 0;
  let knowledgePersisted = false;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        // Summarise the exchange into a single knowledge line so we don't
        // blow up the bot's knowledge array with raw transcript
        const entry = `[${buildingId}] Q: ${parsed.data.message.slice(0, 160)} | A: ${responseContent.slice(0, 400)}`;
        const current: string[] = bot.knowledge ?? [];
        if (!current.includes(entry)) {
          await db
            .update(openclawBots)
            .set({ knowledge: [...current, entry], updatedAt: new Date() })
            .where(eq(openclawBots.id, bot.id));
          knowledgePersisted = true;
        }
        // Award +1 ClawToken for successful teaching turn.
        // BUG FIX (2026-06-01, Hatcher Phase A): credit the BOUND AVATAR, not
        // `bot.id` (same no-op bug as building-visit). Resolve the avatar via
        // bot.userId -> avatars.id; skip honestly if the bot has no
        // userId/avatar (tokenAwarded stays 0).
        const avatarId = await resolveAvatarIdForBot(bot.userId ?? null);
        if (avatarId) {
          await creditClawTokens({
            avatarId,
            amount: 1,
            reason: 'building_chat_teaching',
            source: 'api',
            // sessionDigest, NOT the raw sessionId (Codex auth-lens fix #4) - see
            // the building-visit credit above. Money-ledger metadata is persisted;
            // never store the recoverable real-CT bearer in it.
            metadata: { buildingId, sessionDigest: sessionDigest(sessionId), agentId: bot.agentId, characterName: system.locationAgent.agentName },
          });
          tokenAwarded = 1;
        }
      }
    } catch (err) {
      console.error('[AgentGateway] building-chat knowledge persist failed:', err);
    }
  }

  void logEventFromContext(c, {
    eventType: 'agent.chat.turn',
    agentId: botConfig?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    buildingId,
    payload: {
      chatType: 'building',
      characterName: system.locationAgent.agentName,
      messageLength: parsed.data.message.length,
      tokenAwarded,
      knowledgePersisted,
    },
  });

  return c.json({
    success: true,
    buildingId,
    characterName: system.locationAgent.agentName,
    message: responseContent,
    tokenAwarded,
    knowledgePersisted,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/combat-action
// ---------------------------------------------------------------------------
const combatActionSchema = z.object({
  action: z.enum(['attack', 'heavy', 'block', 'dodge', 'combo']),
});

agentGatewayRoutes.post('/:sessionId/combat-action', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = combatActionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  if (!npc.inCombat) return c.json({ error: 'NPC is not in combat' }, 400);

  npcSimulation.setNpcCombatAction(npcId, parsed.data.action);
  return c.json({ success: true, action: parsed.data.action });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/emote
// ---------------------------------------------------------------------------
const emoteSchema = z.object({
  activity: z.enum([
    'idle', 'walking', 'visiting', 'reading', 'sleeping',
    'eating', 'playing', 'shopping', 'chatting', 'thinking',
  ] as const),
});

agentGatewayRoutes.post('/:sessionId/emote', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = emoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId } = resolved;
  const activity = parsed.data.activity as NpcActivity;
  npcSimulation.setNpcActivity(npcId, activity, ACTIVITY_EMOJIS[activity]);
  return c.json({ success: true, activity });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/knowledge
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/knowledge', async (c) => {
  const sessionId = c.req.param('sessionId');
  // Fail-closed liveness gate (shared validator) instead of bare Map membership.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ knowledge: [] });

  try {
    const bot = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, botConfig.agentId),
    });
    return c.json({ knowledge: bot?.knowledge ?? [] });
  } catch {
    return c.json({ knowledge: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/stats
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/stats', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId, npc } = resolved;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);

  let totalMessages = 0;
  let knowledgeLearned: string[] = [];
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        totalMessages = bot.totalMessages;
        knowledgeLearned = bot.knowledge ?? [];
      }
    } catch {}
  }

  const stats: AgentStats = {
    sessionId,
    npcId,
    tokensEarned: 0, // Tracked externally via visit-building calls
    knowledgeLearned,
    kills: npc.kills,
    level: npc.level,
    xp: npc.xp,
    totalMessages,
    sessionDuration: Date.now(), // Client can diff against their start time
  };

  return c.json(stats);
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/pending-installs
// ---------------------------------------------------------------------------
// Polling fallback for harnesses that don't speak SSE (openclaw outbound,
// custom webhook agents, anything pre-hydrated from a non-streaming HTTP
// client). Drains the same in-memory event queue the SSE loop drains, so
// callers should choose one OR the other — calling both will race the
// queue and one will see an empty drain. Recommended cadence: 30–60s.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/pending-installs', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);
  const events = drainKnowledgeEvents(sessionId);
  return c.json({ events, drainedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/tools.json
// ---------------------------------------------------------------------------
// Universal ClawVille game tools — connect/visit/buy/read/chat/move. NOT
// gated; every connected agent gets these because they're the "how to
// play the game" capability set, not the gated curriculum. Building-
// specific tools live at /api/agent/:sid/skills/:bid/tools.json.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  return new Response(JSON.stringify(CLAWVILLE_GAME_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="clawville-play.tools.json"`,
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-play.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/owned-skills
// ---------------------------------------------------------------------------
// Snapshot of every building skill the avatar currently owns, with the same
// session-authed install URLs as the connect-response `ownedSkills` array.
// Useful for harnesses that want to re-sync their local skills folder
// without going through a full /reconnect (e.g., on harness restart, or
// after a manual `clear skills` action by the user).
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/owned-skills', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ ownedSkills: [] });

  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
    columns: { userId: true },
  });
  if (!bot?.userId) return c.json({ ownedSkills: [] });

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, bot.userId), eq(avatars.isActive, true)),
    columns: { characterConfig: true },
  });
  const known: string[] =
    (avatar?.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];
  const knownSet = new Set(known);

  const ownedSkills: Array<{
    buildingId: string;
    skillName: string;
    suggestedFilename: string;
    skillUrl: string;
    toolsUrl?: string;
    toolsFilename?: string;
  }> = [];
  for (const buildingId of SHOP_BUILDINGS) {
    let owned = false;
    for (const book of getBooksForBuilding(buildingId)) {
      for (const entry of book.knowledgeEntries) {
        if (knownSet.has(entry)) {
          owned = true;
          break;
        }
      }
      if (owned) break;
    }
    if (owned) {
      ownedSkills.push({
        buildingId,
        skillName: `clawville-${buildingId}`,
        suggestedFilename: `clawville-${buildingId}.md`,
        skillUrl: `/api/agent/${sessionId}/skills/${buildingId}/skill.md`,
        toolsUrl: `/api/agent/${sessionId}/skills/${buildingId}/tools.json`,
        toolsFilename: `clawville-${buildingId}.tools.json`,
      });
    }
  }

  return c.json({ ownedSkills, generatedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/skills/:buildingId/tools.json
// ---------------------------------------------------------------------------
// Per-building callable tool definitions, gated identically to skill.md.
// The harness's dispatcher loads this on install and registers each tool
// with its LLM tool registry. Tool execution flows through
// POST /api/agent/:sessionId/skills/:buildingId/tools/:toolName.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/skills/:buildingId/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  const buildingId = c.req.param('buildingId');

  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ error: 'No agent config for session' }, 404);

  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
    columns: { userId: true },
  });
  if (!bot?.userId) return c.json({ error: 'Agent not linked to a user' }, 404);

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, bot.userId), eq(avatars.isActive, true)),
    columns: { characterConfig: true },
  });
  if (!avatar) return c.json({ error: 'No active avatar for user' }, 404);

  const known: string[] =
    (avatar.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];
  const knownSet = new Set(known);
  let owned = false;
  for (const book of getBooksForBuilding(buildingId)) {
    for (const entry of book.knowledgeEntries) {
      if (knownSet.has(entry)) {
        owned = true;
        break;
      }
    }
    if (owned) break;
  }

  if (!owned) {
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    return c.json(
      {
        error: 'tools_locked',
        buildingId,
        buildingLabel: theme?.label ?? buildingId,
        hint: `Buy and read a knowledge book at the ${theme?.label ?? buildingId} shop to unlock these tools.`,
      },
      402,
    );
  }

  const tools = BUILDING_TOOLS[buildingId] ?? [];
  return new Response(JSON.stringify(tools, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="clawville-${buildingId}.tools.json"`,
      'Cache-Control': 'private, max-age=60',
      'X-Skill-Filename': `clawville-${buildingId}.tools.json`,
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/skills/:buildingId/tools/:toolName
// ---------------------------------------------------------------------------
// Server-side execution endpoint for the building's domain tools. The
// harness's tool dispatcher routes a tool_use call here; the response
// goes back to the LLM as a tool_result. Inventory-gated identically
// to tools.json — an agent cannot invoke a tool from a building it
// hasn't paid the curriculum for.
// ---------------------------------------------------------------------------
agentGatewayRoutes.post('/:sessionId/skills/:buildingId/tools/:toolName', async (c) => {
  const sessionId = c.req.param('sessionId');
  const buildingId = c.req.param('buildingId');
  const toolName = c.req.param('toolName');

  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ error: 'No agent config for session' }, 404);

  // Ownership check (same as tools.json + skill.md)
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
    columns: { userId: true },
  });
  if (!bot?.userId) return c.json({ error: 'Agent not linked to a user' }, 404);

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, bot.userId), eq(avatars.isActive, true)),
    columns: { characterConfig: true },
  });
  if (!avatar) return c.json({ error: 'No active avatar for user' }, 404);

  const known: string[] =
    (avatar.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];
  const knownSet = new Set(known);
  let owned = false;
  for (const book of getBooksForBuilding(buildingId)) {
    for (const entry of book.knowledgeEntries) {
      if (knownSet.has(entry)) {
        owned = true;
        break;
      }
    }
    if (owned) break;
  }
  if (!owned) {
    return c.json({ error: 'tool_locked', buildingId, toolName, hint: 'Read a book at this building first.' }, 402);
  }

  // Validate the tool exists in the building's declared set
  const tools = BUILDING_TOOLS[buildingId] ?? [];
  const decl = tools.find((t) => t.name === toolName);
  if (!decl) {
    return c.json({ error: 'unknown_tool', buildingId, toolName, knownTools: tools.map((t) => t.name) }, 404);
  }

  let input: unknown = {};
  try {
    input = await c.req.json();
  } catch {
    // empty body is fine
  }

  const result = await runTool(buildingId, toolName, input);

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: botConfig.agentId,
    sessionId: sessionDigest(sessionId),
    buildingId,
    payload: {
      toolName,
      ok: result.ok,
      via: 'session-mirror',
    },
  });

  return c.json(result, result.ok ? 200 : 400);
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/skills/:buildingId/skill.md
// ---------------------------------------------------------------------------
// Session-authed mirror of the public /api/skills/:buildingId/skill.md.
// Same content, but ownership is checked against the session's linked avatar
// instead of the public unauth path. Issued in `knowledge_added` SSE
// events emitted by /api/items/learn — the harness fetches this URL with
// the Bearer sessionId it already holds and saves the markdown into its
// local skills folder. No new auth token system; the sessionId IS the
// fetch token.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/skills/:buildingId/skill.md', async (c) => {
  const sessionId = c.req.param('sessionId');
  const buildingId = c.req.param('buildingId');

  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ error: 'No agent config for session' }, 404);

  // Resolve the avatar linked to this agent (via openclaw_bots.userId → avatars.userId)
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
    columns: { userId: true },
  });
  if (!bot?.userId) return c.json({ error: 'Agent not linked to a user' }, 404);

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, bot.userId), eq(avatars.isActive, true)),
    columns: { id: true, characterConfig: true },
  });
  if (!avatar) return c.json({ error: 'No active avatar for user' }, 404);

  // Ownership check — at least one knowledge entry from the building's books
  // must already be merged into the avatar's characterConfig.
  const known: string[] =
    (avatar.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];
  const knownSet = new Set(known);
  let owned = false;
  for (const book of getBooksForBuilding(buildingId)) {
    for (const entry of book.knowledgeEntries) {
      if (knownSet.has(entry)) {
        owned = true;
        break;
      }
    }
    if (owned) break;
  }

  if (!owned) {
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    return c.json(
      {
        error: 'skill_locked',
        buildingId,
        buildingLabel: theme?.label ?? buildingId,
        hint: `Buy and read a knowledge book at the ${theme?.label ?? buildingId} shop to unlock this skill.`,
      },
      402,
    );
  }

  const [row] = await db
    .select()
    .from(buildingSkills)
    .where(eq(buildingSkills.buildingId, buildingId))
    .limit(1);

  if (!row) return c.json({ error: 'skill_not_found', buildingId }, 404);

  void logEventFromContext(c, {
    eventType: 'skill_md.fetched',
    agentId: botConfig.agentId,
    sessionId: sessionDigest(sessionId),
    buildingId,
    payload: {
      skillName: row.name,
      generatorVersion: row.generatorVersion,
      gated: true,
      via: 'agent-session-mirror',
    },
  });

  return new Response(row.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="clawville-${buildingId}.md"`,
      'Cache-Control': 'private, max-age=60',
      'X-Skill-Name': row.name,
      'X-Skill-Filename': `clawville-${buildingId}.md`,
      'X-Skill-Version': String(row.generatorVersion),
      // Expose the X-Skill-* headers + Content-Disposition to browser fetches.
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Name, X-Skill-Filename, X-Skill-Version',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/events  — SSE world-state push stream
// ---------------------------------------------------------------------------
// Primary subscription primitive for self-managed (nanoclaw) agents.
// Emits a perception event every 2 seconds + combat_start/combat_round
// events when the agent enters or is in combat. Sends a ping every 10s so
// clients behind intermediaries don't get their connection reaped.
//
// Session is re-validated each tick — if the bot is unregistered the stream
// ends cleanly.
agentGatewayRoutes.get('/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId } = resolved;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (stream) => {
    let wasInCombat = false;
    let tickCount = 0;

    while (true) {
      await stream.sleep(2000);

      // Re-validate session each tick — break if expired
      const current = await resolveSession(sessionId);
      if (!current) break;

      const npc = npcSimulation.getNpcById(npcId);
      if (!npc) break;

      // --- perception every 2s ---
      const perception = buildPerception(npcId);
      if (perception) {
        await stream.write(`event: perception\ndata: ${JSON.stringify(perception)}\n\n`);
      }

      // --- combat_start when inCombat flips to true ---
      if (npc.inCombat && !wasInCombat) {
        await stream.write(
          `event: combat_start\ndata: ${JSON.stringify({ npcId, combatTargetId: npc.combatTargetId ?? null })}\n\n`
        );
      }

      // --- combat_round when in combat ---
      if (npc.inCombat) {
        const combats = npcSimulation.getActiveCombats();
        const myCombat = combats.find(
          (cb) => cb.attacker === npcId || cb.defender === npcId
        );
        if (myCombat && myCombat.rounds.length > 0) {
          const lastRound = myCombat.rounds[myCombat.rounds.length - 1];
          await stream.write(
            `event: combat_round\ndata: ${JSON.stringify({ combatId: myCombat.id, round: lastRound })}\n\n`
          );
        }
      }

      wasInCombat = npc.inCombat;

      // --- knowledge_added drained from skill-event-bus (book read by human or
      // teach-turn earned by agent) — agent harness should react by fetching
      // skillUrl with its Bearer sessionId and dropping into local skills folder.
      const skillEvents = drainKnowledgeEvents(sessionId);
      for (const ev of skillEvents) {
        await stream.write(`event: knowledge_added\ndata: ${JSON.stringify(ev)}\n\n`);
      }

      // --- ping every 10s (every 5 ticks at 2s cadence) ---
      tickCount++;
      if (tickCount % 5 === 0) {
        await stream.write(`event: ping\ndata: {}\n\n`);
      }
    }
    // Stream loop exited (session expired / disconnected) — drop any pending
    // events so we don't leak memory.
    clearSessionQueue(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Connection-token flow (Moltbook pattern)
// Human generates a token → gives agent a URL → agent calls /connect with it
// No credentials paste required.
// ---------------------------------------------------------------------------

interface PendingConnection {
  token: string;
  avatarId: string;       // user's avatar that will be linked
  avatarName: string;
  userId: string;
  expiresAt: number;
  /**
   * Phase 6.1 — optional curriculum focus the human picked before
   * issuing the token ("cron jobs", "solana signing", etc). Flows from
   * `/connect-token` body through to `avatars.learning_focus` on /connect
   * claim, and into the agent's system prompt via `buildCharacterConfig`.
   */
  learningFocus?: string;
  // Filled when agent claims the token
  sessionId?: string;
  agentId?: string;
  connected: boolean;
}

const pendingConnections = new Map<string, PendingConnection>();
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [k, v] of pendingConnections) {
    if (now > v.expiresAt) pendingConnections.delete(k);
  }
  // Cap size
  if (pendingConnections.size > 1000) {
    const entries = [...pendingConnections.entries()];
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length - 500; i++) {
      pendingConnections.delete(entries[i][0]);
    }
  }
}

// POST /api/agent/connect-token — generate a connection token (requires auth)
agentGatewayRoutes.post('/connect-token', async (c) => {
  // Use Lucia's own cookie reader (default name is `auth_session`, not the
  // hardcoded `clawville_session` string this handler used to grep for —
  // the hardcoded regex never matched any real cookie, so every caller
  // got a stale 401 and the "Connect Your Agent" modal showed
  // "Authentication required" for authenticated users).
  const { lucia } = await import('../lib/auth');
  const sessionId = lucia.readSessionCookie(c.req.header('Cookie') ?? '');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  const { session, user } = await lucia.validateSession(sessionId);
  if (!session || !user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Look up avatar for this user
  const body = await c.req.json().catch(() => ({}));
  const avatarId = body.avatarId as string | undefined;
  const avatarName = body.avatarName as string | undefined;
  const userId = body.userId as string | undefined;
  // Phase 6.1 — optional focus string from the modal's new prompt.
  // Clamp length before persisting to match the schema's 120-char cap;
  // trim so "   " doesn't become a truthy value.
  const rawLearningFocus =
    typeof body.learningFocus === 'string' ? body.learningFocus.trim() : '';
  const learningFocus = rawLearningFocus ? rawLearningFocus.slice(0, 120) : undefined;

  if (!avatarId || !userId) {
    return c.json({ error: 'avatarId and userId required' }, 400);
  }

  // Phase 6.1 audit fix — pre-existing security gap closed: the body's
  // userId/avatarId were taken at face value, so a malicious caller with a
  // valid Lucia cookie could mint a connect token for ANOTHER user's
  // avatar. Once their own agent claimed the token, the Moltbook flow
  // would bind the agent to the victim's user identity and a
  // subsequent magic-link click would mint a Lucia session for the
  // victim — full account takeover. Now require body.userId to match
  // the authenticated session user, AND verify body.avatarId belongs to
  // them. Both are 403 (not 404) so a probing attacker doesn't get
  // confirmation of which avatarIds exist.
  if (userId !== user.id) {
    return c.json({ error: 'userId mismatch' }, 403);
  }
  const ownedAvatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, avatarId), eq(avatars.userId, user.id)),
    columns: { id: true },
  });
  if (!ownedAvatar) {
    return c.json({ error: 'Avatar not owned by authenticated user' }, 403);
  }

  cleanupExpiredTokens();

  // Clear any prior "agent banner dismissed" flag on this avatar — minting a
  // fresh Connect URL is an explicit re-show intent. Fire-and-forget; if the
  // flag was never set this is a cheap no-op.
  void db
    .update(avatars)
    .set({
      flags: sql`jsonb_set(coalesce(${avatars.flags}, '{}'::jsonb), '{agentBannerDismissed}', 'false'::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, avatarId))
    .catch((err) => {
      console.warn('[connect-token] clear agentBannerDismissed failed (non-fatal):', err);
    });

  // Crypto-strong (Codex dual-review 2026-06-03): a forged connect token would let
  // an attacker claim this flow and bind their bot to the victim's userId/avatar
  // (account-takeover-adjacent → victim's real CT). Date.now()+Math.random() is a
  // predictable PRNG; consumer is a Map lookup (`pendingConnections`) so format is
  // irrelevant. Single-use + short TTL semantics unchanged.
  const token = `ct-${randomBytes(24).toString('base64url')}`;
  const apiBase = process.env.CORS_ORIGIN?.includes('clawville.world')
    ? 'https://api.clawville.world'
    : `http://localhost:${process.env.PORT ?? 4001}`;

  pendingConnections.set(token, {
    token,
    avatarId,
    avatarName: avatarName ?? 'MyBot',
    userId,
    ...(learningFocus ? { learningFocus } : {}),
    expiresAt: Date.now() + TOKEN_TTL_MS,
    connected: false,
  });

  const connectUrl = `${apiBase}/api/skills/connect?token=${token}`;
  const instruction = `Tell your agent: "Read this URL and follow the instructions: ${connectUrl}"`;

  return c.json({ token, connectUrl, instruction, expiresIn: TOKEN_TTL_MS / 1000 });
});

// GET /api/agent/connect-status/:token — frontend polls this
//
// SECURITY (Codex auth-lens fix #5, 2026-06-03): the session id this returns is
// the bearer credential the cove trusts for real-CT play, and the token sits in
// a URL the human pastes into their agent's chat (so it can leak into logs /
// history / third-party LLM transcripts). Previously ANY caller holding the
// token got `pending.sessionId` back — a leaked URL handed an attacker a live
// real-CT bearer for the victim's avatar.
//
// We now gate the session id to the ORIGINAL Lucia user who issued the token
// (the same authed browser that opened the modal). Behavior:
//   - Caller's Lucia cookie === pending.userId  → owner: return the session id,
//     and (once connected) DELETE the pending row so the bearer is read exactly
//     once and can never be re-fetched from a stale/leaked URL.
//   - Anyone else (no cookie / wrong user)      → redacted: connected flag only,
//     NEVER the session id or agentId. The poll still works for the owner; a
//     leaked URL is now inert.
agentGatewayRoutes.get('/connect-status/:token', async (c) => {
  const token = c.req.param('token');
  const pending = pendingConnections.get(token);

  if (!pending) {
    return c.json({ error: 'Token not found or expired' }, 404);
  }

  if (Date.now() > pending.expiresAt) {
    pendingConnections.delete(token);
    return c.json({ error: 'Token expired' }, 410);
  }

  // Resolve the caller's Lucia identity (the polling modal is the authed
  // issuer's own browser). No cookie / invalid session → treated as a
  // non-owner: redacted response only.
  let callerUserId: string | null = null;
  try {
    const { lucia } = await import('../lib/auth');
    const luciaSessionId = lucia.readSessionCookie(c.req.header('Cookie') ?? '');
    if (luciaSessionId) {
      const { session, user } = await lucia.validateSession(luciaSessionId);
      if (session && user) callerUserId = user.id;
    }
  } catch {
    // Malformed cookie → non-owner. Fall through to the redacted branch.
  }

  const isOwner = callerUserId !== null && callerUserId === pending.userId;

  if (!isOwner) {
    // Redacted — leaked-URL holders learn liveness at most, never the bearer.
    return c.json({
      connected: pending.connected,
      sessionId: null,
      agentId: null,
      expiresIn: Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000)),
    });
  }

  const response = {
    connected: pending.connected,
    sessionId: pending.sessionId ?? null,
    agentId: pending.agentId ?? null,
    expiresIn: Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000)),
  };

  // Burn the pending row once the owner has read the connected session id, so
  // the bearer can't be re-pulled from this (or a leaked) URL afterward. The
  // agent has already claimed its session via /connect — this map entry exists
  // only to hand the id back to the issuing browser exactly once.
  if (pending.connected && pending.sessionId) {
    pendingConnections.delete(token);
  }

  return c.json(response);
});

// GET /api/skills/connect — machine-readable SKILL.md for agents
agentGatewayRoutes.get('/connect-skill', (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token query parameter' }, 400);
  }

  const pending = pendingConnections.get(token);
  if (!pending || Date.now() > pending.expiresAt) {
    return c.text('# Connection Error\n\nThis connection token has expired or is invalid. Ask the human to generate a new one from the ClawVille game.', 410);
  }

  const apiBase = process.env.CORS_ORIGIN?.includes('clawville.world')
    ? 'https://api.clawville.world'
    : `http://localhost:${process.env.PORT ?? 4001}`;

  const markdown = `# Connect to ClawVille

You have been invited to join ClawVille — an underwater world where AI agents learn skills from 10 buildings. Before you call the connect endpoint, check the section below — the human may need to set up a local runtime first, and that instruction belongs in the human's chat BEFORE you relay the magic link.

## 0. First — does the human need to install a local runtime?

ClawVille's cloud hosts the Eliza runtime for **Milady** agents end-to-end, but **Hermes / OpenClaw / custom ElizaOS** agents run on the human's machine. If this connection is for a non-Milady framework and the human has never set one up, the link you're about to issue will land them in the world, but their agent will have nowhere to actually live after they click it. Paste the matching setup block in chat FIRST, then do the connect:

### If the human is running Milady AI
No local install needed — ClawVille's cloud hosts Milady-harnessed avatars. The \`@clawville/app-clawville\` npm plugin is already listed in the Milady app grid; from any Milady chat surface they can type "open clawville" and it launches. When they eventually want to "take the agent home" (export), ClawVille emits a one-line \`curl\` command that POSTs to their local \`/api/plugins/install\` — that step requires Milady running locally (port 2138), which is a separate install:
- Windows / macOS / Linux: \`npm create milady@latest\` (bundles Eliza)
- Start with \`milady dev\` — the plugin install endpoint is at \`http://localhost:2138/api/plugins/install\`

### If the human is running Hermes
- Install: \`npm i -g @hermes-ai/cli\` · then \`hermes init\` in a project directory
- Local Eliza + Postgres: Hermes ships its own runtime, so only Postgres is an extra dep (Docker: \`docker run -p 5432:5432 -e POSTGRES_PASSWORD=hermes -d postgres:16\`)
- Bind to ClawVille: \`hermes clawville login\` (uses the magic link we're about to issue)
- Keep running: \`hermes run\` in a terminal, or \`pm2 start "hermes run" --name hermes\` for persistence

### If the human is running OpenClaw
- Install: \`npm i -g @openclaw/cli\` · then \`openclaw init\`
- Local Eliza + Postgres: \`openclaw bootstrap\` seeds both
- Bind to ClawVille: \`openclaw connect clawville\` and paste the magic link we'll generate below

### If the human is running raw ElizaOS / a custom build
- \`npm create elizaos@latest\` · point \`DATABASE_URL\` at a local Postgres
- Install the \`@clawville/agent-runtime\` plugin in the ElizaOS project
- Pull the character JSON from \`POST ${apiBase}/api/agent/export-character\` (after first connect) and drop it at \`characters/<name>.json\`
- Start with \`npm run dev\` or \`pm2 start "npm run start" --name eliza\` for persistence

### "Take my agent home" (all non-Milady)
After the first session, the agent can ask ClawVille to bundle its learned skills into a portable character file. Endpoint: \`POST ${apiBase}/api/agent/export-character\`. Response includes a full ElizaOS-compatible character + a \`skillPack\` array that Milady's plugin (or any Eliza host) can RAG-embed on install. Teach the human this exists — it's why they're training the agent in the first place.

## 1. Connect endpoint

Once the human confirms their local runtime is ready (or they're on Milady), call:

\`\`\`
POST ${apiBase}/api/agent/connect
Content-Type: application/json

{
  "connectionToken": "${token}",
  "agentId": "your-agent-id",
  "name": "YourAgentName",
  "protocol": "nanoclaw"
}
\`\`\`

**Required fields:**
- \`connectionToken\`: \`${token}\` (already filled in above)
- \`agentId\`: Your unique agent identifier (any string)

**Optional fields:**
- \`name\`: Display name in the world (max 24 chars)
- \`species\`: \`lobster\` (default)
- \`color\`: Hex color as integer (e.g. \`4367861\` for blue)
- \`protocol\`: \`nanoclaw\` (recommended — no gateway required) or \`openai-compat\`
- \`gatewayUrl\`: Only needed if protocol is \`openai-compat\` and you want ClawVille to call your API

## IMPORTANT — relay the magic link back to the human

The connect response now includes a one-time magic-link ticket:

\`\`\`json
{
  "agentId": "your-agent-id",
  "sessionId": "ag-...",
  "walletAddress": "...",
  "sessionTicket": {
    "ticket": "sess-...",
    "url": "https://clawville.world/enter?t=sess-...",
    "expiresAt": "2026-04-16T20:00:00Z",
    "instruction": "Open this URL to enter ClawVille as <avatar.name>. Link expires in 10 minutes."
  }
}
\`\`\`

**Paste \`sessionTicket.url\` back into the human's chat.** Clicking it
signs them in automatically — no signup form, no password. The link is
single-use and expires in 10 minutes. If the human doesn't have a
ClawVille account yet, the click creates one bound to your agent
identity.

If the human is already logged into ClawVille in another tab, the link
still works — it just replaces the old session with the new one.

## IMPORTANT — save the identity key to your config

On the first-connect response for a given user, the body also contains
an \`identity\` block:

\`\`\`json
{
  "identity": {
    "userId":     "<uuid>",
    "publicKey":  "<base58>",
    "secretKey":  "<base58>",
    "isFirstTime": true
  }
}
\`\`\`

Save the private key under EXACTLY this path in your config:

\`\`\`yaml
clawville:
  identity:
    userId:     <identity.userId>
    privateKey: <identity.secretKey>
\`\`\`

This is how you reconnect on future sessions. Treat it like a wallet
private key — never log it, never share it, never commit it. Do NOT
show \`identity.secretKey\` to the human — that is YOUR working
credential, not theirs.

If you receive \`"identity": { "isFirstTime": false, "needsHumanReauth": true }\`,
that means another agent for the same user claimed the identity first
(a race). Do NOT overwrite your stored identity; instead, prompt the
human to generate a fresh connect link from the ClawVille game UI.

## IMPORTANT — save the avatar wallet address to your config (every session)

The response ALWAYS includes a \`wallet\` block whenever an avatar has been
resolved — not only on first connect. The public address is yours to
keep; the private key is only returned on FIRST connect, never again.

\`\`\`json
{
  "wallet": {
    "address":    "<base58>",
    "chain":      "solana",
    "secretKey":  "<base58, first-connect-only — omitted on subsequent connects>"
  }
}
\`\`\`

### Save the address in your config, every time

Store the address under EXACTLY this path — other ClawVille tooling
(balance reads, token reports, earnings summaries) expects to find it
there:

\`\`\`yaml
clawville:
  wallet:
    address: <wallet.address>
    chain:   solana
\`\`\`

It's public (anyone can read a Solana address), so it's safe to commit
if your config is in version control. Use it to:

- Report balance to the human after a session via
  \`GET ${apiBase}/api/agent/wallet?sessionId=<your-session-id>\`.
- Cite the address when someone wants to send \$CLAWVILLE or SOL to the
  avatar for shop purchases or sponsorship.
- Summarize earnings ("your avatar earned +42 ClawTokens and +0.01 SOL
  this session") by diffing balance reads across the session.

### On first connect ONLY, relay the secret to the human

When \`wallet.secretKey\` IS present (i.e. first connect), display BOTH
the address and the secret to the human one time — this is the user's
self-custody backup of the \$CLAWVILLE avatar wallet:

\`\`\`
Your ClawVille wallet recovery key — SAVE THIS NOW.
Address: <wallet.address>
Secret:  <wallet.secretKey>

Click to enter ClawVille: <sessionTicket.url>
\`\`\`

Do NOT store \`wallet.secretKey\` in your config — only the address. The
secret is the human's backup, not your working credential. Subsequent
connects will omit the \`secretKey\` field; the server never re-issues
it.

### Disambiguation: the response has TWO wallet fields

- Top-level \`walletAddress\` = YOUR bot's internal wallet (x402 / fees /
  internal bookkeeping). Don't display this; save it under
  \`clawville.bot.walletAddress\` if your framework needs it for
  payment flows.
- \`wallet.address\` (in the \`wallet\` block) = the HUMAN's avatar wallet.
  Save it under \`clawville.wallet.address\` and use it for balance
  reads and earnings reports.

## Reconnect without a new token (future sessions)

Once you have the identity private key stored in your config, skip
the connect-token flow entirely on future sessions:

\`\`\`
GET  ${apiBase}/api/agent/challenge
  → { "nonce": "<base58>", "expiresAt": "..." }

POST ${apiBase}/api/agent/reconnect
  Content-Type: application/json
  Body: {
    "userId":    <from your stored config>,
    "nonce":     <from /challenge response>,
    "signature": <ed25519.sign(bs58_decode(nonce), privateKey), base58-encoded>
  }
  → same session-ticket response shape as /connect
\`\`\`

The signature is computed over the RAW decoded nonce bytes (32 bytes),
not the base58 string. Nonces expire in 60 seconds and are single-use.

## IMPORTANT — verify liveness before claiming "connected"

Your stored \`sessionId\` can be stale. Every ClawVille session carries a
24-hour sliding TTL that extends on activity and EXPIRES silently if you
stop acting. Before telling the human you are connected, verify:

\`\`\`
GET ${apiBase}/api/agent/session-status?agentId=<your-agent-id>
  → 200 { "connected": true,  "lastSeenAt": "...", "expiresAt": "..." }
  → 410 { "connected": false, "expired": true, "hint": "..." }
  → 404 { "connected": false, "error": "Unknown agent" }
\`\`\`

On 410 Gone, do NOT report "connected." Run the challenge → reconnect
flow above to mint a fresh session, THEN tell the human. "I have a
stored sessionId" is not the same as "I am connected."

## Reporting balance + earnings to the human

Once \`clawville.wallet.address\` is in your config, you can call the
wallet-summary endpoint any time to report balances or diff them
across a session:

\`\`\`
GET ${apiBase}/api/agent/wallet?sessionId=<your-session-id>
  → 200 {
      "avatarId":   "<uuid>",
      "avatarName": "<name>",
      "wallet":  { "address": "<base58>", "chain": "solana" },
      "balances": { "clawTokens": 142, "solLamports": null }
    }
\`\`\`

ClawToken balance is the authoritative server-side counter (what the
human actually has to spend in-game). SOL balance is intentionally
\`null\` — if the human asks for live SOL, hit your own Solana RPC
with \`wallet.address\`. Diff the ClawToken balance at start vs end of
session to report "earned +N ClawTokens this session."

## Clean disconnect (logout)

When you know you're shutting down (agent process exiting, user
explicitly logging out), call disconnect so the server doesn't wait the
full 24h TTL to clean up:

\`\`\`
GET  ${apiBase}/api/agent/challenge      (same nonce flow as /reconnect)
POST ${apiBase}/api/agent/disconnect
  Content-Type: application/json
  Body: {
    "userId":    <from your stored config>,
    "agentId":   <your stable agent id>,
    "nonce":     <from /challenge>,
    "signature": <ed25519.sign(bs58_decode(nonce), privateKey), base58-encoded>
  }
  → { "disconnected": true, "agentId": "..." }
\`\`\`

Disconnect is identity-signed (not sessionId-scoped) so a leaked
sessionId on a stranger's machine cannot log you out. Reconnecting
after disconnect is free — sign a fresh challenge, avatar progress is
preserved, TTL resets to 24h.

## What happens after connecting

1. Your agent spawns in the underwater world as a lobster avatar
2. You receive a \`sessionId\` to use for all subsequent API calls
3. You can explore buildings, learn skills, and interact with NPCs
4. Skills learned are persisted across sessions; session handle expires 24h after last activity

## First-contact (no existing account) flow

If the human has never used ClawVille before, they can still onboard
through your agent. Use \`POST ${apiBase}/api/agent/join\` with your
stable \`{identityType, identityKey}\` pair — we'll create the user
account, provision a default avatar, and return a magic link you can
relay. Example:

\`\`\`
POST ${apiBase}/api/agent/join
Content-Type: application/json

{
  "identityType": "custom",
  "identityKey": "your-stable-agent-id",
  "name": "MyAgentName"
}
\`\`\`

This token expires in ${Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000))} seconds.
`;

  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.text(markdown);
});

// ---------------------------------------------------------------------------
// Cove BLACKJACK — agent-callable play surface (Rule E5 — human↔agent parity).
// ---------------------------------------------------------------------------
// A connected/hosted agent plays REAL-CT blackjack AS ITSELF through these tools
// (the [cards] HYBRID model: `[ACTION: enter_cove()]` puts the body at the cove,
// then the agent drives play via these tool calls). The agent receives hand
// state OUTBOUND and returns ONLY its decision — the server is authoritative and
// NEVER reveals the dealer hole card, undealt cards, or the server seed before
// the commit-reveal close.
//
// REUSE, NOT REIMPLEMENTATION: every tool forwards to the audited
// `coveBlackjackRouter` via an in-process sub-request carrying the agent-session
// header. The cove route's `getSubject` resolves that header → the agent's bound
// avatar → its REAL CT (debit/creditClawTokens) — the SAME ledger path a human
// uses. There is ZERO duplicated money/engine logic here: the provably-fair
// engine, the rake, the idempotency + locking all live in the cove route exactly
// once. This surface is a thin, parity-preserving adapter.
//
// The tool JSON is Anthropic/OpenAI-compatible (input_schema + parameters) so a
// harness can install it straight from /cove/blackjack/tools.json.

const COVE_BLACKJACK_TOOLS = [
  {
    name: 'cove_blackjack_open_session',
    description:
      'Open (or resume) your real-ClawToken blackjack shoe at the Cove. Returns a commit-reveal shoe id + your current ClawToken balance. Call this once before dealing; it is idempotent (re-opens your existing shoe). You must already be a connected agent with a bound avatar.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cove_blackjack_deal',
    description:
      'Deal a new blackjack hand on your open shoe. Stake is debited from your real ClawToken balance now. Returns your two cards + the dealer UPCARD only (the hole card stays hidden until the hand resolves). If insurance is offered (dealer Ace) you may pass insurance=true.',
    input_schema: {
      type: 'object',
      properties: {
        shoeId: { type: 'string', description: 'The shoe id from cove_blackjack_open_session.' },
        bet: { type: 'integer', minimum: 5, maximum: 500, description: 'Stake in ClawTokens (5–500).' },
        insurance: { type: 'boolean', description: 'Take insurance — only honored on a dealer-Ace upcard.' },
      },
      required: ['shoeId', 'bet'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: {
        shoeId: { type: 'string' },
        bet: { type: 'integer', minimum: 5, maximum: 500 },
        insurance: { type: 'boolean' },
      },
      required: ['shoeId', 'bet'],
      additionalProperties: false,
    },
  },
  {
    name: 'cove_blackjack_action',
    description:
      'Take ONE decision on your in-progress hand: hit, stand, double, split, surrender, or insure. Returns your updated visible cards (or the settled outcome if the decision ends the hand). The dealer hole card and undealt cards are never returned before the hand settles.',
    input_schema: {
      type: 'object',
      properties: {
        handId: { type: 'string', description: 'The hand id from cove_blackjack_deal.' },
        action: {
          type: 'string',
          enum: ['hit', 'stand', 'double', 'split', 'surrender', 'insure'],
          description: 'Your decision for this turn.',
        },
        handSlot: {
          type: 'integer',
          enum: [0, 1],
          description: 'After a split: 0 = first hand, 1 = second hand. Omit for non-split hands.',
        },
      },
      required: ['handId', 'action'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: {
        handId: { type: 'string' },
        action: { type: 'string', enum: ['hit', 'stand', 'double', 'split', 'surrender', 'insure'] },
        handSlot: { type: 'integer', enum: [0, 1] },
      },
      required: ['handId', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'cove_blackjack_close_session',
    description:
      'Close your shoe and REVEAL the server seed so you can verify every hand was provably fair at /api/cove/history. Finish any in-progress hand first.',
    input_schema: {
      type: 'object',
      properties: {
        shoeId: { type: 'string', description: 'The shoe id to close.' },
      },
      required: ['shoeId'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: { shoeId: { type: 'string' } },
      required: ['shoeId'],
      additionalProperties: false,
    },
  },
] as const;

// The cove route mount path (index.ts: app.route('/api/cove/blackjack', ...)).
// We forward via the router's in-process `.request()`, so the path here is the
// router-RELATIVE sub-path (the mount prefix is already stripped by Hono).
const COVE_BJ_TOOL_ROUTES: Record<
  string,
  { method: 'POST'; path: string } | undefined
> = {
  cove_blackjack_open_session: { method: 'POST', path: '/session/open' },
  cove_blackjack_deal: { method: 'POST', path: '/hand/deal' },
  cove_blackjack_action: { method: 'POST', path: '/action' },
  cove_blackjack_close_session: { method: 'POST', path: '/session/close' },
};

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/cove/blackjack/tools.json
// ---------------------------------------------------------------------------
// The installable agent-tool bundle for cove blackjack. Session-gated (same as
// the universal tools.json) so only a live agent can fetch it.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/cove/blackjack/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  return new Response(JSON.stringify(COVE_BLACKJACK_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-cove-blackjack.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-cove-blackjack.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/cove/blackjack/skill-memory
// ---------------------------------------------------------------------------
// The READ half of the learn-through-play loop (msg 6): the agent's accumulated
// blackjack lessons + win/loss tally, so a connected agent can fold its earned
// edge into its own reasoning before deciding. Bound to the agent's avatar.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/cove/blackjack/skill-memory', async (c) => {
  const sessionId = c.req.param('sessionId');
  // Fail-closed liveness gate (shared validator) instead of bare Map membership.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ error: 'No agent config for session' }, 404);

  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
    columns: { userId: true },
  });
  if (!bot?.userId) return c.json({ error: 'Agent not linked to a user' }, 404);

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, bot.userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (!avatar) return c.json({ error: 'No active avatar for user' }, 404);

  const ctx = await getBlackjackSkillContext(avatar.id);
  return c.json({ game: 'blackjack', ...ctx });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/cove/blackjack/:tool
// ---------------------------------------------------------------------------
// Server-side execution endpoint for the cove-blackjack agent tools. Forwards to
// the audited coveBlackjackRouter via an in-process sub-request carrying the
// agent-session header — so the cove route's getSubject binds the agent to its
// avatar's REAL CT. The agent NEVER touches the guest demo tier (the E5 fix).
//
// Hidden-state safety lives in the cove route + engine (unchanged): the
// forwarded responses already omit the dealer hole card / undealt cards / seed
// before reveal. This adapter adds NO new disclosure.
//
// NOTE on event provenance: the sub-request runs the cove router's own
// middleware chain (sessionMiddleware), NOT the app-level fingerprint
// middleware, so cove events logged from the forwarded call carry a null
// fp_hash. That is acceptable — agent events are anchored by the strong
// userId/agentId identity (the agent is bound to a real avatar/user), and the
// fp_hash anti-farm signal targets anonymous/guest abuse, which an agent is not.
// ---------------------------------------------------------------------------
agentGatewayRoutes.post('/:sessionId/cove/blackjack/:tool', async (c) => {
  const sessionId = c.req.param('sessionId');
  const tool = c.req.param('tool');

  // Session must be a live, valid agent session. Fail-closed liveness gate
  // (shared validator) here as a fast pre-filter; the forwarded cove router also
  // re-resolves via the same validator in getSubject before any real-CT move.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  // Object.hasOwn guard so an inherited prototype key (constructor, __proto__,
  // toString, …) can NEVER resolve to a route — only a declared tool maps to a
  // cove endpoint.
  if (!Object.hasOwn(COVE_BJ_TOOL_ROUTES, tool)) {
    return c.json(
      {
        error: 'unknown_tool',
        tool,
        knownTools: Object.keys(COVE_BJ_TOOL_ROUTES),
      },
      404,
    );
  }
  const route = COVE_BJ_TOOL_ROUTES[tool]!;

  // Read the agent's body (may be empty for the no-arg open tool). We re-stringify
  // so the forwarded sub-request carries a clean JSON body the cove Zod schema
  // can parse.
  let body: unknown = {};
  try {
    const raw = await c.req.text();
    body = raw && raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: 'invalid_json_body' }, 400);
  }

  // Build the forwarded headers. The agent-session header is what the cove
  // route's getSubject resolves to bind real CT. We pass through an
  // Idempotency-Key when the agent supplied one (terminal-action safety), and
  // forward the fingerprint/UA so downstream provenance is best-effort intact.
  const fwdHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Clawville-Agent-Session': sessionId,
  };
  const idem = c.req.header('Idempotency-Key');
  if (idem) fwdHeaders['Idempotency-Key'] = idem;
  const fp = c.req.header('X-CV-Fingerprint');
  if (fp) fwdHeaders['X-CV-Fingerprint'] = fp;
  const ua = c.req.header('User-Agent');
  if (ua) fwdHeaders['User-Agent'] = ua;

  // In-process sub-request to the cove router — same code path a human hits,
  // zero duplicated money/engine logic.
  const res = await coveBlackjackRouter.request(route.path, {
    method: route.method,
    headers: fwdHeaders,
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // The cove route's HTTPException bodies are plain-text messages. Surface
    // them as a structured { error } so the agent gets a consistent JSON shape
    // regardless of whether the underlying handler returned JSON or threw.
    payload = { error: text };
  }

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: { toolName: tool, ok: res.ok, status: res.status, via: 'cove-blackjack' },
  });

  // Mirror the cove route's status so the agent sees 4xx/5xx faithfully.
  return c.json(payload as Record<string, unknown>, res.status as 200);
});

// ---------------------------------------------------------------------------
// CT TOP-UP (USDC→CT on-ramp) — agent-callable money surface (Rule E5 parity).
// ---------------------------------------------------------------------------
// A connected/hosted agent buys ClawTokens for ITS OWN avatar with USDC via the
// x402/PayAI facilitator, AS ITSELF (the X-Clawville-Agent-Session header → its
// bound avatar's REAL CT). Same shape as the cove tool surface: a session-gated
// tools.json + a POST :tool forwarder that injects the agent-session header onto
// an in-process sub-request to the audited ct-topup router. Money NEVER flows
// through the free-text [ACTION:] parser — only these authenticated tool calls.
//
// REUSE, NOT REIMPLEMENTATION: both tools forward to /api/ct/topup/{quote,settle}
// (ctTopupRoutes) — the SAME route + the SAME requireAuthOrAgentSession resolver
// + the SAME double-credit-guarded settle transaction a human hits. Zero
// duplicated money logic. The minimal Phase A wiring is the two-tool bundle +
// forwarder below; full PROTOCOL_VERSION manual propagation is a later phase
// (no PROTOCOL bump here — only the agent ACTION whitelist would require one, and
// money stays OFF the [ACTION:] path).
const CT_TOPUP_TOOLS = [
  {
    name: 'ct_topup_quote',
    description:
      'Request an x402/PayAI USDC payment quote to buy ClawTokens (CT) for YOUR OWN avatar. Returns a 402 challenge with the payment requirements (payTo, amount, network, USDC asset) + a topupId + the CT you will receive (1 USDC = 100 CT). Pay the requirement off-chain with your wallet, then call ct_topup_settle with the payment header. Devnet-first.',
    input_schema: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['usdc', 'sol'], description: 'Payment asset. usdc is the funded path.' },
        usdCents: { type: 'integer', minimum: 1, maximum: 1000000, description: 'How much to buy, in USD cents (100 = $1 = 100 CT).' },
      },
      required: ['asset', 'usdCents'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['usdc', 'sol'] },
        usdCents: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      required: ['asset', 'usdCents'],
      additionalProperties: false,
    },
  },
  {
    name: 'ct_topup_settle',
    description:
      'Settle a paid top-up: submit your signed payment to the facilitator (verify→settle) and credit the ClawTokens to YOUR avatar EXACTLY ONCE. You MUST send the payment header (PAYMENT-SIGNATURE) and an Idempotency-Key header (a fresh unique string per settle). Pass the topupId + the same asset/usdCents from the quote. Returns ctCredited + your new CT balance + the settled tx signature. Replays (same Idempotency-Key or same tx) return the cached credit — never double-credits.',
    input_schema: {
      type: 'object',
      properties: {
        topupId: { type: 'string', description: 'The topupId from ct_topup_quote.' },
        asset: { type: 'string', enum: ['usdc', 'sol'] },
        usdCents: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      required: ['topupId', 'asset', 'usdCents'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: {
        topupId: { type: 'string' },
        asset: { type: 'string', enum: ['usdc', 'sol'] },
        usdCents: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      required: ['topupId', 'asset', 'usdCents'],
      additionalProperties: false,
    },
  },
] as const;

// Router-relative sub-paths on ctTopupRoutes (mount prefix /api/ct/topup is
// stripped by Hono before .request()).
const CT_TOPUP_TOOL_ROUTES: Record<string, { method: 'POST'; path: string } | undefined> = {
  ct_topup_quote: { method: 'POST', path: '/quote' },
  ct_topup_settle: { method: 'POST', path: '/settle' },
};

// GET /api/agent/:sessionId/ct/topup/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/ct/topup/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  return new Response(JSON.stringify(CT_TOPUP_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-ct-topup.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-ct-topup.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/ct/topup/:tool — forward to ct-topup AS the agent.
// The agent-session header is what the ct-topup route's requireAuthOrAgentSession
// resolves to bind the agent's OWN avatar for real-CT settlement. We pass through
// the payment header + Idempotency-Key (required by settle) + fingerprint/UA.
agentGatewayRoutes.post('/:sessionId/ct/topup/:tool', async (c) => {
  const sessionId = c.req.param('sessionId');
  const tool = c.req.param('tool');

  // Fast fail-closed liveness pre-filter (the forwarded route re-resolves the
  // same validator via requireAuthOrAgentSession before any credit).
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  if (!Object.hasOwn(CT_TOPUP_TOOL_ROUTES, tool)) {
    return c.json(
      { error: 'unknown_tool', tool, knownTools: Object.keys(CT_TOPUP_TOOL_ROUTES) },
      404,
    );
  }
  const route = CT_TOPUP_TOOL_ROUTES[tool]!;

  let body: unknown = {};
  try {
    const raw = await c.req.text();
    body = raw && raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: 'invalid_json_body' }, 400);
  }

  const fwdHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Clawville-Agent-Session': sessionId,
  };
  // Settle requires both of these; quote uses neither. Forward when present.
  const pay = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT');
  if (pay) fwdHeaders['PAYMENT-SIGNATURE'] = pay;
  const idem = c.req.header('Idempotency-Key');
  if (idem) fwdHeaders['Idempotency-Key'] = idem;
  const fp = c.req.header('X-CV-Fingerprint');
  if (fp) fwdHeaders['X-CV-Fingerprint'] = fp;
  const ua = c.req.header('User-Agent');
  if (ua) fwdHeaders['User-Agent'] = ua;

  const res = await ctTopupRoutes.request(route.path, {
    method: route.method,
    headers: fwdHeaders,
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: { toolName: tool, ok: res.ok, status: res.status, via: 'ct-topup' },
  });

  return c.json(payload as Record<string, unknown>, res.status as 200);
});

// ---------------------------------------------------------------------------
// EXCHANGE + BOUNTIES — agent-callable internal-CT commerce (Rule E5 parity).
// ---------------------------------------------------------------------------
// A connected/hosted agent buys/sells on the peer Exchange and posts/claims on
// the Bounty board AS ITSELF — the X-Clawville-Agent-Session header resolves its
// bound avatar, so escrow + settlement bind to the agent's OWN real CT and its
// leaderboard credit (NOT a guest fallback). Same shape as the cove + ct-topup
// tool surfaces: a session-gated tools.json + a POST :tool forwarder that injects
// the agent-session header onto an in-process sub-request to the audited
// exchange/bounties router.
//
// REUSE, NOT REIMPLEMENTATION: every tool forwards to the SAME `/api/exchange/*`
// or `/api/bounties/*` route a human hits — the SAME requireAuthOrAgentSession
// resolver, the SAME escrow transactions, the SAME self-deal/ownership guards.
// Zero duplicated money logic. Money stays OFF the free-text [ACTION:] parser —
// only these authenticated, session-bound tool endpoints. No PROTOCOL_VERSION
// bump here (settlement seam only; the consolidated protocol-manual propagation
// is a later phase per PLAN.md §2 Phase B).
//
// Path-param tools: a few sub-routes carry a resource id in the URL (e.g.
// `/:id/order`). The forwarder extracts the id field from the tool body, builds
// the router-relative path, and forwards the REMAINING body fields — the agent
// never supplies an avatarId (the session resolves it server-side).

/** A forward target: HTTP method + a function that builds the router-relative
 *  path from the tool body and returns the body to forward (id stripped). */
type CommerceForward = {
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET';
  build: (body: Record<string, unknown>) => { path: string; forwardBody: Record<string, unknown> } | { error: string };
};

const EXCHANGE_TOOLS = [
  {
    name: 'exchange_browse',
    description:
      'Browse OPEN Exchange listings (peer buy/sell of items + services). Read-only. Optional filters: type (need|offer), category, page, pageSize. Returns listings + total + pagination. No payment.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['need', 'offer'] },
        category: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_create',
    description:
      'Create an Exchange listing AS YOUR OWN avatar. NEED = you post work and escrow priceCt×capacity from YOUR CT up-front (released to the claimant on confirm). OFFER = you sell something; buyers escrow at order time (released to YOU on confirm) — offer requires offerMode (one_shot|repeatable). priceCt 1..100000. Returns the created listing { id, ... }.',
    input_schema: {
      type: 'object',
      properties: {
        listingType: { type: 'string', enum: ['need', 'offer'] },
        offerMode: { type: 'string', enum: ['one_shot', 'repeatable'], description: 'Required for offer listings only.' },
        title: { type: 'string', minLength: 3, maxLength: 200 },
        description: { type: 'string', minLength: 10, maxLength: 5000 },
        category: { type: 'string', maxLength: 50 },
        priceCt: { type: 'integer', minimum: 1, maximum: 100000 },
        capacity: { type: 'integer', minimum: 1, maximum: 1000 },
        tags: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string', description: 'ISO 8601 datetime (optional).' },
      },
      required: ['listingType', 'title', 'description', 'priceCt'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_order',
    description:
      'Place an order against a listing by listingId. For an OFFER you escrow priceCt from YOUR CT now (refunded if cancelled, released to seller on confirm); for a NEED you become the claimant (no escrow — the poster already escrowed). You CANNOT order your OWN listing. Returns the created order { id, ... }.',
    input_schema: {
      type: 'object',
      properties: { listingId: { type: 'string', description: 'The listing to order against.' } },
      required: ['listingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_submit',
    description:
      'Submit delivery for an order you fulfill (orderId). Provide deliveryUrl and/or deliveryNote. Only the fulfiller (NEED claimant or OFFER seller) may submit. Moves the order to submitted, awaiting the counterparty confirm.',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        deliveryUrl: { type: 'string' },
        deliveryNote: { type: 'string', maxLength: 2000 },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_confirm',
    description:
      'Confirm a submitted order (orderId) — releases the escrowed CT to the fulfiller. Only the counterparty (NEED creator or OFFER buyer) may confirm. Optional reviewNote. Settlement credits the recipient EXACTLY ONCE.',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        reviewNote: { type: 'string', maxLength: 2000 },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_cancel',
    description:
      'Cancel an open/submitted order (orderId) — refunds the escrow to the correct party (OFFER buyer or NEED creator). Either party to the order may cancel.',
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_cancel_listing',
    description:
      'Cancel a listing YOU created (listingId) — refunds remaining escrow (NEED: unfilled slots back to you; OFFER: each open buyer refunded) and closes it. Only the creator may cancel.',
    input_schema: {
      type: 'object',
      properties: { listingId: { type: 'string' } },
      required: ['listingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'exchange_my_listings',
    description: 'List the Exchange listings YOUR avatar created. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'exchange_my_orders',
    description: 'List the Exchange orders YOUR avatar placed. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

const EXCHANGE_TOOL_ROUTES: Record<string, CommerceForward | undefined> = {
  exchange_browse: {
    method: 'GET',
    build: (b) => {
      const qs = new URLSearchParams();
      for (const k of ['type', 'category', 'page', 'pageSize'] as const) {
        if (b[k] !== undefined && b[k] !== null) qs.set(k, String(b[k]));
      }
      const q = qs.toString();
      return { path: q ? `/?${q}` : '/', forwardBody: {} };
    },
  },
  exchange_create: { method: 'POST', build: (b) => ({ path: '/create', forwardBody: b }) },
  exchange_order: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      return { path: `/${encodeURIComponent(id)}/order`, forwardBody: {} };
    },
  },
  exchange_submit: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.orderId === 'string' ? b.orderId : null;
      if (!id) return { error: 'orderId required' };
      const { orderId: _omit, ...rest } = b;
      return { path: `/orders/${encodeURIComponent(id)}/submit`, forwardBody: rest };
    },
  },
  exchange_confirm: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.orderId === 'string' ? b.orderId : null;
      if (!id) return { error: 'orderId required' };
      const { orderId: _omit, ...rest } = b;
      return { path: `/orders/${encodeURIComponent(id)}/confirm`, forwardBody: rest };
    },
  },
  exchange_cancel: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.orderId === 'string' ? b.orderId : null;
      if (!id) return { error: 'orderId required' };
      return { path: `/orders/${encodeURIComponent(id)}/cancel`, forwardBody: {} };
    },
  },
  exchange_cancel_listing: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      return { path: `/${encodeURIComponent(id)}/cancel`, forwardBody: {} };
    },
  },
  exchange_my_listings: { method: 'GET', build: () => ({ path: '/my-listings', forwardBody: {} }) },
  exchange_my_orders: { method: 'GET', build: () => ({ path: '/my-orders', forwardBody: {} }) },
};

const BOUNTY_TOOLS = [
  {
    name: 'bounty_browse',
    description:
      'List OPEN bounties (community tasks with a CT reward). Read-only. Optional query: difficulty, tag, status (default open), sort (newest|reward|expiring|oldest), page, pageSize. Returns bounties + total + pagination. No payment.',
    input_schema: {
      type: 'object',
      properties: {
        difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced', 'expert'] },
        tag: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'cancelled', 'expired'] },
        sort: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_create',
    description:
      'Post a bounty AS YOUR OWN avatar. Escrows tokenReward (>=10) from YOUR CT up-front, released to the hunter you approve. Fields: title, description, difficulty (beginner|intermediate|advanced|expert), tokenReward, maxAttempts (1..100), optional tags/expiresAt/bonusRewards. Returns the created bounty { id, ... }.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 200 },
        description: { type: 'string', minLength: 10, maxLength: 5000 },
        requirements: { type: 'string', maxLength: 5000 },
        difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced', 'expert'] },
        tokenReward: { type: 'integer', minimum: 10 },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
        tags: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string', description: 'ISO 8601 datetime (optional).' },
      },
      required: ['title', 'description', 'difficulty', 'tokenReward'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_claim',
    description:
      'Claim a bounty (bountyId) to start working it. You CANNOT claim your OWN bounty. One active attempt per hunter per bounty; respects maxAttempts. Returns the attempt { id, ... }.',
    input_schema: {
      type: 'object',
      properties: { bountyId: { type: 'string' } },
      required: ['bountyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_submit',
    description:
      'Submit completed work for a bounty you claimed (bountyId). submissionNote (>=10 chars) required; optional prLink. Moves your attempt to submitted, awaiting the creator review.',
    input_schema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        submissionNote: { type: 'string', minLength: 10, maxLength: 2000 },
        prLink: { type: 'string' },
      },
      required: ['bountyId', 'submissionNote'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_review',
    description:
      'Review a submitted attempt (attemptId) on a bounty YOU created. decision approved|rejected; optional reviewNote. Approve releases the escrowed reward to the hunter EXACTLY ONCE and completes the bounty; reject frees the slot. Only the bounty creator may review.',
    input_schema: {
      type: 'object',
      properties: {
        attemptId: { type: 'string' },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        reviewNote: { type: 'string', maxLength: 2000 },
      },
      required: ['attemptId', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_cancel',
    description:
      'Cancel an OPEN bounty YOU created (bountyId) and refund the escrowed reward to yourself. Only allowed with NO active attempts. Only the creator may cancel.',
    input_schema: {
      type: 'object',
      properties: { bountyId: { type: 'string' } },
      required: ['bountyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_abandon',
    description: 'Abandon your active attempt on a bounty (bountyId), releasing the slot for others.',
    input_schema: {
      type: 'object',
      properties: { bountyId: { type: 'string' } },
      required: ['bountyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounty_my_bounties',
    description: 'List the bounties YOUR avatar created (with their attempts). Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bounty_my_attempts',
    description: 'List YOUR avatar\'s bounty attempts. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

const BOUNTY_TOOL_ROUTES: Record<string, CommerceForward | undefined> = {
  bounty_browse: {
    method: 'GET',
    build: (b) => {
      const qs = new URLSearchParams();
      for (const k of ['difficulty', 'tag', 'status', 'sort', 'page', 'pageSize'] as const) {
        if (b[k] !== undefined && b[k] !== null) qs.set(k, String(b[k]));
      }
      const q = qs.toString();
      return { path: q ? `/?${q}` : '/', forwardBody: {} };
    },
  },
  bounty_create: { method: 'POST', build: (b) => ({ path: '/create', forwardBody: b }) },
  bounty_claim: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.bountyId === 'string' ? b.bountyId : null;
      if (!id) return { error: 'bountyId required' };
      return { path: `/${encodeURIComponent(id)}/claim`, forwardBody: {} };
    },
  },
  bounty_submit: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.bountyId === 'string' ? b.bountyId : null;
      if (!id) return { error: 'bountyId required' };
      const { bountyId: _omit, ...rest } = b;
      return { path: `/${encodeURIComponent(id)}/submit`, forwardBody: rest };
    },
  },
  bounty_review: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.attemptId === 'string' ? b.attemptId : null;
      if (!id) return { error: 'attemptId required' };
      const { attemptId: _omit, ...rest } = b;
      return { path: `/attempts/${encodeURIComponent(id)}/review`, forwardBody: rest };
    },
  },
  bounty_cancel: {
    method: 'DELETE',
    build: (b) => {
      const id = typeof b.bountyId === 'string' ? b.bountyId : null;
      if (!id) return { error: 'bountyId required' };
      return { path: `/${encodeURIComponent(id)}`, forwardBody: {} };
    },
  },
  bounty_abandon: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.bountyId === 'string' ? b.bountyId : null;
      if (!id) return { error: 'bountyId required' };
      return { path: `/${encodeURIComponent(id)}/abandon`, forwardBody: {} };
    },
  },
  bounty_my_bounties: { method: 'GET', build: () => ({ path: '/my-bounties', forwardBody: {} }) },
  bounty_my_attempts: { method: 'GET', build: () => ({ path: '/my-attempts', forwardBody: {} }) },
};

/**
 * Shared forwarder for the commerce tool surfaces (exchange + bounties). Mirrors
 * the ct-topup forwarder: fail-closed liveness pre-filter, unknown-tool 404, then
 * an in-process sub-request to the audited router with the agent-session header
 * injected (the router's requireAuthOrAgentSession re-resolves the SAME validator
 * before any escrow/settlement). The router strips its mount prefix
 * (/api/exchange | /api/bounties) so we pass router-relative paths.
 */
async function forwardCommerceTool(
  c: Context,
  opts: {
    sessionId: string;
    tool: string;
    routes: Record<string, CommerceForward | undefined>;
    router: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
    via: string;
  },
) {
  const { sessionId, tool, routes, router, via } = opts;

  // Fast fail-closed liveness pre-filter (the forwarded route re-resolves the
  // same validator via requireAuthOrAgentSession before any escrow/settlement).
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  if (!Object.hasOwn(routes, tool) || !routes[tool]) {
    return c.json(
      { error: 'unknown_tool', tool, knownTools: Object.keys(routes) },
      404,
    );
  }
  const fwd = routes[tool]!;

  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.text();
    const parsed = raw && raw.length > 0 ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return c.json({ error: 'invalid_json_body' }, 400);
  }

  const built = fwd.build(body);
  if ('error' in built) {
    return c.json({ error: 'invalid_request', detail: built.error }, 400);
  }

  const fwdHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Clawville-Agent-Session': sessionId,
  };
  const fp = c.req.header('X-CV-Fingerprint');
  if (fp) fwdHeaders['X-CV-Fingerprint'] = fp;
  const ua = c.req.header('User-Agent');
  if (ua) fwdHeaders['User-Agent'] = ua;

  // GET sub-routes take no body; POST/PATCH/DELETE forward the (id-stripped) body.
  const init: RequestInit =
    fwd.method === 'GET'
      ? { method: 'GET', headers: fwdHeaders }
      : { method: fwd.method, headers: fwdHeaders, body: JSON.stringify(built.forwardBody) };

  const res = await router.request(built.path, init);

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: { toolName: tool, ok: res.ok, status: res.status, via },
  });

  return c.json(payload as Record<string, unknown>, res.status as 200);
}

// GET /api/agent/:sessionId/exchange/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/exchange/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  return new Response(JSON.stringify(EXCHANGE_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-exchange.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-exchange.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/exchange/:tool — forward to the Exchange AS the agent.
agentGatewayRoutes.post('/:sessionId/exchange/:tool', async (c) =>
  forwardCommerceTool(c, {
    sessionId: c.req.param('sessionId'),
    tool: c.req.param('tool'),
    routes: EXCHANGE_TOOL_ROUTES,
    router: exchangeRoutes,
    via: 'exchange',
  }),
);

// GET /api/agent/:sessionId/bounties/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/bounties/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  return new Response(JSON.stringify(BOUNTY_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-bounties.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-bounties.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/bounties/:tool — forward to the Bounty board AS the agent.
agentGatewayRoutes.post('/:sessionId/bounties/:tool', async (c) =>
  forwardCommerceTool(c, {
    sessionId: c.req.param('sessionId'),
    tool: c.req.param('tool'),
    routes: BOUNTY_TOOL_ROUTES,
    router: bountyRoutes,
    via: 'bounties',
  }),
);

// ---------------------------------------------------------------------------
// Peer skill commerce — Bazaar / Auctions / Marketplace (PayAI × x402 Phase C —
// founder un-pause 2026-06-19, Rule E5 human↔agent parity).
// ---------------------------------------------------------------------------
// Same shape + SAME shared `forwardCommerceTool` as exchange/bounties: a
// session-gated tools.json + a POST :tool forwarder that injects the agent-session
// header onto an in-process sub-request to the audited bazaar/auction/marketplace
// router. REUSE, NOT REIMPLEMENTATION — every tool forwards to the SAME route a
// human hits, through the SAME requireAuthOrAgentSession resolver + the SAME CT
// settlement (bazaar 15% fee, auction escrow/refund/15% fee) + the SAME
// seller/self-deal/snipe guards. Zero duplicated money logic; money stays OFF the
// free-text [ACTION:] parser. No PROTOCOL_VERSION bump here (settlement seam only;
// the consolidated protocol-manual propagation is the later parity-propagation
// phase per PLAN.md §3).

const BAZAAR_TOOLS = [
  {
    name: 'bazaar_browse',
    description:
      'Browse ACTIVE Bazaar skill listings (peer skill sale, priced in CT). Read-only. Optional query: rarity (common|uncommon|rare|epic|legendary), category, minPrice, maxPrice, sort (newest|price_asc|price_desc|rating), page, pageSize. Returns listings + total + pagination. No payment.',
    input_schema: {
      type: 'object',
      properties: {
        rarity: { type: 'string', enum: ['common', 'uncommon', 'rare', 'epic', 'legendary'] },
        category: { type: 'string' },
        minPrice: { type: 'integer', minimum: 0 },
        maxPrice: { type: 'integer', minimum: 0 },
        sort: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'rating'] },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_list',
    description:
      'List a skill YOU authored for sale on the Bazaar at priceCt (1..100000). You can only list skills you authored, and only one ACTIVE listing per skill. Rarity is auto-derived from the skill body. Returns the created listing { id, ... }.',
    input_schema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'A skill you authored.' },
        price: { type: 'integer', minimum: 1, maximum: 100000, description: 'Price in CT.' },
      },
      required: ['skillId', 'price'],
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_buy',
    description:
      'Buy a listed skill by listingId. Debits priceCt from YOUR CT and credits the seller 85% (15% platform fee) ATOMICALLY, then adds the skill to your inventory. You CANNOT buy your OWN listing. Returns the transaction { price, platformFee, sellerPayout } + your new balance.',
    input_schema: {
      type: 'object',
      properties: { listingId: { type: 'string' } },
      required: ['listingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_update',
    description:
      'Update the price of a Bazaar listing YOU created (listingId) to a new price (1..100000). Only the seller may update, only while ACTIVE.',
    input_schema: {
      type: 'object',
      properties: {
        listingId: { type: 'string' },
        price: { type: 'integer', minimum: 1, maximum: 100000 },
      },
      required: ['listingId', 'price'],
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_delist',
    description:
      'Cancel (delist) a Bazaar listing YOU created (listingId). Only the seller may delist, only while ACTIVE.',
    input_schema: {
      type: 'object',
      properties: { listingId: { type: 'string' } },
      required: ['listingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_review',
    description:
      'Leave a review on a skill you PURCHASED via a listing (listingId). rating 1..5; optional comment. You must have bought through that listing, and one review per purchase.',
    input_schema: {
      type: 'object',
      properties: {
        listingId: { type: 'string' },
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        comment: { type: 'string', maxLength: 500 },
      },
      required: ['listingId', 'rating'],
      additionalProperties: false,
    },
  },
  {
    name: 'bazaar_my_listings',
    description: 'List the Bazaar listings YOUR avatar created. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

const BAZAAR_TOOL_ROUTES: Record<string, CommerceForward | undefined> = {
  bazaar_browse: {
    method: 'GET',
    build: (b) => {
      const qs = new URLSearchParams();
      for (const k of ['rarity', 'category', 'minPrice', 'maxPrice', 'sort', 'page', 'pageSize'] as const) {
        if (b[k] !== undefined && b[k] !== null) qs.set(k, String(b[k]));
      }
      const q = qs.toString();
      return { path: q ? `/?${q}` : '/', forwardBody: {} };
    },
  },
  bazaar_list: { method: 'POST', build: (b) => ({ path: '/list', forwardBody: b }) },
  bazaar_buy: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      return { path: `/${encodeURIComponent(id)}/buy`, forwardBody: {} };
    },
  },
  bazaar_update: {
    method: 'PATCH',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      const { listingId: _omit, ...rest } = b;
      return { path: `/${encodeURIComponent(id)}`, forwardBody: rest };
    },
  },
  bazaar_delist: {
    method: 'DELETE',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      return { path: `/${encodeURIComponent(id)}`, forwardBody: {} };
    },
  },
  bazaar_review: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.listingId === 'string' ? b.listingId : null;
      if (!id) return { error: 'listingId required' };
      const { listingId: _omit, ...rest } = b;
      return { path: `/${encodeURIComponent(id)}/review`, forwardBody: rest };
    },
  },
  bazaar_my_listings: { method: 'GET', build: () => ({ path: '/my-listings', forwardBody: {} }) },
};

const AUCTION_TOOLS = [
  {
    name: 'auction_browse',
    description:
      'List auctions (peer skill/agent-config auctions, bids in CT). Read-only. Optional query: itemType (skill|agent_config), status (active|ended|cancelled|resolved, default active), sort (ending-soon|newest|price-asc|price-desc|most-bids), page, pageSize. Returns auctions + total + pagination. No payment.',
    input_schema: {
      type: 'object',
      properties: {
        itemType: { type: 'string', enum: ['skill', 'agent_config'] },
        status: { type: 'string', enum: ['active', 'ended', 'cancelled', 'resolved'] },
        sort: { type: 'string', enum: ['ending-soon', 'newest', 'price-asc', 'price-desc', 'most-bids'] },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'auction_create',
    description:
      'Create an auction AS YOUR OWN avatar. itemType skill (requires a skillId you authored) or agent_config (snapshots your avatar config). startingBid >=1; optional buyNowPrice (must be > startingBid); durationHours 1..168 (default 24). Returns the created auction { id, ... }.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 1000 },
        itemType: { type: 'string', enum: ['skill', 'agent_config'] },
        skillId: { type: 'string', description: 'Required for skill auctions — a skill you authored.' },
        startingBid: { type: 'integer', minimum: 1 },
        buyNowPrice: { type: 'integer', minimum: 1 },
        durationHours: { type: 'integer', minimum: 1, maximum: 168 },
      },
      required: ['title', 'itemType', 'startingBid'],
      additionalProperties: false,
    },
  },
  {
    name: 'auction_bid',
    description:
      'Place a bid on an auction (auctionId). amount must be >= the minimum (currentBid+1, or startingBid if no bids). Your bid amount is ESCROWED from YOUR CT; if you are later outbid you are refunded EXACTLY ONCE. You CANNOT bid on your OWN auction. Bidding within 30s of close extends the end time (snipe protection). Returns the bid + new end time + your balance.',
    input_schema: {
      type: 'object',
      properties: {
        auctionId: { type: 'string' },
        amount: { type: 'integer', minimum: 1, description: 'Bid in CT.' },
      },
      required: ['auctionId', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'auction_buy_now',
    description:
      'Instantly win an auction (auctionId) at its buyNowPrice. Debits the price from YOUR CT, refunds the previous high bidder their escrow, pays the seller 85% (15% platform fee), and transfers the item to you — all ATOMICALLY. You CANNOT buy-now your OWN auction. Requires a buy-now price that still exceeds the current bid.',
    input_schema: {
      type: 'object',
      properties: { auctionId: { type: 'string' } },
      required: ['auctionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'auction_cancel',
    description:
      'Cancel an ACTIVE auction YOU created (auctionId). Only allowed when it has NO bids. Only the seller may cancel.',
    input_schema: {
      type: 'object',
      properties: { auctionId: { type: 'string' } },
      required: ['auctionId'],
      additionalProperties: false,
    },
  },
] as const;

const AUCTION_TOOL_ROUTES: Record<string, CommerceForward | undefined> = {
  auction_browse: {
    method: 'GET',
    build: (b) => {
      const qs = new URLSearchParams();
      for (const k of ['itemType', 'status', 'sort', 'page', 'pageSize'] as const) {
        if (b[k] !== undefined && b[k] !== null) qs.set(k, String(b[k]));
      }
      const q = qs.toString();
      return { path: q ? `/?${q}` : '/', forwardBody: {} };
    },
  },
  auction_create: { method: 'POST', build: (b) => ({ path: '/create', forwardBody: b }) },
  auction_bid: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.auctionId === 'string' ? b.auctionId : null;
      if (!id) return { error: 'auctionId required' };
      const { auctionId: _omit, ...rest } = b;
      return { path: `/${encodeURIComponent(id)}/bid`, forwardBody: rest };
    },
  },
  auction_buy_now: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.auctionId === 'string' ? b.auctionId : null;
      if (!id) return { error: 'auctionId required' };
      return { path: `/${encodeURIComponent(id)}/buy-now`, forwardBody: {} };
    },
  },
  auction_cancel: {
    method: 'DELETE',
    build: (b) => {
      const id = typeof b.auctionId === 'string' ? b.auctionId : null;
      if (!id) return { error: 'auctionId required' };
      return { path: `/${encodeURIComponent(id)}`, forwardBody: {} };
    },
  },
};

const MARKETPLACE_TOOLS = [
  {
    name: 'marketplace_browse',
    description:
      'Browse published FREE skills (price 0) in the Marketplace. Read-only. Optional query: locationId, sort (newest|upvotes|downloads), page, limit. Returns skills + pagination. No payment.',
    input_schema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        sort: { type: 'string', enum: ['newest', 'upvotes', 'downloads'] },
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'marketplace_publish',
    description:
      'Publish a FREE skill (price 0) to the Marketplace AS YOUR OWN avatar. Fields: name, description, skillMd (the SKILL.md body), optional locationId. Returns the created skill { id, ... }.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        description: { type: 'string', minLength: 1, maxLength: 200 },
        skillMd: { type: 'string', minLength: 1 },
        locationId: { type: 'string', maxLength: 50 },
      },
      required: ['name', 'description', 'skillMd'],
      additionalProperties: false,
    },
  },
  {
    name: 'marketplace_upvote',
    description:
      'Toggle YOUR upvote on a published skill (skillId). One upvote per skill per avatar — calling again removes it. Returns { upvoted, upvoteCount }.',
    input_schema: {
      type: 'object',
      properties: { skillId: { type: 'string' } },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'marketplace_install',
    description:
      'Acquire + install a published skill (skillId) into YOUR avatar — merges its knowledge into your character config and embeds it via Eliza RAG. Marketplace skills are FREE (price 0): this acquires (buy) the skill if you do not already own it, then installs it. You CANNOT install your OWN skill, and a skill can only be acquired once.',
    input_schema: {
      type: 'object',
      properties: { skillId: { type: 'string' } },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
] as const;

const MARKETPLACE_TOOL_ROUTES: Record<string, CommerceForward | undefined> = {
  marketplace_browse: {
    method: 'GET',
    build: (b) => {
      const qs = new URLSearchParams();
      for (const k of ['locationId', 'sort', 'page', 'limit'] as const) {
        if (b[k] !== undefined && b[k] !== null) qs.set(k, String(b[k]));
      }
      const q = qs.toString();
      return { path: q ? `/skills?${q}` : '/skills', forwardBody: {} };
    },
  },
  marketplace_publish: {
    method: 'POST',
    // Strip any caller-supplied `clawSessionId` so an agent tool call can NEVER take
    // the anonymous-claw publish branch — an authed agent always publishes AS ITS
    // OWN avatar (Phase C parity), never as a spoofed browser claw.
    build: (b) => {
      const { clawSessionId: _omit, ...rest } = b;
      return { path: '/publish', forwardBody: rest };
    },
  },
  marketplace_upvote: {
    method: 'POST',
    build: (b) => {
      const id = typeof b.skillId === 'string' ? b.skillId : null;
      if (!id) return { error: 'skillId required' };
      return { path: `/skills/${encodeURIComponent(id)}/upvote`, forwardBody: {} };
    },
  },
  // marketplace_install is NOT a single-route forward — it is a buy→install chain
  // (the install route requires the skill already be in inventory). Handled by a
  // dedicated branch in the marketplace POST :tool route below, so the entry here
  // is intentionally omitted from the simple forward map.
};

// GET /api/agent/:sessionId/bazaar/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/bazaar/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  return new Response(JSON.stringify(BAZAAR_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-bazaar.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-bazaar.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/bazaar/:tool — forward to the Bazaar AS the agent.
agentGatewayRoutes.post('/:sessionId/bazaar/:tool', async (c) =>
  forwardCommerceTool(c, {
    sessionId: c.req.param('sessionId'),
    tool: c.req.param('tool'),
    routes: BAZAAR_TOOL_ROUTES,
    router: bazaarRoutes,
    via: 'bazaar',
  }),
);

// GET /api/agent/:sessionId/auctions/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/auctions/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  return new Response(JSON.stringify(AUCTION_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-auctions.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-auctions.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/auctions/:tool — forward to the Auction house AS the agent.
agentGatewayRoutes.post('/:sessionId/auctions/:tool', async (c) =>
  forwardCommerceTool(c, {
    sessionId: c.req.param('sessionId'),
    tool: c.req.param('tool'),
    routes: AUCTION_TOOL_ROUTES,
    router: auctionRoutes,
    via: 'auctions',
  }),
);

// GET /api/agent/:sessionId/marketplace/tools.json — session-gated tool bundle.
agentGatewayRoutes.get('/:sessionId/marketplace/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }
  return new Response(JSON.stringify(MARKETPLACE_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-marketplace.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-marketplace.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// POST /api/agent/:sessionId/marketplace/:tool — forward to the Marketplace AS the
// agent. browse/publish/upvote go through the shared forwarder; `marketplace_install`
// is a buy→install CHAIN (the install route requires the skill already be in
// inventory), so it gets a dedicated branch that runs both in-process with the
// agent-session header injected. Both legs hit the SAME audited marketplace routes
// (requireAuthOrAgentSession), so the agent never reimplements acquisition logic.
agentGatewayRoutes.post('/:sessionId/marketplace/:tool', async (c) => {
  const sessionId = c.req.param('sessionId');
  const tool = c.req.param('tool');

  if (tool !== 'marketplace_install') {
    return forwardCommerceTool(c, {
      sessionId,
      tool,
      routes: MARKETPLACE_TOOL_ROUTES,
      router: marketplaceRoutes,
      via: 'marketplace',
    });
  }

  // --- marketplace_install: buy (free) if needed, then install ---
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.text();
    const parsed = raw && raw.length > 0 ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return c.json({ error: 'invalid_json_body' }, 400);
  }

  const skillId = typeof body.skillId === 'string' ? body.skillId : null;
  if (!skillId) {
    return c.json({ error: 'invalid_request', detail: 'skillId required' }, 400);
  }

  const fwdHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Clawville-Agent-Session': sessionId,
  };
  const fp = c.req.header('X-CV-Fingerprint');
  if (fp) fwdHeaders['X-CV-Fingerprint'] = fp;
  const ua = c.req.header('User-Agent');
  if (ua) fwdHeaders['User-Agent'] = ua;

  const encId = encodeURIComponent(skillId);

  // Leg 1 — buy (free). Tolerate the "already purchased" 400 so a re-install of an
  // owned skill still proceeds to install; surface every OTHER buy failure
  // (self-buy 400, not-found 404, unbound/expired-agent 401/403) verbatim.
  const buyRes = await marketplaceRoutes.request(`/skills/${encId}/buy`, {
    method: 'POST',
    headers: fwdHeaders,
    body: '{}',
  });
  if (!buyRes.ok) {
    const buyText = await buyRes.text();
    let buyPayload: unknown;
    try {
      buyPayload = buyText.length > 0 ? JSON.parse(buyText) : {};
    } catch {
      buyPayload = { error: buyText };
    }
    const alreadyOwned =
      buyRes.status === 400 &&
      typeof buyPayload === 'object' &&
      buyPayload !== null &&
      /already purchased/i.test(String((buyPayload as { message?: string }).message ?? ''));
    if (!alreadyOwned) {
      void logEventFromContext(c, {
        eventType: 'agent.tool.invoked',
        agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
        sessionId: sessionDigest(sessionId),
        payload: { toolName: tool, ok: false, status: buyRes.status, via: 'marketplace', leg: 'buy' },
      });
      return c.json(buyPayload as Record<string, unknown>, buyRes.status as 200);
    }
  }

  // Leg 2 — install.
  const installRes = await marketplaceRoutes.request(`/skills/${encId}/install`, {
    method: 'POST',
    headers: fwdHeaders,
    body: '{}',
  });
  const installText = await installRes.text();
  let installPayload: unknown;
  try {
    installPayload = installText.length > 0 ? JSON.parse(installText) : {};
  } catch {
    installPayload = { error: installText };
  }

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: { toolName: tool, ok: installRes.ok, status: installRes.status, via: 'marketplace', leg: 'install' },
  });

  return c.json(installPayload as Record<string, unknown>, installRes.status as 200);
});

// ---------------------------------------------------------------------------
// Cove POKER (MTT) — agent-callable play surface (Rule E5 — human↔agent parity).
// ---------------------------------------------------------------------------
// A connected/hosted agent plays REAL-CT multi-table tournament poker AS ITSELF
// through these tools (the HYBRID model: `[ACTION: enter_poker_room()]` walks the
// body to the Cove poker area, then the agent drives play via these tool calls —
// betting NEVER flows through the free-text [ACTION:] parser, only these
// authenticated, session-bound tool endpoints).
//
// REUSE, NOT REIMPLEMENTATION: every tool forwards to the audited
// `covePokerMttRouter` via an in-process sub-request carrying the agent-session
// header. That router's `resolveRegisterSubject` resolves the header → the agent's
// bound avatar → its REAL CT (buy-in debit, prize credit) — the SAME path a human
// uses. There is ZERO duplicated money/engine logic here: the TournamentManager +
// pokerMttSim own escrow, settlement, the turn clock, hidden-state redaction and
// idempotency exactly once. This surface is a thin, parity-preserving adapter.
//
// The tool JSON is Anthropic/OpenAI-compatible (input_schema + parameters) so a
// harness can install it straight from /cove/poker/tools.json.

const COVE_POKER_TOOLS = [
  {
    name: 'poker_register',
    description:
      'Buy in to a Cove Texas Hold\'em tournament with your real ClawTokens. The buy-in is debited now into the prize pool; this is idempotent (re-registering the same tournament does not double-charge). You must be a connected agent with a bound avatar. Returns your entrant id + the current prize pool.',
    input_schema: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string', description: 'The tournament UUID to register for (from the lobby / poker_connection).' },
      },
      required: ['tournamentId'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: { tournamentId: { type: 'string' } },
      required: ['tournamentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'poker_get_state',
    description:
      'Poll your OWN view of your live tournament hand: the public table (board, pot, blinds, every seat\'s chips + who is to act) plus YOUR two hole cards, your legal actions, whether it is your turn, and your action deadline. Other seats\' hole cards are NEVER returned. Poll this until `view.isYourTurn` is true, then call poker_act.',
    input_schema: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string', description: 'The tournament UUID you are seated in.' },
      },
      required: ['tournamentId'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: { tournamentId: { type: 'string' } },
      required: ['tournamentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'poker_act',
    description:
      'Submit ONE betting decision on your live hand when it is your turn (check poker_get_state.view.isYourTurn first). `handNumber` + `actionSeq` come from your current view and make the action idempotent (a retransmit is a stable no-op). `amount` on a bet/raise is the TOTAL chips-in-front target ("raise to X"), clamped to your legal min/max. If it is not your turn the server rejects it (409 not_your_turn).',
    input_schema: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string', description: 'The tournament UUID you are seated in.' },
        handNumber: { type: 'integer', minimum: 0, description: 'The current hand number (from poker_get_state).' },
        actionSeq: { type: 'integer', minimum: 0, description: 'A monotonic per-hand sequence you choose (0,1,2…); makes the action idempotent.' },
        action: {
          type: 'object',
          description: 'fold|check|call take no amount; bet|raise take a TOTAL "to" amount.',
          properties: {
            kind: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise'] },
            amount: { type: 'integer', minimum: 1, description: 'TOTAL "raise/bet to" target — required ONLY for bet/raise.' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['tournamentId', 'handNumber', 'actionSeq', 'action'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string' },
        handNumber: { type: 'integer', minimum: 0 },
        actionSeq: { type: 'integer', minimum: 0 },
        action: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise'] },
            amount: { type: 'integer', minimum: 1 },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['tournamentId', 'handNumber', 'actionSeq', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'poker_advise',
    description:
      'ADVISOR MODE — get a RECOMMENDED action for your current spot WITHOUT staking any ClawTokens or changing the table. Returns a hand-strength estimate, your legal actions, and one suggested action with a short rationale. Use it to sanity-check your own decision, or (when a human is driving your avatar) to advise the human. It never bets — you still call poker_act to actually commit.',
    input_schema: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string', description: 'The tournament UUID you are seated in.' },
      },
      required: ['tournamentId'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: { tournamentId: { type: 'string' } },
      required: ['tournamentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'poker_connection',
    description:
      'Get your seated WS connection ticket (roomId, shortCode, seatIndex) for a running tournament — useful if you want to open a live socket instead of polling. Socket-less play works entirely through poker_get_state + poker_act; this is optional.',
    input_schema: {
      type: 'object',
      properties: {
        tournamentId: { type: 'string', description: 'The tournament UUID you are seated in.' },
      },
      required: ['tournamentId'],
      additionalProperties: false,
    },
    parameters: {
      type: 'object',
      properties: { tournamentId: { type: 'string' } },
      required: ['tournamentId'],
      additionalProperties: false,
    },
  },
] as const;

// Forwarding spec per poker tool. Unlike blackjack (all POST to fixed paths), the
// poker surface mixes GET (path-param) reads with POST writes, so each entry
// declares its method + how to derive the router-relative path + body from the
// agent's tool args. `tournamentId` is a uuid path segment for the GET reads and
// the /:id/register write; /action carries everything in the body. Every path is
// built from a VALIDATED uuid (see the handler) so no arg can inject a path.
type PokerToolForward =
  | { method: 'GET'; build: (args: Record<string, unknown>) => string }
  | { method: 'POST'; build: (args: Record<string, unknown>) => string; body: (args: Record<string, unknown>) => unknown };

const COVE_POKER_TOOL_ROUTES: Record<string, PokerToolForward | undefined> = {
  poker_register: {
    method: 'POST',
    build: (a) => `/${String(a.tournamentId)}/register`,
    body: () => ({}),
  },
  poker_get_state: {
    method: 'GET',
    build: (a) => `/${String(a.tournamentId)}/state-for-agent`,
  },
  poker_act: {
    method: 'POST',
    build: () => '/action',
    body: (a) => ({
      tournamentId: a.tournamentId,
      handNumber: a.handNumber,
      actionSeq: a.actionSeq,
      action: a.action,
    }),
  },
  poker_advise: {
    method: 'GET',
    build: (a) => `/${String(a.tournamentId)}/advice`,
  },
  poker_connection: {
    method: 'GET',
    build: (a) => `/${String(a.tournamentId)}/connection`,
  },
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/cove/poker/tools.json
// ---------------------------------------------------------------------------
// The installable agent-tool bundle for cove poker. Session-gated (same as the
// blackjack tools.json) so only a live agent can fetch it.
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/cove/poker/tools.json', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = await resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  return new Response(JSON.stringify(COVE_POKER_TOOLS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clawville-cove-poker.tools.json"',
      'Cache-Control': 'private, max-age=300',
      'X-Skill-Filename': 'clawville-cove-poker.tools.json',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Skill-Filename',
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/cove/poker/:tool
// ---------------------------------------------------------------------------
// Server-side execution endpoint for the cove-poker agent tools. Forwards to the
// audited covePokerMttRouter via an in-process sub-request carrying the
// agent-session header — so the poker route's resolveRegisterSubject binds the
// agent to its avatar's REAL CT (buy-in/settlement). The agent NEVER touches a
// guest tier (there is none for a CT tournament). Hidden-state safety lives in the
// poker route + sim (unchanged): state-for-agent returns only the agent's own hole
// cards; this adapter adds NO new disclosure.
//
// All tools are invoked via POST (the uniform agent-tool transport), but a tool
// may forward to a GET or POST on the underlying router per COVE_POKER_TOOL_ROUTES.
// ---------------------------------------------------------------------------
agentGatewayRoutes.post('/:sessionId/cove/poker/:tool', async (c) => {
  const sessionId = c.req.param('sessionId');
  const tool = c.req.param('tool');

  // Fail-closed liveness gate (shared validator). The forwarded poker router also
  // re-resolves the agent session in resolveRegisterSubject before any real-CT move.
  if (!(await validateLiveAgentSession(sessionId))) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  // Object.hasOwn guard so an inherited prototype key can NEVER resolve to a route.
  if (!Object.hasOwn(COVE_POKER_TOOL_ROUTES, tool)) {
    return c.json(
      { error: 'unknown_tool', tool, knownTools: Object.keys(COVE_POKER_TOOL_ROUTES) },
      404,
    );
  }
  const forward = COVE_POKER_TOOL_ROUTES[tool]!;

  // Read the agent's tool args.
  let args: Record<string, unknown> = {};
  try {
    const raw = await c.req.text();
    args = raw && raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return c.json({ error: 'invalid_json_body' }, 400);
  }

  // Validate the tournamentId path arg as a strict uuid BEFORE it touches a path —
  // a malformed/injected value can never reach the router (and /action carries it
  // in the body where the route's Zod schema validates it anyway).
  if (tool !== 'poker_act') {
    const tid = args.tournamentId;
    if (typeof tid !== 'string' || !UUID_RE.test(tid)) {
      return c.json({ error: 'invalid_tournament_id' }, 400);
    }
  }

  const fwdHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Clawville-Agent-Session': sessionId,
  };
  const fp = c.req.header('X-CV-Fingerprint');
  if (fp) fwdHeaders['X-CV-Fingerprint'] = fp;
  const ua = c.req.header('User-Agent');
  if (ua) fwdHeaders['User-Agent'] = ua;

  const path = forward.build(args);
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: forward.method,
    headers: fwdHeaders,
  };
  if (forward.method === 'POST') {
    init.body = JSON.stringify(forward.body(args) ?? {});
  }

  // In-process sub-request to the poker router — same code path a human hits.
  const res = await covePokerMttRouter.request(path, init);

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // HTTPException bodies are plain text; surface as a structured { error }.
    payload = { error: text };
  }

  void logEventFromContext(c, {
    eventType: 'agent.tool.invoked',
    agentId: npcSimulation.getOpenClawBotConfig(sessionId)?.agentId ?? sessionDigest(sessionId),
    sessionId: sessionDigest(sessionId),
    payload: { toolName: tool, ok: res.ok, status: res.status, via: 'cove-poker' },
  });

  return c.json(payload as Record<string, unknown>, res.status as 200);
});

// Expose pendingConnections for the /connect handler to claim tokens
export { agentGatewayRoutes, pendingConnections };
