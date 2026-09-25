#!/usr/bin/env bash
# Nightly logical backup of the self-hosted ClawVille DB. Installed by cron on each box:
#   /etc/cron.d/clawville-db-backup:  17 4 * * * root /opt/clawville-db/bin/db-backup.sh >> /opt/clawville-db/backups/backup.log 2>&1
# Keeps KEEP_DAYS days locally. Optional offsite copy: OFFSITE=<user@host:dir> OFFSITE_KEY=<ssh key path>.
set -euo pipefail
cd /opt/clawville-db
KEEP_DAYS="${KEEP_DAYS:-7}"
name="clawville-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec clawville-db pg_dump -U postgres -d clawville -Fc -Z 6 > "backups/$name.part"
mv "backups/$name.part" "backups/$name"
# The archive must be readable, or the backup does not count.
docker run --rm -v /opt/clawville-db/backups:/b pgvector/pgvector:pg17 pg_restore -l "/b/$name" > /dev/null
find backups -maxdepth 1 -name 'clawville-*.dump' -mtime +"$KEEP_DAYS" -delete
if [ -n "${OFFSITE:-}" ]; then
  scp -q -o BatchMode=yes -i "${OFFSITE_KEY:?OFFSITE_KEY required with OFFSITE}" "backups/$name" "$OFFSITE/"
fi
echo "$(date -u +%FT%TZ) backup ok: $name $(stat -c %s "backups/$name") bytes${OFFSITE:+ (offsite copied)}"
