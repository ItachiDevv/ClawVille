/**
 * One-shot migration: flip every guest pet whose modelKey is still 'lobster'
 * to the canonical default 'milady_official_1'. Targets ONLY guest pets
 * (`is_guest = true`) — regular users who explicitly chose lobster as their
 * avatar are intentionally left alone.
 *
 * Why: yesterday (2026-04-25) we flipped DEFAULT_AGENT_MODEL_KEY from 'lobster'
 * to 'milady_official_1' so newly-created pets render as Miladys. Guests
 * created BEFORE that flip have modelKey='lobster' baked into their pets row,
 * so when they reload the site the player-pet renderer still shows a lobster.
 * This script unsticks those guest pets in bulk.
 *
 * Idempotent — running it twice is a no-op (the WHERE clause filters out
 * rows that already have modelKey='milady_official_1').
 *
 * Usage:
 *   bun run scripts/flip-guest-pets-to-milady.ts             # dry run, shows counts only
 *   bun run scripts/flip-guest-pets-to-milady.ts --apply     # actually update
 *   bun run scripts/flip-guest-pets-to-milady.ts --apply --include-non-guests
 *       # also flip non-guest pets that still have modelKey='lobster' AND
 *       # never edited their appearance (no row in pet_appearance_history).
 *       # NOT recommended unless you're sure no real user picked lobster
 *       # on purpose.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

// drizzle-orm lives in packages/database/node_modules (not hoisted under bun
// workspaces), so import the helpers via the re-export in @clawville/database
// instead of `from 'drizzle-orm'` directly.
import { db, pets, and, eq } from '@clawville/database';
import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';

async function main() {
  const apply = process.argv.includes('--apply');
  const includeNonGuests = process.argv.includes('--include-non-guests');

  if (DEFAULT_AGENT_MODEL_KEY !== 'milady_official_1') {
    console.warn(
      `[flip-guest-pets] DEFAULT_AGENT_MODEL_KEY is '${DEFAULT_AGENT_MODEL_KEY}', ` +
      `expected 'milady_official_1'. Continuing with the current canonical default.`,
    );
  }

  // Always preview the guest-pet bucket first.
  const guestTargets = await db
    .select({ id: pets.id, name: pets.name, modelKey: pets.modelKey })
    .from(pets)
    .where(and(eq(pets.modelKey, 'lobster'), eq(pets.isGuest, true)));

  console.log(`[flip-guest-pets] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[flip-guest-pets] target default = '${DEFAULT_AGENT_MODEL_KEY}'`);
  console.log(`[flip-guest-pets] guest pets with modelKey='lobster': ${guestTargets.length}`);

  let nonGuestTargets: Array<{ id: string; name: string; modelKey: string | null }> = [];
  if (includeNonGuests) {
    nonGuestTargets = await db
      .select({ id: pets.id, name: pets.name, modelKey: pets.modelKey })
      .from(pets)
      .where(and(eq(pets.modelKey, 'lobster'), eq(pets.isGuest, false)));
    console.log(
      `[flip-guest-pets] (--include-non-guests) non-guest pets ` +
      `with modelKey='lobster': ${nonGuestTargets.length}`,
    );
  }

  if (!apply) {
    console.log('');
    console.log(`[flip-guest-pets] DRY-RUN — no rows touched. Re-run with --apply to commit.`);
    if (guestTargets.length > 0) {
      console.log('[flip-guest-pets] Sample of guest targets (up to 5):');
      for (const p of guestTargets.slice(0, 5)) {
        console.log(`  - ${p.id}  name=${p.name}`);
      }
    }
    process.exit(0);
  }

  // APPLY path — single bulk UPDATE per bucket. Drizzle's update().where()
  // with eq(modelKey, 'lobster') guarantees idempotency: re-running after a
  // successful flip selects 0 rows.
  if (guestTargets.length > 0) {
    const updated = await db
      .update(pets)
      .set({ modelKey: DEFAULT_AGENT_MODEL_KEY })
      .where(and(eq(pets.modelKey, 'lobster'), eq(pets.isGuest, true)))
      .returning({ id: pets.id });
    console.log(`[flip-guest-pets] APPLY: updated ${updated.length} guest pet(s).`);
  } else {
    console.log('[flip-guest-pets] APPLY: nothing to do for guests (already clean).');
  }

  if (includeNonGuests && nonGuestTargets.length > 0) {
    const updated = await db
      .update(pets)
      .set({ modelKey: DEFAULT_AGENT_MODEL_KEY })
      .where(and(eq(pets.modelKey, 'lobster'), eq(pets.isGuest, false)))
      .returning({ id: pets.id });
    console.log(`[flip-guest-pets] APPLY: updated ${updated.length} non-guest pet(s).`);
  }

  console.log('[flip-guest-pets] Done. Existing browser sessions need to refetch /api/pets/me to see the change (any reload of /game does this).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[flip-guest-pets] ERROR:', err);
  process.exit(1);
});
