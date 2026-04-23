#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille api (app 3) and web (app 4).
# Idempotent — safe to invoke from GitHub Actions on every push.
set -euo pipefail

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
foreach ([3, 4] as \$appId) {
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
  echo "triggered app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
