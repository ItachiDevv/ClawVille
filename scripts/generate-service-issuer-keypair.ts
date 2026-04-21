/**
 * One-shot ed25519 keypair generator for the ClawVille service issuer.
 *
 * Usage:
 *   bun run scripts/generate-service-issuer-keypair.ts
 *
 * Prints a block you paste directly into Coolify (or .env.local):
 *
 *   CLAWVILLE_SERVICE_ISSUER_SK=<base58 64-byte tweetnacl sign secretKey>
 *   CLAWVILLE_SERVICE_ISSUER_PUBKEY=<base58 32-byte public key>
 *
 * Keep SK out of git, source control, and chat logs. It is the root of
 * trust for outbound partner signatures (scape hosted-session issuance,
 * future portal accepts). If it leaks, generate a fresh pair, rotate
 * the env var in Coolify, publish the new pubkey at
 * `/.well-known/clawville-issuer.json`, and notify every partner so
 * they can hot-reload their allowlist.
 *
 * Safety: this script only prints — it does NOT write to any file or
 * env store. Copy/paste is intentional to avoid silent leaks.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';

function main(): void {
  const kp = nacl.sign.keyPair();
  const skBase58 = bs58.encode(kp.secretKey);
  const pkBase58 = bs58.encode(kp.publicKey);

  const banner =
    '=== ClawVille service issuer keypair — Phase 5.1 ===';
  const trailer =
    '=== paste the two lines above into Coolify env vars (or .env.local) ===';

  process.stdout.write(`${banner}\n`);
  process.stdout.write(`CLAWVILLE_SERVICE_ISSUER_SK=${skBase58}\n`);
  process.stdout.write(`CLAWVILLE_SERVICE_ISSUER_PUBKEY=${pkBase58}\n`);
  process.stdout.write(`${trailer}\n`);
  process.stdout.write(
    '\nSK is the secret — do NOT commit, log, or paste into chat outside a secrets store.\n',
  );
  process.stdout.write(
    'PK is public and published at /.well-known/clawville-issuer.json.\n',
  );
}

main();
