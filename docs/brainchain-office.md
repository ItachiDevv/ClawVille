# BrainChain Office

Last Audited: 2026-11-09

Drift note: This overview now distinguishes implemented preparation, reads, policy controls, and recovery from closed execution gates.

The Office teaches BrainChain task work and its current limits.
It uses the same reviewed curriculum for humans, connected agents, and hosted agents.
The source includes owner-bound test purchase preparation, worker policies, a scheduler, isolated cognition, and exact-result recovery.
Public worker execution and payment transmission remain disabled.
The Office also teaches a pinned testnet procedure for a separately authorized operator.
Research statements describe the 9 November 2026 snapshot.
They do not establish current partner availability.

## Canonical knowledge

`packages/shared/src/constants/brainchain.ts` holds the curriculum, network identifiers, capability evidence, and deterministic manual builder.
`packages/agent-templates/src/locations/brainchain-office.ts` defines the Office teacher.
Its knowledge derives from the shared curriculum.
Its instructions keep task text outside trusted instructions.

The curriculum separates five evidence states:

| State | Meaning |
| --- | --- |
| `available` | The reviewed Office knowledge exists in this release. |
| `source-present` | Reviewed source contains the feature; no ClawVille transaction proves its outcome. |
| `not-verified` | Documentation or a proposal exists; the required end-to-end evidence does not. |
| `unavailable` | The reviewed release disables the feature. |
| `planned` | ClawVille does not implement the action in this release. |

Solana funding remains `source-present`.
Solana task purchase remains `not-verified`. Mainnet offers RH USDG and Base USDC. The refreshed testnet quote also offers Solana devnet; ClawVille has no verified Solana adapter settlement.
Mainnet Solana cash-out remains `unavailable`; the reviewed worker README disables fast exits.
Hosted worker execution has durable implementation and policy controls, while public status still reports executionEnabled=false.
Identity, reputation, and Priors capacity reads exist. Borrowing and credit issuance remain unavailable.
Testnet purchases support Base Sepolia and Solana devnet drafts, unpaid quotes, captured-byte recovery, and bounded payment-history discovery.
Funding and parent-exit preparation retain immutable operations and liabilities. Their transmission gate remains closed.
These implementations do not establish a genuine task settlement, destination payout, or release approval.
The procedure pins worker 0.19.2 and requires Node.js 22.15 or later.
It uses a protected key-file reference, the testnet gas drip, application review, status checks, and a bounded text runner.
The POSIX commands target Linux or macOS.
The official OpenClaw example requires Docker and does not establish Windows support.

## Operational limits

BrainChain mainnet uses chain ID 274663.
BrainChain testnet uses chain ID 274630.
Keep mainnet assets separate from testnet tokens.
Keep the worker wallet separate from the Solana wallet and CT balance.

Humans and bound agents share worker policy, purchase preparation, funding/exit preparation, evidence reads, and exact-result recovery paths.
Closed execution and transmission gates prevent public money dispatch.
Internal worker execution still requires current owner policy, root authority, fresh chain evidence, and reserved compute.
Mainnet money movement, Solana cash-out, borrowing, and automatic financial release remain unavailable.
A Solana payout request does not authorize an alternate-chain payout.
A timeout does not authorize another payment.

## Human Office

The human service desk uses `/brainchain` within the persistent world route group.
The page adds no 3D renderer.
Learn, Worker setup, Work status, Hire help, Earnings, and Recovery share one keyboard-accessible tab list.
The page uses normal vertical scroll inside the world page layer.
Its controls have at least 44 pixels of height.
Touch layout uses the existing device hook.

Public knowledge and capability observations load independently.
Each request supports cancellation.
The page separates reviewed capability declarations from the observation timestamp and expiry.
A returned payment offer never enables a purchase button.
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
Current protocol version 127 includes the Office topic and its finite operation inventory.
Verify the human panel, connected agent, and hosted runtime before release.
System chat records the actual teacher name in learned lessons.
BrainChain lessons no longer claim that Nori taught them.

PARITY: human path: Office panel and system chat; agent path: clawville_brainchain, hosted brainchain action, and the same system chat; private operations and existing capped chat rewards bind to the resolved owner avatar.

The phased plan remains in `docs/brainchain-integration-plan-2026-11-09.md`.
The original partner files remain in `docs/research/brainchain-2026-11-09/README.md`.


## Base Sepolia test purchases - last audited 2026-11-09

Drift note: Hire help now provides private draft, quote, authorization, and recovery controls through the same owner service. Signing and submission remain disabled until independent payment review and authorized test-token proof. The public quote never opens a payment control by itself.

The human signs in and opens Hire help. The draft requires explicit consent to publish its brief. The panel stores a stable retry key until it receives the draft response. It uses an unpaid quote before any authorization. Each current reviewed quote costs one Base Sepolia test USDC; test tokens have no cash value. Guest sessions cannot save personal drafts.

The owner selects BrainChain in the existing spend rules. Unset limits refuse. The service keeps separate buyer/vendor records but uses one shared account liability total. Buyer test authorizations consume the same six-decimal budget units as vendor USDC. They do not represent production token movement. It serializes cap admission with the existing spend-policy lock. Reserved, captured, uncertain, reorganized, and provisionally refunded liabilities carry across UTC days. Vendor pending/ambiguous liabilities carry across UTC days. Paid vendor rows count on their UTC day; failed vendor rows do not count. Provisional buyer payment/refund observations remain held across days. Each authorization counts once. An agent cannot raise limits. If the policy requires approval, the owner signs the exact purchase message with the linked Solana wallet before unsigned payment terms become available.

The external EVM payer connects on Base Sepolia. The service verifies the fixed USDC contract name, decimals, domain separator, recipient, EOA code, balance, network, and canonical block. The payer signs the exact application intent and USDC TransferWithAuthorization. The intent binds the avatar, order, public body hash, quote hash, resource, amount, recipient, nonce, expiry, and permanent avatar association. This consent grants no worker-signing or mainnet authority.

The browser sends signatures directly to the private capture endpoint. The service encrypts the exact payment header with authenticated owner/order/purpose context. GET responses omit ciphertext and signatures. Model tools refuse capture and human-approval paths; connected clients use direct REST from the external signer. Hosted results omit task prose, typed terms, ciphertext, and signatures. Account changes abort pending browser requests.

Submission commits one generation and an uncertain liability before HTTP dispatch. The fixed-origin client checks session, policy, lease, human-approval expiry, and token-authorization expiry after DNS validation. A post-claim failure keeps the liability. The service cannot atomically revoke an authorization already delivered to the desk or external payer. No automatic retry exists.

A known desk order uses reconciliation. An unknown order may use explicit identical-byte recovery only while the original authorization and current authority remain valid. Recovery retains the original hold. Expiry alone never proves non-use. The service never substitutes another network or maps an unknown task board to the current board.

Receipt verification requires the exact token, amount, direction, nonce-use event, canonical receipt block, fresh head, and twelve confirmations. Refund verification also requires a full desk-to-payer transfer after the matched payment. Receipt reuse across orders refuses. Stored payment and refund hashes remain subject to rechecks when the desk omits them. A failed recheck suspends the observation. All observations remain provisional. The carry hold remains after a provisional refund until separately reviewed finality proof exists. No operator release API exists in this increment.

Human path: `/brainchain` Hire help. Connected/hosted agent path: `clawville_brainchain` purchase operations and the protocol 123 `brainchain` action. Direct external clients use `/api/brainchain/purchases/:id/capture` for EVM signatures. Canonical cookie or live bound-session resolution selects the owner avatar. The API rechecks live identity after waits and never accepts a body avatar ID as authority.

Verification: controlled quote/signature/RPC tests, guarded PostgreSQL race/crash tests, real Lucia route composition, MCP route inventory, gateway receipt transport, browser typed-data validation, and public/private panel tests. These fixtures use no live token transfer or provider credential. Device screenshots and independent money-path review remain release gates.


### Purchase audit corrections - last audited 2026-11-09

Human approval now stores the exact linked wallet and its monotonic authority version. Migration 0110 increments the version when the wallet or its proof timestamp changes. Rotation, unlink, and wallet reuse cannot restore an old approval. Legacy approval rows without the tuple refuse. Fresh proof can renew approval for the same frozen payment. The human panel provides Approve account spend for a captured order; Submit remains disabled until approval is current.

One shared liability query governs buyer and vendor admission under the existing avatar spend-policy lock. Vendor pending/ambiguous rows remain held across days. Vendor paid rows count for their UTC day. Provisional buyer payment and refund observations remain held until a separately reviewed finality/release path exists. Buyer records never also enter the vendor ledger, so the same authorization does not count twice.

The service uses the existing retained database pool through getPostgresClient. It explicitly normalizes timestamp reads and text-typed JSON/time writes for the installed Drizzle/postgres.js composition. A controlled child test exercises the actual default buyer factory, not only raw-driver fixtures. No extra production pool or credential source exists.

PARITY: the same owner tuple, approval revocation, and shared cap apply to human and bound-agent REST paths. Only the human owner supplies account approval. External EVM signatures and captured payment bytes remain unchanged.

## Solana devnet purchase adapter - Last Audited 2026-11-09

Drift: Hire help now offers an explicit Solana devnet draft network beside Base Sepolia.
The adapter preserves the shared account cap and linked-wallet authority checks.
An external devnet payer signs the exact task intent and transaction; the account wallet can differ.
Both token accounts must already exist. The Office gives an account-specific refusal when either account is absent.
Capture stores immutable transaction bytes before submission. Recovery never replaces an uncertain transaction.
The fee payer supplies the first signature; the payer signature alone is not a transaction identifier.
Finalized receipt checks retain the carry hold until a separate reviewed release transition.
Signing and submission remain disabled. No genuine Solana payment or refund is proved.
See docs/brainchain-solana-purchase.md for the exact network, byte checks, tests, and release gates.
PARITY: human network selector and external wallet; bound-agent purchase operations and private signature capture; both bind the current non-guest avatar.

## Missing-ID buyer recovery - Last Audited 2026-11-09

Drift: a Solana timeout without identifiers now has Search original payment history.
The same purchase_reconcile operation serves bound agents through their own avatar.
The server scans only captured account history with bounded private progress. Empty or unavailable history retains the full hold.
A verified payment remains separate from an attributed desk order or task.
Refund budget release remains unavailable without verified joint order/payment/refund/amount/network attribution.
The human form now submits task levels best-first, with pass before fail. Agent callers retain their supplied array order.
PARITY: human history control and bound-agent reconciliation share the private order service and explicit release refusal.
See docs/brainchain-buyer-recovery.md for limits, evidence, and tests.


## Testnet funding and exit preparation - Last Audited 2026-11-09

Each connected testnet worker has a private funding and exit panel. It accepts exact atomic-unit limits and reserves the source nonce before disclosure. The current linked account approves separately from the external worker signer. Humans can inspect exact external signature instructions and save externally signed bytes. Bound agents use the same owner service through funding operations and the private capture endpoint. Source receipts and desk status remain separate from unresolved destination evidence. Desk fee and destination minimum are approved quote limits, not atomic payout guarantees. All liabilities persist. Submission remains disabled. Solana conversion and exit remain unavailable. See docs/brainchain-funding-exit.md for the full contract. Browser/device verification remains outstanding. PARITY: human worker panel and bound-agent funding tools resolve the same avatar. Drift: durable testnet preparation and held-exit observations now have a shared private path.
