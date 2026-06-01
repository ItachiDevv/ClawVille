/**
 * Partner API-key middleware (Hatcher partner #2, Phase C — 2026-06-01).
 * See `.claude/plans/hatcher-integration.md` §4 (TIGHT auth, layers B + C).
 *
 * `requirePartnerKey(scope)` gates the HIGH-volume partner read surfaces (skill
 * manifest poll + per-building SKILL.md reads). It:
 *
 *   1. Reads `Authorization: Bearer <token>`, computes `sha256(token)`.
 *   2. Looks the row up by `key_hash` (UNIQUE) — the hash lookup IS the
 *      constant-time-ish compare (no plaintext stored, no string compare). A
 *      presented token either hashes to a stored value or it doesn't.
 *   3. Rejects (opaque 401) when: no/blank bearer · no matching row · row
 *      revoked · row missing the required scope. Every failure returns the
 *      SAME body so a caller can't distinguish "wrong key" from "missing scope"
 *      from "revoked".
 *   4. On success sets `partnerId` + `partnerScopes` on the Hono context and
 *      best-effort (non-blocking) bumps `last_used_at`.
 *
 * SECRET HANDLING: the raw token is hashed and discarded; it is never logged.
 * The hash-not-plaintext + show-once mint invariant lives in
 * `scripts/mint-partner-key.ts` + `packages/database/src/schema/partner-api-keys.ts`.
 *
 * PER-PARTNER RATE LIMIT (`partnerRateLimit(opts)`): a sibling middleware that
 * keys the token bucket on the VALIDATED `partnerId` from the context (set by an
 * upstream `requirePartnerKey`), NOT the client IP. A partner egresses all of
 * its agents from a single server IP, so a per-IP limiter would collapse every
 * agent into one bucket and throttle the whole partner the moment one agent is
 * busy. Keying on `partnerId` gives the partner one fair budget. MUST run AFTER
 * `requirePartnerKey` (it reads `c.get('partnerId')`); falls back to the client
 * IP only when no partner is set (defensive — shouldn't happen on a gated route).
 *
 * IN-MEMORY / POD-LOCAL: the bucket is per-Hono-process, like every other
 * limiter in this codebase (`createRateLimiter`). Multi-pod fan-out needs a
 * shared store (Redis) — flagged here + in the Phase 1 portal deferred finding.
 */

import { createHash } from 'crypto';
import type { MiddlewareHandler } from 'hono';
import { db, partnerApiKeys, eq } from '@clawville/database';
import { createRateLimiter, getClientIp } from './rate-limit';
import type { AppContext } from '../types';

/** sha256 → 64-char lowercase hex. MUST match `scripts/mint-partner-key.ts`. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Single opaque rejection body — never leaks WHY auth failed. */
const UNAUTHORIZED = { error: 'unauthorized' } as const;

/**
 * Gate a route on a valid, un-revoked partner API key that carries `scope`.
 * On success, `c.get('partnerId')` + `c.get('partnerScopes')` are populated for
 * downstream handlers + the per-partner limiter.
 */
export function requirePartnerKey(scope: string): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return c.json(UNAUTHORIZED, 401);
    }
    const token = auth.slice(7).trim();
    if (!token) {
      return c.json(UNAUTHORIZED, 401);
    }

    const keyHash = hashToken(token);

    let row:
      | {
          id: string;
          partnerId: string;
          scopes: string[];
          revokedAt: Date | null;
        }
      | undefined;
    try {
      row = await db.query.partnerApiKeys.findFirst({
        where: eq(partnerApiKeys.keyHash, keyHash),
        columns: { id: true, partnerId: true, scopes: true, revokedAt: true },
      });
    } catch (err) {
      // DB unreachable — fail closed (a partner read route must never open up on
      // a transient DB error). Opaque 401 keeps the failure indistinguishable.
      console.error('[partner-key] lookup failed:', err);
      return c.json(UNAUTHORIZED, 401);
    }

    // Missing row, revoked row, or scope not granted → identical opaque 401.
    if (!row || row.revokedAt || !row.scopes?.includes(scope)) {
      return c.json(UNAUTHORIZED, 401);
    }

    c.set('partnerId', row.partnerId);
    c.set('partnerScopes', row.scopes);

    // Best-effort, non-blocking last-used bump. Never await (don't add latency
    // to the read path) and never let a failure surface.
    void db
      .update(partnerApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(partnerApiKeys.id, row.id))
      .catch((err) => {
        console.error('[partner-key] last_used_at bump failed (non-fatal):', err);
      });

    await next();
  };
}

export interface PartnerRateLimitOptions {
  /** Max requests per partner per window. */
  maxPerWindow: number;
  /** Window length in ms. Default 60_000 (1 minute). */
  windowMs?: number;
}

/**
 * Per-partner token-bucket limiter. Keys on the validated `partnerId` (set by
 * an upstream `requirePartnerKey`), falling back to the client IP only when no
 * partner is on the context. Returns 429 with an opaque rate-limit body.
 *
 * Construct ONE per route group (the same isolated-bucket pattern as
 * `createRateLimiter`) so the manifest poll and a per-skill fetch don't share a
 * budget. POD-LOCAL — see file header re: the Redis swap for multi-pod.
 */
export function partnerRateLimit(
  opts: PartnerRateLimitOptions,
): MiddlewareHandler<AppContext> {
  const limiter = createRateLimiter({
    maxPerWindow: opts.maxPerWindow,
    windowMs: opts.windowMs ?? 60_000,
  });
  return async (c, next) => {
    // Prefer the validated partnerId; fall back to IP defensively (a gated route
    // always sets partnerId, but a misconfigured mount must still be bounded).
    const partnerId = c.get('partnerId');
    const bucketKey = partnerId
      ? `partner:${partnerId}`
      : `ip:${getClientIp(c.req.raw.headers)}`;
    if (!limiter.check(bucketKey)) {
      return c.json(
        { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
        429,
      );
    }
    await next();
  };
}
