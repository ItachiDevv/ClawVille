-- P3 stage A: render-agnostic decorative kit placements. Additive and safe for
-- rolling deploys; old binaries do not read or write this net-new table.
CREATE TABLE IF NOT EXISTS "land_structure_pieces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parcel_id" uuid NOT NULL,
  "owner_avatar_id" uuid NOT NULL,
  "piece_key" text NOT NULL,
  "grid_x" integer NOT NULL,
  "grid_y" integer NOT NULL,
  "rotation_step" integer NOT NULL,
  "stack_level" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "land_structure_pieces_parcel_fk"
    FOREIGN KEY ("parcel_id") REFERENCES "land_parcels"("id") ON DELETE CASCADE,
  CONSTRAINT "land_structure_pieces_owner_avatar_fk"
    FOREIGN KEY ("owner_avatar_id") REFERENCES "avatars"("id"),
  CONSTRAINT "land_structure_pieces_grid_x_range"
    CHECK ("grid_x" BETWEEN 0 AND 15),
  CONSTRAINT "land_structure_pieces_grid_y_range"
    CHECK ("grid_y" BETWEEN 0 AND 15),
  CONSTRAINT "land_structure_pieces_rotation_step_range"
    CHECK ("rotation_step" BETWEEN 0 AND 7),
  CONSTRAINT "land_structure_pieces_stack_level_range"
    CHECK ("stack_level" BETWEEN 1 AND 3),
  CONSTRAINT "land_structure_pieces_cell_stack_unique"
    UNIQUE ("parcel_id", "grid_x", "grid_y", "stack_level")
);

CREATE INDEX IF NOT EXISTS "land_structure_pieces_parcel_idx"
  ON "land_structure_pieces" ("parcel_id");
