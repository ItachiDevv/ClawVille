import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Durable cap reservations for composed-bounty SOL sponsorship. A row is
 * inserted before a transfer, so concurrent workers and process restarts cannot
 * overspend the UTC-day breaker. `pending`/`unconfirmed` reservations count
 * against the cap until an operator reconciles them; ambiguity fails closed.
 */
export const bountyGasSponsorships = pgTable(
  "bounty_gas_sponsorships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bountyId: uuid("bounty_id").notNull(),
    leg: text("leg").notNull(),
    workerWallet: text("worker_wallet").notNull(),
    lamports: bigint("lamports", { mode: "bigint" }).notNull(),
    status: text("status").notNull(),
    signature: text("signature"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    dedupeUnique: uniqueIndex("bounty_gas_sponsorships_dedupe_unique").on(
      t.dedupeKey,
    ),
    dailyCapIdx: index("bounty_gas_sponsorships_daily_cap_idx").on(
      t.createdAt,
      t.status,
    ),
  }),
);

export type BountyGasSponsorship = typeof bountyGasSponsorships.$inferSelect;
