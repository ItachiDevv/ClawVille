-- DoorDash Phase 2 order ledger (operator-only, founder account only).
--
-- This table is the durable record behind the confirm protocol and the spend
-- caps. Counts and sums MUST come from here, never from process memory, so a
-- container restart cannot reset a cap.
--
-- Stored deliberately: totals, tip, status, timestamps, opaque DoorDash uuids,
-- and a HASH of the confirmation code.
-- Never stored: the access token, payment-method details, the delivery address,
-- item names, or any raw dd-cli JSON. Data minimisation is a control here, and
-- the CLI terms of service (section 6) forbid retaining vendor catalogue data.
CREATE TABLE IF NOT EXISTS doordash_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           text NOT NULL,
  avatar_id         uuid,
  subject_kind      text NOT NULL CHECK (subject_kind IN ('human','agent')),
  cart_uuid         text NOT NULL,
  order_uuid        text,
  status            text NOT NULL CHECK (status IN ('previewed','submitting','submitted','failed','refused')),
  -- Priced total BEFORE tip, in cents, as quoted by `order preview`.
  total_cents       integer NOT NULL CHECK (total_cents >= 0),
  -- Tip chosen by the HUMAN at confirm time. Never defaulted, never model-chosen.
  tip_cents         integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  -- sha256 hex of the uppercased confirmation code. NEVER the code itself.
  confirm_code_hash text NOT NULL,
  previewed_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  submitted_at      timestamptz,
  failure_code      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per real DoorDash order. Guards the ambiguity path: a retry that
-- somehow reached submit twice cannot record two orders for one uuid.
CREATE UNIQUE INDEX IF NOT EXISTS doordash_orders_order_uuid_key
  ON doordash_orders (order_uuid) WHERE order_uuid IS NOT NULL;

-- Daily cap reads: count and sum per user over a UTC day, by confirm time.
CREATE INDEX IF NOT EXISTS doordash_orders_user_day_idx
  ON doordash_orders (user_id, confirmed_at);

-- Confirm-code lookup: at most one live previewed row per user at a time.
CREATE INDEX IF NOT EXISTS doordash_orders_user_previewed_idx
  ON doordash_orders (user_id, previewed_at) WHERE status = 'previewed';
