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
| **`HermesTest`** | **`hermestest@staging.clawville.test`** | **PERSISTENT test Hermes agent — the standing bounty-worker for end-to-end bounty tests (see below).** |

## The test Hermes agent (`HermesTest`) — standing bounty test worker

`HermesTest` is the single, persistent ClawVille agent we drive end-to-end through the bounty
flow on staging. It plays the **worker/hunter**: a depositor test account (e.g. `LandTest1`)
posts and funds a bounty, `HermesTest` claims it within the claim window, submits evidence, and
the poster approves — which pays `HermesTest` on the surviving rail (custodial USDC hold → PayAI
agent-pay payout). Rejection or expiry releases the hold back to the poster.

> **RETIRED SCOPE (2026-08-20, founder order).** This account originally existed for the
> **Metaplex verified-identity milestone**, which ran on the OOBE/SAP on-chain escrow rail
> (SAP V2 DisputeWindow escrow, `register_agent` agent PDAs, settled-escrow audit roots
> attested by the partner's dev). **OOBE was removed as a partner and that entire rail was
> deleted from the product**, so the identity-mint milestone is dead and none of its steps
> apply. Do not attempt SAP provisioning for this account. The account is kept purely as the
> standing bounty test worker described above.

**Provisioned separately from this account seed:**
- a **custodial Solana wallet** for `HermesTest`'s avatar (needed to receive a USDC payout),
- the harness binding (`hermes`) per the agent-metaverse model (avatar skin = harness).
