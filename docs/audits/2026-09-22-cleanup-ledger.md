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

### Final local review checkpoint

- A fresh second auditor found no additional blocking source defect. Its focused run passed 71 tests, skipped two database-only tests, and failed none.
- The full isolated API run passed 283 files and failed one stale source-location assertion in `building-reward.test.ts`. After that test followed the extracted service, all 23 cases passed. One database-only file and three existing nondeterministic suites remain excluded from this local runner. The adjacent-session report records their owners and review deadline.
- Final production build: nine tasks passed, zero cached. API typecheck, actionlint, and whitespace checks passed.
- Both VPS deployment helpers now match the reviewed local files and require a full commit SHA. Each host retains a pre-audit backup. No deployment had started at this checkpoint.
- The staging test signer is configured for the signed harness. It is not configured on production. Release verification must remove this staging setting and its local test key after the harness, then confirm the replacement API container has no test signer.

Both independent source reviews found no remaining blocker in this patch. Same-SHA GitHub gates, staging harness, runtime probe, branch-protection proof, deployed-container verification, and browser acceptance remain open. No production repair claim follows from local checks.

The earlier Phase 1 coupling registry is an unimplemented follow-on, not a reverted implementation. The prior session explicitly described it as the next task after Phase 0c. This audit does not claim that the entire multi-phase CI plan is implemented. Owner: CI/domain maintainers. Review deadline: 2026-09-29. Condition: reconcile the fourteen proposed coupling rules with current protected paths, then implement and mutation-test the registry as a separate change.

The production Cove return control navigated to `/game` during this audit. The visible sonar reported `11264, 12564`, and no Cove prompt reopened. This verifies the observed guest return path only; it does not establish the target FPS or real-device Safari behavior.
