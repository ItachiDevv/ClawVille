/**
 * One-time backfill: generate a custodial Solana wallet for every avatar AND
 * every openclaw_bot that doesn't have one yet. Safe to run multiple
 * times — ensureWallet() is idempotent on (subject_type, subject_id).
 *
 * Usage:
 *   bun run scripts/backfill-wallets.ts                 # dry run, shows counts
 *   bun run scripts/backfill-wallets.ts --apply         # generate for both subjects
 *   bun run scripts/backfill-wallets.ts --apply --only=avatar    # avatars only
 *   bun run scripts/backfill-wallets.ts --apply --only=agent  # agents only
 *
 * ⚠️  Requires VANITY_ENCRYPTION_KEY in .env.local (same hex key used for
 *     treasury_wallets + vanity_keypairs).
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, avatars, agentBots } from '@clawville/database';
import { isNull } from 'drizzle-orm';
import { ensureWallet } from '../apps/api/src/services/wallet-service';

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  const doPets = !onlyArg || onlyArg === 'avatar';
  const doAgents = !onlyArg || onlyArg === 'agent';

  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[backfill] VANITY_ENCRYPTION_KEY not set — aborting.');
    process.exit(1);
  }

  console.log(`[backfill] mode=${apply ? 'APPLY' : 'DRY-RUN'}  avatars=${doPets}  agents=${doAgents}`);
  console.log('');

  let petTargets: Array<{ id: string; name: string }> = [];
  let agentTargets: Array<{ id: string; agentId: string; name: string | null }> = [];

  if (doPets) {
    petTargets = await db
      .select({ id: avatars.id, name: avatars.name })
      .from(avatars)
      .where(isNull(avatars.walletAddress));
    console.log(`[backfill] Avatars without a wallet: ${petTargets.length}`);
  }

  if (doAgents) {
    agentTargets = await db
      .select({ id: agentBots.id, agentId: agentBots.agentId, name: agentBots.name })
      .from(agentBots)
      .where(isNull(agentBots.walletAddress));
    console.log(`[backfill] Agents without a wallet: ${agentTargets.length}`);
  }

  console.log('');

  if (!apply) {
    console.log('[backfill] Dry run — pass --apply to generate.');
    if (petTargets.length > 0) {
      console.log('  First 5 avatars:');
      for (const p of petTargets.slice(0, 5)) {
        console.log(`    ${p.id}  ${p.name}`);
      }
    }
    if (agentTargets.length > 0) {
      console.log('  First 5 agents:');
      for (const a of agentTargets.slice(0, 5)) {
        console.log(`    ${a.id}  ${a.agentId}  (${a.name ?? '—'})`);
      }
    }
    process.exit(0);
  }

  let generated = 0;
  let alreadyHad = 0;
  let failed = 0;

  for (const p of petTargets) {
    try {
      const result = await ensureWallet('avatar', p.id);
      if (result.alreadyExisted) alreadyHad += 1;
      else {
        generated += 1;
        console.log(`  ✓ avatar   ${p.id}  ${p.name}  → ${result.publicKey}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ avatar   ${p.id}  ${p.name}:`, err instanceof Error ? err.message : err);
    }
  }

  for (const a of agentTargets) {
    try {
      const result = await ensureWallet('agent', a.id);
      if (result.alreadyExisted) alreadyHad += 1;
      else {
        generated += 1;
        console.log(`  ✓ agent ${a.id}  ${a.agentId}  → ${result.publicKey}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ agent ${a.id}  ${a.agentId}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('');
  console.log(`[backfill] Done. generated=${generated} already=${alreadyHad} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
