-- 0042_sap_agent_identities.sql
-- Durable SAP registration + Metaplex AgentIdentity attachment registry.
--
-- ADDITIVE + IDEMPOTENT ONLY: a new table, CHECK constraints, and indexes.
-- The CI migrate gate applies this file; never use drizzle-kit push against the
-- shared database. The table records identity writes only and does not alter any
-- escrow, settlement, or withdrawal ledger.

CREATE TABLE IF NOT EXISTS "sap_agent_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "wallet" text NOT NULL,
  "agent_pda" text NOT NULL,
  "cluster" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_funding',
  "register_tx_sig" text,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metaplex_asset" text,
  "identity_registration" text,
  "metaplex_tx_sig" text,
  "trigger_source" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sap_agent_identities_cluster_valid"
    CHECK ("cluster" IN ('devnet', 'mainnet')),
  CONSTRAINT "sap_agent_identities_status_valid"
    CHECK ("status" IN (
      'pending_funding',
      'registering',
      'registered',
      'attaching_identity',
      'identity_attached',
      'failed'
    )),
  CONSTRAINT "sap_agent_identities_name_nonempty"
    CHECK (length(btrim("name")) > 0),
  CONSTRAINT "sap_agent_identities_description_nonempty"
    CHECK (length(btrim("description")) > 0),
  CONSTRAINT "sap_agent_identities_attempts_nonnegative"
    CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "sap_agent_identities_avatar_id_unique"
  ON "sap_agent_identities" ("avatar_id");

CREATE UNIQUE INDEX IF NOT EXISTS "sap_agent_identities_agent_pda_unique"
  ON "sap_agent_identities" ("agent_pda");

CREATE INDEX IF NOT EXISTS "sap_agent_identities_status_updated_idx"
  ON "sap_agent_identities" ("status", "updated_at");
