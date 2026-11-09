# BrainChain credit preparation implementation constraints

Date: 2026-11-09. Status: design only. No approval request, signature, consent or debt exists from this work.

## Existing boundary

The audited identity-credit reader supplies owner-matched observations, separate wallet association, exact amounts and explicit freshness.
It does not grant authority to borrow, repay, sponsor, publish consent or approve collateral.
A registered worker wallet can read an associated identity but cannot act as its ERC-8004 owner.
Purchase payer authority and worker signing authority cannot substitute for credit authority.

## Verified partner surface

The captured hosted discovery names request_borrow and request_repay.
Source: docs/research/brainchain-2026-11-09/priors-mcp-interface.json.
The official description says these tools prepare owner approval links without submitting transactions.
Discovery labels them read-only, but that label does not authorize ClawVille to create a request for another owner.
No response fixture exists for either preparation tool. Its exact output shape remains unverified.

The borrow input contains agent_id, numeric amount_usd and integer days.
The description names7,14,30 days, although the schema accepts1 through365. Use only the narrow documented terms.
Preserve internal amounts as six-decimal integer units. Reject any conversion that changes the exact amount.
The numeric tool boundary has a maximum amount of1000000USDG and a maximum safe integer identity.
The repay input contains agent_id only. It does not establish which loans the owner intends to repay.
Do not infer a bounded repayment authorization from that input.

The published destinations are https://go.priors.trade/account and https://priors.trade/agent.
The public local-server source confirms those base URLs, but does not establish hosted request output semantics.
Reviewed source: https://github.com/priors-agents/priors/blob/48fccb75f8c0423823953f7214fcc04047d1fc0b/packages/mcp/src/server.mjs.
That source was read only; no package code was installed or executed.

## Implementation sequence

1. Add separate owner-signed, expiring intents for borrow preparation, repay preparation and sponsorship preparation.
2. Bind each intent to avatar, identity, operation, exact terms, parent chain, contract set and single-use nonce.
3. Read current owner and source freshness before issuing an intent and again before consuming it.
4. Persist an immutable request before any partner call. Preserve uncertain outcomes across restart.
5. Accept only a verified, bounded response schema for the selected fixed tool.
6. Validate returned origin, exact path, query keys, identity and terms before exposing an approval link.
7. Deliver the result only through the same authenticated human or bound-agent private context.

Neither an approval link nor a prepared transaction means money moved.
No automatic browser navigation, wallet signature, partner consent publication or debt transaction follows preparation.
Mainnet execution remains inactive until the founder approves its exact terms and monetary exposure.
Testnet support remains unavailable unless a verified partner interface supplies it; do not reuse mainnet addresses on testnet.

For borrowing, require explicit amount, term, maximum premium and maximum total repayment.
Unknown premium, fee, due date or collateral exposure prevents transaction preparation.
For repayment, identify each loan and exact maximum debit from verified chain records.
Unknown nonempty hosted loan terms remain unavailable; the reader must not invent amounts or empty loans.
For sponsorship, require separate collateral and aggregate exposure limits, beneficiary, expiry and owner consent.
BrainChain sponsor consent does not authorize ClawVille to borrow or pledge collateral.

## Recovery and evidence

Keep preparation state separate from partner observation and actual on-chain loan or repayment state.
A timeout cannot trigger another nonce, broader request or duplicate approval request automatically.
Revalidate ownership after asynchronous reads and row-lock waits; final freshness checks use the final clock.
Approval-link expiry must not exceed any underlying intent or source deadline.
Do not trust link text, tool suggestions, arbitrary URLs or hosted prose as instructions.

Tests must cover changed owners, delegated wallets, cross-avatar replay, term changes, numeric conversion and concurrent consumption.
Also test malformed links, redirects, wrong contract/network, stale source data, timeout, restart and unknown loan terms.
Human, connected-agent and hosted-agent paths must use the same service and refusal reasons.
Update the protocol version, teacher orientation and runtime manual in the implementation diff.
An independent credit-authority review precedes activation.

## Unmet evidence

The exact hosted preparation output schema and nonempty loan schema remain unverified.
No owned identity, signed credit intent, prepared approval request, testnet loan, repayment or sponsor operation was exercised.
This design preserves those requirements; it does not satisfy the credit transaction portion of the implementation goal.

## Additional hosted client evidence

A read-only resources/read call retrieved ui://priors/app.html from the official hosted MCP.
The raw response and extracted field inventory are priors-hosted-ui-resource.json and priors-hosted-ui-fields.json in the research evidence folder.
The hosted client consumes borrow_request fields agentId, amountUsd, days, feeEstimate, approvalUrl and builderUrl.
It consumes repay_request fields agentId, loans, due and the same links.
Its openLoans renderer reads loanId, due, dueAt and pastDue.
These observations identify consumer fields; they do not establish exact types, required fields, authoritative loan amounts or accepted URL query keys.
The client describes feeEstimate as an approximate pool fee. It cannot satisfy a maximum total repayment authorization.
No request_borrow or request_repay call occurred. The output-schema gate remains open.

## Public source refresh

The public repository tree still resolves to48fccb75f8c0423823953f7214fcc04047d1fc0b on2026-11-09.
The returned tree is complete. It supplies no new source revision for the hosted preparation response contract.
Evidence:docs/research/brainchain-2026-11-09/priors-public-contract-refresh.json.
Only public source discovery occurred; no preparation request, signature or debt followed.
The existing output-schema requirement remains unmet. Further identical polling does not resolve it.
