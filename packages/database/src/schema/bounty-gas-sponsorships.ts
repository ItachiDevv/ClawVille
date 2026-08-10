import {
  pgTable,
  uuid,
  text,
  bigint,
  date,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Database-owned cap authority. The first reservation of a UTC day creates it. */
export const bountyGasCapPolicies = pgTable(
  "bounty_gas_cap_policies",
  {
    capDay: date("cap_day", { mode: "string" }).primaryKey(),
    capLamports: bigint("cap_lamports", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    positiveCap: check(
      "bounty_gas_cap_policies_cap_positive",
      sql`${t.capLamports} > 0`,
    ),
  }),
);

/**
 * Durable cap reservations for composed-bounty SOL sponsorship. A row is
 * inserted before a transfer, so concurrent workers and process restarts cannot
 * overspend the UTC-day breaker. `pending`/`unconfirmed`/`quarantined`
 * reservations count against the cap until an operator reconciles them;
 * ambiguity fails closed.
 */
export const bountyGasSponsorships = pgTable(
  "bounty_gas_sponsorships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bountyId: uuid("bounty_id").notNull(),
    leg: text("leg").notNull(),
    workerWallet: text("worker_wallet").notNull(),
    lamports: bigint("lamports", { mode: "bigint" }).notNull(),
    capDay: date("cap_day", { mode: "string" }).notNull(),
    capLamports: bigint("cap_lamports", { mode: "bigint" }).notNull(),
    status: text("status").notNull(),
    signature: text("signature").notNull(),
    serializedTransaction: text("serialized_transaction").notNull(),
    blockhash: text("blockhash").notNull(),
    lastValidBlockHeight: bigint("last_valid_block_height", {
      mode: "bigint",
    }).notNull(),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
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
    dailyCapIdx: index("bounty_gas_sponsorships_cap_day_idx").on(
      t.capDay,
      t.status,
    ),
    positiveLamports: check(
      "bounty_gas_sponsorships_lamports_positive",
      sql`${t.lamports} > 0`,
    ),
    positiveCap: check(
      "bounty_gas_sponsorships_cap_positive",
      sql`${t.capLamports} > 0`,
    ),
    legValid: check(
      "bounty_gas_sponsorships_leg_valid",
      sql`${t.leg} IN ('settle', 'finalize')`,
    ),
    statusValid: check(
      "bounty_gas_sponsorships_status_valid",
      sql`${t.status} IN ('pending', 'unconfirmed', 'quarantined', 'confirmed', 'failed')`,
    ),
    claimLeasePair: check(
      "bounty_gas_sponsorships_claim_lease_pair",
      sql`(${t.claimId} IS NULL) = (${t.claimedAt} IS NULL)`,
    ),
  }),
);

export type BountyGasSponsorship = typeof bountyGasSponsorships.$inferSelect;
export type BountyGasCapPolicy = typeof bountyGasCapPolicies.$inferSelect;
