# BrainChain task purchase design

Date: 2026-11-09. Status: implementation specification; no payment adapter or purchase is proved by this document.

## Verified interface and limits

The official desk documents Base USDC and Robinhood USDG payments, plus testnet equivalents.
It exposes separate order and task states. Refunds return on the payment network.
Briefs are public. The desk documents repeat submission of the same signed payment as returning the same order.
These are interface claims, not independent settlement evidence.
Source: [official agent payment documentation](https://docs.usebrainchain.com/agents).

The pinned MCP configuration identifies Base EIP-3009 and Robinhood Permit2 payment paths.
It defines a fifteen-minute repost interval, separate from the payment authorization lifetime.
Source: [pinned configuration](https://raw.githubusercontent.com/usebrainchain/brainchain-mcp/385f87c1615afdeda39f318c6e35eccb2db3b8c3/src/config.ts).

The captured unpaid challenge is research/brainchain-2026-11-09/payment-required.json.
The existing outbound-x402 service only supports Solana transactions and Ed25519 wallet keys.
Its custody implementation cannot sign EVM payments. Reuse its accounting principles, not its wallet signer.
The fresh unsigned payment-capability-recheck.json confirms a Solana devnet offer.
No mainnet Solana offer or successful Solana settlement is proved. Base Sepolia is an explicit first adapter choice.

## Proposed implementation order

1. Add owner-bound buyer records, immutable task bodies, exact quote parsing and read-only order reconciliation.
2. Add external EVM payer ownership and one-purchase authorization with exact terms.
3. Add a narrowly scoped EIP-3009 adapter and synthetic recovery tests.
4. Add authenticated human and bound-agent interfaces through the same service.
5. Verify a test-token purchase when the payment network and desk permit it.

Prefer Base EIP-3009 for the first supported adapter because it avoids a persistent token allowance.
This choice must remain visible to the user. It does not substitute Base for a requested Solana payment.
Do not import a private key into the web interface or reuse worker signing authority.
Hosted agents need a separately approved EVM payer authority before autonomous purchases.
Connected agents can supply a signed exact authorization through the authenticated route.
The human path obtains that same authorization from the connected external wallet.

## Purchase record and authorization

Bind each record to avatar, actor, payer, environment, payment chain, token, recipient and immutable brief hash.
Use canonical integer amounts and fixed token decimals. Never compare currency amounts as floating-point numbers.
Record the selected full quote, its hash, expiry, one-use nonce, caller idempotency key and explicit maximum amount.
Bind authorization to the desk endpoint and task body. EIP-3009 alone does not bind the task description.
An application-level intent must supply that binding before accepting the payment signature.
Validate recovered signer, EIP-712 domain, chain, token, recipient, amount, nonce and validity interval.
Reject unknown transfer methods, unknown fields that alter payment semantics and fallback assets.
Resolve the bound avatar before any private record access or external request.

Reserve the entire authorized amount transactionally before accepting a payment signature.
Serialize per-payer budget changes and per-order claims. Preserve reservations across restart.
Persist exact signed bytes before the paid request. Never generate a second nonce to recover a timeout.
Mark possible transmission before network dispatch. Lost responses retain the full uncertain hold.
Enforce current ownership, intent, expiry, lease and budget after asynchronous work and before transmission.
Provider compute budgets do not authorize task purchases.

## Recovery and receipt rules

Store local transmission state separately from remote order state and on-chain settlement state.
Treat remote status as an observation until chain evidence verifies the payer, token, recipient and amount.
Validate order identifiers, then construct the fixed desk status URL locally. Never follow returned arbitrary URLs.
Persist the association between payment authorization, returned order and task board plus task ID.
Task IDs alone are insufficient across board upgrades.
An uncertain request remains uncertain even when the desk returns an HTTP error.
Retry only identical persisted authorization bytes under a reviewed recovery policy.
The fifteen-minute client interval is not independent proof that an uncertain payment is safe to replace.
Verify refunds against the original payment chain and payer, with exact amount and canonical receipt evidence.
Do not release budget from task rejection, an HTTP404, authorization expiry or a refund label alone.
Expose refund failure and partial evidence without reporting a successful refund.
No task result, link or desk prose grants permission to spend, change a destination or invoke another tool.

## Tests and release evidence

Required tests include foreign-owner access, quote substitution, wrong domain, altered brief and replay across avatars.
Exercise concurrent budget admission, signature capture interruption, transmission timeout, process restart and chain reorganization.
Exercise a refunded label without a receipt, a wrong-chain receipt, a wrong recipient and a partial refund.
Human and bound-agent paths must produce the same durable records and refusal reasons.
Document all served action surfaces and bump the protocol version in the implementation diff.
Run an independent money-path audit before activation.
Mainnet payment remains outside the current authorization. Preserve the unmet Solana requirement in the release matrix.


## Implementation checkpoint - 2026-11-09

The Base Sepolia vertical now has owner-bound buyer records in migration 0108, fixed quote/token policy, an encrypted capture service, private REST routes, a human panel, and protocol 123 agent operations. The release constant remains false. No live signed request or payment occurred. Existing owner spend rules gain a separate BrainChain vendor; no Solana custody signer participates.

The service reserves before typed data issuance and preserves liabilities after expiry or uncertainty. A provisional refund does not release its carry hold. A later finality/release policy needs separate review. Exact duplicate recovery needs current authority and reuses the captured bytes. Unknown board addresses remain unknown. Model tools exclude payment signature capture and owner approval; the external payer uses direct private REST.
