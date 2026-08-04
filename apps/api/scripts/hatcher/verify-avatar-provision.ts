/**
 * FOCUSED verification for the Hatcher avatar auto-provision (Rule E5).
 *
 * Proves, with NO write to (and NO connection to) the shared prod DB, that:
 *   V1. register-with-identityKey shape: buildHatcherAvatarValues binds the
 *       avatar to the user and carries the human/parity shape (agentCategory
 *       'hatcher', harness 'custom', modelKey = the assigned hatcher_N, neutral
 *       species/color/gender enums).
 *   V2. NO FAUCET: the built INSERT values NEVER set `clawTokens` (the 100-CT
 *       starting balance comes from the schema default `avatars.clawTokens=100`,
 *       identical to the human POST /api/avatars + agent POST /api/agent/join
 *       paths) NOR `isActive` (schema default true) — and 100 >= the Cove min
 *       bet, so the avatar is immediately playable.
 *   V3. invalid/absent modelKey => falls back to a valid Hatcher-category model.
 *   V4. IDEMPOTENCY: ensureHatcherAvatar reuses an existing active avatar
 *       (created:false) — the guard that makes the one-time grant fire once, so a
 *       re-register cannot mint a 2nd avatar nor re-grant CT.
 *   V5. MONEY PATH: public Hatcher records advertise only a resolver-ready
 *       avatar settlement wallet and fail closed with walletPending otherwise.
 *
 * V1-V3 call the EXPORTED PURE `buildHatcherAvatarValues` (no I/O). V4 drives the
 * real `ensureHatcherAvatar` with only `db.query.avatars.findFirst` stubbed (the
 * reassignable nested-method seam the e2e harness uses) returning an existing row
 * so the reuse branch returns BEFORE any insert — no DB connection, no write.
 *
 * Run: bun run scripts/hatcher/verify-avatar-provision.ts
 * Exit: 0 on all-pass, 1 on any fail.
 */

// Crash-loud env (same dummies as the e2e harness — never connects).
function ensureEnv(k: string, v: string) { if (!process.env[k]) process.env[k] = v; }
const HEX32 = '0'.repeat(64);
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
ensureEnv('PARTNER_PUBKEYS', JSON.stringify({ hatcher: 'x'.repeat(32) }));
ensureEnv('CLAWVILLE_SERVICE_ISSUER_SK', HEX32);
ensureEnv('CLAWVILLE_SERVICE_ISSUER_PUBKEY', HEX32);

const fails: string[] = [];
function check(name: string, cond: boolean, evidence: string) {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}\n        ${evidence}`);
  if (!cond) fails.push(name);
}

async function main() {
  console.log('=== Hatcher avatar auto-provision focused verification (NO DB connect/write) ===\n');

  const shared = await import('@clawville/shared');
  const { COVE_BLACKJACK_MIN_BET, getAgentModel } = shared;
  const ph = await import('../../src/routes/partner-hatcher.ts');
  const { buildHatcherAvatarValues, ensureHatcherAvatar, publicAgentRecord } = ph as unknown as {
    buildHatcherAvatarValues: (
      userId: string, modelKey: string | null | undefined, name: string | null | undefined,
    ) => Record<string, unknown>;
    ensureHatcherAvatar: (
      userId: string, modelKey: string | null | undefined, name: string | null | undefined,
    ) => Promise<{ avatarId: string; created: boolean }>;
    publicAgentRecord: (
      row: Record<string, unknown>,
      settlement: { status: 'ready'; address: string } | { status: 'pending' },
    ) => Record<string, unknown>;
  };

  const SELFTEST_USER = '00000000-0000-4000-8000-0000000ava01';

  // ── V1: identity-bound parity shape ────────────────────────────────────────
  const v = buildHatcherAvatarValues(SELFTEST_USER, 'hatcher_3', 'Nori-Helper');
  const boundToUser = v.userId === SELFTEST_USER;
  const categoryOk = v.agentCategory === 'hatcher';
  const harnessOk = v.harness === 'custom';
  const modelOk = v.modelKey === 'hatcher_3';
  const enumsOk = v.species === 'turtle' && v.color === 'blue' && v.gender === 'male';
  const nameBound = typeof v.name === 'string' && (v.name as string).startsWith('Nori-Helper ');
  check('V1 buildHatcherAvatarValues binds userId + parity shape (agentCategory=hatcher, harness=custom, modelKey=hatcher_3, neutral enums)',
    boundToUser && categoryOk && harnessOk && modelOk && enumsOk && nameBound,
    `userId=${v.userId} agentCategory=${v.agentCategory} harness=${v.harness} modelKey=${v.modelKey} species=${v.species}/${v.color}/${v.gender} name=${v.name}`);

  // ── V2: NO FAUCET — clawTokens + isActive omitted (schema defaults apply) ───
  const clawTokensOmitted = !('clawTokens' in v);
  const isActiveOmitted = !('isActive' in v);
  const SCHEMA_DEFAULT_CT = 100; // packages/database/src/schema/avatars.ts:119
  const playable = SCHEMA_DEFAULT_CT >= COVE_BLACKJACK_MIN_BET;
  check('V2 NO FAUCET — INSERT omits clawTokens AND isActive (schema defaults 100/true == human+join path) AND 100 >= Cove min bet',
    clawTokensOmitted && isActiveOmitted && playable,
    `clawTokens key present=${'clawTokens' in v} (expect false) isActive key present=${'isActive' in v} (expect false) schemaDefaultCT=${SCHEMA_DEFAULT_CT} COVE_BLACKJACK_MIN_BET=${COVE_BLACKJACK_MIN_BET} playable=${playable}`);

  // ── V3: invalid modelKey => valid random hatcher_N fallback ────────────────
  const vFallback = buildHatcherAvatarValues(SELFTEST_USER, 'not-a-real-model', null);
  const mk = vFallback.modelKey as string;
  const fellBack = typeof mk === 'string' && getAgentModel(mk)?.category === 'hatcher';
  const defaultNameUsed = typeof vFallback.name === 'string' && (vFallback.name as string).startsWith('Hatcher Agent ');
  check('V3 invalid modelKey => valid Hatcher-category model + default name',
    fellBack && defaultNameUsed,
    `modelKey=${mk} category=${getAgentModel(mk)?.category} name=${vFallback.name}`);

  // ── V4: IDEMPOTENCY — existing active avatar reused, no insert path reached ─
  // Stub ONLY db.query.avatars.findFirst (the reassignable nested-method seam).
  const dbMod = await import('@clawville/database');
  const stub = dbMod.db as unknown as {
    query: { avatars: { findFirst: (a?: unknown) => Promise<unknown> } };
  };
  let findFirstCalls = 0;
  stub.query.avatars.findFirst = async () => {
    findFirstCalls += 1;
    return { id: 'pre-existing-avatar-id-999' };
  };
  const reuse = await ensureHatcherAvatar(SELFTEST_USER, 'hatcher_3', 'Nori-Helper');
  // created:false + the pre-existing id returned => the reuse branch ran and
  // returned BEFORE any db.insert (so no write/connection occurred).
  check('V4 IDEMPOTENT — existing active avatar reused (created:false, no insert reached => no 2nd avatar, no CT re-grant)',
    reuse.created === false && reuse.avatarId === 'pre-existing-avatar-id-999' && findFirstCalls === 1,
    `created=${reuse.created} avatarId=${reuse.avatarId} findFirstCalls=${findFirstCalls} (expect created:false, pre-existing id, exactly 1 findFirst, NO insert)`);

  // ── V5: verified settlement advertisement + fail-closed pending shape ──────
  const publicRow = {
    agentId: 'hatcher:wallet-verification',
    id: 'wallet-verification-row',
    identityType: 'hatcher',
    mode: 'avatar',
    targetNpcId: null,
    name: 'Wallet Verification',
    species: 'phanes',
    color: null,
    cognitionBackend: 'hatcher-proxy',
    proxyUrl: 'https://api.hatcher.host',
    ack: null,
    userId: SELFTEST_USER,
    sessionExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
  };
  const readyRecord = publicAgentRecord(publicRow, {
    status: 'ready',
    address: 'verified-avatar-settlement-wallet',
  });
  const pendingRecord = publicAgentRecord(publicRow, { status: 'pending' });
  check('V5 MONEY PATH: Hatcher advertises only resolver-ready settlement wallet and pending omits the address',
    readyRecord.walletAddress === 'verified-avatar-settlement-wallet'
      && readyRecord.walletPending === false
      && !('walletAddress' in pendingRecord)
      && pendingRecord.walletPending === true,
    `readyAddress=${readyRecord.walletAddress} readyPending=${readyRecord.walletPending} pendingHasAddress=${'walletAddress' in pendingRecord} pendingFlag=${pendingRecord.walletPending}`);

  console.log('\n========================================================');
  console.log(`SUMMARY: ${fails.length === 0 ? 'ALL PASS (5/5)' : `${fails.length} FAIL`}`);
  if (fails.length) for (const f of fails) console.log(`  - FAIL: ${f}`);
  console.log('========================================================');
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => { console.error('VERIFY CRASHED:', err); process.exit(2); });
