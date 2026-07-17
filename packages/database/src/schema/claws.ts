import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

// --- OpenClaw Bot Persistence ---

export interface AgentBotMetadata {
  personality?: string;
  homeX?: number;
  homeY?: number;
  patrolRadius?: number;
  stats?: { hp: number; attack: number; defense: number; speed: number };
  lastX?: number;
  lastY?: number;
}

export interface AgentBotAck {
  manual?: {
    version: number;
    contentHash: string;
    at: string;
  };
  skills?: Record<string, {
    contentHash: string;
    at: string;
  }>;
}

export const agentBots = pgTable('openclaw_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: varchar('agent_id', { length: 200 }).notNull().unique(),
  // Identity type — which framework is connecting.
  // Values: 'openclaw' | 'ironclaw' | 'nanoclaw' | 'milady' | 'custom' | 'anonymous'
  //
  // For 'milady', the agent_id is prefixed with "milady:" and derived from
  // the Milady runtime's agentId. Runtime-trust model: no external
  // verification happens — the @clawville/app-clawville plugin is the
  // trust boundary.
  identityType: varchar('identity_type', { length: 50 }).default('openclaw').notNull(),
  // Nullable: nanoclaw / anonymous / milady agents have no outbound gateway
  gatewayUrl: varchar('gateway_url', { length: 500 }),
  protocol: varchar('protocol', { length: 50 }).default('openai-compat').notNull(),
  mode: varchar('mode', { length: 20 }).notNull(),
  targetNpcId: varchar('target_npc_id', { length: 100 }),
  name: varchar('name', { length: 100 }),
  species: varchar('species', { length: 50 }),
  color: integer('color'),
  knowledge: jsonb('knowledge').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<AgentBotMetadata>(),
  /**
   * Informational BYO-install acknowledgements. These hashes never authorize or
   * gate play; they only make protocol/skill ingestion drift observable.
   */
  ack: jsonb('ack').$type<AgentBotAck>().default({}).notNull(),
  /**
   * Mirror of the agent's custodial Solana wallet address (base58 public key).
   * Secret key lives encrypted in the unified `wallets` table keyed on
   * (subject_type='agent', subject_id=openclaw_bots.id). Auto-populated by
   * ensureWallet() at /api/agent/connect time.
   */
  walletAddress: varchar('wallet_address', { length: 64 }),
  /**
   * Hatcher proxy-cognition (partner #2, Phase A — 2026-06-01).
   *
   * `cognitionBackend` selects how the simulation gets an LLM response for
   * this agent. `null`/absent = the legacy behaviour (the agent's own gateway
   * via `protocol`, or none for nanoclaw/anonymous). `'hatcher-proxy'` =
   * ClawVille POSTs to a Hatcher-managed per-agent proxy that owns the real
   * OpenClaw/Hermes brain. See `.claude/plans/hatcher-integration.md` §13/§14.
   */
  cognitionBackend: varchar('cognition_backend', { length: 32 }),
  /**
   * The partner-supplied proxy base URL ClawVille POSTs to for cognition
   * (`{proxyUrl}/integrations/clawville/agents/{agentId}/chat`). Validated
   * against the SSRF host allowlist before any outbound call — must be https
   * and an allowlisted Hatcher host. Only meaningful when
   * `cognitionBackend = 'hatcher-proxy'`.
   */
  proxyUrl: varchar('proxy_url', { length: 500 }),
  /**
   * The scoped bearer token Hatcher issues per agent for the cognition
   * callback, stored ENCRYPTED AT REST (AES-256-GCM under
   * VANITY_ENCRYPTION_KEY — same envelope shape as the identity/treasury
   * secrets). NEVER store this token in plaintext and NEVER log it. The
   * three columns are the ciphertext + iv + auth tag, all base64. The token
   * is decrypted in-memory ONLY at callback time inside the cognition seam.
   */
  proxyTokenEnc: varchar('proxy_token_enc', { length: 1024 }),
  proxyTokenIv: varchar('proxy_token_iv', { length: 64 }),
  proxyTokenTag: varchar('proxy_token_tag', { length: 64 }),
  totalSessions: integer('total_sessions').default(0).notNull(),
  totalMessages: integer('total_messages').default(0).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  /**
   * Session liveness — sliding 24h TTL extended on every meaningful agent
   * action (location chat, heartbeat, building visit, activity match).
   * `null` means "never expires" and is only used for legacy rows that
   * pre-date the Phase-6 liveness sweep; the sweeper treats null as
   * "needs backfill, not expired".
   *
   * Enforcement:
   *   - `agent-session-sweeper.ts` runs every 5 min, marks rows where
   *     session_expires_at < now() and stops any running Eliza runtime.
   *   - `GET /api/agent/session-status` returns 410 Gone past expiry.
   *   - `POST /api/agent/disconnect` sets session_expires_at = now()
   *     immediately (signed-challenge gated, same as /reconnect).
   *
   * Reconnect is cheap and stateless — an expired row does NOT require
   * the user to re-do the magic-link flow. The agent just signs a fresh
   * challenge with the stored identity private key; the session pops
   * back alive with a new sessionId and a fresh TTL.
   */
  sessionExpiresAt: timestamp('session_expires_at'),
  /**
   * Phase 6.1 — set by the sweeper the first time it picks up an
   * expired row, so the same expiration doesn't fire `agent.session.
   * expired` events on every 5-min tick forever. Reset to NULL on
   * /connect / /reconnect so subsequent expirations get processed
   * correctly. Sweep query: `session_expires_at < now AND
   * (session_swept_at IS NULL OR session_swept_at < session_expires_at)`.
   */
  sessionSweptAt: timestamp('session_swept_at'),
  /**
   * Restart survival (2026-06-11). The live agent-session id is held ONLY in
   * npc-simulation's in-memory Map — never persisted — so every API deploy /
   * restart silently dropped every connected agent's session (the DB row
   * survives, but `validateLiveAgentSession` map-missed and 404'd the agent's
   * owner mid-chat). This column stores `sha256Hex(sessionId)` — the one-way
   * hash of the live bearer, NEVER the raw bearer (a DB dump must not yield a
   * spendable real-CT credential). On a Map-miss the restore path
   * (`agent-session-restore.ts`) hashes the INCOMING bearer, finds the row by
   * this column, re-validates the sliding `session_expires_at` TTL fail-closed,
   * and rebuilds the in-memory session + client FROM THE ROW so the same
   * sessionId keeps working across restarts. Rewritten on every connect /
   * register / patch (new sessionId per connect ⇒ new hash); NULL for legacy
   * rows minted before this column existed (those simply can't be restored and
   * the agent reconnects, the prior behaviour).
   */
  sessionKeyHash: varchar('session_key_hash', { length: 64 }),
  /**
   * Agent-metaverse P1 (2026-07-01) — marks a ClawVille-HOSTED "house" agent
   * (the first member of the eventual autonomous fleet), as opposed to an
   * external/partner-connected agent. Internal-only: it is used ONLY server-side
   * — (a) the autonomy driver + seeder identify house rows, and (b) the body
   * idle-despawn sweeper EXEMPTS house bodies so a hosted fixture survives like a
   * system agent (it is never idle-reaped and its session TTL is null/never-
   * expires). It MUST NEVER be serialized onto any public snapshot / `/rooms`
   * roster / wire field (a house agent must be indistinguishable from any other
   * agent to outsiders — see CLAUDE.md "undetectable is_house flag").
   */
  isHouse: boolean('is_house').default(false).notNull(),
  /**
   * §B.1 durable autonomy (2026-07-08) — the persisted "this owner's hosted
   * avatar-agent intends to run AUTONOMOUS" flag, so a server restart / deploy
   * re-enrolls it into the autonomy driver with ZERO client involvement (the
   * `agent-autonomy-reconcile` loop queries `autonomy_enrolled = true AND
   * session_expires_at > now()` and re-activates). Without this, a browser-closed
   * persisting agent (D6, 24h TTL) was re-enrolled ONLY by the client keepalive,
   * so every deploy silently killed away-users' agents until they returned.
   *
   * Lifecycle (owned by agent-autonomy-activation + the sweeper):
   *   - SET true  → `activateAutonomyForOwner` AFTER a successful enroll (by agent_id).
   *   - SET false → `deactivateAutonomyForOwner` (explicit toggle + logout route),
   *     cleared FIRST/atomically by user_id so a crash can't re-enroll a user who
   *     left; AND the 24h TTL sweep clears it in its mark-swept UPDATE.
   * Only ever true on a hosted-avatar (is_house=false, nanoclaw) session row.
   */
  autonomyEnrolled: boolean('autonomy_enrolled').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  // UNIQUE partial index on the restart-survival session hash. UNIQUE is
  // defense-in-depth: a hash is sha256 of a ~192-bit random bearer, so a
  // collision between two rows is infeasible without a bug — UNIQUE turns such a
  // bug into a loud write error instead of a silent restore mis-resolve (the
  // restore `findFirst` could otherwise bind one agent's bearer to another's
  // row). Partial on non-null so the many legacy/expired NULL rows are skipped.
  // Mirrors the manual migration 2026-06-11_add_openclaw_session_key_hash.sql.
  sessionKeyHashIdx: uniqueIndex('openclaw_bots_session_key_hash_idx')
    .on(table.sessionKeyHash)
    .where(sql`${table.sessionKeyHash} IS NOT NULL`),
}));
