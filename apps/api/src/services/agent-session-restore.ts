/**
 * Agent-session restart survival (2026-06-11).
 *
 * THE BUG: a connected agent's live session exists ONLY in npc-simulation's
 * in-memory `agentBotSessions` Map — the `ag-`/`oc-`/`hat-` bearer is never written
 * to disk. Every API deploy/restart rebuilds that Map empty, so the shared
 * `validateLiveAgentSession` gate map-missed and returned 404 "session not
 * found or expired" to the agent's owner the moment they typed in the chat bar.
 * The `openclaw_bots` ROW survives the restart (keyed by agent_id, carrying a
 * sliding 24h `session_expires_at` TTL), so the live session can be rebuilt FROM
 * THE ROW on first post-restart use, keeping the SAME bearer alive.
 *
 * HOW: every connect/register/patch persists `sha256Hex(sessionId)` into
 * `openclaw_bots.session_key_hash` (the one-way hash of the live bearer — NEVER
 * the raw bearer; a DB dump must not yield a spendable real-CT credential). On a
 * Map-miss the caller hands us the INCOMING bearer; we hash it, find the row by
 * that column (proving the caller holds the live id without it touching disk),
 * re-validate the TTL fail-closed, rebuild the in-memory `{config, client}` from
 * the row, and re-register it under the INCOMING sessionId (it hashed-matched,
 * so it IS the live bearer).
 *
 * FAIL-CLOSED CONTRACT (read this before touching anything — it is the cove
 * anti-resurrection contract that `validateLiveAgentSession` enforces, mirrored
 * here because restore is reached THROUGH that gate):
 *   - The row must exist (hash hit).
 *   - `session_expires_at` must be NON-NULL and STRICTLY in the future. A NULL
 *     or past TTL is EXPIRED → we restore NOTHING and do NOT clear the hash (the
 *     sweeper owns lifecycle; clearing it here would race the sweeper and could
 *     resurrect a reaped row). This is the SAME rule as `validateLiveAgentSession`
 *     so restore can never grant liveness the primary gate would refuse.
 *   - We NEVER mint a NEW sessionId, NEVER slide the TTL, NEVER grant ledger
 *     capability that wasn't already implied by the row. Restore re-binds an
 *     EXISTING live bearer to its surviving row; it is not a new connection.
 *
 * RESTORE MATRIX (which identity types can be rebuilt purely from the row):
 *   - hatcher (protocol 'hatcher-proxy'): row carries proxy_url + encrypted
 *     proxy_token_* → decrypt in-memory → buildHatcherClient. FULLY RESTORABLE
 *     including cognition. This is the live partner path, so it is the one that
 *     most needs to survive a restart.
 *   - nanoclaw: self-managed pull agent, no outbound gateway. The body + cove
 *     binding are all that matter. RESTORABLE.
 *   - milady / anonymous: no outbound gateway (chat routes via the server-side
 *     Eliza runtime for milady, or is a no-op stub). RESTORABLE as a body — its
 *     cove/leaderboard binding (the thing the human cares about) is intact.
 *   - hermes: self-managed pull agent, no caller-supplied gateway and no secrets
 *     on the row (D7, 2026-07-02). RESTORABLE via the same generic no-gateway
 *     path; the in-world protocol is RE-derived from the identityType at rebuild
 *     time ('hermes-local' when the host-it-for-me gate is on, else the fail-soft
 *     'nanoclaw'), NEVER read from the stored `protocol` column — the D1-fix
 *     pattern below applies to it verbatim.
 *
 *   D1 FIX (2026-06-12): the IN-WORLD wire protocol for these no-gateway types
 *   is derived from the AUTHORITATIVE `identity_type` via
 *   `resolveInWorldProtocol` (agent-session-config.ts), NOT the stored
 *   `protocol` column. nanoclaw/milady/anonymous resolve to the fail-soft
 *   'nanoclaw' protocol (`.chat()` returns '' with NO network call). The old
 *   code passed the row's stored 'openai-compat' straight through, so a
 *   restored anonymous/milady body POSTed to the dummy `http://localhost:0`
 *   gateway and 502'd ("Agent gateway error") on every autonomous NPC
 *   conversation tick. The same shared builder is used by the /connect + Hatcher
 *   MINT paths, so the rebuilt config is byte-identical to the original per
 *   identity type and cannot drift again (enforced by a deep-equality
 *   regression test).
 *   - openclaw / ironclaw / custom (EVERY real-gateway identity type): the row
 *     never persists `auth_token` (the bearer to the agent's own gateway), so we
 *     CANNOT rebuild a working outbound chat client — a restored body would
 *     silently 401 (a real gateway) or 502 against the dummy `http://localhost:0`
 *     (a legacy/malformed row with a null/dummy gatewayUrl). We therefore return
 *     null for ALL of these identity types UNCONDITIONALLY (graceful degradation
 *     — the agent reconnects, exactly the pre-fix behaviour), rather than spawn a
 *     half-dead body.
 *
 *   D2 FIX (#6, 2026-06-12): we gate on the IDENTITY TYPE, not on the gatewayUrl
 *     shape. The prior guard only refused real-gateway rows whose `gateway_url`
 *     was present + non-dummy, so a malformed legacy `openclaw`/`custom` row with
 *     a NULL/dummy gatewayUrl fell through and built a mute body pointing at
 *     `http://localhost:0` (the restored-mute-body class, the D1 bug's cousin).
 *
 * CONCURRENCY: two simultaneous post-restart chat calls for the same agent both
 * Map-miss and both reach restore. registerAgentBot is effectively idempotent by
 * sessionId (Map.set overwrites), but a DOUBLE override-register would throw
 * "already overridden" on the second. We guard with a per-agentId in-flight
 * promise so concurrent restores of the SAME agent coalesce onto one rebuild.
 */

import { and, eq } from 'drizzle-orm';
import { db, agentBots, avatars } from '@clawville/database';
import type { AgentSubstrateRegistration } from '@clawville/shared';
import { npcSimulation } from './npc-simulation';
import { AgentSubstrateClient } from './agent-substrate-client';
import { decryptToken } from './keypair-vault';
import { validateHatcherProxyUrl } from './hatcher-config';
import { sha256Hex, sessionDigest } from './session-digest';
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
  isRowRestorableFromIdentity,
  DEFAULT_HATCHER_HOME_X,
  DEFAULT_HATCHER_HOME_Y,
} from './agent-session-config';
import type { LiveAgentSession } from '../middleware/require-auth-or-agent';

const HATCHER_AGENT_PREFIX = 'hatcher:';

/** Strip the `hatcher:` namespace to recover the raw partner id for the proxy. */
function rawHatcherAgentId(namespacedAgentId: string): string {
  return namespacedAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? namespacedAgentId.slice(HATCHER_AGENT_PREFIX.length)
    : namespacedAgentId;
}

/**
 * In-flight restore promises keyed by agentId so two concurrent Map-misses for
 * the same agent coalesce onto ONE rebuild (prevents a double override-register
 * throw + duplicate body churn). Cleared in a finally so a failed restore can be
 * retried on the next call.
 */
const inFlightRestores = new Map<string, Promise<LiveAgentSession | null>>();

type BotRow = typeof agentBots.$inferSelect;

interface RestoreAvatarAttributionDeps {
  findActiveAvatarId(userId: string): Promise<{ id: string } | null | undefined>;
  warn(message: string): void;
}

const restoreAvatarAttributionDeps: RestoreAvatarAttributionDeps = {
  findActiveAvatarId: (userId) =>
    db.query.avatars.findFirst({
      where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
      columns: { id: true },
    }),
  warn: (message) => console.warn(message),
};

/**
 * Resolve optional covenant attribution without expanding the authentication
 * boundary. A storage failure here must never turn a still-live bearer into a
 * restore/auth failure; the body is rebuilt without attribution and its world
 * actions remain functional but recordless until a later reconnect/rebind.
 */
export async function resolveRestoreAvatarIdFailOpen(
  userId: string | null,
  deps: RestoreAvatarAttributionDeps = restoreAvatarAttributionDeps,
): Promise<string | undefined> {
  if (!userId) return undefined;
  try {
    return (await deps.findActiveAvatarId(userId))?.id;
  } catch {
    deps.warn('[Covenant] active-avatar attribution lookup failed during session restore; continuing recordless');
    return undefined;
  }
}

/**
 * Rebuild the in-memory `{config, client}` for a surviving row and register it
 * under the incoming (hash-matched) sessionId. Returns the live session, or null
 * for an identity type that cannot be rebuilt purely from the row (the caller
 * then degrades to "reconnect", the pre-fix behaviour). Pure of TTL logic — the
 * caller already proved the row is live before calling this.
 */
function rebuildAndRegister(
  bot: BotRow,
  sessionId: string,
  avatarId?: string,
): LiveAgentSession | null {
  // If a concurrent restore (or a fresh connect) already re-registered this
  // exact sessionId while we were awaiting the DB read, reuse it rather than
  // double-register.
  const already = npcSimulation.getAgentBotConfig(sessionId);
  if (already) {
    return { config: already, bot };
  }

  const protocol = bot.protocol;
  const mode = bot.mode === 'override' ? 'override' : 'avatar';
  const meta = bot.metadata ?? {};
  const stats = meta.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };

  // ── hatcher-proxy: rebuild cognition from the encrypted token on the row ──
  if (protocol === 'hatcher-proxy') {
    if (!bot.proxyUrl || !bot.proxyTokenEnc || !bot.proxyTokenIv || !bot.proxyTokenTag) {
      // A hatcher row missing its proxy config can't speak — don't spawn a
      // mute body. Degrade to reconnect.
      return null;
    }
    // Re-validate the proxy URL against the SSRF allowlist at restore time
    // (defense-in-depth — the same check the cognition seam runs at call time).
    const urlCheck = validateHatcherProxyUrl(bot.proxyUrl);
    if (!urlCheck.ok) return null;

    let decrypted: string;
    try {
      decrypted = decryptToken(bot.proxyTokenEnc, bot.proxyTokenIv, bot.proxyTokenTag);
    } catch {
      // Token can't be decrypted (rotated VANITY_ENCRYPTION_KEY, corrupt row) —
      // can't speak, degrade to reconnect.
      return null;
    }

    // Partner-signed Hatcher sessions are ledger-capable IFF the row is bound to
    // a user (the same rule the register path uses: boundUserId = row.userId).
    // resolveAgentSession re-validates boundUserId === liveBot.userId at spend
    // time, so a null userId here keeps the restored session non-ledger.
    const boundUserId = bot.userId ?? null;
    const rawId = rawHatcherAgentId(bot.agentId);

    // An override row with no target NPC can't be re-seated — degrade to
    // reconnect (same as the original).
    if (mode === 'override' && !bot.targetNpcId) return null;

    // Build via the SHARED config-builder (agent-session-config.ts) so the
    // restored config is byte-identical to the partner-hatcher MINT config for
    // the spawn-relevant fields. `protocolOverride: 'hatcher-proxy'` matches the
    // mint path (which knows it is hatcher-proxy regardless of the row's
    // identityType column); `resolveAgentSpecies` inside the builder applies the
    // hatcher species fallback (DEFAULT_HATCHER_MODEL_KEY) for a null species.
    const config: AgentSubstrateRegistration =
      mode === 'override'
        ? buildOverrideSessionConfig({
            mode: 'override',
            agentId: bot.agentId,
            sessionId,
            identityType: bot.identityType,
            storedProtocol: bot.protocol,
            autonomyMode: 'server-managed',
            targetNpcId: bot.targetNpcId!,
            ledgerCapable: boundUserId !== null,
            boundUserId,
            avatarId,
            protocolOverride: 'hatcher-proxy',
          })
        : buildAvatarSessionConfig({
            mode: 'avatar',
            agentId: bot.agentId,
            sessionId,
            identityType: bot.identityType,
            storedProtocol: bot.protocol,
            autonomyMode: 'server-managed',
            name: bot.name ?? rawId.slice(0, 24),
            species: bot.species,
            color: bot.color,
            stats,
            // FIX-13: match the HATCHER MINT default (11520-space center 5760),
            // NOT the legacy 5120-space 2560 — restore must be byte-identical to
            // mint for the spawn-relevant fields or a pre-fix row re-spawns at the
            // wrong center on restart. (The non-hatcher branch below stays 2560:
            // openclaw/gateway agents live in the separate 5120-space.)
            homeX: meta.homeX ?? DEFAULT_HATCHER_HOME_X,
            homeY: meta.homeY ?? DEFAULT_HATCHER_HOME_Y,
            patrolRadius: meta.patrolRadius ?? 100,
            personality: meta.personality ?? '',
            ledgerCapable: boundUserId !== null,
            boundUserId,
            avatarId,
            protocolOverride: 'hatcher-proxy',
          });

    const client = new AgentSubstrateClient({
      ...config,
      protocol: 'hatcher-proxy',
      proxyBaseUrl: urlCheck.url,
      proxyAgentId: rawId,
      scopedToken: decrypted,
    });
    try {
      npcSimulation.registerAgentBot(config, client, restoredPos(meta));
    } catch {
      // Override target already taken / body already present — treat as
      // un-restorable this turn rather than crash the chat call.
      return null;
    }
    return { config, bot };
  }

  // ── nanoclaw / milady / anonymous / hermes: no outbound gateway (fail-soft) ──
  // The IN-WORLD wire protocol is decided by `resolveInWorldProtocol` from the
  // AUTHORITATIVE identityType, NOT the stored `protocol` column. For these types
  // it resolves to 'nanoclaw' whose `.chat()` returns '' with NO network call —
  // this is the D1 FIX: the old code passed the row's stored 'openai-compat'
  // straight through, so a restored anonymous/milady body POSTed to the dummy
  // `http://localhost:0` gateway and 502'd on every autonomous NPC conversation.
  // (hermes re-derives to the equally fail-soft 'hermes-local' instead when the
  // host-it-for-me gate is on — same authoritative-identity rule, so a restored
  // hermes body tracks the CURRENT gate state, not whatever the row was minted
  // under.)
  //
  // ── openclaw / ironclaw / custom (every REAL-GATEWAY identity type): the row
  // never persists `auth_token`, so a rebuilt body would 401/502 (mute). The
  // restorability decision is delegated to the SHARED pure predicate
  // `isRowRestorableFromIdentity` (agent-session-config.ts) so the literal rule
  // is unit-tested, NOT a mirror. It gates on the IDENTITY TYPE, not the
  // `gatewayUrl` column shape — closing the #6 fall-through where a malformed
  // legacy `openclaw`/`custom` row with a null/dummy `gatewayUrl` slipped past
  // the old `!!gatewayUrl && gatewayUrl !== 'http://localhost:0'` guard and built
  // a mute body. (The hatcher branch already returned above; this reaches only
  // the non-hatcher identity types.)
  if (!isRowRestorableFromIdentity(bot.identityType)) {
    return null;
  }

  // An override row with no target NPC can't be re-seated — degrade to
  // reconnect (matches the hatcher branch + the original).
  if (mode === 'override' && !bot.targetNpcId) return null;

  const boundUserId = bot.userId ?? null;
  // These paths were never ledger-capable on a bare reconnect (the /connect
  // ledger rule requires a proven owned-token or first-contact; a restart-
  // restore is neither), so we restore them NON-ledger. They keep perceiving/
  // chatting; real-CT play requires a fresh owned reconnect. boundUserId is
  // still carried so resolveAgentSession's rebind backstop stays consistent.
  //
  // Built via the SHARED config-builder so the protocol/species/autonomy
  // resolution is byte-identical to the /connect MINT path for this identity
  // type — the structural prevention against mint↔restore drift.
  const config: AgentSubstrateRegistration =
    mode === 'override'
      ? buildOverrideSessionConfig({
          mode: 'override',
          agentId: bot.agentId,
          sessionId,
          identityType: bot.identityType,
          storedProtocol: bot.protocol,
          gatewayUrl: bot.gatewayUrl,
          targetNpcId: bot.targetNpcId!,
          ledgerCapable: false,
          boundUserId,
          avatarId,
        })
      : buildAvatarSessionConfig({
          mode: 'avatar',
          agentId: bot.agentId,
          sessionId,
          identityType: bot.identityType,
          storedProtocol: bot.protocol,
          gatewayUrl: bot.gatewayUrl,
          name: bot.name ?? bot.agentId.slice(0, 24),
          species: bot.species,
          color: bot.color,
          stats,
          homeX: meta.homeX ?? 2560,
          homeY: meta.homeY ?? 2560,
          patrolRadius: meta.patrolRadius ?? 100,
          personality: meta.personality ?? '',
          ledgerCapable: false,
          boundUserId,
          avatarId,
        });

  const client = new AgentSubstrateClient(config);
  try {
    npcSimulation.registerAgentBot(config, client, restoredPos(meta));
  } catch {
    return null;
  }
  return { config, bot };
}

/** Build the restored-position hint from the row metadata (or undefined). */
function restoredPos(
  meta: NonNullable<BotRow['metadata']>,
): { lastX?: number; lastY?: number; knowledge?: string[] } | undefined {
  if (meta.lastX == null || meta.lastY == null) return undefined;
  return { lastX: meta.lastX, lastY: meta.lastY };
}

/**
 * Restore a live agent session that map-missed after a restart.
 *
 * Contract (called ONLY by `validateLiveAgentSession` on a Map-miss):
 *   - `sessionId` is the INCOMING bearer the caller presented.
 *   - We hash it, find the surviving row by `session_key_hash`, re-validate the
 *     TTL fail-closed (NULL or past = expired → null), and rebuild the session.
 *   - Returns the live `{config, bot}` on success, or null when the row is
 *     missing/expired OR the identity type can't be rebuilt from the row alone.
 *
 * The returned session is registered under the INCOMING sessionId, so the very
 * next `validateLiveAgentSession` call (or the same request's downstream lookup)
 * short-circuits at Map membership.
 */
export async function restoreAgentSessionFromRow(
  sessionId: string,
): Promise<LiveAgentSession | null> {
  if (!sessionId) return null;

  // Coalesce concurrent restores for the same agent. We don't know the agentId
  // until after the row read, so key the in-flight map on the hash (1:1 with the
  // row) which we DO have up front.
  const keyHash = sha256Hex(sessionId);
  const existing = inFlightRestores.get(keyHash);
  if (existing) return existing;

  const work = (async (): Promise<LiveAgentSession | null> => {
    const bot = await db.query.agentBots.findFirst({
      where: eq(agentBots.sessionKeyHash, keyHash),
    });
    if (!bot) return null;

    // Fail-closed TTL gate — IDENTICAL rule to validateLiveAgentSession: a NULL
    // or past session_expires_at is EXPIRED. We do NOT clear the hash here (the
    // sweeper owns lifecycle; clearing would race it). Restore can never grant
    // liveness the primary gate would refuse.
    const expiresAt = bot.sessionExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) return null;

    // Belt-and-suspenders swept gate (auth-lens adversary constraint, 2026-06-11).
    // `sessionSweptAt` is only ever set when `sessionExpiresAt <= now` (the
    // sweeper picks `expiry < now`; expireSession/disconnect set both to now), so
    // a swept row already fails the TTL gate above. We assert it explicitly so a
    // swept/disconnected row can NEVER be restored even if a future change made
    // the two columns diverge — restore must never resurrect a reaped session.
    const sweptAt = bot.sessionSweptAt;
    if (sweptAt && sweptAt.getTime() >= expiresAt.getTime()) return null;

    const avatarId = await resolveRestoreAvatarIdFailOpen(bot.userId);
    const live = rebuildAndRegister(bot, sessionId, avatarId);
    if (live) {
      console.log(
        `[OpenClaw] session restored after restart sess:${sessionDigest(sessionId)} (${bot.identityType}/${bot.mode})`,
      );
    }
    return live;
  })();

  inFlightRestores.set(keyHash, work);
  try {
    return await work;
  } finally {
    inFlightRestores.delete(keyHash);
  }
}
