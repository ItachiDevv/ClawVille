/**
 * One-shot helper to credit a avatar with ClawTokens for testing.
 * Mirrors the in-app `creditClawTokens` flow: row-locks the avatar, increments
 * claw_tokens, inserts a signed claw_token_transactions row so the audit
 * trail stays consistent with normal earn paths.
 *
 * Run: bun packages/database/scripts/grant-test-tokens.ts <avatarId> <amount>
 *
 * Defaults to Hermes ca7fe6 (15f93f4e-15b7-414b-bb67-a7c5b4c459f8) +5000 CT.
 */

import postgres from 'postgres';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const avatarId = process.argv[2] ?? '15f93f4e-15b7-414b-bb67-a7c5b4c459f8';
const amount = parseInt(process.argv[3] ?? '5000', 10);

if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`Bad amount: ${amount}`);
  process.exit(1);
}

// prepare:false — this runs a multi-statement client.begin() (CT ledger write) over the Supabase
// transaction pooler (:6543), which silently drops such transactions without it. See packages/database/src/index.ts.
const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  await client.begin(async (sql) => {
    const [avatar] = await sql<[{ user_id: string; claw_tokens: number; name: string }]>`
      SELECT user_id, claw_tokens, name
      FROM avatars
      WHERE id = ${avatarId}
      FOR UPDATE
    `;
    if (!avatar) {
      throw new Error(`avatar ${avatarId} not found`);
    }
    const balanceAfter = avatar.claw_tokens + amount;
    // F1 vCLAW provenance: the granted amount is non-cashable SOFT — add it to
    // soft_balance so the avatars_vclaw_balance_sum CHECK holds
    // (claw_tokens = soft+bought+earned); existing bought/earned are preserved.
    await sql`UPDATE avatars SET claw_tokens = ${balanceAfter}, soft_balance = soft_balance + ${amount} WHERE id = ${avatarId}`;
    await sql`
      INSERT INTO claw_token_transactions
        (avatar_id, user_id, amount, balance_after, reason, source, provenance, metadata)
      VALUES
        (${avatarId}, ${avatar.user_id}, ${amount}, ${balanceAfter},
         'admin_test_grant', 'admin', 'soft', ${{ note: 'cosmetic verification' }}::jsonb)
    `;
    console.log(`✓ ${avatar.name} (${avatarId.slice(0, 8)}…)  ${avatar.claw_tokens} → ${balanceAfter} CT (+${amount})`);
  });
} catch (err) {
  console.error('FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
