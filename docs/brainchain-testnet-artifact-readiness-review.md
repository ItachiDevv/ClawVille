# BrainChain testnet artifact and dependency review

Reviewed: 2026-11-09. Reviewer: artifact_readiness, team brainchain-office.

## Verdict

The three dependency executables match the pinned source in this independent review. Their full runtime hashes remain unchanged at block 0x13ec.
Artifact admission remains incomplete because its shared hash map includes only five contracts. It omits these three dependencies.
Mutable governance and attestation observations now have fresh independent evidence. They do not establish an attested brain or approve the full governance dependency graph.
Keep both activation flags false. This report authorizes no key access, signature, transaction, provider charge, or deployment.

## Scope and constraints

The review covers dependency artifacts and public state only. It does not revisit the separate C1 consent review.
No credential store, wallet, database, Git index, migration, or paid API was used.
The only RPC endpoint was https://rpc.testnet.usebrainchain.com. Each state read used one explicit block number.
A final read confirmed the same block hash and timestamp. This establishes a bounded observation, not financial finality.

Trap list: runtime identity does not pin mutable authority; metadata exclusion needs bounds; compiler defaults can select older source; public getters need a canonical anchor.
The registry assigns protocol primitives to agent-protocol-partner. This reviewer changed no implementation primitive.
The historical domain memory supplied trap context only. Its old Hatcher status and release gates were not treated as current evidence.

## Independent artifact evidence

Pinned source: https://github.com/usebrainchain/brainchain/tree/348cc3726227a9a321d7593fd0e685904901d31e.
Four raw public files matched the local bytes: deployment manifest, DecisionLog, ModelRegistry, and TestUSDG sources.
A new local compilation used solc 0.8.24, optimizer runs 200, Shanghai, and the retained OpenZeppelin checkout.
Its three compiled runtimes exactly matched the retained compiled artifacts. The OpenZeppelin checkout was not independently downloaded again.
Current deployed executable bytes matched those artifacts after bounded metadata removal. All three artifacts have zero immutable references.
Full metadata still differs. Executable equivalence must not be described as exact deployment artifact identity.

| Dependency | Full deployed runtime hash | Result |
|---|---|---|
| DecisionLog | 0x917216bf47f6d0240fbf0646de38b45f32a4205015cbf61ef26c51b0faa20d58 | Executable match; old hash unchanged |
| ModelRegistry | 0xdd1e96eb781459c608ff34b82469c957ce90e408bccaaa39c5c86e60ea6d326b | Executable match; old hash unchanged |
| TestUSDG | 0x085a09654a7ff2ea410a62fff9309557c953bf29a0ccaa12b5ef4b830e33c226 | Executable match; old hash unchanged |

At 19:33:19 UTC, the public main-branch testnet manifest exactly matched the pinned manifest, including release 3.5.0.
This check covers deployment-manifest drift. It does not assert that every current main-branch source file equals the pinned commit.
The earlier five-contract, 55-slot immutable review remains separate evidence. This review did not repeat those 55 checks.

## Mutable authority observations

At block 0x13ec, DecisionLog.owner equals the manifest AdminTimelock address. pendingOwner is zero.
DecisionLog.brain remains 0x4c4EF8b7797667AC553274dDA0c08D777C5231a0. That address has no deployed code at this anchor.
DecisionLog.attestation equals the manifest DcapAttestation address. attestations is zero and tcbEvaluationNumber is zero.
DecisionLog.count remains 357. ModelRegistry.owner equals the manifest DecisionExecutor address.
TestUSDG reports six decimals, faucet amount 100000000, and faucet interval 86400 seconds.

DecisionLog source lets its owner replace the brain directly. That operation closes attestation until the owner reopens it.
The attestation path checks the verifier result, TCB status, image and app allowlists, nonce, and padded brain address.
A configured verifier does not prove that the current brain passed this path. The zero attestation count supplies no such evidence.
The owner can change the verifier, allowlists, and TCB evaluation number. Runtime identity alone cannot detect these changes.
ModelRegistry permits its owner to change model accounts, prices, activation, and its own owner.
TestUSDG has a public test faucet. Its source has no owner-controlled mint path beyond deployment minting.

AdminTimelock has 6536 runtime bytes with hash 0x28d179e16f2e4807732cc8a2531d51e7036fc5a3e46d0128605ee8324663cf37.
DcapAttestation has 9263 runtime bytes with hash 0xdafcf057f396dcd7437e6c6a5dc164ad72afbe0330467379308fa83798aa7f48.
These auxiliary hashes are observations only. This review did not establish their source equivalence, proxy graph, roles, collateral, or allowlist history.

## Admission gap and minimal correction

The source trace found no alternate mandatory runtime check for DecisionLog, ModelRegistry, or TestUSDG.
The production source consumers all use TESTNET_SIGNER_CODE_EVIDENCE.contracts:

- signer-observation.ts, line 30: collects and checks code at the selected observation block.
- signer-policy.ts, line 54: validates the collected code hashes before artifact admission.
- signer-rpc.ts, line 59: repeats runtime checks before broadcast.

The shared map in signer-code-evidence.ts has only five entries. The evidence JSON files do not execute admission checks.
Add the three dependency addresses and full hashes to that shared map. Retain the separate evidence provenance and metadata limitation.
Test each missing and mismatched dependency in observation, pure admission, and transport verification. A failed dependency must prevent submission.
The correction must preserve the final sequential anchor and acquisition deadline. It must not change either activation flag.

Mutable authority requires a separate reviewed policy before activation. Define approved owners, brain, verifier, and authority-change response explicitly.
Read the approved state at the same anchor as runtime checks. Persist the policy version with the authority evidence.
If the pilot accepts direct-owner brain trust, document that choice explicitly. Do not describe it as a verified TDX guarantee.
If the pilot requires TDX trust, verify the attestation path, allowlists, verifier dependencies, and current brain provenance first.
The present observation does not resolve that product trust decision.

## Remaining gates

1. Extend dependency runtime admission and independently verify negative regressions.
2. Define and enforce the mutable-authority policy and its precise governance trust boundary.
3. Complete any auxiliary contract review that the selected trust policy requires.
4. Preserve the existing isolated-process, protected root budget, custody, and explicit pilot-authority gates.
5. Run the authorized testnet lifecycle with actual hire, delivery, settlement, and interrupted recovery evidence.
6. Keep provisional inclusion separate from financial finality and liability release.

No blocker above requires a paid request for this review. No activation changed.

## Local evidence

All probes and outputs are inside the existing ignored job directory:

- .brainchain-work/artifact-readiness-probe.mjs
- .brainchain-work/artifact-readiness-current.json
- .brainchain-work/artifact-readiness-recompile.mjs
- .brainchain-work/artifact-readiness-recompile.json
- .brainchain-work/artifact-readiness-manifest-drift.mjs
- .brainchain-work/artifact-readiness-manifest-drift.json

The probe used unsigned eth_chainId, eth_getBlockByNumber, eth_getCode, and eth_call requests only.
The scripts are evidence tools, not production transport implementations. They do not replace production response-size and address validation.

## Bounded testnet authority policy, 19:37 UTC

This section narrows the earlier open trust decision. The authorized pilot can trust the protocol's configured authority for test tokens.
DecisionLog.record requires the configured brain. Protocol semantics do not require TDX attestation before ordinary decisions.
TDX provides an alternate brain-rotation path. This pilot makes no TDX, enclave, operator-independence, or governance-security guarantee.
Therefore, proof of the current brain's TDX provenance is not a prerequisite for this bounded pilot.

Proposed policy identifier: brainchain-testnet-configured-authority-v1.
Pin the policy in reviewed source, not a public manifest response, task text, request parameter, or automatically accepted database value.
Bind it to chain 274630, release 3.5.0, source 348cc3726227a9a321d7593fd0e685904901d31e, and the eight reviewed runtime hashes.
Store its version and deterministic content digest with operation authority evidence. Missing, unknown, or mismatched policy evidence must refuse a new effect.
A historical operation must not silently inherit a later policy. Recovery retains its original evidence and requires explicit reconciliation after policy changes.

The independent refresh at 19:37:50 UTC returned the following exact allowlist values at block 0x13ec:

| Contract getter | Required value |
|---|---|
| DecisionLog.owner | 0x2b70bcf8fe79e75f10a7dbf8d9ab6d63216f2273 |
| DecisionLog.pendingOwner | 0x0000000000000000000000000000000000000000 |
| DecisionLog.brain | 0x4c4ef8b7797667ac553274dda0c08d777c5231a0 |
| DecisionLog.attestation | 0xb364f47e16ea1555835f9593f409c39d3509f4c5 |
| DecisionLog.attestations | 0 |
| DecisionLog.tcbEvaluationNumber | 0 |
| ModelRegistry.owner | 0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366 |
| TaskBoard.owner | 0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366 |
| TaskBoard.guardian | 0x84d01e0869fbcb07c0141e49c390ffdc064d6882 |
| TaskBoard.feeRouter | 0x235658ee85939e2969e1bcbae1633769a414bd8a |
| WorkerStaking.owner | 0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366 |
| DecisionExecutor.board | 0x7a7cc5d35a642ccc268c7b263ff800bc7ebd52a4 |
| DecisionExecutor.models | 0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c |
| DecisionExecutor.guardian | 0x84d01e0869fbcb07c0141e49c390ffdc064d6882 |

Normalize addresses to lowercase before comparison. Validate each decoded address and exact integer type before comparison.
The attestation count and TCB number act only as change detectors. They do not establish an attestation guarantee.
Do not pin DecisionLog.count: ordinary protocol decisions must remain possible.
Do not pin individual ModelRegistry model records globally: task-specific hire evidence already binds the relevant model and worker.
The immutable token, decisions, models, and staking relationships remain covered by runtime hashes and the earlier immutable-value evidence.
Financial parameters, task deadlines, worker permission, stake, and board pause state still need their existing action-specific checks.
This authority allowlist does not replace those checks or approve unrestricted new fees.

### Required checks

Use fixed ABI getters at the same selected block as runtime checks. Start the existing 30-second acquisition window before the first read.
Fetch all fourteen getter results before the final sequential block read. Check block number, hash, and timestamp again.
A missing getter, decode failure, wrong value, changed anchor, expired acquisition window, or wrong chain refuses admission.
Apply this check to worker admission, execution admission, signer observation, and pre-broadcast transport verification.
The transport must perform its own check. A stored observation alone cannot authorize a later broadcast.
Keep the final current-authority callback after asynchronous URL validation. Do not reset observation time during this callback.
Retain the current distinction between response freshness and an old Nitro block timestamp.

The selected-block policy cannot guarantee that governance stays unchanged after the last read or during transaction inclusion.
This is an explicit trust boundary for the test-token pilot. Do not describe it as an atomic on-chain governance lock.
Read-only reconciliation remains available after drift. Stop new computation, signatures, and broadcasts until the drift receives review.
Retain captured bytes, reserved nonces, and uncertain liabilities. Do not re-sign, release holds, or change policy pins automatically.
A reorg or restored old value does not erase an observed unresolved operation or authorize a replacement signature.

### Auxiliary source boundary

There is no project src/AdminTimelock.sol in the pinned checkout. DeployTestnet.s.sol imports OpenZeppelin TimelockController.
Its deployment helper uses a two-hour delay for a new controller or accepts an explicitly supplied existing controller.
The manifest alone does not prove controller membership or current delay. This policy trusts the selected admin address without making those claims.
DecisionLog imports only the IDcapAttestation interface. The external verifier and its collateral are outside this pilot's trust assurance.
Changes inside the admin or verifier can occur without changing these fourteen values. This policy does not promise to detect every internal authority change.
No additional TDX or complete governance audit is necessary for the stated test-token assumption.
A mainnet release or an attested-brain claim requires a separate trust decision and evidence.

Evidence: .brainchain-work/artifact-readiness-authority-policy.mjs and .brainchain-work/artifact-readiness-authority-policy.json.
The final anchor retained hash 0xe3484924e3fd6e5613bfe5ba54801350f350b8d0d725adabb66fa3590dedf4c6.
No material product decision remains for this bounded assumption. Implementation and negative regression review remain necessary.


## Independent dependency correction review

Reviewed frozen evidence-map SHA-256: 4445d6afd80a964cf336c94bf0e3f29f66c1064a37ae556de9f7a2c39b83e926.
Verdict: approved within the dependency runtime admission correction scope. The earlier five-entry-map finding is resolved in this reviewed source.
The map now contains eight contracts. All three added addresses and full hashes exactly match this report's independent chain evidence.
The comment separates the original five-contract evidence digest from the later dependency evidence. No metadata-identity claim was added.

The existing observation, pure policy, and transport consumers iterate the expanded shared map. No alternate permissive path was added.
Both TESTNET_SIGNER_ARTIFACT_REVIEW.verified and TESTNET_SIGNER_CODE_EVIDENCE.approvedForSigning remain false.
The transport retains its final sequential anchor, acquisition deadline, and current-authority callback before submission.
The observer retains its final block number/hash/timestamp checks and freshness check.

Independent execution used three separate Bun processes, without shared database access or public RPC:

| Suite | Tests passed | Assertions |
|---|---:|---:|
| signer-policy.test.ts | 9 | 54 |
| signer-observation.test.ts | 16 | 333 |
| signer-rpc-send.test.ts | 1 | 128 |

Each dependency has an explicit address and expected full hash in policy tests. Missing and mismatched hash evidence refuses.
Observation tests independently name each dependency and return absent code or different code. Both cases refuse the observation.
Transport tests independently name each dependency and assert one targeted read, refusal, zero authority callbacks, and no additional submission.
The explicit target assertions prevent a shortened shared map from making these transport tests pass without reading the dependency.
Existing expiry, reorg, exact-byte submission, and ambiguous-send tests also pass in this run.

The transport suite replaces activation and hashes only inside its isolated test process. It sends no network request and uses no key.
This approval does not approve mutable-authority implementation, activation, custody, a paid call, or a live testnet lifecycle.
The bounded mutable-authority policy above remains the next implementation task.

## Configured-policy implementation pre-read

Reviewed the full implementation design and the initial configured-authority.ts draft. The draft is not frozen or approved.
The fourteen getter targets and expected values match the independently refreshed policy table. The policy digest includes the eight runtime hashes.
The reader already uses the selected block, a bounded acquisition window, and a final sequential anchor check.

Early constraints sent to the backend owner:

1. Snapshot the caller's observation timestamp before awaits. Return a new Date so caller mutation cannot refresh the returned evidence.
2. Each getter returns exactly one ABI word. Reject wrong lengths, trailing bytes, and noncanonical padding before admitting the result.
3. A version/digest pair identifies expectations only. It cannot substitute for fresh getter evidence at an effect boundary.
4. Ordinary historical NULL grants must fail new effects. Never replace their NULL policy with the current pair automatically.
5. A persisted fresh exact-recovery authority can permit the documented historical-byte broadcast path. It cannot rewrite original evidence, bytes, nonce, or ceilings.
6. Read-only journal inspection and receipt reconciliation remain available during drift. They cannot invoke another key or provider.

The baseline source confirms distinct effect boundaries that need explicit coverage:

| Boundary | Required policy check |
|---|---|
| Owner authority issuance | Current version/digest plus fresh matching observation |
| Execution admission | Stored authority pair and fresh evidence before consumption, after row locks |
| Compute reservation and dispatch | Mandatory trusted policy fence for owner-issued workers, including calls outside the scheduler |
| Result signature and transaction capture | Current pair and evidence at the final key callback |
| Delivery and exact-capture recovery | Persisted authority pair; fresh observation; original immutable operation remains unchanged |
| Broadcast | Fresh transport getter checks plus current durable authority callback before send |
| Journal/receipt/status reconciliation | No new effect; preserve access and unresolved liabilities |

The baseline proxy accepts an optional workerFence. Its comment distinguishes root-only trials from autonomous worker composition.
The implementation must identify owner-issued worker authority from durable records. Omitting a constructor callback must not bypass that worker policy.
Root budget verification remains independent. A valid policy cannot create budget, and a valid root budget cannot replace worker authority.

The baseline signer service exposes recoverCapturedOperation separately from broadcastCapturedOperation. Preserve that separation.
The capture helper checks artifact admission before its accepted-operation branch. Do not accidentally make it the only path to historical read-only recovery.
The final broadcast callback runs after asynchronous transport checks. Current database time and policy evidence must still pass at that point.

These are source pre-read constraints, not findings against a frozen implementation. No draft tests ran during this pre-read.
Final approval requires frozen source, independent negative tests, and the separate database review for migration 0117.

## Frozen reader review: two final-response blockers

The independent owner-suite run passed 25 tests and 565 assertions. Source review confirmed fourteen exact pins, canonical ABI words, and timestamp snapshots.
However, the independent final-response probe failed both required refusal cases:

- A final RPC advances the controlled clock beyond the caller's 100-millisecond deadline, but remains inside the global 30-second window.
- A final RPC aborts the caller's signal synchronously and then returns the expected anchor.

Both cases returned authority evidence. The probe expected refusal: zero passed, two failed.
Probe: .brainchain-work/artifact-readiness-final-boundary.test.ts. Run with bun test ./.brainchain-work/artifact-readiness-final-boundary.test.ts.
The probe uses controlled RPC responses and clock state. It invokes no public endpoint, key, provider, or transaction.

The bounded helper checks the deadline before the await but lacks a post-await check. Final evidence validation checks only global freshness.
The helper also invokes rpc before installing its local abort rejection listener. A synchronous caller abort can occur before that listener exists.
Install cancellation handling before invocation. Recheck caller abort, local abort, and the exact absolute deadline after each awaited result.
Repeat those checks before returning final evidence. Preserve the original acquisition timestamp and the tighter caller deadline.

Verdict: reader approval withheld until both probes refuse. The backend owner received these findings and the exact probe path.
This finding concerns the frozen reader only. Consumer integration and migration 0117 remain outside this review.

## Independent reader correction verdict

Reviewed source SHA-256: 598bb935848fc574a8209fa1d8ff8c324ffc5889b34f8327394b41d4704650e6.
Verdict: approved within the frozen configured-authority reader and pure-policy scope. Both final-response blockers now refuse in the original independent probe.
The unchanged independent probe passed two tests and two assertions. The separate owner suite passed 27 tests and 653 assertions.

The correction installs cancellation handling before deferred RPC invocation. After each await, it checks local abort, caller abort, and the absolute deadline.
The final return repeats caller cancellation and deadline checks. The original acquisition timestamp remains unchanged.
Late completion cannot restore evidence after the returned promise rejects. The existing delayed-read test also confirms no final anchor follows the timeout.
Strict single-word ABI checks, canonical re-encoding, fourteen exact pins, and the final sequential anchor remain present.

This verdict covers no consumer integration, migration 0117, operation-policy propagation, activation, or live testnet lifecycle.
No network request, key, provider charge, database change, or application-source edit occurred during this correction review.

## Configured-policy consumer review, first findings

Scope: new configured-policy propagation only. This review does not repeat the separate C1 review.
The backend supplied .brainchain-work/configured-authority-consumer-freeze.json with nineteen source hashes.
The core nine consumers include issuance, execution, compute, signer service, result signatures, delivery, and exact recovery.
No overall consumer approval follows from the reader tests.

### CP1: exact capture lacks a shared hire/policy anchor

ExactCaptureRecovery.current originally validated fresh configured evidence but discarded its selected block and hash.
It therefore lacked the equality check already present in execution admission and DeliveryRecovery.verify.
The backend confirmed this omission and added the block/hash equality guard. The exact-capture freeze reopened only for that correction.
A focused negative test must supply valid policy evidence from another block or hash and observe refusal before acceptance or key effect.
The same-anchor positive path must remain reachable. Independent regression execution remains pending.

### CP2: effect policy enters the reconciliation reader

createWorkerDeliveryEvidenceReader unconditionally calls readConfiguredAuthority before returning canonical hire evidence.
DeliveryRecovery.verify always invokes its evidence reader, including stage reconcile. Its explicit policy exemption occurs later.
Composing these two exported services therefore rejects read-only reconciliation when the configured brain or owner drifts.
The design requires reconciliation to remain available while new effects stop. Keep canonical hire reads separate from effect-policy enforcement.
Effect stages still require their fresh policy reader and shared anchor. A public caller must not select a bypass for those stages.
No production instantiation of this exported worker evidence reader was found in the source search. This finding concerns the intended integration composition.

The independent existing worker-delivery-evidence suite returned three passes and one failure.
Its idle positive failed with Configured authority ABI word required after the new getter reads entered its task-only RPC fixture.
This failure proves stale test coverage; the separate source trace establishes the reconciliation-policy coupling.
The backend owner received both findings. No database fixture, live RPC, key, provider, or transaction was used.

### Source observations, pending final evidence

The proxy now checks the persisted execution policy and requires workerFence for owner-policy grants, even outside the scheduler.
It repeats policy and database-time checks after asynchronous root verification before provider dispatch.
Signer operations copy the current pair from the persisted grant. Ordinary historical NULL operations refuse current admission.
Exact delivery authorities persist a current pair for effects and retain NULL pairs for reconcile-only grants.
Result-signature journal recovery and captured-transaction recovery remain separate methods without a new policy read.
These observations are scoped source evidence. Final consumer approval still requires corrected frozen source and the targeted database regressions.

## Independent CP1 and CP2 correction verdict

Verdict: both configured-policy consumer findings are resolved in the reviewed frozen source and targeted independent tests.
Exact-capture source SHA-256: 165a60eba043c42f5c0d34bbe65b46cd8ec079745ed882149695dd4eef12a0c8.
Read-only worker evidence source SHA-256: 278507717a9d98b3ad12e5862d6e52be81243340f9a00ac6e24ccc81e23dbfac.
Both hashes match the refreshed consumer freeze manifest.

Independent runs used separate processes and the coordinated disposable PostgreSQL fixture on port 55439:

| Regression | Tests passed | Assertions | Observed boundary |
|---|---:|---:|---|
| Different configured block or hash | 1 | 6 | Both mismatches refuse; accepted_at stays NULL; zero key calls |
| Expired retained capture and replay | 1 | 16 | Same-anchor positive captures once and preserves nonce and original authority |
| Authority drift during reconciliation | 1 | 5 | Reconciliation records provisional evidence without a policy read; upload refuses and leaves grant unconsumed |
| Worker evidence reader | 4 | 13 | Idle positive, reorg, acquisition expiry, and code mismatch checks pass |

The positive capture test uses a public synthetic fixture key and local mock driver. No production key or transaction is involved.
The delivery test injects controlled chain evidence and a policy reader that refuses. Its result does not establish live chain reconciliation.
The corrected worker evidence reader no longer fetches configured authority. Effect consumers retain their independent policy enforcement.
The exact-capture consumer compares configured block and hash against hire evidence before acceptance. It retains final database-time checks.

After the targeted tests, the reviewer restored fixture wrappers in order: migration 0112, then migration 0115.
The restoration returned FIXTURE_WRAPPERS_0112_0115_RESTORED. Port 55439 was released to the team with no active review process.

No further configured-policy blocker was confirmed in this scoped source pass. This is not overall integration approval.
The separate migration 0117 review and combined consumer regression run remain release evidence requirements.
Historical NULL ordinary grants still refuse effects. Fresh exact recovery uses its own current authority without rewriting original operation policy.
Read-only captured-byte recovery remains separate. Neither this verdict nor the fixture gate substitutes authorize activation.
