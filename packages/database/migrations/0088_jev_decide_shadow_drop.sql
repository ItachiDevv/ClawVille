-- 0088_jev_decide_shadow_drop.sql: drop the Jev decide SHADOW ledger (founder order 2026-10-23, "yes" to the drop).
--
-- Created by 0081_jev_decide_shadow.sql. Jev was removed from world action choice on 2026-10-20 (founder: Jev never
-- chooses world actions); the writer (services/jev-decide-shadow.ts) and the staging world-decide demo were deleted
-- then (`8a2dd271`). The table was kept read-only until the code flip reached prod.
--
-- Pre-drop state VERIFIED 2026-10-23:
--   prod     3,382 rows, last row 2026-10-22 01:24:58Z (promotion #11 flip); no writer on prod since.
--   staging    184 rows, last row 2026-10-20 05:20:00Z.
--   No view references the table and no FK points into it (staging pg_views / pg_constraint).
--   No code reader or writer: the Drizzle mirror (schema/jev-shadow.ts) is removed in this same diff.
-- Every row from both boxes was ARCHIVED to CSV before this migration was written (local, untracked, under
-- ops/house-traders/archive/).
--
-- Destructive BY DESIGN; the second sanctioned DROP exception (see migrate-ci.ts). Idempotent (IF EXISTS).
-- No CASCADE: an unknown dependency must fail loudly. No explicit transaction (migrate-ci.ts wraps each file).

DROP TABLE IF EXISTS public.jev_decide_shadow;
