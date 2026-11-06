/**
 * Images made by an avatar's paid tools, and a human's own vendor API keys
 * (migration 0091, MCP hub step 2 phase 2b), and vendor sign-ins (migration
 * 0094). Written only by `apps/api/src/services/studios-images.ts`,
 * `services/vendor-credentials.ts` and `services/vendors/studios-oauth.ts`.
 */

import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';
import { vendorSpendLedger } from './vendor-spend-ledger';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const avatarMedia = pgTable('avatar_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull(),
  actor: varchar('actor', { length: 16 }).notNull(),
  mimeType: varchar('mime_type', { length: 32 }).notNull(),
  bytes: bytea('bytes').notNull(),
  prompt: text('prompt').notNull(),
  ledgerId: uuid('ledger_id').references(() => vendorSpendLedger.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  avatarCreatedIdx: index('avatar_media_avatar_created_idx').on(table.avatarId, table.createdAt),
}));

/**
 * A human's own vendor credentials, one row per kind (migration 0094): an API
 * key ('api_key': enc/iv/tag + last4) and a sign-in ('oauth': access and
 * refresh tokens, each encrypted with the same enc/iv/tag scheme). One avatar
 * can hold both kinds for the same vendor at the same time.
 */
export const userVendorCredentials = pgTable('user_vendor_credentials', {
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull().default('api_key'),
  enc: text('enc'),
  iv: text('iv'),
  tag: text('tag'),
  last4: varchar('last4', { length: 4 }),
  accessEnc: text('access_enc'),
  accessIv: text('access_iv'),
  accessTag: text('access_tag'),
  refreshEnc: text('refresh_enc'),
  refreshIv: text('refresh_iv'),
  refreshTag: text('refresh_tag'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  scope: text('scope'),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_vendor_credentials_pk', columns: [table.avatarId, table.vendor, table.kind] }),
  kindCheck: check('user_vendor_credentials_kind_check', sql`${table.kind} IN ('api_key', 'oauth')`),
  statusCheck: check('user_vendor_credentials_status_check', sql`${table.status} IN ('active', 'broken')`),
  shapeCheck: check('user_vendor_credentials_shape_check', sql`(${table.kind} = 'api_key'
    AND ${table.enc} IS NOT NULL AND ${table.iv} IS NOT NULL AND ${table.tag} IS NOT NULL AND ${table.last4} IS NOT NULL)
    OR (${table.kind} = 'oauth'
      AND ${table.accessEnc} IS NOT NULL AND ${table.accessIv} IS NOT NULL AND ${table.accessTag} IS NOT NULL
      AND ${table.accessExpiresAt} IS NOT NULL
      AND ((${table.refreshEnc} IS NULL AND ${table.refreshIv} IS NULL AND ${table.refreshTag} IS NULL)
        OR (${table.refreshEnc} IS NOT NULL AND ${table.refreshIv} IS NOT NULL AND ${table.refreshTag} IS NOT NULL)))`),
}));

/**
 * One row per vendor sign-in a human starts (migration 0094). `state` is kept
 * only as its SHA-256 hex; the PKCE verifier is encrypted (encryptToken). Single
 * use (used_at) and 10 minutes long. Written only by
 * `apps/api/src/services/vendors/studios-oauth.ts`.
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
}, (table) => ({
  stateHashUnique: uniqueIndex('vendor_oauth_states_state_hash_unique').on(table.stateHash),
  userCreatedIdx: index('vendor_oauth_states_user_created_idx').on(table.userId, table.createdAt),
  ttlCheck: check('vendor_oauth_states_ttl_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

/**
 * One row per image request in either mode, inserted BEFORE the vendor call:
 * the unique idempotency key stops a retry from billing twice, and the rows
 * give per-avatar daily limits that survive a restart.
 */
export const vendorCallRequests = pgTable('vendor_call_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  actor: varchar('actor', { length: 16 }).notNull(),
  surface: varchar('surface', { length: 16 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('pending'),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  mediaId: uuid('media_id').references(() => avatarMedia.id, { onDelete: 'set null' }),
  ledgerId: uuid('ledger_id').references(() => vendorSpendLedger.id, { onDelete: 'set null' }),
  // Migration 0093 ("ask me before each payment"): what a waiting request
  // runs at approve, its expiry, the decision, and our own failure code.
  prompt: text('prompt'),
  model: varchar('model', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  failureCode: varchar('failure_code', { length: 48 }),
  /** Account mode: SHA-256 of the saved key at queue time (never the key). */
  credentialSha256: varchar('credential_sha256', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  avatarVendorIdemUnique: uniqueIndex('vendor_call_requests_avatar_vendor_idem_unique').on(table.avatarId, table.vendor, table.idempotencyKey),
  avatarCreatedIdx: index('vendor_call_requests_avatar_created_idx').on(table.avatarId, table.createdAt),
}));

export type VendorCallRequestRow = typeof vendorCallRequests.$inferSelect;
export type AvatarMediaRow = typeof avatarMedia.$inferSelect;
export type UserVendorCredentialRow = typeof userVendorCredentials.$inferSelect;
export type VendorOAuthStateRow = typeof vendorOAuthStates.$inferSelect;
