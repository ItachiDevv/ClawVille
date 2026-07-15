-- Wager capture-before-send durability (M8, 2026-07-15).
-- Additive/idempotent only; CI applies this migration before deploy.

ALTER TABLE lobbies
  ADD COLUMN IF NOT EXISTS on_chain_create_status text NOT NULL DEFAULT 'confirmed';

-- Operator preflight before applying (must return zero rows; duplicates require
-- money-aware chain reconciliation, never automatic deletion):
-- SELECT activity_id, room_id, COUNT(*) AS n,
--        array_agg(id ORDER BY created_at) AS lobby_ids
-- FROM lobbies
-- WHERE mode = 'multiplayer' AND state IN ('open', 'locked')
-- GROUP BY activity_id, room_id
-- HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lobbies_active_multiplayer_room_uniq
  ON lobbies(activity_id, room_id)
  WHERE mode = 'multiplayer' AND state IN ('open','locked');

DO $$
BEGIN
  ALTER TABLE lobbies
    ADD CONSTRAINT lobbies_on_chain_create_status_valid
    CHECK (on_chain_create_status IN ('prepared','sending','confirmed','reconcile','failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS wager_chain_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key varchar(200) NOT NULL,
  operation text NOT NULL,
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE RESTRICT,
  actor_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'prepared',
  target_pda text NOT NULL,
  tx_signature text,
  blockhash text,
  last_valid_block_height bigint,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wager_chain_intents_operation_valid
    CHECK (operation IN ('create','join')),
  CONSTRAINT wager_chain_intents_status_valid
    CHECK (status IN ('prepared','sending','confirmed','reconcile','failed')),
  CONSTRAINT wager_chain_intents_capture_state_valid
    CHECK (
      (
        status IN ('prepared','failed')
        AND tx_signature IS NULL
        AND blockhash IS NULL
        AND last_valid_block_height IS NULL
      ) OR (
        status IN ('sending','confirmed','reconcile')
        AND tx_signature IS NOT NULL
        AND blockhash IS NOT NULL
        AND last_valid_block_height IS NOT NULL
      )
    )
);

-- Partial-attempt preflight: SELECT to_regclass('public.wager_chain_intents');
-- If this returns a table from an earlier failed/manual attempt, compare every
-- column + constraint below before rerunning: IF NOT EXISTS cannot repair drift.

DO $$
BEGIN
  ALTER TABLE wager_chain_intents
    ADD CONSTRAINT wager_chain_intents_operation_valid
    CHECK (operation IN ('create','join'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE wager_chain_intents
    ADD CONSTRAINT wager_chain_intents_status_valid
    CHECK (status IN ('prepared','sending','confirmed','reconcile','failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE wager_chain_intents
    ADD CONSTRAINT wager_chain_intents_capture_state_valid
    CHECK (
      (
        status IN ('prepared','failed')
        AND tx_signature IS NULL
        AND blockhash IS NULL
        AND last_valid_block_height IS NULL
      ) OR (
        status IN ('sending','confirmed','reconcile')
        AND tx_signature IS NOT NULL
        AND blockhash IS NOT NULL
        AND last_valid_block_height IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wager_chain_intents_operation_key_uniq
  ON wager_chain_intents(operation_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wager_chain_intents_tx_signature_uniq
  ON wager_chain_intents(tx_signature)
  WHERE tx_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wager_chain_intents_status_updated
  ON wager_chain_intents(status, updated_at);
