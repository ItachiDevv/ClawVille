# shellcheck shell=bash disable=SC2034
# (SC2034: MARKER and MARKER_ERR are read by the scripts that source this file.)
# Sourced by db-migrate.sh, db-cutover.sh and db-backup.sh; not run on its own.
# The clawville.env environment marker, read like apps/api/scripts/db-env-marker.ts (keep the two in sync):
# the database-level value from the catalog (pg_db_role_setting, setrole = 0), with every catalog name
# schema-qualified so a search_path cannot shadow it, plus the session value current_setting() sees.
# More than one database marker, or a session value that differs from it (a role setting, PGOPTIONS or
# a connection option), is refused. '' counts as no marker.
DB_MARKER_SQL="select pg_catalog.cardinality(m.database_markers), m.database_markers[1], m.session_marker from (
select
  (select pg_catalog.array_agg(u.v)
     from pg_catalog.pg_db_role_setting s
     cross join lateral pg_catalog.unnest(s.setconfig) as u(v)
    where s.setdatabase = (select d.oid from pg_catalog.pg_database d
                            where d.datname = pg_catalog.current_database())
      and s.setrole = 0
      and pg_catalog.starts_with(u.v, 'clawville.env=')) as database_markers,
  pg_catalog.current_setting('clawville.env', true) as session_marker) m"

# read_marker <container>: queries database clawville in that container. On success sets MARKER (empty =
# no marker). On any failed query, unexpected answer, or refused state it sets MARKER_ERR and returns 1.
read_marker() {
  local out n first sess db
  MARKER=""; MARKER_ERR=""
  out=$(docker exec "$1" psql -U postgres -d clawville -v ON_ERROR_STOP=1 -tA -F $'\037' -c "$DB_MARKER_SQL") \
    || { MARKER_ERR="the marker query failed"; return 1; }
  # Exactly one line with exactly three fields.
  case "$out" in
    *$'\n'*|*$'\037'*$'\037'*$'\037'*) MARKER_ERR="unexpected marker answer"; return 1;;
    *$'\037'*$'\037'*) ;;
    *) MARKER_ERR="unexpected marker answer"; return 1;;
  esac
  IFS=$'\037' read -r n first sess <<<"$out"
  case "${n:-0}" in
    0) db="";;
    1) case "$first" in clawville.env=*) db=${first#clawville.env=};; *) MARKER_ERR="unexpected marker answer"; return 1;; esac;;
    [2-9]|[1-9][0-9]*) MARKER_ERR="more than one clawville.env marker on the database"; return 1;;
    *) MARKER_ERR="unexpected marker answer"; return 1;;
  esac
  [ "$sess" = "$db" ] || { MARKER_ERR="the session clawville.env differs from the database-level marker (role setting or connection option)"; return 1; }
  MARKER=$db
}
