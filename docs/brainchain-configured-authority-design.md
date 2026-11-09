# BrainChain configured authority implementation

Last Audited: 2026-11-09. Team: brainchain-office. Backend owner; root coordinates; artifact reviewer checks independently.

## Plan

1. Add a fixed policy module for brainchain-testnet-configured-authority-v1. Its canonical digest binds chain 274630, release 3.5.0, source commit, eight runtime hashes, and the fourteen reviewed getter values. Treat the configured brain as trusted for test tokens. Make no TDX claim.
2. Add a bounded getter reader with strict address/integer decoding. Use the caller's selected block and acquisition start. Complete all reads before a final sequential anchor check. Integrate the reader into signer observation and fixed RPC transport without changing their activation flags.
3. Add nullable version/digest pairs to signer authorities, signer operations, execution authorities, delivery authorities, and exact capture authorities in migration 0117. Preserve historical NULL pairs. Enforce pair consistency and immutability; do not backfill approved evidence. New effect admission requires the current pair and fresh matching chain evidence.
4. Propagate evidence through owner issuance, execution admission, mandatory compute fences, result signing, delivery, exact recovery, and broadcast. Read-only status and protected captured-byte inspection remain available. Old bytes and nonces remain immutable; a fresh explicit recovery authority supplies current policy for permitted broadcast.
5. Test the pure policy and reader first. Then test final transport and actual shared-pool authority consumption. Cover missing policy, all getter drift, wrong chain, changed anchor, expiry after awaits, historical NULL grants, and ordinary configured brain admission with zero attestations.

## Trap list

- Runtime hashes do not prove mutable governance state. The fourteen getters are mandatory at each fresh effect observation.
- The policy trusts configured addresses; it does not audit internal timelock membership or verifier collateral.
- Zero attestations is an exact change detector, not a TDX claim. Do not pin DecisionLog.count or all model records.
- Start the existing acquisition deadline before network reads. Never reset it during authority callbacks.
- A policy digest identifies immutable expectations; it cannot replace a fresh same-anchor observation.
- Final database clocks follow all asynchronous callbacks and row locks. Use the transaction connection inside a transaction.
- Historical NULL policy pairs cannot inherit the current policy. Preserve read-only recovery and uncertain liabilities.
- Fresh exact recovery cannot rewrite original revocations, original operation policy, bytes, nonce, or fee ceilings.
- Preserve C1 persisted authority linkage. No caller-supplied override can authorize a key effect.
- Owner-issued compute requires the trusted policy fence even outside the scheduler. Root budget authority remains separate.
- Both activation flags remain false. No live key, provider call, transaction, live migration, or deployment occurs in this task.

## Ownership and coupling

Backend owns policy/reader modules, targeted observation/transport checks, issuer/execution/proxy/delivery consumers, schema 0117, and tests. Identity owns independent schema/CI review. Funding owner retains funding services and migration 0116. Shared fixture operations remain serialized.

The signer, result-signature, exact-capture, and delivery consumers need narrow integration edits because their final callbacks consume authority after asynchronous work. These changes preserve existing consent predicates and add policy checks alongside them. Explicit historical-byte recovery requires a fresh persisted recovery authority rather than rewriting old operation evidence.

PARITY: human and bound-agent worker paths consume the same durable owner and recovery authorities. This policy adds no public approval shortcut.

## Historical captured transaction recovery linkage

Fresh recovery requests sign the configured policy version and digest inside the existing consent payload. Issuance verifies those signed values and fresh chain evidence before it records a new delivery authority. A broadcast grant binds the retained operation ID, transaction hash, nonce, result, and exact gas liability through the existing issuance and lease tables. The operation keeps its original NULL or historical policy pair. Only this fresh persisted exact-consent broadcast grant can supply current policy. Ordinary operation checks reject historical pairs. Reconciliation and protected-byte inspection do not require new policy authority. C1 authority-ID and exact-consent predicates remain mandatory.

## Consumer freeze evidence, 2026-11-09

The final consumer source passed API typecheck (exit 0). All nine injected-reader consumers enforce a caller-owned two-second bound, propagate cancellation, and reject late results. The scheduler passes the trusted reader into its issuer. The default reader remains the fixed testnet reader.

Independent schema checks passed 30 pair cases, five historical rewrite refusals, lineage refusals, and full-schema replay twice. Fourteen retained late captures stayed unchanged. The independent deferred-reader execution probe released locks by 2,300 milliseconds without consuming authority or creating an attempt. Combined CI and independent consumer review remain separate gates. Both activation flags remain false.

The consumer pre-read found a missing exact-capture anchor comparison. The capture boundary now requires the configured observation block number and hash to equal the hire evidence anchor before acceptance or key access. The focused PostgreSQL regression passed one test with six assertions. Independent consumer review remains pending.

The hire evidence reader now excludes configured governance checks. Read-only reconciliation remains available after governance drift. Effect consumers require their own current policy observation and matching anchor. Targeted PostgreSQL coverage passed one test with five assertions for reconciliation versus upload refusal. The canonical hire reader passed four tests with thirteen assertions. Migration 0112 and 0115 wrappers were restored after the fixture tests.

The scheduler passes its trusted configured-authority reader into both the authority issuer and the concrete inference proxy. The coordinator inherits the same runtime reader. Recovery issuers also receive it. This prevents a controlled host composition from silently switching to the default RPC reader during compute. The default production composition still uses the fixed testnet reader.
