# BrainChain purchase independent audit

Date: 2026-11-09. Reviewer: independent Codex buyer_audit.
Workspace: registered brainchain-plan worktree on itachi222.
Current verdict: scoped source approval after B1/B2 corrections and independent reruns. Keep testnet execution disabled.
The original findings below remain as historical reproduction evidence. The correction review appears at the end.

## Scope

Reviewed the Base Sepolia buyer DTOs, migration 0108, schema, policy, HTTP client, receipt reader, durable purchase service, private routes, agent actions, MCP mapping, served-manual entry, human panel, and browser EVM signer.
The review used source reads and controlled local tests. It made no external payment, paid inference request, or mainnet signature.
The prior root P1/P2 report documents the stored-refund and final-approval-expiry corrections. This review preserves those corrections.

## B1 ? linked-wallet rotation does not revoke purchase approval

Severity: blocking owner-authority defect before activation.
Source: apps/api/src/services/brainchain/purchases.ts:53,112,146; migration 0108 approval columns.

The service checks the current linked Solana wallet when it verifies the human signature.
It stores only approval time and expiry. It does not retain the wallet that signed the approval.
The later policy and dispatch checks accept that approval after the account changes its linked wallet.
The context reader locks the current user row, but it does not compare that wallet with the approval wallet.

Independent reproduction:
1. Create a non-guest owner with per-purchase human approval enabled.
2. Sign the exact approval with the linked Solana fixture wallet.
3. Capture valid task-intent and EIP-3009 signatures from an external EVM fixture payer.
4. Replace users.linked_wallet_pubkey with a different fixture wallet.
5. Submit the captured purchase.

Observed: the controlled paid client received one call. The expected call count was zero.
Probe: .brainchain-work/buyer-audit-wallet-rotation.test.ts.
Result: 0 pass, 1 fail, 1 assertion. The client returned only controlled fixture data.
No external token transfer occurred. This demonstrates authorization failure in the disabled execution path.

Required correction: retain the approval wallet and its revocation identity. Compare it with the current owner wallet during admission and final dispatch.
An unlink or rotation must invalidate previous authority. A change away and back must not restore a revoked approval.
Preserve captures and liabilities. A new owner approval must not alter the frozen payment or task.
Add tests for rotation before capture, rotation after capture, unlink, and rotation away and back.

## B2 ? account daily cap has separate buyer and vendor totals

Severity: blocking budget-authority defect before activation.
Source: apps/api/src/services/brainchain/purchases.ts:53-60 and apps/api/src/services/outbound-x402.ts:356-364.

Both services read the same user_spend_policies daily cap and acquire the same avatar spend lock.
The buyer service sums only brainchain_buyer_orders. The existing vendor service sums only vendor_spend_ledger.
The lock serializes admission but does not combine liabilities. Each path can admit the full account cap independently.
The current buyer lane uses test tokens. This finding does not claim a production cash loss.

Independent buyer-side reproduction:
1. Set the account daily cap to 100 cents.
2. Insert an ambiguous vendor liability of 1,000,000 atomic units for that account.
3. Request a buyer intent for another 1,000,000 atomic units.

Observed: the buyer service admitted the reservation. The expected error was over_daily_cap.
Probe: .brainchain-work/buyer-audit-global-cap.test.ts.
Result: 0 pass, 1 fail, 1 assertion.
The isolated fixture lacks vendor_spend_ledger. The probe uses a connection-local temporary table with the relevant production columns and max:1.
It creates no persistent schema and makes no external request. The reverse vendor-side omission is a source finding, not an executed vendor-service test.
An earlier setup attempt stopped because that fixture table was absent; that result is not evidence of the budget defect.

Required correction: use one authoritative liability calculation or one common reservation ledger under the existing avatar lock.
Both admission paths must count the same applicable liabilities without double counting. Preserve uncertain liabilities and explicitly define testnet scope.
If testnet needs a separate cap, add explicit owner-authorized testnet policy. Do not silently reuse one global cap as two independent allowances.
Test both admission orders and concurrent buyer/vendor reservations.

## Controls supported by source and tests

- Immutable owner, task, intent, capture, remote order, and task association fields prevent ordinary request substitution.
- Exact typed intent binds the task, avatar, endpoint, quote, payer, amount, recipient, and payment nonce.
- The fixed Base Sepolia token domain, recipient, network, and amount refuse alternate payment lanes.
- The service reserves before typed-data issuance. Capture persists before paid dispatch.
- Recovery reuses captured bytes and retains uncertainty after transport failure.
- The HTTP client invokes the dispatch fence after DNS validation and refuses redirects.
- Receipt checks require the exact transfer and payment authorization nonce. Refund checks require the original payer and full amount.
- Receipt event uniqueness prevents reuse across orders for the same evidence kind.
- Private routes resolve human or bound-agent identity. Approval routes require a human session and owner-wallet proof.
- Model actions omit signature capture and approval. Hosted results exclude signatures, ciphertext, and arbitrary desk prose.
- The browser signer reconstructs constrained types and checks payer, chain, order, task hash, nonce, amount, domain, and expiry equality.

These are scoped controls. They do not cancel B1 or B2.

## Independent verification runs

All commands ran on itachi222 in the shared worktree.

- Purchase policy, receipt, and purchase action suites: 11 pass, 0 fail, 251 assertions.
- BrainChain HTTP/session composition suite: 8 pass, 0 fail, 63 assertions.
- Browser EVM wallet unit suite: 1 pass, 0 fail, 9 assertions.
- B1 independent PG probe: reproduced the defect, 1 failing assertion.
- B2 independent PG probe: reproduced the buyer-side defect, 1 failing assertion.

PG probes required BRAINCHAIN_DB_FIXTURE=1 and BRAINCHAIN_LOCAL_FIXTURE=1.
The test helper supplied the approved loopback fixture connection. No credential values appeared in output.
No production source files changed during this audit.

## Open integration limits

The source gate remains false. This review does not authorize activation.
Finality-aware refund liability release remains absent; provisional refund holds remain retained.
Solana purchase support, actual test-token settlement, authenticated staging parity, and browser interaction evidence remain outside these tests.
The external signer unit test is not a real browser-wallet transaction.
The live desk's identical-authorization recovery guarantee still needs test-token evidence.
The initial audit required B1/B2 corrections and independent reruns. The correction review below records their result.

## Independent correction review ? 2026-11-09

Verdict: B1 and B2 satisfy this source audit after the corrections. No new blocker was reproduced in this review.
This verdict does not authorize live submission, finality release, or production promotion.

### B1 correction

Migration 0110 stores the linked-wallet authority version and the purchase approval wallet/version tuple.
The users trigger increments the version on wallet or proof-time changes. It rejects a manual reset and bounds the value to exact safe integers.
The purchase challenge captures that tuple. Proof verification, capture admission, and final dispatch compare it with the current locked user row.
The final fence checks the tuple after the last identity await, then checks approval and payment deadlines using the database clock.
The current user row lock prevents a concurrent wallet mutation during that transaction. Remote desk acceptance remains outside this database transaction.
A legacy null tuple refuses. Unlink, rotation, rotation away and back, and same-key proof refresh invalidate earlier approval.
A fresh human proof renews account authority without replacing captured payment bytes, task intent, or nonce.
The human panel exposes that renewal for a captured order and disables Submit while required approval is invalid.

The original independent B1 test assumed submit returned after dispatch. Correct refusal now occurs before the claim.
The refusal-aware rerun catches that error and separately asserts zero paid-client calls.
The original failing probe remains unchanged as historical evidence.

An additional independent probe rotates the wallet inside the controlled transport, after the outer fence and before its final dispatch fence.
It verifies zero paid-client calls, uncertain retained state, and humanApproved=false.
Probe: .brainchain-work/buyer-audit-final-wallet-fence.test.ts.

### B2 correction

The buyer and outbound vendor adapters now use accountSpendLiabilityQuery under the same avatar advisory lock.
The shared query adds exact atomic liabilities once per authorization. Buyer operations do not also insert vendor ledger rows.
Pending and ambiguous vendor liabilities carry across UTC days. Paid vendor rows count on their UTC day; failed rows do not count.
Reserved and provisional buyer states retain their liabilities across days. A finality-based release remains a separate requirement.
This policy explicitly uses the same global cap for testnet buyer authorizations. It grants no separate testnet allowance.

The original independent B2 probe now refuses admission with over_daily_cap.
The rerun used the persistent fixture vendor table added by the owner tests; it needed no temporary table or new audit DDL.
The owner suite also exercises the actual outbound admission function in both admission orders and concurrently.
It verifies a mixed 500,000 plus 1,000,000 atomic total and refuses an extra atomic unit.
The shared SQL shows no adapter-specific rounding or second allowance.

### Installed database composition

Reviewed getPostgresClient() in packages/database/src/index.ts. It returns the existing lazy postgres.js pool after Drizzle initialization.
It creates no second pool or credential source. The buyer factory now uses that getter.
Buyer writes use explicit text parameters with JSONB/timestamptz casts. Reads normalize dates before comparisons and DTO serialization.
The fixture suite executes the actual default factory in a child process and verifies pool identity, body round-trip, date round-trip, and disabled execution.
Its separate full lifecycle test initializes actual Drizzle serializers before approval, capture, final fences, and refund reconciliation.
These checks passed during the independent review.

### Correction verification

Commands ran on itachi222. The DDL window was coordinated with durable_audit and released after the buyer suite.

- Guarded buyer PostgreSQL suite: 20 pass, 0 fail, 120 assertions.
- Independent B1 original-refusal rerun, late-transport rotation probe, and B2 rerun: 3 pass, 0 fail, 7 assertions.
- Human purchase panel plus browser EVM signer suites: 5 pass, 0 fail, 25 assertions.

The PostgreSQL suite includes P1 stored-refund omission and P2 final-session-wait approval expiry regressions.
No external paid request, transaction, mainnet signature, or credential output occurred.
The independent probes use synthetic identities and controlled transports against the approved loopback fixture.

### Remaining release limits

Execution remains false. Solana support, finality-aware liability release, a live test-token purchase, and authenticated staging parity remain unproved.
Device screenshots for the new captured-order approval state remain separate from the DOM tests.
The source review does not establish atomic revocation at the remote desk or live recovery behavior.
