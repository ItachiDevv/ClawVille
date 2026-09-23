# ClawVille regression cleanup audit

Last Audited: 2026-09-22. Status: IN PROGRESS. Coordinator: Codex.

## Scope and evidence rules

The founder requested a full audit of the Claude sessions `dd` and `bountyFix2`, related sessions in their period, and cleanup of unresolved complaints. Transcript assertions do not count as independent verification. Each result distinguishes historical evidence, current source, executed tests, live state, and visual checks.

The principal period is September 16–20, 2026. The gate-work predecessor starts September 14. Logs reside on **itachi222**, under `C:\Users\itachi\.claude\projects\C--Users-itachi-Documents-Crypto-ClawVille`.

## Checkout and deployed baseline

- The original ClawVille checkout is `main-desktop` at `754f2bfd`, July 28. It is 646 commits behind fetched staging. `git pull --ff-only` refused because tracked incoming assets would overwrite local untracked files. Those files remain untouched.
- Audit worktree: `C:\Users\itachi\Documents\Crypto\cv-dd-audit`, branch `audit/dd-bounty-cleanup-20260922`, baseline `10575a98`.
- Production `/health`, September 22 04:39 UTC: `6f115fc2c0eecb6765b981879cda16659310c185`, status `ok`.
- Staging `/health`, same check: `10575a98c4d954bcfd809c1d86aa4c9169942151`, status `ok`.
- Independent SSH container inspection finds both application images on each host at those SHAs. Production API `SOURCE_COMMIT` agrees and `CLAWVILLE_ENV=production`.
- Differences between these branches concern later Trading Floor work. The original regression repair commits remain ancestors of both branches.

## Session coverage

Discovery inspected all 16 top-level ClawVille transcripts on itachi222 (366.3 MB). Exactly seven contain events during September 16–20 UTC. All seven appear below. The earlier gate precursor adds historical context. The adjacent-session report inventories excluded dates and distinguishes later runner containment from evidence in the audit period. Its six parent logs and 46 subagent logs contain 63,583 records.

| Session | ID | Scope and current audit status |
|---|---|---|
| dd | `b4fbbf4a-9a8c-47ea-a87d-a5dcc906e610` | Full parsed transcript, eight subagent logs, complaint matrix, code and exploit checks. See dd report. |
| bountyFix2 | `9a694cbe-d6d8-4642-a1ff-18cf75b621a1` | Full parsed transcript and embedded Codex reviews. No Agent/Task subagent logs. See bounty report. |
| fixBounty | `924028d1-dfd1-42a1-b11b-51656fc07b14` | Gate-work precursor: all user requests and implementation/failure/final reports inspected. Phase 0c handoff remains partly unfinished. |
| Gate and settlement precursor | `201f3253-9acd-4620-81f2-6e280d7bb5f1` | September 14–15 reports inspected: self-heal, protocol pins, retired export flow, canonical-doc drift. Current bounty retry tests pass. |
| mobile | `1803b128-c813-43ed-86be-998f3603d4b6` | Full period review appears in the adjacent-session report. The prior wave-two promotion reached production through later promotions. Real Safari evidence remains separate. |
| clawPump | `e7625636-22c9-413c-8ef9-ca3827d30203` | Full period review appears in the adjacent-session report. Later containment pauses both runners indefinitely. This audit preserves that state. |
| clawAgents | `4057967f-8d3e-4225-adc4-f979488a4659` | Full period review appears in the adjacent-session report. Current knowledge corrections distinguish public house-trader reads from unavailable player controls. |
| PayAI report | `b6fd7433-5b3b-4704-8361-9fa5927cf57c` | Period user requests concern report wording and transaction attribution. No regression-repair claim identified in that inventory. |

## Independent live database evidence

A SELECT-only transaction ran inside the production API container, using its existing connection. It printed no credentials, user records, or wallet identifiers.

| Check | Result |
|---|---|
| Public tables matching `sap_%`, `bounty_gas_sponsorships`, `bounty_gas_cap_policies` | Zero rows |
| Seven removed bounty columns from migration 0067 | Zero rows |
| Lobby 184 | `cancelled`, creation status `failed` |
| Lobby 187 | `cancelled`, creation status `failed` |
| Bounty status counts | 4 open, 13,647 completed, 848 cancelled, 1 expired |

Production retains `SAP_ENABLED=true`. The prior user explicitly chose to retain SAP settings. Removed code and tables, rather than this unused setting, establish removal. No setting changed during this audit.

## Findings and work assignments

| ID | Finding | Owner / verification status |
|---|---|---|
| DD-A01 | Incidental numbers or mismatched units authorize a model-selected tip. | Mocked actual bridge reproduced the defect before edits. Explicit unit-aware confirmation grammar now passes original and independent ambiguity cases. Local patch; release verification remains. |
| DD-A02 | Equal-price cart changes retain an old confirmation. | Mocked actual bridge reproduced the defect. Persisted quote identity, pre-write revocation, and complete local workflow locks now pass mutation/submit cases. Fingerprint preserves all ordered arrays. Cross-environment vendor check-to-charge gap remains documented. |
| DD-A03 | Failed address lookup can send an unanchored search to the vendor fallback city. | Address lookup now refuses discovery on failure. Operator tests pass; no live order was placed. |
| UI-01 | Nonzero bottom safe area causes Jump/Nori and Autonomous/joystick overlap. | bounty worker: formulas and inset tests in progress. |
| UI-02 | Guest Explore opens invisible Nori chat and loses controls; Escape cannot recover. | Root reproduced in production at 390×844. Nori is unconditional, but ChatPanel requires `hasAvatar`. Repair assigned. |
| CI-01 | Neither branch has protection; no rulesets exist. Deploy runs without a test dependency. | GitHub API verified. Reusable test gate before migration/deploy in progress. |
| CI-02 | New mock files bypass hardcoded isolation; several regression suites never run. | History worker: dynamic partition and coverage repair in progress. |
| CI-03 | Deployment queues branch HEAD instead of the tested SHA. | Both live Coolify signatures accept `commit`. Exact-SHA script changes in progress. |
| CI-04 | Phase 0c staging-vs-CI constraint inventory was never delivered. | Inventory and disposable replay now verified below. Same-SHA GitHub CI remains a release gate. |
| UI-03 | Baccarat Close and Fairness controls inherit pointer-events:none. | Root reproduced in production: the canvas receives the visible button hit. One-line CSS repair awaits staging browser verification. |

### September 22 independent follow-up

- CI-04: staging has 944 catalog artifacts; the initial disposable CI database has 811. Normalized comparison finds 14 relevant missing artifacts: 12 poker CHECKs, one market-deed FK, and one bounty partial unique index. Other differences concern runtime-owned or retired tables. See the independent review for accepted differences.
- Fresh replay applies 85 migrations. Both the migration log and the database tracking-table count verify 85; an earlier coordinator summary incorrectly said 84. The bounded repair restores 13 constraints, then restores zero on repeat. The catalog assertion verifies all 14 artifacts. A two-connection approval test accepts one bounty approval and rejects the other with SQLSTATE 23505. All three tests pass on PostgreSQL 15 and Bun 1.4.2.
- Separate temporary-table probes reject invalid poker seat count, rake, and source values. A valid row succeeds. The transaction rolls back.
- Production SELECT finds only the bounty-attempt primary-key index. It finds zero duplicate approved bounties among 13,652 approved attempts. Migration 0069 adds the missing partial unique index through the normal release gate. No production schema change occurred during these probes.
- Migration 0068 preserves legacy previewed and submitted rows with null fingerprints. Applying its statement twice succeeds. A new 64-character fingerprint also succeeds. The disposable compatibility transaction rolls back.
- The 18 other Drizzle CHECK declarations absent on staging remain outside this constraint repair. The independent report records responsible domains and a review deadline. They are not silently enabled in CI or production.
- The guest Nori repair exposed a separate existing agent-parity defect. The previous system-chat route accepted only human sessions. The local patch adds a shared bound-agent route and executable `chat_nori` action with owner-scoped memory and reward limits. Route tests pass 14/14; hosted action tests pass 8/8, including private-reply exclusion from public snapshots. Nori receives no executable runtime services for either subject. The independent signed Hatcher consumption check remains a separate gate.
- Local service-gate partition: 168 shared suites and 17 isolated suites pass. The shared process skips 114 database cases; the database CI lane must run them separately.
- Local production build passes all nine tasks. The local server launch is blocked by the tool's ownership validation. The managed launcher receives the same rejection. Interface verification therefore proceeds on staging after release gates pass.

### Historical migration documentation correction

The safety comments in applied migration 0067 incorrectly claim no runtime readers remained. The old ORM schema still selected the removed columns during the documented deployment outage. The migration runner enforces immutable checksums, so this audit preserves the applied SQL file. This correction supersedes those comments. Future removal requires an expand/contract release sequence that first removes all old application readers.

## Executed checks

Local runtime: Bun 1.3.14. Existing CI pins Bun 1.3.11. Live production container reports Bun 1.4.2. These are distinct environments.

- Frozen dependency install passed; no lockfile change.
- Shared, database, templates, agent-runtime, and wager-program builds passed: five tasks.
- Focused original web regressions: 168 pass, zero fail, 11 files.
- Shared constants: 119 pass, zero fail, 11 files.
- Knowledge and activity queue combined: 51 pass; room-manager import failed due to mock pollution. Room-manager alone: 60 pass, zero fail. This demonstrates why process isolation matters.
- Bounty settlement and sweeper: 36 pass, zero fail.
- Staging public agent-onboarding smoke: all 12 checks passed, including identity binding, owned skills, movement, chat, served manual, and reconnect.
- Production Chrome guest phone check: World Map opens and has a close control. Nori shortcut reproduces UI-02. No captured console errors accompany that failure.
- Latest bounded cleanup checks: API typecheck and agent-runtime build pass; DoorDash fingerprint plus independent ambiguity checks pass 35/35; Nori moderation passes 8/8; runtime-agent memory-ID collision check passes 1/1. The updated offline Hatcher harness passes 87/87 with the seventeenth action in the manual and executor. This offline result does not replace the signed staging harness.

## Remaining work

### Consolidated complaint acceptance

| Complaint | Independent result | Acceptance limit |
|---|---|---|
| Earlier land lots became empty | The earlier generator stayed intact. A later parcel expansion omitted showroom coverage. Current generation and shared tests cover all 56 parcels. | Physical world inspection remains separate from data coverage. |
| A shadow avatar follows the player after Reef Race | Activity suspension erased local identity while retaining the world session. Current lifecycle and identity tests pin the repaired behavior. | No fresh human race was played in this audit. |
| Nori body and collider disagree | A mesh move changed one of several duplicated coordinates. Current paths share `NORI_WORLD_Z`. | Current source and regression tests establish coordinate agreement. |
| Cove falls into the dark fallback | The old 40 FPS threshold conflicted with a 30 FPS phone limit and startup stalls. Current sampler tests cover the policy. | Browser automation did not establish the FPS floor. Physical-device acceptance remains open. |
| Cove exit traps the player | The old exit constant lay in an unsafe band. Current tests cover the derived exit; the production return control reaches the world without reopening Cove. | Observed guest path only. |
| Nori gives wrong bounty directions | All three knowledge surfaces name the Bounty Board. Live guest chat gives its pavilion location. The 99-check hosted probe proves real Nori execution and private next-decision consumption. | Production promotion remains pending. |
| SAP removal appears reversed | No restoration commit was found. The earlier removal intentionally retained tables. Production now has none of the removed tables or columns. | The applied migration caused an old-code/new-schema outage. Its immutable SQL remains unchanged; this report corrects its misleading comments. |
| Old wager lobbies remain open | Production rows 184 and 187 are cancelled with failed creation status. Recovery tests pass. | This is not a fresh on-chain settlement experiment. |
| DoorDash accepts unsafe confirmation or a changed cart | Independent parser, identity, and workflow tests pass; staging serves the patch. Address lookup fails closed. | Production promotion remains pending. No paid order was placed. |
| Phone controls overlap; guest Nori cannot close | Staging guest Nori answers and closes. Jump hit tests and joystick bounds pass at all eight required dimensions. | Real iPad safe-area and device FPS evidence remain open. |
| Baccarat Close and Fairness reject clicks | Staging Fairness opens and closes. Table Close returns to Cove without a wager. | Production promotion remains pending. |
| Regression gates and promised follow-up were absent | Four required checks, fourteen coupling rules, schema restoration, exact-SHA helpers, and deploy dependencies have evidence. A deliberately wrong test fails the required API checks in a disposable PR. | The latest follow-up patch requires its own green checks and staged container verification before promotion. Later CI phases retain their named owner and deadline. |
| Trading research and accounting claims lack proof | The later audit invalidates profitability claims and records unresolved execution accounting. Approved indefinite pauses supersede older restart instructions. | Owner: external runner maintainer. Review deadline: 2026-09-29. Reconcile failed-entry fees, unknown-buy expiry, and ambiguous HTTP outcomes before any separately approved resume. This cleanup does not restart traders. |

### Final local review checkpoint

- A fresh second auditor found no additional blocking source defect. Its focused run passed 71 tests, skipped two database-only tests, and failed none.
- The first full isolated API run passed 283 files and failed one stale source-location assertion in `building-reward.test.ts`. After that test followed the extracted service, all 23 cases passed. The final full rerun passed all 284 executed files, with zero failures. One database-only file and three existing nondeterministic suites remain excluded from this local runner. The adjacent-session report records their owners and review deadline.
- Final production build: nine tasks passed, zero cached. API typecheck, actionlint, and whitespace checks passed.
- Both VPS deployment helpers passed installation and hash checks. The push then failed for missing GitHub workflow permission. The coordinator restored both pre-audit helpers and verified byte equality, because the unchanged remote workflows still call them without SHA arguments. Install the reviewed helpers again immediately before the authorized staging push. No deployment started.
- The staging test signer was configured for the signed harness, then removed when GitHub credentials blocked the push. The Coolify model readback reports zero signer settings. No container deployment occurred, and production never received this setting. The live harness remains pending.

Both independent source reviews found no remaining blocker in this patch. Same-SHA GitHub gates, staging harness, runtime probe, branch-protection proof, deployed-container verification, and browser acceptance remain open. No production repair claim follows from local checks.

The earlier Phase 1 coupling registry was an unimplemented follow-on, not a reverted implementation. The coordinator authorized its separate implementation after local cleanup commit `cbb647ad`. All fourteen rule files now exist locally with current paths and ownership. Independent registry probes verify fourteen missing-target failures, fourteen changed-target passes, seven current-path failures, the shared-orientation alternative, and the generated index. The adjacent-session report records each rule and scope. The separate adversarial parser/Git/workflow review approves the local change after21 tests pass with104 assertions. Release and remote required-check proof remain blocked by GitHub credentials. This does not claim that the entire multi-phase CI plan is implemented. Later asset/static/CODEOWNERS phases remain owned by CI/domain maintainers, with review deadline 2026-09-29.

The production Cove return control navigated to `/game` during this audit. The visible sonar reported `11264, 12564`, and no Cove prompt reopened. This verifies the observed guest return path only; it does not establish the target FPS or real-device Safari behavior.

### GitHub credential blocker, 05:58 UTC

Commit `cbb647ad1a5a7c9b9e1a301c9f1b2ea2ec43fde6` is local. The HTTPS push rejects workflow updates because the GitHub CLI token has only `gist, read:org, repo` scopes. The configured SSH key authenticates as the read-only `ItachiDevv/itachi-memory` deploy key. A separate SSH identity does not authenticate. Git Credential Manager has no stored GitHub credential. The peer laptop's GitHub CLI token is invalid. The coordinator requested `gh auth refresh -h github.com -s workflow` on itachi222.

At 05:58 UTC, production health remains `ok` at `6f115fc2`; staging remains `ok` at `10575a98`. No application, migration, trader, or branch-protection change occurred. The temporary test signer is removed, the old deployment helpers are restored, and both disposable audit database containers are removed. The reviewed patches remain available locally for release after credential renewal.

### Release continuation after credential renewal

Final source checkpoint for protocol 69: appearance now uses one shared human/agent service, strict bound-agent identity, an UPDATE-time config merge, and a same-avatar mutex through live projection. Both the universal tool and eighteenth hosted action expose it. The public onboarding smoke adds an actual agent-session HTTP PATCH and signed presence teardown; the hosted probe checks the real action and durable/live body color. A fresh reviewer passes 48 tests with 520 assertions, skips one PostgreSQL-only case, and reports no source blocker. Separate PostgreSQL legacy-red/helper-green evidence remains recorded. Final driver evidence is 61 passing tests with 369 assertions. The final production build passes all nine tasks; API typecheck and offline Hatcher selftest (87 checks) pass. Exact protocol-69 staging acceptance remains pending before promotion.

Latest hosted acceptance, 2026-09-23: all 99 live checks pass after the probe fixture uses `tx.json` for JSON objects. A read-only synthetic query proves raw postgres.js double-encoded the previous stringified configuration, while the production Drizzle adapter preserves JSON objects correctly. The passing run proves actual Nori action execution, a sanitized avatar-owned lesson, private next-decision consumption, all 17 verbs, exactly one chat reward, zero trades, and clean fixture/server teardown. The earlier failures remain recorded below as unsuccessful attempts. Separate source review identified an appearance config overwrite race and directive read/pending races; their narrow regressions and repairs precede the final staged release.

Continuation at 2026-09-23 03:18 UTC: production and staging health still report their prior commits. The latest diagnostic run passes the halt transition, but records one queued Nori question and zero emitted Nori actions. Its fixture has a valid bound session and active avatar; no Nori reward or room memory exists. This narrows that run to action delivery rather than establishing a service rejection. The signed-disconnect teardown passes independent review (six tests, 36 assertions) and checks both public session and body absence before durable deletion. Two older orphan bot rows pass exact ownership guards and are removed in one transaction; the subsequent count is zero. Independent public checks find both old exact agent/body IDs absent. The staging signer configuration and local disposable key are removed; the existing API container still requires its next rollout to lose the old environment setting.

Live staging verification: both containers and public health serve `59dba1cf`. Public onboarding passes 12/12; the signed partner harness passes 14/14 and deletes its registered agent. Browser checks confirm guest Nori answers the Bounty Board question with the pavilion location and says Pearl does not hold bounties. The panel closes. NPC-mode Jump remains 64 by 64 pixels and receives center hit tests at all eight required phone/tablet dimensions; both joystick zones remain within the viewport. Nori input remains within each viewport. Baccarat Fairness opens and closes, and table Close reaches `/cove`, without a wager. Real Safari safe areas and physical-device FPS remain unverified.

The live hosted probe first fails after its halt transition. An independently reviewed capture-buffer correction passes four tests with 23 assertions. The rerun passes the halt transition and then fails because no fixture-owned Nori lesson appears. This remains a release blocker. Browser evidence also shows retained probe avatars after database cleanup; the probe omitted the internal session/body lifecycle. The team investigates both defects without changing fleet halts or trade authority.

Credential renewal verified at 06:35 UTC. Staging received `732c7342`; draft promotion PR is #296. Run `35695565960` passed coupling contracts, API invariants, and PostgreSQL route checks. The web lane failed on delayed DOM access after test teardown. Both migration and deployment were skipped by the dependency chain. This proves the new failure gate blocks live changes. The author and a separate reviewer now repair the fixture/process lifecycle; no check is bypassed.

The corrected commit `59dba1cf` passes all four jobs in PR run `35696068784` and staging run `35696065632`. The latter applies migrations 0068 and 0069 and queues both apps for that exact SHA. A staging read-only transaction verifies 85 migration records, the nullable fingerprint column, and the valid partial bounty index. The old API remains healthy before the container flip, which verifies additive compatibility for its health path.

Master protection now requires all four named checks from GitHub Actions app 15368, with strict branch freshness. Force pushes and branch deletion are disabled. The planned administrator exception remains enabled (`enforce_admins=false`); this does not claim a universal direct-push ban. A deliberately wrong test pin (69 instead of 68) in draft PR #297 fails both required API checks in run `35695998122`. Web and coupling checks pass. The PR closes without merge, and the remote scratch branch is absent. The PR also reports `BEHIND`, so the test failure is not claimed as its sole merge restriction.

PR #296 exposes one missing back-merge: the prior production promotion merge `6f115fc2` is not yet an ancestor of staging. After the current build finishes, merge that commit back, prove the application and migration trees unchanged, and run exact-head Gates. A reviewed manual queue can then deploy that exact SHA after the idempotent migration check. Do not overlap or supersede the active build.

1. Fetch both remote branches. Preserve other work and resolve any new staging changes before release.
2. Reinstall the reviewed full-SHA deployment helpers on both hosts. Verify their hashes. The current host copies intentionally remain the old versions while remote workflows remain old.
3. Create a new temporary signer for the staging Hatcher harness. Set it through the staging Coolify model only. Never set it on production.
4. Push the reviewed commit to staging. Require all reusable Gates jobs before migration and deployment. Confirm both container SHAs and `/health`; verify migrations 0068 and 0069 and the approval index.
5. Run public onboarding, the signed identity-bound Hatcher client, and the hosted runtime probe with autonomous-decision evidence. Preserve the fleet halt. The probe must show a private Nori reply on the next decision and no trade from its fixture.
6. Verify guest Nori, Baccarat controls, and touch layouts in both orientations on staging. Record console errors and observed performance honestly. Real Safari remains a founder device check.
7. Remove the staging signer and test identity. Remove the local test key. Redeploy the same API SHA and verify no test signer remains in that container.
8. Configure and read back the four master checks: `coupling documentation contracts`, `web Trading Floor tests`, `api money/cove/poker invariant tests`, and `api route tests (Postgres-backed)`. Preserve the planned admin exception explicitly. Prove a deliberately incorrect protocol pin fails a disposable draft PR before removing that test branch.
9. Promote staging through a PR to master. Verify production container SHAs, health, schema, served manual, and browser behavior. Update deployment evidence and founder review notes in the same release sequence.

No step authorizes a paid DoorDash order, a swap, a trader restart, removal of a fleet halt, or changes to retained SAP settings.
