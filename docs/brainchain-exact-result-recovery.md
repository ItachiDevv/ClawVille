# Exact-result recovery consent

Last Audited: 2026-11-09. Source and local fixture evidence only. Independent audit remains required.

The separate consent covers one retained output. It does not restart compute or resume the worker.
The original execution revocation, compute charge, transaction nonce, and captured bytes remain unchanged.

## Authority and interfaces

The private worker recovery panel and private recovery routes share the exact-result consent service.
A bound agent uses recovery, recovery_request, recovery_narrow, or recovery_revoke through clawville_brainchain or hosted ACTION brainchain.
Protocol126 documents the same operations. Human challenge and approval routes refuse agent headers.
A live human session and the current linked Solana wallet sign the domain-bound exact payload hash.
The payload binds avatar, worker, task, hire snapshot, attempt, result, output hashes, generations, wallet version, stages, gas, expiry, and revocation provenance.
A request expires within ten minutes. A wallet challenge expires within two minutes and permits five attempts.
Wallet rotation and A-B-A rotation invalidate old proofs through the monotonic wallet version.
Narrowing atomically revokes the old consent and creates a smaller request. A fresh human signature must approve that request.
Unknown, legacy, root, or security revocation lacks owner-control provenance and refuses owner-only recovery.

Migration0112 records owner-control provenance in the same transaction that revokes issued authority.
The append-only record identifies the policy revision, actor, authority, and exact revocation timestamp.
Legacy delivery authority retains legacy-depth12-age120-v1. Only explicit exact consent can select nitro-testnet-latest-v1.
This worker observation policy does not change stableBlock or financial finality.

The separate issuer creates only the selected delivery stage and, where necessary, exact signature or submit gas authority.
It cannot allocate compute, provider money, or lifecycle authority.
Delivery checks validate the complete lineage before and after chain reads within one transaction.
The final database clock checks consent, session, stage grant, and lease expiry after waits and locks.
The submit key callback validates exact consent issuance while the worker stays paused.
Exact consent operations also require this fence when the worker has a running state.

## Retained uncertainty and explicit gap

Unknown upload permits evidence-only reconciliation. The same accepted upload token can finish its known in-flight upload.
Captured broadcast retains its original operation, nonce, bytes, and gas ceiling.
An accepted key-use gap remains evidence-only and cannot cause a second signature.
A retained unsigned operation with expired or revoked original grants remains refused.
That case requires the separate exact-capture design and independent review. This increment does not implement that authority.
The public panel and agent tools do not activate the scheduler. Execution remains disabled pending review.

## Verification

The opt-in loopback PostgreSQL suite uses the canonical shared getPostgresClient and real Drizzle signer composition.
It uses ephemeral fixture signatures and deliberately invalid transaction bytes. It makes no network request or real key call.
The positive paused-worker test reaches prepare, nonce reservation, capture admission, and driver.assertCurrent.
The negative key-boundary test revokes consent after durable key claim and proves zero driver calls.
The owner-revocation test verifies nested provenance through PostgreSQL JSONB key reordering.
The suite also covers wallet versions, cross-avatar scope, replay, reduced limits, final evidence expiry, and security revocation.
Run it alone with BRAINCHAIN_DB_FIXTURE=1 and BRAINCHAIN_LOCAL_FIXTURE=1.
Fixture migration replays must remain serial with the worker policy and buyer suites.

PARITY: human path: private Office recovery panel and routes; agent path: bound-session MCP and hosted recovery operations; authority binds to the same resolved avatar. Only the human wallet grants authority.

Final local verification: consent PostgreSQL11 tests/42 assertions; auth, hosted, MCP, topic130 tests/1022 assertions; human panel1 test/9 assertions. Shared build and API/web TypeScript checks exited0. The independent CI lane also replayed the11 consent tests on its disposable PostgreSQL fixture. Synthetic browser data is in the ignored exact-recovery-visual-fixture.json under .brainchain-work. Browser evidence and independent consent review remain gates.

The hosted decision receipt lasts at most thirty seconds and ends at an earlier live consent expiry. It carries observations only. Every operation rechecks authority in the database. The receipt contains no output text, signature, protected payload reference, or permission to execute.

## C1 correction ? 2026-11-09

The independent audit reproduced exact submit authority without a delivery lease while ordinary execution remained live. Revocation after durable key claim did not prevent the fixture driver call.
Consent detection now starts from persisted signer and gas authority IDs. Preparation supplies both IDs before operation insertion. Later fences load both IDs from the immutable operation. Any exact ID requires one matching issuance, its exact signer/gas pair, and its issued delivery lease. The ordinary result fence cannot substitute. Missing or mismatched lease data refuses preparation or later admission.
The result-signature authority method also detects exact issuance through its signer authority ID. It requires the matching signature delivery lease before the ordinary result path can execute.

Correction tests passed13 tests/64 assertions. Tests include live ordinary execution, omitted or altered lease proof, nonce refusal after revocation, and driver callbacks after revoke, narrow, or expiry. The sibling result-signature test proves omitted lease refusal and revocation at its key callback. Positive exact submit and result-signature fixture paths still reach their drivers. Ordinary signer and receipt suites passed9 tests/68 assertions. Only artifact admission uses a test substitute. No real key or network request occurs. Independent correction review remains required.

## C2 human approval terms ? 2026-11-09

The human panel shows the retained operation ID, reserved nonce, transaction hash, and maximum retained gas charge in wei before wallet approval. Decimal strings remain exact, including integers above the JavaScript safe-number limit. A null nonce says Not reserved. A null transaction hash says Not captured. Missing values say Unknown (not recorded). A null retained-operation object differs from an absent record. Incomplete broadcast terms cannot request a wallet challenge.

The typed optional captureIntent display shows the operation ID, original operation digest, chain, signer, destination, value, nonce, gas limit, maximum fee per gas, and maximum priority fee per gas. Expandable text shows exact unsigned calldata. The panel never renders signed transaction bytes or protected payload references. Incomplete exact transaction terms cannot request a wallet challenge. The capture-submit request selector remains unavailable pending the separate0115 authority review.

Hash and calldata text use wrap rules. Controls and the calldata disclosure use a minimum44px target. Panel tests pass5 tests/38 assertions; web TypeScript check exited0. Tests assert retained fields at the wallet-call boundary, exact integer preservation, null/missing distinctions, future transaction terms, and refusal of incomplete broadcast terms. No browser was available for this correction. DOM tests do not establish visual layout or device proof.

PARITY: humans inspect exact transaction terms before wallet approval; bound agents request the same hash-bound consent through existing recovery operations. Agents cannot grant authority. The backend authority and the resolved avatar remain unchanged by this display correction.
