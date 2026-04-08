import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { pets } from './pets';
import { publishedSkills } from './marketplace';

export const bazaarListingStatusEnum = pgEnum('bazaar_listing_status', [
  'active',
  'sold',
  'cancelled',
  'expired',
]);

export const bazaarListings = pgTable('bazaar_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  skillId: uuid('skill_id')
    .notNull()
    .references(() => publishedSkills.id, { onDelete: 'cascade' }),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  price: integer('price').notNull(),
  status: bazaarListingStatusEnum('status').default('active').notNull(),
  featuredAt: timestamp('featured_at'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const bazaarTransactions = pgTable('bazaar_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id')
    .notNull()
    .references(() => bazaarListings.id, { onDelete: 'cascade' }),
  buyerId: uuid('buyer_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id')
    .notNull()
    .references(() => publishedSkills.id, { onDelete: 'cascade' }),
  price: integer('price').notNull(),
  platformFee: integer('platform_fee').notNull(),
  sellerPayout: integer('seller_payout').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const bazaarReviews = pgTable('bazaar_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => bazaarTransactions.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id')
    .notNull()
    .references(() => publishedSkills.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
