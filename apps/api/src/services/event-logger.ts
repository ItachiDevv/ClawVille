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
 * PII/secret sanitization: any payload key matching /token|secret|auth|apiKey|password|privateKey/i
 * gets [REDACTED] before insert. Belt-and-suspenders — we should never pass
 * sensitive fields in a payload, but this catches accidents.
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

function sanitizeValue(v: unknown): unknown {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return v.map(sanitizeValue);
    return sanitize(v as Record<string, unknown>);
  }
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
}

export async function logEvent(input: EventInput): Promise<void> {
  const row = {
    eventType: input.eventType,
    userId: input.userId ?? null,
    agentId: input.agentId ?? null,
    avatarId: input.avatarId ?? null,
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
