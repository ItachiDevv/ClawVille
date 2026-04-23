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
  petId?: string | null;
  buildingId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
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
    | 'underminlap'
    | 'seq_gap'
    | 'ghost_input'
    | 'checkpoint_skip'
    | 'powerup_unowned';
  activityId: string;
  roomId: string;
  detail?: Record<string, unknown>;
}

export interface ActivityPodPressurePayload {
  cpuPct?: number;
  memPct?: number;
  level: 'warn' | 'reduce_tick' | 'refuse_new_rooms';
}

export async function logEvent(input: EventInput): Promise<void> {
  const row = {
    eventType: input.eventType,
    userId: input.userId ?? null,
    agentId: input.agentId ?? null,
    petId: input.petId ?? null,
    buildingId: input.buildingId ?? null,
    sessionId: input.sessionId ?? null,
    payload: sanitize(input.payload),
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
