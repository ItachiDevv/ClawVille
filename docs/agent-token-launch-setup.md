# Agent Token Launch — Setup Instructions

## 1. Generate Encryption Key

Generate a 32-byte hex key for encrypting vanity keypairs at rest:

```bash
openssl rand -hex 32
```

Add it to `.env.local`:

```
VANITY_ENCRYPTION_KEY=<64-char hex string from above>
```

## 2. Push Database Schema

The token launch feature adds two new tables:
- `vanity_keypairs` — encrypted pool of pre-generated CLAW/HRMS mint keypairs
- `token_launches` — tracks every agent token deployment

```bash
bun run db:push
```

## 3. Organize Vanity Keypair Files

Place your Solana keypair JSON files in two directories:

```
vanity-keys/
  CLAW/
    key1.json    # [12, 45, 200, ... 64 numbers]
    key2.json
    ...          # 250 files
  HRMS/
    key1.json
    key2.json
    ...          # 250 files
```

Each `.json` file should contain a JSON array of 64 bytes (standard `solana-keygen` output format).

## 4. Import Vanity Keypairs

```bash
# Import all CLAW-suffixed keypairs
bun run scripts/import-vanity-keypairs.ts --dir ./vanity-keys/CLAW --suffix CLAW

# Import all HRMS-suffixed keypairs
bun run scripts/import-vanity-keypairs.ts --dir ./vanity-keys/HRMS --suffix HRMS

# Or import a single file
bun run scripts/import-vanity-keypairs.ts --file ./my-key.json --suffix CLAW
```

The script will:
- Validate each keypair's public key ends with the correct suffix
- Encrypt the secret key with AES-256-GCM
- Insert into the `vanity_keypairs` table with status `available`
- Skip duplicates (already imported keys)

## 5. Verify Import

Check the pool stats via Drizzle Studio:

```bash
bun run db:studio
```

Or query directly:

```sql
SELECT suffix, status, count(*) FROM vanity_keypairs GROUP BY suffix, status;
```

Expected output:
```
CLAW | available | 250
HRMS | available | 250
```

## 6. Required Environment Variables

| Variable | Description |
|----------|-------------|
| `VANITY_ENCRYPTION_KEY` | 64-char hex string (32 bytes) for AES-256-GCM encryption |
| `DATABASE_URL` | PostgreSQL connection string |
| `SOLANA_RPC_URL` | Solana RPC endpoint (mainnet or devnet) |

## Architecture Overview

```
User/Agent requests token launch
  → API reserves a vanity keypair (CLAW or HRMS suffix)
  → API builds the create transaction (pump.fun or Raydium)
  → API partial-signs with the vanity mint keypair (server-side)
  → Dev wallet signs:
      • "user" mode   → serialized tx sent to browser, Phantom signs
      • "agent" mode   → agent's own wallet keypair signs server-side
      • "generated"    → fresh keypair created + signs server-side
  → Broadcast to Solana
  → Token lives at the vanity address (e.g. ...CLAW or ...HRMS)
```

## Files

| File | Purpose |
|------|---------|
| `packages/database/src/schema/token-launch.ts` | DB schema (vanity_keypairs + token_launches) |
| `apps/api/src/services/keypair-vault.ts` | Encryption, import, reserve, load, release |
| `scripts/import-vanity-keypairs.ts` | Bulk import CLI |
| `apps/web/src/app/page.tsx` | Landing page launch section |
