# BrainChain buyer history recovery

Last Audited: 2026-11-09. Status: local source; independent review remains required.
Drift: missing-ID Solana timeouts now have an authenticated read-only history search.
Execution remains disabled. This change creates no payment and releases no liability.

## Exact read path

Humans select Search original payment history on their own uncertain Solana order.
Bound agents use purchase_reconcile with the same order ID.
Both paths call the existing private reconciliation route and resolve the current non-guest avatar.
A request cannot select a wallet, token account, RPC, transaction, or cursor.
The server uses the payer, source token account, and frozen message from the captured order.
No remote desk order or task follows from a discovered payment alone.

Each scan reads at most four history pages and twelve candidate transactions.
Each page contains at most 25 signatures.
The scan has a fifteen-second overall deadline.
The fixed RPC retains its five-second request deadline, response byte bound, and read-only method list.
Cancellation propagates through transaction and canonical receipt reads.
New schema metadata stores only bounded private progress for that exact message.

The RPC lists account signatures from newest to oldest.
The scan uses finalized history and stops below the message's issuance context slot.
It checks each candidate's exact frozen message and the external payer and pinned fee-payer signatures.
A match must pass the existing finalized canonical receipt verifier.
The payer signature alone never becomes a transaction identifier.
Unknown, partial, stale, ambiguous, and unavailable evidence retains the original liability.

Private cursors let later calls continue without accepting cursor values from the caller.
Unavailable evidence restores the previous cursor, so a possible payment is not skipped.
An empty scan means only that this scan found no verified match.
It does not establish non-payment, cancellation, or permission for another payment.
Restart preserves the original captured bytes and progress.
The S1 final expiry fence and S2 refund signer checks remain unchanged.

## Refund release remains unavailable

The observed challenge output schema declares order, status, and optional state.
It does not establish a joint order, payment, refund, amount, and network attestation.
The existing order parser permits paymentTx, refundTx, and network separately; it has no verified amount association.
Official documentation describes a refund transaction and return on the original network.
It does not supply the missing joint attribution contract.

A pinned desk signature can prove a token return to the payer.
That transfer alone does not identify which same-amount order it refunds.
A unique refund identifier prevents reuse but does not establish that attribution.
Therefore this increment changes no shared liability exclusion and creates no release record.
Even a finalized return or a refunded label retains the hold.
The human and agent result reports refundRelease=unavailable and refundReleaseReason=order_attribution_unverified.

Required next evidence is a verified documented association that binds the original payment, refund, order, amount, and network.
Final canonical receipt checks and unique consumption would still be required after that association exists.
No invented response field, lookup context, or generated receipt substitutes for the missing evidence.

## Quality-level correction

The pinned BrainChain MCP source requires quality levels in best-first order.
With two levels, only the first passes. With three, the second or better passes.
The human form now submits the pass criterion before the fail criterion.
Its exact submitted-body regression checks this order.
Agent creation retains the caller's array order and documents the same contract.
Recovery does not rewrite existing task bodies or signatures.

References: [pinned MCP schema and validation](https://raw.githubusercontent.com/usebrainchain/brainchain-mcp/385f87c1615afdeda39f318c6e35eccb2db3b8c3/src/tools.ts),
[official order and refund documentation](https://docs.usebrainchain.com/agents),
[Solana account history](https://solana.com/docs/rpc/http/getsignaturesforaddress),
and [transaction lookup](https://solana.com/docs/rpc/http/gettransaction).
The local evidence is docs/research/brainchain-2026-11-09/payment-capability-recheck.json.

PARITY: human history control and bound-agent purchase_reconcile use the same authenticated order service and avatar.
Both receive the same scan state and explicit refund-release refusal. Neither can clear a hold from absent history.

## Local verification

The discovery suite passed four tests and 89 assertions, including pagination, unavailable candidates, foreign cursors, and cancellation.
All Solana pure suites passed 15 tests and 143 assertions.
The actual Drizzle Solana suite passed eight tests and 51 assertions; Base regressions passed 20 tests and 120 assertions.
The Office panel passed seven tests and 28 assertions, including the exact best-first submitted body.
MCP and hosted purchase checks passed 106 tests and 890 assertions.
Shared and database builds, API typecheck, and web typecheck returned zero.
The isolated full-schema fixture accepted migration 0114 twice and retained 34 buyer constraints.
No genuine positive pinned discovery receipt or refund appears in these fixture results.
Independent review, updated CI inventory, and device review remain required.
