/**
 * Images made by an avatar's paid tools, and a human's own vendor API keys
 * (migration 0091, MCP hub step 2 phase 2b). Written only by
 * `apps/api/src/services/studios-images.ts` and `services/vendor-credentials.ts`.
 */

import { customType, index, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
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
  mimeType: varchar('mime_type', { length: 32 }),
  bytes: bytea('bytes'),
  externalUrl: text('external_url'),
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

export type AvatarMediaRow = typeof avatarMedia.$inferSelect;
export type UserVendorCredentialRow = typeof userVendorCredentials.$inferSelect;
