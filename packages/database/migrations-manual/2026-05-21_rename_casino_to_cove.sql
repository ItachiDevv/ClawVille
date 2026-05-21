-- 2026-05-21 — Rename building id 'casino' → 'cove' to match the public
-- "Predictive Gaming Cove" branding. Touches every table that stores a
-- building id as a varchar (informal FK — no constraints in the schema).
--
-- Safe to run multiple times; the WHERE id='casino' clause is idempotent
-- once executed (no rows match on re-run).

BEGIN;

-- Reference data
UPDATE map_locations SET id = 'cove' WHERE id = 'casino';

-- Informal FKs (varchar(50), no enforced constraint on the DB side; see
-- the schema files for documentation: each table comments that the column
-- "informally references map_locations.id")
UPDATE location_agents SET location_id = 'cove' WHERE location_id = 'casino';
UPDATE published_skills SET location_id = 'cove' WHERE location_id = 'casino';
UPDATE research_articles SET location_id = 'cove' WHERE location_id = 'casino';
UPDATE activities SET building_id = 'cove' WHERE building_id = 'casino';

-- Event log table — building-visited / chat-turn / activity-match rows
-- carry building_id values that may be 'casino'. Best-effort relabel so
-- leaderboard / dash counts roll into the renamed building.
UPDATE events SET building_id = 'cove' WHERE building_id = 'casino';

COMMIT;
