# Goal prompt: implement BrainChain Office in ClawVille

Use the text below as the implementation goal.
This file defines future execution; writing this file does not start implementation.

---

## Objective

Implement BrainChain Office as a complete ClawVille integration for humans, connected agents, and hosted agents.
When this prompt starts execution, register this objective through the available persistent-goal tool.
Do not invent a token budget; the founder specified dollar budgets only.
Build the physical office, teacher, curriculum, human interface, agent tools, worker execution, task purchases, income tracking, and recovery controls.
Include verified reputation and a separately controlled Priors credit interface where the partner supports them.
Carry each supported feature through implementation, independent review, tests, staging deployment, and browser verification.
Do not stop after a catalog entry, a model asset, a mock interface, or a plan.

The founder is asleep for several hours.
Make routine implementation and design choices without waiting for replies.
Continue independent work when an external dependency blocks one feature.
Keep unmet requirements visible; never redefine partial delivery as full integration.

## Inputs and starting state

Read these files completely before decomposition:

- `docs/brainchain-integration-plan-2026-11-09.md`
- `docs/research/brainchain-2026-11-09/README.md`
- `docs/research/brainchain-2026-11-09/brainchain-office.md`
- `docs/research/brainchain-2026-11-09/brainchain-office-knowledge.md`
- The evidence JSON files beside those inputs.
- The current `AGENTS.md`, domain registry, canonical docs, and relevant domain trap lists.
- Current MCP ecosystem, wallet, knowledge, world-presence, and deployment documentation.

The source files came from hoodie-prometh.
The implementation host is itachi222, the Windows desktop.
The research worktree is `C:\Users\itachi\Documents\Crypto\ClawVille\.worktrees\brainchain-plan`.
The research branch is `docs/brainchain-plan`.
Research commit `f617a125d` contains the analysis and original inputs.

Use this registered worktree for the whole job after checking its status and ownership.
Use one shared worktree for all teammates and auditors.
Do not create one worktree per agent.
Preserve unrelated work in the root checkout and other worktrees.
Fetch current staging and production references before choosing the implementation base.
Merge the current staging lineage into this job without overwriting concurrent edits.
If this worktree has an active owner, coordinate before any change.

Read the latest job handoff if this goal resumes after interruption.
Recheck live commands, deployment commits, and protocol versions.
Do not trust the research date as current release evidence.

## Authorization and budgets

The founder authorizes source image generation with Codex Make Image / the available image-generation tool.
The founder authorizes Meshy generation through the existing Meshy subscription and API key.
Meshy subscription credits have no job-specific numeric cap.
Use those credits for useful iterations, and record consumption.
Do not purchase credits, change the subscription, or use a separately billed Meshy reseller under that authorization.

The founder authorizes up to **$10 total through the desktop GPT/OpenAI key** for this job.
The founder separately authorizes up to **$10 total through the OpenRouter key** for this job.
These caps cover all agents, retries, image calls billed through those keys, worker model calls, and resumed sessions.
They are separate ceilings; neither resets per agent, per day, or per restart.
Unused budget from one provider does not increase the other provider's cap.

Read the required credentials privately through the established Itachi keyring mechanisms on itachi222.
The existing keyring location is `C:\Users\itachi\.itachi-api-keys`; verify access without printing its contents.
Never place secrets in commands visible to users, source files, reports, prompts, screenshots, or task results.
Give task subprocesses no access to provider or wallet secrets.

Maintain one durable budget ledger for the whole team.
Reserve the worst-case cost before each paid call, including output tokens and retries.
Only the budget owner can authorize a reservation.
Update the ledger from provider usage after the call.
Keep uncertain charges reserved until reconciled.
Use a conservative buffer when prices or usage are uncertain.
Stop that provider's calls before its cap can be exceeded.
Use subscription tools or local checks when a paid provider reaches its limit.

These API budgets do not authorize mainnet token purchases, stakes, bonds, loans, guarantees, or wallet transfers.
Implement and test those paths with test tokens and controlled fixtures first.
Prepare exact mainnet test costs and signer details for the founder's later approval.
Do not turn an API budget into authority over an existing wallet balance.
Do not send partner messages or publish announcements without separate authorization.

## Team and operating rules

Team name: `brainchain-office`.
Use sub-agents freely for useful parallel work within the harness's available concurrency.
Queue additional roles when the harness has fewer slots than the plan needs.
Do not bypass platform limits or create idle agents.

The lead owns coordination, budget accounting, integration, release evidence, and the final report.
Assign each implementation file to exactly one domain owner.
Use these roles, combining compatible roles when necessary:

1. Protocol researcher: capability probes, package review, contract sets, and partner discrepancies.
2. Knowledge implementer: curriculum, teacher, seed, installation, and runtime consumption.
3. Backend implementer: identity, operations, payments, worker lifecycle, and recovery.
4. Human-interface implementer: office panel, status, consent, errors, and device layouts.
5. 3da manager: reference images, Meshy, optimized assets, world integration, and visual evidence.
6. Adversarial auditor: identity isolation, hostile content, custody, retries, and economic effects.
7. Independent reconciler: new money, custody, authentication, and schema changes.

Every agent prompt includes the literal phrase `use ultrathink reasoning before writing code` or `use ultrathink reasoning before reviewing code`.
Include the team name, role, exact file ownership, dependencies, trap list, and relevant hard constraints.
Tell each implementer that other agents share the codebase and that it must preserve their edits.
Communicate findings promptly; do not save blocking findings for a final report.

Follow the repository's actual Claude–Codex collaboration requirement for 3D work.
A second Codex agent does not substitute for an independent Claude review.
Use the available Claude workflow for decomposition and the required cross-model review.
Follow its commit and push ownership rules.
If that workflow is unavailable, record the missing review and continue independent non-3D work.
Never invent a review or claim that visual checks passed without viewing the scene.

## Phase A: refresh the contract and choose the architecture

Probe the official BrainChain docs, released packages, RPC chain IDs, unpaid payment challenges, and exit endpoints.
Record timestamp, package version, source commit, network, and observed capability.
Read current on-chain terms where the public interface permits it.
Distinguish deployed service behavior from code presence and documentation claims.

Resolve these research findings before enabling their affected paths:

- The observed task quote offered RH USDG and Base USDC, with no Solana option.
- The worker README disabled mainnet fast exits, and the mainnet exit endpoint returned 404.
- Mainnet activation used different timing from the supplied two-hour instructions.
- The supplied blanket 3% loss rule differed from operation-specific source limits.
- House-task results could become public even after rejection.
- Task purchases through the desk did not give the payer direct poster-dispute rights.

Use one capability model that drives routes, tools, UI, and curriculum.
Fail closed when a required payment capability disappears or its quote changes.
Prefer the native Solana interface when BrainChain actually supports it.
Never weaken ClawVille's existing Solana payment checks to accept an EVM quote.
Treat any new EVM payment implementation as a distinct reviewed money path.

Default product choice: a standalone BrainChain Office panel with a physical office entrance and teacher.
Choose an available, legal world location after inspecting the current map and collision model.
Preserve existing teacher IDs, earned skills, and occupied buildings.
Do not silently replace a building or overwrite another team's location.
If a permanent location needs a founder choice, use an existing supported temporary placement mechanism where one exists.
Keep the unresolved permanent choice explicit.

## Phase B: knowledge, identity, and a useful office

Create reviewed ClawVille curriculum from the partner inputs and refreshed evidence.
Preserve the original partner files unchanged.
Keep canonical knowledge in tracked code and generate served manuals from it.
Use deterministic seeding and agent-scoped memory IDs.
Update Nori, the connection manual, and the hosted runtime copy in the same diff.
Allocate the next protocol version after checking concurrent changes.

Prove that both chat and action decisions consume the current knowledge.
For gateway runtimes, prove that the outbound request carries it.
Compare exact hashes between served manuals and installed copies.
Use source versions and per-artifact hashes for teacher summaries that intentionally contain different text.

Build human and agent access to the same operations and status records.
Resolve human sessions and bound agent sessions to the same avatar.
Keep guests on explicit read or demo paths.
Add fresh wallet-control challenges before external worker-wallet bindings.
Keep Solana identity, EVM worker identity, and ERC-8004 identity distinct.

Provide clear sections for learning, worker setup, work status, hiring, earnings, and recovery.
Show unavailable capabilities with accurate reasons and useful next actions.
Do not fill unavailable functionality with simulated success.
Keep implementation details out of ordinary product screens.

## Phase C: durable task purchases and worker execution

Reuse existing MCP route adapters, building tools, action inventory, and shared service patterns.
Register BrainChain as a distinct spend vendor.
Enforce wallet-signed grants and existing human-controlled cap changes.
Agents cannot increase their own authority.

Persist operation intent and atomically reserve budget before signing.
Bind idempotency to avatar, environment, operation, endpoint, and request hash.
Keep uncertain payments reserved and reconcile their original authorization.
Never create a new payment merely because a request timed out.
Verify network, asset, recipient, amount, expiry, fee payer, and destination.
Track the buyer order separately from the underlying BrainChain task.
Verify refunds through receipts, not a task's failure label.

Implement worker execution outside the API process.
Use ElizaOS through the existing agent runtime; do not replace it with a direct model call.
Keep the signer outside task execution, model prompts, and memories.
Start with bounded text tasks and no shell access.
Use an actual sandbox for code tasks with explicit filesystem, network, CPU, memory, and time limits.
Do not expose Docker control or host credentials.

Persist task leases, attempt records, delivery hashes, and recovery checkpoints.
Prevent duplicate work ownership and duplicate submission after restarts.
Preserve multiple attempts under one unique task identity.
Identify tasks by network, contract set or board, and task ID.
Implement supported pause, drain, restart, and shutdown behavior.
A stopped local process does not prove that BrainChain stops hiring its identity.

Run a testnet pilot through application, activation, hire, delivery, grade, and settlement.
Wait for real protocol windows when necessary while other work continues.
Record actual eligibility and deadline values rather than fixed countdowns.
Test failures, refused applications, rejected results, expired tasks, and interrupted delivery.
Measure model cost and net task income separately.

## Phase D: earnings, cash-out, reputation, and credit

Implement separate balances for stake, unlocked stake, pending income, settled income, and destination funds.
Require destination-chain confirmation before describing funds as spendable there.
Implement partial-funding recovery and held-exit recovery.
Never silently substitute RH USDG for a requested Solana payout.
Require distinct consent for any alternate destination or asset.

Use existing verified ClawVille purchase paths for spending external income in the world.
Do not write avatar CT balances directly.
Do not mint CT from self-reported income or credit.
Keep receipt uniqueness and ownership checks across all economic effects.

Implement verified work history and issuer-filtered reputation reads where supported.
Do not automatically convert outside work totals into leaderboard points.
Any score change needs the scoring owner's anti-farm design and parity audit.

Include Priors discovery, eligibility, terms, loan status, and repayment status where verified interfaces support them.
Review identity ownership, sponsor consent, debt terms, and default behavior before any write path.
Use separate authorities for borrowing, repayment, and sponsorship.
Implement supported transaction preparation and testnet behavior without creating live debt.
Keep mainnet credit inactive until the founder approves its terms and monetary exposure.
Treat missing partner credit capabilities as explicit requirements still unmet.

## Phase E: source images, Meshy model, and world integration

Read the current brand docs, world references, and 3D performance rules first.
Inspect BrainChain's public brand assets before choosing colors or symbols.
Use public branding without inventing an official endorsement or copying private material.

Create original source images with Codex Make Image.
Use a coherent front, side, rear, and three-quarter design where the chosen Meshy workflow needs them.
Keep geometry consistent between views.
Use clear entrances, readable silhouette, and a style that matches ClawVille at gameplay camera distance.
Avoid tiny baked text; implement signs through the game's supported sign system.
Document the visual brief and preserve the source references.

Use the direct Meshy subscription API through the existing repository workflow.
Inspect these existing helpers before reuse:

- `scripts/hermes-pipeline/meshy-rest.mjs`
- `scripts/read-glb-bbox.mjs`

The root checkout also contains `scripts/hermes-pipeline/meshy-buildings.mjs` as local, untracked work.
That helper does not exist in the research worktree at prompt creation.
Inspect it read-only if useful, and preserve its owner's work.
Bring any required adaptation into the shared job worktree before execution.

Some other Meshy helpers use fal.ai and a separate billing path.
Do not assume those calls consume the authorized Meshy subscription.
Do not copy an avatar helper's polygon and texture defaults into a building without review.
Persist task IDs and resume polling instead of submitting duplicate generation jobs.

Iterate until the selected building matches the reference and the scene budget.
Use the Blender specialist for cleanup when needed.
Verify scale, footprint, origin, normals, UVs, materials, texture sizes, and entrance clearance.
Remove hidden excess geometry and unusable details.
Use compressed runtime assets where the current renderer supports them.
Use a new filename or version when replacing an asset at an existing public path.

Wire the building through the current location, collider, navigation, interaction, teacher, and renderer systems.
Prove human approach and entry, agent navigation, skill access, and return to the world.
Keep the 2D path fully usable.
Inspect screenshots after every visual iteration.
Do not accept a downloaded GLB as proof of in-world integration.

No per-frame network calls or allocations.
Preserve the Iris Xe prohibitions on drei Text/Billboard and InstancedMesh with ShaderMaterial.
Measure load cost, draw calls, texture memory, and sustained FPS against the same baseline scene.
Keep heavy intermediate files in an explicitly ignored job directory inside this worktree.
Commit only the assets and provenance needed for the shipped feature.

## Phase F: audit, release, and evidence

Run the relevant tests and lint checks.
Use the repository's production-bundle local workflow; never run `bun run dev`.
Run meaningful regression tests for identity, budget races, duplicate payments, restart recovery, and hostile task content.
Test knowledge installation and actual runtime consumption.
Run the staging onboarding smoke and hosted runtime probe where required.

Use an adversarial reviewer before release.
Fix blocking issues, then use a fresh reviewer for the changed paths and remaining risks.
Require the independent reconciler for high-stakes paths.
Do not count the implementer's own approval as independent review.

Test phone and iPad layouts at the repository's required sizes in both orientations.
Exercise the actual panels, errors, task records, and controls.
Record any real-iPad safe-area check that still needs the founder's device.
Do not block unrelated implementation while that physical-device evidence is unavailable.

Prepare same-diff canonical docs, protocol changes, PARITY notes, deployment status, and founder-review entries.
Verify the approved GitHub identity before any push or PR action.
Use staging first; never push directly to master.
Follow the current deploy runbook and required 3D release owner.
Verify the runtime source commit, health, served manual, capability behavior, and browser scene after deployment.
Prepare the production promotion PR after staging evidence exists.
Merge to production only when session authorization explicitly covers that promotion.

Do not claim founder acceptance while the founder sleeps.
Use “implemented and verified on staging; founder review pending” when the evidence supports it.
Do not use “complete” for the full goal while a required external capability or review remains unmet.
Finish the authorized staging and testnet scope autonomously.
Keep unavailable Solana capabilities as unmet requirements.
Mainnet monetary tests require separate approval; production promotion requires session authorization.
Neither gate permits indefinite waiting or unauthorized spending.
Use the goal tool's actual status rules when an external dependency prevents further progress.

## Continuity and finish criteria

Maintain a durable job board, budget ledger, evidence index, and handoff inside this worktree.
Commit coherent changes as work progresses.
Record exact file ownership, source versions, task IDs, migrations, tests, and next commands.
Keep sensitive values out of every record.

If a partner endpoint remains unavailable, finish every independent supported feature.
Build a real adapter only from a verified interface contract.
Test unavailable paths against controlled fixtures and mark them as unverified against the live service.
Do not repeatedly poll an unchanged dependency without a reason.
Record the exact external action needed to continue and prepare a concise partner question draft.
Never send that draft automatically.

The full objective requires all applicable items below:

- A visible, optimized BrainChain building with a functional entrance and teacher.
- A useful human panel and equivalent bound-agent tools.
- Reviewed knowledge that connected and hosted agents actually consume.
- A durable worker lifecycle with verified testnet execution and recovery.
- Supported task purchases with authorization, budget controls, and receipt tracking.
- Income and cash-out paths with accurate availability and verified destination handling.
- Verified work history and the supported Priors interface, with separate credit authority.
- Independent audits and the required Claude–Codex 3D review.
- Passing relevant local and staging checks, with actual browser evidence.
- An honest list of any mainnet test, partner capability, production promotion, or founder review still pending.

At handoff, provide the staging URL, a short visual walkthrough, commit and PR links, budget totals, Meshy usage, and remaining gates.
State separately what exists in code, what passed testnet, what passed staging, and what has mainnet transaction evidence.
Preserve in-flight transactions and recovery records during rollback.
Disable new operations before reverting an integration that has pending external work.
Remove the job worktree only after the merge or an explicit abandonment, using the repository's safe cleanup procedure.
