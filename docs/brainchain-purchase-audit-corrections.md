# BrainChain purchase audit corrections

Date: 2026-11-09. Status: source corrections and controlled checks; independent re-review remains required.
Execution remains disabled. No real payment, signer credential, or paid inference call occurred.

## B1: approval wallet authority

Migration 0110 adds the current linked-wallet authority version and the purchase approval wallet/version tuple.
The database increments that version on a wallet or proof-time change. It rejects a manual version reset.
The safe-integer constraint prevents precision loss and fails closed on exhaustion.
A challenge records the exact current tuple. Proof verification and later capture compare that tuple.
Final dispatch compares it again after the final identity await, then checks the fresh database clock.
Legacy approvals with no tuple refuse. Unlink and A-to-B-to-A rotation cannot restore a previous approval.
Current GET/list responses report an obsolete approval as false and reflect the current owner approval policy.
A human can renew account approval for the frozen captured order. The ciphertext, task, nonce, and payment bytes stay unchanged.
The human panel disables Submit until required approval is current and exposes Approve account spend.
The same service enforces this authority on human and bound-agent paths. Only the human supplies account approval.

## B2: one account liability total

The shared query in apps/api/src/services/account-spend-liability.ts serves buyer and outbound vendor admission.
Both callers hold the same avatar spend-policy advisory lock before their checks and reservation insert.
The calculation uses exact six-decimal atomic units, not floating-point or rounded displayed cents.
Vendor pending/ambiguous rows count across UTC days. Paid rows count on their UTC day. Failed rows do not count.
Buyer reserved/captured/sending/uncertain and provisional payment/refund/reorganization states retain their liabilities across days.
A buyer authorization never also inserts a vendor ledger row. Each authorization counts once.
Testnet buyer authorizations consume this same owner-authorized global cap; there is no second testnet allowance.
This is budget accounting, not evidence of production token movement.
Solana mainnet network/token selection, external EVM consent, and the disabled testnet activation gate remain unchanged.

## Installed database composition

A cross-path fixture exposed a separate default-factory defect.
The installed Drizzle driver has no assumed client property and changes postgres.js timestamp/JSON serialization behavior.
The database package now retains and exports its existing lazy pool through getPostgresClient().
It creates no second production pool, credential source, or new configuration.
Buyer JSON/time writes use explicit text-typed parameters and casts. Reads normalize timestamps before decisions or DTO construction.
A child process exercises the actual default buyer factory and retained pool.
A separate controlled test executes approval, capture, final fences, and reconciliation after actual Drizzle initialization.
Backend owns the corresponding worker-policy factory correction.

## Evidence

- Guarded buyer PostgreSQL suite: 20 pass, 0 fail, 120 assertions.
- Human purchase panel: 4 pass, 0 fail, 16 assertions.
- Existing outbound/spend-policy suites: 37 pass, 0 fail, 126 assertions.
- Shared/database builds: exit 0.
- Full-schema fixture: migration 0108 then 0110, each applied twice; 32 buyer constraints observed.
- Root independently reran B1/B2: 2 pass, 4 assertions. B1 catches the pre-claim refusal before its zero-paid-call assertion.

The initial full-schema probe lacked the new 0108 buyer table and stopped. It passed after the prerequisite migration was applied.
The B1 original failing probe remains preserved. Root uses buyer-audit-wallet-rotation-corrected.test.ts for the refusal-aware rerun.
The independent audit report remains unchanged until its reviewer evaluates these corrections.

Reproduction:

```powershell
$env:BRAINCHAIN_DB_FIXTURE='1'
$env:BRAINCHAIN_LOCAL_FIXTURE='1'
bun test ./apps/api/src/services/brainchain/purchases.test.ts
bun .brainchain-work/buyer-authority-full-schema.ts
```

The test helper requires an explicit approved loopback fixture. CI uses BRAINCHAIN_TEST_DATABASE_URL instead of the desktop fallback.
A finality-based liability release, authenticated staging parity, device screenshots for the captured-order proof state, and a live test-token purchase remain separate release gates.

PARITY: human path: /brainchain Hire help and account proof; agent path: clawville_brainchain/hosted purchase operations and direct external-signer capture; both bind state and the shared cap to the canonical non-guest owner avatar.
