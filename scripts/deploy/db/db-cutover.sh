#!/usr/bin/env bash
# Cut ClawVille over from Supabase to the local clawville-db on THIS box.
# Install: copy scripts/deploy/db/*.sh to /opt/clawville-db/bin/ on the box; run db-setup.sh first.
# Usage: ENV_NAME=staging|production APP_IDS="3 4" API_C=<api container> WEB_C=<web container> \
#        DEPLOY_SCRIPT=/root/clawville-...-deploy.sh SHA=<40-hex commit> bash db-cutover.sh
# Rollback: /opt/clawville-db/.old_database_url holds the previous (Supabase) DATABASE_URL.
set -euo pipefail
cd /opt/clawville-db
: "${ENV_NAME:?}" "${APP_IDS:?}" "${API_C:?}" "${WEB_C:?}" "${DEPLOY_SCRIPT:?}" "${SHA:?}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "FATAL: SHA must be 40 hex"; exit 1; }
set -a; . ./.env; set +a
ts() { date -u +%H:%M:%S; }

echo "[$(ts)] save rollback URL + source URL"
( umask 077; docker exec "$API_C" printenv DATABASE_URL > .old_database_url )
grep -q 'pooler.supabase.com:6543/' .old_database_url || { echo "FATAL: current DATABASE_URL is not the Supabase txn pooler — already cut over?"; exit 1; }
( umask 077; sed -E 's#(pooler\.supabase\.com):6543/#\1:5432/#' .old_database_url > .src )

echo "[$(ts)] freeze writes: stop app containers"
docker stop "$API_C" "$WEB_C" >/dev/null

LOG=/opt/clawville-db/backups/migrate-$(date -u +%Y%m%dT%H%M%S).log
if ! bash "$(dirname "$0")/db-migrate.sh" 2>&1 | tee "$LOG"; then
  echo "ABORT: copy failed — restarting old containers (still on Supabase)"; docker start "$API_C" "$WEB_C" >/dev/null; exit 1
fi
if ! grep -q 'ROWCOUNTS: IDENTICAL' "$LOG" || ! grep -q 'SEQUENCES: IDENTICAL' "$LOG"; then
  echo "ABORT: verification failed — restarting old containers (still on Supabase)"; docker start "$API_C" "$WEB_C" >/dev/null; exit 1
fi

echo "[$(ts)] mark database environment"
docker exec clawville-db psql -U postgres -q -c "ALTER DATABASE clawville SET clawville.env TO '${ENV_NAME}'"

echo "[$(ts)] switch Coolify DATABASE_URL (Eloquent model, never raw SQL)"
NEWURL="postgresql://clawville:${APP_PASSWORD}@clawville-db:5432/clawville"
docker exec -e NEWURL="$NEWURL" -e APP_IDS="$APP_IDS" coolify php artisan tinker --execute='
use App\Models\EnvironmentVariable;
$ids = array_map("intval", explode(" ", trim(getenv("APP_IDS"))));
$n = 0;
foreach (EnvironmentVariable::where("key", "DATABASE_URL")->where("resourceable_type", "App\\Models\\Application")->whereIn("resourceable_id", $ids)->get() as $row) {
  $row->value = getenv("NEWURL"); $row->save(); $n++;
}
$ok = 0;
foreach (EnvironmentVariable::where("key", "DATABASE_URL")->where("resourceable_type", "App\\Models\\Application")->whereIn("resourceable_id", $ids)->get() as $row) {
  if ($row->value === getenv("NEWURL")) $ok++;
}
echo "updated=" . $n . " readback_ok=" . $ok . PHP_EOL;
'

echo "[$(ts)] redeploy $SHA"
bash "$DEPLOY_SCRIPT" "$SHA"
echo "[$(ts)] deploy queued — verify health next"
