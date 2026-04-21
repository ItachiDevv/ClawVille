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

// Keys matching this regex get [REDACTED] before insert. The (?!or) on `auth`
// excludes `author` (writer credit) while keeping `authToken` / `auth` blocked.
// Known hole: `authorization` is NOT blocked (also matches the lookahead). In
// practice we never put HTTP Authorization headers in event payloads, so this
// is acceptable — but if a future emitter does, tighten this regex first.
const SENSITIVE_KEY = /token|secret|auth(?!or)|apiKey|password|privateKey/i;

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
      if (SENSITIVE_KEY.test(k)) return [k, '[REDACTED]'];
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
