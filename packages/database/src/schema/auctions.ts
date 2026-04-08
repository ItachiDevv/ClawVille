import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { publishedSkills } from './marketplace';

export const auctionStatusEnum = pgEnum('auction_status', [
  'active',
  'ended',
  'cancelled',
  'resolved',
]);

export const auctionItemTypeEnum = pgEnum('auction_item_type', [
  'skill',
  'agent_config',
]);

export const auctions = pgTable('auctions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  itemType: auctionItemTypeEnum('item_type').notNull(),
  skillId: uuid('skill_id')
    .references(() => publishedSkills.id, { onDelete: 'set null' }),
  agentConfigSnapshot: jsonb('agent_config_snapshot'),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  startingBid: integer('starting_bid').notNull(),
  currentBid: integer('current_bid'),
  buyNowPrice: integer('buy_now_price'),
  currentBidderId: uuid('current_bidder_id')
    .references(() => avatars.id, { onDelete: 'set null' }),
  bidCount: integer('bid_count').default(0).notNull(),
  status: auctionStatusEnum('status').default('active').notNull(),
  endsAt: timestamp('ends_at').notNull(),
  originalEndsAt: timestamp('original_ends_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const auctionBids = pgTable('auction_bids', {
  id: uuid('id').primaryKey().defaultRandom(),
  auctionId: uuid('auction_id')
    .notNull()
    .references(() => auctions.id, { onDelete: 'cascade' }),
  bidderId: uuid('bidder_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  isAutoBid: boolean('is_auto_bid').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auctionAgentConfigs = pgTable('auction_agent_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  auctionId: uuid('auction_id')
    .notNull()
    .references(() => auctions.id, { onDelete: 'cascade' }),
  avatarId: uuid('avatar_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  configSnapshot: jsonb('config_snapshot').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
