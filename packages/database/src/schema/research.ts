import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

/**
 * Research articles — pre-scraped article cache per location/crypto topic.
 * 20 curated articles per location, scraped and cached for instant research.
 */
export const researchArticles = pgTable('research_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Location this article belongs to (e.g. 'potion-shop', 'bazaar') */
  locationId: varchar('location_id', { length: 50 }).notNull(),
  url: text('url').notNull(),
  title: varchar('title', { length: 300 }).notNull(),
  /** Source publication (e.g. 'CoinDesk', 'Bankless') */
  source: varchar('source', { length: 100 }).notNull(),
  /** Scraped article content as markdown text */
  content: text('content').notNull().default(''),
  /** SHA-256 hash of content for dedup */
  contentHash: varchar('content_hash', { length: 64 }),
  scrapedAt: timestamp('scraped_at').defaultNow().notNull(),
  /** 'success' | 'failed' | 'pending' */
  scrapeStatus: varchar('scrape_status', { length: 20 }).notNull().default('pending'),
  /** Extra metadata: { wordCount, readingTime, errorMessage? } */
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
