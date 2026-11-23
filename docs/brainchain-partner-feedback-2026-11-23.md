# BrainChain partner feedback tracker (2026-11-20 to 2026-11-23)

The BrainChain developer reviewed the Office on staging between 2026-11-20 and 2026-11-23.
This file maps each point to the ClawVille feature that it concerns, the change, and the state.
Update the State column in the same commit that closes an item.

Verified on staging 2026-11-23 18:46Z (commit `0053461bd`, containers `6edb7d1cf`, PROTOCOL 141 served, Cortex reply and Office Learn and Earnings tabs checked signed in).

States: `open` (not started), `in diff` (in the working change), `on staging` (pushed and verified on staging), `founder` (needs a founder decision), `no change` (nothing to change).

## Evidence read on 2026-11-23

- `brainchain-worker` 0.21.1 on npm (published 2026-11-23). Its README documents `fund --from-solana` (mainnet) and `exit --to-solana <address>` (mainnet only, USDC through Relay, less a 0.5% desk fee and Relay's fee).
- `GET https://brain.usebrainchain.com/exits` (mainnet desk): pays USDG on Robinhood Chain (chain 4663) by default, fee 50 bps, minimum fee 0.01 USDG.
- `GET https://brain.usebrainchain.com/x402/tasks` (mainnet, HTTP 402 quote): accepts Robinhood USDG, Base USDC and Solana mainnet USDC.
- `https://docs.usebrainchain.com/other-networks`: BrainChain backs Priors credit lines of 25 USDG, or 50 USDG for agents that Priors Score v2 rates proven with outside customers. Each decision is written into a BrainChain block.
- `https://docs.usebrainchain.com/bug-hunt`: round 1 is closed; ten bugs were confirmed and paid at 100 USD each.
- `https://docs.usebrainchain.com/security`: the contracts have no outside-firm audit; source and tests are public. No public explorer page showing "verified on chain" was found.
- `https://usebrainchain.com/brand`: ink `#1D1D1D`, rose `#F386A1`, ivory `#F8F7F4`, background `#0B0B0B`, Geist type. The Office boards already use these colours.

## Items

| # | Partner point | Feature it concerns | Change | State |
|---|---|---|---|---|
| 1 | Brand page link | Office 3D boards and window | Palette already matches. The Office does not show the official BrainChain logo. Option: draw the supplied mark on the existing Task Board canvas (no new draw call). | founder |
| 2 | Solana funding works on mainnet | Capability `solana_funding`; curriculum section "Payment and cash-out limits" | Sets `available` with worker 0.21.1 evidence and `fund --from-solana`. The curriculum explains the Relay quote and stake command. ClawVille does not run it. | on staging |
| 3 | Payouts to Solana built on testnet (later superseded by item 12) | Capability `solana_cash_out` | See item 12. | no change |
| 4 | What is left before production | Promotion of the Office | Founder answer list: promotion approval, prod migrations, real-device safe-area screenshot, live hosted-agent run of the `tasks` and funding ops. | founder |
| 5 | Target go-live date | Promotion | Founder decision. | founder |
| 6 | Teacher was right that Solana cash-out was not on mainnet | Cortex knowledge | Replaces the stale claim with mainnet worker CLI cash-out to Solana. Nori, orientation, the manual, Office copy and docs state the same fact. Office exit preparation stays testnet-only. | on staging |
| 7 | Teacher opens with API topics (OAuth, webhooks, rate limits) | Cortex template (`api-integrations`) description, bio, topics, examples | Leads with BrainChain work in description, bio, lore, topics and the first example. Keeps the full API lesson after it, as the founder required on 2026-11-10. | on staging |
| 8 | Audit and trust-boundary lines read too cautious | Curriculum section "Task safety and public output"; Cortex bio and lore | Replaces audit and trust-boundary copy with public decision and source evidence. Keeps task-data, secret, signer-isolation and dispute instructions in plain language. | on staging |
| 9 | Send the go-live time for Solana cash-out | Capability `solana_cash_out` | Superseded by item 12. | no change |
| 10 | Replacement copy: "Task safety and public output" | Curriculum section `safety` | Uses published confidence and judge questions, public contract source and tests, and the closed, paid bug hunt. Omits the unsupported claim "verified on chain". Preserves the exact public-output paragraph. | on staging |
| 11 | Replacement copy: "Work history and future credit" | Curriculum section `history`; capability `credit` | Sets credit `available`; explains up to 50 USDG on Priors, qualification, consent and case-by-case decisions recorded on chain. The Office reads `identity_credit` and does not lend. The web evidence filter accepts the exact credit page URL. | on staging |
| 12 | Solana cash-out is live on mainnet | Capability `solana_cash_out`; payment section; manual; Nori; orientation | Sets `available` through `exit --to-solana <address>`. States fees and the current Robinhood USDG default. The README permits Robinhood USDG fallback above Relay cost limits; the curriculum separates this behavior from ClawVille's separate-approval rule. No runtime behavior changes. | on staging |
| 13 | Replacement teacher opening line | Cortex description and first bio line | Uses the partner opening about joining as a worker, taking tasks and receiving USDG for accepted work. The first example explains qualification, mainnet fee, dispute window and cash-out. | on staging |
| 14 | Mainnet quotes now accept Solana USDC (observed, not in the messages) | Capability `solana_task_purchase` | Names Robinhood USDG, Base USDC and Solana USDC. ClawVille drafts stay test-only, so the state stays `not-verified`. No ClawVille Solana settlement is claimed. | on staging |
| 15 | Worker release moved from 0.19.2 to 0.21.1 (observed) | Curriculum section "Prepare a testnet exercise" | Pins 0.21.1, checks commands against the saved README, adds `--strict-mcp-config`, and states Node.js 22.12 plus Windows support. Retains the Node.js 22.15 restart guard and OpenClaw clone/Docker requirements. The web evidence filter accepts the exact release URL. Curriculum becomes version 2; protocol becomes 141. | on staging |
| 16 | "Anything else you need" | Partner questions | Founder to ask: what "verified on chain" refers to; the release date of the Base USDC default payout. | founder |

## Static verification for this diff

The shared curriculum uses version 2, research date 2026-11-23 and worker 0.21.1. The protocol uses version 141.
The Office status label already maps `available` to "Available". The data paths and test IDs stay unchanged.
The web evidence filter adds only the exact worker release and credit page URLs. Its tests cover those URLs and reject adjacent targets.

The lead measured these BrainChain chunks as UTF-16 characters through static source reconstruction with base URL https://api.example.test.
No application code or test runner executed for this measurement. Each chunk stays below 24,000 characters.

| Chunk | Characters |
|---|---:|
| Access | 20,886 |
| Purpose | 391 |
| Office controls | 1,120 |
| Networks | 451 |
| Worker | 1,051 |
| Practice | 3,186 |
| Payments | 4,248 |
| Safety | 982 |
| History | 622 |
| Capability evidence | 1,692 |
| Official sources | 867 |

Verification limits: no local build, dev server, test runner or typecheck ran, as the brief requires.
Claude retains commit, push and deployment ownership. The items remain `in diff`; CI, browser and hosted-runtime checks remain unverified.
PARITY: human Office and chat; connected and hosted agent tools and chat; private state and chat rewards bind to the resolved owner avatar.

### Files in the diff

- `packages/shared/src/constants/brainchain.ts`
- `packages/shared/src/constants/brainchain.test.ts`
- `packages/shared/src/constants/orientation-skill.ts`
- `packages/agent-templates/src/locations/api-integrations.ts`
- `packages/agent-templates/src/locations/town-guide.ts`
- `apps/api/src/services/skill-protocol-topics/brainchain.ts`
- `apps/api/src/services/skill-protocol.ts`
- `apps/api/src/services/brainchain/bindings-db.test.ts`
- `apps/api/src/services/__tests__/brainchain-topic.test.ts`
- `apps/api/src/services/__tests__/floor-arena-knowledge.test.ts`
- `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`
- `apps/api/src/services/__tests__/trading-floor-constants.test.ts`
- `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`
- `apps/web/src/components/brainchain/office-api.ts`
- `apps/web/src/components/brainchain/office-api.test.ts`
- `apps/web/src/components/brainchain/office-funding-exit.tsx`
- `docs/brainchain-office.md`
- `docs/hatcher-integration-spec.md`
- `GameFeatures.md`
- `ARCHITECTURE.md`
- `FOUNDER-REVIEW.md`
- This existing partner feedback tracker remains untracked until Claude stages it.

### Test changes for CI

The shared curriculum test expects four available capabilities, worker 0.21.1, Solana exit instructions and credit of up to 50 USDG.
It rejects the old fast-exit and audit statements and retains secret-key checks.
The BrainChain topic test checks Cortex lesson order and mainnet Solana capability text.
The floor-arena, onboarding, trading-floor and paid-surface tests expect protocol 141.

The Office evidence-link test permits only the exact new credit and worker release URLs, with scheme, credential, port and adjacent-target refusals.
The database fixture uses the current curriculum version for its same-version hash-conflict case.
Version 1 now upgrades to version 2, so a literal 1 no longer represents that conflict.
No test runner executed. The database test keeps mixed CRLF/LF line endings and preserves all untouched bytes.
Its two new or changed lines use LF so plain `git diff --check` passes.
