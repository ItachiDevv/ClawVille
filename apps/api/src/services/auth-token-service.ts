/**
 * Email-flow token issuance + atomic consume.
 *
 * Mirrors the `session-ticket-service` pattern:
 *   - Raw token is 32 random bytes encoded as URL-safe hex (64 chars).
 *   - DB only ever holds `sha256(raw_token)` in `tokenHash` — so a DB
 *     dump never reveals a usable reset link.
 *   - `consumeToken` runs a single UPDATE ... SET consumed_at = now()
 *     WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL
 *     AND expires_at > now() RETURNING *. Two concurrent redeem requests
 *     can never both succeed because Postgres row-level locking
 *     guarantees exactly one returns the row.
 *
 * Two purposes live on the same table; the `purpose` predicate in the
 * WHERE clause is defense-in-depth so a `password-reset` consumer can
 * never accept a token issued for `email-verify`.
 */

import { randomBytes, createHash } from 'crypto';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { db, authTokens, sql } from '@clawville/database';

export type AuthTokenPurpose = 'password-reset' | 'email-verify';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 60 min
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function ttlFor(purpose: AuthTokenPurpose): number {
  return purpose === 'password-reset' ? PASSWORD_RESET_TTL_MS : EMAIL_VERIFY_TTL_MS;
}

/**
 * 32 bytes of CSPRNG → 64-char hex. URL-safe by construction (only
 * 0-9a-f), no padding shenanigans, copy-pastes cleanly into mailto
 * links and command-line curl. We could base58 like the agent ticket
 * for a shorter string, but the email URL already wraps so the extra
 * characters cost nothing.
 */
function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface IssuedAuthToken {
  /** Raw token — caller MUST embed in the email URL, then discard. */
  rawToken: string;
  expiresAt: Date;
  purpose: AuthTokenPurpose;
  userId: string;
}

export async function issueAuthToken(params: {
  userId: string;
  purpose: AuthTokenPurpose;
}): Promise<IssuedAuthToken> {
  const { userId, purpose } = params;
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlFor(purpose));

  await db.insert(authTokens).values({
    userId,
    purpose,
    tokenHash,
    expiresAt,
  });

  return { rawToken, expiresAt, purpose, userId };
}

export interface ConsumedAuthToken {
  userId: string;
  purpose: AuthTokenPurpose;
}

/**
 * Atomically consume a token. Returns the `userId` + `purpose` on
 * success, `null` on any failure (invalid hash, expired, already
 * consumed, wrong purpose). Callers MUST treat all failures
 * identically — no leaking which case fired.
 */
export async function consumeAuthToken(params: {
  rawToken: string;
  purpose: AuthTokenPurpose;
}): Promise<ConsumedAuthToken | null> {
  const { rawToken, purpose } = params;
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);

  const updated = await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({
      userId: authTokens.userId,
      purpose: authTokens.purpose,
    });

  const row = updated[0];
  if (!row) return null;
  return {
    userId: row.userId,
    purpose: row.purpose as AuthTokenPurpose,
  };
}
