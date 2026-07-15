-- 0032b_activity_result_uniqueness.sql
-- REQUIRED OPERATOR PREFLIGHT. A duplicate result pair may represent duplicate
-- economic settlement, so it must NOT be silently deleted. Reconcile both sets:
--
-- SELECT room_id, avatar_id, count(*) AS result_rows,
--        sum(tokens_awarded) AS recorded_awards
-- FROM activity_results
-- GROUP BY room_id, avatar_id
-- HAVING count(*) > 1;
--
-- SELECT metadata->>'roomId' AS room_id,
--        avatar_id,
--        count(*) AS ledger_rows,
--        sum(amount) AS credited
-- FROM claw_token_transactions
-- WHERE reason = 'activity_match_placed'
-- GROUP BY metadata->>'roomId', avatar_id
-- HAVING count(*) > 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "activity_results"
    GROUP BY "room_id", "avatar_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'activity_results has duplicate (room_id, avatar_id) rows',
      HINT = 'Run the 0032b preflight queries and reconcile both activity_results and activity_match_placed ledger rows before retrying.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "activity_results_room_avatar_unique"
  ON "activity_results" ("room_id", "avatar_id");
