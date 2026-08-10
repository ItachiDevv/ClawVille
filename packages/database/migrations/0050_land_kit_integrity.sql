-- P3 stage-A fix round: durable kit idempotency and avatar lifecycle parity.
-- Replacing the FK is retry-safe; the expression index is additive/idempotent.
ALTER TABLE "land_structure_pieces"
  DROP CONSTRAINT IF EXISTS "land_structure_pieces_owner_avatar_fk";

ALTER TABLE "land_structure_pieces"
  ADD CONSTRAINT "land_structure_pieces_owner_avatar_fk"
  FOREIGN KEY ("owner_avatar_id") REFERENCES "avatars"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "land_tx_kit_piece_idem_unique"
  ON "land_transactions" ((metadata->>'idempotencyKey'))
  WHERE kind = 'structure_placement'
    AND metadata->>'operation' = 'kit_piece_placement';
