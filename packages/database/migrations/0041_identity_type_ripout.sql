-- Identity-type ripout (2026-07-17).
--
-- PRE-APPLY read-only classification on production:
--   nanoclaw: 10 genuine hosted / 31 non-hosted / 41 total
--   anonymous:  0 genuine hosted / 67 non-hosted / 67 total
--   ironclaw:   0 genuine hosted /  0 non-hosted /  0 total
-- Reproduce with packages/database/scripts/identity-type-ripout-analysis.sql.
--
-- Idempotency: both statements select only legacy identity_type values. After a
-- successful run, neither predicate matches any row on a re-run.

-- First preserve genuine hosted-avatar identity. All classification conjuncts
-- are required: same owner, exact platform-agent id, legacy hosted tag, and a
-- ClawVille-hosted avatar harness. Merely being user-bound is not sufficient.
UPDATE openclaw_bots AS b
SET
  identity_type = 'milady',
  updated_at = NOW()
WHERE b.identity_type = 'nanoclaw'
  AND EXISTS (
    SELECT 1
    FROM avatars AS a
    WHERE a.user_id = b.user_id
      AND a.platform_agent_id IS NOT NULL
      AND b.agent_id = a.platform_agent_id::text
      AND a.harness IN ('milady', 'hermes', 'openclaw')
  );

-- Then retain every other legacy row under the supported general-config identity.
-- Rows are re-tagged only; no session, ownership, wallet, or agent row is deleted.
UPDATE openclaw_bots
SET
  identity_type = 'custom',
  updated_at = NOW()
WHERE identity_type IN ('nanoclaw', 'anonymous', 'ironclaw');
