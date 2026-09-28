/**
 * backfill-avatar-agents.ts — bulk mint-on-backfill for agent-less avatars.
 * ============================================================================
 *
 * WHY (scope-audit finding, 2026-07-08)
 * -------------------------------------
 * The account ≡ agent ≡ avatar model made 'agent-provisioning-pending' a
 * DERIVED transitional state, converged lazily by the mint-on-customize
 * backfill in PATCH /api/avatars/me (avatars.ts "P2 post-panel BLOCKING #1").
 * That convergence is user-initiated only — live staging carries 38 non-guest
 * avatars with platform_agent_id NULL (30 milady + 8 custom) that stay
 * agent-less until each user happens to re-customize. This script performs the
 * missing BULK convergence: it mints the same 'avatar-agent' platform_agents
 * row the customize backfill would, per avatar, in a per-avatar transaction.
 *
 * SCOPE
 * -----
 * - Only ACTIVE avatars of NON-guest users with platform_agent_id NULL.
 * - Only harness values passed via --harness (default 'milady'). 'custom' is
 *   deliberately NOT defaulted: custom = BYO-gateway semantics; minting a
 *   hosted ElizaOS agent for it is a product decision (founder call).
 * - Users with ANY openclaw_bots row are SKIPPED — they are Path-A (BYO) users
 *   whose agent IS the bot row; /me/agent-session already resolves them
 *   truthfully via the bot-row branch.
 * - Avatars whose archetype is unknown to AVATAR_ARCHETYPES are SKIPPED and
 *   reported (buildCharacterConfig would throw).
 *
 * WHAT IT MINTS (byte-parity with the customize backfill, avatars.ts)
 * -------------------------------------------------------------------
 * agents row: { userId, name, type:'avatar-agent', status:'pending',
 *   config:{species,color,archetypeId,modelKey,agentCategory,harness},
 *   customization: FULL buildCharacterConfig(...) + learned-knowledge
 *   preservation } — then links avatars.platform_agent_id in the SAME tx.
 * NO wallet mint (the customize backfill doesn't either), NO runtime warm
 * (lazy-starts on first chat), NOT is_house.
 *
 * SAFETY
 * ------
 * - DB URL from BACKFILL_DATABASE_URL ONLY (no DATABASE_URL/.env.local
 *   fallback — the 2026-06-16 prod-write lesson). Never logged.
 * - Exactly one explicit target assertion:
 *   --ref <ref>  (Supabase): the URL MUST name the project exactly (pooler user
 *                `postgres.<ref>` or host `db.<ref>.supabase.co`) or the script exits
 *                before connecting, and the database must carry no marker.
 *   --env <staging|production>  (self-hosted, reached through the 127.0.0.1:15432
 *                SSH tunnel since 2026-09-25): the database's own `clawville.env`
 *                marker (scripts/deploy/db) MUST equal it.
 *   The marker is read before any selection or write, and again as the first
 *   statement of every write transaction (a mismatch rolls back and stops the run).
 * - DRY-RUN by default: prints the plan. Writes ONLY with --apply.
 * - Idempotent: re-checks platform_agent_id IS NULL inside each tx.
 *
 * RUN (staging):
 *   BACKFILL_DATABASE_URL="postgresql://clawville:<pw>@127.0.0.1:15432/clawville" \
 *     bun run apps/api/scripts/backfill-avatar-agents.ts --env staging [--harness milady] [--apply]
 *   Legacy Supabase: --ref mtpixvtclsjqjguouxes with the session-pooler URL.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, inArray, sql as drizzleSql } from 'drizzle-orm';
// Pure table DEFINITIONS only — no connection is opened by these imports.
import { users, avatars, agents, agentBots } from '@clawville/database';
import {
  AVATAR_ARCHETYPES,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  getAgentModel,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_CATEGORY,
  DEFAULT_AGENT_HARNESS,
} from '@clawville/shared';
import type { AvatarArchetypeId } from '@clawville/shared';
import { buildCharacterConfig } from '../src/services/avatar-agent-provisioning';
import {
  DATABASE_ENV_MARKER_SQL,
  DatabaseEnvMarkerError,
  assertWriteTargetMarker,
  namesSupabaseProject,
  resolveDatabaseEnvMarker,
  type DatabaseEnvMarkerRow,
} from './db-env-marker';

// ── 0. args + hard ref guard ────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const HARNESS = getArg('harness') ?? 'milady';
const EXPECTED_REF = getArg('ref');
const EXPECTED_ENV = getArg('env');
if (!EXPECTED_REF === !EXPECTED_ENV) {
  console.error(
    'FATAL: pass exactly one explicit target assertion: --ref <supabase-project-ref> or --env <staging|production>.',
  );
  process.exit(1);
}
if (EXPECTED_ENV && EXPECTED_ENV !== 'staging' && EXPECTED_ENV !== 'production') {
  console.error('FATAL: --env must be exactly staging or production.');
  process.exit(1);
}
const dbUrl = process.env.BACKFILL_DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: BACKFILL_DATABASE_URL is required (no DATABASE_URL fallback by design).');
  process.exit(1);
}
// The exact Supabase identity (pooler user `postgres.<ref>` or host `db.<ref>.supabase.co`),
// not the ref anywhere in the URL text (a password or query parameter would match that).
if (EXPECTED_REF && !namesSupabaseProject(dbUrl, EXPECTED_REF)) {
  console.error('FATAL: BACKFILL_DATABASE_URL does not name the asserted project (pooler user or direct host). Refusing to connect.');
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });
const db = drizzle(sql);

// The self-hosted URL names no project, so the database's own marker decides: --env must equal
// it, and --ref is valid only for an unmarked (Supabase) database. The marker is read from the
// catalog, so a URL option or role setting cannot fake it (db-env-marker.ts).
let marker: string | null;
try {
  const [markerRow] = await sql.unsafe<DatabaseEnvMarkerRow[]>(DATABASE_ENV_MARKER_SQL);
  marker = resolveDatabaseEnvMarker(markerRow);
} catch (error) {
  await sql.end();
  if (!(error instanceof DatabaseEnvMarkerError)) throw error;
  console.error(`FATAL: ${error.message}.`);
  process.exit(1);
}
if (marker !== (EXPECTED_ENV ?? null)) {
  console.error(
    `FATAL: database marker clawville.env=${marker ?? '(none)'} does not match ${EXPECTED_ENV ? `--env ${EXPECTED_ENV}` : '--ref (expects no marker)'}. Refusing.`,
  );
  await sql.end();
  process.exit(1);
}

// ── 1. selection ────────────────────────────────────────────────────────────
const candidates = await db
  .select({
    avatarId: avatars.id,
    userId: avatars.userId,
    name: avatars.name,
    species: avatars.species,
    color: avatars.color,
    archetype: avatars.archetype,
    modelKey: avatars.modelKey,
    agentCategory: avatars.agentCategory,
    harness: avatars.harness,
    learningFocus: avatars.learningFocus,
    characterConfig: avatars.characterConfig,
  })
  .from(avatars)
  .innerJoin(users, eq(users.id, avatars.userId))
  .where(
    and(
      isNull(avatars.platformAgentId),
      eq(avatars.isActive, true),
      eq(users.isGuest, false),
      eq(avatars.harness, HARNESS),
    ),
  );

// Path-A exclusion: users with any openclaw_bots row keep their BYO agent.
const userIds = candidates.map((c) => c.userId);
const botUsers = userIds.length
  ? await db
      .select({ userId: agentBots.userId })
      .from(agentBots)
      .where(inArray(agentBots.userId, userIds))
  : [];
const botUserSet = new Set(botUsers.map((b) => b.userId).filter(Boolean));

const plan = candidates.filter((c) => !botUserSet.has(c.userId));
const skippedBot = candidates.length - plan.length;

console.log(
  `[backfill] harness=${HARNESS} candidates=${candidates.length} path-a-skipped=${skippedBot} to-mint=${plan.length} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`,
);

// ── 2. per-avatar mint (mirrors avatars.ts customize backfill) ──────────────
let minted = 0;
let skippedArchetype = 0;
for (const c of plan) {
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === c.archetype);
  if (!archetype) {
    console.log(`  SKIP ${c.avatarId} name="${c.name}" — unknown archetype '${c.archetype}'`);
    skippedArchetype++;
    continue;
  }
  const modelKey = c.modelKey ?? DEFAULT_AGENT_MODEL_KEY;
  const modelMeta = getAgentModel(modelKey);
  const modelLabel = modelMeta?.label ?? modelKey;

  // Full characterConfig + learned-knowledge preservation (route parity).
  const fresh = buildCharacterConfig(
    c.archetype as AvatarArchetypeId,
    c.name,
    modelLabel,
    c.learningFocus,
  );
  const oldKnowledge: string[] = Array.isArray(
    (c.characterConfig as { knowledge?: unknown } | null)?.knowledge,
  )
    ? (c.characterConfig as { knowledge: string[] }).knowledge
    : [];
  const baseline = new Set<string>([...archetype.knowledge, ...CLAWVILLE_ORIENTATION_KNOWLEDGE]);
  const learned = oldKnowledge.filter((k) => !baseline.has(k));
  const customization = {
    ...fresh,
    knowledge: [...fresh.knowledge, ...learned.filter((k) => !fresh.knowledge.includes(k))],
  };

  if (!APPLY) {
    console.log(
      `  DRY ${c.avatarId} name="${c.name}" archetype=${c.archetype} model=${modelKey} learned=${learned.length}`,
    );
    continue;
  }

  try {
    await db.transaction(async (tx) => {
      // First statement: the database this transaction writes to must still carry the marker
      // the pre-check accepted; a mismatch throws and rolls the avatar back.
      await assertWriteTargetMarker(async (query) => await tx.execute(drizzleSql.raw(query)), marker);
      // Idempotency re-check inside the tx.
      const [still] = await tx
        .select({ platformAgentId: avatars.platformAgentId })
        .from(avatars)
        .where(eq(avatars.id, c.avatarId));
      if (!still || still.platformAgentId) {
        console.log(`  SKIP ${c.avatarId} — platform_agent_id no longer NULL`);
        return;
      }
      const [agent] = await tx
        .insert(agents)
        .values({
          userId: c.userId,
          name: c.name,
          type: 'avatar-agent',
          status: 'pending',
          config: {
            species: c.species,
            color: c.color,
            archetypeId: c.archetype,
            modelKey,
            agentCategory: c.agentCategory ?? modelMeta?.category ?? DEFAULT_AGENT_CATEGORY,
            harness: c.harness ?? DEFAULT_AGENT_HARNESS,
          },
          customization,
        })
        .returning();
      await tx
        .update(avatars)
        .set({ platformAgentId: agent.id })
        .where(eq(avatars.id, c.avatarId));
      minted++;
      console.log(`  MINT ${c.avatarId} name="${c.name}" -> agent ${agent.id}`);
    });
  } catch (error) {
    if (!(error instanceof DatabaseEnvMarkerError)) throw error;
    console.error(`FATAL: ${error.message}; stopping after ${minted} minted.`);
    await sql.end();
    process.exit(1);
  }
}

console.log(
  `[backfill] done. minted=${minted} archetype-skipped=${skippedArchetype} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`,
);
await sql.end();
