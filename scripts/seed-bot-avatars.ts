/**
 * Q2 Activity Portals — seed the reserved bot-avatar pool used by the
 * activity matchmaker for backfill (chunk #10).
 *
 * Why pre-seeded rows?
 *   `activity_room_participants.avatar_id` is `uuid NOT NULL REFERENCES
 *   avatars(id)` — the schema explicitly says "avatar_id MUST exist in avatars
 *   even for bots". Rather than relax the FK or add a parallel `bot_id`
 *   column, we pre-create N avatar rows owned by N system bot users and
 *   reserve them per-room from `bot-pool.ts`.
 *
 * Idempotent — safe to run on every deploy. Only inserts missing rows;
 * never wipes existing.
 *
 * Order:
 *   1. `bun run db:push`            (apply schema)
 *   2. `bun run db:seed`            (seed map_locations)
 *   3. `bun run scripts/seed-activities.ts`
 *   4. `bun run scripts/seed-bot-avatars.ts`   ← this script
 *
 * Conventions (must match `apps/api/src/services/activity/bots/bot-pool.ts`):
 *   - email:  bot-NNN@bots.clawville.internal       (NNN = 001..064, zero-padded)
 *   - name:   Bot-Crab-NNN
 *   - species + color + gender + archetype: deterministic per index so
 *     replays look distinguishable on the client without leaking per-bot
 *     skill differences.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, users, avatars, eq } from '@clawville/database';

const BOT_POOL_CAPACITY = 64;
const BOT_USER_EMAIL_DOMAIN = '@bots.clawville.internal';
const BOT_PET_NAME_PREFIX = 'Bot-Crab-';

// Deterministic per-index trait pickers — keep replays visually
// distinguishable without leaking per-bot skill differences.
const SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const COLORS = ['green', 'red', 'blue', 'yellow'] as const;
const GENDERS = ['male', 'female'] as const;
const ARCHETYPE = 'brave-adventurer'; // benign default; bots never chat

function botUserEmail(index: number): string {
  return `bot-${String(index).padStart(3, '0')}${BOT_USER_EMAIL_DOMAIN}`;
}

function botAvatarName(index: number): string {
  return `${BOT_PET_NAME_PREFIX}${String(index).padStart(3, '0')}`;
}

async function seed(): Promise<void> {
  console.log(`Seeding ${BOT_POOL_CAPACITY} bot users + avatars…`);

  let usersCreated = 0;
  let petsCreated = 0;
  let usersExisting = 0;
  let petsExisting = 0;

  for (let i = 1; i <= BOT_POOL_CAPACITY; i++) {
    const email = botUserEmail(i);
    const name = botAvatarName(i);

    // 1. Upsert the system bot user.
    //
    // The `users_has_auth_method` CHECK constraint requires every user
    // to have EITHER (email + password_hash) OR identity_fingerprint.
    // Bots never log in, but we still need a non-null password_hash to
    // satisfy the constraint. We use a deterministic, unusable scrypt-
    // shaped placeholder — long enough to never collide with a real hash
    // and obvious enough at a glance that an admin won't try to guess it.
    const placeholderPasswordHash = `$bot$disabled$${String(i).padStart(3, '0')}-${Buffer.from(email).toString('base64')}`;
    let userId: string;
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (existingUser) {
      userId = existingUser.id;
      usersExisting++;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email,
          passwordHash: placeholderPasswordHash,
          name: `Bot Owner ${String(i).padStart(3, '0')}`,
          emailVerified: true,
        })
        .returning({ id: users.id });
      userId = created.id;
      usersCreated++;
    }

    // 2. Upsert the bot avatar (one per user — avatars.userId is unique).
    const existingPet = await db.query.avatars.findFirst({
      where: eq(avatars.userId, userId),
    });
    if (existingPet) {
      petsExisting++;
      continue;
    }

    const species = SPECIES[(i - 1) % SPECIES.length];
    const color = COLORS[(i - 1) % COLORS.length];
    const gender = GENDERS[(i - 1) % GENDERS.length];

    await db.insert(avatars).values({
      userId,
      name,
      species,
      color,
      gender,
      archetype: ARCHETYPE,
      personality: {
        habitat: 'Bumper Arena',
        hobby: 'Filling out matchmaking',
        greeting: 'Beep boop.',
      },
      stats: { strength: 5, defence: 5, movement: 5 },
      // characterConfig left null — bots never run an Eliza runtime; they
      // only exist as DB rows so `activity_room_participants.avatar_id` FK
      // stays valid. The matcher attaches them with subjectType='bot'.
      clawTokens: 0, // bots do not earn or spend
      // F1 vCLAW provenance: mirror clawTokens (0) into softBalance so the
      // avatars_vclaw_balance_sum CHECK holds (0 = 0+0+0). Without this the column
      // DEFAULT 100 makes a bare insert 100, breaking 0 = 100 for these bot rows.
      softBalance: 0,
      isActive: false, // not visible in NPC simulation
      agentCategory: 'openclaw',
      modelKey: 'lobster',
      harness: 'milady',
    });
    petsCreated++;
  }

  console.log(
    `Done! Users: ${usersCreated} created, ${usersExisting} existed. Avatars: ${petsCreated} created, ${petsExisting} existed.`,
  );
  if (usersCreated + petsCreated === 0) {
    console.log('Pool already fully seeded — no changes written.');
  }
  process.exit(0);
}

seed().catch((err) => {
  console.error('Bot avatar seed failed:', err);
  process.exit(1);
});
