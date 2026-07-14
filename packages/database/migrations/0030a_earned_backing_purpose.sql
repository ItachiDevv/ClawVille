-- 0030a_earned_backing_purpose.sql
-- MUST remain the only statement in this file. migrate-ci runs each file in an
-- implicit transaction; PostgreSQL must COMMIT the enum value before 0030b may
-- reference it in a partial index or insert.
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'earned-backing';
