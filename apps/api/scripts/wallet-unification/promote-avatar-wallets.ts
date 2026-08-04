#!/usr/bin/env bun
/**
 * Controlled avatar settlement wallet promotion.
 *
 * This is an app-host Bun script, not a CI migration. It traverses avatars
 * canonical-first, applies the frozen five-way matrix, and never reads or
 * writes openclaw_bots.wallet_address.
 *
 * Manual sweep evidence carried into this runbook:
 * 205 retained agent wallets were measured fundless except for 3 funded
 * wallets; $27.33 was recovered to treasury. Every environment must still be
 * remeasured independently before apply.
 *
 * Usage:
 *   bun apps/api/scripts/wallet-unification/promote-avatar-wallets.ts --env=staging
 *   bun apps/api/scripts/wallet-unification/promote-avatar-wallets.ts --env=staging --apply
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dir, '../../../../.env.local') });

import { avatars, db, eq, sql, wallets } from '@clawville/database';
import {
  inspectAvatarWalletProvision,
  provisionAvatarWallet,
} from '../../src/services/wallet-service';
import type { AvatarWalletMatrixBranch } from '../../src/services/avatar-wallet-reconciliation';

interface BackfillCounts {
  avatars: number;
  canonicalAvatarWallets: number;
  custodyVerified: number;
  retainedAgentWallets: number;
}

async function measure(): Promise<BackfillCounts> {
  const [avatarCount] = await db.select({ n: sql<number>`count(*)` }).from(avatars);
  const [canonicalCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(wallets)
    .where(eq(wallets.subjectType, 'avatar'));
  const [verifiedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(wallets)
    .where(
      sql`${wallets.subjectType} = 'avatar' AND ${wallets.custodyVerified} = true`,
    );
  const [retainedAgentCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(wallets)
    .where(eq(wallets.subjectType, 'agent'));
  return {
    avatars: Number(avatarCount?.n ?? 0),
    canonicalAvatarWallets: Number(canonicalCount?.n ?? 0),
    custodyVerified: Number(verifiedCount?.n ?? 0),
    retainedAgentWallets: Number(retainedAgentCount?.n ?? 0),
  };
}

function increment(
  counts: Map<AvatarWalletMatrixBranch, number>,
  branch: AvatarWalletMatrixBranch,
): void {
  counts.set(branch, (counts.get(branch) ?? 0) + 1);
}

export async function runWalletUnificationBackfill(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const environment =
    args.find((arg) => arg.startsWith('--env='))?.slice('--env='.length).trim()
    || process.env.APP_ENV?.trim()
    || process.env.NODE_ENV?.trim()
    || 'unknown';

  if (args.some((arg) => arg.startsWith('--only=agent'))) {
    throw new Error('Agent wallet mode is disabled');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  console.log(`[wallet-unification] environment=${environment} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log('[wallet-unification] manual sweep: 205 agent wallets, 3 funded, $27.33 recovered to treasury');
  console.log('[wallet-unification] remeasure retained agent-wallet funds separately for this environment before apply');

  const before = await measure();
  console.log(`[wallet-unification] before=${JSON.stringify(before)}`);

  const avatarRows = await db
    .select({ id: avatars.id, name: avatars.name })
    .from(avatars)
    .orderBy(avatars.id);

  const branches = new Map<AvatarWalletMatrixBranch, number>();
  let failed = 0;
  for (const avatar of avatarRows) {
    try {
      const result = apply
        ? await provisionAvatarWallet(avatar.id, { disclose: false })
        : await inspectAvatarWalletProvision(avatar.id);
      increment(branches, result.branch);
      if (
        result.branch === 'canonical-valid-mirror-mismatch'
        || result.branch === 'canonical-absent-mirror-present'
        || result.branch === 'canonical-invalid'
      ) {
        console.error(
          `[wallet-unification] exception avatar=${avatar.id} name=${avatar.name} branch=${result.branch}`,
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[wallet-unification] failed avatar=${avatar.id} name=${avatar.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const branchCounts = Object.fromEntries([...branches.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const branch3And5 =
    (branches.get('canonical-valid-mirror-mismatch') ?? 0)
    + (branches.get('canonical-absent-mirror-present') ?? 0);
  console.log(`[wallet-unification] branches=${JSON.stringify(branchCounts)}`);
  console.log(`[wallet-unification] branch_3_5_exceptions=${branch3And5}`);

  const after = await measure();
  console.log(`[wallet-unification] after=${JSON.stringify(after)}`);
  console.log(`[wallet-unification] failed=${failed}`);

  if (failed > 0 || (apply && after.custodyVerified + branch3And5 < after.avatars)) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runWalletUnificationBackfill(process.argv.slice(2));
}
