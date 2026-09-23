# Regression provenance audit, 2026-09-22

Team: dd-bounty-cleanup-20260922. Role: independent Git provenance auditor.

## Evidence boundary

Reviewed fetched `origin/master` = `6f115fc2` and `origin/staging` = `10575a98` on itachi222. The coordinator independently read both live health endpoints and found these SHAs. This report examines Git diffs and CI configuration. It does not claim a new browser reproduction or a database audit.

The original ClawVille checkout on itachi222 remains at `754f2bfd` from July 28. The audit uses the isolated `cv-dd-audit` worktree. Old local files are not evidence that production reverted. The current master/staging application difference contains only Trading Floor changes. The September 18 complaint fixes are present on both branches.

## Confirmed causes

| Complaint | Earlier behavior | Defect introduction | September repair | Evidence and classification |
|---|---|---|---|---|
| Empty outer land lots after an earlier fill request | `12307503` on June 18 changes showroom stride from 3 to 1 and fills every then-existing founder/starter parcel | `220e2f64` on June 24 adds 20 c-tier parcels without changing showroom generation | `acb02d6e` on staging; `51f376a4` on hotfix/master | Actual diffs prove a missed coupling. The prior fix was not deleted. It ceased to cover the expanded parcel set. Current `land-showroom.ts` explicitly covers c-tier and its test asserts full parcel coverage. |
| Delayed copy of the player's avatar after Reef Race | `21db4a83` on June 19 adds local/former-session filtering to `players.ts` | `969c6769` on July 30 adds activity downlink suspension. `closeStream()` calls `clearPlayers()` while the world session remains alive | `45eb388e` / `ab6c8dbe`, followed by queue review changes | Actual diffs prove a lifecycle regression. `clear()` erases the local identity. Reopen retains the session without a new join. The old filter remains in code but loses its input. Current controller calls `clearRemotePlayers()` and reasserts local identity before reopen. |
| Nori collider differs from her body | Mesh and collider previously use Z=240 | `f9a3e6df` on May 21 changes `GUIDE_Z` from 240 to 400 without the collider update | `60ae1b0a` / `8b459199`, then `7988ea34` / `addc8c3a` for the server collider | Actual mesh diff and repair diff establish stale duplicated coordinates. Current client mesh, client collider, and server collider use shared `NORI_WORLD_Z=400`. |
| Cove unexpectedly uses the dark fallback room | `50d373ba` creates the Cove interior with a fixed 40 FPS fallback threshold | The threshold never accounts for the 30 FPS phone profile introduced by `0e2fa0c2`; early scene stalls also contaminate the initial sample | `3793c675` / `de793d92` | Actual sampler diff proves the hard-coded threshold and first-window sampling. This is a compatibility defect between new performance policy and older fallback policy. The precise first activation commit for all retained-stage cases is not established here. |
| Cove exit returns the player to the tunnel | Old exit uses world X=-3760 | Later tunnel/collision behavior makes that point unsafe; `f9924239` carries the auto-enter bands | `32680477` / `ddf56c8f`; NPC placement `498c04ab` / `fdd7f678`; refresh/home placement `40ebf275` / `e1b22676` | Old exit and repair diffs confirm an unsafe constant. No evidence establishes deletion of an earlier safe exit patch. Current exit derives from the prompt band and updates the NPC body. |
| Nori sends bounty users to Pearl | Three knowledge surfaces describe bounty mechanics but lack an explicit board location | No overwrite commit established | `6f0c9e89` / `031f32a5`, then knowledge accuracy and building-place changes | The repair adds the location and explicitly rejects NPC custody. This report does not claim that every generated answer now follows that text. |
| SAP/OOBE tables remain after code removal | August removal deliberately retains physical reconciliation evidence | No reintroduction established | `b428cb5f` / `8ed77738`, migration 0067 | The earlier removal is staged, not a demonstrated restore of removed code. Migration 0067 drops the retained physical objects. Its production rollout causes a documented four-minute bounty 500 window because old app code still selects removed columns before the container flip. |
| Wager lobbies never close | Two historical lobbies have prepared creates and absent chain accounts | No previous close implementation found | `01137d48`, `ff619a4f`, `41add642` and hotfix equivalents | Repair adds a missing terminal branch and a finalized-chain watcher. A new recovery branch is not proof of an overwritten prior fix. Durable closure still requires row/chain verification. |

## Branch and merge evidence

1. September hotfixes copy staging patches onto master with new commit IDs. A different SHA does not mean a missing patch.
2. `3e205b1c` merges master into staging before DoorDash promotion #279. Its actual delta is two deploy-ledger lines. It does not replace application code.
3. Hotfixes #285 through #294 are not promptly merged back. Before reconciliation, master has 79 unique commits and staging has 97. This impedes promotion and creates conflict risk.
4. `1e34f075` on September 20 merges master into staging. The first-parent diff contains four files: ARCHITECTURE, founder review, deploy ledger, and the bounty-board-place regression test. It does not remove an application fix.
5. The bounty-board-place test exists on the hotfix line before staging receives it through this merge. That is a real temporary test-coverage divergence.
6. `667efaac` in July adds roughly 1,683 lines to GameFeatures. September commits `b5e38e8e` / `feb7c98f` remove duplicated sections. Duplicate canonical text creates contradictory instructions, but does not itself prove a runtime rollback.

The examined evidence does not support one general merge overwrite as the cause of all complaints. Two major complaints have direct, reproducible code-history explanations: new land geometry omitted showroom coverage, and new stream suspension cleared identity required by the prior ghost fix.

## CI enforcement defects found in this audit

Live GitHub API read on September 22:

- `GET /repos/ItachiDevv/ClawVille/branches/master`: `protected=false`, checks and contexts empty, enforcement `off`.
- The staging branch returns the same state.
- The repository rulesets endpoint returns an empty list.
- The master protection endpoint returns HTTP 404, `Branch not protected`.

Before this cleanup, `gates.yml` runs on selected PR changes and master pushes. It does not run on staging pushes. Both deployment workflows require only `migrate`; they do not depend on Gates. A failed test can therefore coexist with a production deployment.

Coverage gaps before this cleanup:

- PR path filters omit `packages/agent-runtime/**` and `packages/agent-templates/**`.
- Web's explicit test list omits `players-local-identity`, `salvage-identity`, `salvage-hydrator`, and `agent-display-name`.
- API activity queue and room-manager unit suites are outside the selected service directories. The wager DB suite runs separately, but does not replace these unit suites.
- Runtime DoorDash/action/persona tests have no test step in Gates.
- Route mock isolation uses a fixed filename list. New `mock.module` files can enter the shared process and contaminate other tests.

## Owed work in the inherited plan

`.claude/plans/gates-phase0c-sweep-and-flip.md` explicitly says NOT STARTED. It requires: empirical staging/CI constraint parity; a permanent artifact inventory; automatic mock isolation; branch protection; then the coupling registry. Current API and workflow reads confirm the protection and automatic-isolation items did not land. This audit does not substitute Git diffs for the required database inventory.

The coordinator owns the broader complaint matrix, live verification, and remaining repair decisions. This report makes no founder visual sign-off claim.

## Cleanup diff and validation

The cleanup adds a reusable Gates workflow. Both deploy callers require Gates before live migration, then require migration before deployment. PR filters include agent runtime, templates, dependency files, and workflow changes. Missing web and activity tests now run. All runtime files run separately. Service and route mockers automatically run in separate processes. The old route list missed `floor-house-traders.test.ts` and `rate-limit-client-ip.test.ts`.

The helper scripts previously queue a moving branch tip. Read-only SSH probes on September 22 confirm both live Coolify versions accept a named `commit` argument. The new helpers require a full 40-character SHA and pass it to Coolify. Both workflow callers supply their tested `github.sha`. A version-marker preflight refuses an old host helper that would ignore the argument.

Validation on itachi222: actionlint exits 0 for all three workflows; YAML dependency assertions pass; `git diff --check` exits 0. The four added web suites pass 12 tests. Activity queue passes 24 tests. Room manager passes 60 tests. All 12 runtime test files pass separately. Local Bun is 1.3.14; CI remains pinned to 1.3.11. The exact route partition runs each of 65 files once: 50 shared, 15 isolated. This does not claim a new Postgres CI run.

Remaining release work: independent review, install the reviewed helpers on both VPS hosts, run the full same-commit Gates suite, and verify deployed source commits. No remote scripts or branch protection changed in this subtask. The empirical staging/CI constraint inventory remains unperformed and must not be marked satisfied by this workflow repair.
