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
