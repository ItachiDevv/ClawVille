/**
 * Phase P0 (lifecycle-truth) — boot rehydration of in-world agent bodies.
 *
 * THE RESTART-DESYNC FIX (world / server-driven half). On a process restart the
 * in-RAM `openClawBots` registry is empty, so every live-TTL agent's BODY
 * vanishes from the world. v7 already recovers a REMOTE's session lazily — the
 * first time a remote presents its bearer, `validateLiveAgentSession` map-misses
 * and `restoreAgentSessionFromRow` rebuilds the EXACT session from the surviving
 * row (hash-matched on `session_key_hash`). But lazy restore only fires when a
 * caller presents a bearer, so it does NOT cover:
 *   - SERVER-DRIVEN agents (nanoclaw self-managed, milady, anonymous, a hosted
 *     fleet) — nothing external ever presents their bearer, so their body would
 *     never respawn on its own; AND
 *   - VISUAL continuity — the world is empty between restart and the first
 *     bearer-bearing request.
 *
 * This rehydrator PROACTIVELY re-creates the in-world BODY for every live-TTL row
 * so the world is populated immediately and server-driven agents resume. It mints
 * a FRESH server-side sessionId and marks the session PROVISIONAL (a placeholder:
 * body present, but NO bearer/brain re-attached, `ledgerCapable:false`).
 *
 * COEXISTENCE WITH LAZY RESTORE / RECONNECT (the v7-specific trap the design docs
 * predate): a boot body under a fresh sessionId would otherwise DOUBLE-register
 * when the remote later presents its old bearer (lazy restore) or reconnects
 * (avatar → two bodies; override → `already overridden` throw → lockout). We defeat
 * that at the ONE registration chokepoint: `registerOpenClaw` evicts any PROVISIONAL
 * sibling for the same agentId before registering, so ANY real (re)registration
 * REPLACES the placeholder. `session-status` treats an agentId whose only live RAM
 * session is provisional as "not attached" (see D-2/H1).
 *
 * SECURITY / PARTNER SURFACE (protected): this touches the same `registerOpenClaw`
 * Map + `openclaw_bots` rows the Hatcher partner path uses. Invariants preserved:
 *   - Rehydrated sessions are NON-LEDGER (fail-closed): `ledgerCapable:false`,
 *     ALWAYS. A rehydrated body can perceive/wander but the cove rejects real-CT
 *     spend (403) until the agent re-proves ownership via a proof-carrying
 *     /connect or the signed-challenge /reconnect. Reproducing real-CT authority
 *     purely from at-rest state, with no signature in hand, is a security decision
 *     we do NOT make mechanically.
 *   - The freshly-minted (provisional) sessionId is NEVER persisted and NEVER
 *     handed to any client, so it can never become a usable bearer.
 *   - `config.agentId` is set VERBATIM to `openclaw_bots.agent_id` (the stable /
 *     namespaced handle) so the evict-by-agentId path cleanly REPLACES this body.
 *   - We NEVER log a raw sessionId (auth-lens rule) — only aggregate counts.
 *   - SKIP-IF-PRESENT: if a live RAM session already exists for the agentId (a
 *     reconnect/restore beat boot, or a second rehydrate pass), we skip — never
 *     downgrade a live cognition client to a provisional placeholder.
 *
 * COGNITION ON REHYDRATION (prefer a DORMANT body over a BROKEN client — L1):
 *   - hatcher (`protocol='hatcher-proxy'`) with valid proxy config → decrypt +
 *     SSRF-validate → LIVE hatcher-proxy client (the partner drives it). Any
 *     failure (missing fields / bad key/tag / stale-private URL) → INERT nanoclaw
 *     body (present + hatcher-looking, cognition resumes on reconnect).
 *   - EVERYTHING ELSE (gateway `openai-compat`/`custom` AND nanoclaw/milady/
 *     anonymous) → INERT nanoclaw body. At boot we hold no outbound credential
 *     (`auth_token` is never persisted), so a real-gateway client would 502/401;
 *     `nanoclaw`'s `.chat()` returns '' with NO network call. Cognition resumes on
 *     the agent's next /connect / /reconnect.
 *
 * Config is assembled via the SHARED builders (`agent-session-config.ts`) so the
 * spawn-relevant fields are byte-identical to the /connect + restore paths per
 * identity type — the same structural prevention against mint↔restore↔rehydrate
 * drift the restore path relies on.
 */

import { eq, gt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db, openclawBots, agents } from '@clawville/database';
import type { OpenClawRegistration } from '@clawville/shared';
import { npcSimulation } from './npc-simulation';
import { OpenClawClient } from './openclaw-client';
import { decryptToken } from './keypair-vault';
import { validateHatcherProxyUrl } from './hatcher-config';
import { setSessionAgent } from './session-agent-map';
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
  DEFAULT_HATCHER_HOME_X,
  DEFAULT_HATCHER_HOME_Y,
} from './agent-session-config';

const HATCHER_AGENT_PREFIX = 'hatcher:';

/** Strip the internal `hatcher:` namespace so the proxy callback sees the id IT knows. */
function rawHatcherAgentId(namespacedAgentId: string): string {
  return namespacedAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? namespacedAgentId.slice(HATCHER_AGENT_PREFIX.length)
    : namespacedAgentId;
}

/**
 * Re-create in-world PROVISIONAL bodies for every live-TTL `openclaw_bots` row.
 * Called ONCE at boot from `apps/api/src/index.ts`, AFTER the NPC sim is started
 * (so override targets exist) and AFTER the seeders, BEFORE the session sweeper.
 * Awaited so the in-RAM registry is populated before the sweeper's first tick.
 *
 * NEVER crashes boot: the whole call is guarded at the call site, and every row
 * is processed inside its own try/catch so a single bad row can't abort the rest.
 *
 * @returns the number of bodies restored (for the boot log line).
 */
export async function rehydrateAgentSessions(): Promise<number> {
  const now = new Date();

  // Live rows only. `gt(session_expires_at, now)` also excludes NULL TTLs (SQL
  // `NULL > x` is NULL/false) — fail-closed, matching the bearer gate +
  // session-status which both treat NULL as expired. A swept/disconnected row has
  // an expiry in the PAST, so it can't match here.
  let rows: Array<typeof openclawBots.$inferSelect>;
  try {
    rows = await db.select().from(openclawBots).where(gt(openclawBots.sessionExpiresAt, now));
  } catch (err) {
    console.error('[Rehydrate] live-session query failed — restored 0:', err);
    return 0;
  }
  if (rows.length === 0) return 0;

  // Best-effort openclawBotId → ElizaOS agent id map (RAM-only session→eliza
  // pointer). Hatcher rows have no server Eliza runtime, so they won't appear.
  const elizaByBotId = new Map<string, string>();
  try {
    const ocAgents = await db
      .select({ id: agents.id, config: agents.config })
      .from(agents)
      .where(eq(agents.type, 'openclaw-bot'));
    for (const a of ocAgents) {
      const botId = (a.config as { openclawBotId?: string } | null)?.openclawBotId;
      if (botId) elizaByBotId.set(botId, a.id);
    }
  } catch (err) {
    console.warn('[Rehydrate] eliza-agent map build failed (non-fatal):', err);
  }

  let restored = 0;
  let hatcherLive = 0;
  let inert = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      // SKIP-IF-PRESENT: a live RAM session already exists for this agentId (a
      // reconnect/restore beat boot, or a second rehydrate pass). Skipping keeps
      // this idempotent AND never downgrades a live cognition client to a
      // provisional placeholder.
      if (npcSimulation.findActiveSessionsByAgentIds([row.agentId]).length > 0) {
        skipped++;
        continue;
      }

      const mode: 'avatar' | 'override' = row.mode === 'override' ? 'override' : 'avatar';
      // An override row with no target NPC can't be re-seated (registerOpenClaw
      // would throw); skip cleanly. (A stale/unknown targetNpcId is caught by the
      // per-row try/catch below via registerOpenClaw's "NPC not found" throw.)
      if (mode === 'override' && !row.targetNpcId) {
        skipped++;
        continue;
      }

      // Fresh PROVISIONAL server-side sessionId. Prefix is cosmetic (validation is
      // Map membership); `rhy-` marks it as a rehydrated placeholder in logs. It is
      // never persisted and never handed out, so it can never be a usable bearer.
      const sessionId = `rhy-${randomBytes(24).toString('base64url')}`;

      const isHatcherRow = row.protocol === 'hatcher-proxy';

      // Try to rebuild a LIVE hatcher-proxy cognition client (the only credential
      // restorable from the row — its scoped bearer is persisted encrypted). ANY
      // failure falls back to an inert body (never a broken client).
      let hatcherProxyBaseUrl = '';
      let hatcherScopedToken = '';
      let liveHatcher = false;
      if (
        isHatcherRow &&
        row.proxyUrl &&
        row.proxyTokenEnc &&
        row.proxyTokenIv &&
        row.proxyTokenTag
      ) {
        // Synchronous (non-DNS) SSRF guard — the DNS-resolving variant is for
        // persist-time; running it per row at boot would do outbound DNS for every
        // agent. The per-call cognition path re-runs the DNS-aware check anyway.
        const urlCheck = validateHatcherProxyUrl(row.proxyUrl);
        if (urlCheck.ok) {
          try {
            hatcherScopedToken = decryptToken(row.proxyTokenEnc, row.proxyTokenIv, row.proxyTokenTag);
            hatcherProxyBaseUrl = urlCheck.url;
            liveHatcher = true;
          } catch {
            // Bad VANITY_ENCRYPTION_KEY / tampered tag → inert fallback. NEVER log
            // the token or raw crypto error body.
          }
        }
      }

      // Wire protocol: LIVE hatcher speaks 'hatcher-proxy'; EVERYTHING else (incl.
      // a hatcher row that couldn't rebuild + all gateway/no-gateway types) is
      // forced INERT 'nanoclaw' (`.chat()` returns '' with no outbound), per L1.
      const protocolOverride = liveHatcher ? 'hatcher-proxy' : 'nanoclaw';

      // Home default matches the RESTORE path per coordinate space: hatcher rows
      // live in the 22528-px hatcher space (center 11264); non-hatcher gateway
      // agents in the legacy 5120-space (2560). `meta.lastX/lastY` (below) is the
      // real spawn hint; this default only applies to a never-moved body.
      const meta = row.metadata ?? {};
      const homeX = meta.homeX ?? (isHatcherRow ? DEFAULT_HATCHER_HOME_X : 2560);
      const homeY = meta.homeY ?? (isHatcherRow ? DEFAULT_HATCHER_HOME_Y : 2560);

      // Fail-closed ledger derivation (see file header). `boundUserId` carries the
      // row's user for truthfulness, but is irrelevant at spend time because
      // `ledgerCapable:false` (resolveAgentSession only reads boundUserId when
      // ledgerCapable === true). The agent re-earns ledger capability on reconnect.
      const boundUserId = row.userId ?? null;

      const config: OpenClawRegistration =
        mode === 'override'
          ? buildOverrideSessionConfig({
              mode: 'override',
              agentId: row.agentId,
              sessionId,
              identityType: row.identityType,
              storedProtocol: row.protocol,
              gatewayUrl: row.gatewayUrl,
              autonomyMode: 'server-managed',
              targetNpcId: row.targetNpcId!,
              ledgerCapable: false,
              boundUserId,
              protocolOverride,
            })
          : buildAvatarSessionConfig({
              mode: 'avatar',
              agentId: row.agentId,
              sessionId,
              identityType: row.identityType,
              storedProtocol: row.protocol,
              gatewayUrl: row.gatewayUrl,
              autonomyMode: 'server-managed',
              name: row.name ?? rawHatcherAgentId(row.agentId).slice(0, 24),
              species: row.species,
              color: row.color,
              stats: meta.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 },
              homeX,
              homeY,
              patrolRadius: meta.patrolRadius ?? 100,
              personality: meta.personality ?? '',
              ledgerCapable: false,
              boundUserId,
              protocolOverride,
            });

      // Build the client. LIVE hatcher gets the proxy fields (callback uses the RAW
      // partner id); everything else gets an inert nanoclaw client.
      const client = liveHatcher
        ? new OpenClawClient({
            ...config,
            protocol: 'hatcher-proxy',
            proxyBaseUrl: hatcherProxyBaseUrl,
            proxyAgentId: rawHatcherAgentId(row.agentId),
            scopedToken: hatcherScopedToken,
          })
        : new OpenClawClient(config);

      const restoredState =
        meta.lastX != null && meta.lastY != null
          ? { lastX: meta.lastX, lastY: meta.lastY, knowledge: row.knowledge ?? [] }
          : undefined;

      npcSimulation.registerOpenClaw(config, client, restoredState);
      // Mark PROVISIONAL immediately so session-status reports "not attached" and
      // a real reconnect/restore evicts this placeholder.
      npcSimulation.markSessionProvisional(sessionId);
      restored++;
      if (liveHatcher) hatcherLive++;
      else inert++;

      // Best-effort session→eliza pointer (RAM-only, lost on restart).
      const elizaAgentId = elizaByBotId.get(row.id);
      if (elizaAgentId) setSessionAgent(sessionId, elizaAgentId);
    } catch (err) {
      // Per-row isolation — a single bad row must never abort the rest of boot.
      console.error(`[Rehydrate] row ${row.id.slice(0, 8)} failed (non-fatal):`, err);
    }
  }

  // Digest-only aggregate — NEVER a raw sessionId (auth-lens rule).
  console.log(
    `[Rehydrate] restored ${restored} provisional bodies (${hatcherLive} hatcher-live, ${inert} inert, ${skipped} skipped)`,
  );
  return restored;
}
