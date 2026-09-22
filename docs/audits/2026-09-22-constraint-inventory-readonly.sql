BEGIN READ ONLY;
SELECT 'constraint' AS kind, n.nspname AS schema_name, t.relname AS table_name,
       c.conname AS artifact_name, c.contype::text AS artifact_type,
       pg_get_constraintdef(c.oid, true) AS definition,
       c.convalidated AS validated
FROM pg_constraint c
JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND c.contype IN ('c','f','u','p','x')
UNION ALL
SELECT 'index', n.nspname, t.relname, ix.relname,
       CASE WHEN i.indisunique THEN 'unique_index' ELSE 'partial_index' END,
       pg_get_indexdef(i.indexrelid), i.indisvalid
FROM pg_index i
JOIN pg_class t ON t.oid=i.indrelid
JOIN pg_class ix ON ix.oid=i.indexrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND (i.indisunique OR i.indpred IS NOT NULL)
ORDER BY 1,2,3,4;
ROLLBACK;
