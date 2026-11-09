# Independent exact-result consent review

Last audited: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

Verdict: BLOCKED on C1. No activation or live-key approval follows this review.

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
