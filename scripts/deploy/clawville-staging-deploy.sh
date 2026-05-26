#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille STAGING — api (app 3) + web (app 4) on
# the staging box (real IP in gitignored scripts/deploy/.env.deploy as $STAGING_VPS_IP).
# Counterpart to clawville-deploy.sh (which targets prod app IDs 2/3).
# Idempotent — safe to invoke from GitHub Actions on every staging push.
# Coolify may also receive the GitHub webhook directly; wait briefly so that
# webhook-created queues appear, then skip apps that already have active work.
# Must run INSIDE the staging VPS.
set -euo pipefail

sleep "${COOLIFY_WEBHOOK_SETTLE_SECONDS:-8}"

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
use Illuminate\Support\Facades\DB;
foreach ([3, 4] as \$appId) {
  \$active = DB::table('application_deployment_queues')
    ->where('application_id', (string) \$appId)
    ->whereIn('status', ['queued', 'in_progress'])
    ->where('created_at', '>=', now()->subMinutes(20))
    ->orderByDesc('id')
    ->first();
  if (\$active) {
    echo "skip staging app:" . \$appId . " active deployment " . \$active->deployment_uuid . " status " . \$active->status . PHP_EOL;
    continue;
  }
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
  echo "triggered staging app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
