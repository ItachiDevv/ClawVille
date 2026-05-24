#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille STAGING — api (app 3) + web (app 4) on
# the staging box (real IP in gitignored scripts/deploy/.env.deploy as $STAGING_VPS_IP).
# Counterpart to clawville-deploy.sh (which targets prod app IDs 2/3).
# Idempotent — safe to invoke from GitHub Actions on every staging push.
# Must run INSIDE the staging VPS.
set -euo pipefail

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
foreach ([3, 4] as \$appId) {
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
  echo "triggered staging app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
