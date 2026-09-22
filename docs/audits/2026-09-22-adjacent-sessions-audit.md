# Adjacent Claude session audit — September 22, 2026

Last Audited: 2026-09-22. Team: `dd-bounty-cleanup-20260922`.
Baseline: `10575a98`. Evidence host: **itachi222**.

## Scope and evidence limits

This report covers the six adjacent sessions assigned by the audit coordinator.
The main period is September 16–20. Earlier precursors establish the requested behavior.
Later messages establish final scope or superseding evidence; they do not prove earlier correctness.

The audit parsed every available parent and nested subagent JSONL record in this set.
It then traced substantive requests, complaints, review findings, commits, and current source.
Tool results, teammate messages, skill text, and compacted summaries are not treated as human requests.
Pasted human messages and explicit answers inside tool results require separate classification.

| Session | Full session UUID | Parent records | Nested logs / records |
|---|---|---:|---:|
| clawPump | `e7625636-22c9-413c-8ef9-ca3827d30203` | 27,272 | 16 / 6,556 |
| clawAgents | `4057967f-8d3e-4225-adc4-f979488a4659` | 8,323 | 21 / 15,494 |
| mobile | `1803b128-c813-43ed-86be-998f3603d4b6` | 1,840 | 9 / 760 |
| fixBounty | `924028d1-dfd1-42a1-b11b-51656fc07b14` | 1,197 | 0 |
| bounty precursor | `201f3253-9acd-4620-81f2-6e280d7bb5f1` | 1,667 | 0 |
| PayAI report | `b6fd7433-5b3b-4704-8361-9fa5927cf57c` | 474 | 0 |

Total: **63,583 records**, including 46 nested logs.
Parent log paths are `C:\Users\itachi\.claude\projects\C--Users-itachi-Documents-Crypto-ClawVille\<UUID>.jsonl` on itachi222.
Nested logs are under `<UUID>\subagents\`.
Log anchors below identify physical parent-file lines unless explicitly qualified.
Raw transcripts remain outside the repository because they contain credentials and private operational information.

### Discovery completeness

The audit enumerated all16 top-level JSONL files in that project folder, totaling366.3 MB.
Selection used a top-level record timestamp from September16 00:00Z through September21 00:00Z, exclusive at the end.
Exactly7 sessions match: dd, bountyFix2, clawPump, clawAgents, mobile, fixBounty, and the PayAI report.
The two named sessions have separate audit reports. This report covers the other5 and the earlier bounty precursor.
Mobile has only6 in-period records; its substantive implementation history predates the main period and was inspected too.
This is completeness for logs available in this folder on itachi222, not a claim about unavailable or deleted logs on other hosts.

| Other available technical session | UUID | Exclusion |
|---|---|---|
| lnd | `16a81303-948b-40ff-a120-e805f417d23f` | Last record September14 |
| logoLink | `6b563a68-9d2b-4742-a217-0de743b2a0b5` | Last record August26 |
| pokPlus | `875d8dcd-f94f-4037-a02a-c843220ad4cd` | Last record August20 |
| oobe | `996dc187-0e97-49b0-9a80-0a17e7d1964e` | Last record September14 |
| prf | `99a9c2a9-a223-4806-a57e-ab33d2a71fc1` | Last record September14 |
| uos | `eb8b05ac-e76c-4fb9-997b-ed98dce004ae` | Last record August26 |
| vclaw tester | `ec503319-6637-4f44-9062-d2b44883c87b` | Last record August21 |
| Later runner audit | `771d8821-4f60-4f13-86cf-ec2d82945521` | Starts September21 06:39Z; later durable audit evidence reviewed separately |

The remaining earlier file is the bounty precursor already included above.

Local tests establish the inspected source behavior, not current production state.
This audit did not execute a swap, alter a trader, retrieve credentials, or restart a runner.
It did not reproduce live mobile FPS or financial database results.

## Complaint and acceptance matrix

`Verified source` means current source and local evidence support the stated behavior.
`Historical evidence` means the session recorded it; this audit did not repeat the external operation.
`Open` means the requested acceptance evidence remains absent or a defect persists.

| ID | Request or complaint; log anchors | Disposition and current evidence |
|---|---|---|
| A01 | Build Trading Floor with real guardrails and distinct trader objectives. clawPump:369,452,2459. | Verified source: wallet proof, verifier, guarded execution, public tape and scoring remain. Main sequence: `4f8d556d`, `6fae0cf4`, `26a0b2b8`, `fc42e37e`. Later decisions supersede the initial five-house-trader proposal. |
| A02 | Provision one low-funded staging trader first; explain objective briefs. clawPump:6086. | Historical evidence: `7a0f63d2` adds one-objective provisioning. `3baaf819` records the first staging trade. No new funding or provisioning occurred here. |
| A03 | Stop repeated `RPC is not configured` alerts. clawPump:6253. | Verified source: `1b714eef` centralizes RPC resolution in `services/trading-rpc.ts`. Current resolver and sweeper consume the same configuration. Live alert silence was not re-proved. |
| A04 | Funded test trader cannot execute or record its first trade. clawPump first-rung sequence, commits below. | Verified source: USDC authority pins (`0b30fb7e`/`706b6484`), additive Jupiter response fields (`cc52279c`/`167eff50`), raw JSON transaction fetch (`0579a586`/`e625e866`). Mint, Jupiter, and observer tests pass locally. |
| A05 | The agent must be Genesis on ClawPump, not an unrelated custodial fleet wallet. clawPump:6518,6539,8361. | Verified source: observe-only ClawPump pairing remains in `1dd47e24`; house slots resolve actual ClawPump links. Ordinary external ClawPump users still lack a message-signing ownership proof. That limit is documented. |
| A06 | Repeated drawdown alarms after retiring the test fleet wallet. clawPump:9002. | Source history: `3827451b` excludes retired links, disarms retirement, and deduplicates breach causes. `trading-links.ts:74` retains the retirement invariant. This audit does not claim current trader risk state from that old fix. |
| A07 | Enterprise API access, AI credits, and agent rules were confused. clawPump:8699,8734,9381,9422,10066,10136. | Historical evidence: API tier and inference credit are separate. Assistant:10774 admits the system-prompt field was ignored and a dollar amount became SOL units. Persona instructions corrected the recorded test. Current docs preserve those distinctions; live provider configuration was not rechecked. |
| A08 | Recurring database timeouts require an explanation and handoff. clawPump:9518,9607. | Historical incident and handoff are evidence, not a current health guarantee. The main regression audit owns deployment/runtime verification. |
| A09 | Use faster execution, wider discovery, research existing datasets, and explain missing tokens. clawPump:10777,10799,10860,12979,13869,14741,17665. | External runner scope. Durable source and decisions exist in `runner-data` on itachi222. Later audit finds significant research and execution limitations; see the separate operational section. This is not closed by repository tests. |
| A10 | Keep distinct entry strategies; do not converge both agents. clawPump:17473,19957,19961,19998. | Confirmed historical regression: assistant reported identical strategies after the earlier request for distinct entries. Later split restored momentum/dip lanes. Current lineup and knowledge describe separate lanes. Later containment evidence retains 15%/20% trails. Current live parameters were not read here. |
| A11 | Keep lifetime loss records, but remove lifetime entry blocking; separate risk counters from history. clawPump:23101,23497,24061. | Durable ledger rows 33–36 record lifetime-gate removal and derived daily drawdown. Historical counters remain records. Later audit explicitly identifies residual execution accounting gaps. No counter or risk reset occurred here. |
| A12 | Risk pauses must appear on the board. clawAgents:5943. | Verified source: `d3900dcf` through `6f334af2`; `house-trader-status.ts`, route merge, client expiry, and shared `house-trader-risk.ts`. API and web tests exercise pause/fault distinction, stale reports, timestamps, and sanitization. |
| A13 | Trading agent work must use ClawPump; purge unrelated cv-agents assumptions. clawAgents:456. | The user rejected the first research artifact. Current five templates and house lineup use ClawPump. The wrong artifact is historical evidence of context contamination, not evidence that current code imports cv-agents. |
| A14 | Build the referenced 3D building, then add walls, stock-floor board, desks and seats. clawAgents:2011,3090,3130. | Verified source: `3b728d4f` replaces the Downtown Building presentation while preserving `cron-automation`. Interior assets, collisions, desks, seats, monitor and exit tests remain. Prior screenshots and current local geometry tests do not substitute for a fresh GPU/device check. |
| A15 | Show live house-trader P&L, including losses. clawAgents:4489,4555,5838. | Verified source: `house-traders.ts:283` computes full-history FIFO using integer micro-dollars. It discloses excluded legs and no-exit losses. Tests cover partial sells, poisoned dates/notionals, conservation, and truncation. Recorded staging reconciliation at :5838 is historical. |
| A16 | Show trades as objects in the 3D room; focus on visuals. clawAgents:7451. | Verified source: `387b27f0`, `f29ee021`, `6a48d554`, `fc111613`. Trade slabs carry trader, side, money, and sell realization. Tests cover geometry, lifetime, color semantics, atlas bounds, and client normalization. |
| A17 | Stop excess review traffic; use Codex for implementation and review. clawAgents:4874,6847,7741. | Historical process failure confirmed. Assistant:4888 admits excess agent cross-messaging. Later commits record Codex implementation and review. This audit uses bounded parallel ownership and exact source evidence. |
| A18 | Pause after the team reports. clawAgents:2791. | Subsequent prose records a pause and frozen tree. Later work follows subsequent user direction. A peer message is not treated as new user authorization. |
| A19 | Player trading and trader launch are Coming soon; house monitoring remains separate. clawAgents:8129,8168, after the main audit period. | `10575a98` implements the UI boundary. Existing authenticated bind/report APIs remain. `/trade` still needs a provisioned, armed account. Knowledge drift remained at baseline: Nori advertised immediate copying. This cleanup corrects Nori, orientation and the manual under protocol 68, with a boundary test. |
| A20 | Improve older-phone performance and finish interrupted wave 2. mobile:13,132,741,905. | Verified source: phone texture cap 512, tablet 1024, desktop uncapped; cap occurs before upload and retains texture identity. `sw.js:86` stays v13 with 13 deferred avatar files. Four local behavioral probes pass. |
| A21 | Record founder review and promote mobile changes. mobile:1632,1763. | Historical production check at :1815 reports 147.8 MB and no uncompressed phone textures above 512. Current `FOUNDER-REVIEW.md:637` still requests a physical-phone verdict. This audit does not claim that verdict. |
| A22 | Replace ambiguous bounty payout alert loops with automatic recovery and documentation. precursor:13,650,963. | Verified source: recurring `x402-auto-reconcile.ts:150`, startup hooks in `index.ts:864,1746`, advisory lock, resumable capture, persisted verdicts, quiet-tick suppression and delayed manual alerts. Focused tests pass; external settlement correctness still requires database/chain evidence. |
| A23 | Make all route tests run in CI and prove the lane detects a bad protocol pin. fixBounty:16; precursor:1274,1300,1641. | Phase0b historical green/red evidence exists: runs 35059946527 and 35059722536. The lane and schema bootstrap remain. This is not proof that branch protection or constraint parity was delivered. |
| A24 | Do not wait a week; perform constraint inventory, required checks and coupling runner now. fixBounty:1045. | **Open at baseline.** Assistant:1050 promised immediate execution, but :1188 delivered another kickoff. `.claude/plans/gates-phase0c-sweep-and-flip.md` says NOT STARTED. The coordinator's CI cleanup and empirical inventory own this acceptance gap. |
| A25 | Give PayAI concise, precise volume/use-case/rail claims; verify devnet bug story. PayAI:15,186,353,373,381,389,409,440,464. | Final prose exists at :466. Historical devnet fee-payer correction is traceable to `cab4c477`. Current PayAI code uses the supported/verify/settle flow. The old 19,000+ and 88%/12% figures are not refreshed figures; no current external marketing claim is made here. |

## What caused regressions or created credible risk

1. **Review occurred while the tree changed.** The clawAgents auditor documents a global-limit query before a concurrent window-function correction.
   The later claim that the auditor read stale code does not invalidate its original observation.
   Nested `agent-atpl-impl-b2a4a3bd687cf80d:1160–1184` and parent review prose distinguish frozen commits from mutable files.
2. **Windows text rewrites created whole-file diffs.** The author first blamed Git configuration, then reproduced Python newline translation.
   Nested agent line1182 names the writer and three additional affected files.
   `372a3b15` normalizes those files. This explains noisy diffs, not semantic loss by itself.
3. **Manual version conflicts required a real merge.** The v64/v65 rebase needed both Nori/bounty additions and house-trader additions.
   The historical deletion audit found 546 raw deleted lines but only17 substantive deletions after CRLF normalization.
   Those17 belonged to the intended change. Current Nori still describes the bounty board at the pavilion.
   Evidence supports preservation in this rebase; it does not support blaming it for every regression.
4. **Hotfix and staging histories diverged.** `1e34f075` merges master into staging before promotion.
   The main provenance report analyzes the broader overwrite and stale-document incidents.
5. **Review fixes introduced new defects.** `e4ea850e` omitted `HouseTraderStatusResponse`; parent:7189 reports the compile failure.
   Parent:7239 admits the float-cent correction still reproduced the comparison bug.
   `6f334af2` adds the type import and integer-cent arithmetic. Current tests pass those cases.
6. **A real client omission survived an API feature.** `6a48d554` added per-trade realized results, then `fc111613` carried them through normalization.
   Without the second change, the 3D chip could not use the API result.
7. **Knowledge missed the final UI restriction.** `10575a98` disabled controls without updating installed agent knowledge.
   Protocol68 corrects this factual boundary without changing route availability or trader state.
8. **Promised execution became another handoff.** Phase0c was explicitly requested without a calendar delay, but its session stopped at planning.
   Green Phase0b tests cannot close that separate commitment.

## External runner: separate operational acceptance

The durable handoff is `C:\Users\itachi\Documents\Crypto\handoffs\clawAgents-handoff-2026-09-19.md` on itachi222.
It assigns the runner to clawPump and the building/user surface to clawAgents.
Local runner artifacts reside at `C:\Users\itachi\Documents\Crypto\runner-data` on itachi222.
Their recorded trading host is the staging server. Local files are evidence copies, not proof of current server state.

The later `audit-20260921/AUDIT_SUMMARY.md` and `session_history.md` contain a separate independent investigation.
They identify paper/live mixing, ideal trigger fills, insertion-order halves, short-path exclusions, and unsupported validation claims.
`session_history.md` supplies exact human-answer anchors that ordinary text-message extraction misses.
The same report distinguishes actual losses from hypothetical backtest returns.
These later findings prevent acceptance of the earlier claim that the research proved profitable parameters.

The later `audit-20260921/INSTALL_REPORT.md:9–20,40–63` supersedes earlier runner restart instructions.
It records separate founder approval for containment and indefinite pauses for both agents.
It records independent post-install verification on September22 and explicitly leaves further execution gaps.
Those gaps include failed-entry fee accounting, unknown-buy expiry, and ambiguous HTTP failure classification.
Unknown sales require transaction and wallet reconciliation before releasing their durable hold.
This audit neither repeats those operations nor adopts their historical authorization.

## Current local checks

Commands ran on itachi222 in `cv-dd-audit`, using Bun1.3.14.
CI pins a different Bun release, so these are local results, not CI replacements.

| Check | Result |
|---|---|
| Trading Floor web hooks, components, room, board, trade tape and touch-layout batch | 586 pass / 0 fail |
| House realization/status/discriminator plus route/source invariants | 110 pass / 0 fail |
| Auto reconcile, reconciliation apply, bounty sweeper, mint admission, observer | 45 pass / 13 database-dependent skips / 0 fail |
| Jupiter fixture and auto-reconcile batch | 17 pass / 0 fail;7 overlap the preceding batch |
| Mobile texture probe: aspect, object/render flags, compressed skip, render-target skip, failure preservation | Four grouped behavioral checks pass; no GPU |
| Shared and agent-template TypeScript builds after knowledge correction | Both exit0 |
| Protocol/pin route and service batch after knowledge correction | 111 pass / 0 fail |
| Onboarding tests after Nori REST/action discovery and availability assertions | 9 pass / 0 fail |
| Offline Hatcher selftest at protocol68, before the subsequent Nori action implementation | 87 pass / 0 fail / 0 skip; superseded for final release by the required new-action rerun |

The new boundary test initially failed because the first edit reached `DECISION_SCOPE` instead of full orientation knowledge.
The correction moved the text to `CLAWVILLE_ORIENTATION_KNOWLEDGE` and retained the small decision menu.
The successful rerun proves the full orientation and Nori consume the availability correction.
That correction adds no per-decision endpoint list or new action.

### Subsequent Nori parity correction in the same cleanup

The dd auditor separately identifies an existing agent-auth gap on Nori chat.
The coordinator assigns its route/service/executor correction to that auditor.
This report's author owns the matching manual, orientation, version, and documentation edits.
Protocol68 now also documents `clawville_chat_nori`, the shared authenticated Nori route, and the17th executor action, `chat_nori(message)`.
The new action enters the compact decision menu because hosted agents can execute it.
Its reply enters runtime memory and next-decision context, never recursive action dispatch.
The new manual test checks REST/tool/action discovery, identity limits, cooldown, and the installed version/hash pointer.
It does not substitute for route, reward, executor, gateway, or staging tests owned by the other reviewers.

The partner source reference now exists at `.hatcher-ref/`, commit `18d20987efeffbfa8c25ac7a41e9c127719a5abe`.
The public frontend's extensible protocol pointer and registration methods remain compatible with the updated manual pointer.
The clone has no `CONTRACT.md`; the spec records the exact source comparison and remaining live harness requirement.

## Remaining release evidence

The parent audit owns the final combined build, independent review, staging promotion, and live browser checks.
Protocol68 requires the staging onboarding smoke, hosted runtime probe, and signed mock-Hatcher harness.
The hosted probe must run beside the staging API because its gateway fixtures use loopback ports.
Run `bun run apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api <staging-api> --with-echo --autonomous-decision` there.
Use the existing staging-only signer procedure in `apps/api/scripts/hatcher/run-mock-e2e.md`, then remove that signer and verify cleanup.
Do not print private keys or reuse the offline selftest's generated keys as partner credentials.

PARITY: human path: Nori and game controls; agent path: protocol68 and shared orientation; settlement retains the existing avatar resolution.

## Independent second review: CI, schema and deployment repair

Reviewer: adjacent_sessions. This review follows the separate reconciler's schema changes.
It performs no live operation and makes no schema/code edits.

The review finds no blocker in the bounded restoration, new approval index, or workflow dependency chain.
It detected a summary-count error: the local directory contains85 SQL migrations, while the coordinator's first report said84 applied.
There are83 tracked baseline SQL files plus0068 and0069. The coordinator checked the replay log and migration table: both confirm85.
The earlier84 count describes the prior replay with0068 only. The final replay includes0069; no file was omitted.

### Schema boundary and invariant coverage

`ci-restore-schema-invariants.ts:23` requires CI=true, no CLAWVILLE_ENV, localhost/loopback, and database `clawville_test`.
The executable entry checks this guard before creating the database client.
An independent no-network probe accepts the valid target and rejects remote host, wrong database, deployment environment, and CI=false.
The driver also ignores attempted host/database overrides in URL query parameters during a no-connection options probe.

The restoration selects only the explicit expected list, not every Drizzle declaration.
That list contains12 poker CHECKs, one marketplace listing foreign key, and one bounty approval index.
The restoration restores only the13 constraints; the schema declaration and new migration supply the index.
It rejects parameterized CHECK SQL, quotes identifiers, validates retained constraints, and compares foreign-key columns, target schema, and update/delete actions.
The catalog test compares actual PostgreSQL definitions and validity, rather than source text alone.
Its14-definition check catches a same-name CHECK with the wrong predicate after restoration.

The concurrent approval test uses a pool capped at2 connections and submits both updates together.
It requires exactly one successful update, SQLSTATE23505 for the other, and one approved/one submitted row afterward.
It cleans its isolated fixtures through the test user and executes no ledger or payout operation.
This reviewer ran the local guard test:1 pass,2 DB tests skipped because no test database URL was supplied.
The coordinator owns the separate PostgreSQL replay and concurrency execution evidence.

Migration0069 adds the partial unique index without deleting or reclassifying attempts.
Existing duplicates cause index creation to fail, which stops the migration-dependent deploy.
The coordinator's production read reports no equivalent index and zero duplicate approved bounties; this reviewer did not repeat that live query.
The Drizzle predicate matches the migration and the explicit catalog definition.

The applied0067 bytes remain identical to HEAD after LF normalization.
SHA256: `1de620b51eb84d65088b351fa5181fb4da6ecdaea60a052617f7b4b700677566`.
The unchanged migration runner checks all recorded checksums before applying pending files.
The correction to0067's inaccurate safety comments therefore belongs in the audit documentation, as implemented, not in its frozen SQL.

### Workflow and exact-commit deployment

Actionlint1.7.12 exits0 on all3 workflow files.
An independent YAML parse confirms both chains: reusable Gates → migrate → deploy.
The migration skip marker does not skip Gates. Neither dependent job overrides failure with `always()`.
The local reusable workflow resolves from its caller commit, and checkout uses that event commit.
Both SSH calls pass the same full `github.sha` into a host helper with an explicit version marker.
Each helper rejects any input except one40-character hexadecimal SHA and passes it into Coolify's named `commit` argument.
This review does not claim that the revised host scripts are already installed or that a new deployment ran.

Required check names remain stable: `web Trading Floor tests`, `api money/cove/poker invariant tests`, and `api route tests (Postgres-backed)`.
The PR trigger has no path filter, so documentation-only PRs can emit those checks.
The reusable concurrency group includes caller workflow and ref, separating deployment callers from ordinary Gates runs.
Automatic source discovery separates each direct `mock.module` test into its own process.
Runtime tests each run in a separate process; guest Nori DOM tests also have a separate process.
Branch protection and manual deployment access remain separate controls; workflow source does not prove their live state.

## Independent Nori consumption review and probe additions

The first implementation reached the hosted driver's latest lesson, but it did not reach partner cognition.
Some Hatcher clients have no `userAgents` driver entry. A browser chat bubble cannot satisfy consumption.
The review reported this gap before release. The implementation now uses a private, bounded per-client observation.
`agent-substrate-client.ts` adds it to the existing user turn and `clawville.playerMessage`, which remain identical.
It adds no system role, public world-state field, or public reply bubble. A fresh client has no prior observation.
`hatcher-nori-consumption.test.ts` passes1/0 with16 assertions against actual signed outbound bytes.
It checks real ephemeral ed25519 verification, redirect refusal, private/public separation, fresh-client isolation, action stripping, and the2000-character bound.
No production key, DNS request, partner request, or database is used by this test.

The local hosted path retains the actual parser → shared service → own lesson → next decision prompt sequence.
The earned-memory UUID seed now includes the runtime agent ID. Existing rows remain readable; no history is rewritten.
Nori receives no executable services for either human or agent turns. Explicit chat rewards have separate identity fences.
The current offline Hatcher selftest reports87PASS/0FAIL/0SKIP after the17th action update, superseding the earlier pre-action run.

The hosted release probe now preserves existing fleet halts. It changes only its own disposable agent halt.
It checks the remaining halt state instead of requiring an operator to clear a deployment-wide halt.
Its gateway emits one real Nori action, then checks the next actual outbound decision against the fixture's recorded Nori lesson.
It verifies sanitized text, the full action menu, a disarmed/killed fixture, one chat credit, and zero trading decisions.
Cleanup includes the fixture's Nori conversation room memories, avatar keyword memories, and a ledger-cascade postcondition.
Focused probe tests pass2/0 with12 assertions. API typecheck exits0. Live inference and staging acceptance remain the coordinator's release checks.

## Current classification of seven historical file quarantines

All seven files ran independently with `DATABASE_URL=''` and a30-second per-test timeout.
Four stale exclusions are removed after repeat passes:

| File | Current result | Change |
|---|---|---|
| partner-hatcher-p5-handler.test.ts |4pass/0fail twice|Remove stale createdAt quarantine; no route change.|
| activity-room-manager.test.ts |60pass/0fail twice|Remove stale whole-file quarantine.|
| reef-race-spline.test.ts |55pass/0fail twice|Remove stale physics quarantine; assertions unchanged.|
| reef-race-bot-winrate.test.ts |Initially1pass/10fail; then11pass/0fail twice|Repair missing transaction PB-claim SELECT in the telemetry fixture, then remove quarantine.|

The winrate failure was deterministic fixture drift, not a measured bot winrate failure.
The repaired mock explicitly returns no PB claims for fixtures without lap claims and checks the projection and limit.
Production scoring, race algorithms, payout logic, and all existing telemetry assertions remain unchanged.

Three exclusions remain: bumper-shells-bot8pass; reef-race-bot21pass/1existing skip; spline-sim-integration1pass on this run.
One passing run does not resolve their unseeded statistics or timing dependence. They are not counted as confirmed current product failures.
Tracked owner: **activities-arena**. Review deadline: **2026-09-29**.
Graduation condition: reproduce historical flakes or supply seeded/controlled-clock tests that preserve the behavioral assertions, then remove each exclusion.
The existing reef-race-bot V2-T4 skip also requires that owner's explicit disposition.

## Phase0c versus the Phase1 follow-on

The actual founder messages in fixBounty are:999 (what follows) and:1045 (reject the week wait; implement everything).
The final assistant message:1188 hands off Phase0c tasksA/B and says taskC is to **start** Phase1 afterward.
TaskC names the coupling runner and `.claude/gates/` registry. The session does not claim that either was delivered.
Thus Phase0c's constraint/protection acceptance is distinct from the unimplemented Phase1 follow-on.
Owner: **agent-protocol-partner / CI owner**. Review deadline: **2026-09-29**.
Required disposition: inventory the Phase1 registry and runner against the plan before claiming that broader gates program is implemented.
