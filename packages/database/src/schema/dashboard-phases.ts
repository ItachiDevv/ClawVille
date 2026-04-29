/**
 * Q3 plan §gamification dashboard — Phase Status table.
 *
 * One row per "phase" in the gamification roadmap. Mutable via the
 * dashboard MCP server (tools/dashboard-mcp/) so internal sessions can
 * advance phase state without touching the canonical plan markdown.
 *
 * The plan file (.claude/plans/gamification-economy-and-shop-q3.md) stays
 * the authoritative DESIGN doc; this table tracks live STATUS — what's
 * shipped, what's in flight, what's blocked. Two different cadences.
 *
 * Status enum (string):
 *   'planned'      — on the roadmap, not started
 *   'in_progress'  — actively being implemented
 *   'shipped'      — deployed + verified live
 *   'blocked'      — has a dependency or decision waiting
 *   'paused'       — intentionally on hold (e.g., paid marketplace pivot)
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';

export const dashboardPhases = pgTable('dashboard_phases', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** url-safe stable id, e.g. 'phase-1', 'phase-3-engine'. Used by MCP. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** 'planned' | 'in_progress' | 'shipped' | 'blocked' | 'paused' */
  status: text('status').notNull().default('planned'),
  /** Optional free-text notes — what landed, what's blocking, link to commit, etc. */
  notes: text('notes'),
  /** Display order (ascending). MCP can reshuffle. */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
