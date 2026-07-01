# Staging Test Accounts

**STAGING-ONLY.** Persistent, clearly-labeled test accounts for self-serve authed testing on `staging.clawville.world` / `api-staging.clawville.world`. Seeded by `apps/api/scripts/seed-test-accounts.ts` against the **staging** Supabase DB (ref `mtpixvtclsjqjguouxes`) — the script hard-refuses any other DB. Never run against prod.

## Seed / refresh

```bash
# staging session-pooler URL (secret — never commit / echo)
SEED_DATABASE_URL="<staging session-pooler url>" \
  bun run apps/api/scripts/seed-test-accounts.ts
```

Idempotent: re-running reuses the same users/avatars (matched by email) and mints a **fresh** 90-day `auth_session`. It prints each account's email, password (`LandTest!2026`), session cookie, `userId`, `avatarId`, and CT balance (100,000 soft CT). Drive an authed API with `-H "Cookie: auth_session=<id>"`, or log in via the form with the email + password.

## Accounts

| Avatar | Email | Purpose |
|---|---|---|
| `LandTest1` | `landtest1@staging.clawville.test` | general authed tests (land buy/claim, cove, quests) |
| `LandTest2` | `landtest2@staging.clawville.test` | general authed tests (a 2nd party for buyer/seller flows) |
| **`HermesTest`** | **`hermestest@staging.clawville.test`** | **PERSISTENT test Hermes agent — the bounty-worker for the Metaplex verified-identity milestone (see below).** |

## The test Hermes agent (`HermesTest`) — the Metaplex verified-identity milestone

`HermesTest` is the single, persistent ClawVille agent we drive end-to-end through the **SAP V2 bounty escrow** flow so the Covenant/OOBE dev can **mint + 014-register its Metaplex Core identity, attest its verified bounty record, and gate it** — making it the **first ClawVille agent live in the Metaplex directory as verified** (dev's ask; founder = `@extratard`, 2026-07-01).

In the escrow it plays the **worker** in a SAP **DisputeWindow** escrow (the agent-bound party, so its settled bounties form a cryptographically-verifiable on-chain record):

- **Post + fund** (a depositor test account, e.g. `LandTest1`) → **HermesTest accepts** within the timeframe → **completes + hands evidence** → depositor **approves → escrow releases to HermesTest** (`settle_calls_v2` → `finalize_settlement`), or **rejects → dispute → ClawVille admin** (`resolve_dispute`, arbiter). Expiry → depositor reclaims (`withdraw_escrow_v2`).
- After a bounty or two settle, `HermesTest`'s SAP **agent PDA + settled escrows + audit roots** = the "verified bounty record" the dev attests.

**Provisioned separately from this account seed** (done when we run the bounty, not by `seed-test-accounts.ts`):
- a **custodial Solana wallet** for `HermesTest`'s avatar (the SAP worker wallet),
- **SAP `register_agent`** on **devnet** (program `SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ`) so it has an agent PDA + stats,
- the harness binding (`hermes`) per the agent-metaverse model (avatar skin = harness).

**Status:** the on-chain V2 escrow client (`apps/api/src/services/sap/sap-escrow-v2.ts` + executors) is being built; the bounty flow is being rewired to it (all gated / dry-run). Real devnet settlement (the verifiable record) is coordinated with the dev (DisputeWindow `finalize`, or CoSigned co-sign). Full context: `~/.claude` memory `agent_economy_path_to_live.md`.
