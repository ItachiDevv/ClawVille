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

import { db, events, eventWriteFailures } from '@clawville/database';
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
// IDEMPOTENT BY CONSTRUCTION: `redactBearer` ONLY transforms a value that matches
// the RAW-bearer shape (`^(ag|oc|hat|claw)-<16+ url-safe chars>`). An already-
// digested 16-hex value (`a1b2c3d4e5f60718`) does NOT start with one of those
// prefixes, so it passes through UNCHANGED. Consequences:
//   (a) call sites that already pass `sessionDigest(sessionId)` are untouched
//       here (no double-digest),
//   (b) call sites / headers that pass a RAW bearer get digested here,
//   (c) `COUNT(DISTINCT session_id)` for `agent.connected` stays correct because
//       `sessionDigest` is a deterministic 1:1 map — the same raw session always
//       digests to the same value whether the digest happened at the call site or
//       here.
const RAW_BEARER_RE = /^(ag|oc|hat|claw)-[A-Za-z0-9_-]{16,}$/;

function redactBearer(v: unknown): unknown {
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
   * `POST /api/auth/guest`). The agent leaderboard SQL filters on
   * `payload->>'isGuest' <> 'true'` to keep guest results out of the
   * placement-tier credit, mirroring the existing bot exclusion.
   * Defaults to undefined (omitted) for non-guest writers — the JSON
   * filter coalesces a missing key to `''` which fails the `=` 'true'
   * test, so it's safe to leave off legacy emitters.
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

export async function logEvent(input: EventInput): Promise<void> {
  // Fix B — coalesce rapid-reconnect agent.connected duplicates BEFORE any
  // insert. Subject precedence agentId → avatarId → userId; key includes the
  // fingerprint so distinct browsers stay independent. When no subject can be
  // resolved we do NOT coalesce (always emit) — a null subject can't be farmed.
  if (input.eventType === 'agent.connected') {
    const subj = input.agentId ?? input.avatarId ?? input.userId ?? null;
    if (subj !== null) {
      const key = `${subj}:${input.fpHash ?? 'nofp'}`;
      if (!shouldEmitAgentConnected(key, Date.now())) {
        return;
      }
    }
  }

  // Central raw-bearer redaction (see RAW_BEARER_RE block above). Applied to the
  // `session_id` column and run over the (already secret-key-sanitized) payload so
  // a RAW agent-session bearer can never land in the events table from ANY call
  // site or caller-supplied header. Idempotent: an already-digested value is left
  // unchanged.
  //
  // NOT applied to `agent_id`: that column is the STABLE agent handle the
  // leaderboard groups by (GROUP BY / COUNT(DISTINCT) agent_id). A handle can
  // legitimately share a bearer prefix (an openclaw `data.agentId` may be
  // `oc-…`, identical in shape to an `oc-` SESSION bearer), so redacting it would
  // false-positive and split that agent's score across the raw handle (old rows)
  // and its digest (new rows). The bearer never legitimately lands in agent_id:
  // every call site that used a `?? sessionId` fallback already digests it
  // (`?? sessionDigest(sessionId)`), so there is nothing to redact here anyway.
  const row = {
    eventType: input.eventType,
    userId: input.userId ?? null,
    agentId: input.agentId ?? null,
    avatarId: input.avatarId ?? null,
    buildingId: input.buildingId ?? null,
    sessionId: redactBearer(input.sessionId ?? null) as string | null,
    payload: redactBearersDeep(sanitize(input.payload)) as Record<string, unknown> | undefined,
    fpHash: input.fpHash ?? null,
    ipPrefixHash: input.ipPrefixHash ?? null,
  };

  try {
    await db.insert(events).values(row);
    return;
  } catch (primaryErr) {
    try {
      await db.insert(eventWriteFailures).values({
        attemptedEventType: input.eventType,
        attemptedRow: row,
        errorMessage: String(primaryErr),
        errorStack: (primaryErr as Error)?.stack,
      });
      return;
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
    }
  }
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
  const fpHash = c.get('fpHash');
  const ipPrefixHash = c.get('ipPrefixHash');
  return logEvent({
    ...input,
    fpHash:
      input.fpHash ?? (typeof fpHash === 'string' ? fpHash : null),
    ipPrefixHash:
      input.ipPrefixHash ?? (typeof ipPrefixHash === 'string' ? ipPrefixHash : null),
  });
}
