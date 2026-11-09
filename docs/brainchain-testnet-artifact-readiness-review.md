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
