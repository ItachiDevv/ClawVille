/**
 * One-shot helper to credit a pet with ClawTokens for testing.
 * Mirrors the in-app `creditClawTokens` flow: row-locks the pet, increments
 * claw_tokens, inserts a signed claw_token_transactions row so the audit
 * trail stays consistent with normal earn paths.
 *
 * Run: bun packages/database/scripts/grant-test-tokens.ts <petId> <amount>
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

const petId = process.argv[2] ?? '15f93f4e-15b7-414b-bb67-a7c5b4c459f8';
const amount = parseInt(process.argv[3] ?? '5000', 10);

if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`Bad amount: ${amount}`);
  process.exit(1);
}

const client = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  await client.begin(async (sql) => {
    const [pet] = await sql<[{ user_id: string; claw_tokens: number; name: string }]>`
      SELECT user_id, claw_tokens, name
      FROM pets
      WHERE id = ${petId}
      FOR UPDATE
    `;
    if (!pet) {
      throw new Error(`pet ${petId} not found`);
    }
    const balanceAfter = pet.claw_tokens + amount;
    await sql`UPDATE pets SET claw_tokens = ${balanceAfter} WHERE id = ${petId}`;
    await sql`
      INSERT INTO claw_token_transactions
        (pet_id, user_id, amount, balance_after, reason, source, metadata)
      VALUES
        (${petId}, ${pet.user_id}, ${amount}, ${balanceAfter},
         'admin_test_grant', 'admin', ${{ note: 'cosmetic verification' }}::jsonb)
    `;
    console.log(`✓ ${pet.name} (${petId.slice(0, 8)}…)  ${pet.claw_tokens} → ${balanceAfter} CT (+${amount})`);
  });
} catch (err) {
  console.error('FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
