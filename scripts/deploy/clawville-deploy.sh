#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille api (app 2) and web (app 3) on the prod box
# (real IP in gitignored scripts/deploy/.env.deploy as PROD_VPS_IP).
# Migrated 2026-05-23 — IDs changed from 3/4 on the old box to 2/3 on the new box.
# Queues one deployment per app per invocation; workflow concurrency controls normal calls.
# Must run INSIDE the prod VPS.
set -euo pipefail

# CLAWVILLE_PINNED_DEPLOY_V1: CI checks this marker before calling the helper.
# Never resolve a moving branch tip after Gates approved a different commit.
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Usage: $0 <tested-full-commit-sha>" >&2
  exit 2
fi
DEPLOY_COMMIT="$1"

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
foreach ([2, 3] as \$appId) {
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, commit: '$DEPLOY_COMMIT', is_api: true, no_questions_asked: true);
  echo "triggered app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
