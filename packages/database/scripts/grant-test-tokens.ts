/**
 * One-shot STAGING-only helper to credit an avatar with SOFT vCLAW for testing.
 * The mutation goes through the production `creditClawTokens` ledger chokepoint,
 * so the balance, provenance ledger, and covenant action record commit atomically.
 *
 * Run (staging only):
 *   CLAWVILLE_ENV=staging \
 *   TEST_GRANT_DB_URL="<staging database url>" \
 *   bun packages/database/scripts/grant-test-tokens.ts \
 *     --i-understand-this-is-a-test-db <avatarId> <amount>
 */

const ACKNOWLEDGEMENT = '--i-understand-this-is-a-test-db';
const STAGING_PROJECT_REF = 'mtpixvtclsjqjguouxes';
const PROD_PROJECT_REF = 'wheuidgiyyccqyoppxoa';

/** Pure guard exported for security regression tests. */
export function isDedicatedStagingDatabaseUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;

  const username = decodeURIComponent(parsed.username);
  const directIdentity =
    parsed.hostname === `db.${STAGING_PROJECT_REF}.supabase.co`
    && username === 'postgres';
  const poolerIdentity =
    parsed.hostname.endsWith('.pooler.supabase.com')
    && username === `postgres.${STAGING_PROJECT_REF}`;

  // The explicit prod check is defense-in-depth and makes the refusal invariant
  // obvious if a future identity form is added without exact matching.
  const isKnownProd =
    parsed.hostname === `db.${PROD_PROJECT_REF}.supabase.co`
    || username === `postgres.${PROD_PROJECT_REF}`;
  return !isKnownProd && (directIdentity || poolerIdentity);
}

async function main(): Promise<void> {
  if (process.env.CLAWVILLE_ENV !== 'staging') {
    console.error('REFUSING: CLAWVILLE_ENV must be exactly "staging".');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (!args.includes(ACKNOWLEDGEMENT)) {
    console.error(`REFUSING: explicit ${ACKNOWLEDGEMENT} acknowledgement is required.`);
    process.exit(1);
  }

  const targetUrl = process.env.TEST_GRANT_DB_URL;
  if (!targetUrl) {
    console.error('REFUSING: TEST_GRANT_DB_URL is required; DATABASE_URL is never used as input.');
    process.exit(1);
  }

  if (!isDedicatedStagingDatabaseUrl(targetUrl)) {
    console.error('REFUSING: TEST_GRANT_DB_URL is not the dedicated staging database.');
    process.exit(1);
  }

  const positional = args.filter((arg) => arg !== ACKNOWLEDGEMENT);
  const avatarId = positional[0];
  if (!avatarId) {
    console.error('REFUSING: an explicit avatarId is required; there is no default recipient.');
    process.exit(1);
  }

  const amount = Number(positional[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    console.error('REFUSING: amount must be a positive safe integer.');
    process.exit(1);
  }

  // Install the already-validated explicit target before importing any app/database
  // module. The database proxy binds lazily to this value on the first ledger call.
  process.env.DATABASE_URL = targetUrl;

  try {
    const { creditClawTokens } = await import(
      '../../../apps/api/src/services/claw-token-ledger'
    );
    const result = await creditClawTokens({
      avatarId,
      amount,
      reason: 'admin_test_grant',
      source: 'admin',
      provenance: 'soft',
      actorKind: 'admin',
      metadata: { note: 'staging-only test grant' },
    });
    const balanceBefore = result.balanceAfter - amount;
    console.log(
      `Granted ${amount} SOFT vCLAW to avatar ${avatarId.slice(0, 8)}… ` +
        `(${balanceBefore} -> ${result.balanceAfter}); ledger=${result.ledgerId}`,
    );
    process.exit(0);
  } catch {
    // Database/client errors can embed connection details. Keep the failure
    // crash-loud without echoing the URL, credentials, or raw driver error.
    console.error('FAILED: staging ledger grant did not complete.');
    process.exit(1);
  }
}

if (import.meta.main) await main();
