-- Land gamification P7a: the seabed-salvage claim core.
-- Idempotent DDL; migrate-ci applies the file atomically. FORWARD-ONLY — this
-- never edits 0053-0055 and never touches the frozen 0051/0052 tenure core.
--
-- Three tables, three distinct jobs:
--   salvage_node_claims       per-(avatar, node) cooldown + the claim ordinal
--                             the HMAC yield is derived from
--   salvage_daily_admissions  per-avatar UTC-day claim + material cap
--   salvage_owner_admissions  per-OWNER UTC-day claim cap (the anti-fleet bound)
--
-- `salvage_claim_receipts` already exists (0053) and is NOT recreated here.
--
-- WHY THE CAP LIVES IN BOTH THE UPSERT AND A CHECK
-- ------------------------------------------------
-- Admission is an atomic conditional upsert (`... DO UPDATE ... WHERE
-- claims_admitted < cap RETURNING`), which is what actually enforces the cap
-- under concurrency: zero returned rows means refused, and no read-then-write
-- window exists. The CHECK constraints below can therefore never fire in normal
-- operation. They are a backstop against a future writer that forgets the
-- WHERE clause — a cap breach becomes a loud constraint violation instead of
-- silent over-issuance of currency.
--
-- The bounds are PINNED to the shared constants
-- (`SALVAGE_AVATAR_DAILY_CLAIM_CAP = 20`, `SALVAGE_OWNER_DAILY_CLAIM_CAP = 120`,
-- `SALVAGE_YIELD_MAX = 3`). Raising a constant WITHOUT a forward migration turns
-- every claim past the old bound into a check violation rather than a clean 429,
-- so `land-salvage.test.ts` asserts the constants and this file agree.

CREATE TABLE IF NOT EXISTS "salvage_node_claims" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id"       uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "node_id"         text NOT NULL,
  "layout_version"  integer NOT NULL,
  -- Monotonic per (avatar, node). Feeds the HMAC yield, so it must never be
  -- reset or reused: repeating an ordinal repeats a yield.
  "claim_ordinal"   integer NOT NULL DEFAULT 0,
  "last_claimed_at" timestamptz NOT NULL,
  "next_claim_at"   timestamptz NOT NULL
);

ALTER TABLE "salvage_node_claims"
  DROP CONSTRAINT IF EXISTS "salvage_node_claims_ord_nonneg";
ALTER TABLE "salvage_node_claims"
  ADD CONSTRAINT "salvage_node_claims_ord_nonneg" CHECK ("claim_ordinal" >= 0);

-- The cooldown row is per (avatar, node) and is the FOR UPDATE target of every
-- claim, so this index is both the uniqueness barrier and the lookup path.
CREATE UNIQUE INDEX IF NOT EXISTS "salvage_node_claims_uniq"
  ON "salvage_node_claims" ("avatar_id", "node_id");

-- Read model: "which of my nodes are ready" is a per-avatar scan ordered by
-- readiness.
CREATE INDEX IF NOT EXISTS "salvage_node_claims_ready"
  ON "salvage_node_claims" ("avatar_id", "next_claim_at");

CREATE TABLE IF NOT EXISTS "salvage_daily_admissions" (
  "avatar_id"        uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "utc_day"          date NOT NULL,
  "claims_admitted"  integer NOT NULL DEFAULT 0,
  "materials_issued" integer NOT NULL DEFAULT 0,
  CONSTRAINT "salvage_daily_pk" PRIMARY KEY ("avatar_id", "utc_day")
);

ALTER TABLE "salvage_daily_admissions"
  DROP CONSTRAINT IF EXISTS "salvage_daily_cap";
ALTER TABLE "salvage_daily_admissions"
  ADD CONSTRAINT "salvage_daily_cap"
  CHECK ("claims_admitted" BETWEEN 0 AND 20);

ALTER TABLE "salvage_daily_admissions"
  DROP CONSTRAINT IF EXISTS "salvage_daily_mat_cap";
ALTER TABLE "salvage_daily_admissions"
  ADD CONSTRAINT "salvage_daily_mat_cap"
  CHECK ("materials_issued" BETWEEN 0 AND 60);

-- owner_kind is a single-value enum today ('user'). The design deleted the
-- 'agent' kind deliberately: `platform_agents.user_id` is NOT NULL, so every
-- admissible agent resolves to a user principal, and an unbound session is
-- refused outright rather than given its own bucket. The CHECK keeps a future
-- writer from inventing a second kind that would silently double the cap.
CREATE TABLE IF NOT EXISTS "salvage_owner_admissions" (
  "owner_kind"      text NOT NULL,
  "owner_id"        uuid NOT NULL,
  "utc_day"         date NOT NULL,
  "claims_admitted" integer NOT NULL DEFAULT 0,
  CONSTRAINT "salvage_owner_pk" PRIMARY KEY ("owner_kind", "owner_id", "utc_day")
);

ALTER TABLE "salvage_owner_admissions"
  DROP CONSTRAINT IF EXISTS "salvage_owner_kind";
ALTER TABLE "salvage_owner_admissions"
  ADD CONSTRAINT "salvage_owner_kind" CHECK ("owner_kind" = 'user');

ALTER TABLE "salvage_owner_admissions"
  DROP CONSTRAINT IF EXISTS "salvage_owner_cap";
ALTER TABLE "salvage_owner_admissions"
  ADD CONSTRAINT "salvage_owner_cap"
  CHECK ("claims_admitted" BETWEEN 0 AND 120);
