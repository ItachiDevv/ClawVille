#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille api (app 2) and web (app 3) on the prod box
# (real IP in gitignored scripts/deploy/.env.deploy as PROD_VPS_IP).
# Migrated 2026-05-23 — IDs changed from 3/4 on the old box to 2/3 on the new box.
# Idempotent — safe to invoke from GitHub Actions on every push. Must run INSIDE the prod VPS.
# Coolify may also receive the GitHub webhook directly; wait briefly so that
# webhook-created queues appear, then skip apps that already have active work.
set -euo pipefail

sleep "${COOLIFY_WEBHOOK_SETTLE_SECONDS:-8}"

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
use Illuminate\Support\Facades\DB;
foreach ([2, 3] as \$appId) {
  \$active = DB::table('application_deployment_queues')
    ->where('application_id', (string) \$appId)
    ->whereIn('status', ['queued', 'in_progress'])
    ->where('created_at', '>=', now()->subMinutes(20))
    ->orderByDesc('id')
    ->first();
  if (\$active) {
    echo "skip app:" . \$appId . " active deployment " . \$active->deployment_uuid . " status " . \$active->status . PHP_EOL;
    continue;
  }
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
  echo "triggered app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
