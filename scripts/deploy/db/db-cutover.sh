#!/usr/bin/env bash
# Cut ClawVille over from Supabase to the local clawville-db on THIS box.
# Install: copy scripts/deploy/db/*.sh to /opt/clawville-db/bin/ on the box; run db-setup.sh first.
# Usage: ENV_NAME=staging|production APP_IDS="3 4" API_C=<api container> WEB_C=<web container> \
#        DEPLOY_SCRIPT=/root/clawville-...-deploy.sh SHA=<40-hex commit> SOURCE_BARRIER=network-restricted \
#        bash db-cutover.sh
#        SOURCE_BARRIER=network-restricted attests that the operator restricted the Supabase database to this
#        box (Management API network restrictions) for the window; the real run refuses without it.
#        DEPLOY_WAIT=<seconds> (default 900): how long to wait for the redeploy before the after-switch check.
#        PREFLIGHT_ONLY=1 <same variables> bash db-cutover.sh   # pre-flight checks only, change nothing
#        (any non-empty PREFLIGHT_ONLY means pre-flight only)
# Rollback: /opt/clawville-db/.old_database_url holds the previous (Supabase) DATABASE_URL.
# The script never overwrites that file: while it exists, a new run refuses to start.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)   # before any cd: db-migrate.sh and db-marker.sh live next to this script
. "$HERE/db-marker.sh"
fails=0
# check <label> <command...>: one PASS/FAIL line; a failure is counted and the checks go on.
check() { local label=$1; shift; if "$@"; then echo "PASS $label"; else echo "FAIL $label"; fails=$((fails+1)); fi; }
stop_on_fail() { [ "$fails" = 0 ] || { echo "PREFLIGHT: FAIL ($fails)"; exit 1; }; }
matches() { [[ "$1" =~ $2 ]]; }
is_exec() { [ -f "$1" ] && [ -x "$1" ]; }

# Pre-flight part 1: inputs only (ENV_NAME first). Nothing touches the box until these pass.
check "ENV_NAME is exactly staging or production" matches "${ENV_NAME:-}" '^(staging|production)$'
check "SHA is 40 hex" matches "${SHA:-}" '^[0-9a-f]{40}$'
check "APP_IDS are Coolify app ids separated by single spaces" matches "${APP_IDS:-}" '^[0-9]+( [0-9]+)*$'
check "DEPLOY_SCRIPT is an executable file" is_exec "${DEPLOY_SCRIPT:-}"
DEPLOY_WAIT=${DEPLOY_WAIT:-900}   # seconds to wait for the redeploy before the after-switch source check
check "DEPLOY_WAIT is a number of seconds" matches "$DEPLOY_WAIT" '^[0-9]+$'
# The write barrier is operator-applied in the window, so the dry pre-flight only reports it.
if [ -n "${PREFLIGHT_ONLY:-}" ]; then
  echo "INFO SOURCE_BARRIER=${SOURCE_BARRIER:-unset} (the real run requires network-restricted)"
else
  check "SOURCE_BARRIER=network-restricted (the Supabase database accepts only this box)" matches "${SOURCE_BARRIER:-}" '^network-restricted$'
fi
stop_on_fail
cd /opt/clawville-db
# One lock for db-cutover.sh, db-migrate.sh and db-backup.sh, held until this script exits (through
# the redeploy). db-migrate.sh inherits fd 9 and reuses it.
exec 9>>/opt/clawville-db/.lock
set -a; . ./.env; set +a
ts() { date -u +%H:%M:%S; }
# Tinker output is echoed through this filter, so a URL or a Laravel ciphertext never reaches the log.
redact() { sed -E 's#postgres(ql)?://[^[:space:]]*#<url>#g; s#eyJ[A-Za-z0-9+/=]{16,}#<ciphertext>#g'; }

# Coolify env rows change only through the Eloquent model, never raw SQL. Values arrive only as
# environment variables (docker exec -e NAME), never on a command line.
#   check : per app, count DATABASE_URL rows, the rows equal to OLDURL, and the rows equal to NEWURL (read-only)
#   apply : set every DATABASE_URL row to NEWURL, print each changed row, then read back
#   revert: set OLDURL on the rows listed in ROW_IDS or now equal to NEWURL
TINKER=$(cat <<'PHP'
$ids = array_map("intval", explode(" ", trim(getenv("APP_IDS"))));
$old = getenv("OLDURL");
$new = getenv("NEWURL");
$mode = getenv("MODE");
$revertIds = array_map("intval", preg_split("/\s+/", trim(getenv("ROW_IDS")), -1, PREG_SPLIT_NO_EMPTY));
$rows = function ($id) {
  return \App\Models\EnvironmentVariable::where("key", "DATABASE_URL")
    ->where("resourceable_type", "App\\Models\\Application")->where("resourceable_id", $id)->get();
};
foreach ($ids as $id) {
  if ($mode === "check") {
    $all = $rows($id); $eq = 0; $nw = 0;
    foreach ($all as $row) { if ($row->value === $old) $eq++; if ($row->value === $new) $nw++; }
    echo "CHECK app=" . $id . " rows=" . count($all) . " equal=" . $eq . " new=" . $nw . PHP_EOL;
  } elseif ($mode === "apply") {
    $n = 0;
    foreach ($rows($id) as $row) {
      $row->value = $new; $row->save(); $n++;
      echo "CHANGED app=" . $id . " row=" . $row->id . PHP_EOL;
    }
    $all = $rows($id); $ok = 0;
    foreach ($all as $row) { if ($row->value === $new) $ok++; }
    echo "APPLIED app=" . $id . " rows=" . count($all) . " changed=" . $n . " ok=" . $ok . PHP_EOL;
  } elseif ($mode === "revert") {
    foreach ($rows($id) as $row) {
      if (in_array((int) $row->id, $revertIds, true) || $row->value === $new) {
        $row->value = $old; $row->save();
        echo "REVERTED app=" . $id . " row=" . $row->id . PHP_EOL;
      }
    }
  }
}
PHP
)
tinker() { MODE=$1 docker exec -e MODE -e APP_IDS -e OLDURL -e NEWURL -e ROW_IDS coolify php artisan tinker --execute="$TINKER" 2>&1 || true; }
# Each app in APP_IDS needs >=1 DATABASE_URL row, and every row must pass (\1 = that app's row count).
all_rows_old() { local id; for id in $APP_IDS; do grep -qx "CHECK app=$id rows=\([1-9][0-9]*\) equal=\1 new=0" <<<"$1" || return 1; done; }
all_rows_new() { local id; for id in $APP_IDS; do grep -qx "APPLIED app=$id rows=\([1-9][0-9]*\) changed=\1 ok=\1" <<<"$1" || return 1; done; }

# Pre-flight part 2: the box, read-only. The live URL goes to a mode-600 temp file, never to output;
# the trap deletes it unless the cutover moves it to .old_database_url.
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
live_is_pooler() { docker exec "${API_C:-}" printenv DATABASE_URL > "$tmp" && grep -q 'pooler.supabase.com:6543/' "$tmp"; }
web_same_url() { [ -s "$tmp" ] && [ "$(docker exec "${WEB_C:-}" printenv DATABASE_URL)" = "$(cat "$tmp")" ]; }
db_healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' clawville-db 2>/dev/null)" = healthy ]; }
# Same fail-closed marker read as db-migrate.sh (db-marker.sh): a failed query, an unexpected answer, or a
# refused marker state counts as live.
db_not_live() {
  local has_db
  has_db=$(docker exec clawville-db psql -U postgres -v ON_ERROR_STOP=1 -tAc "select 1 from pg_catalog.pg_database where datname = 'clawville'") || return 1
  case "$has_db" in "") return 0;; 1) ;; *) return 1;; esac
  read_marker clawville-db || { echo "  ($MARKER_ERR)"; return 1; }
  [ -z "$MARKER" ] || [ "${I_KNOW_THIS_DROPS_LIVE_DATA:-}" = "$MARKER" ]
}
coolify_rows_match() { local out; out=$(tinker check); redact <<<"$out"; all_rows_old "$out"; }
tmp=$(mktemp .old_database_url.XXXXXX)
trap 'rm -f "$tmp"' EXIT
check "no other db script holds /opt/clawville-db/.lock" flock -n 9
check "API_C is a running container" running "${API_C:-}"
check "WEB_C is a running container" running "${WEB_C:-}"
check "no .old_database_url yet (it holds the only rollback URL; move an old one away deliberately)" test ! -e .old_database_url
check "API_C DATABASE_URL is the Supabase txn pooler" live_is_pooler
check "WEB_C runs on the same DATABASE_URL as API_C" web_same_url
check "clawville-db is healthy" db_healthy
check "clawville-db target is not live (marker empty, or I_KNOW_THIS_DROPS_LIVE_DATA equals it)" db_not_live
OLDURL=$(cat "$tmp")
NEWURL="postgresql://clawville:${APP_PASSWORD}@clawville-db:5432/clawville"
ROW_IDS=""
export APP_IDS OLDURL NEWURL ROW_IDS
check "Coolify: each app has >=1 DATABASE_URL row, all equal to the live URL (read-only)" coolify_rows_match
stop_on_fail
echo "PREFLIGHT: PASS"
[ -z "${PREFLIGHT_ONLY:-}" ] || exit 0

echo "[$(ts)] save rollback URL + source URL"
mv "$tmp" .old_database_url
sed -E 's#(pooler\.supabase\.com):6543/#\1:5432/#' .old_database_url > .src

echo "[$(ts)] freeze writes: stop app containers"
# One at a time: if a stop fails, restart whatever already stopped, so a half stop never becomes an outage.
stopped=()
for c in "$API_C" "$WEB_C"; do
  if docker stop "$c" >/dev/null; then stopped+=("$c"); continue; fi
  echo "ABORT: could not stop $c — restarting the containers already stopped (still on Supabase)"
  [ "${#stopped[@]}" = 0 ] || docker start "${stopped[@]}" >/dev/null || echo "FATAL: restart failed — run: docker start ${stopped[*]}"
  exit 1
done

LOG=/opt/clawville-db/backups/migrate-$(date -u +%Y%m%dT%H%M%S).log
if ! REQUIRE_QUIESCENT=1 bash "$HERE/db-migrate.sh" 2>&1 | tee "$LOG"; then
  echo "ABORT: copy failed, or writes reached the source (see $LOG) — restarting old containers (still on Supabase)"; docker start "$API_C" "$WEB_C" >/dev/null; exit 1
fi
if ! grep -q 'ROWCOUNTS: IDENTICAL' "$LOG" || ! grep -q 'OBJECTS: IDENTICAL' "$LOG" || ! grep -q 'SEQUENCES: IDENTICAL' "$LOG" \
  || ! grep -q 'QUIESCENT: YES' "$LOG"; then
  echo "ABORT: verification failed — restarting old containers (still on Supabase)"; docker start "$API_C" "$WEB_C" >/dev/null; exit 1
fi

echo "[$(ts)] mark database environment"
docker exec clawville-db psql -U postgres -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE clawville SET clawville.env TO '${ENV_NAME}'" \
  && read_marker clawville-db && [ "$MARKER" = "$ENV_NAME" ] \
  || { echo "ABORT: could not set or read back the marker — restarting old containers (still on Supabase)"; docker start "$API_C" "$WEB_C" >/dev/null; exit 1; }

echo "[$(ts)] switch Coolify DATABASE_URL (Eloquent model, never raw SQL)"
out=$(tinker apply); redact <<<"$out"
if ! all_rows_new "$out"; then
  echo "ABORT: Coolify update not verified for every app — writing the old URL back to the changed rows"
  ROW_IDS=$(sed -n 's/^CHANGED app=[0-9]* row=\([0-9]*\)$/\1/p' <<<"$out" | tr '\n' ' ')
  out=$(tinker revert); redact <<<"$out"
  # Verify BEFORE any restart: every row back on the old URL, none on the new one.
  out=$(tinker check); redact <<<"$out"
  if ! all_rows_old "$out"; then
    cat <<EOF
FATAL: the Coolify revert did NOT verify. The app containers STAY STOPPED: downtime beats a split brain.
Manual recovery (never print the URLs):
  1. docker exec -it coolify php artisan tinker. For every EnvironmentVariable with key DATABASE_URL,
     resourceable_type App\Models\Application and resourceable_id in ($APP_IDS): set ->value to the content
     of /opt/clawville-db/.old_database_url, then ->save(). Eloquent only, never raw SQL.
  2. Read every row back: each must equal that content, and none may equal the clawville-db URL.
  3. docker start $API_C $WEB_C   (their environment still holds the Supabase URL)
  4. Keep /opt/clawville-db/.old_database_url until 1-3 are done.
  To finish the cutover instead: set every row to the clawville-db URL, then run: bash $DEPLOY_SCRIPT $SHA
EOF
    exit 1
  fi
  docker start "$API_C" "$WEB_C" >/dev/null || { echo "FATAL: rows are reverted, but the restart failed — run: docker start $API_C $WEB_C"; exit 1; }
  echo "ABORT: rows reverted and verified before the restart; old containers restarted (still on Supabase). clawville-db is marked but unused."
  echo "       A retry needs .old_database_url moved away and I_KNOW_THIS_DROPS_LIVE_DATA=$ENV_NAME."
  exit 1
fi

echo "[$(ts)] redeploy $SHA"
# Every container per Coolify name prefix that exists BEFORE the deploy (running or stopped): none of them
# can count as the redeployed one.
ids_before() { docker ps -a --no-trunc --filter "name=${1%-*}" --format '{{.ID}}'; }
API_BEFORE=$(ids_before "$API_C")
WEB_BEFORE=$(ids_before "$WEB_C")
# fd 9 is closed for the deploy script, so nothing it leaves running can keep the lock alive.
bash "$DEPLOY_SCRIPT" "$SHA" 9>&- || { echo "FATAL: deploy script failed — Coolify already points at clawville-db; re-run it (old containers are stopped)"; exit 1; }
echo "[$(ts)] deploy queued"

# W3 must see the source after the redeploy has finished. For each app, look at EVERY running container of its
# Coolify name prefix (the stopped old one is not running): all of them must use clawville-db, and at least one
# must be created after the deploy started (ID not in the before-set), on $SHA, and healthy (or running without
# a healthcheck). Container env values are compared, never printed.
new_ready() {  # new_ready <old container> <IDs that existed before the deploy>
  local prefix=${1%-*} before=$2 id name found=""
  while read -r id name; do
    [ -n "$id" ] && [[ "$name" == "$prefix"-* ]] || continue
    # Any running container of this app on the old URL still writes to Supabase: not ready.
    if [ "$(docker exec "$id" printenv DATABASE_URL 2>/dev/null)" != "$NEWURL" ]; then stale_url=1; return 1; fi
    ! grep -qxF "$id" <<<"$before" || continue
    [ "$(docker exec "$id" printenv SOURCE_COMMIT 2>/dev/null)" = "$SHA" ] || continue
    case "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)" in
      healthy|running) found=1;;
    esac
  done < <(docker ps --no-trunc --filter "name=$prefix" --format '{{.ID}} {{.Names}}')
  [ -n "$found" ]
}
echo "[$(ts)] wait for the redeploy: new api + web containers on $SHA, healthy (up to $DEPLOY_WAIT s)"
deadline=$(( $(date +%s) + DEPLOY_WAIT ))
rc=0
while :; do
  stale_url=""; api_ok=""; web_ok=""   # both apps are inspected on every poll, so the reason below is complete
  new_ready "$API_C" "$API_BEFORE" && api_ok=1
  new_ready "$WEB_C" "$WEB_BEFORE" && web_ok=1
  if [ -n "$api_ok" ] && [ -n "$web_ok" ]; then echo "[$(ts)] redeploy finished: both apps run $SHA on clawville-db"; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "WARNING: the redeploy did not finish within $DEPLOY_WAIT s (no healthy new container on $SHA for both apps); checking the source anyway"
    [ -z "$stale_url" ] || echo "WARNING: a container still uses the old DATABASE_URL (a running container of the app, or the Coolify change did not reach it)"
    rc=1; break
  fi
  sleep 10
done

echo "[$(ts)] after the switch: compare the source fingerprint with W2 (no automatic rollback)"
if ! SOURCE_RECHECK=1 bash "$HERE/db-migrate.sh"; then
  cat <<'EOF'
WARNING: writes reached Supabase after the copy (changed components above), so clawville-db lacks them,
         or the source could not be re-read (error above). The apps now run on clawville-db; nothing was
         rolled back. Do NOT retire Supabase: compare the listed tables in both databases and carry any
         missing writes over by hand.
EOF
  rc=1
fi
[ "$rc" = 0 ] || exit 1
echo "[$(ts)] verify health next"
