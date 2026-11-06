/**
 * /api/vendors/studios: request gates, the answer shape and the human-only key
 * routes. The paid flow is covered by outbound-x402-db.test.ts; the image
 * service by studios-images.test.ts.
 */

if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = '0'.repeat(64);
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import bs58 from 'bs58';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import * as realDatabase from '@clawville/database';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realGuard from '../../middleware/require-non-guest';
import * as realImages from '../../services/studios-images';
import * as realCreds from '../../services/vendor-credentials';

type Identity = { kind: 'user' | 'agent'; userId: string; avatarId: string; agentId: string | null; ledgerCapable?: boolean; guest?: boolean };
let identity: Identity | null = null;
let nextResult: realImages.StudiosImageResult = { ok: false, code: 'spend_rules_not_set', message: 'Spend caps are not set.', httpStatus: 403, ledgerId: null };
const calls: Array<Parameters<typeof realImages.generateStudiosImage>[0]> = [];
const savedKeys: Array<{ avatarId: string; key: string }> = [];
const sessions = new Map<string, { userId: string; createdVia: string | null }>();
const humanWallet = nacl.sign.keyPair();
const otherWallet = nacl.sign.keyPair();
let linkedWalletPubkey: string | null = null;
const deletedKeys: string[] = [];
const decisions: Array<Record<string, unknown>> = [];
const REQ = '11111111-2222-4333-8444-555555555555';

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie: (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null,
    validateSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) return { session: null, user: null };
      return { session: { id, userId: s.userId, fresh: false, expiresAt: new Date(Date.now() + 60_000), createdVia: s.createdVia }, user: { id: s.userId } };
    },
    createSessionCookie: () => ({ serialize: () => 'auth_session=x' }),
    createBlankSessionCookie: () => ({ serialize: () => 'auth_session=' }),
  },
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: async (c: any, next: () => Promise<void>) => {
    if (!identity) throw new HTTPException(401, { message: 'unauthorized' });
    c.set('identity', identity);
    return next();
  },
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realGuard,
  requireNonGuestIdentity: async (c: any, next: () => Promise<void>) => {
    if (identity?.guest) return c.json({ code: 'guest_not_allowed' }, 403);
    return next();
  },
  requireNonGuestUser: async (_c: any, next: () => Promise<void>) => next(),
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: { query: {
    avatars: { findFirst: async () => ({ id: 'avatar-of-user' }) },
    users: { findFirst: async () => ({ linkedWalletPubkey }) },
  } },
}));
mock.module('../../services/studios-images', () => ({
  ...realImages,
  generateStudiosImage: async (input: Parameters<typeof realImages.generateStudiosImage>[0]) => {
    calls.push(input);
    return nextResult;
  },
  requestStudiosOperation: async (input: Record<string, unknown>) => {
    opCalls.push(input);
    return nextOpResult;
  },
  listMedia: async () => [],
  listAwaitingApprovals: async (avatarId: string) => {
    decisions.push({ kind: 'list', avatarId });
    return [];
  },
  approveStudiosRequest: async (input: { avatarId: string; userId: string; requestId: string; terms: { mode: string } }) => {
    decisions.push({ kind: 'approve', avatarId: input.avatarId, userId: input.userId, requestId: input.requestId, signedMode: input.terms.mode });
    return { result: nextResult, surface: 'api' };
  },
  readApprovalTerms: async (avatarId: string, requestId: string) => (requestId === REQ
    ? { ok: true, terms: { avatarId, requestId, operation: 'image', mode: 'wallet', maxUsdCents: 10, promptSha256: 'a'.repeat(64), paramsSha256: null, credentialSha256: null } }
    : { ok: false, result: { ok: false, code: 'approval_not_found', message: 'none', httpStatus: 404, ledgerId: null } }),
  declineStudiosRequest: async (input: { avatarId: string; userId: string; requestId: string }) => {
    decisions.push({ kind: 'decline', ...input });
    return { ok: true, requestId: input.requestId, status: 'declined', surface: 'api' };
  },
  readStudiosRequest: async (avatarId: string, requestId: string) => {
    decisions.push({ kind: 'read', avatarId, requestId });
    return avatarId === 'a1' && requestId === REQ ? { requestId, status: 'awaiting_approval', mode: 'wallet' } : null;
  },
}));
const opCalls: Array<Record<string, unknown>> = [];
let nextOpResult: unknown = { ok: false, code: 'running', httpStatus: 202, message: 'running', ledgerId: null, requestId: REQ };
mock.module('../../services/studios-menus', () => ({
  readStudiosMenu: async (menu: string) => (menu === 'recast-presets' ? { presets: [{ id: 'recast-x-wan', priceUsd: 1 }] } : null),
  resetStudiosMenuCache: () => {},
}));
mock.module('../../services/vendor-credentials', () => ({
  ...realCreds,
  saveVendorKey: async (avatarId: string, _v: string, _u: string, key: string) => {
    savedKeys.push({ avatarId, key });
    return { linked: true, last4: key.slice(-4), updatedAt: '2026-11-05T00:00:00.000Z' };
  },
  readVendorKeyStatus: async () => ({ linked: false, last4: null, updatedAt: null }),
  deleteVendorKey: async (avatarId: string) => {
    deletedKeys.push(avatarId);
  },
}));

const { vendorStudiosRoutes, resetStudiosRateLimit } = await import('../vendor-studios');
const app = new Hono();
app.route('/api/vendors/studios', vendorStudiosRoutes);
app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: 'x' }, 500)));

function post(body: unknown, key: string | null = 'key-12345678') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return app.request('/api/vendors/studios/images', { method: 'POST', headers, body: JSON.stringify(body) });
}

type Proof = { nonce: string; signature: string };

function keyRequest(method: 'PUT' | 'DELETE' | 'POST', path: string, opts: { cookie?: string; agent?: string; body: unknown }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[realAgentAuth.AGENT_SESSION_HEADER] = opts.agent;
  return app.request(`/api/vendors/studios${path}`, { method, headers, body: JSON.stringify(opts.body) });
}

function putKey(opts: { cookie?: string; agent?: string; apiKey: string; proof?: Proof }) {
  return keyRequest('PUT', '/key', { ...opts, body: { apiKey: opts.apiKey, ...(opts.proof ? { proof: opts.proof } : {}) } });
}

const KEY_A = 'chk_abcdefghijklmnop1234';
/** The save challenge body for a key, as the browser builds it. */
function saveRef(key: string) {
  return { action: 'save' as const, last4: key.slice(-4), sha256: createHash('sha256').update(key).digest('hex') };
}

/** Ask a challenge and sign it with `signer` (the linked wallet by default). */
async function signedProof(body: ReturnType<typeof saveRef> | { action: 'remove' }, signer = humanWallet): Promise<Proof> {
  const res = await keyRequest('POST', '/key/challenge', { cookie: 'pw', body });
  expect(res.status).toBe(200);
  const challenge = await res.json() as { nonce: string; messageToSign: string; walletPubkey: string };
  expect(challenge.walletPubkey).toBe(linkedWalletPubkey!);
  const signature = nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), signer.secretKey);
  return { nonce: challenge.nonce, signature: bs58.encode(signature) };
}

beforeEach(() => {
  resetStudiosRateLimit();
  calls.length = 0;
  savedKeys.length = 0;
  deletedKeys.length = 0;
  decisions.length = 0;
  linkedWalletPubkey = bs58.encode(humanWallet.publicKey);
  sessions.clear();
  sessions.set('pw', { userId: 'u1', createdVia: 'password' });
  sessions.set('exchanged', { userId: 'u1', createdVia: 'agent_exchange' });
  identity = { kind: 'user', userId: 'u1', avatarId: 'a1', agentId: null };
  nextResult = { ok: false, code: 'spend_rules_not_set', message: 'Spend caps are not set.', httpStatus: 403, ledgerId: null };
});

describe('POST /api/vendors/studios/images', () => {
  it('refuses a guest and an agent session that is not ledger-capable', async () => {
    identity = { kind: 'user', userId: 'u1', avatarId: 'a1', agentId: null, guest: true };
    expect((await post({ prompt: 'crab' })).status).toBe(403);
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a1', agentId: 'g1', ledgerCapable: false };
    const res = await post({ prompt: 'crab' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'agent_session_not_ledger_authorized' });
    expect(calls).toHaveLength(0);
  });

  it('needs an Idempotency-Key and a valid body', async () => {
    expect((await post({ prompt: 'crab' }, null)).status).toBe(400);
    expect((await post({ prompt: 'crab' }, 'short')).status).toBe(400);
    for (const body of [{}, { prompt: '' }, { prompt: 'x'.repeat(1001) }, { prompt: 'crab', model: 'gpt-image-2' }, { prompt: 'crab', extra: 1 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('calls the shared service as the right actor for the session avatar', async () => {
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a9', agentId: 'g1', ledgerCapable: true };
    await post({ prompt: 'a green crab' });
    expect(calls[0]).toEqual({ avatarId: 'a9', actor: 'agent', prompt: 'a green crab', model: undefined, idempotencyKey: 'key-12345678' });
  });

  it('limits each avatar to 6 calls a minute, and refuses a large body', async () => {
    for (let i = 0; i < 6; i += 1) expect((await post({ prompt: 'crab' }, `key-0000000${i}`)).status).toBe(403);
    expect((await post({ prompt: 'crab' }, 'key-00000099')).status).toBe(429);
    expect(calls).toHaveLength(6);
    resetStudiosRateLimit();
    const big = JSON.stringify({ prompt: 'x'.repeat(20 * 1024) });
    const res = await app.request('/api/vendors/studios/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-big00000', 'Content-Length': String(big.length) },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('returns the refusal from the service with its status', async () => {
    nextResult = { ok: false, code: 'over_daily_cap', message: 'This call would pass the daily cap. Nothing was paid.', httpStatus: 402, ledgerId: null };
    const res = await post({ prompt: 'crab' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'over_daily_cap', message: 'This call would pass the daily cap. Nothing was paid.' });
  });

  it('returns the stored image path on success', async () => {
    nextResult = { ok: true, mode: 'wallet', mediaId: 'm1', mediaPath: '/api/media/m1', ledgerId: 'l1', paidUsdCents: 1, txSignature: 'tx1' };
    const res = await post({ prompt: 'crab' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(nextResult);
  });
});

describe('POST /videos, /characters, /recasts and GET /options/:menu (phase 3b)', () => {
  function postOp(path: string, body: unknown, key: string | null = 'key-12345678') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    return app.request(`/api/vendors/studios${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  it('each route checks the session, the key and the body with the operation schema, then calls the shared service', async () => {
    opCalls.length = 0;
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a1', agentId: 'g1', ledgerCapable: false };
    expect((await postOp('/videos', { prompt: 'boat' })).status).toBe(403);
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a1', agentId: 'g1', ledgerCapable: true };
    expect((await postOp('/videos', { prompt: 'boat' }, null)).status).toBe(400);
    expect((await postOp('/videos', { prompt: 'boat', imageUrl: 'https://127.0.0.1/x.png' })).status).toBe(400);
    expect((await postOp('/characters', {})).status).toBe(400);
    expect((await postOp('/recasts', { preset: 'p', imageUrls: ['http://cdn.example.org/a.png'] })).status).toBe(400);
    expect(opCalls).toHaveLength(0);
    const video = await postOp('/videos', { prompt: 'boat', durationSeconds: 5 });
    expect(video.status).toBe(202);
    expect(await video.json()).toEqual({ status: 'running', requestId: REQ, message: 'running' });
    nextOpResult = { ok: false, code: 'operation_needs_studios_key', httpStatus: 403, message: 'key only', ledgerId: null };
    const chars = await postOp('/characters', { random: true });
    expect(chars.status).toBe(403);
    expect(await chars.json()).toMatchObject({ code: 'operation_needs_studios_key' });
    nextOpResult = { ok: false, code: 'running', httpStatus: 202, message: 'running', ledgerId: null, requestId: REQ };
    expect((await postOp('/recasts', { preset: 'recast-x-wan', imageUrls: ['https://cdn.example.org/a.png'] })).status).toBe(400);
    expect((await postOp('/recasts', { preset: 'recast-x-wan', imageUrls: ['https://api.clawville.world/api/media/11111111-2222-4333-8444-555555555555'] })).status).toBe(202);
    expect(opCalls.map((c) => [c.operation, c.actor, c.avatarId, c.idempotencyKey])).toEqual([
      ['video', 'agent', 'a1', 'key-12345678'],
      ['character_shots', 'agent', 'a1', 'key-12345678'],
      ['recast', 'agent', 'a1', 'key-12345678'],
    ]);
    expect(opCalls[0]!.params).toEqual({ prompt: 'boat', durationSeconds: 5 });
  });

  it('serves a known menu and refuses an unknown one', async () => {
    const ok = await app.request('/api/vendors/studios/options/recast-presets');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ menu: 'recast-presets', presets: [{ id: 'recast-x-wan', priceUsd: 1 }] });
    expect((await app.request('/api/vendors/studios/options/chat-models')).status).toBe(400);
    expect((await app.request('/api/vendors/studios/options/builder')).status).toBe(502);
  });
});

describe('Studios key routes (human only, linked wallet signs)', () => {
  it('refuses an agent header and an agent-exchanged cookie', async () => {
    for (const opts of [{ agent: 'x', cookie: 'pw' }, { cookie: 'exchanged' }]) {
      const res = await putKey({ ...opts, apiKey: 'chk_abcdefghijklmnop1234' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'studios_key_human_only' });
      const challenge = await keyRequest('POST', '/key/challenge', { ...opts, body: { action: 'remove' } });
      expect(challenge.status).toBe(403);
    }
    expect(savedKeys).toHaveLength(0);
  });

  it('needs a linked wallet and its signature: a session alone cannot change the key', async () => {
    expect((await putKey({ cookie: 'pw', apiKey: 'not-a-key' })).status).toBe(400);
    let res = await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'studios_key_needs_wallet_proof' });
    linkedWalletPubkey = null;
    res = await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'studios_key_needs_wallet_link' });
    res = await keyRequest('POST', '/key/challenge', { cookie: 'pw', body: { action: 'remove' } });
    expect(await res.json()).toMatchObject({ code: 'studios_key_needs_wallet_link' });
    expect(savedKeys).toHaveLength(0);
  });

  it('refuses a proof from another wallet, for another key, for another action, or used twice', async () => {
    const otherSigner = await signedProof(saveRef(KEY_A), otherWallet);
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof: otherSigner })).status).toBe(401);
    const otherKey = await signedProof(saveRef('chk_zzzzzzzzzzzzzzzz9999'));
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof: otherKey })).status).toBe(401);
    const removeProof = await signedProof({ action: 'remove' });
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof: removeProof })).status).toBe(401);
    // Same last 4 characters, another key: the signed digest does not match.
    const sameSuffix = await signedProof(saveRef(KEY_A));
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_ZZZZZZZZZZZZZZZZ1234', proof: sameSuffix })).status).toBe(401);
    const good = await signedProof(saveRef(KEY_A));
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof: good })).status).toBe(200);
    expect((await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof: good })).status).toBe(401);
    expect(savedKeys).toHaveLength(1);
  });

  it('saves a well-formed key for the human active avatar and returns only the last 4', async () => {
    const proof = await signedProof(saveRef(KEY_A));
    const res = await putKey({ cookie: 'pw', apiKey: 'chk_abcdefghijklmnop1234', proof });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ linked: true, last4: '1234', updatedAt: '2026-11-05T00:00:00.000Z' });
    expect(JSON.stringify(body)).not.toContain('chk_');
    expect(savedKeys).toEqual([{ avatarId: 'avatar-of-user', key: 'chk_abcdefghijklmnop1234' }]);
  });

  it('removes the key only with a remove proof', async () => {
    let res = await keyRequest('DELETE', '/key', { cookie: 'pw', body: {} });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'studios_key_needs_wallet_proof' });
    const saveProof = await signedProof(saveRef(KEY_A));
    expect((await keyRequest('DELETE', '/key', { cookie: 'pw', body: { proof: saveProof } })).status).toBe(401);
    const proof = await signedProof({ action: 'remove' });
    res = await keyRequest('DELETE', '/key', { cookie: 'pw', body: { proof } });
    expect(res.status).toBe(200);
    expect(deletedKeys).toEqual(['avatar-of-user']);
  });
});

function postAs(cookie: string | null, body: unknown, key = 'key-12345678') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
  if (cookie) headers.Cookie = `auth_session=${cookie}`;
  return app.request('/api/vendors/studios/images', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('"Ask me before each payment": the request side', () => {
  it('answers 202 with the request id when the request waits for the human', async () => {
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a1', agentId: 'g1', ledgerCapable: true };
    nextResult = { ok: false, code: 'awaiting_approval', httpStatus: 202, message: 'waits', ledgerId: null, requestId: REQ, expiresAt: '2026-11-06T12:15:00.000Z' };
    const res = await post({ prompt: 'crab' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'awaiting_approval', requestId: REQ, expiresAt: '2026-11-06T12:15:00.000Z', message: 'waits' });
  });

  it('counts only a human sign-in cookie as the human; an exchanged or origin-less cookie is the agent', async () => {
    sessions.set('legacy', { userId: 'u1', createdVia: null });
    for (const [cookie, actor] of [['pw', 'human'], ['exchanged', 'agent'], ['legacy', 'agent'], [null, 'agent']] as const) {
      calls.length = 0;
      resetStudiosRateLimit();
      await postAs(cookie, { prompt: 'crab' });
      expect(calls[0]?.actor).toBe(actor);
    }
  });
});

function approvalRequest(method: 'GET' | 'POST', path: string, opts: { cookie?: string; agent?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[realAgentAuth.AGENT_SESSION_HEADER] = opts.agent;
  return app.request(`/api/vendors/studios${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}

/** Ask the approve challenge for REQ and sign it with `signer` (the linked wallet by default). */
async function approvalProof(signer = humanWallet): Promise<Proof & { messageToSign: string }> {
  const res = await approvalRequest('POST', `/approvals/${REQ}/challenge`, { cookie: 'pw', body: {} });
  expect(res.status).toBe(200);
  const challenge = await res.json() as { nonce: string; messageToSign: string; walletPubkey: string };
  expect(challenge.walletPubkey).toBe(linkedWalletPubkey!);
  const signature = nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), signer.secretKey);
  return { nonce: challenge.nonce, signature: bs58.encode(signature), messageToSign: challenge.messageToSign };
}

const approveWith = (proof?: Proof) => approvalRequest('POST', `/approvals/${REQ}/approve`, {
  cookie: 'pw',
  body: proof ? { proof: { nonce: proof.nonce, signature: proof.signature } } : {},
});

describe('"Ask me before each payment": approve and decline are human-only', () => {
  it('refuses an agent header, an agent-exchanged cookie and no session, before any decision', async () => {
    for (const path of ['/approvals', `/approvals/${REQ}/challenge`, `/approvals/${REQ}/approve`, `/approvals/${REQ}/decline`]) {
      const method = path === '/approvals' ? 'GET' : 'POST';
      for (const opts of [{ agent: 'x' }, { agent: 'x', cookie: 'pw' }, { cookie: 'exchanged' }]) {
        const res = await approvalRequest(method, path, opts);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'studios_approval_human_only' });
      }
      expect((await approvalRequest(method, path)).status).toBe(401);
    }
    expect(decisions).toHaveLength(0);
  });

  it('the challenge names the account, avatar, request, payer, the most it costs and the prompt hash', async () => {
    const { messageToSign } = await approvalProof();
    expect(messageToSign).toContain('ClawVille payment approval');
    expect(messageToSign).toContain('account: u1');
    expect(messageToSign).toContain('avatar: avatar-of-user');
    expect(messageToSign).toContain(`request: ${REQ}`);
    expect(messageToSign).toContain('pays: my agent wallet, at most $0.10');
    expect(messageToSign).toContain(`prompt sha256: ${'a'.repeat(64)}`);
    expect(messageToSign).toMatch(/\nnonce: \S+$/);
  });

  it('a session cookie alone never approves: no signature, a wrong wallet, a replayed nonce', async () => {
    nextResult = { ok: true, mode: 'wallet', mediaId: 'm1', mediaPath: '/api/media/m1', ledgerId: 'l1', paidUsdCents: 1, txSignature: 'tx1' };
    let res = await approveWith();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'studios_approval_needs_wallet_proof' });
    res = await approveWith(await approvalProof(otherWallet));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'studios_approval_invalid_wallet_proof' });
    const good = await approvalProof();
    expect((await approveWith(good)).status).toBe(200);
    res = await approveWith(good);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'studios_approval_invalid_wallet_proof' });
    expect(decisions.filter((d) => d.kind === 'approve')).toHaveLength(1);
  });

  it('needs a linked wallet for the challenge and the approve', async () => {
    linkedWalletPubkey = null;
    for (const path of [`/approvals/${REQ}/challenge`, `/approvals/${REQ}/approve`]) {
      const res = await approvalRequest('POST', path, { cookie: 'pw', body: {} });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'studios_approval_needs_wallet_link' });
    }
    expect(decisions).toHaveLength(0);
  });

  it('lists, approves with the signature and declines with the session for the human active avatar', async () => {
    expect((await approvalRequest('GET', '/approvals', { cookie: 'pw' })).status).toBe(200);
    nextResult = { ok: true, mode: 'wallet', mediaId: 'm1', mediaPath: '/api/media/m1', ledgerId: 'l1', paidUsdCents: 1, txSignature: 'tx1' };
    const approved = await approveWith(await approvalProof());
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(nextResult);
    const declined = await approvalRequest('POST', `/approvals/${REQ}/decline`, { cookie: 'pw' });
    expect(await declined.json()).toEqual({ requestId: REQ, status: 'declined' });
    expect(decisions).toEqual([
      { kind: 'list', avatarId: 'avatar-of-user' },
      { kind: 'approve', avatarId: 'avatar-of-user', userId: 'u1', requestId: REQ, signedMode: 'wallet' },
      { kind: 'decline', avatarId: 'avatar-of-user', userId: 'u1', requestId: REQ },
    ]);
  });

  it('returns an approve refusal with its code and status, and refuses a bad id without a decision', async () => {
    nextResult = { ok: false, code: 'approval_expired', message: 'expired', httpStatus: 409, ledgerId: null };
    const res = await approveWith(await approvalProof());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_expired' });
    decisions.length = 0;
    expect((await approvalRequest('POST', '/approvals/not-a-uuid/approve', { cookie: 'pw', body: {} })).status).toBe(404);
    expect(decisions).toHaveLength(0);
  });
});

describe('GET /api/vendors/studios/requests/:id', () => {
  it('reads one request of the session avatar, for the agent or the human', async () => {
    identity = { kind: 'agent', userId: 'u1', avatarId: 'a1', agentId: 'g1', ledgerCapable: true };
    const res = await approvalRequest('GET', `/requests/${REQ}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestId: REQ, status: 'awaiting_approval' });
  });

  it('is 404 for another avatar or a bad id', async () => {
    identity = { kind: 'agent', userId: 'u2', avatarId: 'a2', agentId: 'g2', ledgerCapable: true };
    expect((await approvalRequest('GET', `/requests/${REQ}`)).status).toBe(404);
    expect((await approvalRequest('GET', '/requests/x')).status).toBe(404);
  });
});
