# Codex Design Review: Two-Tier Custody Architecture

**Review date:** 2026-07-21

**Material reviewed:** `docs/custody-architecture-spec-2026-07-21.md`, `docs/wallet-infrastructure-review-2026-07-21.md`, and the referenced custody, x402, escrow, identity, withdrawal, redemption, wager, Hatcher, and database code.

## 1. VERDICT

**Sound-with-changes.** The architectural direction is correct: keep the permanent avatar/agent identity wallet as a small, self-controlled spending wallet for high-frequency signatures, and move durable balances and high-value authorities behind a policy-controlled remote signer. That is the only credible shape within the founder's constraints that preserves current addresses and avoids per-signature billing on micropayments. The proposal is **not safe to implement as written**, however. It overstates the spending ceiling as a security boundary even though all deposits still arrive there; retains an online legacy-key path that can bypass Turnkey; assumes a two-leg withdrawal can fit a one-transaction state machine; lacks a common reservation/locking model across payments, top-ups, and sweeps; understates Turnkey-tier signing, especially for composed bounties, redemption, and wagering; and does not yet define the canonical wallet for Hatcher-bound agents. These are blocking design defects, not implementation details. Resolve them before Phase T1.

## 2. Where the design is right

- **It preserves the immutable economic identity.** SAP identity registration derives the agent PDA from the existing avatar wallet, so changing that wallet would change the on-chain identity (`apps/api/src/services/sap/sap-identity-registrar.ts:701`, `apps/api/src/services/sap/sap-identity-registrar.ts:734`). Keeping it as the spending/identity signer is the right invariant.
- **It keeps micro-cadence signing off the billed tier.** Each custodial x402 payment signs an authorization with the payer key (`apps/api/src/services/custodial-x402.ts:37`, `apps/api/src/services/custodial-x402.ts:56`). Putting those signatures behind Turnkey would directly recreate the cost problem this architecture is intended to solve.
- **It is incremental.** The existing wallet table already has a durable subject-to-address identity and versioned encrypted secret material (`packages/database/src/schema/wallets.ts:37`, `packages/database/src/schema/wallets.ts:87`). A separately mapped vault can be added without changing the public wallet or violating the one-time-secret rule.
- **It correctly rejects treasury-funded SOL drips.** Fees, ATA rent, and operational SOL should be paid by the economic subject or explicitly charged back, not hidden as a treasury subsidy.
- **Per-user segregation is preferable to omnibus accounting.** It limits accounting ambiguity and makes recovery, reconciliation, and customer support tractable. It does not eliminate custody or regulatory obligations, but it reduces avoidable operational risk.
- **Lazy provisioning and staged migration are appropriate.** A vault should not be created for guests, empty dormant wallets, or records that do not represent a real economic subject.

## 3. BLOCKING concerns

### B1. The proposed `$10` hot ceiling is not a hard loss bound

**Failure scenario.** A user deposits $50,000 USDC to the permanent public identity/spending address. Before the asynchronous sweep confirms, a compromised API process, stolen spending key, or the user-held one-time secret transfers the deposit elsewhere. The sweep itself is authorized by the same spending key, so a compromised signer can also replace its destination. No Turnkey policy is involved until funds have already reached the vault. A fast sweep reduces exposure time; it does not cap exposure at $10.

**Required fix.** State the guarantee precisely: the ceiling is a **steady-state liquidity target**, not a maximum-loss bound. Add a second, optional secure vault deposit address for large deposits and direct all internal high-value credits to it. This does not change or invalidate the permanent identity address; both addresses can remain accepted. For deposits that still arrive at the identity address, use finalized-chain monitoring, destination-pinned sweep intents, alerts, and an incident freeze, while acknowledging the residual race. There is no cryptographic way to make an unrestricted Solana key both freely usable for x402 and unable to transfer a large inbound deposit.

### B2. Keeping the old key online would bypass the new custody boundary

**Failure scenario.** Funds are moved to Turnkey and protected by policies, but the original encrypted private key remains decryptable by the production API through the existing database and Cloudflare wrapping path. An attacker who compromises the API, database access, and wrapping service simply decrypts the legacy key and signs outside Turnkey. Current spending-wallet decryption supports both the legacy and envelope formats (`apps/api/src/services/keypair-vault.ts:292`, `apps/api/src/services/keypair-vault.ts:323`), while treasury keys are encrypted under the single legacy environment key (`packages/database/src/schema/treasury.ts:60`). Turnkey has become an additional signing route, not an enforcement boundary.

**Required fix.** Preserve the encrypted rows as required, but remove them from the normal production unwrap path after a verified import. Rewrap the recovery copy under an offline, independently administered 2-of-N recovery process; record an immutable custody-backend state; make fallback a break-glass ceremony rather than automatic runtime behavior; and rehearse export/restore to a clean signer. Production credentials that can transact must not also be able to export keys, mutate policies, or access the offline recovery wrapping keys.

### B3. The withdrawal design does not match the current state machine

**Failure scenario.** A withdrawal drains the spending wallet first, then Turnkey fails or rejects the vault leg. The user receives a partial withdrawal. A retry cannot safely determine whether to repeat the first leg because the current record represents one withdrawal with one unique transaction signature (`packages/database/src/schema/withdrawals.ts:72`, `packages/database/src/schema/withdrawals.ts:109`). The executor likewise constructs and sends one signed transaction (`apps/api/src/services/wallet-withdraw-executor.ts:1094`, `apps/api/src/services/wallet-withdraw-executor.ts:1141`). Treating the parent as complete would strand vault funds; rebuilding the whole request could double-send the hot leg.

**Required fix.** Model a parent withdrawal intent and immutable child legs per source wallet and asset. Each child needs its own amount, message hash, signer backend, signing activity identifier, transaction signature, claim/capture state, and reconciliation outcome. Reserve both legs before signing either. Expose `pending` and `partially_sent` explicitly. A parent is successful only after every required leg reaches the chosen finality; repair jobs retry only the unresolved child.

### B4. There is no common reservation boundary across spend, top-up, sweep, and withdraw

**Failure scenario.** Two unrelated x402 payments both observe sufficient hot balance, or a sweep removes funds after payment admission but before signing. The agent-pay mutex is keyed by the payment idempotency key and expressly does not serialize unrelated payments after admission (`apps/api/src/services/agent-pay.ts:649`, `apps/api/src/services/agent-pay.ts:858`). A concurrent low-balance observer can also create two top-ups for the same shortfall. Across API pods, an in-memory mutex is insufficient.

**Required fix.** Introduce one durable per-economic-subject, per-asset liquidity coordinator. All outgoing payment admission, withdrawal planning, top-up, and sweep operations must acquire the same database advisory lock in a fixed order and create reservations before releasing it. Use unique transfer-intent identities such as `(subject, asset, purpose, source_operation_id)`. Define available balance as finalized on-chain balance minus reserved and broadcast-unknown outgoing amounts. A retry must reuse the exact stored transaction/message and signer request; it must never recalculate a fresh amount or timestamp while the prior broadcast state is uncertain.

### B5. Turnkey price, policy, limit, and throughput assumptions are not yet procurement-grade facts

**Failure scenario.** The system is designed around `$0.01/signature`, rolling daily caps, and effectively unconstrained wallet creation. At implementation time, the plan costs five times as much, the desired rolling-rate policy cannot be expressed inside the enclave, or organizational resource limits require an unplanned hierarchy migration.

**Required fix.** Make a signed commercial quote, SLA/rate-limit schedule, resource model, policy proof, and export commitment a T0 gate. The current public [Turnkey pricing page](https://www.turnkey.com/pricing) advertises Pro at **$0.05/signature**, not $0.01, despite separate FAQ language about prices that “can” be lower. The [resource limits](https://docs.turnkey.com/reference/resource-limits) include limits per organization for wallets, private keys, and policies. The [Solana policy examples](https://docs.turnkey.com/features/policies/examples/solana) demonstrate recipient, program, mint, and amount checks, but do not establish a native rolling daily/value velocity limit. Treat any app-side velocity limit as defense in depth, not enclave-enforced protection. Prove default-deny policies against raw SOL, Token Program, Token-2022, ATA creation/closure, address lookup tables, and every transaction builder actually used.

### B6. The house wallet is a high-cadence operational wallet, not merely a treasury

**Failure scenario.** Coralia is moved to Turnkey on the assumption that it signs only low-frequency treasury actions. In the current composed bounty flow the house signs a pricing update for each bounty (`apps/api/src/services/sap/bounty-escrow-link.ts:540`, `apps/api/src/services/sap/bounty-escrow-link.ts:602`), the V2 settlement (`apps/api/src/services/sap/bounty-escrow-link.ts:735`), the permissionless finalize call (`apps/api/src/services/sap/bounty-escrow-link.ts:769`), and the house-to-hunter x402 payout (`apps/api/src/services/sap/bounty-escrow-link.ts:809`). That is four house signatures per successful bounty today, three even after moving permissionless finalize to a zero-value crank.

**Required fix.** Do not classify Coralia wholesale as a low-cadence Turnkey treasury. Split roles: Turnkey should hold durable bounty principal and any high-value authority; a strictly capped hot operational wallet may make the x402 payout; a no-value hot crank should perform permissionless finalize; and the per-bounty pricing transaction should be eliminated, cached, or explicitly budgeted. If the program architecture cannot split those duties, accept and price at least three Turnkey signatures per bounty rather than hiding them in the treasury estimate.

### B7. A single dollar ceiling ignores non-fungible operational obligations

**Failure scenario.** A generic sweeper removes SOL needed for SAP registration or wagering, or removes CLV that the withdrawal hold logic expects to find in the spending wallet. SAP registration requires a 0.06 SOL funding floor and then uses the avatar key for registration/attachment (`apps/api/src/services/sap/sap-identity-registrar.ts:56`, `apps/api/src/services/sap/sap-identity-registrar.ts:636`). Withdrawal enforcement currently evaluates the land CLV hold against that one custodial wallet (`apps/api/src/services/wallet-withdraw-executor.ts:1047`). Sweeping CLV to a vault could make a legitimate hold look underfunded or make the displayed withdrawable amount wrong.

**Required fix.** Define asset-specific bands and obligation-aware reservations, not one `$10 equivalent` scalar. SOL minimums must cover rent, base/priority fees, pending SAP operations, and any stake requirement without treasury subsidy. Do not sweep CLV until land holds, withdrawal checks, shop/economy reads, and reconciliation all understand both tiers. Escrowed/staked assets are neither hot nor vault “available” balance.

### B8. The canonical economic subject is ambiguous for connected agents

**Failure scenario.** Hatcher provisioning creates an `agent` wallet (`apps/api/src/routes/partner-hatcher.ts:1014`), while the wallet service independently supports both avatar and external-agent owners (`apps/api/src/services/wallet-service.ts:10`). Other money flows operate on the bound avatar wallet. A lazy vault keyed to whichever row a caller supplies can create two vaults for one agent/avatar pair, strand funds on an unbound agent record, or settle leaderboard/economy actions to the wrong identity.

**Required fix.** Key custody tiering to the canonical **avatar/economic subject**, with one designated immutable identity/spending wallet. Resolve every human and connected/hosted-agent route through that subject before selecting a vault. Classify existing agent-owner wallet rows as identity, non-economic, migration alias, or orphan via a migration report; do not infer. Guests receive no vault. Add Hatcher contract-harness cases for bind, top-up, balance, payout, and withdrawal so E5 parity is real rather than route-level only.

### B9. Remote signing is not a one-function substitution

**Failure scenario.** Phase T1 replaces the common wallet loader, but treasury and Anchor flows still require an in-process `Keypair`. The wager client decrypts and caches the settlement authority as a `Keypair` (`apps/api/src/services/wager-program-client.ts:317`) and uses that signer for lock and settle (`apps/api/src/services/wager-program-client.ts:943`, `apps/api/src/services/wager-program-client.ts:990`). Earned redemption directly decrypts backing and swap-wallet keys (`apps/api/src/services/earned-redemption.ts:666`, `apps/api/src/services/earned-redemption.ts:1214`). A partial migration either leaves bypasses or breaks these flows.

**Required fix.** Inventory every signer and introduce a transaction-building/signing contract that supports local and asynchronous remote signers, partial signatures, Versioned Transactions, address lookup tables, signer ordering, and durable capture of the signed bytes before broadcast. Migrate one signer class at a time with parity tests. Do not present `loadAvatarWalletForSigning` as the sole seam.

## 4. Answers to the eight open questions

### Q1. Per-user vault or omnibus vault?

**Recommendation: per-user, lazily provisioned, on-chain-segregated vaults keyed to avatar/economic subject.** Do not use an omnibus customer-funds wallet. Per-user segregation makes ownership, recovery, incident containment, and reconciliation clearer, and avoids converting every bug into an internal-ledger solvency event. It is not operationally negligible: USDC and CLV ATAs consume rent; organizational limits, policies, and sub-organization/account hierarchy must be designed up front; and “wallet” has multiple meanings in Turnkey's resource model. Prefer deterministic HD accounts only if Turnkey confirms policy isolation, exportability, and audit behavior are equivalent. Otherwise use separate private keys/sub-organizations and shard deliberately. A vault must not be provisioned until the avatar binding is final.

### Q2. How should SAP escrow funding interact with the two tiers?

**Recommendation: the immutable spending wallet remains the SAP identity and escrow depositor; the vault is only a funding source.** The current registrar binds the agent PDA to the avatar wallet address (`apps/api/src/services/sap/sap-identity-registrar.ts:734`), and current composed escrow expects the creator to fund V2 (`apps/api/src/services/sap/bounty-escrow-link.ts:427`). For amounts beyond hot available liquidity, create a durable bridge intent. Prefer one atomic Solana transaction containing vault-to-spending funding plus spending-to-escrow funding, co-signed by Turnkey and the spending key, after proving the program and policy support it. If atomic composition is not possible, use a reserved two-step state machine: confirmed vault top-up, then immediate spending-wallet escrow deposit, with no unrelated spend admitted between them. Never change the SAP depositor/identity to the vault merely to reduce orchestration.

### Q3. Where should the house/treasury line sit?

**Recommendation: draw the line by retained authority/value, not by the label “house.”** Durable pooled principal, redemption backing, swap inventory, fee treasury, and wager settlement authority belong in Turnkey. High-frequency, narrowly purposed transfer wallets may remain hot only with strict asset-specific caps and replenishment from Turnkey. Coralia currently mixes durable authority with per-bounty operations: pricing, settlement, finalize, and x402 payout. Split it before migration. Put principal/authority in Turnkey; move permissionless finalize to a zero-value hot crank; eliminate or amortize the pricing update; and use a capped hot payout wallet for the final x402 leg if program semantics permit. If they do not, budget three Turnkey house signatures per completed bounty after the crank change (four today), and call that a business decision rather than low-cadence treasury signing.

### Q4. Who funds SOL fees, ATA rent, and operational float?

**Recommendation: preserve the no-treasury-drip rule and make costs attributable to the subject.** Maintain an asset-specific SOL reserve in the spending wallet funded from the user's SOL or a user-authorized USDC-to-SOL conversion. Where a vault transfer needs both signatures, use the spending wallet as fee payer when possible so the vault does not need a free SOL drip. Charge ATA creation and exceptional priority fees to the user/agent transparently. Turnkey supports Solana gas/rent sponsorship, but its own [rent-sponsorship guidance](https://docs.turnkey.com/features/networks/solana-rent-refunds) warns about rent-extraction risk; using it without exact metering and chargeback would violate the founder ruling. A fixed “small SOL float” is inadequate during fee spikes or for SAP's 0.06 SOL registration floor.

### Q5. How can the sweep destination be made tamper-evident on Solana?

**Recommendation: use layered detection and do not claim prevention.** Solana has no native restriction that prevents an ordinary key from signing a direct SOL/SPL transfer, and an SPL delegate is revocable by the owner. Store the vault mapping append-only in the database, require a vault-key-signed certificate binding `(avatar_id, identity_wallet, vault_wallet, mint ATAs, version)`, and anchor the certificate hash in an independently controlled append-only log or small on-chain PDA/Memo record. Monitors should reject any sweep whose exact destination ATA and certificate version do not match, and separately reconcile chain history. Signer credentials must be unable to mutate the mapping. This makes destination changes evident and auditable, but a stolen hot key can still bypass the sweeper. Only a separate secure deposit address or an on-chain restricted custody program removes the large-inbound race; the latter conflicts with current x402/address constraints.

### Q6. What should happen during a Turnkey outage or backend compromise?

**Recommendation: degrade, queue, and fail closed—never silently fall back to legacy keys.** During a Turnkey outage, already-funded hot x402 payments continue until the subject reaches its reserved floor. Vault withdrawals, top-ups, large escrow funding, redemption, and vault-tier treasury operations queue with clear status. Sweeps should pause if the system cannot verify the destination and vault health; they must not pile funds into an uncertain transfer state. A compromised API should be limited to the hot balance plus inbound/transit exposure and only the vault transactions allowed by immutable Turnkey policies. Policy administration, key export, and transaction signing require different credentials and preferably different operators. Unknown broadcast outcomes must reconcile by stored signature/message before retry.

### Q7. Does per-user Turnkey custody materially change the legal/regulatory posture?

**Recommendation: assume no favorable change without counsel.** Per-user wallets improve accounting and evidence but ClawVille still controls transaction initiation and user access. Turnkey describes itself as non-custodial key-management infrastructure; that does not make ClawVille non-custodial. Product language must accurately describe custody, withdrawal availability, freezes, and recovery. Obtain counsel on money-transmission/custody, sanctions screening, transaction monitoring, and jurisdictional restrictions before enabling the currently dark withdrawal and redemption surfaces. Architecture should retain complete subject, source, destination, policy-decision, and operator audit trails.

### Q8. What parity and integration changes are required?

**Recommendation: make custody a shared service below every human and agent route, then gate rollout on vertical-specific parity tests.** Human and connected/hosted-agent sessions must resolve to the same bound avatar/economic subject; Hatcher's separate agent wallet cannot become an accidental second economy. Guests remain demo/off-chain and must not receive vaults. Internal top-ups and sweeps must not create leaderboard events. SAP identity remains bound to the permanent spending wallet. Land/CLV holds and visible balances must aggregate tiers correctly. The withdrawal route already supports human and agent authentication while excluding guests (`apps/api/src/routes/wallet-withdraw.ts:37`), but the execution model must gain multi-leg semantics. E3 is currently **dark**, despite the spec's economy table describing it as live (`apps/api/src/services/earned-redemption.ts:1`); enabling it requires remote-signer and accounting coverage first. Wagering requires an asynchronous remote-signer adapter. The partner contract/harness and agent-facing protocol must test the same outcomes as the human UI before rollout.

## 5. Race and consistency analysis of the tiering mechanics

### Required accounting model

Use one durable state machine for every inter-tier movement:

`planned -> reserved -> signing -> signed -> broadcast_unknown -> confirmed -> finalized`

with terminal `failed`, `cancelled`, and `reconciled` outcomes. Persist the source/destination, mint, amount, blockhash/expiry, message hash, exact signed bytes or deterministic signature, Turnkey activity ID, originating operation, and confirmation slot. A signed or broadcast-unknown transfer must never be rebuilt automatically; query the signer and chain first.

The user-facing balance must distinguish:

- **Total assets:** finalized spending + finalized vault + recognized escrow/stake positions.
- **Available to spend:** finalized liquid assets minus holds, reservations, rent/fee floors, and broadcast-unknown outgoing amounts.
- **Pending:** inbound/outbound transfers not yet final.

A naive `spending + vault + escrow` sum will double-count an in-flight top-up/sweep if the source debit and destination credit are observed at different RPC slots, and it will mislabel escrow/stake as spendable. Read related token accounts with a consistent commitment/context slot where possible, then overlay durable reservations.

### Top-up versus concurrent spends

Under the same per-subject/per-asset database advisory lock, payment admission must reserve the intended spend before deciding whether a top-up is needed. Compute:

`hot_available = finalized_hot - reserved_out - broadcast_unknown_out - operational_floor`

If insufficient, create exactly one top-up tied to the source operation and refill to an asset-specific target band, not merely the observed shortfall. The payment waits for the top-up's required finality and consumes its reservation. Unrelated payment admissions cannot spend the reserved liquidity while the bridge is in progress.

### Double top-up under retry

Use a unique database key on `(economic_subject, asset, purpose, source_operation_id)` plus at most one active general liquidity-adjustment intent per subject/asset. Persist the exact Turnkey request body and activity ID before retrying. If the request embeds a timestamp or expiry, a retry that regenerates it is a new signature request, not an idempotent replay. A worker lease can be retried; the economic intent cannot be duplicated.

### Sweep versus in-flight payments

Sweep only:

`finalized_hot - all_reservations - operational_floor - target_ceiling - dust_threshold`

The sweep obtains the same lock as payment and withdrawal admission. It must exclude newly confirmed deposits that are already reserved for an immediate operation, and it must not run while signer/destination verification is unhealthy. Once signed, the swept amount remains pending outbound until finality. A blockhash expiry requires signature/history reconciliation before constructing a replacement.

### Deposit then immediate spend

Do not admit a spend against a merely observed/unconfirmed deposit. Once the deposit reaches the selected commitment, reserve it for the requested spend under the same lock. The sweep sees the reservation and leaves it in place. For a large SAP deposit, prefer the atomic co-signed vault-to-hot-to-escrow transaction or the explicit bridge state machine described in Q2.

### Withdrawal consistency

Plan hot and vault legs from one locked snapshot; reserve both before either broadcast. Deduct pending legs from available balance immediately. If one leg finalizes and another is blocked by Turnkey, show the exact delivered and outstanding amounts. Do not compensate by automatically pulling the delivered leg back. Reconciliation should be transaction-signature-driven, not based solely on later balance differences.

### Turnkey outage windows

- **Before signing:** keep the reservation and queue or cancel safely after an explicit expiry.
- **After Turnkey accepts but before the response is stored:** recover by request fingerprint/activity lookup; do not submit a fresh request.
- **After signing but before broadcast:** retrieve/capture the same signed transaction and broadcast it.
- **After broadcast with timeout:** query signature history and recent blockhash validity before replacement.
- **Extended outage:** micro-spending continues only within already funded hot liquidity. Stop promising immediate vault withdrawals/top-ups and expose degraded status. Never activate the legacy online key as an automatic fallback.

### Multi-process locking

The escrow gate already demonstrates the correct direction by combining process coordination with PostgreSQL advisory locking (`apps/api/src/services/sap/escrow-gate.ts:170`). Tiering needs an equivalent common lock spanning services, not separate mutexes in agent-pay, withdrawals, and sweep workers. Lock ordering must be documented to avoid deadlocks when one operation touches spending, vault, and treasury subjects.

## 6. Economics and signature-population check

The specification's “low thousands/month” Turnkey-signature estimate is not validated by the actual flow graph. It may be true at low volume, but the current document does not supply the activity counts needed to establish it and omits several cadence multipliers.

### Signatures that should remain on the hot/self-controlled tier

- **Agent-pay/custodial x402:** one payer signature for every micro-payment (`apps/api/src/services/custodial-x402.ts:56`).
- **Direct/legacy PayAI payment:** one payer signature for each signed x402 payload; the facilitator sponsors settlement fees but does not replace the payer authorization (`apps/api/src/services/x402-payai.ts:300`, `apps/api/src/services/x402-payai.ts:402`).
- **SAP identity issuance:** currently two spending-wallet transactions per new avatar—registration and metadata attachment—and requires the SOL floor (`apps/api/src/services/sap/sap-identity-registrar.ts:636`).
- **SAP creator funding, refund, and dust reclaim:** creator/identity signatures unless a large funding bridge involves a vault co-signature (`apps/api/src/services/sap/bounty-escrow-link.ts:795`).
- **Hot-to-vault sweeps:** one hot signature each. They create no Turnkey signature because Turnkey is only the recipient.
- **Permissionless finalize/crank calls:** move these to a zero-value hot crank rather than paying Turnkey to sign them.

### Signatures that land on the Turnkey/billed tier

- **Per-user top-ups:** one vault signature per confirmed refill. The count depends on target bands and micropayment velocity, not merely user count.
- **Vault withdrawal legs:** one vault signature per asset/source leg, plus any separate token-account setup transaction not composed into the transfer.
- **Composed bounty house path:** four house signatures per successful bounty in the code today—pricing update, settle, finalize, and x402 payout. Moving permissionless finalize off the house reduces this to three, not zero (`apps/api/src/services/sap/bounty-escrow-link.ts:602`, `apps/api/src/services/sap/bounty-escrow-link.ts:735`, `apps/api/src/services/sap/bounty-escrow-link.ts:769`, `apps/api/src/services/sap/bounty-escrow-link.ts:809`). Refund/recovery paths add signatures.
- **Earned redemption:** currently one backing-wallet funding signature, one swap signature per clipped Jupiter purchase, and one delivery signature. Swap clips are capped at $100 (`apps/api/src/services/clv-swap-live.ts:1623`) and each clip is separately signed (`apps/api/src/services/clv-swap-live.ts:1941`), followed by delivery (`apps/api/src/services/earned-redemption.ts:1214`). For buy amount `A`, the nominal count is `2 + ceil(A / $100)` vault-tier signatures, before setup/recovery. This flow is dark today (`apps/api/src/services/earned-redemption.ts:1`).
- **Wager authority:** at least one authority signature for lock and one for settle, plus cancel/refund/recovery actions (`apps/api/src/services/wager-program-client.ts:943`, `apps/api/src/services/wager-program-client.ts:990`). If matches are frequent, this is billed at match cadence, not treasury cadence.
- **Other treasury transfers and policy-authorized operational recovery:** one or more per transaction, depending on whether ATA creation or multi-step swaps can be composed.

An auditable monthly forecast should therefore use at least:

`S_vault = topups + vault_withdrawal_legs + (3 or 4) * completed_bounties + bounty_recovery_signatures + sum_redemptions(2 + ceil(amount/100)) + wager_authority_actions + treasury_operations`

Land, vCLAW-only Cove/activity/shop operations, and leaderboard events do not create chain signatures today. They should not be labeled vault-tier signature candidates unless a future on-chain action is specified.

At the public Pro price of $0.05/signature, 100,000 vault signatures cost $5,000 before base fees, not $1,000. Enterprise rates may be materially lower, but they must be modeled from a written quote. The exact micro-cadence traps are **house bounty actions and wager authority actions**; redemption clipping is a second multiplier at higher redemption sizes. The design should include low/base/high monthly activity scenarios before vendor commitment.

## 7. What's missing

### Solana account and fee mechanics

- **ATA rent and ownership:** every per-user vault may need USDC and CLV ATAs. Record who pays, when accounts are created, whether empty accounts are closed, and where reclaimed rent goes. Turnkey recipient policies may need the destination ATA, not merely the owner's wallet address.
- **Token variants:** test the exact Token Program/Token-2022 instructions, transfer-checked semantics, transfer-fee tokens, ATA program, address lookup tables, and Jupiter transaction shapes. Reject unknown programs by default.
- **Fee volatility:** SOL target bands must respond to base/priority fee conditions and upcoming operations. A fixed float can strand an otherwise funded account.
- **Dust and partial sweeps:** set per-asset minimums, preserve SOL rent/fee reserves, and reconcile dust instead of repeatedly generating uneconomic sweeps.
- **Finality and RPC divergence:** define confirmed versus finalized policy for each operation and use more than one RPC for reconciliation of high-value/unknown transactions.

### Turnkey operations and security

- **Resource hierarchy and scaling:** decide organization/sub-organization/private-key/HD-account layout, policy count, sharding, and how an avatar is located if the main database is unavailable.
- **Rate limits, latency, and SLA:** benchmark burst signing for top-up storms, bounty settlement, and withdrawal; add bounded queues, circuit breakers, and user-visible degradation.
- **Import ceremony:** use a quarantined worker and one-time import path; log public-key equality; canary with small funds; prohibit clipboard/plaintext files; revoke import credentials; and independently verify the encrypted offline recovery artifact.
- **Credential separation:** transaction signers must not edit policies, add authenticators, export private keys, or change vault mappings. Root recovery requires a separate quorum and hardware-backed operator authentication.
- **Policy change control:** policy edits need versioned review, delay where supported, independent alerting, and an emergency freeze path. A compromised application must not be able to loosen its own limit.
- **Provider exit/disaster recovery:** Turnkey documents its own [disaster-recovery model](https://docs.turnkey.com/security/disaster-recovery), but ClawVille still needs periodic export verification, an address-preserving restore runbook, a maximum recovery-time objective, and a tested ability to sign with the offline recovery copy if Turnkey disappears.

### Environment and rollout

- **Separate organizations by environment:** production mainnet and staging/devnet must use separate Turnkey organizations, credentials, policies, webhooks, and recovery artifacts. Turnkey's SVM broadcast documentation supports devnet/testnet, but that does not validate every product flow.
- **The withdrawal staging gate is presently contradictory:** the route requires a staging smoke before enablement (`apps/api/src/routes/wallet-withdraw.ts:1`), while the executor is mainnet-only (`apps/api/src/services/wallet-withdraw-executor.ts:54`). Resolve this with a guarded devnet executor or an explicitly documented non-value harness before enabling dark withdraw.
- **Migration reconciliation:** before import, prove `wallet.address == derived(imported key) == avatar/agent mirror`; after import, sign a non-value challenge and a canary transfer; only then move funds. Record every orphan, duplicate subject, and mirror mismatch.
- **Rollback semantics:** after funds enter a vault, rollback means switching the signing adapter or restoring the same key/address—not reverting the database migration or creating a new address.

### Product, accounting, and partner behavior

- **Proof of liabilities and solvency:** daily reconciliation must compare per-subject hot + vault + escrow assets to internal obligations, with aggregate treasury/backing reconciliation and alarms for unexplained deltas.
- **Canonical subject model:** explicitly cover human-owned avatars, Hatcher/hosted agents, external agents, unbound agents, deleted accounts, merged/bound identities, and guests.
- **Hatcher incident behavior:** define what a partner agent sees when top-up or Turnkey is degraded, and ensure retries preserve the partner's idempotency keys. Run the protected Hatcher harness before staging promotion.
- **Balance semantics:** UI/API/tool surfaces need total, available, held, and pending values; a single undifferentiated number is misleading during bridges and escrow.
- **User-held spending secret:** humans may still independently drain their spending wallet using the once-disclosed key. That is intentional self-custody for Tier 1, but reconciliation and support must treat external user signatures as first-class events, not theft by default.
- **Legal and incident response:** document sanctions/abuse controls, freeze authority, disclosure language, audit retention, key-compromise notification, and who can authorize break-glass recovery.
- **Observability:** measure time above target ceiling, maximum transient hot exposure, top-up/sweep failure rate, signer latency, broadcast-unknown age, policy denials, vault reconciliation deltas, and billed signatures by flow—not only aggregate signatures.

## 8. Alternative within the founder's constraints

A materially safer variant exists, but it is an evolution of the proposed architecture rather than a different custody model:

1. Keep the permanent identity/spending address exactly as it is for SAP identity, x402, low-value operations, and backward-compatible deposits.
2. Give each economic subject a second, explicitly labeled secure vault deposit address. Show it for large deposits and route all new internal high-value credits, bounty principal, redemption proceeds, and treasury-originated user credits there.
3. Maintain asset-specific hot target bands with durable reservations. Refill from the per-user Turnkey vault; sweep legacy inbound excess from hot when safe.
4. Keep no online legacy-key bypass. Retain an offline, independently wrapped recovery copy and rehearse address-preserving provider exit.
5. Split treasury authorities from operational hot roles, especially Coralia and the wager crank.

This variant respects one vendor, permanent existing addresses, no Steward, no per-signature charge on x402 micropayments, and no treasury SOL drips. Its advantage is that large users and internal flows can avoid the unbounded hot-deposit race. It does not eliminate risk for deposits sent to the legacy identity address, so both the UI and threat model must say so.

If a second deposit address is rejected, there is no materially better architecture within the stated constraints. The proposed two-tier system remains useful for reducing **time-weighted and steady-state** hot exposure, but it cannot honestly promise a hard hot-wallet loss cap. A program-controlled vault or multisig restriction could provide a stronger boundary, but it would add a second custody mechanism, complicate standard x402 transfers, and conflict with the requirement that the current identity address remain the freely signing micro-payment wallet.

## Decision gates before implementation

The following are the minimum architecture gates implied by this review:

1. Reframe the hot ceiling and decide whether to expose a secure large-deposit address.
2. Approve the canonical avatar/economic-subject mapping, including Hatcher and legacy agent rows.
3. Design parent/leg withdrawal and the common reservation/transfer-intent state machine.
4. Split or explicitly price Coralia's per-bounty signing duties; inventory every remaining signer.
5. Specify asset-aware floors/holds, particularly SAP SOL and land CLV.
6. Obtain written Turnkey pricing, limits, SLA, export, and policy capabilities; prove policies against real serialized transactions.
7. Approve offline recovery/import ceremonies and credential separation that prevent the legacy key from bypassing Turnkey.
8. Produce low/base/high signature and on-chain fee models from actual event volumes.

Until all eight gates have owners and acceptance evidence, Phase T1 should remain a design exercise rather than a production migration.
