# BrainChain Office: cloud continuation handoff

Prepared on 2026-11-09 from itachi222. This is a continuation of the ClawVille partnership integration.
Session clarification: this conversation already runs in a cloud session. Its tools access the desktop filesystem on itachi222.
The session environment and the filesystem host are different concepts. Do not infer that another session or source transfer is required.
The full integration is unfinished. No staging deployment, production release, paid provider call, or mainnet transaction occurred.
Use this document for current state. Older handoffs contain chronological statements that later sections supersede.

## 1. Scope and the GitHub clarification

The partner is Mizuki Hayashi, the BrainChain developer. The project is https://usebrainchain.com/.
The requested product is a BrainChain Office inside ClawVille, with a teacher, useful human controls, and equivalent connected/hosted agent operations.
Agents learn the skill, perform external paid tasks, track income, and use verified work history where Priors supports it.
The scope also includes task purchases, funding, cash-out, failure recovery, an optimized building, and release verification.
The founder authorized implementation after the research and goal prompt. Preserve that full objective.

A standing GitHub identity rule applies to pushes and pull requests.
That is a release authentication rule. It must not stop independent implementation, analysis, tests, or this handoff.
Desktop GitHub CLI authenticated as ItachiDevv. No alternate authentication was established.
Verify the approved identity before GitHub writes. If the founder changes that rule, use the new explicit instruction.

## 2. Existing source access and optional transfer

Repository origin: https://github.com/ItachiDevv/ClawVille.git.
Local branch: docs/brainchain-plan. Local worktree: C:/Users/itachi/Documents/Crypto/ClawVille/.worktrees/brainchain-plan.
The application commit is c025c733a0ca204ab4ad88a6f40bb8e3de262467.
The pre-handoff documentation commit is 75abfaf25ea9e6658b99c29b54afb51b1b6c388b.
Inspect this registered worktree first. This session already has access to it; no upload or import is required here.
Continue in the existing worktree when it remains accessible. Do not create a second worktree merely because the session is cloud-hosted.
No branch push occurred. A separate checkout without desktop access may therefore lack the integration.
The optional transfer manifest identifies its packaged source commit. Git HEAD is authoritative for the accessible worktree.

### Optional fallback for a different environment without the source

Use the following transfer procedure only after confirming that the existing worktree is inaccessible.
The transfer package is a portability aid, not a prerequisite for this session.

The transfer package contains an incremental Git bundle, these two documents, a CI summary, and a manifest.
The bundle requires this existing staging ancestor:

```text
9fd879bea60b7aec99f1c9d90a83853515d2663f
```

Import into an authorized ClawVille clone. Use an absolute path for the uploaded bundle.
Before import, verify the bundle SHA-256 against transfer-manifest.json with sha256sum or Get-FileHash.
These example commands assume the local import branch and worktree do not already exist.
Inspect existing state first. Never overwrite a concurrent branch or dirty checkout.

```sh
git status --short
git remote -v
git fetch origin staging
git cat-file -e 9fd879bea60b7aec99f1c9d90a83853515d2663f^{commit}
git bundle verify /absolute/upload/brainchain-cloud.bundle
git fetch /absolute/upload/brainchain-cloud.bundle refs/heads/docs/brainchain-plan:refs/heads/brainchain-cloud-import
git worktree add .worktrees/brainchain-cloud brainchain-cloud-import
git worktree list --porcelain
cd .worktrees/brainchain-cloud
git log -1 --format='%H %s'
git merge-base --is-ancestor c025c733a0ca204ab4ad88a6f40bb8e3de262467 HEAD
```

If the clone is shallow and lacks the prerequisite, fetch the required history before import.
If repository access or the bundle is absent, request that source artifact. Do not rebuild the integration from this prose.
Verify the bundle SHA-256 against transfer-manifest.json. Verify imported HEAD against its sourceHead value.
The bundle contains committed code, models, source images, original partner files, documentation, tests, and migration history.
It excludes ignored local logs, credentials, database state, node_modules, build output, and local process handles.
The CI summary preserves finite historical counts and source report hashes. It is not a new cloud test result.
AGENTS.md and shared local brain junctions may be ignored. Read available repository instructions and retain the constraints below.

## 3. Read order and evidence precedence

1. Read docs/brainchain-implementation-goal-prompt.md in full. It defines the complete objective and dollar budgets.
2. Read this handoff and docs/brainchain-release-requirements.md. Distinguish the opening current matrix from older chronological entries.
3. Read GameFeatures.md, ARCHITECTURE.md, 3dStructure.md, and docs/agent-metaverse-model.md.
4. Read docs/brainchain-office.md, docs/brainchain-application-source-checkpoint.md, and docs/brainchain-world-source-checkpoint.md.
5. Read docs/brainchain-ci.md and docs/brainchain-staging-parity-runbook.md before test or staging operations.
6. Read the original partner inputs and research README under docs/research/brainchain-2026-11-09/.
7. Read the relevant design and independent review before changing a subsystem.

Code and fresh runtime evidence outrank historical prose. Older research describes the state before implementation.
In particular, the initial plan's research-only status and credit deferral do not narrow the later implementation goal.
Do not treat an earlier failed probe as current failure when its correction and final review follow it.
Do not treat a scoped review as approval of the whole integration.

## 4. Partnership requirements and protocol findings

The conversation proposes an office where OpenClaw and Hermes agents learn BrainChain and earn outside income.
The partner supplied a worker skill and teacher knowledge file. The founder explained that ClawVille also installs knowledge into Eliza memory.
Canonical knowledge now lives in source. Generated manuals and per-agent runtime installation replace hand-written database-only knowledge.
The supplied screenshot only showed the Telegram Downloads folder. It contained no extra architecture.
The original files remain unchanged in the research folder, with hashes in its README.

Observed BrainChain mainnet chain ID:274663. Testnet chain ID:274630. BrainChain is separate from its Robinhood parent chain.
Research found RH USDG and Base USDC purchase offers. A later unpaid challenge also advertised Solana devnet.
An advertised offer does not prove settlement. No mainnet Solana offer or successful Solana payment was established.
Mainnet fast exits were unavailable through the observed interface. Do not promise the partner's quoted23-second testnet timing on mainnet.
Jev decisions and record hashes provide evidence of recorded decisions, not proof of subjective answer quality.
The initial token address in the conversation is the BRAIN token, not the task board or payment desk.
Public capabilities, package versions and contract state can change. Refresh only the capability required for the next real action.

Current source supports parent-testnet ETH depositEth and child-testnet USDG parent exit preparation.
It does not prove Solana funding, Solana cash-out, or mainnet transfers.
Priors read interfaces exist. A verified hosted preparation contract and nonempty loan terms remain missing.
Do not fabricate borrowing, sponsorship, repayment authority, refund attribution, or destination confirmation.
Partner questions16-18 remain drafted in the integration plan. No partner message was sent.

## 5. What exists in committed source

| Area | Main entry points | Current scope |
| --- | --- | --- |
| Human Office | apps/web/src/components/brainchain/; world route /brainchain | Learning, worker identity/policy/status/recovery, purchases, earnings and credit views |
| Shared knowledge | packages/shared/src/constants/brainchain.ts; agent templates; skill-protocol.ts | Code-generated curriculum, protocol127, teacher, Nori orientation, MCP and hosted action surfaces |
| Backend | apps/api/src/routes/brainchain.ts; apps/api/src/services/brainchain/ | Owner-bound reads and durable worker, purchase, funding, delivery and recovery services |
| Worker host | apps/api/scripts/brainchain/run-worker.ts; run-worker-scheduler.ts | Explicit trusted host composition; no automatic public activation |
| Isolated cognition | packages/agent-runtime/src/isolated-task/ | Actual Eliza child, bounded transport, network-none container, no task access to signer/provider secrets |
| Durable data | packages/database/migrations/0100 through0118; schema/brainchain* | Binding, task, signer, compute, delivery, purchase, policy, consent, funding and probe records |
| Runtime probe | probe-bootstrap.ts; probe-runtime-scope.ts; packages/agent-runtime/src/probe-runtime.ts | Protected bootstrap, per-identity providers, exact operation restrictions and durable cost accounting |
| World | brainchain-office-world.ts; three/brainchain-office.tsx; world stage and Pixi paths | Separate venue, guide, door, map/minimap, collision/navigation, 2D entry and return |

Use rg to resolve exact paths and inspect exports before edits. The change spans multiple existing systems, not only new BrainChain files.
The local branch differs from its last merged staging ancestor by more than500 files.
That includes world navigation and2D corrections. Preserve their reviewed semantics during any new staging merge.

## 6. Building and visual evidence

The office uses the partner's charcoal/pink direction and original generated reference images.
Three built-in image generations and one Meshy task produced the selected assets. Meshy reported30 subscription credits.
Asset commit:26e5814f40ae03b1dc26839ef17006e6a408243f.
Actual-Claude world commit:984f9f28f6c9d5d55159ec6c6e91e2ba5a06e533.
Runtime asset: apps/web/public/models/brainchain/brainchain-office-exterior-v2-mips-mo-ktx.glb.
URL suffix:?v=1. Size:963764 bytes. SHA256:9b5e625433ef97fcf5bb65143ed117da53794282471458dccce12339154ae752.
The reviewed asset has one mesh,11311 triangles, Float32 runtime geometry, and11 BC7 mip levels.
The office center is x760,z-3040. The door is x760,z-2790. The safe approach is x760,z-2600.
The guide ID is brainchain-office-guide. It is a separate venue, not a replacement for an existing teacher building.

Actual local browser checks cover guest/synthetic Office entry, map paths,2D transitions and selected device states.
Actual Claude and Codex performed scoped world/navigation reviews. Their reports are committed.
No authenticated staging scene, final foreground Iris Xe baseline comparison, or real-iPad safe-area approval exists.
A generic60FPS observation is not Iris Xe proof. Do not relabel local synthetic captures as live settlement evidence.
New3D changes still need actual Claude/Codex collaboration and screenshot review. A second Codex agent is not a Claude substitute.

## 7. Final local verification

The application checkpoint c025c733a passed these isolated local lanes on itachi222:

| Lane | Suites | Tests passed | Expected skips |
| --- | ---: | ---: | ---: |
| Pure | 80 | 609 | 1 |
| PostgreSQL | 26 | 173 | 0 |
| Protected Linux | 4 | 12 | 5 |

The pure Docker skip belongs to the PostgreSQL lane. Linux skips are the reviewed split-platform/child-entry cases.
API, runtime, and script/test strict TypeScript checks passed. An earlier production web build and separate web typecheck also passed.
The web checks predate the final backend/runtime changes. No remote CI result exists.
The documentation path guard passed807 references with70 existing baseline entries.
The final pure retry corrected four old authentication fixtures. Production marker guards were not weakened.
The first failed log remains locally retained. Raw logs are not required for cloud execution and are not automatically transferred.
See docs/research/brainchain-2026-11-09/cloud-ci-summary.json for the portable per-suite historical evidence.

Bootstrap review passed seven frozen source paths. Runtime review passed33 frozen paths.
Independent runtime evidence includes actual Eliza8tests/22assertions, HTTP4/11, cleanup2/17, terminal boundary3/14, and real PostgreSQL composition1/15.
Prepared attach1/9 used controlled rows. It did not exercise real PostgreSQL attachment.
Protected artifact3/26 used Linux primitives and exact wrapper extraction. It did not prove every complete CLI import or mid-read mutation race.
Read docs/brainchain-probe-bootstrap-review.md and docs/brainchain-probe-runtime-final-review.md for exact limits.

## 8. Cost, custody and runtime probe

Stable budget job UUID:2482562a-c3fd-4684-b3a8-963224c4f479.
The cumulative OpenAI cap is10USD. Spent0; reserved0.
The separate cumulative OpenRouter cap is10USD. Spent0; reserved0.
These caps include all agents, retries and resumed sessions. A cloud session does not reset them.
Meshy has no job-specific subscription-credit cap. No credit purchase or separately billed reseller is authorized.
The built-in image calls did not load the desktop OpenAI key.
Read docs/brainchain-budget-ledger.json before any spending.

No signed genesis, persistent protected authority store, actual reservation, dedicated staging key, paid trial, or owned live hire exists.
The fixed embedding adapter uses text-embedding-3-small,1536 finite dimensions,8192 tokens,200microUSD maximum per call and a30-second ceiling.
It rejects redirects and has no automatic retry or house-key fallback.
At c025c733a, protocol127 has46 sections and the curriculum has11 sections.
The proposed quota is2*46+11+32=135 calls, or27000microUSD ($0.027).
The largest protocol section is24257 UTF-8 bytes. This does not prove it fits the provider token limit.
Protocol SHA256:63147c1474bbea48c1a281edcfca6549c399dddad2c797451f2a13d265da2755.
Curriculum SHA256:2a5696a82c6829e712e696ec158bf16be18a44f8bdc10fbe0f45759d7a05f517.
These are source measurements, not a reservation or served staging proof.

Probe order: deploy exact source; prepare fixture identities without connect; publish signed root reservation; register the run; configure API; attach; connect.
BRAINCHAIN_PROBE_CONFIG_PATH is staging-only. Absent configuration leaves the probe disabled.
API startup hydrates existing authority before warmup. It never signs, allocates, registers, or creates a genesis itself.
Existing tools are publish-root-budget.ts, register-runtime-probe.ts, and hosted-skill-runtime-probe.ts prepare/attach modes.
External signing is intentional. Do not add a public signing endpoint to make the test easier.
The five stages are install, chat, decide, workers read, and a later private receipt. The sequence lasts at most eight minutes.
No payment or transaction action belongs to this runtime probe.
Durable embedding failure stops the exact run. Uncertain cost remains held. Intentional shutdown can consume the reviewed second start.
Cleanup stops paid admission, autonomy and runtime; verifies disconnect; closes the gateway; then removes live fixture identity rows.
Accounting and immutable identity markers survive cleanup. Failed disposal retains identity rows and reports failure.
Read the runtime budget design and staging parity runbook before provisioning or execution.

## 9. Open requirements: do not claim release

1. Verify the existing worktree and current tool access. Import the optional bundle only if a different environment lacks the source.
2. Obtain permitted repository write authentication for release. Continue independent work while access is unresolved.
3. Refresh staging ancestry and source identities before merge or deployment. Resolve concurrent protocol and migration numbering explicitly.
4. Verify protected Linux storage, UID, paths and secret delivery before the paid probe. Do not use NTFS permission assumptions.
5. Execute onboarding and actual hosted knowledge-consumption checks on staging, with exact served hashes.
6. Prove authenticated human and bound-agent parity. Guest or synthetic sessions do not satisfy it.
7. Run the real testnet worker application, activation, hire, execution, delivery, grade and settlement sequence.
8. Prove interrupted delivery, partial funding, held exit and supported destination recovery against real receipts.
9. Obtain verified purchase/refund attribution and Priors preparation terms where the partner supports them.
10. Run final integrated adversarial review, browser/device checks, and foreground performance comparison.
11. Prepare the promotion PR only after staging evidence. Production merge still needs explicit authorization.

Configured testnet policy is brainchain-testnet-configured-authority-v1, for chain274630 and reviewed release3.5.0.
The source review covers14 getters and eight runtime hashes. Both activation flags remain false.
Nitro emits no empty blocks. An old head timestamp alone is not an outage or permission to weaken financial finality.
Parent finality/archive inclusion evidence remains incomplete. Provisional receipts cannot release full liabilities.
The exact-consent C1 correction has partial independent evidence. The review service rejected its final report.
Do not call that a full approval or retry/rephrase the rejected task to bypass the refusal.
The desktop Chrome launch also received an automatic rejection. Later browser inventory reported its access host unavailable.
Do not bypass the rejected launch. A cloud environment may expose different approved browser tools; inspect their availability normally.
Any unavailable tool or review remains an explicit evidence gap, not a reason to invent success.

## 10. Cloud setup and meaningful checks

Use the repository lockfile and current workflow version. Historical local Bun was1.3.14; workflow pin was1.4.2.
Read current workflow/package requirements before installation. Do not assume package.json's older packageManager field establishes the tested version.
Use a fresh dedicated fixture database. Never point fixture suites at staging, production, or an unrelated development database.
BRAINCHAIN_TEST_DATABASE_URL must use literal127.0.0.1, an explicit unprivileged port, and brainchain_fixture role/database.
Provide its synthetic password through the cloud secret mechanism. Never print the URL.
Do not set the desktop-only BRAINCHAIN_LOCAL_FIXTURE fallback in cloud.

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@clawville/agent-runtime
bun scripts/brainchain/ci-tests.ts pure
# Configure the dedicated database and approved Docker fixture first.
BRAINCHAIN_DB_FIXTURE=1 BRAINCHAIN_DOCKER_FIXTURE=1 bun scripts/brainchain/ci-tests.ts postgres
bun scripts/brainchain/ci-tests.ts prepare-linux
bun scripts/brainchain/ci-tests.ts linux
bun scripts/ci/check-doc-paths.ts
```

Read docs/brainchain-ci.md before these commands. The Linux lane needs its pinned Docker profile and image.
Run database DDL suites serially. Restore consent wrappers after each suite, as the runner does.
Do not run all Bun tests in one process. Module mocks and fixture DDL can contaminate unrelated suites.
Do not rerun unchanged successful checks merely to consume time. Run checks required by source changes or environment validation.
Use production-bundle local preview. Never run bun run dev on the desktop; its HMR path can crash WebGPU.
Keep failed-run evidence and distinguish compilation, local fixture verification, staging behavior, and actual transaction proof.

## 11. Team, project constraints and secrets

Use one registered job worktree. Assign one owner per source area and preserve other agents' edits.
Read the domain registry and trap lists where available. Non-trivial implementation requires collaborators and independent review.
Every implementation/review delegation includes: use ultrathink reasoning before writing code, or before reviewing code.
Actual Claude owns the required3D collaboration and final3Drelease role. Do not counterfeit that review in cloud.
Human/agent parity requires canonical avatar identity on writes, action/tool documentation, protocol updates, and real settlement where applicable.
Update Nori, the served protocol manual and hosted runtime consumption together. Memory IDs must include agent identity.
Preserve ElizaOS. Do not replace it with direct model calls to simplify tests.
Do not mint CT/vCLAW from self-reported BrainChain income or credit. Use the existing ledger for real economy mutations.
Never enable dark money flags, bypass consent, reset budget history, or retry an uncertain payment as a new operation.
Use staging first. Do not push master, merge production, spend mainnet funds, create live debt, or send partner messages without authorization.
Keep code and matching canonical documentation in the same diff. Include the required PARITY note.
Do not claim founder acceptance. Local tests do not establish founder visual approval.

Desktop credential location: C:/Users/itachi/.itachi-api-keys. This is a location reference, not a file to upload.
Laptop source machine: hoodie-prometh, C:/Users/newma. Historical access used ssh -n laptop.
This session has desktop filesystem access. A future session must inspect which machines and services its tools can actually reach.
Use the cloud's approved secret injection. Never copy keyrings, wallet keys, cookies, .env files, database dumps, or complete ignored evidence directories.
The transfer package deliberately excludes those items. No new credentials are required merely to read or review the integration.

## 12. State when this handoff was written

The prior persistent goal was marked blocked after repeated release-access failures. It was not marked complete.
The founder requested a handoff and kickoff, then clarified that this conversation is already a cloud session.
Do not ask for an upload or another session when the existing worktree is accessible.
Do not start deployment merely because this documentation request exists.
The cloud kickoff below explicitly requests continuation of the original implementation goal.
Retain its full scope and budgets when starting or resuming the cloud goal. Do not infer a token budget.
No old sub-agent process needs polling. Imported files and fresh tool state are authoritative.
Keep the complete original plan, budget ledger, evidence matrix and this handoff available through future context resets.
