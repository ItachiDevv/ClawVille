/**
 * One-off audit: where did the 77 non-guest pets come from?
 *
 * Group them by:
 *   - whether their owner user has is_guest=true (orphan flag mismatch?)
 *   - whether the user has an email (real signup vs anonymous)
 *   - whether they have an openclaw_bots row (came from agent connect)
 *   - creation date histogram
 *
 * Read-only. Just print findings.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, pets, users, openclawBots, sql, eq } from '@clawville/database';

async function main() {
  // 1. Total counts
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(pets);
  const [{ guestPets }] = await db
    .select({ guestPets: sql<number>`count(*)::int` })
    .from(pets)
    .where(eq(pets.isGuest, true));
  const [{ nonGuestPets }] = await db
    .select({ nonGuestPets: sql<number>`count(*)::int` })
    .from(pets)
    .where(eq(pets.isGuest, false));

  console.log(`[audit] total pets:     ${total}`);
  console.log(`[audit]   is_guest=true: ${guestPets}`);
  console.log(`[audit]   is_guest=false: ${nonGuestPets}`);
  console.log('');

  // 2. Cross-reference: how many non-guest pets have a guest owner user?
  const flagMismatch = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM ${pets} p
    JOIN ${users} u ON u.id = p.user_id
    WHERE p.is_guest = false AND u.is_guest = true
  `);
  console.log(`[audit] non-guest pets whose OWNER is a guest: ${(flagMismatch[0] as any)?.c ?? 0}`);

  // 3. Non-guest pets WITHOUT email on their user (i.e. anonymous account)
  const noEmail = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM ${pets} p
    JOIN ${users} u ON u.id = p.user_id
    WHERE p.is_guest = false
      AND (u.email IS NULL OR u.email = '')
  `);
  console.log(`[audit] non-guest pets whose user has NO email: ${(noEmail[0] as any)?.c ?? 0}`);

  // 4. Non-guest pets whose user_id matches an openclaw_bots.user_id
  //    (= the user has connected agents — likely a real account, not orphan)
  const fromAgent = await db.execute(sql`
    SELECT COUNT(DISTINCT p.id)::int AS c
    FROM ${pets} p
    JOIN ${openclawBots} b ON b.user_id = p.user_id
    WHERE p.is_guest = false
  `);
  console.log(`[audit] non-guest pets whose user has connected agents: ${(fromAgent[0] as any)?.c ?? 0}`);

  // 5. Creation-date breakdown for non-guest pets
  console.log('');
  console.log('[audit] non-guest pets by creation week:');
  const byWeek = await db.execute(sql`
    SELECT
      to_char(date_trunc('week', p.created_at), 'YYYY-MM-DD') AS week,
      COUNT(*)::int AS c
    FROM ${pets} p
    WHERE p.is_guest = false
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 10
  `);
  for (const row of byWeek) {
    console.log(`  ${(row as any).week}  ${(row as any).c}`);
  }

  // 6. Sample 8 — name + user_email + has_bot for inspection
  console.log('');
  console.log('[audit] sample of 8 non-guest pets:');
  const sample = await db.execute(sql`
    SELECT
      p.name AS pet_name,
      p.is_guest AS pet_is_guest,
      u.is_guest AS user_is_guest,
      COALESCE(u.email, '') AS email,
      EXISTS(SELECT 1 FROM ${openclawBots} b WHERE b.user_id = p.user_id) AS user_has_bot,
      to_char(p.created_at, 'YYYY-MM-DD') AS created
    FROM ${pets} p
    JOIN ${users} u ON u.id = p.user_id
    WHERE p.is_guest = false
    ORDER BY p.created_at DESC
    LIMIT 8
  `);
  for (const row of sample) {
    const r = row as any;
    console.log(
      `  ${r.created}  pet=${r.pet_name}  user_is_guest=${r.user_is_guest}  ` +
      `email=${r.email || '(none)'}  user_has_bot=${r.user_has_bot}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[audit] ERROR:', err);
  process.exit(1);
});
