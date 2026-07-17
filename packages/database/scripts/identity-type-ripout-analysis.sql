-- READ ONLY: classify every unsupported identity row before applying migration 0041.
-- This query performs no writes and intentionally emits zero-count rows so the
-- operator can compare all three legacy identities against the reviewed split.
WITH legacy_identity_types(identity_type) AS (
  VALUES ('nanoclaw'), ('anonymous'), ('ironclaw')
), classified AS (
  SELECT
    b.identity_type,
    b.identity_type = 'nanoclaw'
      AND EXISTS (
        SELECT 1
        FROM avatars AS a
        WHERE a.user_id = b.user_id
          AND a.platform_agent_id IS NOT NULL
          AND b.agent_id = a.platform_agent_id::text
          AND a.harness IN ('milady', 'hermes', 'openclaw')
      ) AS is_hosted_avatar
  FROM openclaw_bots AS b
  WHERE b.identity_type IN ('nanoclaw', 'anonymous', 'ironclaw')
)
SELECT
  legacy.identity_type,
  COUNT(classified.identity_type) FILTER (WHERE classified.is_hosted_avatar) AS hosted_avatar_rows,
  COUNT(classified.identity_type) FILTER (WHERE NOT classified.is_hosted_avatar) AS non_hosted_rows,
  COUNT(classified.identity_type) AS total_rows
FROM legacy_identity_types AS legacy
LEFT JOIN classified USING (identity_type)
GROUP BY legacy.identity_type
ORDER BY CASE legacy.identity_type
  WHEN 'nanoclaw' THEN 1
  WHEN 'anonymous' THEN 2
  WHEN 'ironclaw' THEN 3
END;
