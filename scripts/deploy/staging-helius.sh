#!/usr/bin/env bash
# Turn Helius RPC on or off for the STAGING api (Coolify app 3) only.
#
# Founder rule 2026-10-31: staging uses NO Helius quota unless someone is
# testing a path that needs it. The default state is OFF.
#
#   OFF: the Coolify rows HELIUS_API_KEY / HELIUS_RPC_URL / SAP_RPC_URL are
#        renamed to <NAME>_PARKED. The values stay in Coolify (encrypted).
#        The api then uses the keyless public mainnet RPC (solana-mainnet-rpc.ts
#        "no key" path); the arena chain checks skip (rpc_not_configured).
#   ON:  the rows get their real names back.
#
# Each change redeploys ONLY the staging api, pinned to the commit it already
# runs (rollback: true, so Coolify reuses the image and does not build the
# branch tip). The script prints names and states, never a value.
#
# Usage (operator machine, staging key ~/.ssh/clawville_deploy):
#   scripts/deploy/staging-helius.sh status
#   scripts/deploy/staging-helius.sh on      # before a test that needs Helius
#   scripts/deploy/staging-helius.sh off     # right after the test
set -euo pipefail

MODE="${1:-}"
case "$MODE" in on|off|status) ;; *) echo "Usage: $0 on|off|status" >&2; exit 2;; esac

if [[ -z "${STAGING_VPS_IP:-}" && -f scripts/deploy/.env.deploy ]]; then
  set -a; source scripts/deploy/.env.deploy; set +a
fi
: "${STAGING_VPS_IP:?set STAGING_VPS_IP (scripts/deploy/.env.deploy)}"
KEY="${STAGING_SSH_KEY:-$HOME/.ssh/clawville_deploy}"
SSH=(ssh -n -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "root@$STAGING_VPS_IP")

"${SSH[@]}" "docker exec coolify php artisan tinker --execute='
use App\\Models\\Application;
\$app = Application::find(3);
\$mode = \"$MODE\";
foreach ([\"HELIUS_API_KEY\", \"HELIUS_RPC_URL\", \"SAP_RPC_URL\"] as \$k) {
  \$live = \$app->environment_variables()->where(\"key\", \$k)->first();
  \$parked = \$app->environment_variables()->where(\"key\", \$k.\"_PARKED\")->first();
  if (\$mode === \"off\" && \$live) { \$live->key = \$k.\"_PARKED\"; \$live->save(); echo \"parked \".\$k.PHP_EOL; }
  elseif (\$mode === \"on\" && \$parked && !\$live) { \$parked->key = \$k; \$parked->save(); echo \"restored \".\$k.PHP_EOL; }
  else { echo \$k.\": \".(\$live ? \"ON\" : (\$parked ? \"parked\" : \"absent\")).PHP_EOL; }
}
'"

[[ "$MODE" == status ]] && exit 0

CONTAINER="$("${SSH[@]}" "docker ps --format '{{.Names}}' | grep yvtwz | head -1")"
COMMIT="$("${SSH[@]}" "docker exec $CONTAINER printenv SOURCE_COMMIT")"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "could not read SOURCE_COMMIT from $CONTAINER" >&2; exit 1; }

"${SSH[@]}" "docker exec coolify php artisan tinker --execute='
use App\\Models\\Application;
\$app = Application::find(3);
\$uuid = (string) new \\Visus\\Cuid2\\Cuid2;
queue_application_deployment(application: \$app, deployment_uuid: \$uuid, commit: \"$COMMIT\", is_api: true, no_questions_asked: true, rollback: true);
echo \"queued staging api redeploy \".\$uuid.\" at \".\"$COMMIT\".PHP_EOL;
'"
echo "Wait 1-3 min, then check: the api container name changes and /health answers."
