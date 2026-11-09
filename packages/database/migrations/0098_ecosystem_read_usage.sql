-- 0098_ecosystem_read_usage.sql
-- MCP hub, market and trust reads (2026-11-07): the vendor calls of one avatar
-- on one UTC day. One atomic upsert (`calls < limit`) checks the budget and
-- counts the call before ClawVille calls the vendor. A reply from the shared
-- in-process cache writes nothing. The limit is the code constant
-- ECOSYSTEM_READS_PER_AVATAR_PER_DAY, not a column.
-- Additive and idempotent. Old code does not read this table.

CREATE TABLE IF NOT EXISTS "ecosystem_read_usage" (
  "avatar_id" uuid NOT NULL,
  "day" date NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ecosystem_read_usage_pkey" PRIMARY KEY ("avatar_id", "day"),
  CONSTRAINT "ecosystem_read_usage_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade
);
