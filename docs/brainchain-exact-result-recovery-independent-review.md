# Independent exact-result consent review

Last audited: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

Verdict: full approval withheld. C1 correction has partial independent evidence; C2 has scoped source/test approval with browser checks pending.
No activation or live-key approval follows this review.

## C1: exact submit authority can lose its consent dependency

prepareSignerOperation accepts exact-result signer and gas authority IDs without deliveryProof.
When the ordinary execution result fence remains valid, preparation succeeds without a delivery-submit lease link.
assertSubmitResult discovers exact consent only through that optional lease link.
The later running-worker signer callback therefore checks ordinary authority and misses exact-consent revocation.

The independent PostgreSQL probe establishes these conditions:

- The worker runs and its original execution authority and attempt lease remain current.
- A human approves exact prepare-submit consent for the frozen result.
- The real issuer supplies exact signer and gas authority IDs.
- The probe omits deliveryProof when calling real prepareSignerOperation.
- The journal claim revokes the consent before the first driver call.
- The mock driver calls the actual authority.assertCurrent callback.

Observed output: consentRevoked true, deliveryProofOmitted true, calls 1, callbackPassed true, state uncertain.
The expectation of zero driver calls fails. Invalid synthetic bytes produce uncertainty after the unauthorized driver entry.
No real key, signature, upload, payment, or external network call participated.

Reproduction: .brainchain-work/audit-exact-consent-omission.test.ts.
Run with both BRAINCHAIN_DB_FIXTURE=1 and BRAINCHAIN_LOCAL_FIXTURE=1:

```powershell
bun test ./.brainchain-work/audit-exact-consent-omission.test.ts
```

Required correction: derive exact authority lineage from the signer and gas authority IDs and immutable issuance.
Require the matching consent and delivery proof even when the ordinary execution fence succeeds.
Preserve that relationship across preparation, nonce reservation, acceptance, final driver callback, and broadcast.
Do not let mixed signer/gas authority pairs or absent lease links downgrade an exact grant to ordinary authority.
Keep original capture and gas restrictions; this correction grants no replacement authority for expired unsigned operations.

Adjacent source concern: ResultSignatureCoordinator.authority checks exact linkage only when this.deliveryLease exists.
Review the same authority-ID omission boundary for result signatures. This sibling path was not independently executed yet.

## Evidence and reviewed boundaries

The standard canonical PostgreSQL consent suite passed 11 tests with 42 assertions in this review.
It verifies paused-worker positive capture, consent revocation with a supplied lease, wallet A-B-A, provenance, narrowing, and expiry.
It does not cover C1's omitted lease while the ordinary running-worker result fence remains current.

The private recovery route uses parent avatar middleware and separate human-origin and agent-header refusal for approval.
The consent service checks current account, wallet version, permitted human session, signature, nonce, and final database clock.
The immutable snapshot binds the frozen output, original hire, execution lineage, generations, and retained transaction fields.
Owner revocation requires recorded provenance. Unknown security revocation refuses owner-only recovery.
The issuer creates exact delivery/signature/submit authority without compute allocation or restoration of original authority.

The review inspected migration 0112 and the consent, issuer, result-signature, submit, signer, and route boundary source.
Full human panel, hosted action, MCP, and browser checks remain pending in this independent scope.
The lead reported a successful combined web build; this reviewer did not run it.
The corrected source must receive a fresh independent probe and regression pass before scoped approval.

PARITY: the reviewed route resolves the same avatar for humans and bound agents; human wallet approval remains separate.
No full feature-parity or automatic recovery-lifecycle approval follows the partial source review.

## Correction checkpoint recorded by the lead

The owner froze the C1 correction with persisted authority-ID checks at preparation and later signer boundaries.
The result-signature method also checks exact issuance before it accepts the optional delivery lease.
Root inspected these source changes and the immutable issuance trigger.

The independent reviewer reported that the original omission case now refuses preparation and creates zero operations.
The reviewer also reported consent13/64, ordinary signer/receipts9/68, auth/hosted/MCP112/945 and panel1/9 passes.
These are the reviewer's reported test results, not additional root test runs.

The review service then rejected the final report for possible cybersecurity risk.
The final independent report and complete boundary verdict therefore remain unfinished.
The lead preserves the earlier observations and does not retry or rephrase that rejected review task.
Do not treat this checkpoint as full C1 or feature release approval.

## C2: approval panel omits retained transaction details

The consent payload contains captured operationId, nonce, transactionHash and gasWei.
OfficeWorkerRecovery types captured as unknown and does not render these fields.
The displayed maximum gas does not identify the retained transaction or its exact nonce.
The reviewer reported this gap; root independently confirmed the service payload and panel source.

Show retained transaction fields before the human confirms and invokes the linked wallet.
Use explicit unknown or unreserved labels for null values. Do not substitute zero or an empty hash.
Do not expose signed bytes, credentials or internal key references.
The separate0115 capture extension must also show its exact destination, calldata, value and fee fields before approval.
The protocol owner now implements this narrow panel correction and regression tests.
Browser verification remains absent because the launch was rejected and the browser access host is unavailable.

## C2 correction review by the lead

Root read the frozen panel and independently ran its five tests with38assertions after the final text correction.
Panel SHA256:B9AA462FF762B30A0E30CC4376F8674BFCE2FEFBB6ECF6451891FA36F87BC44C.
The retained operation ID, nonce, transaction hash and gas ceiling now precede the approval controls.
The panel preserves decimal integer strings and distinguishes null reservation/capture from missing data.
Incomplete broadcast terms prevent the wallet challenge even after the confirmation checkbox changes.
Optional capture intent exposes destination, signer, chain, nonce, calldata, value and fee fields.
The capture-submit request selector remains closed pending the separate0115 implementation.

Root found inaccurate text that implied every worker was already paused and every compute grant revoked.
The owner changed it to state that consent does not resume a paused worker or restore revoked compute permissions.
The updated assertion passed in the independent five-test run.

This is scoped approval of the C2 panel source and component behavior.
Happy-DOM tests do not prove browser layout, wallet extension behavior, authenticated staging or0115 capture execution.
Final device and browser checks remain required.

## Capture-stage panel and action review

Root independently ran the updated panel suite:6tests passed with41assertions.
Panel SHA256:A6414C1FDEEE744CEDE3303942FDA5E95A5ACF4A037DFEA7BDCA55F2060D537C.
The request selector exposes capture-submit. The transaction display retains the exact chain, signer, destination, calldata, nonce and fee fields.
This extends the earlier component evidence; it does not prove database capture or a browser wallet flow.

The combined hosted action run produced18passes and1failure with71assertions.
The older recovery receipt fixture supplies only a protectedReference field for its captured object.
The stricter DTO now requires operationId, nonce, transactionHash and gasWei, so that fixture fails before its secret-stripping assertions.
The owner must supply a valid retained tuple and preserve the secret sentinel and assertions. Do not loosen the DTO.
The new capture action test passed.
The owner corrected only the stale fixture, retaining the protectedReference sentinel and strict production projection.
Root independently reran both action suites:19tests passed with77assertions and zero failures.
This gives scoped component/action approval for the capture-stage extension, not database capture, wallet, or live staging approval.
