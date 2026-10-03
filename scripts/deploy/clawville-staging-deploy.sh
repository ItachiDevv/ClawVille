#!/usr/bin/env bash
# Triggers Coolify deploys for ClawVille STAGING — api (app 3) + web (app 4) on
# the staging box (real IP in gitignored scripts/deploy/.env.deploy as $STAGING_VPS_IP).
# Counterpart to clawville-deploy.sh (which targets prod app IDs 2/3).
# Queues one deployment per app per invocation; workflow concurrency controls normal calls.
# Must run INSIDE the staging VPS.
set -euo pipefail

# CLAWVILLE_PINNED_DEPLOY_V1: CI checks this marker before calling the helper.
# Never resolve a moving branch tip after Gates approved a different commit.
# `rollback: true` is what makes the pin real. Without it Coolify's deployment job runs
# `git ls-remote refs/heads/<branch>` and REPLACES the requested commit with the branch tip
# (seen on staging 2026-10-03: a db57bbbc request built fa159a9b). With it the job checks out
# exactly $DEPLOY_COMMIT; Coolify's own "redeploy this commit" uses the same flag.
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Usage: $0 <tested-full-commit-sha>" >&2
  exit 2
fi
DEPLOY_COMMIT="$1"

docker exec -i coolify php artisan tinker --execute="$(cat <<PHP_EOF
use App\Models\Application;
foreach ([3, 4] as \$appId) {
  \$app = Application::find(\$appId);
  \$uuid = (string) new \Visus\Cuid2\Cuid2;
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, commit: '$DEPLOY_COMMIT', is_api: true, no_questions_asked: true, rollback: true);
  echo "triggered staging app:" . \$appId . " deployment " . \$uuid . PHP_EOL;
}
PHP_EOF
)"
