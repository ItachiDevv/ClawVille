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
 * - The URL's Supabase project ref MUST equal --ref <ref> or the script exits
 *   before connecting.
 * - DRY-RUN by default: prints the plan. Writes ONLY with --apply.
 * - Idempotent: re-checks platform_agent_id IS NULL inside each tx.
 *
 * RUN (staging):
 *   BACKFILL_DATABASE_URL="<staging session-pooler url>" \
 *     bun run apps/api/scripts/backfill-avatar-agents.ts --ref mtpixvtclsjqjguouxes [--harness milady] [--apply]
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, inArray } from 'drizzle-orm';
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

// ── 0. args + hard ref guard ────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const HARNESS = getArg('harness') ?? 'milady';
const EXPECTED_REF = getArg('ref');
if (!EXPECTED_REF) {
  console.error('FATAL: --ref <supabase-project-ref> is required (explicit target assertion).');
  process.exit(1);
}
const dbUrl = process.env.BACKFILL_DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: BACKFILL_DATABASE_URL is required (no DATABASE_URL fallback by design).');
  process.exit(1);
}
const refMatch = /postgres(?:ql)?:\/\/[^.@]*\.?([a-z]{20})[.:@]/.exec(dbUrl) ?? /([a-z]{20})/.exec(dbUrl);
if (!refMatch || !dbUrl.includes(EXPECTED_REF)) {
  console.error('FATAL: BACKFILL_DATABASE_URL does not contain the asserted project ref. Refusing to connect.');
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });
const db = drizzle(sql);

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

  await db.transaction(async (tx) => {
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
}

console.log(
  `[backfill] done. minted=${minted} archetype-skipped=${skippedArchetype} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`,
);
await sql.end();
