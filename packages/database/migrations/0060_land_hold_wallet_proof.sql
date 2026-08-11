-- Land hold-wallet OWNERSHIP PROOF (founder ruling 2026-08-10: "optional proof
-- is just not proof"). Declaring a hold wallet you do not control let an account
-- claim hold-door land backed by SOMEONE ELSE'S CLV balance. Proof is now
-- REQUIRED before the hold door opens.
--
-- Idempotent DDL; migrate-ci applies this file atomically as one implicit
-- transaction. NOTE: the `treasury_purpose` enum value 'land-hold-verify' that
-- door 2 needs is DELIBERATELY NOT here — `ALTER TYPE ... ADD VALUE` cannot run
-- inside a transaction block, so it lives ALONE in 0060a and the singleton index
-- that uses it lives in 0060b (the 0057a/0057b precedent). Nothing in this file
-- references that enum value.
--
-- FAIL-CLOSED DESIGN (trap T1): verification is PUBKEY-BOUND, never row-bound.
-- `land_hold_wallet_verified_pubkey` is compared against the CURRENT
-- `land_hold_wallet_pubkey` on every gate, so declare-A -> verify-A ->
-- change-to-B can never inherit A's proof even if the clear-on-change in
-- `declareLandHoldWallet` were to regress.

-- ── Retired treasury wallets ────────────────────────────────────────────────
-- Verify-wallet ROTATION has to be representable. Dust already sent to a
-- previous verify address stays recoverable only while we keep that row and its
-- encrypted key, and the rotated-destination discovery in
-- `land-hold-transfer-verify.ts` needs to know the retired addresses. An
-- active-only singleton (0060b) plus this marker gives exactly one live wallet
-- with every retired one persisting beside it. Nullable and additive, so no
-- other treasury purpose is affected.
ALTER TABLE "treasury_wallets"
  ADD COLUMN IF NOT EXISTS "retired_at" timestamptz;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_verified_at" timestamptz;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_verified_method" varchar(16);
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_verified_pubkey" varchar(44);
-- One-shot grandfather discriminator (trap T2). Stamped ONCE by the UPDATE at
-- the bottom of this file, keyed on a HARD-CODED literal cutoff. Application
-- code MUST NEVER write a non-null value here — it may only NULL it.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_grandfathered_pubkey" varchar(44);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_land_hold_wallet_verified_method_valid'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_land_hold_wallet_verified_method_valid"
      CHECK (
        "land_hold_wallet_verified_method" IS NULL
        OR "land_hold_wallet_verified_method" IN ('signature', 'transfer', 'custodial')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_land_hold_wallet_verified_shape'
  ) THEN
    -- All-NULL or all-NON-NULL. A half-written verification tuple can never be
    -- read as proof.
    ALTER TABLE "users"
      ADD CONSTRAINT "users_land_hold_wallet_verified_shape"
      CHECK (
        (
          "land_hold_wallet_verified_at" IS NULL
          AND "land_hold_wallet_verified_method" IS NULL
          AND "land_hold_wallet_verified_pubkey" IS NULL
        ) OR (
          "land_hold_wallet_verified_at" IS NOT NULL
          AND "land_hold_wallet_verified_method" IS NOT NULL
          AND "land_hold_wallet_verified_pubkey" IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "users"
  VALIDATE CONSTRAINT "users_land_hold_wallet_verified_method_valid";
ALTER TABLE "users"
  VALIDATE CONSTRAINT "users_land_hold_wallet_verified_shape";

-- ── Door 2: exact-dust transfer challenges ──────────────────────────────────
-- A user who will not connect a browser wallet sends an exact unique dust
-- amount of SOL from the declared wallet to a ClawVille verify address, WITH an
-- SPL Memo naming the challenge id. We attribute by exact amount + sender,
-- require the memo as the sender's statement of intent, grant on FINALIZED,
-- then AUTO-REFUND. (Amount + sender alone prove only that the wallet sent us
-- lamports, which a phished whale can be made to do for someone else's
-- declaration; the memo names the challenge, so it cannot be induced blind.)
--
-- `rejected` + `rejected_reason` is how an EXACT-amount inbound that cannot be
-- proof is recorded: the signature is still consumed so the money is REFUNDED,
-- and the user is told what went wrong instead of waiting out the TTL.
-- DB-owned daily refund-fee cap policy, mirroring `bounty_gas_cap_policies`
-- (migration 0057b). The FIRST cap-consuming admission of a UTC day owns that
-- day's value; every later pod must agree with it or its admission is refused
-- and ops are paged. Without this, a cap change across a rolling deploy is
-- neither persisted nor reconcilable after the fact.
CREATE TABLE IF NOT EXISTS "land_hold_verify_cap_policies" (
  "cap_day" date PRIMARY KEY,
  "cap_lamports" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "land_hold_verify_cap_policies_cap_positive" CHECK ("cap_lamports" > 0)
);

CREATE TABLE IF NOT EXISTS "land_hold_wallet_transfer_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT, deliberately NOT CASCADE: this is a live money ledger.
  -- Cascading an account deletion mid-processing would strand inbound SOL at the
  -- verify address AND destroy the audit trail that proves we owe it back.
  -- `wallet_pubkey` is the immutable account-side snapshot on every row.
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "wallet_pubkey" varchar(44) NOT NULL,
  "lamports" bigint NOT NULL,
  -- What we ACTUALLY received from `wallet_pubkey` in the attributed
  -- transaction, summed across every leg. A transaction may carry the exact
  -- amount MORE THAN ONCE (or carry extra legs), and refunding only `lamports`
  -- would silently keep the surplus. The refund pays this.
  "inbound_lamports" bigint,
  "destination_pubkey" varchar(44) NOT NULL,
  "status" text NOT NULL,
  "rejected_reason" varchar(32),
  "expires_at" timestamptz NOT NULL,
  "inbound_signature" varchar(128),
  "refund_state" text,
  "refund_signature" varchar(128),
  "refund_claim_id" uuid,
  "refund_claimed_at" timestamptz,
  -- Immutable spend-window stamp, written under the global cap lock when the
  -- refund is AUTHORIZED. Counting spend by `created_at` let a deferred backlog
  -- age out of the window and then blow past the cap all at once on resume.
  "refund_cap_day" date,
  "refund_cap_lamports" bigint,
  "refund_authorized_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "land_hold_wallet_transfer_challenges_lamports_positive"
    CHECK ("lamports" > 0),
  CONSTRAINT "land_hold_wallet_transfer_challenges_inbound_lamports_positive"
    CHECK ("inbound_lamports" IS NULL OR "inbound_lamports" > 0),
  -- 'unclaimed' = the background scan found this money on chain but the user
  -- never SUBMITTED the signature. Verification is submission-only, so the row
  -- is refunded and NEVER verified.
  CONSTRAINT "land_hold_wallet_transfer_challenges_status_valid"
    CHECK ("status" IN ('pending', 'observed', 'verified', 'expired', 'failed',
                        'rejected', 'unclaimed')),
  CONSTRAINT "land_hold_wallet_transfer_challenges_rejected_reason_valid"
    CHECK (
      "rejected_reason" IS NULL
      OR "rejected_reason" IN ('memo_missing', 'source_not_signer', 'transfer_not_top_level')
    ),
  -- A reason exists exactly when the row is rejected, so no state can carry a
  -- stale explanation and no rejection can be silent.
  CONSTRAINT "land_hold_wallet_transfer_challenges_rejected_reason_pair"
    CHECK (("status" = 'rejected') = ("rejected_reason" IS NOT NULL)),
  CONSTRAINT "land_hold_wallet_transfer_challenges_refund_state_valid"
    CHECK (
      "refund_state" IS NULL
      OR "refund_state" IN ('none', 'sending', 'sent', 'reconcile', 'skipped')
    ),
  -- Mirrors bounty_gas_sponsorships_claim_lease_pair (migration 0057b).
  CONSTRAINT "land_hold_wallet_transfer_challenges_refund_claim_lease_pair"
    CHECK (("refund_claim_id" IS NULL) = ("refund_claimed_at" IS NULL)),
  -- The authorization stamp moves as ONE unit, like the verification tuple on
  -- users: a half-written policy stamp can never be read as a spend record.
  CONSTRAINT "land_hold_wallet_transfer_challenges_refund_cap_stamp"
    CHECK (
      ("refund_cap_day" IS NULL AND "refund_cap_lamports" IS NULL
        AND "refund_authorized_at" IS NULL)
      OR ("refund_cap_day" IS NOT NULL AND "refund_cap_lamports" IS NOT NULL
        AND "refund_authorized_at" IS NOT NULL)
    )
);

-- Trap T6: exact-amount attribution only works if no two OPEN challenges share
-- an amount. The service regenerates on a 23505 collision.
CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_pending_lamports_unique"
  ON "land_hold_wallet_transfer_challenges" ("lamports")
  WHERE "status" = 'pending';

-- Trap T7: one inbound signature satisfies AT MOST one challenge, so a replayed
-- or duplicated scan is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_inbound_signature_unique"
  ON "land_hold_wallet_transfer_challenges" ("inbound_signature")
  WHERE "inbound_signature" IS NOT NULL;

-- Refund transactions are deterministic in their bytes (fee payer, blockhash,
-- destination, amount), and amounts become reusable once a challenge closes, so
-- two backlogged refunds to the same wallet for the same reused amount under the
-- same recent blockhash produced the IDENTICAL signature. Solana deduped the
-- second while both rows recorded it as `sent`, keeping one user's deposit. The
-- refund now carries a per-challenge memo so the bytes can never coincide, and
-- this index is the database backstop: a collision surfaces as a 23505 at
-- capture and the row is quarantined instead of pretending to have paid.
CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_refund_signature_unique"
  ON "land_hold_wallet_transfer_challenges" ("refund_signature")
  WHERE "refund_signature" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_status_expires_idx"
  ON "land_hold_wallet_transfer_challenges" ("status", "expires_at");

-- Trap T5: the per-user daily attempt cap counts this user's recent rows.
CREATE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_user_created_idx"
  ON "land_hold_wallet_transfer_challenges" ("user_id", "created_at" DESC);

-- The refund-fee cap is summed per authorization day, so it must be indexed by
-- the stamp rather than by row creation.
CREATE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_refund_cap_day_idx"
  ON "land_hold_wallet_transfer_challenges" ("refund_cap_day")
  WHERE "refund_cap_day" IS NOT NULL;

-- ── Durable scan ledger ─────────────────────────────────────────────────────
-- The attribution scan used to read one 50-signature page and re-parse
-- everything it did not match, so 25 one-lamport spam transfers could keep a
-- real deposit at position 26 from EVER being examined: after its grace window
-- the user's SOL was neither attributed nor refunded. This table is the durable
-- work queue behind cursor-paginated scanning — every signature is parsed at
-- most once per destination, the decision survives restarts, and paging walks
-- back to the oldest open challenge instead of stopping at the newest page.
-- `facts` holds the parsed transfer/memo/signer facts for THIS destination, so a
-- challenge opened later can be matched against an earlier parse. Storing only a
-- "seen" flag would make the ledger a blindfold: the parse cost is paid once,
-- but the matching opportunity must never expire.
CREATE TABLE IF NOT EXISTS "land_hold_wallet_verify_scans" (
  "destination_pubkey" varchar(44) NOT NULL,
  "signature" varchar(128) NOT NULL,
  "block_time" timestamptz,
  "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "matched" boolean NOT NULL DEFAULT false,
  "scanned_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("destination_pubkey", "signature")
);

CREATE INDEX IF NOT EXISTS "land_hold_wallet_verify_scans_scanned_at_idx"
  ON "land_hold_wallet_verify_scans" ("scanned_at");

-- ── Refund obligations ──────────────────────────────────────────────────────
-- User funds sitting at a verify address that NO challenge row can return:
-- another sender's legs inside a transaction we settled for someone else
-- ('retained_leg'), dust paid to a verify address whose key we no longer hold
-- ('destination_rotated'), and money that arrived, was never submitted, and is
-- now past every live challenge window ('unclaimed_inbound').
--
-- The invariant this table exists for: an ALERT must never be the only record of
-- retained user funds. Settlement is operator-driven today; the row is the
-- durable, queryable claim that we owe it.
CREATE TABLE IF NOT EXISTS "land_hold_wallet_refund_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "destination_pubkey" varchar(44) NOT NULL,
  "signature" varchar(128) NOT NULL,
  "recipient_pubkey" varchar(44) NOT NULL,
  "lamports" bigint NOT NULL,
  "reason" varchar(32) NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "challenge_id" uuid REFERENCES "land_hold_wallet_transfer_challenges"("id") ON DELETE RESTRICT,
  "settled_signature" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "land_hold_wallet_refund_obligations_lamports_positive"
    CHECK ("lamports" > 0),
  CONSTRAINT "land_hold_wallet_refund_obligations_reason_valid"
    CHECK ("reason" IN ('retained_leg', 'destination_rotated', 'unclaimed_inbound')),
  CONSTRAINT "land_hold_wallet_refund_obligations_state_valid"
    CHECK ("state" IN ('open', 'settled', 'void'))
);

-- One obligation per (destination, signature, recipient, reason): re-observing
-- the same retained funds must never create a second claim on the same money.
-- The DESTINATION is part of the key because ONE transaction can fund several
-- historical verify addresses; without it those are two genuinely different
-- debts that could not even be represented independently, and a void scoped by
-- signature alone would erase the wrong one.
CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_refund_obligations_unique"
  ON "land_hold_wallet_refund_obligations"
     ("destination_pubkey", "signature", "recipient_pubkey", "reason");

CREATE INDEX IF NOT EXISTS "land_hold_wallet_refund_obligations_open_idx"
  ON "land_hold_wallet_refund_obligations" ("state", "created_at")
  WHERE "state" = 'open';

-- The match phase reads a destination's facts newest-first inside the candidate
-- window.
CREATE INDEX IF NOT EXISTS "land_hold_wallet_verify_scans_destination_block_time_idx"
  ON "land_hold_wallet_verify_scans" ("destination_pubkey", "block_time" DESC);

-- ── Grandfather stamp (trap T2) ─────────────────────────────────────────────
-- ONE-SHOT, migration-only, keyed on a HARD-CODED LITERAL cutoff — never now(),
-- never "verified IS NULL". A re-run of this file can therefore NEVER capture a
-- declaration made after the cutoff: a fresh declare stamps
-- land_hold_wallet_declared_at = now(), which is >= the cutoff. The cutoff is
-- this migration's authoring instant rounded DOWN to the UTC day, which errs
-- toward requiring proof rather than granting it.
--
-- Grandfathered accounts are NOT evicted (trap T12): the rent sweeper is
-- untouched and every existing live hold keeps working. Grandfathering does NOT
-- admit a NEW hold-door claim (adversarial review 2026-08-10: a pre-cutoff
-- squatter would otherwise keep acquiring land on a wallet it never proved).
-- The stamp survives only so the status surface can report `grandfathered` and
-- the UI can prompt that account to verify.
UPDATE "users"
SET "land_hold_wallet_grandfathered_pubkey" = "land_hold_wallet_pubkey"
WHERE "land_hold_wallet_pubkey" IS NOT NULL
  AND "land_hold_wallet_grandfathered_pubkey" IS NULL
  AND (
    "land_hold_wallet_declared_at" IS NULL
    OR "land_hold_wallet_declared_at" < TIMESTAMPTZ '2026-08-10 00:00:00+00'
  );
