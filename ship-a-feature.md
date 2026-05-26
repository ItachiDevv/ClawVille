# Ship a feature — end-to-end loop

The canonical loop for any change. Every other runbook in this directory
delegates to this one for the "land it" half.

## The loop

1. **Identify which canonical docs you'll touch.**
   - Grep `CLAUDE.md` "Path → doc decision matrix" for the file paths you're about to edit.
   - If the matrix says "update `WorldContent.md §2 + 3dStructure.md §2`", you're touching both. Don't start coding before you know what doc updates land in the same diff.
2. **Make the code change.**
3. **Update the canonical doc(s) in the same diff.**
   - Edit the relevant table or section.
   - Bump the doc's "Last edit" line at the top.
   - If it's a section that has a "Recent material changes" log at the bottom, add a one-line entry.
4. **Typecheck.**
   ```bash
   cd apps/web && bun x tsc --noEmit -p tsconfig.json && echo OK || echo FAIL
   cd apps/api && bun x tsc --noEmit -p tsconfig.json && echo OK || echo FAIL
   ```
   (Run only the side you touched; both if it's cross-cutting.)
5. **Commit.** Conventional-commit-ish, scope-prefixed:
   ```
   feat(buildings): add Sandy's underwater greenhouse
   perf(npc-store): mutate position in place on stable NPC refs
   docs(world-content): add the underwater greenhouse to §2
   ```
   The commit body should describe **what changed and why**, not what the doc says now.
6. **Push to STAGING.** Per CLAUDE.md PUSH FLOW: all new work lands on the `staging` branch first.
   ```bash
   git checkout staging
   git merge --ff-only <your-feature-branch>   # or just commit directly on staging
   git push origin staging
   ```
   - `gh auth setup-git` + `unset GITHUB_TOKEN` if push auth fails. Do not hand the user the push — see the "No lazy handoffs" rule in `CLAUDE.md`.
   - **Override:** only if the commit message contains the literal phrase `direct to master` (hotfix path) is it OK to skip steps 7–9 and push to master directly.
7. **Wait for STAGING Coolify.** `deploy-staging.yml` fires on push to `staging`. ~3–5 min for web builds. Watch via (staging box, app id 4 = web):
   ```bash
   ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP "docker exec coolify php artisan tinker --execute='use App\Models\ApplicationDeploymentQueue; \$d = ApplicationDeploymentQueue::where(\"application_id\",4)->orderByDesc(\"id\")->first(); echo \$d->status . \" \" . substr(\$d->commit,0,7);'"
   ```
   Status flow: `queued → in_progress → finished`.
8. **Verify on STAGING in browser.** Per the CLAUDE.md MANDATORY rule:
   - Open `https://staging.clawville.world/game` via Chrome DevTools MCP / Playwright.
   - Check the feature's golden path. Take a screenshot. Confirm no console errors.
   - If you can't visually verify because of tool limits, say so explicitly — never claim a visual fix done without seeing it.
9. **Promote to PROD.** After staging verification:
   ```bash
   gh pr create --base master --head staging --title "promote: <feature summary>" --body "Verified on staging.clawville.world\n\n<paste evidence: screenshot path, perf numbers, etc>"
   gh pr merge <PR#> --merge   # or --squash if you prefer a clean master history
   ```
   `deploy.yml` then ships to PROD on the master merge. Watch prod the same way (app id 3 = web on the Hillsboro box, key `~/.ssh/clawville_hillsboro` via ssh-agent). Final browser verify on `https://clawville.world/game`.

## Doc updates required

Driven by which code paths you touched. Default to the path → doc matrix in `CLAUDE.md`.

- [ ] Did you update the matching canonical doc(s)?
- [ ] Did you bump the "Last edit" header on each touched doc?
- [ ] If the change is material (new feature, swapped asset, new constant), did you add a one-line entry to the doc's "Recent material changes" log?

## When this loop fails

- **Push auth fails:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → retry. SSH remote as last fallback.
- **Coolify build fails:** check the failed deploy's logs via the SSH `tinker` command in `DEPLOY-HETZNER.md`. Common causes: type error in a dependency package; flaky Docker layer push.
- **Browser verify shows wrong asset:** prod's static asset handler sends `Cache-Control: max-age=31536000, immutable`. Rename the file with a `-v2` suffix to bust the cache.
- **3D mesh sized wrong:** measure the GLB locally with `scripts/read-glb-bbox.mjs` before guessing yOffset / scale values. See `3dStructure.md §2` for the building scale + pivot system.
