---
name: feedback-staging-first-push-flow
description: "All ClawVille pushes go to the `staging` branch first. Override = literal phrase `direct to master` in the commit message. Promotion = PR `staging → master`. Set 2026-05-24 after the user demanded a more serious deploy workflow following the prod migration cutover."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 660f876a-b012-459e-8ed1-977182c0844d
---

ALL new ClawVille work goes to the `staging` git branch first. Push to `master` is forbidden unless the user's message (or commit message) contains the literal phrase **`direct to master`** (case-insensitive).

**Why:** User repeatedly burned by cutover bugs landing on prod without a staging gate. Most recently after the 2026-05-23 box migration, where my raw-SQL env-var encryption mistake forced a DNS rollback mid-cutover. The rule trades velocity for safety; deploys take 2–3× longer (extra build + manual verify + PR ceremony) but no broken state hits prod users.

**How to apply:**

Default flow:
1. `git push origin staging` → `.github/workflows/deploy-staging.yml` ships to STAGING_VPS_IP (`87.99.142.34`, Coolify apps 3+4).
2. Verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` (browser playtest, not just curl 200).
3. `gh pr create --base master --head staging --title "promote: …" --body "<verification evidence>"` — open the promotion PR.
4. Merge the PR → `.github/workflows/deploy.yml` ships to PROD_VPS_IP (`5.78.129.176`, Coolify apps 2+3).

Override:
- Only if the user's message OR commit message contains `direct to master` (case-insensitive). The merged commit's CI run flags the bypass as a `::warning::` in the GH Actions log. Hotfix only.

Caveats:
- Both Coolify boxes share the SAME Supabase DB. Staging writes mutate prod data. Don't assume "staging is safe to test destructive things" — it isn't. Treat destructive staging changes with the same care as prod.
- GH Actions auto-deploy needs repo secrets (`PROD_VPS_IP`, `STAGING_VPS_IP`, `COOLIFY_SSH_KEY`, `STAGING_COOLIFY_SSH_KEY`). Until added, push triggers the workflow but the SSH step fails — fall back to manual `bash /root/clawville-staging-deploy.sh` (staging) or `bash /root/clawville-deploy.sh` (prod) via SSH.
- Coolify on the staging box is pinned to the `staging` branch (`git_branch='staging'` on apps 3+4). Prod stays on `master`. Don't accidentally flip either.

Companion to [[project_deploy_infrastructure]] (IPs, app IDs, SSH keys) and [[feedback_coolify_envvar_encryption]] (the model-mutator gotcha that bit during the migration).
