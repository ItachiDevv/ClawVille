#!/usr/bin/env bash
# Copy the ClawVille app schemas from Supabase into the local clawville-db, then verify.
# Usage: [APP=<container holding the Supabase DATABASE_URL>] bash db-migrate.sh
# Re-runnable: drops and recreates the target database each run. Never prints secrets.
set -euo pipefail
cd /opt/clawville-db
IMG=pgvector/pgvector:pg17
set -a; . ./.env; set +a
# Source URL: from a running app container (APP=...), else from the saved .src file (apps stopped).
if [ -n "${APP:-}" ]; then
  ( umask 077; docker exec "$APP" printenv DATABASE_URL | sed -E 's#(pooler\.supabase\.com):6543/#\1:5432/#' > .src )
fi
[ -s .src ] || { echo "FATAL: no source URL (.src missing and APP unset)"; exit 1; }
SRC=$(cat .src)
case "$SRC" in *pooler.supabase.com:5432/*) ;; *) echo "FATAL: source is not a Supabase session-pooler URL"; exit 1;; esac
DST="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/clawville"
run() { docker run --rm --network host -e SRC="$SRC" -e DST="$DST" -v /opt/clawville-db/backups:/b "$IMG" bash -c "$1"; }
ts() { date -u +%H:%M:%S; }

# Guard: after cutover the database carries clawville.env and is LIVE. Never drop it.
live_env=$(docker exec clawville-db psql -U postgres -d clawville -tAc "select coalesce(current_setting('clawville.env', true), '')" 2>/dev/null || true)
if [ -n "$live_env" ] && [ "${I_KNOW_THIS_DROPS_LIVE_DATA:-}" != "$live_env" ]; then
  echo "FATAL: target database is LIVE (clawville.env=$live_env). Refusing to drop it."; exit 1
fi

echo "[$(ts)] reset target database"
docker exec -i clawville-db psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='clawville' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS clawville;
-- Match Supabase exactly: UTF8, ICU provider, en-US (text ORDER BY + text indexes behave the same).
CREATE DATABASE clawville OWNER clawville TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'en_US.utf8';
SQL
docker exec -i clawville-db psql -U postgres -d clawville -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION clawville;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
ALTER SCHEMA public OWNER TO clawville;
ALTER DATABASE clawville SET search_path TO "$user", public, extensions;
SQL

echo "[$(ts)] pg_dump from Supabase"
run 'pg_dump "$SRC" -Fc -Z 6 --schema=public --schema=migrations --schema=drizzle --no-owner --no-privileges --no-publications --no-subscriptions -f /b/src.dump && ls -la /b/src.dump | awk "{print \$5\" bytes\"}"'

echo "[$(ts)] build restore list (skip extension + schema-public entries; they exist already)"
run 'pg_restore -l /b/src.dump > /b/toc.all && grep -v -E " (EXTENSION - |COMMENT - EXTENSION |SCHEMA - public |COMMENT - SCHEMA public )" /b/toc.all > /b/toc.list; echo "toc entries: $(grep -vc "^;" /b/toc.all) -> $(grep -vc "^;" /b/toc.list)"'

echo "[$(ts)] pg_restore into clawville (role clawville)"
run 'pg_restore -d "$DST" --no-owner --no-privileges --role=clawville -j 2 --exit-on-error -L /b/toc.list /b/src.dump'
docker exec clawville-db psql -U postgres -d clawville -q -c 'ANALYZE'

echo "[$(ts)] verify exact row counts per table"
COUNT_SQL="select string_agg(format('select %L as t, count(*) as n from %I.%I', n.nspname||'.'||c.relname, n.nspname, c.relname), ' union all ' order by 1) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle')"
run 'Q=$(psql "$SRC" -tAc "'"$COUNT_SQL"'"); psql "$SRC" -tA -F" " -c "$Q" | LC_ALL=C sort > /b/count.src; Q2=$(psql "$DST" -tAc "'"$COUNT_SQL"'"); psql "$DST" -tA -F" " -c "$Q2" | LC_ALL=C sort > /b/count.dst; echo "tables src=$(wc -l < /b/count.src) dst=$(wc -l < /b/count.dst)"; if diff /b/count.src /b/count.dst > /b/count.diff; then echo "ROWCOUNTS: IDENTICAL"; else echo "ROWCOUNTS: DIFFER"; head -20 /b/count.diff; fi'

echo "[$(ts)] verify object counts"
OBJ_SQL="select 'tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle') union all select 'indexes', count(*) from pg_indexes where schemaname in ('public','migrations','drizzle') union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','migrations','drizzle') union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','migrations','drizzle') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','migrations','drizzle') and not t.tgisinternal union all select 'sequences', count(*) from pg_sequences where schemaname in ('public','migrations','drizzle') union all select 'enums', count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'"
run 'psql "$SRC" -tA -F" " -c "'"$OBJ_SQL"'" > /b/obj.src; psql "$DST" -tA -F" " -c "'"$OBJ_SQL"'" > /b/obj.dst; paste /b/obj.src /b/obj.dst'
SEQ_SQL="select schemaname||'.'||sequencename, coalesce(last_value,0) from pg_sequences where schemaname in ('public','migrations','drizzle') order by 1"
run 'psql "$SRC" -tA -F" " -c "'"$SEQ_SQL"'" | LC_ALL=C sort > /b/seq.src; psql "$DST" -tA -F" " -c "'"$SEQ_SQL"'" | LC_ALL=C sort > /b/seq.dst; if diff -q /b/seq.src /b/seq.dst >/dev/null; then echo "SEQUENCES: IDENTICAL ($(wc -l < /b/seq.src))"; else echo "SEQUENCES: DIFFER"; diff /b/seq.src /b/seq.dst | head; fi'
echo "[$(ts)] done"
