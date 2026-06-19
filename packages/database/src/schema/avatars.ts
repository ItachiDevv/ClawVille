import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  boolean,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AgentCategory, AgentHarness } from '@clawville/shared';
import { users } from './users';
import { platformAgents } from './agents';

export const avatarSpeciesEnum = pgEnum('avatar_species', [
  'cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle',
]);

export const avatarColorEnum = pgEnum('avatar_color', [
  'green', 'red', 'blue', 'yellow',
]);

export const avatarGenderEnum = pgEnum('avatar_gender', ['male', 'female']);

/**
 * Avatar render-format for 3D rendering.
 *
 * - 'glb'  — default, loads /models/{species}.glb via existing species-keyed path
 * - 'vrm'  — custom VRM model URL in avatars.avatarUrl; used by Milady agents that
 *            bring their own avatar, and by clawville.world users who later
 *            choose to upload one. Renderer (when shipped) uses @pixiv/three-vrm.
 *
 * Renderer falls back to 'glb' if avatarUrl is null or the VRM fails to load.
 */
export const avatarRenderTypeEnum = pgEnum('avatar_render_type', ['glb', 'vrm']);

/**
 * VRM-specific metadata — expression map, bone overrides, loading hints.
 * Populated at connect time by the Milady plugin (if it has this info from
 * the runtime character config) or by a future ClawVille avatar upload flow.
 * Optional — the renderer uses sensible defaults if absent.
 */
export interface AvatarVrmMetadataJson {
  /** Semantic version of the schema so we can migrate later */
  version?: number;
  /** Expression names available on the VRM (e.g. 'happy', 'sad', 'angry') */
  expressions?: string[];
  /** Custom bone mappings if the VRM doesn't follow the standard humanoid rig */
  boneMap?: Record<string, string>;
  /** Optional license string from the VRM file metadata */
  license?: string;
  /** Original author / creator attribution */
  author?: string;
  /** SHA-256 hash of the VRM file (for cache busting + integrity check) */
  contentHash?: string;
}

export interface AvatarPersonalityJson {
  habitat: string;
  hobby: string;
  greeting: string;
}

export interface AvatarStatsJson {
  strength: number;
  defence: number;
  movement: number;
}

/** ElizaOS-compatible character config for avatar agents */
export interface AvatarCharacterConfigJson {
  bio: string[];
  greeting: string;
  tone: string;
  topics: string[];
  adjectives: string[];
  rules: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  messageExamples: Array<{ user: string; content: string }[]>;
  lore: string[];
  knowledge: string[];
  system?: string;
}

export const avatars = pgTable('avatars', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull().unique(),
  species: avatarSpeciesEnum('species').notNull(),
  color: avatarColorEnum('color').notNull(),
  gender: avatarGenderEnum('gender').notNull(),
  /** Selected archetype ID (e.g. 'brave-adventurer') */
  archetype: varchar('archetype', { length: 50 }).notNull(),
  /**
   * Phase 6.1 — free-text curriculum focus the human picked at
   * magic-link time (e.g. "cron jobs", "solana signing", "discord bot").
   * Appended to the avatar's character system prompt so the agent biases
   * toward the matching building's teacher. Nullable — agents connected
   * before the column existed have no focus; `buildCharacterConfig`
   * skips the injection when null.
   */
  learningFocus: varchar('learning_focus', { length: 120 }),
  personality: jsonb('personality').$type<AvatarPersonalityJson>().notNull(),
  stats: jsonb('stats').$type<AvatarStatsJson>().notNull(),
  /** ElizaOS character config - full archetype data for the avatar's AI personality */
  characterConfig: jsonb('character_config').$type<AvatarCharacterConfigJson>(),
  /** Link to platform_agents table for ElizaOS runtime */
  platformAgentId: uuid('platform_agent_id')
    .references(() => platformAgents.id, { onDelete: 'set null' }),
  clawTokens: integer('claw_tokens').default(100).notNull(),
  // town-center spawn (land Phase 0 re-center); mirrors @clawville/shared
  // SPAWN_PX (9216, 9756). Migration 0002 resets existing rows. NOTE: drizzle
  // column defaults MUST be numeric literals (importing @clawville/shared here
  // would create a database→shared dependency cycle), so these are pinned by
  // the comment, not by an import — keep them equal to SPAWN_PX.
  positionX: integer('position_x').default(9216).notNull(),
  positionY: integer('position_y').default(9756).notNull(),
  /**
   * Town fast-travel — per-avatar spawn preference (town-fast-travel, 2026-06-19).
   *
   * - `spawnPreference` ∈ {'town','home'}: where this avatar re-spawns on world
   *   entry. DEFAULT 'town' (the re-centered town square, SPAWN_PX). When 'home'
   *   the client computes world coords from `homeParcelId`'s grid cell.
   * - `homeParcelId`: the owned parcel that 'home' resolves to. Nullable; set
   *   ONLY by `POST /api/land/spawn-preference` after asserting the caller owns
   *   the parcel. FK → land_parcels(id) ON DELETE SET NULL.
   *
   * FK note (import-cycle avoidance): `land.ts` already imports `avatars` from
   * this file, so a static `.references(() => landParcels.id)` here would create
   * a circular module import. The column is therefore declared WITHOUT a Drizzle
   * `.references()`; the actual Postgres FK constraint
   * (`avatars_home_parcel_id_fkey`, ON DELETE SET NULL) is added by migration
   * `0004_spawn_preference.sql`. Drizzle never DROPs/recreates it because the
   * migrate-ci runner only executes the SQL we author (never drizzle-kit push).
   * Keep the values 'town'/'home' in sync with the shared Avatar type
   * (`spawnPreference`) and the `POST /api/land/spawn-preference` Zod enum.
   */
  spawnPreference: text('spawn_preference').notNull().default('town'),
  homeParcelId: uuid('home_parcel_id'),
  lastActiveAt: timestamp('last_active_at'),
  loginStreak: integer('login_streak').default(0).notNull(),
  lastLoginDate: varchar('last_login_date', { length: 10 }),
  slotIndex: integer('slot_index').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  equippedSkills: jsonb('equipped_skills').$type<string[]>().default([]),
  level: integer('level').default(1).notNull(),
  xp: integer('xp').default(0).notNull(),
  totalXp: integer('total_xp').default(0).notNull(),
  /**
   * Avatar format + URL. Default 'glb' falls through to the existing
   * species-keyed /models/{species}.glb loader. 'vrm' triggers the VRM
   * renderer (Phase 5, not yet wired on the frontend) with avatarUrl as
   * the source. Schema is ready today; renderer comes later.
   */
  avatarType: avatarRenderTypeEnum('avatar_type').default('glb').notNull(),
  avatarUrl: varchar('avatar_url', { length: 1024 }),
  vrmMetadata: jsonb('vrm_metadata').$type<AvatarVrmMetadataJson>(),
  /**
   * Phase 2 fields — first-class agent-framework identity on the avatar.
   *
   * - `modelKey` (Phase 2 §3.1): stable key into `@clawville/shared`
   *   `AGENT_MODELS` (e.g. 'lobster', 'priestess'). Drives 3D GLB pick
   *   on the web side. Replaces `species` as the visual-identity field
   *   going forward; `species` stays populated for backwards compat
   *   with the pixi 2D fallback.
   * - `agentCategory`: which agent-framework bucket the avatar belongs to.
   *   Drives per-framework features (Hermes chat routing, Milady install).
   * - `harness`: user's preferred agent runtime. Drives Phase 3 export
   *   target (what character-bundle format we generate). DEFAULT 'milady'
   *   so a freshly-created agent works autonomously in Phase 4a without
   *   further config.
   *
   * All three have NOT NULL DEFAULTs so existing avatar rows backfill to
   * `('openclaw','lobster','milady')` on migration without a separate
   * backfill query. Enum values are enforced at three layers:
   *   1. API — Zod `.enum(AGENT_CATEGORIES | AGENT_HARNESSES)` in
   *      apps/api/src/routes/avatars.ts (also validated by `.refine`
   *      against AGENT_MODEL_KEYS for modelKey).
   *   2. TypeScript — `$type<AgentCategory>()` / `$type<AgentHarness>()`
   *      below pull the union directly from @clawville/shared so any
   *      registry change in the shared package cascades here at build.
   *   3. Postgres — CHECK constraints `avatars_agent_category_valid` and
   *      `avatars_harness_valid` (see constraint block at the end of the
   *      table definition). This is defense-in-depth against direct-SQL
   *      writers (admin tools, cron, backfill scripts) that bypass the
   *      API. See Phase 2 plan §3.1.
   */
  agentCategory: varchar('agent_category', { length: 16 })
    .notNull()
    .default('openclaw')
    .$type<AgentCategory>(),
  modelKey: varchar('model_key', { length: 64 })
    .notNull()
    .default('lobster'),
  harness: varchar('harness', { length: 16 })
    .notNull()
    .default('milady')
    .$type<AgentHarness>(),
  /**
   * Auto-generated custodial Solana wallet address (base58). NULL for avatars
   * that existed before the C2 backfill; populated for new avatars (human or
   * agent-created) via apps/api/src/services/avatar-wallet-service.ts.
   * Secret key lives encrypted in the wallets table.
   */
  walletAddress: varchar('wallet_address', { length: 64 }),
  /**
   * Q2 Activity Portals — admin-driven flags JSONB.
   *
   * Catch-all bag for low-volume per-avatar flags that don't justify their
   * own column. Today: anti-cheat banner thresholds (`anti_cheat_banned_
   * until`), future: shadow-banned, beta-feature opt-ins, etc.
   *
   * Default empty object so existing rows backfill seamlessly. Reads
   * should always tolerate missing keys.
   */
  flags: jsonb('flags').notNull().default(sql`'{}'::jsonb`),
  /**
   * Guest-avatar auto-create (2026-04-23) — true when this avatar was created
   * for an un-authenticated visitor via `POST /api/auth/guest`. Mirrors
   * `users.is_guest` for fast joinless filtering on the activity
   * leaderboards + reward pipeline. Existing avatars default to false.
   */
  isGuest: boolean('is_guest').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  // Phase 2 §3.1 — Postgres CHECK constraints mirror the shared
  // AGENT_CATEGORIES / AGENT_HARNESSES tuples. Literals are hardcoded
  // here because `sql` template interpolation of a JS array is awkward
  // and the emitted DDL must stay readable. The $type<> annotations on
  // the columns above import the TS unions from @clawville/shared, so
  // any drift between the shared tuple and this list fails to compile
  // rather than silently diverging.
  //
  // After editing: run `bun run db:push` from the repo root to apply
  // the ALTER TABLE ADD CONSTRAINT. Drizzle-kit 0.24 emits these
  // constraints as part of the push. If push errors with "constraint
  // already exists", drop the existing one manually (the name matches
  // the first argument to check()).
  // MIRROR of AGENT_CATEGORIES in @clawville/shared (agent-models.ts). 'hatcher'
  // added 2026-06-01 (partner #2): although connected Hatcher agents render via
  // openclaw_bots.species (NOT an avatars row), `'hatcher'` is now a member of
  // the shared AGENT_CATEGORIES tuple, which the avatars route validates with
  // `z.enum(AGENT_CATEGORIES)` and writes to agent_category. Keeping this CHECK
  // in lockstep with the tuple is the documented invariant (see the block
  // comment on the columns above) — without 'hatcher' here, an avatars write
  // carrying it would hit a Postgres CHECK violation. Applied to the shared
  // Supabase via migrations-manual/2026-06-01_add_hatcher_agent_category.sql
  // (NOT auto-run — db:push is flaky on this table; raw drop+recreate, once).
  agentCategoryCheck: check(
    'avatars_agent_category_valid',
    sql`${t.agentCategory} IN ('openclaw','hermes','milady','other','hatcher')`,
  ),
  harnessCheck: check(
    'avatars_harness_valid',
    sql`${t.harness} IN ('openclaw','hermes','milady','custom')`,
  ),
  // town-fast-travel (2026-06-19) — defense-in-depth against direct-SQL writers
  // that bypass the API Zod enum. Mirrors the {'town','home'} domain. Added by
  // migration 0004_spawn_preference.sql alongside the home_parcel_id FK.
  spawnPreferenceCheck: check(
    'avatars_spawn_preference_valid',
    sql`${t.spawnPreference} IN ('town','home')`,
  ),
}));
