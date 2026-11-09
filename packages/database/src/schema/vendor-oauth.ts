/**
 * Vendor sign-ins (OAuth) for the human's own vendor account (migration 0094,
 * MCP hub phase 3c). Written only by `apps/api/src/services/vendors/studios-oauth.ts`.
 * Separate from `user_vendor_credentials` (API keys), which stays unchanged.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';

/**
 * One row per sign-in a human starts. `state` is kept only as its SHA-256 hex;
 * the PKCE verifier is encrypted (encryptToken). Single use (used_at), 10
 * minutes long. `cancelled_at` = the human removed the sign-in while this one
 * was open: its tokens are never installed.
 */
export const vendorOAuthStates = pgTable('vendor_oauth_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  stateHash: varchar('state_hash', { length: 64 }).notNull(),
  verifierEnc: text('verifier_enc').notNull(),
  verifierIv: text('verifier_iv').notNull(),
  verifierTag: text('verifier_tag').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, (table) => ({
  stateHashUnique: uniqueIndex('vendor_oauth_states_state_hash_unique').on(table.stateHash),
  userCreatedIdx: index('vendor_oauth_states_user_created_idx').on(table.userId, table.createdAt),
  avatarVendorIdx: index('vendor_oauth_states_avatar_vendor_idx').on(table.avatarId, table.vendor),
  ttlCheck: check('vendor_oauth_states_ttl_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

/**
 * One linked vendor sign-in per avatar and vendor. Access and refresh tokens
 * are each encrypted with encryptToken (enc/iv/tag). `status`: 'active';
 * 'refreshing' = a refresh request is in flight since `refresh_started_at`
 * (written and committed BEFORE the request, so a lost reply is never followed
 * by a second use of the same refresh token); 'broken' = the human must sign
 * in again. `link_id` is new on every link (a link after an unlink never
 * reuses it); `refresh_claim_id` is new on every refresh claim. A refresh
 * writes its result only while the row still has its link id, its claim id
 * and status 'refreshing'.
 */
export const userVendorOAuthLinks = pgTable('user_vendor_oauth_links', {
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  accessEnc: text('access_enc').notNull(),
  accessIv: text('access_iv').notNull(),
  accessTag: text('access_tag').notNull(),
  refreshEnc: text('refresh_enc'),
  refreshIv: text('refresh_iv'),
  refreshTag: text('refresh_tag'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
  scope: text('scope').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  refreshStartedAt: timestamp('refresh_started_at', { withTimezone: true }),
  linkId: uuid('link_id').notNull(),
  refreshClaimId: uuid('refresh_claim_id'),
  linkedByUserId: uuid('linked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_vendor_oauth_links_pk', columns: [table.avatarId, table.vendor] }),
  statusCheck: check('user_vendor_oauth_links_status_check', sql`${table.status} IN ('active', 'refreshing', 'broken')`),
  refreshShapeCheck: check('user_vendor_oauth_links_refresh_check', sql`(${table.refreshEnc} IS NULL AND ${table.refreshIv} IS NULL AND ${table.refreshTag} IS NULL)
    OR (${table.refreshEnc} IS NOT NULL AND ${table.refreshIv} IS NOT NULL AND ${table.refreshTag} IS NOT NULL)`),
}));

export type VendorOAuthStateRow = typeof vendorOAuthStates.$inferSelect;
export type UserVendorOAuthLinkRow = typeof userVendorOAuthLinks.$inferSelect;
