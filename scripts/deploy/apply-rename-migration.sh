#!/usr/bin/env bash
# apply-rename-migration.sh
#
# Applies a hand-authored Drizzle SQL migration (e.g. 0007_pets_to_avatars.sql)
# to the production Postgres instance. ClawVille's prod DB is Supabase
# (endpoint in scripts/deploy/.env.deploy) — NOT the coolify-db Postgres
# stack. The DATABASE_URL is set as an env var inside the api container
# on the Hetzner VPS. We exec into the api container, install psql if
# absent, and apply the migration via psql against $DATABASE_URL.
#
# This script EXISTS because `packages/database/package.json` wires both
# `migrate` and `push` to `drizzle-kit push --force`, which DIFFs the TS
# schema against the live DB and synthesizes its own ALTERs — it does NOT
# execute hand-authored SQL files in `packages/database/drizzle/*.sql`.
# Running `db:push` for a rename would emit `DROP TABLE avatars` + `CREATE
# TABLE avatars` and wipe production rows. This script is the manual
# escape hatch.
#
# Usage:
#   bash scripts/deploy/apply-rename-migration.sh \
#     --migration 0007 \
#     --vps-ip <PROD_VPS_IP>
#
#   # or via env:
#   PROD_VPS_IP=1.2.3.4 bash scripts/deploy/apply-rename-migration.sh --migration 0007
#
# Flags:
#   --migration <NUMBER>   4-digit migration prefix (default: 0007)
#   --vps-ip <IP>          Production VPS IP (else PROD_VPS_IP env var; no default)
#   --ssh-key <PATH>       SSH key path (default: ~/.ssh/clawville_hillsboro for prod;
#                          use ~/.ssh/clawville_deploy for staging)
#   --dry-run              Print commands instead of executing
#   --probe-table <NAME>   Pre-flight existence check; if non-NULL, abort
#                          gracefully (default: avatars — only valid for 0007)
#   --verify-table <NAME>  Post-flight count probe (default: avatars)
#   -h, --help             Show this help and exit
#
# Exit codes:
#   0   Migration applied successfully (or already applied)
#   1   Pre-flight check failed for an unexpected reason
#   2   Migration SQL execution failed
#   3   Post-flight verification failed
#   4   Bad usage / missing required flag
#
# Notes:
# - Drizzle's `_journal.json` is left untouched. It's not in the execution
#   path (we don't use `drizzle-kit migrate`), and updating it without a
#   matching snapshot file would just confuse future humans.
# - Idempotent: re-running after success reports "already applied" and
#   exits 0. Re-running after a partial failure runs the SQL again — the
#   migration itself wraps DDL in BEGIN/COMMIT and uses idempotent guards
#   on rename steps, so retry is safe.

set -euo pipefail

MIGRATION="0007"
VPS_IP="${PROD_VPS_IP:-}"
SSH_KEY="${HOME}/.ssh/clawville_hillsboro"  # prod post-2026-05-23; use clawville_deploy for staging
DRY_RUN=0
PROBE_TABLE="avatars"
VERIFY_TABLE="avatars"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --migration)   MIGRATION="$2"; shift 2 ;;
    --vps-ip)      VPS_IP="$2"; shift 2 ;;
    --ssh-key)     SSH_KEY="$2"; shift 2 ;;
    --probe-table) PROBE_TABLE="$2"; shift 2 ;;
    --verify-table) VERIFY_TABLE="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    *) echo "[apply-rename-migration] Unknown flag: $1" >&2; exit 4 ;;
  esac
done

if [[ -z "$VPS_IP" ]]; then
  echo "[apply-rename-migration] Missing --vps-ip (or PROD_VPS_IP env)." >&2
  echo "  See CLAUDE.md → 'Deployment — Hetzner + Coolify' for the IP." >&2
  exit 4
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_DIR="$REPO_ROOT/packages/database/drizzle"

# Find the SQL file matching the migration prefix. We don't hard-code the
# slug so the script works for any future hand-authored rename migration.
LOCAL_SQL="$(find "$SQL_DIR" -maxdepth 1 -name "${MIGRATION}_*.sql" | head -n1 || true)"
if [[ -z "$LOCAL_SQL" || ! -f "$LOCAL_SQL" ]]; then
  echo "[apply-rename-migration] No SQL file found for prefix '${MIGRATION}' under $SQL_DIR" >&2
  exit 4
fi
SQL_BASENAME="$(basename "$LOCAL_SQL")"
REMOTE_TMP="/tmp/${SQL_BASENAME}"
CONTAINER_TMP="/tmp/${SQL_BASENAME}"

echo "[apply-rename-migration] migration   : ${MIGRATION}"
echo "[apply-rename-migration] sql file    : ${LOCAL_SQL}"
echo "[apply-rename-migration] vps         : root@${VPS_IP}"
echo "[apply-rename-migration] ssh key     : ${SSH_KEY}"
echo "[apply-rename-migration] probe table : ${PROBE_TABLE}"
echo "[apply-rename-migration] verify table: ${VERIFY_TABLE}"

run_remote() {
  local cmd="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] ssh root@${VPS_IP} \"${cmd}\""
    return 0
  fi
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "root@${VPS_IP}" "$cmd"
}

find_api_container() {
  if [[ -z "${API_APP_UUID:-}" ]]; then
    echo "[apply-rename-migration] API_APP_UUID not set — source scripts/deploy/.env.deploy first or export it." >&2
    return 1
  fi
  run_remote "docker ps --format '{{.Names}}' | grep -E '${API_APP_UUID}' | head -1"
}

ensure_psql_in_container() {
  local container="$1"
  if ! run_remote "docker exec ${container} which psql >/dev/null 2>&1"; then
    echo "[apply-rename-migration] Installing postgresql-client in api container..."
    run_remote "docker exec ${container} bash -c 'apt-get update -qq && apt-get install -y -qq postgresql-client' >/dev/null 2>&1"
  fi
}

run_psql() {
  # Run a single SQL statement against the live Supabase DB via the api
  # container's $DATABASE_URL. Returns only the value (psql -At = unaligned,
  # tuples-only).
  local sql="$1"
  local container="${API_CONTAINER:-$(find_api_container)}"
  if [[ -z "$container" ]]; then
    echo "[apply-rename-migration] Could not find api container on ${VPS_IP}" >&2
    return 1
  fi
  API_CONTAINER="$container"
  ensure_psql_in_container "$container"
  run_remote "docker exec ${container} bash -c 'psql \"\$DATABASE_URL\" -At -c \"${sql//\"/\\\"}\"'"
}

# ─── Pre-flight: is the migration already applied? ──────────────────────
echo
echo "[apply-rename-migration] Pre-flight: probing for table '${PROBE_TABLE}'..."
# `to_regclass` returns the relation name if it exists, else NULL. With
# psql -At (unaligned + tuples-only) NULL prints as empty. Strip the
# trailing newline psql still emits.
PROBE_OUT="$(run_psql "SELECT to_regclass('public.${PROBE_TABLE}')" || true)"
PROBE_OUT="$(echo "$PROBE_OUT" | tr -d '[:space:]')"

if [[ "$PROBE_OUT" == "${PROBE_TABLE}" ]]; then
  echo "[apply-rename-migration] Table '${PROBE_TABLE}' already exists. Migration appears to be applied. Skipping."
  exit 0
fi

if [[ -z "$PROBE_OUT" ]]; then
  echo "[apply-rename-migration] Pre-flight: '${PROBE_TABLE}' does not exist (expected for un-applied state). Proceeding."
else
  echo "[apply-rename-migration] Pre-flight returned unexpected value: '${PROBE_OUT}'. Proceeding cautiously." >&2
fi

# ─── Copy SQL up + into container ───────────────────────────────────────
echo
echo "[apply-rename-migration] Copying SQL to ${VPS_IP}:${REMOTE_TMP}..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] scp -i $SSH_KEY \"$LOCAL_SQL\" root@${VPS_IP}:${REMOTE_TMP}"
else
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
    "$LOCAL_SQL" "root@${VPS_IP}:${REMOTE_TMP}"
fi

CONTAINER="${API_CONTAINER:-$(find_api_container)}"
if [[ -z "$CONTAINER" ]]; then
  echo "[apply-rename-migration] Could not find api container on ${VPS_IP}" >&2
  exit 1
fi
echo "[apply-rename-migration] Copying SQL into api container ${CONTAINER}..."
run_remote "docker cp ${REMOTE_TMP} ${CONTAINER}:${CONTAINER_TMP}"

# ─── Apply migration ────────────────────────────────────────────────────
echo
echo "[apply-rename-migration] Applying migration via psql against \$DATABASE_URL (Supabase)..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] docker exec ${CONTAINER} bash -c 'psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ${CONTAINER_TMP}'"
else
  ensure_psql_in_container "$CONTAINER"
  if ! run_remote "docker exec ${CONTAINER} bash -c 'psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ${CONTAINER_TMP}'"; then
    echo "[apply-rename-migration] Migration FAILED. The hand-authored SQL is wrapped in BEGIN/COMMIT," >&2
    echo "  so on error PG will have rolled back. Investigate the error output above and retry." >&2
    exit 2
  fi
fi

# ─── Post-flight: verify table is queryable ─────────────────────────────
echo
echo "[apply-rename-migration] Post-flight: verifying SELECT count(*) FROM ${VERIFY_TABLE}..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] would query SELECT count(*) FROM ${VERIFY_TABLE}"
else
  if ! VERIFY_OUT="$(run_psql "SELECT count(*) FROM ${VERIFY_TABLE}")"; then
    echo "[apply-rename-migration] Post-flight count query FAILED. Migration likely did not commit cleanly." >&2
    exit 3
  fi
  VERIFY_OUT="$(echo "$VERIFY_OUT" | tr -d '[:space:]')"
  echo "[apply-rename-migration] Post-flight: count(${VERIFY_TABLE}) = ${VERIFY_OUT}"
fi

echo
echo "[apply-rename-migration] Done. Migration ${MIGRATION} applied successfully."
echo "[apply-rename-migration] Next: trigger code deploy via Coolify (see CLAUDE.md)."
