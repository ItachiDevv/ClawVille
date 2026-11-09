# Concrete signer review

Reviewed: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

## Scope

Reviewed the Linux driver, protected journal, fixed testnet RPC adapter, receipt helper, backend design, and tests. Production artifact activation remains false. This review used no keyring, paid provider, or live transaction.

## Findings and verified corrections

1. **Head age can expire during verification.** `assertTestnet` checks age before code reads. The final block check originally checked only the hash. An independent controlled-clock probe admitted a head aged 121 seconds after it entered verification at 119 seconds. The adapter must recheck age after all code reads and immediately before submission. Probe: `.brainchain-work/audit-signer-head-age.ts`. It replaces the code evidence and fetch with controlled fixtures; no network or signature is used.
2. **Caller mutation can change the driver transaction after validation.** `signTransaction` originally validated and hashed the caller object before awaiting the journal claim. Later signing and capture verification reused that object. A synchronous immutable snapshot must precede the first await. All checks, hashes, signing, and recovery comparisons must use the snapshot. This finding follows from source inspection. A Windows mock probe failed to replace native filesystem access and did not prove the execution path. A deferred-claim Linux regression must cover the mutation.
3. **ASCII decoding accepts high-bit aliases.** Node's ASCII decoder clears high bits. The documented exact hexadecimal key format therefore needs Latin-1 or strict UTF-8 decoding before its hexadecimal regex. The address check limits the effect, but the parser must enforce the documented format.

All three findings now have verified corrections. The final canonical head check compares hash and timestamp and checks age again. The send path checks age after asynchronous URL validation, immediately before fetch. The original independent 121-second probe now refuses admission. The driver copies and freezes the transaction synchronously before its first await. All later steps use that copy. Latin-1 decoding preserves high bits for rejection by the hexadecimal regex.

## Properties confirmed in source

The shared activation gate runs before key claims, key-file access, and direct RPC submission. The driver constructor inspects directory metadata but does not read key bytes. Mainnet transaction types and arbitrary signer destinations fail driver validation.

The fixed registry binds reference, filename, and expected address. The directory requires the non-root signer UID and mode 0700. The driver opens the key with O_NOFOLLOW and checks the open descriptor for UID, mode 0600, regular-file type, one link, and exact size. It verifies the derived address. Clearing the byte buffer does not guarantee erasure of JavaScript strings or library copies; process isolation remains necessary.

The journal requires the coordinator's matching intent claim before the driver's separate claim. An ambiguous driver claim cannot authorize another signature. The driver persists the signed payload before returning, so caller timeout does not discard a later capture. Replay verifies the captured transaction against the request and avoids key-file access.

The RPC URL is fixed. Requests omit credentials, reject redirects, validate the destination, cap response bytes, validate JSON-RPC identity, and have bounded timeouts. Broadcast submits exactly the supplied captured bytes once. Receipt reads verify the requested transaction hash and canonical block hash twice. Receipt inclusion remains provisional. Missing or orphaned receipts retain the nonce and protected bytes. No confirmation count releases authority or proves finality.

## Independent test evidence

- Driver restriction and RPC suites: 11 tests, 117 assertions passed.
- Corrected isolated exact-byte RPC fault suite: 1 test, 43 assertions passed. It rejects expiry during code reads and URL validation without submission.
- Real local PostgreSQL signer suite: 7 tests, 34 assertions passed, including receipt ownership and retained capture after reorg.
- Independent freshness probe: admitted a 121-second head before correction; rejected the same case after correction.

The reviewer inspected `docs/research/brainchain-2026-11-09/signer-linux-driver-evidence.md` and independently reran its corrected Linux fixture. It used public synthetic scalar 1, no network, and an isolated gate mock. It passed 1 test with 14 assertions. The deferred-claim mutation test preserved the original destination, calldata, gas, fee, and nonce. The high-bit key-byte test refused the input. The temporary container exited and was removed. This result does not authorize real key custody or activation.

## Remaining activation gates

No blocker remains within this inactive adapter scope. Keep the artifact gate closed. Mutable dependency state, freshness of the actual chain, explicit signing authority, process isolation, and the concrete root budget integration remain separate gates. The lead reported a stale testnet head. No successful live pilot follows from these local tests.
