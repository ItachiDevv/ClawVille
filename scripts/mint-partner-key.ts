/**
 * Mint a partner API key (Hatcher partner #2, Phase C — 2026-06-01).
 *
 * Generates an `hk_`-style bearer token, prints it to stdout EXACTLY ONCE, and
 * persists ONLY its sha256 hash + a non-secret display prefix into
 * `partner_api_keys`. The plaintext token is never stored and can never be
 * recovered — mirrors the Phase 5.1 wallet `secretKey`-returned-exactly-once
 * invariant. A lost key is re-minted; the old row is revoked
 * (`UPDATE partner_api_keys SET revoked_at = now() WHERE id = '<id>'`).
 *
 * Usage:
 *   bun run scripts/mint-partner-key.ts \
 *     --partner=hatcher \
 *     --scopes=skills:read,manifest:read,stats:read \
 *     --label="Hatcher prod read key"
 *
 * Flags:
 *   --partner   (required) partner id — must match a PARTNER_PUBKEYS key.
 *   --scopes    (required) comma-separated scope list.
 *   --label     (optional) human label for the admin list.
 *   --prefix    (optional) token prefix, default `hk_` (kept ≤ 8 chars).
 *
 * The hashing + token-shape MUST stay byte-identical to the request-time
 * validator in `apps/api/src/middleware/partner-key.ts`
 * (`sha256(rawToken)` lowercase hex). Both call the same shape — if you change
 * one, change both.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { randomBytes, createHash } from 'crypto';
import { db, partnerApiKeys } from '@clawville/database';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** sha256 → 64-char lowercase hex. Identical to the middleware validator. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function main() {
  const partnerId = flag('partner')?.trim();
  const scopesRaw = flag('scopes')?.trim();
  const label = flag('label')?.trim() || null;
  const prefixFlag = (flag('prefix')?.trim() || 'hk_').slice(0, 8);

  if (!partnerId) {
    console.error('ERROR: --partner=<id> is required (e.g. --partner=hatcher)');
    process.exit(1);
  }
  if (!scopesRaw) {
    console.error(
      'ERROR: --scopes=<a,b,c> is required (e.g. --scopes=skills:read,manifest:read,stats:read)',
    );
    process.exit(1);
  }
  const scopes = scopesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    console.error('ERROR: --scopes resolved to an empty list');
    process.exit(1);
  }

  // Token = prefix + 32 random bytes (base64url, no padding). High entropy, URL-
  // safe, opaque. The prefix is purely cosmetic ("which key is this").
  const secret = randomBytes(32).toString('base64url');
  const token = `${prefixFlag}${secret}`;
  const keyHash = hashToken(token);
  // Display prefix: the literal prefix flag + only the first 4 chars of the
  // secret so an admin can correlate the printed token with the stored row.
  // Deliberately minimal (~24 bits) — a display column should not bank secret
  // material; the full token is shown ONCE on stdout and never persisted.
  const keyPrefix = `${prefixFlag}${secret.slice(0, 4)}`;

  let row: typeof partnerApiKeys.$inferSelect;
  try {
    const [inserted] = await db
      .insert(partnerApiKeys)
      .values({
        partnerId,
        keyHash,
        keyPrefix,
        scopes,
        label,
      })
      .returning();
    row = inserted;
  } catch (err) {
    console.error('ERROR: failed to insert partner_api_keys row:', err);
    process.exit(1);
  }

  // SHOW ONCE. Print the raw token here and NOWHERE else — it is not stored.
  console.log('');
  console.log('=== Partner API key minted — COPY THE TOKEN NOW (shown once) ===');
  console.log('');
  console.log(`  partner:  ${row.partnerId}`);
  console.log(`  scopes:   ${row.scopes.join(', ')}`);
  console.log(`  label:    ${row.label ?? '(none)'}`);
  console.log(`  row id:   ${row.id}`);
  console.log(`  prefix:   ${row.keyPrefix}`);
  console.log('');
  console.log(`  TOKEN:    ${token}`);
  console.log('');
  console.log('  Send this to the partner over a secure channel. It is NOT stored');
  console.log('  in plaintext and CANNOT be recovered. To revoke later:');
  console.log(`    UPDATE partner_api_keys SET revoked_at = now() WHERE id = '${row.id}';`);
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
