import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  boolean,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { platformAgents } from './agents';

export const petSpeciesEnum = pgEnum('pet_species', [
  'cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle',
]);

export const petColorEnum = pgEnum('pet_color', [
  'green', 'red', 'blue', 'yellow',
]);

export const petGenderEnum = pgEnum('pet_gender', ['male', 'female']);

/**
 * Avatar model format for 3D rendering.
 *
 * - 'glb'  — default, loads /models/{species}.glb via existing species-keyed path
 * - 'vrm'  — custom VRM model URL in pets.avatarUrl; used by Milady agents that
 *            bring their own avatar, and by clawville.world users who later
 *            choose to upload one. Renderer (when shipped) uses @pixiv/three-vrm.
 *
 * Renderer falls back to 'glb' if avatarUrl is null or the VRM fails to load.
 */
export const petAvatarTypeEnum = pgEnum('pet_avatar_type', ['glb', 'vrm']);

/**
 * VRM-specific metadata — expression map, bone overrides, loading hints.
 * Populated at connect time by the Milady plugin (if it has this info from
 * the runtime character config) or by a future ClawVille avatar upload flow.
 * Optional — the renderer uses sensible defaults if absent.
 */
export interface PetVrmMetadataJson {
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

export interface PetPersonalityJson {
  habitat: string;
  hobby: string;
  greeting: string;
}

export interface PetStatsJson {
  strength: number;
  defence: number;
  movement: number;
}

/** ElizaOS-compatible character config for pet agents */
export interface PetCharacterConfigJson {
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

export const pets = pgTable('pets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull().unique(),
  species: petSpeciesEnum('species').notNull(),
  color: petColorEnum('color').notNull(),
  gender: petGenderEnum('gender').notNull(),
  /** Selected archetype ID (e.g. 'brave-adventurer') */
  archetype: varchar('archetype', { length: 50 }).notNull(),
  personality: jsonb('personality').$type<PetPersonalityJson>().notNull(),
  stats: jsonb('stats').$type<PetStatsJson>().notNull(),
  /** ElizaOS character config - full archetype data for the pet's AI personality */
  characterConfig: jsonb('character_config').$type<PetCharacterConfigJson>(),
  /** Link to platform_agents table for ElizaOS runtime */
  platformAgentId: uuid('platform_agent_id')
    .references(() => platformAgents.id, { onDelete: 'set null' }),
  clawTokens: integer('claw_tokens').default(100).notNull(),
  positionX: integer('position_x').default(2560).notNull(),
  positionY: integer('position_y').default(2560).notNull(),
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
  avatarType: petAvatarTypeEnum('avatar_type').default('glb').notNull(),
  avatarUrl: varchar('avatar_url', { length: 1024 }),
  vrmMetadata: jsonb('vrm_metadata').$type<PetVrmMetadataJson>(),
  /**
   * Phase 2 fields — first-class agent-framework identity on the pet.
   *
   * - `modelKey` (Phase 2 §3.1): stable key into `@clawville/shared`
   *   `AGENT_MODELS` (e.g. 'lobster', 'priestess'). Drives 3D GLB pick
   *   on the web side. Replaces `species` as the visual-identity field
   *   going forward; `species` stays populated for backwards compat
   *   with the pixi 2D fallback.
   * - `agentCategory`: which agent-framework bucket the pet belongs to.
   *   Drives per-framework features (Hermes chat routing, Milady install).
   * - `harness`: user's preferred agent runtime. Drives Phase 3 export
   *   target (what character-bundle format we generate). DEFAULT 'milady'
   *   so a freshly-created agent works autonomously in Phase 4a without
   *   further config.
   *
   * All three have NOT NULL DEFAULTs so existing pet rows backfill to
   * `('openclaw','lobster','milady')` on migration without a separate
   * backfill query. Enum values are enforced at the API layer via Zod +
   * the shared `AgentCategory` / `AgentHarness` types. No SQL CHECK
   * constraints are applied here — if you add a direct-SQL writer, you
   * MUST replicate the Zod validation or switch these columns to
   * `pgEnum` types. For now, the API is the sole writer.
   */
  agentCategory: varchar('agent_category', { length: 16 })
    .notNull()
    .default('openclaw')
    .$type<'openclaw' | 'hermes' | 'milady' | 'other'>(),
  modelKey: varchar('model_key', { length: 64 })
    .notNull()
    .default('lobster'),
  harness: varchar('harness', { length: 16 })
    .notNull()
    .default('milady')
    .$type<'openclaw' | 'hermes' | 'milady' | 'custom'>(),
  /**
   * Auto-generated custodial Solana wallet address (base58). NULL for pets
   * that existed before the C2 backfill; populated for new pets (human or
   * agent-created) via apps/api/src/services/pet-wallet-service.ts.
   * Secret key lives encrypted in the pet_wallets table.
   */
  walletAddress: varchar('wallet_address', { length: 64 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
