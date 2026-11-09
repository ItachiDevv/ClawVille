# BrainChain Solana devnet purchase adapter

Last Audited: 2026-11-09. Status: local implementation; independent review and activation remain required.
Drift: The unpaid devnet offer now has a distinct external-payer adapter. It does not establish settlement.

## Fixed interface

The captured offer names network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
The fixed RPC is `https://api.devnet.solana.com`.
An unsigned genesis read returned `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` on 9 November 2026.
The adapter verifies that full hash before reads.
The USDC mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` with six decimals.
The amount is exactly 1000000 atomic units.

The desk recipient is `AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi`.
The fee payer is `BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP`.
The offer lifetime cannot exceed 300 seconds.
The adapter accepts only the fixed testnet desk endpoint.
Mainnet Solana, Token2022, fallback assets, and automatic account creation remain unsupported.

## Consent and transaction bytes

The account owner selects the BrainChain vendor and spend limits.
The service reserves the same shared account liability as Base orders and existing vendor payments.
The account approval binds the current linked wallet and authority version.
The external devnet payer can differ from that linked wallet.
The external payer signs a readable task intent before the transaction.
Neither consent substitutes for the other.

The exact sequence is: reserve liability, obtain required account approval, expose unsigned terms, then request the external signatures.
The browser signs the domain-bound payer intent before the transaction.
The server requires both proofs at capture.
The server does not require a separate payer-intent proof before unsigned-term disclosure.
Unsigned bytes alone confer no spend authority.

The intent binds the avatar, order, task hash, quote hash, network, genesis, endpoint, asset, amount, and account addresses.
It also binds the exact message hash, blockhash, last valid block height, context slot, nonce, and expiry.
The message hash uses SHA256 over the exact message bytes.
The payer consent permanently associates the payment-network address with the avatar.
The service supplies the blockhash and height through its fixed RPC.
Requests cannot select an RPC, blockhash, or height.

The transaction uses version zero without address lookup tables.
Its instructions are compute limit 20000, compute price 1 microLamport, classic SPL TransferChecked, and a 32-character hexadecimal memo.
The transfer uses the exact associated token accounts, mint, amount, decimals, and payer authority.
Both token accounts must already exist and pass the classic SPL account checks.
A missing account produces an actionable refusal before the reservation and signature flow.
The user can create the payer account through an authorized wallet; the desk must provision its receive account.

The fee payer occupies signature slot zero. The external payer occupies slot one.
Capture requires an empty fee-payer signature and a valid external payer signature.
The service stores the unsigned transaction separately from the encrypted signed transaction.
Capture binds the encrypted value to the owner, order, task, network, and purpose.
The browser requests signatures only. It never sends the transaction to RPC.
The browser loads its transaction library only after explicit purchase approval.

## Expiry and recovery

The quote expiry and blockhash lifetime are separate checks.
The service persists the exact last valid block height at issuance.
Capture and dispatch check the original blockhash and height again.
A refused dispatch after the send claim retains uncertainty and the entire liability.
Recovery uses identical stored bytes. It never replaces the blockhash, memo, payer, or transaction.
Expired transactions require reconciliation; expiry alone does not release the hold.

The payer signature is not a transaction identifier.
Only the first signature identifies a transaction after the fee payer signs.
When identifiers are absent, reconciliation scans the captured payer and source token account.
A scan without a verified exact match leaves the order uncertain.
The implementation does not treat an empty history scan as proof of non-payment.
Bounded history discovery records evidence; it never invents a desk order or releases budget.

## Receipt rules and limits

The verifier supports confirmed and finalized RPC observations; order reconciliation requests finalized evidence.
It verifies successful metadata, exact transaction bytes, payer and fee-payer signatures, token balance changes, and canonical block inclusion.
It repeats transaction and canonical block reads after the other reads.
The final head must remain fresh.
A refund requires a later, full, classic TransferChecked movement from the desk account to the original payer account.
Unknown refund instruction forms remain unavailable.

Receipt evidence remains provisional for account accounting.
Even a finalized RPC observation does not release the shared carry hold in this increment.
A separate reviewed release transition remains required.
The event identity prevents receipt reuse across orders.
Remote refund labels, HTTP errors, unknown boards, and missing receipts never establish settlement.
No genuine signature from the pinned fee payer or desk appears in the generated test fixtures.

## Evidence and release gates

The installed `@x402/svm` version is 2.9.0.
The controlled SDK probe generates actual SDK wire bytes and compares them with the adapter's reconstructed message.
Kit sorts account-role groups by address; web3.js preserves insertion order.
The adapter reindexes the message to match Kit exactly.
Tests use generated payer keys and controlled RPC responses only.
They do not establish a desk payment or refund.

The fixed RPC permits read methods only, uses a five-second deadline, and bounds each response to 262144 bytes.
Large or unavailable evidence produces a refusal.
The source and browser tests cover signature changes, extra instructions, fee-payer changes, address tables, account type, expiry, and cancellation.
PostgreSQL tests cover actual Drizzle composition, capture, exact-byte restart, approval rotation, and shared-cap races.
Release still requires independent review, a genuine authorized devnet settlement and refund, and device checks for the new network selector.
No key discovery, live payment, production migration, or activation occurred.

Local verification: Solana pure suites passed 15 tests and 143 assertions.
The actual Drizzle devnet suite passed 8 tests and 51 assertions.
The Base regression suite passed 20 tests and 120 assertions.
The browser signer passed 2 tests and 13 assertions; the Office panel passed 7 tests and 28 assertions.
The purchase action suite passed 3 tests and 16 assertions, including explicit Solana grammar and result filtering.
Shared and database builds, API typecheck, and web typecheck returned exit code zero.
The isolated full-schema fixture accepted migration 0111 twice and retained 33 buyer constraints.
These results do not replace independent audit, initial-route bundle inspection, device review, or genuine pinned receipt evidence.

PARITY: humans use the Office network selector and external wallet; bound agents use the same private purchase routes and finite purchase operations.
The server resolves every private operation to the authenticated non-guest avatar.
External signature capture stays outside model tools for both Base and Solana.

Primary references: [Solana confirmation](https://solana.com/developers/cookbook/transactions/confirmation),
[transaction lookup](https://solana.com/docs/rpc/http/gettransaction),
[blockhash lifetime](https://solana.com/docs/rpc/http/getlatestblockhash),
[signature status](https://solana.com/docs/rpc/http/getsignaturestatuses),
and [official cluster endpoints](https://solana.com/docs/references/clusters).

## S1 and S2 correction scope - Last Audited 2026-11-09

S1 moves the repeated frozen-blockhash and block-height check inside the final database fence.
The check follows lock acquisition and the final owner/session wait.
The current linked-wallet approval and database-clock checks follow the RPC wait.
Expired approval, lease, wall-clock authorization, blockhash, or height retains uncertainty without a paid-client call.
A live chain can advance after the final RPC observation; this ordering does not make RPC and database state atomic.

S2 requires the refund authority in the actual signer slots and verifies its exact-message signature.
The production caller pins that authority to the desk address.
The one-transfer shape requires exact account roles and an exact account inventory.
It permits the desk as fee payer or one separate fee payer with the desk as the second signer.
A public key in a non-signer owner meta cannot establish refund authority.
Generated-key tests exercise the pure verifier without substituting a generated key for any production pin.
An independent fixture with fabricated successful RPC metadata now receives receipt_unavailable.

The corrections preserve Base behavior, shared caps, captured bytes, uncertain holds, and the disabled execution gate.
No genuine pinned payment or refund, live payment, key access, or activation accompanies these corrections.

Correction verification: the original S1 probe passed with zero paid-client calls and an uncertain order.
The original S2 probe passed with accepted=false for a non-signer desk owner.
Tracked S1 cases cover final-wait height expiry, invalid blockhash, and account approval expiry during the final RPC wait.
Tracked S2 cases cover exact roles, pinned authority, both permitted fee-payer layouts, and fabricated successful RPC metadata.
The Base suite passed 20 tests and 120 assertions. API typecheck returned zero after both corrections.
Independent re-review remains required. No correction changes the disabled execution gate.

Missing-ID discovery and the explicit refund-release refusal are specified in docs/brainchain-buyer-recovery.md.
