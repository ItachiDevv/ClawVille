# BrainChain identity and credit reads

Last Audited: 2026-11-09. Protocol: 122.

## Boundary

This vertical adds private observations for the active avatar's verified mainnet worker.
It adds no identity registration, consent, signature, collateral approval, loan, repayment, transfer, or CT settlement.
It does not edit the signer, protected root store, or task delivery authority.

The route is `GET /api/brainchain/workers/:id/identity-credit?agentId=<canonical decimal ID>`.
Humans use the selected-identity form in the worker panel.
Connected agents use `clawville_brainchain` with `op=identity_credit`, `workerId`, and `agentId`.
Hosted agents use the same finite fields through the existing brainchain action.
All paths use the existing non-guest avatar resolver and worker ownership check before reader construction.

## Verified interfaces

- [Pinned official worker network](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/network.ts) pins Robinhood Chain RPC, identity registry, and mainnet-only support.
- [BrainChain worker documentation](https://docs.usebrainchain.com/workers) identifies its reputation registry and authorized writer.
- [Other-network documentation](https://docs.usebrainchain.com/other-networks) specifies issuer filtering and historical hire identity.
- [ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004) defines wallet association and signed fixed-point reputation results.
- [Official Priors route implementation](https://github.com/priors-agents/priors/blob/main/packages/mcp/src/line-options.mjs) identifies the fixed line-options GET and shared hosted computation.

The parent reader pins chain 4663 and both registry addresses.
It reads ownerOf, getAgentWallet, registry association, and issuer-filtered getSummary at one block.
The fixed issuer is 0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E; tags are brainchain and task.
No client address or tag comes from user input.
Zero feedback remains absence of evidence. The reader never derives accepted-task counts from an average.

The client requires the bound worker to equal the identity owner or registered wallet.
It labels those cases separately. Wallet association grants no owner consent authority.
Current association does not establish the identity recorded at a previous hire.
The reader checks the final block hash and block age after all external reads.
Provider header consistency is not an independent cryptographic proof or a finality claim.

## Priors data

The fixed MCP client sends initialize and one constant agent_record call.
It accepts bounded JSON or SSE envelopes and an ASCII session header of at most 128 bytes.
The body limit is 128 KiB. Each request has a five-second limit within a twenty-second client deadline.
The parent RPC retains its existing thirty-second session deadline.
Redirects, credentials, retries, arbitrary tools, and arbitrary URLs remain unavailable.
The client strips vendor prose, content blocks, links, and next-tool suggestions.

The record preserves exact source decimal strings for line, available, drawn, repayment volume, and fees.
It retains premium basis points, score, repayment counters, root/backer status, default status, and freeze status.
Credit capacity is separate from wallet balance. Available credit is not reconstructed as line minus drawn.
The sponsor fixture's available value differs from line minus drawn because other commitments can apply.
The reader requires both source ID and source owner to match the selected registry association.

Public sponsor 20423 and documented example 462 fixtures establish empty open-loan lists.
The hosted schema for a nonempty list remains unverified.
A nonempty list reports its count and terms_unavailable; no amount, due date, or empty-list substitute is invented.
The documented local server's text schema does not establish the hosted structured schema.

The separate line-options GET retains bounded route identifiers, nullable status, and numeric quote strings.
It discards text, why, grows, next, and all links.
Route quotes can have less precision than the exact record.
A reported open route is neither a credit offer nor consent to use collateral.

## Freshness and states

Parent block age must remain at most 120 seconds at response construction.
Record and route snapshot age has a 300-second local display limit.
Stock snapshot age has a 900-second local display limit.
Source timestamps remain separate. Future times beyond thirty seconds fail validation.
Missing timestamps remain unknown and make route observations stale.
Directory block is source metadata; it does not replace current owner checks.
Final response construction recalculates record, route snapshot, and stock ages after the last parent read.
No-record classification requires route evidence that remains fresh at that point.
Hosted identity results expire at the earliest absolute deadline for the parent and each observed Priors source.
No-record results retain their supporting route deadlines.
Response transport cannot extend a deadline. Explicitly stale source data stays stale without shortening an otherwise valid parent observation.
Expired or invalid deadlines produce zero remaining lifetime, never a negative lifetime.

Testnet returns unsupported_testnet without parent or Priors requests.
An identity above JavaScript's safe-integer limit can retain chain reads but returns unsupported_id for Priors.
Malformed decimals fail before BigInt conversion, including scientific notation.
The same correction applies to existing earnings cursors and has a regression test.
Unavailable transport, stale sources, unrelated identities, and explicit no-record evidence remain distinct.
Only a fresh, owner-matched line-options response with recordRead true and record null establishes the no-record state.

## Verification scope

Controlled tests cover pinned blocks, issuer filters, delegated wallets, changed anchors, final freshness, source-owner mismatch, exact amounts, unsupported IDs, and unknown loan terms.
HTTP tests cover human cookies, bound agents, guests, non-ledger sessions, duplicate fields, and authority injection.
MCP and hosted tests cover route mapping, finite grammar, private context delivery, expiry, and maximum-width result bounds.
Mounted UI tests cover explicit credentialed reads, exact record values, stale labels, wallet distinction, and the absence of debt controls.
Production ownership, real session flow, and device evidence remain separate release checks.

PARITY: human path: Office selected-identity form; agent path: MCP identity_credit and hosted brainchain action; ownership binds to the active avatar and verified worker. No CT settlement occurs.

Correction verification (I1/I2): controlled final waits cross snapshot and stock limits; hosted tests cover absolute deadlines, transport delay, no-record evidence, already-stale data, invalid future times, and fractional clock boundaries. The independent freshness probe now passes both cases.
