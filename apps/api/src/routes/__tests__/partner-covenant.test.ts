/**
 * Covenant partner READ-surface AUTH-GATE tests (no DB, no network).
 *
 * The 503 (unconfigured) / 403 (wrong IP) / 401 (bad signature) decisions all
 * short-circuit in `requireCovenantPartner` BEFORE any handler / DB call, so we
 * exercise the gate against a tiny dummy Hono app + a real ed25519 keypair —
 * matching the local "primitive test, no DB harness" convention
 * (partner-hatcher-p5.test.ts). This proves:
 *   - unconfigured env → 503 partner_not_configured
 *   - configured + missing signature → 401
 *   - configured + wrong IP → 403
 *   - configured + valid signature from an allowed IP → passes to the handler
 *   - getClientIp prefers cf-connecting-ip (the CF-authoritative header)
 *   - COVENANT_ALLOWED_IPS parsing (whitespace tolerance)
 *
 * DB-dependent response-shape tests are intentionally omitted (the local
 * convention keeps DB-mocking to a separate file — partner-hatcher-p5-handler —
 * and this gate is the security boundary worth locking).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  requireCovenantPartner,
  parseCovenantAllowedIps,
  isCovenantIpAllowed,
  covenantConfigStatus,
  isCovenantConfigured,
  COVENANT_PARTNER_ID,
  COVENANT_PUBKEY_HEADER,
  COVENANT_SIGNATURE_HEADER,
  COVENANT_TIMESTAMP_HEADER,
} from '../../middleware/require-covenant-partner';
import { getClientIp } from '../../middleware/rate-limit';

const ALLOWED_IP = '62.242.144.246';

// A stable test ed25519 keypair (NOT any real partner key). We register its
// public key as PARTNER_PUBKEYS.covenant and sign the canonical GET challenge.
const kp = nacl.sign.keyPair();
const TEST_PUBKEY_B58 = bs58.encode(kp.publicKey);

/** Build a tiny app fronted by the covenant gate + a 200 probe. */
function makeApp() {
  const app = new Hono();
  app.use('*', requireCovenantPartner);
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}

/** Sign the canonical GET challenge the middleware verifies. */
function signGet(method: string, path: string, tsMs: string) {
  const challenge = `clawville-partner-get\n${method.toUpperCase()}\n${path}\n${tsMs}`;
  const digest = createHash('sha256').update(challenge).digest();
  const sig = nacl.sign.detached(new Uint8Array(digest), kp.secretKey);
  return bs58.encode(sig);
}

// Isolate env per test — the gate reads PARTNER_PUBKEYS + COVENANT_ALLOWED_IPS
// at call time.
let savedPubkeys: string | undefined;
let savedIps: string | undefined;
beforeEach(() => {
  savedPubkeys = process.env.PARTNER_PUBKEYS;
  savedIps = process.env.COVENANT_ALLOWED_IPS;
});
afterEach(() => {
  if (savedPubkeys === undefined) delete process.env.PARTNER_PUBKEYS;
  else process.env.PARTNER_PUBKEYS = savedPubkeys;
  if (savedIps === undefined) delete process.env.COVENANT_ALLOWED_IPS;
  else process.env.COVENANT_ALLOWED_IPS = savedIps;
});

function configureCovenant() {
  process.env.PARTNER_PUBKEYS = JSON.stringify({ covenant: TEST_PUBKEY_B58 });
  process.env.COVENANT_ALLOWED_IPS = ALLOWED_IP;
}

// ---------------------------------------------------------------------------
// Handler response-SHAPE mock (mocked @clawville/database, real everything else).
//
// Locks the EXACT top-level (and key nested) response keys of the 3 routes so a
// future `...spread` or an added/removed column fails the test. Mirrors the
// partner-hatcher-p5-handler db-mock style: spread the REAL db module (so every
// table export the route imports resolves) and override ONLY `db` with an
// in-memory stub. Because `mock.module('@clawville/database')` is process-global,
// this file — like partner-hatcher-p5-handler — is meant to run ISOLATED
// (single-file / the `test:isolated` CI runner); the real-module auth-gate tests
// ABOVE never import `@clawville/database`, so the mock does not affect them.
// ---------------------------------------------------------------------------

// A valid 32-byte base58 pubkey so deriveSapAgentPda produces a real PDA.
const HUNTER_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
const AGENT_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
const TEST_UUID = '11111111-1111-4111-8111-111111111111';

// Canned data + a FIFO queue the select-builder shifts from (the routes call
// db.select in a deterministic order per request).
const cov: {
  bountyFindFirst: Record<string, unknown> | null;
  avatarFindFirst: Record<string, unknown> | null;
  repFindFirst: Record<string, unknown> | null;
  userFindFirst: Record<string, unknown> | null;
  selectQueue: unknown[];
} = {
  bountyFindFirst: null,
  avatarFindFirst: null,
  repFindFirst: null,
  userFindFirst: null,
  selectQueue: [],
};

// Chainable, awaitable select stub — every builder method returns `this`; the
// terminal `await` resolves to the next queued result (thenable).
function covSelectBuilder() {
  const result = cov.selectQueue.shift() ?? [];
  const b: Record<string, unknown> = {
    from: () => b,
    innerJoin: () => b,
    where: () => b,
    orderBy: () => b,
    limit: () => b,
    offset: () => b,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return b;
}

const covDbStub = {
  select: () => covSelectBuilder(),
  query: {
    bounties: { findFirst: async () => cov.bountyFindFirst },
    avatars: { findFirst: async () => cov.avatarFindFirst },
    bountyReputation: { findFirst: async () => cov.repFindFirst },
    users: { findFirst: async () => cov.userFindFirst },
  },
};

// Crash-loud module-load env requirements for the transitive graph the ROUTE
// pulls (the `@clawville/database` client etc.), matching the p5-handler harness.
// Only sets what is missing — bun auto-loads apps/api/.env.local, so on a normal
// dev box these are already present; this keeps the file hermetic if not.
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const HEX32 = '0'.repeat(64);
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

const realDbForCovenant = await import('@clawville/database');
mock.module('@clawville/database', () => ({
  ...realDbForCovenant,
  db: covDbStub,
}));

/** Signed GET headers for a covenant request to `path` from the allowed IP. */
function covenantHeaders(path: string): Record<string, string> {
  const tsMs = String(Date.now());
  return {
    'cf-connecting-ip': ALLOWED_IP,
    [COVENANT_PUBKEY_HEADER]: TEST_PUBKEY_B58,
    [COVENANT_SIGNATURE_HEADER]: signGet('GET', path, tsMs),
    [COVENANT_TIMESTAMP_HEADER]: tsMs,
  };
}

/** assert an object's keys are EXACTLY `keys` (order-insensitive). */
function expectExactKeys(obj: Record<string, unknown>, keys: string[]) {
  expect(Object.keys(obj).sort()).toEqual([...keys].sort());
}

describe('parseCovenantAllowedIps', () => {
  it('parses a comma list with surrounding + empty-segment whitespace', () => {
    expect(parseCovenantAllowedIps(' 1.2.3.4 , 5.6.7.8 ,, 9.9.9.9 ')).toEqual([
      '1.2.3.4',
      '5.6.7.8',
      '9.9.9.9',
    ]);
  });
  it('returns [] for missing/blank input', () => {
    expect(parseCovenantAllowedIps(undefined)).toEqual([]);
    expect(parseCovenantAllowedIps('')).toEqual([]);
    expect(parseCovenantAllowedIps('   ')).toEqual([]);
  });
});

describe('isCovenantIpAllowed', () => {
  it('is exact-match membership', () => {
    expect(isCovenantIpAllowed('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(isCovenantIpAllowed('1.2.3.5', ['1.2.3.4'])).toBe(false);
    expect(isCovenantIpAllowed('1.2.3.4', [])).toBe(false);
  });
});

describe('covenant config gate', () => {
  it('isCovenantConfigured requires BOTH pubkey and an allowed IP', () => {
    delete process.env.PARTNER_PUBKEYS;
    delete process.env.COVENANT_ALLOWED_IPS;
    expect(isCovenantConfigured()).toBe(false);

    process.env.PARTNER_PUBKEYS = JSON.stringify({ covenant: TEST_PUBKEY_B58 });
    expect(isCovenantConfigured()).toBe(false); // still no IPs

    process.env.COVENANT_ALLOWED_IPS = ALLOWED_IP;
    expect(isCovenantConfigured()).toBe(true);

    // Pubkey present for a DIFFERENT partner only → not configured for covenant.
    process.env.PARTNER_PUBKEYS = JSON.stringify({ hatcher: TEST_PUBKEY_B58 });
    expect(covenantConfigStatus().pubkeyConfigured).toBe(false);
  });
});

describe('getClientIp (CF-aware extraction reused by the gate)', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    const ip = getClientIp({
      get: (n) =>
        n === 'cf-connecting-ip'
          ? '9.9.9.9'
          : n === 'x-forwarded-for'
            ? '1.1.1.1, 2.2.2.2'
            : null,
    });
    expect(ip).toBe('9.9.9.9');
  });
  it('falls back to the LAST x-forwarded-for entry when no cf header', () => {
    const ip = getClientIp({
      get: (n) => (n === 'x-forwarded-for' ? '1.1.1.1, 2.2.2.2' : null),
    });
    expect(ip).toBe('2.2.2.2');
  });
});

describe('requireCovenantPartner middleware', () => {
  it('503 partner_not_configured when env is unset', async () => {
    delete process.env.PARTNER_PUBKEYS;
    delete process.env.COVENANT_ALLOWED_IPS;
    const res = await makeApp().request('/probe', {
      headers: { 'cf-connecting-ip': ALLOWED_IP },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'partner_not_configured' });
  });

  it('503 when pubkey is set but the IP allowlist is empty', async () => {
    process.env.PARTNER_PUBKEYS = JSON.stringify({ covenant: TEST_PUBKEY_B58 });
    delete process.env.COVENANT_ALLOWED_IPS;
    const res = await makeApp().request('/probe', {
      headers: { 'cf-connecting-ip': ALLOWED_IP },
    });
    expect(res.status).toBe(503);
  });

  it('403 when configured but the client IP is not allowlisted', async () => {
    configureCovenant();
    const res = await makeApp().request('/probe', {
      headers: { 'cf-connecting-ip': '5.5.5.5' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('401 when the IP is allowed but the signature is missing', async () => {
    configureCovenant();
    const res = await makeApp().request('/probe', {
      headers: { 'cf-connecting-ip': ALLOWED_IP },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401 when the signature is present but forged (wrong key)', async () => {
    configureCovenant();
    const tsMs = String(Date.now());
    const otherKp = nacl.sign.keyPair();
    const challenge = `clawville-partner-get\nGET\n/probe\n${tsMs}`;
    const digest = createHash('sha256').update(challenge).digest();
    const forged = bs58.encode(nacl.sign.detached(new Uint8Array(digest), otherKp.secretKey));
    const res = await makeApp().request('/probe', {
      headers: {
        'cf-connecting-ip': ALLOWED_IP,
        [COVENANT_PUBKEY_HEADER]: TEST_PUBKEY_B58, // claims the real key…
        [COVENANT_SIGNATURE_HEADER]: forged, // …but signed with another
        [COVENANT_TIMESTAMP_HEADER]: tsMs,
      },
    });
    expect(res.status).toBe(401);
  });

  it('401 when the timestamp is stale (outside the ±5 min window)', async () => {
    configureCovenant();
    const staleTs = String(Date.now() - 6 * 60_000);
    const res = await makeApp().request('/probe', {
      headers: {
        'cf-connecting-ip': ALLOWED_IP,
        [COVENANT_PUBKEY_HEADER]: TEST_PUBKEY_B58,
        [COVENANT_SIGNATURE_HEADER]: signGet('GET', '/probe', staleTs),
        [COVENANT_TIMESTAMP_HEADER]: staleTs,
      },
    });
    expect(res.status).toBe(401);
  });

  it('passes to the handler on a valid signature from an allowed IP', async () => {
    configureCovenant();
    const tsMs = String(Date.now());
    const res = await makeApp().request('/probe', {
      headers: {
        'cf-connecting-ip': ALLOWED_IP,
        [COVENANT_PUBKEY_HEADER]: TEST_PUBKEY_B58,
        [COVENANT_SIGNATURE_HEADER]: signGet('GET', '/probe', tsMs),
        [COVENANT_TIMESTAMP_HEADER]: tsMs,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('exposes the covenant partner id as "covenant"', () => {
    expect(COVENANT_PARTNER_ID).toBe('covenant');
  });
});

describe('partner-covenant handler response shapes (mocked db)', () => {
  let app: Hono;

  beforeAll(async () => {
    // Import AFTER mock.module('@clawville/database') has registered (top-level).
    const mod = await import('../partner-covenant');
    app = new Hono();
    app.route('/api/partner/covenant', mod.partnerCovenantRoutes);
  });

  it('GET /bounties returns EXACTLY {bounties, limit, offset} + fixed item keys', async () => {
    configureCovenant();
    cov.selectQueue = [
      [
        {
          id: TEST_UUID,
          title: 't',
          status: 'open',
          paymentRail: 'ct',
          verdictRequired: false,
          escrowPda: null,
          escrowJobId: null,
          tokenReward: 50,
          currentAttempts: 0,
          expiresAt: null,
          updatedAt: new Date(),
        },
      ],
    ];
    const path = '/api/partner/covenant/bounties';
    const res = await app.request(path, { headers: covenantHeaders(path) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expectExactKeys(j, ['bounties', 'limit', 'offset']);
    const rows = j.bounties as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expectExactKeys(rows[0], [
      'id',
      'title',
      'status',
      'paymentRail',
      'verdictRequired',
      'escrowPda',
      'escrowJobId',
      'tokenReward',
      'currentAttempts',
      'expiresAt',
      'updatedAt',
    ]);
  });

  it('GET /bounties/:id/verification returns EXACTLY the 6-key bundle + fixed nested keys', async () => {
    configureCovenant();
    cov.bountyFindFirst = {
      id: TEST_UUID,
      creatorId: 'creator-avatar-id',
      title: 't',
      description: 'd',
      requirements: 'r',
      acceptanceCriteria: 'ac',
      difficulty: 'intermediate',
      status: 'open',
      tokenReward: 100,
      paymentRail: 'usdc',
      verdictRequired: true,
      covenantAuditRootHex: 'ab',
      covenantVerificationPassed: true,
      covenantVerdictId: 'v1',
      escrowPda: 'EPDA',
      escrowJobId: TEST_UUID,
      maxAttempts: 1,
      currentAttempts: 1,
      expiresAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    cov.avatarFindFirst = { id: 'creator-avatar-id', name: 'Creator', species: 'turtle' };
    cov.repFindFirst = { tier: 'expert' };
    cov.selectQueue = [
      // attempts
      [
        {
          id: 'att-1',
          hunterId: 'hunter-avatar-id',
          hunterName: 'Hunter',
          hunterWallet: HUNTER_WALLET,
          hunterUserId: 'hunter-user-id',
          status: 'submitted',
          prLink: 'https://example.com/pr/1',
          submissionNote: 'sn',
          reviewNote: 'rn',
          claimedAt: new Date(),
          submittedAt: new Date(),
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      // settlements
      [
        {
          id: 's-1',
          status: 'settled',
          dryRun: true,
          settleSignature: 'sig',
          fundingSignature: 'fsig',
          tokenMint: 'mint',
          pricePerCall: '100',
          maxCalls: '1',
          fundedAmount: '100',
          callsSettled: '1',
          releasedAmount: '100',
          refundedAmount: null,
          verificationProvider: 'covenant',
          verificationPassed: true,
          auditRootHex: 'ab',
          verificationDetail: 'ok',
          depositorAvatarId: 'creator-avatar-id',
          workerAvatarId: 'hunter-avatar-id',
          depositorWalletPubkey: 'DPUB',
          workerWalletPubkey: 'WPUB',
          createdAt: new Date(),
          updatedAt: new Date(),
          settledAt: new Date(),
        },
      ],
      // approvals
      [
        {
          id: 'ap-1',
          approverAvatarId: 'creator-avatar-id',
          workerAvatarId: 'hunter-avatar-id',
          approvedCalls: '1',
          approvedAt: new Date(),
        },
      ],
      // users (fingerprint lookup)
      [{ id: 'hunter-user-id', fp: 'deadbeef' }],
    ];

    const path = `/api/partner/covenant/bounties/${TEST_UUID}/verification`;
    const res = await app.request(path, { headers: covenantHeaders(path) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expectExactKeys(j, [
      'bounty',
      'creator',
      'attempts',
      'escrowSettlements',
      'escrowApprovals',
      'hunterAgentIdentity',
    ]);
    expectExactKeys(j.bounty as Record<string, unknown>, [
      'id',
      'title',
      'description',
      'requirements',
      'acceptanceCriteria',
      'difficulty',
      'status',
      'tokenReward',
      'paymentRail',
      'verdictRequired',
      'covenantAuditRootHex',
      'covenantVerificationPassed',
      'covenantVerdictId',
      'escrowPda',
      'escrowJobId',
      'maxAttempts',
      'currentAttempts',
      'expiresAt',
      'completedAt',
      'createdAt',
      'updatedAt',
    ]);
    expectExactKeys(j.creator as Record<string, unknown>, [
      'avatarId',
      'name',
      'species',
      'reputationTier',
    ]);
    const attempts = j.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expectExactKeys(attempts[0], [
      'id',
      'hunter',
      'status',
      'prLink',
      'submissionNote',
      'reviewNote',
      'claimedAt',
      'submittedAt',
      'reviewedAt',
      'updatedAt',
    ]);
    expectExactKeys(attempts[0].hunter as Record<string, unknown>, ['avatarId', 'name']);
    const settlements = j.escrowSettlements as Array<Record<string, unknown>>;
    expect(settlements).toHaveLength(1);
    expectExactKeys(settlements[0], [
      'id',
      'status',
      'dryRun',
      'settleSignature',
      'fundingSignature',
      'tokenMint',
      'pricePerCall',
      'maxCalls',
      'fundedAmount',
      'callsSettled',
      'releasedAmount',
      'refundedAmount',
      'verificationProvider',
      'verificationPassed',
      'auditRootHex',
      'verificationDetail',
      'depositorAvatarId',
      'workerAvatarId',
      'depositorWalletPubkey',
      'workerWalletPubkey',
      'createdAt',
      'updatedAt',
      'settledAt',
    ]);
    const approvals = j.escrowApprovals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expectExactKeys(approvals[0], [
      'id',
      'approverAvatarId',
      'workerAvatarId',
      'approvedCalls',
      'approvedAt',
    ]);
    const identities = j.hunterAgentIdentity as Array<Record<string, unknown>>;
    expect(identities).toHaveLength(1);
    expectExactKeys(identities[0], [
      'name',
      'avatarId',
      'walletPubkey',
      'sapAgentPda',
      'eip8004RegistrationUrl',
    ]);
    // Wallet flows through as the mirror pubkey; PDA derives to a real base58 addr.
    expect(identities[0].walletPubkey).toBe(HUNTER_WALLET);
    expect(typeof identities[0].sapAgentPda).toBe('string');
  });

  it('GET /agents/:avatarId returns EXACTLY {avatar, reputation, agentIdentity} + fixed nested keys', async () => {
    configureCovenant();
    cov.avatarFindFirst = {
      id: TEST_UUID,
      name: 'Agent',
      species: 'turtle',
      userId: 'agent-user-id',
      walletAddress: AGENT_WALLET,
    };
    cov.repFindFirst = {
      tier: 'master',
      totalCompleted: 10,
      totalEarned: 500,
      totalPosted: 3,
      successRate: 90,
      lastActivityAt: new Date(),
    };
    cov.userFindFirst = { identityFingerprint: 'cafef00d' };

    const path = `/api/partner/covenant/agents/${TEST_UUID}`;
    const res = await app.request(path, { headers: covenantHeaders(path) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expectExactKeys(j, ['avatar', 'reputation', 'agentIdentity']);
    expectExactKeys(j.avatar as Record<string, unknown>, ['id', 'name', 'species']);
    expectExactKeys(j.reputation as Record<string, unknown>, [
      'tier',
      'totalCompleted',
      'totalEarned',
      'totalPosted',
      'successRate',
      'lastActivityAt',
    ]);
    expectExactKeys(j.agentIdentity as Record<string, unknown>, [
      'avatarId',
      'walletPubkey',
      'sapAgentPda',
      'eip8004RegistrationUrl',
    ]);
    expect((j.agentIdentity as Record<string, unknown>).walletPubkey).toBe(AGENT_WALLET);
  });

  it('GET /agents/:avatarId returns opaque 404 when the avatar is unknown', async () => {
    configureCovenant();
    cov.avatarFindFirst = null;
    const path = `/api/partner/covenant/agents/${TEST_UUID}`;
    const res = await app.request(path, { headers: covenantHeaders(path) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
