-- Land P2 instrument A: DELETE-ONLY absorption of the exact 18-row a/b ghost
-- manifest. The no-ghost re-run path is a true no-op. When ghosts exist, any
-- deviation or final-manifest mismatch raises inside this transaction, so every
-- write rolls back and the pre-migration database remains byte-identical.

SELECT pg_advisory_xact_lock(510020260801);

CREATE TEMP TABLE land_p2_ghost_manifest (
  parcel_code text PRIMARY KEY,
  tier text NOT NULL,
  grid_x integer NOT NULL,
  grid_y integer NOT NULL,
  price_ct integer NOT NULL,
  rent_ct_weekly integer NOT NULL
) ON COMMIT DROP;

INSERT INTO land_p2_ghost_manifest VALUES
  ('parcel-b-00','b',128,128,24000,550),
  ('parcel-b-01','b',277,128,22727,523),
  ('parcel-b-02','b',426,128,21455,495),
  ('parcel-b-03','b',576,128,20182,468),
  ('parcel-b-04','b',576,277,18909,441),
  ('parcel-b-05','b',576,426,17636,414),
  ('parcel-b-06','b',576,576,16364,386),
  ('parcel-b-07','b',426,576,15091,359),
  ('parcel-b-08','b',277,576,13818,332),
  ('parcel-b-09','b',128,576,12545,305),
  ('parcel-b-10','b',128,426,11273,277),
  ('parcel-b-11','b',128,277,10000,250),
  ('parcel-a-00','a',152,152,80000,2400),
  ('parcel-a-01','a',418,152,72000,2120),
  ('parcel-a-02','a',552,285,64000,1840),
  ('parcel-a-03','a',552,552,56000,1560),
  ('parcel-a-04','a',285,552,48000,1280),
  ('parcel-a-05','a',152,418,40000,1000);

CREATE TEMP TABLE land_p2_render_manifest (
  parcel_code text PRIMARY KEY,
  tier text NOT NULL,
  grid_x integer NOT NULL,
  grid_y integer NOT NULL
) ON COMMIT DROP;

INSERT INTO land_p2_render_manifest VALUES
  ('parcel-founder-00','founder',162,162),('parcel-founder-01','founder',314,162),
  ('parcel-founder-02','founder',466,162),('parcel-founder-03','founder',542,238),
  ('parcel-founder-04','founder',542,390),('parcel-founder-05','founder',542,542),
  ('parcel-founder-06','founder',390,542),('parcel-founder-07','founder',238,542),
  ('parcel-founder-08','founder',162,466),('parcel-founder-09','founder',162,314),
  ('parcel-c-00','c',47,47),('parcel-c-01','c',169,47),
  ('parcel-c-02','c',291,47),('parcel-c-03','c',413,47),
  ('parcel-c-04','c',535,47),('parcel-c-05','c',657,47),
  ('parcel-c-06','c',657,169),('parcel-c-07','c',657,291),
  ('parcel-c-08','c',657,413),('parcel-c-09','c',657,535),
  ('parcel-c-10','c',657,657),('parcel-c-11','c',535,657),
  ('parcel-c-12','c',413,657),('parcel-c-13','c',291,657),
  ('parcel-c-14','c',169,657),('parcel-c-15','c',47,657),
  ('parcel-c-16','c',47,535),('parcel-c-17','c',47,413),
  ('parcel-c-18','c',47,291),('parcel-c-19','c',47,169),
  ('parcel-starter-00','starter',94,94),('parcel-starter-01','starter',173,94),
  ('parcel-starter-02','starter',252,94),('parcel-starter-03','starter',332,94),
  ('parcel-starter-04','starter',411,94),('parcel-starter-05','starter',490,94),
  ('parcel-starter-06','starter',570,94),('parcel-starter-07','starter',610,133),
  ('parcel-starter-08','starter',610,213),('parcel-starter-09','starter',610,292),
  ('parcel-starter-10','starter',610,371),('parcel-starter-11','starter',610,451),
  ('parcel-starter-12','starter',610,530),('parcel-starter-13','starter',610,610),
  ('parcel-starter-14','starter',530,610),('parcel-starter-15','starter',451,610),
  ('parcel-starter-16','starter',371,610),('parcel-starter-17','starter',292,610),
  ('parcel-starter-18','starter',213,610),('parcel-starter-19','starter',133,610),
  ('parcel-starter-20','starter',94,570),('parcel-starter-21','starter',94,490),
  ('parcel-starter-22','starter',94,411),('parcel-starter-23','starter',94,332),
  ('parcel-starter-24','starter',94,252),('parcel-starter-25','starter',94,173);

DO $$
DECLARE
  ghost_count integer;
  deleted_count integer;
BEGIN
  -- Deterministic row locks, followed by a complete reclassification under lock.
  PERFORM id
  FROM land_parcels
  WHERE parcel_code ~ '^parcel-(a|b)-'
  ORDER BY parcel_code
  FOR UPDATE;

  SELECT count(*) INTO ghost_count
  FROM land_parcels
  WHERE parcel_code ~ '^parcel-(a|b)-';

  IF ghost_count > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM land_parcels p
      LEFT JOIN land_p2_ghost_manifest m ON m.parcel_code = p.parcel_code
      WHERE p.parcel_code ~ '^parcel-(a|b)-'
        AND (
          m.parcel_code IS NULL OR p.tier::text <> m.tier
          OR p.grid_x <> m.grid_x OR p.grid_y <> m.grid_y
          OR p.price_ct IS DISTINCT FROM m.price_ct
          OR p.rent_ct_weekly IS DISTINCT FROM m.rent_ct_weekly
        )
    ) THEN
      RAISE EXCEPTION 'land P2 absorb refused: extra or mutated a/b parcel';
    END IF;

    IF EXISTS (
      SELECT 1 FROM land_p2_ghost_manifest m
      LEFT JOIN land_parcels p ON p.parcel_code = m.parcel_code
      WHERE p.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM land_transactions t
          WHERE t.kind::text = 'parcel_relocation'
            AND COALESCE(
              t.metadata->>'sourceParcelCode',
              t.metadata->>'oldParcelCode',
              t.metadata->>'parcelCode'
            ) = m.parcel_code
        )
    ) THEN
      RAISE EXCEPTION 'land P2 absorb refused: unexplained manifest absence';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM land_parcels p
      WHERE p.parcel_code ~ '^parcel-(a|b)-'
        AND (
          p.status::text <> 'available'
          OR p.owner_avatar_id IS NOT NULL OR p.acquired_at IS NOT NULL
          OR p.tenure IS NOT NULL OR p.tenure_terms_version IS NOT NULL
          OR p.rent_paid_through IS NOT NULL OR p.grace_until IS NOT NULL
          OR p.deposit_ct IS NOT NULL OR p.deposit_remaining_ct IS NOT NULL
          OR p.hold_threshold_ct IS NOT NULL OR p.hold_subject IS NOT NULL
          OR p.grandfathered IS DISTINCT FROM false
          OR p.nft_mint_address IS NOT NULL OR p.nft_owner_pubkey IS NOT NULL
          OR p.nft_minted_at IS NOT NULL OR p.last_tax_paid_at IS NOT NULL
          OR p.upkeep_due_at IS NOT NULL OR p.rake_bps <> 0
          OR EXISTS (SELECT 1 FROM land_structures s WHERE s.parcel_id = p.id)
          OR EXISTS (SELECT 1 FROM land_structure_pieces sp WHERE sp.parcel_id = p.id)
          OR EXISTS (SELECT 1 FROM market_deed_locks d WHERE d.parcel_id = p.id)
          OR EXISTS (SELECT 1 FROM land_transactions t WHERE t.parcel_id = p.id)
          OR EXISTS (SELECT 1 FROM partner_storefronts s WHERE s.parcel_id = p.id)
          OR EXISTS (SELECT 1 FROM avatars a WHERE a.home_parcel_id = p.id)
          OR EXISTS (
            SELECT 1 FROM market_listings l
            WHERE l.item_kind::text = 'land_deed' AND l.item_ref = p.id::text
          )
          OR EXISTS (
            SELECT 1 FROM x402_checkouts x
            WHERE x.item_kind::text = 'rent_payment' AND x.item_ref = p.id::text
          )
        )
    ) THEN
      RAISE EXCEPTION 'land P2 absorb refused: non-clean row or inbound reference';
    END IF;

    DELETE FROM land_parcels p
    USING land_p2_ghost_manifest m
    WHERE p.parcel_code = m.parcel_code;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    IF deleted_count <> ghost_count THEN
      RAISE EXCEPTION 'land P2 absorb refused: delete count % differs from classified %', deleted_count, ghost_count;
    END IF;

    -- These assertions are deliberately absorb-path-only. A no-ghost database
    -- is category (b): already migrated or seeded after P2, so it stays untouched.
    IF (SELECT count(*) FROM land_parcels) <> 56 THEN
      RAISE EXCEPTION 'land P2 absorb refused: final parcel count is not 56';
    END IF;
    IF EXISTS (
      SELECT 1 FROM land_parcels p
      FULL JOIN land_p2_render_manifest r ON r.parcel_code = p.parcel_code
      WHERE p.id IS NULL OR r.parcel_code IS NULL
        OR p.tier::text <> r.tier OR p.grid_x <> r.grid_x OR p.grid_y <> r.grid_y
    ) THEN
      RAISE EXCEPTION 'land P2 absorb refused: final rendered manifest mismatch';
    END IF;
    IF (SELECT array_agg(DISTINCT tier::text ORDER BY tier::text) FROM land_parcels)
       <> ARRAY['c','founder','starter']::text[] THEN
      RAISE EXCEPTION 'land P2 absorb refused: final tier set mismatch';
    END IF;
  END IF;
END $$;
