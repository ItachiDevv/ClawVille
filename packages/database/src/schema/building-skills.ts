import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
} from 'drizzle-orm/pg-core';

/**
 * Building skills — agentskills.io-compatible SKILL.md content per building,
 * generated once by a one-time script (`scripts/generate-building-skills.ts`)
 * that summarizes the scraped `research_articles` via Gemini.
 *
 * Served from cache by `GET /api/skills/:buildingId/skill.md` — no per-request
 * LLM calls, no webhooks. An external agent (OpenClaw, Hermes, etc.) fetches
 * the skill file, drops it into its skills folder, and gains the ability to
 * interact with that building in the ClawVille world.
 *
 * The `clawville-play` meta-skill is also stored here (buildingId =
 * 'clawville-play') and describes how to use /api/agent/connect + /events +
 * /move + /visit-building to actually play the game.
 */
export const buildingSkills = pgTable('building_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Building id (e.g. 'mcp-tool-use') or 'clawville-play' for the meta skill. Unique. */
  buildingId: varchar('building_id', { length: 64 }).notNull().unique(),
  /** Skill name as it appears in YAML frontmatter (kebab-case, <=64 chars). */
  name: varchar('name', { length: 64 }).notNull(),
  /** One-line skill description (<1024 chars per agentskills.io spec). */
  description: text('description').notNull(),
  /** Full SKILL.md body including YAML frontmatter. */
  content: text('content').notNull(),
  /** UUIDs of research_articles rows used to generate this skill (for provenance). */
  sourceArticleIds: jsonb('source_article_ids').$type<string[]>().notNull().default([]),
  /** Schema/generator version so we can regenerate when the prompt changes. */
  generatorVersion: integer('generator_version').notNull().default(1),
  /**
   * sha256 of `content` as 64-char lowercase hex (Hatcher Phase C — 2026-06-01).
   * Lets a partner poll `GET /api/skills/manifest.json`, diff the hash, and only
   * re-fetch + re-embed a skill whose body actually changed (vs the coarse
   * integer `generatorVersion`). Backfilled by `scripts/generate-building-skills.ts`;
   * nullable so existing rows don't need the migration applied before the
   * manifest works — the manifest endpoint computes the hash LIVE from the
   * served markdown at request time (cached), so a null column is non-blocking.
   * See `.claude/plans/hatcher-integration.md` §4.
   */
  contentHash: varchar('content_hash', { length: 64 }),
  /** When this skill was last (re)generated. */
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type BuildingSkill = typeof buildingSkills.$inferSelect;
export type NewBuildingSkill = typeof buildingSkills.$inferInsert;
