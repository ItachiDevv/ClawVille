# BrainChain Solana buyer independent audit

Date: 2026-11-09. Reviewer: independent Codex buyer_audit. Host: itachi222.
Current verdict: scoped source APPROVED after S1/S2 correction review. Execution must remain disabled.
The original findings remain below as historical evidence. The correction review appears at the end.

## Scope and method

Reviewed the Solana policy, transaction builder/verifier, fixed RPC, receipt verifier, migration 0111, shared buyer service, client, DTOs, web signer, and Office path.
Reviewed the narrow Base/shared-account changes against the earlier B1/B2 correction report.
The review read the complete current handoff and the Solana adapter specification.
The existing B1/B2 source approval remains limited to its recorded scope.

Tests used controlled RPC responses and generated fixture keys. No key from the pinned desk or fee payer was available or fabricated.
No external payment, network write, activation, deployment, or production database operation occurred.
Fixture DDL ran only during a window coordinated with backend and protocol_review. That window is released.

## S1 ? block-height check precedes the final database waits

Severity: blocking expiry enforcement defect before activation.
Source: apps/api/src/services/brainchain/purchases.ts:179-183, submit final fence.

The fence checks the frozen Solana blockhash and height before database.begin.
It then acquires locks and awaits owner/session checks. The final database clock only covers wall-clock deadlines and lease validity.
The original blockhash can expire during those waits. The service does not repeat its Solana validity check before dispatch.

Independent reproduction: .brainchain-work/buyer-audit-solana-final-height.test.ts.
The test captures a valid fixture authorization with lastValidBlockHeight=200.
Inside the client's final fence, the owner check advances the controlled RPC height to 201.
Observed: one paid-client call. Expected: zero calls with the durable liability retained.
Result: 0 pass, 1 fail, 1 assertion. The controlled client made no network request.

This demonstrates late dispatch of an expired transaction. It does not demonstrate token loss; the chain normally rejects an expired blockhash.
Required correction: validate the frozen blockhash and height after lock acquisition and final owner waits.
Retain final owner-approval, lease, payment-deadline, and database-clock checks after the RPC await.
Keep uncertain liability and captured bytes unchanged on refusal. Never replace the blockhash for recovery.

## S2 ? refund evidence does not require the pinned desk signature

Severity: blocking receipt-authenticity defect before activation.
Source: apps/api/src/services/brainchain/purchase-solana-receipts.ts:31-46.

The refund verifier checks the TransferChecked owner public key against the pinned desk.
It verifies each required signature but does not require that owner to occupy a signer slot.
It also does not require the transfer owner's instruction meta to mark it as a signer.
A message with only an unrelated fee-payer signature can therefore pass the local signature checks.

Independent reproduction: .brainchain-work/buyer-audit-solana-refund-authority.test.ts.
The probe builds a one-instruction refund-shaped message with exact pinned token, amount, source and destination.
It sets the desk owner meta to isSigner=false and signs only with a generated arbitrary fee payer.
Controlled RPC responses report successful metadata, exact balance deltas, and canonical finalized inclusion.
Observed: requiredSignatures=1, pinnedDeskSigner=false, accepted=true.
Result: 0 pass, 1 fail, 1 assertion. The expected result was receipt_unavailable.

This is not a valid Solana token transfer. It requires false or corrupted RPC evidence.
The defect matters because the verifier claims independent pinned-authority signature checks.
The current accounting hold remains retained, so this test does not establish financial release or loss.
Required correction: require the pinned desk owner in a signer slot and verify its signature over the exact refund message.
Validate the transfer account roles and the reviewed refund shape. Refuse unknown authority layouts.
Do not substitute a generated signer for the production pin to obtain a positive receipt test.
A genuine pinned payment/refund proof remains a release requirement.

## Controls retained in the reviewed source

- Fixed devnet genesis, endpoint, mint, recipient, fee payer, amount, decimals, and quote lifetime.
- Payment message reconstruction pins version zero, no address tables, two signer slots, and four exact instructions.
- The fee payer is slot zero; the external payer is slot one. A payer signature cannot become the transaction identifier.
- Capture requires an empty fee-payer slot and a valid external payer signature over the frozen message.
- Separate task intent binds owner/order/task/quote/network/message/lifetime. The server requires both proofs at capture.
- Full shared account liability precedes unsigned-term disclosure. Required linked-account proof precedes disclosure.
- Account-wallet approval and external payer consent stay separate. Current wallet/version checks remain in the shared service.
- Restart recovery preserves captured bytes. Timeout does not create a replacement memo, blockhash, or transaction.
- The browser signs intent before transaction, checks exact message/account roles, and never broadcasts.
- The transaction library loads only within the explicit signing function.
- The mainnet outbound guard remains unchanged.
- Provisional payment/refund observations retain account liabilities. Unknown history does not prove non-payment.

These controls do not cancel S1 or S2.

## Independently executed baseline checks

- Solana PostgreSQL suite with actual Drizzle composition: 4 pass, 0 fail, 24 assertions.
- Transaction/RPC/receipt pure suites: 9 pass, 0 fail, 45 assertions.
- Browser Solana signer plus Office panel: 7 pass, 0 fail, 34 assertions.
- S1 independent PostgreSQL probe: one reproduced failure.
- S2 independent receipt probe: one reproduced failure.

The pure suite includes the installed x402/svm 2.9.0 controlled-RPC wire comparison.
Its generated-key signature helper is not a genuine positive pinned receipt test.
The PostgreSQL suite includes exact-byte restart, pre-existing expiry, wallet rotation, and shared-cap order/concurrency checks.
The independent S1 test covers expiry during the final wait, which those baseline tests missed.

## Release limits

The initial review required S1/S2 corrections and independent reruns. The correction review below records their result.
Even after source approval, execution remains disabled until separately authorized activation evidence exists.
A genuine devnet purchase and refund, no-ID recovery discovery, finality-aware liability release, and authenticated staging parity remain unproved.
Initial-route bundle inspection, real-device network-selector checks, and browser-wallet integration remain separate from unit tests.

## Independent S1/S2 correction review ? 2026-11-09

Verdict: scoped APPROVED for the reviewed source corrections. No additional blocker was reproduced.
This verdict grants no activation, financial release, live settlement, or production approval.

### S1

The final fence now repeats frozen blockhash/height validation inside the database transaction after locks and owner/session waits.
The current linked-wallet approval check and fresh database-clock check follow that RPC await.
Payment expiry, approval expiry, lease ownership/generation, and lease expiry still refuse dispatch.
The original independent S1 probe passes unchanged: paidCalls=0, height=201, state=uncertain.

The tracked approval-expiry test can expire during the outer validity call before the inner locked RPC call.
I added a separate independent test that delays only the inner height read after the final owner check.
It confirms that the delay actually occurs once, no paid-client call occurs, and the order retains uncertainty.
Probe: .brainchain-work/buyer-audit-solana-inner-rpc-expiry.test.ts.
This closes the test-coverage distinction without changing production source.

A chain can advance after the final RPC response. The database and remote chain are not atomic.
The correction removes the avoidable pre-lock/pre-owner stale read; it does not eliminate that residual race.
An uncertain outcome retains the original bytes and liability. Recovery cannot replace the blockhash.

### S2

The production refund branch supplies the fixed desk authority and asset/account pins to the pure refund verifier.
The verifier now requires the desk owner in the actual signer slots and validates its exact-message signature.
It requires exact transfer roles, one TransferChecked instruction, and the exact account inventory.
The accepted layouts use the desk as fee payer or one separate fee payer followed by the desk signer.
The token program cannot be writable or a signer. Unknown account layouts refuse.

The original independent fabricated-RPC probe passes unchanged: requiredSignatures=1, pinnedDeskSigner=false, accepted=false.
Generated-key positive tests exercise only the parameterized pure verifier. Production callers retain the fixed desk pin.
No genuine successful pinned payment or refund appears in these fixtures.

### Independently executed correction evidence

- Solana PostgreSQL suite plus original S1 probe: 7 pass, 0 fail, 35 assertions.
- Receipt suite plus original S2 probe: 5 pass, 0 fail, 16 assertions.
- Additional inner-RPC approval-expiry probe: 1 pass, 0 fail, 3 assertions.

The PostgreSQL DDL window was coordinated with protocol_review and released immediately after the suite.
The additional independent probe used existing schema and new isolated fixture rows only.
No external payment, RPC write, key access, activation, or deployment occurred.

### Limits retained

Execution stays disabled. Genuine pinned devnet payment/refund evidence remains required.
No-ID history recovery, finality-aware liability release, authenticated staging parity, bundle inspection, and real-device checks remain separate requirements.
The original audit's other capability limits remain in force.
