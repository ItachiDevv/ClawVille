/**
 * Fire-and-forget analytics event writer.
 *
 * Every meaningful app action calls logEvent({...}). Three-tier fallback:
 *   1. INSERT into `events` table (happy path, ~1ms)
 *   2. If that fails, INSERT into `event_write_failures` table with attempt + error
 *   3. If that ALSO fails, console.warn + immediate Telegram alert
 *
 * The function returns Promise<void> and NEVER throws — callers can
 * `void logEvent(...)` or `await logEvent(...)` safely without try/catch.
 *
 * PII/secret sanitization: any payload key matching the detector in
 * isSensitiveKey() (word-list + danger-substring pass) gets [REDACTED]
 * before insert. Verified against 43 edge cases. Belt-and-suspenders —
 * we should never put secrets in a payload, but this catches accidents.
 *
 * Value preservation: sanitizeValue() recurses into plain objects and arrays,
 * and passes Date/Buffer/Map/RegExp/etc. through untouched so the jsonb
 * serializer gets them intact. Object.entries(new Date()) returns [], so a
 * naive recurse would silently truncate Date values to {}.
 */

import { db, events, eventWriteFailures, users, avatars, agentBots } from '@clawville/database';
import { eq, sql } from 'drizzle-orm';
import { alertError } from './alert-error';
import { sessionDigest } from './session-digest';

// ─── Central raw-bearer redaction chokepoint (Codex auth-lens fix #4 — 2026-06-03) ──
//
// The raw agent-session id (`ag-…` / `oc-…` / `hat-…` / `claw-…`) is the REAL-CT
// bearer the Cove reads from the `X-Clawville-Agent-Session` header. Scattered
// call-site `sessionDigest(...)` edits proved INCOMPLETE — e.g. skills.ts logs a
// caller-supplied `X-Clawville-Session-Id` header RAW. This is the single insert
// chokepoint, so redact here regardless of which call site (or header) supplied
// the value: every raw bearer that reaches the `events` table is digested before
// it lands.
//
// EXACT-SHAPE MATCH (so it is safe to redact the agent_id column too — see below).
// Every real-CT bearer is `<prefix>-` + `randomBytes(24).toString('base64url')`,
// which is ALWAYS exactly 32 url-safe chars (24 bytes * 8 / 6 = 32, no padding):
//   agent-gateway `ag-…`, openclaw `oc-…`, hatcher `hat-…`. So the bearer is
// `^(ag|oc|hat|claw)-[A-Za-z0-9_-]{32}$` and nothing else. Matching the EXACT
// length (not `{16,}`) is what lets us redact agent_id without corrupting it:
//   - a legit agent HANDLE the leaderboard groups by (`oc-mybot`, `milady:x`,
//     `agent-<ts>-<rand>`, a UUID, a `hatcher:<id>`) is NEVER exactly
//     `<prefix>-`+32-url-safe-chars, so it passes through UNCHANGED — the
//     `COUNT(DISTINCT agent_id)` / `GROUP BY agent_id` scoring stays intact;
//   - a CALLER-INJECTED raw bearer (e.g. a client putting an `ag-…`/`oc-…` into
//     the spoofable `X-Clawville-Agent-Id` header that skills.ts logs into
//     events.agent_id) DOES match and gets digested here. Closes that injection
//     path centrally regardless of which call site or header supplied the value.
//
// IDEMPOTENT BY CONSTRUCTION: an already-digested 16-hex value (`a1b2c3d4e5f60718`)
// has no `(ag|oc|hat|claw)-` prefix and is only 16 chars, so it never matches —
// call sites that already pass `sessionDigest(...)` are untouched (no double-digest),
// and `sessionDigest` is a deterministic 1:1 map so `COUNT(DISTINCT session_id)` for
// `agent.connected` is invariant whether the digest happened at the call site or here.
const RAW_BEARER_RE = /^(ag|oc|hat|claw)-[A-Za-z0-9_-]{32}$/;

// Exported for the focused unit test that PINS the events.agent_id ==
// getAgentBotConfig().agentId join the P3 slice-1 replay depends on: a
// canonical agentId handle must pass through UNCHANGED (so a settle/visit/chat
// row is found by the replay's canonical agentId), while a raw bearer is
// digested (so it can never land as agent_id). Pure — no env, no I/O.
export function redactBearer(v: unknown): unknown {
  return typeof v === 'string' && RAW_BEARER_RE.test(v) ? sessionDigest(v) : v;
}

// Recursively walk objects/arrays and redact any RAW-bearer string leaf. Depth-
// capped (~6) so a pathologically nested payload can't blow the stack; below the
// cap we stop recursing and return the value as-is (a deep object can't hide a
// bearer behind 6 levels of nesting in practice, and `sanitize()` upstream
// already strips secret-keyed fields).
function redactBearersDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return v;
  if (typeof v === 'string') return redactBearer(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((el) => redactBearersDeep(el, depth + 1));
  // Only walk plain objects; Date/Buffer/Map/RegExp/etc. pass through untouched
  // (same carve-out as sanitizeValue, so jsonb serialization stays intact).
  const proto = Object.getPrototypeOf(v as object);
  if (proto === Object.prototype || proto === null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        redactBearersDeep(val, depth + 1),
      ]),
    );
  }
  return v;
}

/**
 * Duck-typed Hono context — any object with a string-keyed `.get()` method
 * satisfies us. We only need `fpHash` and `ipPrefixHash` (set by the global
 * fingerprintMiddleware). Avoiding `Context<AppContext>` here is deliberate:
 *
 *   - Hono's Context generic is invariant in `Variables`, so a strict shape
 *     like `Context<{ Variables: { fpHash: string; ipPrefixHash: string } }>`
 *     rejects every real call site (AppContext, AppContext & AuthenticatedContext,
 *     BlankEnv from routes that did `new Hono()` without a generic).
 *   - The runtime contract is: middleware always sets these two strings, so
 *     `c.get('fpHash')` returns `string`. We narrow with `typeof === 'string'`
 *     to be safe at the boundary.
 *
 * Audit fix 2026-04-29 (round 2) — first attempt used Context<{...}> which
 * caused 12 TS errors across the migrated emitter sites.
 */
type FingerprintedContext = {
  get(key: string): unknown;
};

// Sensitive-key detection. Two passes:
//
//   1. Split the key into words (camelCase → snake_case, then split on _/-).
//      If any word is an exact match for one of the sensitive words (`auth`,
//      `token`, `secret`, etc.), redact.
//
//   2. Strip all separators and test against a substring regex — catches
//      `API_KEY` → `apikey`, `authorizationHeader` → contains `authoriz`,
//      etc., even when the camelCase/snake-case split produces harmless parts.
//
// The word-list approach cleanly separates `auth` (redact) from `author`
// (keep — writer credit), and the substring pass picks up compound danger
// words that otherwise split to benign parts.
//
// Audit-verified against 36 edge cases in the test suite — see the commit
// message for `fix(event-logger): normalize-and-word-check sanitizer`.
const SENSITIVE_WORDS = new Set([
  'token', 'secret', 'password', 'apikey', 'privatekey',
  'credential', 'credentials', 'bearer', 'authorization', 'auth',
]);
const SENSITIVE_SUB = /token|secret|password|apikey|privatekey|credential|bearer|authoriz/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const words = normalized.split(/[_-]+/).filter(Boolean);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  // Strip separators so `API_KEY` / `PRIVATE_KEY` / `authorizationHeader`
  // are caught even when their words individually look harmless.
  return SENSITIVE_SUB.test(normalized.replace(/[_-]/g, ''));
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sanitizeValue);
  // Only recurse into plain {} — Date/Buffer/Map/RegExp/etc. get passed
  // through so JSON.stringify (via jsonb) can handle them. Recursing with
  // Object.entries would truncate these to {} since their enumerable own
  // properties are empty.
  if (isPlainObject(v as object)) return sanitize(v as Record<string, unknown>);
  return v;
}

function sanitize(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (isSensitiveKey(k)) return [k, '[REDACTED]'];
      return [k, sanitizeValue(v)];
    }),
  );
}

export interface EventInput {
  eventType: string;
  userId?: string | null;
  agentId?: string | null;
  avatarId?: string | null;
  buildingId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Phase 1 anti-farm — sha256-salted browser fingerprint. Routes should
   * use logEventFromContext() which pulls this from middleware context;
   * system/cron writes that have no request can leave it null.
   */
  fpHash?: string | null;
  /**
   * Phase 1 anti-farm — sha256-salted IP /24 prefix. Same lifecycle as
   * fpHash.
   */
  ipPrefixHash?: string | null;
}

// ─── DURABLE guest resolution (2026-07-10) ──────────────────────────────────
//
// The free-agent leaderboard must exclude guests EVEN AFTER ownership changes
// (a bot rebind or a guest-account delete), which a live `is_guest` join can't
// survive because `events.agent_id` is immutable TEXT and `user_id`/`avatar_id`
// are ON DELETE SET NULL. So we FREEZE the guest fact on the event row at write
// time. Guest-ness is anchored on the SoT `users.is_guest`, resolved from EVERY
// subject id present (userId, avatarId→owner, agentId→bot-owner).
//
// Semantics (returns boolean | null):
//   - true  ⇒ at least one present subject id resolves to a GUEST user (OR).
//   - false ⇒ EVERY present id resolved to a DEFINITIVE non-guest (no guest, no
//             indeterminate) — only then is it safe to freeze an authoritative
//             non-guest fact.
//   - null  ⇒ INDETERMINATE (no subject ids, or every lookup found no row /
//             timed out / errored). NULL rows fall through to the CTE's LIVE
//             flag-join backstop; a stamped true/false is authoritative.
//
// Caching (findings from adversarial review):
//   - We cache ONLY userId + avatarId results, which derive from an IMMUTABLE
//     user property (`users.is_guest` never flips in-place — guests only
//     expire→delete). The agentId path is DERIVED THROUGH THE MUTABLE
//     `openclaw_bots.user_id` (`/connect` rebinds ownership), so it is NEVER
//     cached — always resolved fresh at write time.
//   - We NEVER cache a "no row found" result: a caller-supplied agentId/userId
//     with no row yet (e.g. the public skill route's `X-Clawville-Agent-Id`)
//     must not poison a later real binding with a stale `false`.
//   - The cache-MISS lookups for an event run in ONE transaction (a single
//     `SET LOCAL statement_timeout` + one SELECT per miss), so a multi-id event
//     costs one BEGIN/COMMIT, not three, and the caller-visible worst case is
//     one deadline, not N×. Bounding: `SET LOCAL statement_timeout` is the REAL
//     server-side cancel (an abandoned lookup can't hold a pooled connection);
//     `withResolveTimeout` is the client-side belt (covers a hang while still
//     acquiring the pool connection, before SET LOCAL runs) → the caller gets
//     null and never stalls. Systemic pool-level statement_timeout is FILED to
//     the database domain (packages/database client config).
const guestResolveCache = new Map<string, boolean>();
const GUEST_RESOLVE_CACHE_MAX = 20_000;
const GUEST_RESOLVE_TIMEOUT_MS = 750;

function withResolveTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guarded = p.finally(() => clearTimeout(timer));
  // Register a terminal handler so that if the timeout WINS the race and `p`
  // (the abandoned transaction) later REJECTS, the rejection is not "unhandled"
  // (classic Promise.race footgun → Node unhandledRejection). This does not
  // change what the race returns; it only prevents the orphaned branch's
  // rejection from surfacing globally. (The abandoned query itself is bounded
  // server-side by SET LOCAL statement_timeout; a pool-level statement_timeout
  // is filed to the database domain for the pool-checkout-phase.)
  guarded.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('guest-resolve-timeout')), GUEST_RESOLVE_TIMEOUT_MS);
  });
  return Promise.race([guarded, timeout]);
}

// One-SELECT-per-id inside a caller-supplied tx. Returns true (guest) / false
// (non-guest row) / null (no row) — no throw handling here; the caller's
// try/catch + timeout wrap the whole transaction.
async function lookupGuest(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  kind: 'u' | 'a' | 'g',
  id: string,
): Promise<boolean | null> {
  let rows: Array<{ g: boolean | null }>;
  if (kind === 'u') {
    rows = await tx.select({ g: users.isGuest }).from(users).where(eq(users.id, id)).limit(1);
  } else if (kind === 'a') {
    // SoT via the avatar's owner (not the denormalized avatars.is_guest mirror).
    rows = await tx.select({ g: users.isGuest }).from(avatars)
      .innerJoin(users, eq(users.id, avatars.userId)).where(eq(avatars.id, id)).limit(1);
  } else {
    rows = await tx.select({ g: users.isGuest }).from(agentBots)
      .innerJoin(users, eq(users.id, agentBots.userId)).where(eq(agentBots.agentId, id)).limit(1);
  }
  return rows.length === 0 ? null : !!rows[0].g;
}

async function resolveSubjectWasGuest(input: EventInput): Promise<boolean | null> {
  const ids: Array<['u' | 'a' | 'g', string]> = [];
  if (input.userId) ids.push(['u', input.userId]);
  if (input.avatarId) ids.push(['a', input.avatarId]);
  if (input.agentId) ids.push(['g', input.agentId]);
  if (ids.length === 0) return null;

  const resolved = new Map<string, boolean | null>();
  const misses: Array<['u' | 'a' | 'g', string]> = [];
  for (const [kind, id] of ids) {
    if (kind !== 'g') {
      const c = guestResolveCache.get(`${kind}:${id}`);
      if (c !== undefined) { resolved.set(`${kind}:${id}`, c); continue; }
    }
    misses.push([kind, id]);
  }

  if (misses.length > 0) {
    try {
      const pairs = await withResolveTimeout(
        db.transaction(async (tx) => {
          // Fixed literal (never user input) — safe under sql.raw.
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${GUEST_RESOLVE_TIMEOUT_MS}`));
          const out: Array<[string, boolean | null]> = [];
          for (const [kind, id] of misses) {
            out.push([`${kind}:${id}`, await lookupGuest(tx, kind, id)]);
          }
          return out;
        }),
      );
      for (const [k, r] of pairs) {
        resolved.set(k, r);
        // Cache ONLY definitive user/avatar results (immutable). Never agent
        // (mutable ownership), never null (no-row anti-poison).
        if (r !== null && !k.startsWith('g:')) {
          if (guestResolveCache.size >= GUEST_RESOLVE_CACHE_MAX) guestResolveCache.clear();
          guestResolveCache.set(k, r);
        }
      }
    } catch {
      // Transaction / timeout / error → every miss is INDETERMINATE (null).
      for (const [kind, id] of misses) resolved.set(`${kind}:${id}`, null);
    }
  }

  // Three-way OR: ANY id guest → true. Otherwise false ONLY when EVERY present
  // id resolved to a DEFINITIVE non-guest; any INDETERMINATE (null) id → null so
  // the CTE's live-join backstop still checks — a null must never be laundered
  // into an authoritative `false` by a sibling `false`.
  let allDefinitivelyNonGuest = true;
  for (const [kind, id] of ids) {
    const r = resolved.get(`${kind}:${id}`) ?? null;
    if (r === true) return true;
    if (r === null) allDefinitivelyNonGuest = false;
  }
  return allDefinitivelyNonGuest ? false : null;
}

// ─── Q2 Activity Portals — event taxonomy ──────────────────────────────────
//
// These are the new event_type strings introduced by the Q2 activity-portal
// phase. Listed here so call sites can reference them by symbol rather than
// retyping the string literal everywhere; logEvent() still accepts any
// `eventType: string` for backwards compat.
//
// Doc-side reference: backend §5.5 "event emissions" + plan resolved
// decisions §11.
//
// `activity.match.placed` and `agent.collaboration.turn` (kind:
// 'activity-co-play') are both consumed by the free-agent leaderboard via
// AGENT_SCORE_WEIGHTS.activityPlacement (chunk #7). The other event types
// here back the `/dash` activity tiles.

export const ACTIVITY_EVENT_TYPES = {
  QUEUE_JOINED: 'activity.queue.joined',
  QUEUE_LEFT: 'activity.queue.left',
  MATCH_STARTED: 'activity.match.started',
  MATCH_ENDED: 'activity.match.ended',
  MATCH_PLACED: 'activity.match.placed',
  MATCH_SWEPT: 'activity.match.swept',
  MATCH_ABORTED_CRASH: 'activity.match.aborted_crash',
  ANTI_CHEAT_FLAG: 'anti_cheat.flag',
  POD_PRESSURE: 'activity.pod.pressure',
} as const;

export type ActivityEventType =
  (typeof ACTIVITY_EVENT_TYPES)[keyof typeof ACTIVITY_EVENT_TYPES];

// Typed payload shapes — each one is the shape of `payload` for that event.
// Useful for IDE completion at emit sites; logEvent() doesn't enforce them
// (the table is JSONB, so over-tightening is counterproductive).

export interface ActivityQueueJoinedPayload {
  activityId: string;
  partyId: string | null;
  subjectType: 'human' | 'agent';
  agentOnly?: boolean;
}

export interface ActivityQueueLeftPayload {
  activityId: string;
  reason: 'voluntary' | 'matched' | 'timeout' | 'pod_restart';
  roomId?: string;
}

export interface ActivityMatchStartedPayload {
  activityId: string;
  roomId: string;
  participantCount: number;
  hasBots: boolean;
  hasAgents: boolean;
}

export interface ActivityMatchEndedPayload {
  activityId: string;
  roomId: string;
  durationMs: number;
  reason: 'complete' | 'forfeit' | 'aborted';
}

export interface ActivityMatchPlacedPayload {
  activityId: string;
  roomId: string;
  placement: number;
  score: number;
  tokensAwarded: number;
  leaderboardPoints: number;
  subjectType: 'human' | 'agent' | 'bot';
  /**
   * True when the participant is an un-authed guest (created via
   * `POST /api/auth/guest`).
   *
   * NOTE (2026-07-10): guests are now EXCLUDED from the free-agent leaderboard
   * (founder-confirmed full exclusion), but NOT via this payload key — the
   * exclusion is the durable `events.subject_was_guest` event-time stamp +
   * a `users.is_guest` live-join backstop in `buildAgentSnapshot` (see
   * ARCHITECTURE.md §5b). This key is retained for `/dash` + forensics only;
   * the scoring CTE does not read it. Defaults to undefined for non-guest writers.
   */
  isGuest?: boolean;
}

export interface ActivityMatchSweptPayload {
  activityId: string;
  roomId: string;
  reason:
    | 'pending_empty'
    | 'live_no_ws'
    | 'countdown_underfill'
    | 'results_retention';
  playerCount?: number;
}

export interface ActivityMatchAbortedCrashPayload {
  activityId: string;
  roomId: string;
  errorStack?: string;
  recoveredAt?: string;
  reason?: 'sim_exception' | 'pod_restart_orphan';
}

export interface ActivityAntiCheatFlagPayload {
  kind:
    | 'overspeed'
    | 'overaccel'
    | 'underminlap'
    | 'seq_gap'
    | 'ghost_input'
    | 'checkpoint_skip'
    | 'powerup_unowned'
    // Reef Race v2 (spline sim) anti-cheat — replaces lap-time +
    // checkpoint-sequence with progress-monotonic + per-segment time
    // check. See `.claude/plans/reef-race-v2-spline-architecture.md` §6.
    | 'progress_regression'
    | 'segment_too_fast';
  activityId: string;
  roomId: string;
  detail?: Record<string, unknown>;
}

export interface ActivityPodPressurePayload {
  cpuPct?: number;
  memPct?: number;
  level: 'warn' | 'reduce_tick' | 'refuse_new_rooms';
}

// ─── agent.connected rapid-reconnect coalescing (Fix B, 2026-06-03) ─────────
//
// Defense-in-depth backstop for the uncapped agent.connected session farm.
// The authoritative fix is the leaderboard-side per-day distinct-session cap
// (DAILY_CAPS.session in leaderboard.ts); this emission-side gate additionally
// DROPS duplicate `agent.connected` rows for the same (subject, fingerprint)
// within a short window so a replayed / rapid re-register doesn't even write an
// extra session row in the first place. It is fingerprint-scoped (a real new
// browser/session legitimately earns a new row); the DB daily cap remains the
// fp-independent authority.
const AGENT_CONNECTED_COALESCE_MS = 60_000;
const AGENT_CONNECTED_MAP_MAX = 10_000;
const lastAgentConnectedAt = new Map<string, number>();

/**
 * Pure-ish coalescing gate for `agent.connected` emission.
 *
 * Returns `true` (EMIT) on the first call for `subjectKey`, or once
 * AGENT_CONNECTED_COALESCE_MS has elapsed since the last recorded emit for that
 * key; returns `false` (SKIP) when a prior emit is still within the window. On
 * an EMIT decision it records `nowMs` as the new last-emit time. Exported so the
 * leaderboard self-tests can drive it directly with an injected clock.
 *
 * Includes an opportunistic, size-bounded cleanup: when the map grows past
 * AGENT_CONNECTED_MAP_MAX entries, stale entries (older than the window) are
 * evicted so a long-lived process with many distinct subjects can't leak memory.
 */
export function shouldEmitAgentConnected(subjectKey: string, nowMs: number): boolean {
  const last = lastAgentConnectedAt.get(subjectKey);
  if (last !== undefined && nowMs - last < AGENT_CONNECTED_COALESCE_MS) {
    // Within the coalescing window — duplicate connect, drop it.
    return false;
  }

  // Opportunistic eviction BEFORE recording the new key so the size guard also
  // bounds the set we're about to grow.
  if (lastAgentConnectedAt.size >= AGENT_CONNECTED_MAP_MAX) {
    for (const [k, t] of lastAgentConnectedAt) {
      if (nowMs - t >= AGENT_CONNECTED_COALESCE_MS) lastAgentConnectedAt.delete(k);
    }
  }

  lastAgentConnectedAt.set(subjectKey, nowMs);
  return true;
}

/**
 * Insert core shared by `logEvent` (void) and `logEventReturningId` (id). Same
 * never-throws contract, same sanitization, same three-tier fallback. Returns
 * the inserted `events.id` on the happy path, or `null` when the row was
 * coalesced away (agent.connected dedupe) or BOTH inserts failed.
 */
async function writeEvent(input: EventInput): Promise<bigint | null> {
  // Fix B — coalesce rapid-reconnect agent.connected duplicates BEFORE any
  // insert. Subject precedence agentId → avatarId → userId; key includes the
  // fingerprint so distinct browsers stay independent. When no subject can be
  // resolved we do NOT coalesce (always emit) — a null subject can't be farmed.
  if (input.eventType === 'agent.connected') {
    const subj = input.agentId ?? input.avatarId ?? input.userId ?? null;
    if (subj !== null) {
      const key = `${subj}:${input.fpHash ?? 'nofp'}`;
      if (!shouldEmitAgentConnected(key, Date.now())) {
        return null;
      }
    }
  }

  // Central raw-bearer redaction (see RAW_BEARER_RE block above). Applied to the
  // `session_id` AND `agent_id` columns and run over the (already secret-key-
  // sanitized) payload so a RAW agent-session bearer can never land in the events
  // table from ANY call site or caller-supplied header. Idempotent: an already-
  // digested value is left unchanged.
  //
  // `agent_id` IS redacted here, safely: the EXACT-shape regex only matches a real
  // bearer (`<prefix>-`+32 url-safe chars), never a legit grouping handle
  // (`oc-mybot`, `milady:x`, `agent-<ts>-<rand>`, a UUID), so leaderboard
  // `GROUP BY agent_id` is preserved. This closes the spoofable-header injection
  // path: skills.ts logs the caller-supplied `X-Clawville-Agent-Id` into
  // events.agent_id, and a client could put a raw `ag-/oc-/hat-` bearer there.
  // Freeze the subject's guest-ness on the row (durable leaderboard exclusion —
  // see resolveSubjectWasGuest). Best-effort + never throws.
  const subjectWasGuest = await resolveSubjectWasGuest(input);

  const row = {
    eventType: input.eventType,
    userId: input.userId ?? null,
    agentId: redactBearer(input.agentId ?? null) as string | null,
    avatarId: input.avatarId ?? null,
    buildingId: input.buildingId ?? null,
    sessionId: redactBearer(input.sessionId ?? null) as string | null,
    payload: redactBearersDeep(sanitize(input.payload)) as Record<string, unknown> | undefined,
    subjectWasGuest,
    fpHash: input.fpHash ?? null,
    ipPrefixHash: input.ipPrefixHash ?? null,
  };

  try {
    // RETURNING id so callers that need the durable cursor (P3 slice 1 — the
    // live settlement-confirm push cites this as the SSE `id:`) can capture it;
    // `logEvent` discards it, so existing call sites are unaffected.
    const inserted = await db.insert(events).values(row).returning({ id: events.id });
    return inserted[0]?.id ?? null;
  } catch (primaryErr) {
    try {
      await db.insert(eventWriteFailures).values({
        attemptedEventType: input.eventType,
        attemptedRow: row,
        errorMessage: String(primaryErr),
        errorStack: (primaryErr as Error)?.stack,
      });
      return null;
    } catch (secondaryErr) {
      console.warn(
        '[event-logger] DOUBLE FAILURE',
        input.eventType,
        primaryErr,
        secondaryErr,
      );
      await alertError({
        severity: 'critical',
        source: 'event-logger',
        message:
          'Both events and event_write_failures inserts failed. Database likely unreachable.',
        context: {
          eventType: input.eventType,
          primaryError: String(primaryErr),
          secondaryError: String(secondaryErr),
        },
      });
      return null;
    }
  }
}

export async function logEvent(input: EventInput): Promise<void> {
  await writeEvent(input);
}

/**
 * Same as `logEvent` but returns the inserted `events.id` (or null on
 * coalesce/failure). Use ONLY where the durable cursor is needed downstream
 * (P3 slice 1 settlement-confirm delivery). Same never-throws contract.
 */
export async function logEventReturningId(input: EventInput): Promise<bigint | null> {
  return writeEvent(input);
}

/**
 * Phase 1 anti-farm helper — pulls fpHash + ipPrefixHash from request
 * context (set by global fingerprintMiddleware) and forwards to logEvent.
 *
 * Use this from any Hono route handler. System / cron writes that have no
 * Hono context call logEvent directly with fp/ip null — those rows are
 * inherently exempt from anti-farm caps because they aren't attributable
 * to a single browser session.
 *
 * Returns Promise<void> with the same never-throws contract as logEvent.
 */
export async function logEventFromContext(
  c: FingerprintedContext,
  input: EventInput,
): Promise<void> {
  await logEventFromContextReturningId(c, input);
}

/**
 * `logEventFromContext` variant that returns the inserted `events.id` (or null).
 * Same fp/ip context extraction; use where the durable cursor is needed
 * downstream (P3 slice 1 cove settlement-confirm delivery).
 */
export async function logEventFromContextReturningId(
  c: FingerprintedContext,
  input: EventInput,
): Promise<bigint | null> {
  const fpHash = c.get('fpHash');
  const ipPrefixHash = c.get('ipPrefixHash');
  return logEventReturningId({
    ...input,
    fpHash:
      input.fpHash ?? (typeof fpHash === 'string' ? fpHash : null),
    ipPrefixHash:
      input.ipPrefixHash ?? (typeof ipPrefixHash === 'string' ? ipPrefixHash : null),
  });
}
