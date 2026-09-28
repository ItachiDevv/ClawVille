#!/usr/bin/env bash
# Nightly logical backup of the self-hosted ClawVille DB. Installed by cron on each box:
#   /etc/cron.d/clawville-db-backup:  17 4 * * * root /opt/clawville-db/bin/db-backup.sh >> /opt/clawville-db/backups/backup.log 2>&1
# A dump counts only after it restores into a throwaway container (with its clawville.env marker);
# retention runs only after that. Each dump gets a <name>.meta sidecar (marker, server version, tables, bytes).
# Keeps KEEP_DAYS days locally. Optional offsite copy over rsync+ssh (the receiving key can be
# rrsync-restricted): OFFSITE=<user@host:dir> OFFSITE_KEY=<ssh key path>.
set -euo pipefail
umask 077
. "$(cd "$(dirname "$0")" && pwd)/db-marker.sh"
cd /opt/clawville-db
KEEP_DAYS="${KEEP_DAYS:-7}"
[ -z "${OFFSITE:-}" ] || : "${OFFSITE_KEY:?OFFSITE_KEY required with OFFSITE}"
# One lock for db-cutover.sh, db-migrate.sh and db-backup.sh. A cutover can hold it for a while.
exec 9>>/opt/clawville-db/.lock
flock -w "${LOCK_WAIT:-1800}" 9 || { echo "$(date -u +%FT%TZ) backup SKIPPED: lock busy"; exit 1; }
IMG=pgvector/pgvector:pg17
name="clawville-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
VC="clawville-db-verify-$$"
# Failed dumps are kept as .unverified for inspection, but only the newest 3, so repeated failures
# cannot fill the disk. Each removal is logged.
prune_unverified() {
  find backups -maxdepth 1 -type f -name 'clawville-*.dump.unverified' -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- |
    while IFS= read -r f; do if rm -f -- "$f"; then echo "$(date -u +%FT%TZ) removed old unverified dump: ${f#backups/}"; fi; done
}
cleanup() {
  local rc=$? kept=""
  docker rm -f -v "$VC" >/dev/null 2>&1 || true
  # A partial dump is deleted. A complete dump that failed verification is kept under a name
  # that retention and restores never pick up. A sidecar is never left without its dump.
  if [ -f "backups/$name.part" ] && [ -n "${dumped:-}" ]; then
    mv "backups/$name.part" "backups/$name.unverified"; kept=" (kept as $name.unverified)"
    prune_unverified
  fi
  rm -f "backups/$name.part" "backups/$name.meta.part"
  [ -f "backups/$name" ] || rm -f "backups/$name.meta"
  [ "$rc" = 0 ] || echo "$(date -u +%FT%TZ) backup FAILED: $name (exit $rc)$kept"
}
trap cleanup EXIT

# The live marker must exist: a backup without it would restore as an unmarked (unprotected) database.
# db-marker.sh reads it at database level from the catalog and refuses a differing session value.
read_marker clawville-db || { echo "FATAL: live database: $MARKER_ERR"; exit 1; }
marker=$MARKER
[ -n "$marker" ] || { echo "FATAL: the live database has no clawville.env marker"; exit 1; }
version=$(docker exec clawville-db psql -U postgres -v ON_ERROR_STOP=1 -tAc "show server_version")
[ -n "$version" ] || { echo "FATAL: could not read the server version"; exit 1; }
# --create: the archive carries CREATE DATABASE plus the database-level settings (the marker), so
# `pg_restore -C` brings clawville.env back with the data.
docker exec clawville-db pg_dump -U postgres -d clawville -Fc -Z 6 --create > "backups/$name.part"
dumped=1

# The dump must restore, or the backup does not count. Throwaway container: no network, random
# superuser password (passed by name), backups read-only; the trap removes it with its volume.
vpw=$(openssl rand -hex 24)
POSTGRES_PASSWORD="$vpw" docker run -d --name "$VC" --network none --shm-size 256m \
  -e POSTGRES_PASSWORD -v /opt/clawville-db/backups:/b:ro "$IMG" >/dev/null
# TCP answers only after the image's init finishes (init runs on the unix socket only).
for _ in $(seq 1 60); do
  docker exec "$VC" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 2
done
docker exec "$VC" pg_isready -q -h 127.0.0.1 -U postgres || { echo "FATAL: verify container never became ready"; exit 1; }
# Restore exactly like a real restore: -C recreates the database (encoding, ICU locale, settings).
docker exec -i "$VC" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE clawville;
SQL
docker exec "$VC" pg_restore -U postgres -C -d postgres --exit-on-error "/b/$name.part"
tables=$(docker exec "$VC" psql -U postgres -d clawville -v ON_ERROR_STOP=1 -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','migrations','drizzle')")
[[ "$tables" =~ ^[0-9]+$ ]] && [ "$tables" -gt 0 ] || { echo "FATAL: restored dump has no app tables"; exit 1; }
read_marker "$VC" || { echo "FATAL: restored database: $MARKER_ERR"; exit 1; }
[ "$MARKER" = "$marker" ] || { echo "FATAL: restored clawville.env marker [$MARKER] differs from the live one [$marker]"; exit 1; }
# Publish the sidecar first, then the dump: a published dump always has its .meta.
bytes=$(stat -c %s "backups/$name.part")
printf 'dump=%s\nmarker=%s\nserver_version=%s\ntables=%s\nbytes=%s\n' "$name" "$marker" "$version" "$tables" "$bytes" > "backups/$name.meta.part"
mv "backups/$name.meta.part" "backups/$name.meta"
mv "backups/$name.part" "backups/$name"

# Retention works on published pairs only: a dump without its .meta is never counted or removed here.
find backups -maxdepth 1 -type f -name 'clawville-*.dump' -mtime +"$KEEP_DAYS" | while IFS= read -r d; do
  [ -f "$d.meta" ] || continue
  if rm -f -- "$d" "$d.meta"; then echo "$(date -u +%FT%TZ) removed expired backup: ${d#backups/}"; fi
done
if [ -n "${OFFSITE:-}" ]; then
  rsync -e "ssh -i $OFFSITE_KEY -o BatchMode=yes" "backups/$name" "backups/$name.meta" "$OFFSITE/"
fi
echo "$(date -u +%FT%TZ) backup ok: $name $bytes bytes restore-verified tables=$tables${OFFSITE:+ (offsite copied)}"
