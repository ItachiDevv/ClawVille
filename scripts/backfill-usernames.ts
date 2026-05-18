/**
 * scripts/backfill-usernames.ts — one-off backfill for the username column
 * added in 2026-05-19. Idempotent: only touches rows where users.username
 * IS NULL. Skips rows where the candidate name collides with another
 * user's already-claimed username (those need manual triage — extremely
 * rare since avatar.name had its own UNIQUE constraint pre-existing).
 *
 * Run AFTER `bun run db:push` lands the new column:
 *   bun run scripts/backfill-usernames.ts
 *
 * Output:
 *   - one line per user with the chosen name
 *   - final summary: { backfilled, skipped, collisions }
 */

import { db, users, avatars, eq, and, isNull, sql, desc } from '@clawville/database';

interface BackfillRow {
  userId: string;
  candidate: string;
}

async function main() {
  console.log('[backfill-usernames] scanning…');

  // Users with no username AND at least one avatar. The leftmost avatar
  // (lowest createdAt) wins — that's the closest to "your first identity
  // on the platform" and matches the create-time semantics.
  const candidates = await db
    .select({
      userId: users.id,
      avatarName: avatars.name,
      avatarCreatedAt: avatars.createdAt,
    })
    .from(users)
    .innerJoin(avatars, eq(avatars.userId, users.id))
    .where(isNull(users.username))
    .orderBy(users.id, avatars.createdAt);

  // Group by userId, keep first avatar name (oldest).
  const firstByUser = new Map<string, BackfillRow>();
  for (const row of candidates) {
    if (!firstByUser.has(row.userId)) {
      firstByUser.set(row.userId, { userId: row.userId, candidate: row.avatarName });
    }
  }

  console.log(`[backfill-usernames] ${firstByUser.size} user(s) need a username`);

  let backfilled = 0;
  let skipped = 0;
  let collisions = 0;

  for (const { userId, candidate } of firstByUser.values()) {
    // Format guard: legacy avatars MIGHT have characters we no longer
    // accept (older versions allowed wider regex). Skip those and let
    // the user pick a fresh handle from settings.
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(candidate)) {
      console.log(`[skip-format] ${userId}: "${candidate}" — fails new username regex`);
      skipped += 1;
      continue;
    }

    // Race-safe: this UPDATE will fail with 23505 if someone else just
    // claimed the same username via PATCH. Wrap in try/catch and log.
    try {
      const updated = await db
        .update(users)
        .set({ username: candidate, updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.username)))
        .returning({ id: users.id, username: users.username });

      if (updated.length === 0) {
        // Row already has a username by the time we got here.
        skipped += 1;
        continue;
      }
      console.log(`[ok] ${userId} → ${candidate}`);
      backfilled += 1;
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } } | null)?.code
        ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') {
        console.log(`[collide] ${userId}: "${candidate}" already taken by another user`);
        collisions += 1;
      } else {
        throw err;
      }
    }
  }

  console.log('\n[backfill-usernames] summary:', { backfilled, skipped, collisions });

  if (collisions > 0) {
    console.log(
      '\n  Note: collision rows need manual resolution. The user can pick a fresh username via PATCH /api/users/me/username — meanwhile their public surface falls back to avatar.name.',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-usernames] fatal:', err);
  process.exit(1);
});
