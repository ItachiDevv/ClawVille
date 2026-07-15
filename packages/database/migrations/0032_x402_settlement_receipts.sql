-- Global x402 settlement-signature ownership. A signature may fund exactly one
-- economic rail across top-ups, generic checkouts, and agent payments.
-- PRE-PROMOTION: run the collision query from the reconciler report (UNION ALL
-- tx_signature from ct_topups, x402_checkouts, and agent_payments; GROUP BY
-- tx_signature HAVING count(*) > 1) and resolve every returned owner set. The
-- deterministic backfill below can select one future owner but cannot reverse
-- any historical double economic effect.
CREATE TABLE IF NOT EXISTS x402_settlement_receipts (
  tx_signature text PRIMARY KEY,
  rail text NOT NULL,
  kind text NOT NULL,
  reference_id text NOT NULL,
  subject_id uuid NOT NULL,
  amount_usdc_atomic bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT x402_settlement_receipts_amount_positive CHECK (amount_usdc_atomic > 0)
);

CREATE INDEX IF NOT EXISTS x402_settlement_receipts_reference_idx
  ON x402_settlement_receipts (rail, reference_id);

DO $$
DECLARE duplicate_count bigint;
BEGIN
  SELECT count(*) INTO duplicate_count FROM (
    SELECT tx_signature
    FROM (
      SELECT tx_signature FROM ct_topups WHERE tx_signature IS NOT NULL
      UNION ALL
      SELECT tx_signature FROM x402_checkouts WHERE tx_signature IS NOT NULL
      UNION ALL
      SELECT tx_signature FROM agent_payments WHERE tx_signature IS NOT NULL
    ) all_signatures
    GROUP BY tx_signature
    HAVING count(*) > 1
  ) duplicate_signatures;
  IF duplicate_count > 0 THEN
    RAISE WARNING '% pre-existing cross-rail x402 signature collision(s) detected; completed-effect ranking contains future reuse but cannot undo historical effects', duplicate_count;
  END IF;
END $$;

-- Backfill legacy ownership before new writers begin consulting the registry.
-- If historical corruption placed one signature on multiple rails, a completed
-- economic effect owns it ahead of a merely captured/nonterminal row. Remaining
-- ties are deterministic; operators can audit duplicates with the candidates
-- CTE/query from this migration before promotion.
WITH candidates AS (
  SELECT tx_signature, 'ct_topup'::text AS rail, 'topup'::text AS kind,
         id::text AS reference_id, avatar_id AS subject_id,
         (amount_ct::bigint * 10000) AS amount_usdc_atomic, created_at,
         CASE WHEN status = 'settled' THEN 0 ELSE 1 END AS effect_priority
  FROM ct_topups WHERE tx_signature IS NOT NULL
  UNION ALL
  SELECT tx_signature, 'x402_checkout', item_kind::text, id::text, avatar_id,
         (usd_cents::bigint * 10000), created_at,
         CASE WHEN status = 'settled' THEN 0 ELSE 1 END
  FROM x402_checkouts WHERE tx_signature IS NOT NULL
  UNION ALL
  SELECT tx_signature, 'agent_payment', 'agent_payment', id::text, recipient_avatar_id,
         usdc_atomic::bigint, created_at,
         CASE WHEN status = 'settled' THEN 0 ELSE 1 END
  FROM agent_payments WHERE tx_signature IS NOT NULL
), winners AS (
  SELECT DISTINCT ON (tx_signature)
    tx_signature, rail, kind, reference_id, subject_id, amount_usdc_atomic, created_at
  FROM candidates
  ORDER BY tx_signature, effect_priority, created_at, rail, reference_id
)
INSERT INTO x402_settlement_receipts
  (tx_signature, rail, kind, reference_id, subject_id, amount_usdc_atomic, created_at)
SELECT tx_signature, rail, kind, reference_id, subject_id, amount_usdc_atomic, created_at
FROM winners
ON CONFLICT (tx_signature) DO NOTHING;
