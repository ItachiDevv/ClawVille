#!/usr/bin/env bash
# Copy the ClawVille app schemas from Supabase into the local clawville-db, then verify.
# Usage: [APP=<container holding the Supabase DATABASE_URL>] [REQUIRE_QUIESCENT=1] bash db-migrate.sh
# Re-runnable: drops and recreates the target database each run. Never prints secrets.
# REQUIRE_QUIESCENT=1 (set by db-cutover.sh): fail unless no write reached the source during the copy.
# SOURCE_RECHECK=1 (db-cutover.sh, after the switch): only compare the source fingerprint with W2.
set -euo pipefail
umask 077
. "$(cd "$(dirname "$0")" && pwd)/db-marker.sh"
cd /opt/clawville-db
# One lock for db-cutover.sh, db-migrate.sh and db-backup.sh. Under db-cutover.sh, fd 9 is its lock
# (same open file description), so flock succeeds at once; any other concurrent run fails fast.
LOCK=/opt/clawville-db/.lock
[ "$(readlink "/proc/$$/fd/9" 2>/dev/null)" = "$LOCK" ] || exec 9>>"$LOCK"
flock -n 9 || { echo "FATAL: another db script holds $LOCK"; exit 1; }
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
# The URLs carry passwords: they reach the tool container by variable NAME only (-e SRC -e DST).
export SRC DST
# Tool-container prelude. pgurl splits a URL into a password-less URI (SRC_URI, DST_URI) and its
# percent-decoded password (SRC_PW, DST_PW); the password travels only in PGPASSWORD, never argv.
# Backslashes are doubled before the %XX -> \xXX rewrite so printf %b keeps them literal.
PRE='umask 077
pgurl() {
  local u=${!1} a pw
  case $u in *://*@*) ;; *) echo "FATAL: $1 is not a user@host URL" >&2; return 1;; esac
  a=${u#*://}; a=${a%%@*}
  case $a in *:*) pw=${a#*:};; *) pw=;; esac
  pw=${pw//\\/\\\\}
  printf -v "$1_URI" %s "${u%%://*}://${a%%:*}@${u#*@}"
  printf -v "$1_PW" %b "${pw//%/\\x}"
}
pgurl SRC; pgurl DST
sq() { PGPASSWORD="$SRC_PW" psql "$SRC_URI" -v ON_ERROR_STOP=1 "$@"; }
dq() { PGPASSWORD="$DST_PW" psql "$DST_URI" -v ON_ERROR_STOP=1 "$@"; }
'
# Strict mode inside the container too: a failed query stops the run, never compares empty files.
run() { docker run --rm --network host -e SRC -e DST -v /opt/clawville-db/backups:/b "$IMG" bash -euo pipefail -c "$PRE$1"; }
ts() { date -u +%H:%M:%S; }

# Source write fingerprint, one sorted "component key value" line each (schema-qualified catalog reads;
# string_agg only over catalog rows, never over table data):
#   dml - N              inserts+updates+deletes the source counted on the copied schemas
#   relfilenode T N      per table (TRUNCATE and table rewrites change it)
#   sequence S V         last_value per sequence (null = never called)
#   catalog - MD5        DEFINITIONS in the three schemas: relations (oid, name, kind, relfilenode, row security
#                        on/forced), columns (name, type/typmod, not null, identity/generated, default), index,
#                        constraint, trigger (+ enabled state) and function definitions (non-extension; aggregates
#                        by identity), row-security policies, enum labels, views. ACLs are not copied, so not hashed.
FP_SQL="select 'dml', '-', coalesce(pg_catalog.sum(s.n_tup_ins + s.n_tup_upd + s.n_tup_del), 0)::text
  from pg_catalog.pg_stat_user_tables s where s.schemaname in ('public','migrations','drizzle')
union all
select 'relfilenode', n.nspname::text || '.' || c.relname::text, c.relfilenode::text
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle')
union all
select 'sequence', q.schemaname::text || '.' || q.sequencename::text, coalesce(q.last_value::text, 'null')
  from pg_catalog.pg_sequences q where q.schemaname in ('public','migrations','drizzle')
union all
select 'catalog', '-', pg_catalog.md5(pg_catalog.string_agg(f.x, ';' order by f.x)) from (
  select 'rel:' || c.oid::text || ':' || c.relname::text || ':' || c.relkind::text || ':' || c.relfilenode::text || ':'
         || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text as x
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public','migrations','drizzle')
  union all
  select 'col:' || a.attrelid::text || ':' || a.attnum::text || ':' || a.attname::text || ':'
         || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
         || a.attidentity::text || a.attgenerated::text || ':' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname in ('public','migrations','drizzle') and a.attnum > 0 and not a.attisdropped
  union all
  select 'idx:' || pg_catalog.pg_get_indexdef(i.indexrelid) from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public','migrations','drizzle')
  union all
  select 'con:' || k.conrelid::text || ':' || k.conname::text || ':' || pg_catalog.pg_get_constraintdef(k.oid)
    from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
   where n.nspname in ('public','migrations','drizzle')
  union all
  select 'trg:' || pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public','migrations','drizzle') and not t.tgisinternal
  union all
  select 'pol:' || p.polrelid::text || ':' || p.polname::text || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':'
         || coalesce((select pg_catalog.string_agg(coalesce(r.rolname::text, 'public'), ',' order by coalesce(r.rolname::text, 'public'))
                        from pg_catalog.unnest(p.polroles) as u(oid) left join pg_catalog.pg_roles r on r.oid = u.oid), '') || ':'
         || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ':'
         || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
    from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','migrations','drizzle')
  union all
  select 'fn:' || case when p.prokind = 'a' then p.oid::text || ':' || p.proname::text
                       else pg_catalog.pg_get_functiondef(p.oid) end
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','migrations','drizzle')
     and not exists (select 1 from pg_catalog.pg_depend e where e.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                                                           and e.objid = p.oid and e.deptype = 'e')
  union all
  select 'enum:' || e.enumtypid::text || ':' || e.enumsortorder::text || ':' || e.enumlabel::text
    from pg_catalog.pg_enum e join pg_catalog.pg_type t on t.oid = e.enumtypid
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace where n.nspname in ('public','migrations','drizzle')
  union all
  select 'view:' || c.oid::text || ':' || pg_catalog.pg_get_viewdef(c.oid) from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('v','m') and n.nspname in ('public','migrations','drizzle')) f"
# fp <name>: write the source fingerprint to backups/<name>.
fp() { run 'sq -tA -F" " -c "'"$FP_SQL"'" | LC_ALL=C sort > /b/'"$1"; }
# fp_changes <old> <new>: the components that differ, e.g. "dml +3; relfilenode public.t; catalog".
fp_changes() {
  local d1 d2
  d1=$(awk '$1 == "dml" {print $3}' "$1"); d2=$(awk '$1 == "dml" {print $3}' "$2")
  [[ "$d1" =~ ^[0-9]+$ && "$d2" =~ ^[0-9]+$ ]] || { d1=0; d2=0; }
  diff "$1" "$2" | sed -n 's/^[<>] //p' \
    | awk -v d="$((d2 - d1))" '{ if ($1 == "dml") print "dml " (d >= 0 ? "+" d : d); else if ($2 == "-") print $1; else print $1 " " $2 }' \
    | LC_ALL=C sort -u | paste -sd ';' - | sed 's/;/; /g'
}

# After the switch (db-cutover.sh): fingerprint the source once more (W3) and compare it with W2.
# This mode only reads the source: no guard, no drop, no copy.
if [ "${SOURCE_RECHECK:-}" = 1 ]; then
  echo "[$(ts)] settle 15 s, then re-read the source fingerprint (W3)"
  sleep 15
  fp w3
  if diff -q backups/w2 backups/w3 >/dev/null; then echo "SOURCE AFTER SWITCH: UNCHANGED"; exit 0; fi
  echo "SOURCE AFTER SWITCH: CHANGED ($(fp_changes backups/w2 backups/w3))"
  exit 1
fi

# Guard: after cutover the database carries clawville.env and is LIVE. Never drop it.
# Fail closed: a failed query, or an answer that is not exactly the expected shape, stops here, before the DROP.
# The marker is read by db-marker.sh (catalog, database level; a differing session value is refused).
has_db=$(docker exec clawville-db psql -U postgres -v ON_ERROR_STOP=1 -tAc "select 1 from pg_catalog.pg_database where datname = 'clawville'") \
  || { echo "FATAL: cannot query clawville-db — refusing to continue"; exit 1; }
case "$has_db" in
  "") ;;
  1)
    read_marker clawville-db || { echo "FATAL: $MARKER_ERR — refusing to drop the database"; exit 1; }
    live_env=$MARKER
    if [ -n "$live_env" ] && [ "${I_KNOW_THIS_DROPS_LIVE_DATA:-}" != "$live_env" ]; then
      echo "FATAL: target database is LIVE (clawville.env=$live_env). Refusing to drop it."; exit 1
    fi;;
  *) echo "FATAL: unexpected pg_database answer — refusing to continue"; exit 1;;
esac

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

# Writer quiescence: the source fingerprint (FP_SQL) before the dump (W1) and after verification (W2);
# any difference means a write reached the source during the copy.
if [ "${REQUIRE_QUIESCENT:-}" = 1 ]; then
  # PG15+ flushes an idle backend's pending stats within ~10 s; the apps stopped just before this run.
  echo "[$(ts)] settle 15 s so stopped writers' statistics reach the source"
  sleep 15
fi
fp w1

echo "[$(ts)] pg_dump from Supabase"
run 'PGPASSWORD="$SRC_PW" pg_dump "$SRC_URI" -Fc -Z 6 --schema=public --schema=migrations --schema=drizzle --no-owner --no-privileges --no-publications --no-subscriptions -f /b/src.dump && ls -la /b/src.dump | awk "{print \$5\" bytes\"}"'

echo "[$(ts)] build restore list (skip extension + schema-public entries; they exist already)"
run 'pg_restore -l /b/src.dump > /b/toc.all && grep -v -E " (EXTENSION - |COMMENT - EXTENSION |SCHEMA - public |COMMENT - SCHEMA public )" /b/toc.all > /b/toc.list; echo "toc entries: $(grep -vc "^;" /b/toc.all) -> $(grep -vc "^;" /b/toc.list)"'

echo "[$(ts)] pg_restore into clawville (role clawville)"
run 'PGPASSWORD="$DST_PW" pg_restore -d "$DST_URI" --no-owner --no-privileges --role=clawville -j 2 --exit-on-error -L /b/toc.list /b/src.dump'
docker exec clawville-db psql -U postgres -d clawville -v ON_ERROR_STOP=1 -q -c 'ANALYZE'

echo "[$(ts)] verify row counts + row hashes per table"
# One streaming scan per table: count(*) and an order-independent sum of 60-bit md5 prefixes of the
# row text. O(1) memory; never string_agg over rows (that restarted a small Supabase server).
# Both sides use the same session settings, so the row text matches.
HASH_SET="SET timezone='UTC'; SET extra_float_digits=1; SET datestyle='ISO, MDY'; SET intervalstyle='postgres'; SET bytea_output='hex'; SET statement_timeout=0;"
HASH_GEN="select format('select %L, count(*), coalesce(sum((''x''||substr(md5(cv_row_::text),1,15))::bit(60)::bigint),0) from %I.%I cv_row_;', n.nspname||'.'||c.relname, n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle') order by 1"
run '{ echo "'"$HASH_SET"'"; sq -tAc "'"$HASH_GEN"'"; } | sq -q -tA -F" " -f - | LC_ALL=C sort > /b/count.src; { echo "'"$HASH_SET"'"; dq -tAc "'"$HASH_GEN"'"; } | dq -q -tA -F" " -f - | LC_ALL=C sort > /b/count.dst; ns=$(wc -l < /b/count.src); nd=$(wc -l < /b/count.dst); echo "tables src=$ns dst=$nd"; if [ "$ns" -eq 0 ] || [ "$nd" -eq 0 ]; then echo "FATAL: row-count step saw 0 tables (src=$ns dst=$nd)"; exit 1; fi; if diff /b/count.src /b/count.dst > /b/count.diff; then echo "ROWCOUNTS: IDENTICAL (count+hash)"; else echo "ROWCOUNTS: DIFFER (count+hash)"; head -20 /b/count.diff; fi'

echo "[$(ts)] verify object counts"
OBJ_SQL="select 'tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle') union all select 'indexes', count(*) from pg_indexes where schemaname in ('public','migrations','drizzle') union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','migrations','drizzle') union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','migrations','drizzle') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','migrations','drizzle') and not t.tgisinternal union all select 'sequences', count(*) from pg_sequences where schemaname in ('public','migrations','drizzle') union all select 'enums', count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'"
run 'sq -tA -F" " -c "'"$OBJ_SQL"'" > /b/obj.src; dq -tA -F" " -c "'"$OBJ_SQL"'" > /b/obj.dst; paste /b/obj.src /b/obj.dst; if diff /b/obj.src /b/obj.dst > /b/obj.diff; then echo "OBJECTS: IDENTICAL"; else echo "OBJECTS: DIFFER"; cat /b/obj.diff; fi'
SEQ_SQL="select schemaname||'.'||sequencename, coalesce(last_value,0) from pg_sequences where schemaname in ('public','migrations','drizzle') order by 1"
run 'sq -tA -F" " -c "'"$SEQ_SQL"'" | LC_ALL=C sort > /b/seq.src; dq -tA -F" " -c "'"$SEQ_SQL"'" | LC_ALL=C sort > /b/seq.dst; if diff /b/seq.src /b/seq.dst > /b/seq.diff; then echo "SEQUENCES: IDENTICAL ($(wc -l < /b/seq.src))"; else echo "SEQUENCES: DIFFER"; head /b/seq.diff; fi'

echo "[$(ts)] verify writer quiescence on the source"
if [ "${REQUIRE_QUIESCENT:-}" = 1 ]; then
  # Settle again, so a write that landed late in the copy is flushed and counted in W2.
  echo "[$(ts)] settle 15 s before the final fingerprint read"
  sleep 15
fi
fp w2
if diff -q backups/w1 backups/w2 >/dev/null; then
  echo "QUIESCENT: YES (source fingerprint unchanged, $(wc -l < backups/w1) components)"
else
  echo "QUIESCENT: NO ($(fp_changes backups/w1 backups/w2))"
  [ "${REQUIRE_QUIESCENT:-}" != 1 ] || { echo "FATAL: writes reached the source during the copy"; exit 1; }
fi
echo "[$(ts)] done"
