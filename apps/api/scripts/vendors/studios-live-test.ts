#!/usr/bin/env bun
/**
 * ONE live Studios image call, paid from a staging test avatar wallet
 * (MCP hub step 2 phase 2a). Founder cap 2026-11-04: $1.00 total for these
 * tests. This script enforces that cap in code and makes exactly one call.
 *
 * Usage (inside the STAGING api container, from /app/apps/api):
 *   bun scripts/vendors/studios-live-test.ts --avatar <uuid> --confirm-spend [--seed-test-rules]
 *
 * --seed-test-rules writes the avatar's spend rules directly (daily $1.00,
 * per call $0.01, Studios allowed). That skips the linked-wallet signature on
 * purpose: it is a staging test fixture, recorded in deploy-status.md.
 *
 * Prints only ids, amounts, the transaction signature and the image link.
 * Never prints a key or vendor text.
 */

import postgres from 'postgres';
import { db, sql } from '@clawville/database';
import { callVendorWithAvatarWallet } from '../../src/services/outbound-x402';
import { writeSpendPolicy } from '../../src/services/spend-policy';
import {
  STUDIOS_MAX_CALL_ATOMIC,
  STUDIOS_PAY_TO,
  buildStudiosImageRequest,
  parseStudiosImage,
} from '../../src/services/vendors/studios';

const TEST_BUDGET_ATOMIC = 1_000_000n; // $1.00, founder cap
const PER_CALL_ATOMIC_LIMIT = 10_000n; // $0.01 for this test

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<number> {
  if (process.env.CLAWVILLE_ENV !== 'staging') {
    console.error('refused: this script runs on staging only');
    return 2;
  }
  const avatarId = arg('--avatar');
  if (!avatarId || !/^[0-9a-f-]{36}$/.test(avatarId)) {
    console.error('usage: --avatar <uuid> --confirm-spend [--seed-test-rules]');
    return 2;
  }
  if (!process.argv.includes('--confirm-spend')) {
    console.error('refused: pass --confirm-spend to spend real USDC');
    return 2;
  }

  const owner = Array.from(await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM avatars WHERE id = ${avatarId}`,
  ))[0];
  if (!owner) {
    console.error('refused: avatar not found');
    return 2;
  }

  // One dedicated connection holds a session advisory lock until the call ends.
  const lockConn = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    await lockConn`SELECT pg_advisory_lock(hashtextextended('studios-live-test-budget', 0))`;
    return await runLocked(avatarId, owner.user_id);
  } finally {
    await lockConn`SELECT pg_advisory_unlock(hashtextextended('studios-live-test-budget', 0))`.catch(() => {});
    await lockConn.end();
  }
}

async function runLocked(avatarId: string, ownerUserId: string): Promise<number> {
  // In-code budget: every live-test row of ANY avatar counts, failed rows
  // too (a failed row may still hide money that moved).
  const spent = BigInt(Array.from(await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(usdc_atomic), 0)::text AS total FROM vendor_spend_ledger
    WHERE vendor = 'studios' AND idempotency_key LIKE 'live-test-%'`))[0]?.total ?? '0');
  const worstCase = STUDIOS_MAX_CALL_ATOMIC < PER_CALL_ATOMIC_LIMIT ? STUDIOS_MAX_CALL_ATOMIC : PER_CALL_ATOMIC_LIMIT;
  if (spent + worstCase > TEST_BUDGET_ATOMIC) {
    console.error(`refused: test budget used (${spent} of ${TEST_BUDGET_ATOMIC} atomic)`);
    return 3;
  }

  if (process.argv.includes('--seed-test-rules')) {
    await writeSpendPolicy(avatarId, ownerUserId, {
      dailyCapUsdCents: 100,
      perCallCapUsdCents: Number(PER_CALL_ATOMIC_LIMIT / 10_000n),
      allowedVendors: ['studios'],
    });
    console.log('seeded test spend rules: daily 100 cents, per call 1 cent, studios');
  }

  const seeded = process.argv.includes('--seed-test-rules');
  try {
    return await callOnce(avatarId);
  } finally {
    if (seeded) {
      // Leave no spending rule behind: an agent bound to this avatar must not
      // keep spending after the test.
      await writeSpendPolicy(avatarId, ownerUserId, { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] });
      console.log('reset test spend rules to unset');
    }
  }
}

async function callOnce(avatarId: string): Promise<number> {
  const request = buildStudiosImageRequest({ prompt: 'A small green cartoon crab waving, flat colors, white background' });
  const result = await callVendorWithAvatarWallet({
    avatarId,
    actor: 'human',
    pin: { vendor: 'studios', payTo: STUDIOS_PAY_TO, maxCallAtomic: PER_CALL_ATOMIC_LIMIT },
    tool: 'images.generations',
    idempotencyKey: `live-test-${Date.now()}`,
    url: request.url,
    body: request.body,
  });

  if (!result.ok) {
    console.log(JSON.stringify({ ok: false, code: result.code, ledgerId: result.ledgerId ?? null, httpStatus: result.httpStatus ?? null }));
    return 1;
  }
  const image = parseStudiosImage(result.responseJson);
  console.log(JSON.stringify({
    ok: true,
    ledgerId: result.ledgerId,
    paidUsdcAtomic: result.usdcAtomic,
    txSignature: result.txSignature,
    imageUrl: image?.imageUrl ?? null,
    imageBase64Chars: image?.imageBase64?.length ?? 0,
  }));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('live test crashed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
