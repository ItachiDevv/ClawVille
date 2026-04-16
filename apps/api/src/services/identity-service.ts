/**
 * Phase 5 — identity bootstrap for agent-first onboarding.
 *
 * Converts the `{identityType, identityKey}` the agent presents on
 * `/api/agent/connect` or `/api/agent/join` into a stable `users` row.
 * The identity is hashed (SHA-256 over `${type}:${key}`) and stored on
 * `users.identity_fingerprint`, which is UNIQUE — so two concurrent
 * connects with the same identity race-safely resolve to the same user.
 *
 * Race-condition story (spec §10 audit note): both callers may observe
 * "user not found" before inserting. The first INSERT wins; the second
 * hits a 23505 unique violation. We catch that, re-read the row, and
 * return it. No distributed lock, no advisory lock — Postgres's own
 * UNIQUE constraint is the serializer.
 */

import { createHash } from 'crypto';
import { db, users, eq } from '@clawville/database';

/**
 * Stable hash of `{type}:{key}` as hex SHA-256 (64 chars). The colon
 * separator means `milady:abc` and `miladyabc:` can never collide even
 * if an agent sends a weird `type` with a trailing colon.
 */
export function identityFingerprint(identityType: string, identityKey: string): string {
  return createHash('sha256')
    .update(`${identityType}:${identityKey}`)
    .digest('hex');
}

export interface IdentityUser {
  id: string;
  email: string | null;
  name: string | null;
  identityFingerprint: string | null;
  isNewUser: boolean;
}

/**
 * Resolve the user row for an agent identity, creating a minimal row
 * if one doesn't exist yet. Never returns null — any DB failure that
 * isn't a handled-race throws.
 *
 * The created user row has:
 *   - `email = null`, `password_hash = null` — the CHECK constraint
 *     `users_has_auth_method` is satisfied via `identity_fingerprint`.
 *   - `name` defaulted to a human-readable slice of the identity key so
 *     Milady/OpenClaw agents show up in admin listings with something
 *     meaningful even before the human adds recovery credentials.
 *
 * Postgres error code 23505 = unique_violation. If two requests race
 * into the "not found → insert" window, the loser catches 23505 and
 * re-reads. The re-read is authoritative because the winner has
 * already committed by the time the loser's insert errors.
 */
export async function resolveOrCreateUserByIdentity(
  identityType: string,
  identityKey: string,
): Promise<IdentityUser> {
  const fingerprint = identityFingerprint(identityType, identityKey);

  // 1. Try to find an existing row by fingerprint.
  const existing = await db.query.users.findFirst({
    where: eq(users.identityFingerprint, fingerprint),
  });
  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      identityFingerprint: existing.identityFingerprint,
      isNewUser: false,
    };
  }

  // 2. Not found — try to insert. Friendly default name: `Agent <first-8-of-key>`.
  //    The key might itself be a UUID or a long hash, so slicing keeps
  //    admin surfaces readable without leaking the full identity.
  const displayName = `Agent ${identityKey.slice(0, 8)}`;

  try {
    const [inserted] = await db
      .insert(users)
      .values({
        email: null,
        passwordHash: null,
        name: displayName,
        identityFingerprint: fingerprint,
      })
      .returning();

    return {
      id: inserted.id,
      email: inserted.email,
      name: inserted.name,
      identityFingerprint: inserted.identityFingerprint,
      isNewUser: true,
    };
  } catch (err: unknown) {
    // 3. Race-loser path — the concurrent caller beat us to the insert.
    //    Catch the unique-violation and re-read. Any other error is a
    //    real failure and rethrows.
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;

    if (code !== '23505') throw err;

    const raced = await db.query.users.findFirst({
      where: eq(users.identityFingerprint, fingerprint),
    });
    if (!raced) {
      // Exceptionally unlikely — either the DB is lying or the
      // concurrent INSERT rolled back after we saw it. Surface loudly.
      throw new Error('Identity fingerprint race: row vanished after 23505');
    }
    return {
      id: raced.id,
      email: raced.email,
      name: raced.name,
      identityFingerprint: raced.identityFingerprint,
      isNewUser: false,
    };
  }
}
