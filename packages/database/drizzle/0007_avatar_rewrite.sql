-- 0007_pets_to_avatars.sql
-- Avatars → Avatars rename. Preserves all production rows.
--
-- Order matters:
--   1) Data migrations on string-literal columns ('avatar' → 'avatar').
--   2) Structural renames: tables, then FK columns, then named indexes,
--      then named CHECK constraints, then pgEnum types.
--   3) Enum value swap is done via type-swap (CREATE NEW + USING + DROP)
--      because PG cannot drop a value from an existing enum, and an
--      ALTER TYPE ADD VALUE cannot be used in the same transaction it
--      was added in.
--
-- See .claude/plans/avatars-to-avatar-rewrite.md §1b for full spec.
-- Hand-authored — DO NOT regenerate via drizzle-kit (would emit DROP/CREATE).

BEGIN;

-- ─── (1) Data migrations on string-literal columns ──────────────────────

-- npc_memories.entity_type: 'avatar' → 'avatar' (varchar, no enum)
UPDATE npc_memories SET entity_type = 'avatar' WHERE entity_type = 'avatar';

-- events.payload->>'chatType': 'avatar' → 'avatar' (jsonb)
UPDATE events
  SET payload = jsonb_set(payload, '{chatType}', '"avatar"')
  WHERE payload->>'chatType' = 'avatar';

-- ─── (2) Rename main tables ─────────────────────────────────────────────
-- Each ALTER TABLE ... RENAME preserves all rows + FK constraints + indexes.

ALTER TABLE avatars RENAME TO avatars;
ALTER TABLE avatar_inventory RENAME TO avatar_inventory;
ALTER TABLE avatar_skins RENAME TO avatar_skins;

-- ─── (3) Rename FK columns across all referencing tables ────────────────
-- Each RENAME COLUMN preserves data + FK references (PG tracks via OID).

ALTER TABLE avatar_inventory RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE avatar_skins RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE activity_log RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE published_skills RENAME COLUMN author_pet_id TO author_avatar_id;
ALTER TABLE skill_upvotes RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE token_launches RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE bounty_reputation RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE auction_agent_configs RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE quest_submissions RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE quest_rewards RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE agent_configs RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE claw_token_transactions RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE activity_queue_entries RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE activity_room_participants RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE activity_results RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE activity_parties RENAME COLUMN leader_pet_id TO leader_avatar_id;
ALTER TABLE activity_party_members RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE events RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE agent_session_tickets RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE reef_race_personal_bests RENAME COLUMN avatar_id TO avatar_id;
ALTER TABLE tutorial_quest_claims RENAME COLUMN avatar_id TO avatar_id;

-- ─── (4) Rename hand-named indexes ──────────────────────────────────────
-- (Auto-named btree indexes for renamed FK columns are PG-internal and
--  follow the new column name automatically; we only rename indexes
--  explicitly created via `index('name')` in the Drizzle schema files.)

ALTER INDEX idx_arp_pet_joined RENAME TO idx_arp_avatar_joined;
ALTER INDEX uniq_pet_skin_pet_sku RENAME TO uniq_avatar_skin_avatar_sku;
ALTER INDEX idx_pet_skin_pet_equipped RENAME TO idx_avatar_skin_avatar_equipped;
ALTER INDEX idx_events_pet_ts RENAME TO idx_events_avatar_ts;
ALTER INDEX idx_activity_results_pet_created RENAME TO idx_activity_results_avatar_created;
ALTER INDEX idx_activity_queue_pet RENAME TO idx_activity_queue_avatar;
ALTER INDEX uq_reef_race_pb_pet_activity RENAME TO uq_reef_race_pb_avatar_activity;
ALTER INDEX claw_token_tx_pet_idx RENAME TO claw_token_tx_avatar_idx;
ALTER INDEX skill_upvotes_skill_pet_unique RENAME TO skill_upvotes_skill_avatar_unique;
-- 0004 added `idx_pets_is_guest` directly via SQL (no TS schema declaration).
ALTER INDEX idx_pets_is_guest RENAME TO idx_avatars_is_guest;

-- ─── (5) Rename CHECK constraints on the avatars table ──────────────────
-- (Postgres does NOT auto-rename CHECK constraints when the table is
--  renamed; their internal names stay `pets_*` until ALTER'd.)
--
-- Idempotent: phase 2 commit 4f45ea4b claims these CHECKs were applied
-- manually to prod, but parity is unverified. If the constraint never
-- existed, RENAME CONSTRAINT raises `undefined_object` and the surrounding
-- BEGIN block would roll back the whole migration. Wrap each rename in a
-- DO block that catches `undefined_object` and creates the constraint
-- under the new name instead. Allowed-value lists must match
-- `packages/database/src/schema/avatars.ts` lines 222-229.

DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_agent_category_valid TO avatars_agent_category_valid;
EXCEPTION WHEN undefined_object THEN
  -- Constraint was never applied to production. Add it under the new name.
  ALTER TABLE avatars
    ADD CONSTRAINT avatars_agent_category_valid
    CHECK (agent_category IN ('openclaw','hermes','milady','other'));
END $$;

DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_harness_valid TO avatars_harness_valid;
EXCEPTION WHEN undefined_object THEN
  ALTER TABLE avatars
    ADD CONSTRAINT avatars_harness_valid
    CHECK (harness IN ('openclaw','hermes','milady','custom'));
END $$;

-- ─── (5.5) Rename FK / UNIQUE / PK constraints to drop stale `avatar`/`avatars` ───
-- Postgres preserves constraint names through ALTER TABLE RENAME and
-- ALTER COLUMN RENAME — it stores constraints by OID, not by reconstructed
-- name. After steps (2)-(3), every FK/UNIQUE/PK still carries its OLD
-- name (e.g. `events_pet_id_pets_id_fk` on the `events` table referencing
-- `avatars.id`). Rename them so a future `bun run db:push` doesn't see
-- naming drift and emit DROP/ADD CONSTRAINT (which takes ACCESS EXCLUSIVE
-- locks on busy tables).
--
-- Each rename is wrapped in DO $$ ... EXCEPTION WHEN undefined_object so
-- the block is idempotent: if drizzle-kit's introspection already auto-
-- fixed a constraint during a prior push (or if a constraint never
-- existed in this environment), the rename becomes a no-op instead of
-- aborting the transaction.
--
-- List authoritative source: grep `CONSTRAINT "..*avatar.*"` across all SQL
-- in `packages/database/drizzle/`. 35 constraints below.

-- avatars table itself — primary table identity
DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_user_id_users_id_fk
    TO avatars_user_id_users_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_platform_agent_id_platform_agents_id_fk
    TO avatars_platform_agent_id_platform_agents_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_user_id_unique
    TO avatars_user_id_unique;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE avatars
    RENAME CONSTRAINT pets_name_unique
    TO avatars_name_unique;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- avatar_inventory
DO $$ BEGIN
  ALTER TABLE avatar_inventory
    RENAME CONSTRAINT avatar_inventory_avatar_id_avatars_id_fk
    TO avatar_inventory_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- avatar_skins (was avatar_skins)
DO $$ BEGIN
  ALTER TABLE avatar_skins
    RENAME CONSTRAINT pet_skins_pet_id_pets_id_fk
    TO avatar_skins_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE avatar_skins
    RENAME CONSTRAINT pet_skins_sku_id_cosmetic_skus_id_fk
    TO avatar_skins_sku_id_cosmetic_skus_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_log
DO $$ BEGIN
  ALTER TABLE activity_log
    RENAME CONSTRAINT activity_log_pet_id_pets_id_fk
    TO activity_log_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- published_skills
DO $$ BEGIN
  ALTER TABLE published_skills
    RENAME CONSTRAINT published_skills_author_pet_id_pets_id_fk
    TO published_skills_author_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- skill_upvotes
DO $$ BEGIN
  ALTER TABLE skill_upvotes
    RENAME CONSTRAINT skill_upvotes_pet_id_pets_id_fk
    TO skill_upvotes_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bazaar_listings
DO $$ BEGIN
  ALTER TABLE bazaar_listings
    RENAME CONSTRAINT bazaar_listings_seller_id_pets_id_fk
    TO bazaar_listings_seller_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bazaar_reviews
DO $$ BEGIN
  ALTER TABLE bazaar_reviews
    RENAME CONSTRAINT bazaar_reviews_reviewer_id_pets_id_fk
    TO bazaar_reviews_reviewer_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bazaar_transactions
DO $$ BEGIN
  ALTER TABLE bazaar_transactions
    RENAME CONSTRAINT bazaar_transactions_buyer_id_pets_id_fk
    TO bazaar_transactions_buyer_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bazaar_transactions
    RENAME CONSTRAINT bazaar_transactions_seller_id_pets_id_fk
    TO bazaar_transactions_seller_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- token_launches
DO $$ BEGIN
  ALTER TABLE token_launches
    RENAME CONSTRAINT token_launches_pet_id_pets_id_fk
    TO token_launches_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- claw_token_transactions
DO $$ BEGIN
  ALTER TABLE claw_token_transactions
    RENAME CONSTRAINT claw_token_transactions_pet_id_pets_id_fk
    TO claw_token_transactions_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- auction_agent_configs
DO $$ BEGIN
  ALTER TABLE auction_agent_configs
    RENAME CONSTRAINT auction_agent_configs_pet_id_pets_id_fk
    TO auction_agent_configs_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- auction_bids
DO $$ BEGIN
  ALTER TABLE auction_bids
    RENAME CONSTRAINT auction_bids_bidder_id_pets_id_fk
    TO auction_bids_bidder_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- auctions
DO $$ BEGIN
  ALTER TABLE auctions
    RENAME CONSTRAINT auctions_seller_id_pets_id_fk
    TO auctions_seller_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE auctions
    RENAME CONSTRAINT auctions_current_bidder_id_pets_id_fk
    TO auctions_current_bidder_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- quest_rewards
DO $$ BEGIN
  ALTER TABLE quest_rewards
    RENAME CONSTRAINT quest_rewards_pet_id_pets_id_fk
    TO quest_rewards_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- quest_submissions
DO $$ BEGIN
  ALTER TABLE quest_submissions
    RENAME CONSTRAINT quest_submissions_pet_id_pets_id_fk
    TO quest_submissions_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- agent_configs
DO $$ BEGIN
  ALTER TABLE agent_configs
    RENAME CONSTRAINT agent_configs_pet_id_pets_id_fk
    TO agent_configs_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bounties
DO $$ BEGIN
  ALTER TABLE bounties
    RENAME CONSTRAINT bounties_creator_id_pets_id_fk
    TO bounties_creator_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bounty_attempts
DO $$ BEGIN
  ALTER TABLE bounty_attempts
    RENAME CONSTRAINT bounty_attempts_hunter_id_pets_id_fk
    TO bounty_attempts_hunter_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- bounty_reputation
DO $$ BEGIN
  ALTER TABLE bounty_reputation
    RENAME CONSTRAINT bounty_reputation_pet_id_pets_id_fk
    TO bounty_reputation_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bounty_reputation
    RENAME CONSTRAINT bounty_reputation_pet_id_unique
    TO bounty_reputation_avatar_id_unique;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- agent_session_tickets
DO $$ BEGIN
  ALTER TABLE agent_session_tickets
    RENAME CONSTRAINT agent_session_tickets_pet_id_pets_id_fk
    TO agent_session_tickets_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- events
DO $$ BEGIN
  ALTER TABLE events
    RENAME CONSTRAINT events_pet_id_pets_id_fk
    TO events_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_room_participants — has both PK and FK
DO $$ BEGIN
  ALTER TABLE activity_room_participants
    RENAME CONSTRAINT activity_room_participants_room_id_pet_id_pk
    TO activity_room_participants_room_id_avatar_id_pk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE activity_room_participants
    RENAME CONSTRAINT activity_room_participants_pet_id_pets_id_fk
    TO activity_room_participants_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_results
DO $$ BEGIN
  ALTER TABLE activity_results
    RENAME CONSTRAINT activity_results_pet_id_pets_id_fk
    TO activity_results_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_queue_entries
DO $$ BEGIN
  ALTER TABLE activity_queue_entries
    RENAME CONSTRAINT activity_queue_entries_pet_id_pets_id_fk
    TO activity_queue_entries_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_parties
DO $$ BEGIN
  ALTER TABLE activity_parties
    RENAME CONSTRAINT activity_parties_leader_pet_id_pets_id_fk
    TO activity_parties_leader_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- activity_party_members — has both PK and FK
DO $$ BEGIN
  ALTER TABLE activity_party_members
    RENAME CONSTRAINT activity_party_members_party_id_pet_id_pk
    TO activity_party_members_party_id_avatar_id_pk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE activity_party_members
    RENAME CONSTRAINT activity_party_members_pet_id_pets_id_fk
    TO activity_party_members_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- reef_race_personal_bests
DO $$ BEGIN
  ALTER TABLE reef_race_personal_bests
    RENAME CONSTRAINT reef_race_personal_bests_pet_id_pets_id_fk
    TO reef_race_personal_bests_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- tutorial_quest_claims
DO $$ BEGIN
  ALTER TABLE tutorial_quest_claims
    RENAME CONSTRAINT tutorial_quest_claims_pet_id_pets_id_fk
    TO tutorial_quest_claims_avatar_id_avatars_id_fk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ─── (6) Rename pgEnum types (values stay) ──────────────────────────────

ALTER TYPE avatar_species RENAME TO avatar_species;
ALTER TYPE avatar_color RENAME TO avatar_color;
ALTER TYPE avatar_gender RENAME TO avatar_gender;
ALTER TYPE pet_avatar_type RENAME TO avatar_render_type;

-- ─── (7) wallet_subject_type — value swap via type-replace ─────────────
-- Single-statement type swap with USING CAST handles the data migration:
--   any existing 'avatar' rows become 'avatar' atomically.
--
-- We can't use `ALTER TYPE wallet_subject_type ADD VALUE 'avatar'` because
-- PG forbids using the new value in the same transaction it's added in.
-- We can't use `ALTER TYPE … RENAME VALUE 'avatar' TO 'avatar'` because PG
-- ≤16 lacks RENAME VALUE entirely (added in 17). The swap is the
-- portable solution and survives downgrades.

CREATE TYPE wallet_subject_type_new AS ENUM ('avatar', 'agent', 'treasury');

ALTER TABLE wallets
  ALTER COLUMN subject_type TYPE wallet_subject_type_new
  USING (
    CASE subject_type::text
      WHEN 'avatar' THEN 'avatar'
      ELSE subject_type::text
    END
  )::wallet_subject_type_new;

DROP TYPE wallet_subject_type;
ALTER TYPE wallet_subject_type_new RENAME TO wallet_subject_type;

COMMIT;
