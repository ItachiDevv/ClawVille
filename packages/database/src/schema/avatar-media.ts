/**
 * Images made by an avatar's paid tools, and a human's own vendor API keys
 * (migration 0091, MCP hub step 2 phase 2b). Written only by
 * `apps/api/src/services/studios-images.ts` and `services/vendor-credentials.ts`.
 */

import { customType, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
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

export const userVendorCredentials = pgTable('user_vendor_credentials', {
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  vendor: varchar('vendor', { length: 32 }).notNull(),
  enc: text('enc').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  last4: varchar('last4', { length: 4 }).notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_vendor_credentials_pk', columns: [table.avatarId, table.vendor] }),
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
