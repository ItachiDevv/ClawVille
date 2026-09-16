# ClawPump integration

**Last Audited: 2026-09-16.** Trading Floor wave 2d requires a signed wallet-ownership challenge before founder pairing. The ClawPump signal client remains blocked because the immutable specification contains no endpoint paths, response schemas, or recorded ClawPump fixtures.

## Boundary

ClawPump supplies market intelligence and the founder's observed agent. It is not an execution rail. Its trade result lacks the quote binding, exact transaction validation, durable idempotency, captured signature, and explicit chain recovery required for ClawVille custody.

ClawVille executes fleet swaps only through Jupiter. The core observer can verify and score the founder's external ClawPump wallet after pairing. ClawVille does not hold that external wallet key and cannot halt its trades.

## Endpoint contract

| Purpose | Endpoint | Status |
|---|---|---|
| Board or agent intelligence | `TODO-SEAM:clawpump-endpoint-contract` | No path or response schema exists in the final specification. |
| Founder ownership challenge | `POST /api/admin/trading/pair/challenge` | Takes `avatarId` and `walletPubkey`. It returns the exact four-line ed25519 message and a single-use wallet nonce. The write also requires a separate money-operator nonce header. |
| Founder agent pairing | `POST /api/admin/trading/pair` | Takes `avatarId`, opaque `clawpumpAgentId`, `walletPubkey`, objective, wallet `nonce`, and detached base58 `signature`. It verifies wallet control, binds an observe-only agent wallet, and forces `operatedByClawville=false`. |
| Founder agent lookup | `TODO-SEAM:clawpump-endpoint-contract` | A later API-driven lookup needs a documented path, response schema, and recorded fixture. |
| Trade execution | None | Forbidden for ClawVille custody. |

## Fixture inventory

`TODO-FIXTURE:clawpump`: the supplied scratchpad contains no ClawPump JSONC fixture. The client must remain absent until recorded fixtures define strict response schemas.

The Jupiter fixture inventory is separate. The four files live under `apps/api/src/services/__tests__/__fixtures__/jupiter/` and their SHA-256 values are fixed in the Wave 2 report.

## Operations

### Founder pairing

1. Set `CLAWVILLE_API_URL`, operator origin, operator cookie, and genesis avatar ID.
2. Add `--production` when the API host is `api.clawville.world`.
3. Run `bun apps/api/scripts/trading/pair-genesis.ts <walletPubkey> --challenge [--production]`.
4. Sign the returned `messageToSign` with the ClawPump wallet.
5. Keep the returned wallet nonce and encode the detached signature as base58.
6. Run `bun apps/api/scripts/trading/pair-genesis.ts <walletPubkey> <walletNonce> <signature> [--production]`.
7. If the key is not available locally, export genesis's detached signature from its signer and submit the same message.

The wallet nonce expires after two minutes and is consumed once. The money-operator nonce is separate and expires after one minute.

### Signal client

1. Record read-only ClawPump responses from the approved environment.
2. Remove credentials and preserve each file byte-for-byte.
3. Record SHA-256 values.
4. Define an HTTPS host allowlist and explicit path prefixes.
5. Derive strict Zod schemas from all fixtures.
6. Add daily call accounting and bounded timeouts.
7. Keep execution methods absent.
8. Run only fixture-backed tests before staging.

`CLAWPUMP_API_KEY` gates signal reads only. Its absence must never stop Jupiter execution. `CLAWPUMP_FIXTURE_DIR` is test only, and staging or production refuses boot when it is set.
