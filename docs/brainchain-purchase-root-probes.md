# BrainChain purchase pre-release probes

Date:2026-11-09. Reviewer:root Codex, separate from the purchase implementer.
Status:targeted probes only. The complete purchase increment still needs an independent money-path audit.

## P1: omission of a previously observed refund

Source review found that reconcile rechecked a stored payment transaction but not a stored refund when the remote response omitted it.
A previously refunded row could retain that state without another refund receipt check.
The implementer added the stored-refund fallback before the independent probe reached execution.
Therefore this report does not claim an observed failure of the original implementation.

The independent correction probe creates a real database order and synthetic signatures, observes a refund, then removes the remote refund field.
Its controlled receipt reader rejects the stored refund as reorged.
The corrected service reads the refund again, rejects reconciliation and records reorg_suspended.
Result:1test,5assertions passed. No external transaction or paid request occurred.
Probe:.brainchain-work/audit-purchase-refund-omission.test.ts.

## P2: human approval expires during the final session check

The dispatch fence checked human approval, then awaited another session check.
Its final database-clock check covered the payment authorization and lease but omitted the human approval deadline.
The independent test used genuine fixture Solana owner and EVM payment signatures, then delayed the final session read.
The approval expired during that delay while the payment authorization stayed valid.
Observed original result:the controlled paid client was called once; the expected count was zero.
The test failed with calls1,reads11,stateuncertain. No live network call occurred.

The implementer added a final approval deadline check after the await.
Root reran the original probe after the schema changes. It passed: 1 test and 2 assertions.
The paid client received zero calls; the durable order retained its uncertain state.
The probe used local fixtures only and made no paid request.
Probe:.brainchain-work/audit-purchase-human-expiry.test.ts.

## Provisional refund accounting

The receipt reader labels twelve-confirmation observations provisional.
A provisional refund cannot release a retained cross-day liability as final money reconciliation.
The implementer now keeps refunded observations in the carry liability.
Finality-aware release remains an explicit unfinished requirement. A permanently retained hold is not the final recovery feature.

## Fixture correction

The purchase fixture initially declared users.id and avatars.user_id as varchar64 while production uses UUID.
The implementers applied the fixture-only UUID correction before migration0109.
Backend reports two successful applications of0109. Root then reran P2 successfully.
The test helper must continue to reject application or remote database targets.

## Limits

These probes do not cover every payment, owner, receipt, refund, browser, hosted-agent or restart invariant.
They do not authorize opening the execution gate.
Full source review, finality handling, a test-token purchase and staging parity remain required.

## Independent buyer-audit correction probes

The separate buyer auditor reproduced B1wallet-rotation and B2split-account-cap defects.
The implementer added wallet authority versions and shared buyer/vendor liability accounting.
Root reran the independent probes after those changes:2tests,4assertions passed.

B1now rejects before dispatch with human_approval_required and zero paid-client calls.
Root preserved the original failing probe and copied it to buyer-audit-wallet-rotation-corrected.test.ts.
The copied test catches the earlier rejection before asserting the original zero-call invariant.
B2uses the original buyer-audit-global-cap.test.ts and now refuses the additional buyer reservation.
The fixture now contains vendor_spend_ledger; the probe did not need a temporary table.

These tests do not establish every reverse-order/concurrency/factory invariant.
The independent auditor must review the complete correction and actual Drizzle client composition before activation.
No external payment occurred.
