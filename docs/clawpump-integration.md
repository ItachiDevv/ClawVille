# ClawPump integration

**Last Audited: 2026-09-16.** Trading Floor wave 2c adds address-driven founder pairing. The ClawPump signal client remains blocked because the immutable specification contains no endpoint paths, response schemas, or recorded ClawPump fixtures.

## Boundary

ClawPump supplies market intelligence and the founder's observed agent. It is not an execution rail. Its trade result lacks the quote binding, exact transaction validation, durable idempotency, captured signature, and explicit chain recovery required for ClawVille custody.

ClawVille executes fleet swaps only through Jupiter. The core observer can verify and score the founder's external ClawPump wallet after pairing. ClawVille does not hold that external wallet key and cannot halt its trades.

## Endpoint contract

| Purpose | Endpoint | Status |
|---|---|---|
| Board or agent intelligence | `TODO-SEAM:clawpump-endpoint-contract` | No path or response schema exists in the final specification. |
| Founder agent pairing | `POST /api/admin/trading/pair` | Version one takes `avatarId`, opaque `clawpumpAgentId`, validated `walletPubkey`, objective, and `operatedByClawville=false`. It performs no ClawPump API call. |
| Founder agent lookup | `TODO-SEAM:clawpump-endpoint-contract` | A later API-driven lookup needs a documented path, response schema, and recorded fixture. |
| Trade execution | None | Forbidden for ClawVille custody. |

## Fixture inventory

`TODO-FIXTURE:clawpump`: the supplied scratchpad contains no ClawPump JSONC fixture. The client must remain absent until recorded fixtures define strict response schemas.

The Jupiter fixture inventory is separate. The four files live under `apps/api/src/services/__tests__/__fixtures__/jupiter/` and their SHA-256 values are fixed in the Wave 2 report.

## Operations

1. Record read-only ClawPump responses from the approved environment.
2. Remove credentials and preserve each file byte-for-byte.
3. Record SHA-256 values.
4. Define an HTTPS host allowlist and explicit path prefixes.
5. Derive strict Zod schemas from all fixtures.
6. Add daily call accounting and bounded timeouts.
7. Keep execution methods absent.
8. Run only fixture-backed tests before staging.

`CLAWPUMP_API_KEY` gates signal reads only. Its absence must never stop Jupiter execution. `CLAWPUMP_FIXTURE_DIR` is test only, and staging or production refuses boot when it is set.
