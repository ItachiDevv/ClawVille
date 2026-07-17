/**
 * Operator-only repair for the hosted-Milady provisioning-pending tail.
 *
 * Dry-run is the default. This script deliberately imports the database and
 * provisioning service only after validating flags, DATABASE_URL, and the
 * production guard, so a refused invocation cannot auto-load or connect.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun run apps/api/scripts/repair-provisioning-pending.ts
 *   DATABASE_URL="postgresql://..." bun run apps/api/scripts/repair-provisioning-pending.ts --apply
 *   DATABASE_URL="<known-prod-url>" bun run apps/api/scripts/repair-provisioning-pending.ts --apply --allow-prod
 */

const PROD_DATABASE_REF = 'wheuidgiyyccqyoppxoa';
const KNOWN_FLAGS = new Set(['--dry-run', '--apply', '--allow-prod']);
const args = process.argv.slice(2);
const unknownFlags = args.filter((arg) => !KNOWN_FLAGS.has(arg));

if (unknownFlags.length > 0) {
  console.error(`FATAL: unknown flag(s): ${unknownFlags.join(', ')}`);
  process.exit(1);
}
if (args.includes('--dry-run') && args.includes('--apply')) {
  console.error('FATAL: choose exactly one of --dry-run or --apply.');
  process.exit(1);
}

const apply = args.includes('--apply');
const allowProd = args.includes('--allow-prod');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('FATAL: DATABASE_URL is required.');
  process.exit(1);
}
if (databaseUrl.includes(PROD_DATABASE_REF) && !allowProd) {
  console.error(
    `FATAL: DATABASE_URL matches the known production database (${PROD_DATABASE_REF}); pass --allow-prod deliberately to continue.`,
  );
  process.exit(1);
}

const { and, avatars, db, eq, isNull, sql, users } = await import('@clawville/database');
const { BOT_USER_EMAIL_DOMAIN } = await import('../src/services/activity/bots/bot-pool');
// Single implementation policy: reuse the staging-proven lazy-backfill row mint
// (`backfillPlatformAgentForAvatar`, CAS race-guarded, no double-genesis) as the
// batch entry point too — two implementations of the same row mint is exactly
// the drift class this ripout removes.
const { backfillPlatformAgentForAvatar } = await import(
  '../src/services/avatar-agent-provisioning'
);

// Two exclusions are load-bearing — BOTH caught by prod dry-runs before apply:
// 1. Guests (274→95): demo-economy accounts must NEVER get a hosted runtime.
//    The lazy path enforces this at the route's cold is_guest read; the batch
//    entry point mirrors it via the denormalized `avatars.isGuest`.
// 2. Activity backfill bots (95→human tail): `Bot-Crab-###` avatars belong to
//    seeded bot-owner users (`bot-NNN@bots.clawville.internal` — the seeder's
//    authoritative marker). Bots are never players and provisioning ~80 idle
//    ElizaOS runtimes would be pure sim cost.
const candidates = await db
  .select({
    userId: avatars.userId,
    avatarId: avatars.id,
    name: avatars.name,
  })
  .from(avatars)
  .innerJoin(users, eq(users.id, avatars.userId))
  .where(and(
    eq(avatars.harness, 'milady'),
    isNull(avatars.platformAgentId),
    eq(avatars.isGuest, false),
    sql`(${users.email} IS NULL OR ${users.email} NOT ILIKE ${`%${BOT_USER_EMAIL_DOMAIN}`})`,
  ));

console.log(`[repair-provisioning] mode=${apply ? 'APPLY' : 'DRY-RUN'} accounts=${candidates.length}`);
for (const candidate of candidates) {
  console.log(
    `  ACCOUNT user=${candidate.userId} avatar=${candidate.avatarId} name=${JSON.stringify(candidate.name)}`,
  );
}

if (!apply) {
  console.log(`[repair-provisioning] dry-run complete; planned=${candidates.length} mutated=0`);
  process.exit(0);
}

let created = 0;
let skipped = 0;
let failed = 0;
for (const candidate of candidates) {
  try {
    const agentId = await backfillPlatformAgentForAvatar(candidate.userId, candidate.avatarId);
    if (agentId) {
      created++;
      console.log(
        `  LINKED user=${candidate.userId} avatar=${candidate.avatarId} agent=${agentId}`,
      );
    } else {
      skipped++;
      console.log(
        `  SKIP user=${candidate.userId} avatar=${candidate.avatarId} (already linked, missing, or not hosted-harness)`,
      );
    }
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`  FAIL user=${candidate.userId} avatar=${candidate.avatarId}: ${message}`);
  }
}

console.log(
  `[repair-provisioning] apply complete; candidates=${candidates.length} created=${created} skipped=${skipped} failed=${failed}`,
);
process.exit(failed > 0 ? 1 : 0);
