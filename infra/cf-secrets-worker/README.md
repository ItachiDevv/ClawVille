# ClawVille Secrets Store Worker

Envelope-encryption gateway for per-row data-encryption keys (DEKs) used by
`wallets`, `users.identity_*`, and other at-rest secret storage. The master
key-encryption key (KEK) lives exclusively inside Cloudflare and is never
persisted on the Hetzner VPS.

See Phase 5.1 plan §8 and `apps/api/src/services/keypair-vault.ts`
(`encryptSecretKeyEnveloped` / `decryptSecretKeyEnveloped`) for the caller
side of this Worker.

## One-time setup

```bash
cd infra/cf-secrets-worker
bun install                    # installs wrangler
bunx wrangler login            # opens browser, authorizes Cloudflare CLI

# Pick a Cloudflare account if the CLI prompts. This repo deploys under
# your personal account by default; swap via CLOUDFLARE_ACCOUNT_ID env if
# you want a different target.
```

## Generate and upload the KEK

The KEK is a 32-byte random value. Generate it locally and paste into
the wrangler secret prompt — NEVER commit it to git.

```bash
# Generate 32 random bytes, base64-encoded
openssl rand -base64 32

# Paste the value when prompted:
bunx wrangler secret put KEK_V1
```

Hex is also accepted if you prefer:

```bash
openssl rand -hex 32
# Worker auto-detects hex vs base64 by length.
```

Rotation procedure: provision `KEK_V2`, re-wrap every DB row via a
background job that decrypts with `KEK_V1` and re-wraps with `KEK_V2`,
then flip `encryptionVersion` on those rows. Worker supports only the
current generation so runbook is a two-deploy swap.

## Generate and upload the bearer token

This bearer authenticates the Hetzner API to the Worker. Rotate it
independently of the KEK whenever the API VPS is re-provisioned.

```bash
openssl rand -base64 48
bunx wrangler secret put WORKER_BEARER
```

Take the exact same value and set `CLOUDFLARE_WORKER_BEARER` on the
Hetzner API container (see `CLAUDE.md` §Deployment for the Coolify
tinker command).

## Deploy

```bash
# From the infra/cf-secrets-worker directory
bunx wrangler deploy
```

The Worker deploys to `clawville-secrets.<your-account>.workers.dev`.
Copy that URL into Hetzner as `CLOUDFLARE_WORKER_URL` (no trailing
slash). Re-deploy the ClawVille API so it picks up the env change.

A one-shot deploy from the repo root is also wired up:

```bash
bun run deploy:cf-secrets
```

## Smoke test

```bash
# Replace URL + BEARER below
export URL="https://clawville-secrets.<account>.workers.dev"
export BEARER="<value you set above>"

# Random 32-byte DEK
DEK=$(openssl rand -base64 32)
echo "DEK: $DEK"

# Wrap it
WRAPPED=$(curl -sS -X POST "$URL/wrap" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d "{\"plaintextDek\":\"$DEK\"}" | jq -r .wrappedDek)
echo "Wrapped: $WRAPPED"

# Unwrap and confirm we get the original back
UNWRAPPED=$(curl -sS -X POST "$URL/unwrap" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d "{\"wrappedDek\":\"$WRAPPED\"}" | jq -r .plaintextDek)
echo "Unwrapped: $UNWRAPPED"

# Must match
test "$DEK" = "$UNWRAPPED" && echo "OK" || echo "MISMATCH"
```

## What not to do

- Do not store the KEK in Hetzner env. That defeats the split-trust
  model — an attacker who dumps the VPS should still need a second
  compromise (Cloudflare) to unwrap any ciphertext.
- Do not bake the bearer token into the Worker source file. It stays as
  a secret binding and is rotated without redeploying Worker code.
- Do not increase the KEK size above 32 bytes. AES-KW requires 128/192/256
  bit keys, and the rest of the pipeline assumes 256-bit (AES-256-GCM for
  the DEK, AES-256 KW for wrapping).
