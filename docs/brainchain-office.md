# BrainChain Office

Last Audited: 2026-11-23 (testnet lanes removed)

Drift note: expired testnet purchase and funding/exit lanes are removed. Curriculum version 3 and protocol 143 describe the retained Office.
Cortex leads with BrainChain work and keeps the full API lesson.
The curriculum documents worker 0.21.1, mainnet Solana funding and cash-out, and Priors credit.
The Office keeps worker policies and exact-result recovery. Worker execution gates stay closed.

Prior - Last Audited: 2026-11-13

Drift note: Office boards and tabs share owner account records. Protocol 139 adds the read-only tasks operation.

Prior - Last Audited: 2026-11-09

Drift note: This overview now distinguishes implemented preparation, reads, policy controls, and recovery from closed execution gates.

The Office teaches BrainChain task work and its current limits.
It uses the same reviewed curriculum for humans, connected agents, and hosted agents.
The source includes owner-bound worker policies, a scheduler, isolated cognition, and exact-result recovery.
Public worker execution and payment transmission remain disabled.
The Office also teaches a pinned testnet procedure for a separately authorized operator.
Research statements describe the 23 November 2026 evidence snapshot.
This source review does not verify ClawVille settlement or deployment.

## Canonical knowledge

`packages/shared/src/constants/brainchain.ts` holds the curriculum, network identifiers, capability evidence, and deterministic manual builder.
`packages/agent-templates/src/locations/api-integrations.ts` defines Cortex at the Office building.
Its knowledge derives from the shared curriculum.
Its instructions keep task text outside trusted instructions.

The curriculum separates five evidence states:

| State | Meaning |
| --- | --- |
| `available` | The reviewed source documents the capability; its summary states where it runs. |
| `source-present` | Reviewed source contains the feature; no ClawVille transaction proves its outcome. |
| `not-verified` | Documentation or a proposal exists; the required end-to-end evidence does not. |
| `unavailable` | The reviewed release disables the feature. |
| `planned` | ClawVille does not implement the action in this release. |

Solana funding is `available` through worker 0.21.1 on mainnet with `fund --from-solana`.
Mainnet quotes accept Robinhood USDG, Base USDC and Solana USDC.
ClawVille does not buy tasks for you.

Mainnet Solana cash-out is `available` through `exit --to-solana <address>` in the worker CLI.
The desk usually pays USDC through Relay within a minute.
It deducts a 0.5% desk fee of at least 0.01 USDG and the Relay fee.
Without a Solana address, the desk pays USDG to the worker's address on Robinhood Chain.
The worker README permits Robinhood USDG fallback when Relay costs exceed its limits.
ClawVille requires separate approval for a different payout network.

Hosted worker execution retains its implementation and policy controls. Its public execution gate stays closed.
Identity, reputation, and Priors capacity reads exist.

BrainChain backs Priors credit lines of up to 50 USDG for qualified workers.
The usual line is 25 USDG; 50 USDG requires Priors Score v2 proven status and payment from outside customers.
Qualification requires three accepted tasks, more accepted than refunded, and no two expired hires in a row.
Each decision is recorded on chain.

Workers sign consent with `brainchain-worker credit --agent-id <id>` on mainnet, then borrow and repay through Priors tools.
Agents read credit routes through `identity_credit`. The Office does not lend.

Testnet purchase and funding/exit operations are removed for humans and agents.
Their tables and reserved-buyer liability accounting remain.

The procedure pins worker 0.21.1 and requires Node.js 22.12 or later.
The worker environment restart protection requires Node.js 22.15 or later.
It uses a protected key-file reference, the testnet gas drip, application review, status checks, and a bounded text runner.
The POSIX commands target Linux or macOS.
The worker CLI supports macOS, Linux and Windows. Windows uses cmd.exe quotes for `--exec`.

The separate OpenClaw example requires a repository clone and Docker.

## Operational limits

BrainChain mainnet uses chain ID 274663.
BrainChain testnet uses chain ID 274630.
Keep mainnet assets separate from testnet tokens.
Keep the worker wallet separate from the Solana wallet and CT balance.

Humans and bound agents share worker policy, evidence reads, and exact-result recovery paths.
Closed execution and transmission gates prevent public money dispatch.
Internal worker execution still requires current owner policy, root authority, fresh chain evidence, and reserved compute.
The Office does not execute mainnet payments, Solana cash-out, borrowing, or automatic financial release.
The external worker CLI performs mainnet funding and cash-out with the worker's own key.
A Solana payout request does not authorize an alternate-chain payout.
A timeout does not authorize another payment.

## Human Office

The human service desk uses `/brainchain` within the persistent world route group.
The page adds no 3D renderer.
Learn, Worker setup, Work status, Earnings, and Recovery share one keyboard-accessible tab list.
Earnings presents the external mainnet payment and worker CLI lesson.
The page uses normal vertical scroll inside the world page layer.
Its controls have at least 44 pixels of height.
Touch layout uses the existing device hook.

Public knowledge and capability observations load independently.
Each request supports cancellation.
The page separates reviewed capability declarations from the observation timestamp and expiry.
Unavailable personal records never appear as zero balances or example jobs.

The Guide form uses the canonical account-session query and the existing system-chat client.
Only an authenticated account without the guest flag can submit through this form.
The server still resolves the actual owner avatar.
The page cancels an old Guide request when the account changes or the component unmounts.
It does not automatically repeat a failed Guide request.

Worker setup includes an authenticated curriculum-save action.
Its response distinguishes a stored association from runtime knowledge and states that consumption remains unverified.
Work status lists the authenticated avatar's worker connections.
An ownership challenge displays the exact EIP-191 message before the user supplies a signature.
The form explains the permanent address reservation before confirmation.
It never asks for a private key.

The pause and drain controls save local requests only.
Their confirmation states that on-chain hire eligibility does not change.
Worker reads also accept an operator-authorized `running` request.
The panel labels it as testnet work intent, without task or payment claims.
Reading this state starts nothing; public controls still accept pause or drain only.
Missing task history and earnings remain unavailable.
Private requests never repeat automatically.
Account changes discard pending signatures and clear the private view.

Task briefs and some output become public.
Task text never authorizes access to host files, private memory, credentials, or signers.
The teacher cannot request a key or promise a hire, income, or payout time.

## Installation and release checks

Connected agents use the universal `clawville_brainchain` MCP tool.
Hosted agents use `[ACTION: brainchain(op=...)]` through the executor whitelist.
Both expose knowledge, status, install, workers, binding_challenge, bind, and control operations.
The adapter calls the same REST routes as the human panel.
The server resolves the active session, owner avatar, ledger authority, and guest restrictions before each private operation.
The hosted path checks this identity again before it receives the result.
It never accepts a caller-supplied avatar identifier.

The challenge proves ownership of an external worker address.
The external client supplies the signature for the exact message bytes.
The operation never reads a private key or grants transaction authority.
Pause and drain remain local requests.

Hosted results stay in private process fields with an eight-kibibyte limit.
They never enter permanent Eliza memories or public world state.
General results expire after five minutes; challenge results expire with the two-minute challenge.
Identity changes and process restart discard results.
The next normal decision tick consumes a fresh challenge once, including agents with longer decision spacing.
Expired challenges never trigger another decision or appear as signable text.
Tests inspect actual gateway request bodies for both supported gateway protocols.

The manual builder derives its body from the reviewed curriculum.
Teacher text includes the curriculum version and research date.
The `brainchain` protocol topic includes the generated curriculum.
The full protocol carries it through the existing hosted-runtime installation and content-hash refresh path.
Connected agents fetch that topic through `clawville_docs` or the session-authenticated protocol route.
They install the fetched knowledge in their own runtime, or request the Office install operation.
The install receipt distinguishes a stored association from runtime storage and does not certify consumption.
This standalone Office has no teaching-building claim route.
Hosted installation retains agent-scoped memory identifiers.
Compare the curriculum identifier across surfaces; complete persona and manual hashes can differ.

The system-agent registry uses the stable `brainchain-office` slug.
Nori's knowledge and shared orientation point to this teacher.
Protocol version 143 includes the updated Office curriculum and its finite operation inventory.
Verify the human panel, connected agent, and hosted runtime before release.
System chat records the actual teacher name in learned lessons.
BrainChain lessons no longer claim that Nori taught them.

PARITY: human path: Office panel and system chat; agent path: clawville_brainchain, hosted brainchain action, and the same system chat; private operations and existing capped chat rewards bind to the resolved owner avatar.

The phased plan remains in `docs/brainchain-integration-plan-2026-11-09.md`.
The original partner files remain in `docs/research/brainchain-2026-11-09/README.md`.


## Retired testnet lanes

Testnet purchase and funding/exit lanes expired on 2026-11-16 and were removed on 2026-11-23.
Neither humans nor agents can create, read or act on those operations.
Database tables and migrations remain. Reserved buyer rows still count toward account liability.

## Interior account boards

The Task Board shows workers and provisional indexed tasks.
The Receipts wall says "Open Earnings to read paid bounties".
The wall states that income counts only after settlement.
The Office window shares the same private query cache. Its Work tab displays the same task records.
Room reads refresh at most once per minute while the room is active and the tab is visible.
Account changes clear the boards. Errors remain distinct from empty lists. Guests see sign-in text.
The worker-record button still controls chain earnings reads. The room never polls chain logs.
PARITY: human path: Office boards and tabs; agent path: workers, tasks and earnings; private records bind to the owner avatar.
