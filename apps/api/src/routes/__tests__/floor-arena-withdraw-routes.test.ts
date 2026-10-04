import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_REQUEST_CODES,
  buildFloorArenaWithdrawAddressMessage,
  cloneFloorArenaParams,
} from '@clawville/shared';
import { createFloorArenaRoutes, type FloorArenaRouteDeps } from '../floor-arena';
import { requireLedgerCapableIdentity } from '../../middleware/require-auth-or-agent';
import { createRateLimiter } from '../../middleware/rate-limit';
import { buildWalletLinkMessage } from '../../services/wallet-link-challenge';
import * as writer from '../../services/clawpump-writer';
import type {
  ArenaAgentRecord,
  ArenaEvent,
  ArenaWithdrawAddressRecord,
  ArenaWithdrawalRecord,
  ArenaWithdrawRequestResult,
} from '../../services/floor-arena/queries';

/**
 * P5 T5 withdraw routes (contract ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md
 * §6 + §10 T5). REAL MONEY surface: every case here runs on fake deps, so NO
 * route may reach ClawPump, the RPC or the network (I4); the last block spies
 * on the withdraw writer and on fetch to prove it.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const USER = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const AVATAR = '00000000-0000-4000-8000-0000000000aa';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const BOT_ID = 'bot-1';
const SOURCE_WALLET = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey);
const GENESIS = FLOOR_ARENA_TEMPLATES.find((template) => template.id === 'genesis')!;

/** A 32-byte base58 text that is NOT an ed25519 point (arenaDestinationProblem says off_curve). */
function offCurveAddress(): string {
  for (let i = 1; i < 256; i++) {
    const text = bs58.encode(new Uint8Array(32).fill(i));
    if (writer.arenaDestinationProblem(text) === 'off_curve') return text;
  }
  throw new Error('no off-curve sample');
}

function userAgent(overrides: Partial<ArenaAgentRecord> = {}): ArenaAgentRecord {
  return {
    id: AGENT_ID, kind: 'user', ownerUserId: USER, avatarId: AVATAR, name: 'Trader', templateId: GENESIS.id,
    params: cloneFloorArenaParams(GENESIS.params), paramsVersion: 1, mode: 'paper', status: 'active', seated: false,
    seatIndex: null, seatedAt: null, clawpumpAgentId: 'cp-agent-1', clawpumpWallet: SOURCE_WALLET, provisionState: 'ready',
    provisionError: null, provisionAttempts: 0, provisionNextAt: null, addons: [], autoApplySuggestions: false, contestId: null,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function withdrawalRow(overrides: Partial<ArenaWithdrawalRecord> = {}): ArenaWithdrawalRecord {
  return {
    id: crypto.randomUUID(), agentId: AGENT_ID, ownerUserId: USER, subjectKind: 'human', subjectAgentId: null,
    idempotencyKey: 'key-00000001', asset: 'USDC', amountMode: 'exact', requestedAtomic: 100_000n, amountAtomic: null,
    sourceClawpumpAgentId: 'cp-agent-1', sourceWallet: SOURCE_WALLET, destination: 'DestDestDestDestDestDestDestDestDest',
    addressId: crypto.randomUUID(), state: 'requested', errorCode: null, preBalanceAtomic: null, preSolLamports: null,
    postBalanceAtomic: null, txSignature: null, recipientAccountCreated: null, reviewNote: null, requestedAt: NOW,
    dispatchedAt: null, sentAt: null, finalizedAt: null, lastCheckedAt: null, checkCount: 0, ...overrides,
  };
}

/** Identity from test headers, standing in for session + requireAuthOrAgentSession (same as floor-arena-routes.test.ts). */
const fakeIdentity: MiddlewareHandler = async (c, next) => {
  const user = c.req.header('x-test-user');
  if (!user) return c.json({ error: 'auth' }, 401);
  const kind = c.req.header('x-test-kind') === 'agent' ? 'agent' : 'user';
  c.set('identity' as never, (kind === 'agent'
    ? { kind, userId: user, avatarId: AVATAR, agentId: BOT_ID, sessionId: 's', ledgerCapable: c.req.header('x-test-ledger') !== 'false' }
    : { kind, userId: user, avatarId: AVATAR, agentId: null }) as never);
  return next();
};

/**
 * Stand-in for requireNonGuestIdentity (the real one reads users.is_guest from
 * Postgres): the same 403 body for a guest human OR a guest-owned agent. The real
 * chain order is pinned in floor-arena-routes.test.ts (FLOOR_ARENA_AUTH_CHAIN).
 */
const fakeGuestGate: MiddlewareHandler = async (c, next) => {
  if (c.req.header('x-test-guest') === 'true') {
    return c.json({ error: 'Guests run a demo economy. Create a free account to use this feature.', code: 'guest_not_allowed' }, 403);
  }
  return next();
};

const CHAIN: MiddlewareHandler[] = [fakeIdentity, fakeGuestGate, requireLedgerCapableIdentity as unknown as MiddlewareHandler];

function makeStore() {
  return {
    agent: userAgent() as ArenaAgentRecord | null,
    challenges: new Map<string, { agentId: string; ownerUserId: string; address: string; message: string; expiresAt: Date; consumed: boolean }>(),
    arenaWallets: new Set<string>([SOURCE_WALLET]),
    linked: new Map<string, { address: string; linkedAt: Date }>(),
    addresses: [] as ArenaWithdrawAddressRecord[],
    withdrawals: [] as ArenaWithdrawalRecord[],
    requests: [] as Array<Parameters<FloorArenaRouteDeps['requestWithdrawal']>[0]>,
    setInputs: [] as Array<Parameters<FloorArenaRouteDeps['setWithdrawAddress']>[0]>,
    refuseNext: null as ArenaWithdrawRequestResult | null,
    listLimits: [] as number[],
    eventTypes: [] as Array<readonly string[] | null>,
  };
}

const EVENTS: ArenaEvent[] = [
  { id: 1, at: NOW.toISOString(), type: 'entry', mint: 'MintA', summary: 'Bought $20 of WIF', data: null },
  { id: 2, at: NOW.toISOString(), type: 'withdraw', mint: null, summary: 'Withdrawal requested: 0.1 USDC to Dest...Dest.', data: { action: 'requested' } },
  { id: 3, at: NOW.toISOString(), type: 'status', mint: null, summary: 'Sat down', data: null },
];

function makeDeps(store: ReturnType<typeof makeStore>): FloorArenaRouteDeps {
  const current = () => store.addresses.find((row) => row.revokedAt === null) ?? null;
  return {
    now: () => NOW,
    newId: () => AGENT_ID,
    readAgent: async (id) => (store.agent && store.agent.id === id ? store.agent : null),
    readAgentByOwner: async (userId) => (store.agent && store.agent.ownerUserId === userId ? store.agent : null),
    readHouseAgents: async () => [],
    readAvatarName: async () => 'Trader',
    insertUserAgent: async () => null,
    updateParams: async () => ({ ok: false, reason: 'version_conflict' }),
    setSeat: async () => null,
    setStatus: async () => null,
    setAddons: async () => null,
    setAutoApply: async () => null,
    readReport: async () => null,
    readLatestReport: async () => null,
    setReportState: async () => false,
    readPositions: async () => [],
    readParamChanges: async () => [],
    readEvents: async (_agentId, after, limit, types) => {
      store.eventTypes.push(types ?? null);
      return EVENTS.filter((event) => (after === null || event.id > after) && (!types || types.includes(event.type))).slice(-limit);
    },
    readDiscovery: async () => [],
    readTape: async () => [],
    readStats: async () => new Map(),
    readLeaderboard: async () => [],
    readContest: async () => { throw new Error('unused'); },
    readAddonStats: async () => [],
    readWalletBalance: async () => ({ agentId: 'cp-agent-1', walletAddress: SOURCE_WALLET, sol: 0.012, usdc: 1.5, updatedAt: NOW.toISOString() }),
    addonCatalog: () => [],
    addonPaymentsEnabled: () => true,
    logArenaEvent: async () => {},
    // ── Withdraw (fakes with the T3 semantics the routes rely on) ──
    issueWithdrawChallenge: async (input) => {
      const live = [...store.challenges.values()].filter((row) => row.agentId === input.agentId && row.expiresAt > input.now);
      if (live.length >= FLOOR_ARENA_WITHDRAW_LIMITS.maxLiveChallengesPerAgent) return { ok: false, reason: 'too_many_challenges' };
      const expiresAt = new Date(input.now.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.challengeTtlMs);
      const message = buildFloorArenaWithdrawAddressMessage({
        agentId: input.agentId, userId: input.ownerUserId, address: input.address, nonce: input.nonce, expiresAt: expiresAt.toISOString(),
      });
      store.challenges.set(input.nonce, { agentId: input.agentId, ownerUserId: input.ownerUserId, address: input.address, message, expiresAt, consumed: false });
      return { ok: true, nonce: input.nonce, message, expiresAt };
    },
    consumeWithdrawChallenge: async (input) => {
      const row = store.challenges.get(input.nonce);
      if (!row || row.consumed || row.agentId !== input.agentId || row.ownerUserId !== input.ownerUserId
        || row.address !== input.address || row.expiresAt <= NOW) return null;
      row.consumed = true;
      return { message: row.message };
    },
    isArenaWallet: async (address) => store.arenaWallets.has(address),
    readLinkedWallet: async (userId) => store.linked.get(userId) ?? null,
    setWithdrawAddress: async (input) => {
      store.setInputs.push(input);
      if (!store.agent || store.agent.provisionState !== 'ready') return { ok: false, reason: 'wallet_not_ready' };
      const old = current();
      if (old?.address === input.address) return { ok: false, reason: 'same_address' };
      if (old) { old.revokedAt = NOW; old.revokeReason = 'replaced'; }
      const row: ArenaWithdrawAddressRecord = {
        id: crypto.randomUUID(), agentId: input.agentId, ownerUserId: input.ownerUserId, address: input.address, proofKind: input.proofKind,
        message: input.message, signature: input.signature, challengeNonce: input.challengeNonce, setBy: input.setBy,
        setByAgentId: input.setByAgentId, createdAt: NOW, activeAt: new Date(Math.max(input.activeAt.getTime(), NOW.getTime())),
        revokedAt: null, revokeReason: null,
      };
      store.addresses.push(row);
      return { ok: true, address: row };
    },
    revokeWithdrawAddress: async (input) => {
      const row = store.addresses.find((item) => item.id === input.addressId && item.agentId === input.agentId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.revokedAt) return { ok: false, reason: 'already_revoked' };
      row.revokedAt = NOW;
      row.revokeReason = input.reason;
      return { ok: true };
    },
    requestWithdrawal: async (input) => {
      store.requests.push(input);
      if (store.refuseNext) {
        const refused = store.refuseNext;
        store.refuseNext = null;
        return refused;
      }
      const existing = store.withdrawals.find((row) => row.agentId === input.agentId && row.idempotencyKey === input.idempotencyKey);
      if (existing) {
        return existing.asset === input.asset && existing.amountMode === input.amountMode && existing.requestedAtomic === input.requestedAtomic
          ? { kind: 'replay', withdrawal: existing }
          : { kind: 'refused', code: 'idempotency_conflict', withdrawalId: existing.id };
      }
      const address = current()!;
      const row = withdrawalRow({
        agentId: input.agentId, ownerUserId: input.ownerUserId, subjectKind: input.subjectKind, subjectAgentId: input.subjectAgentId,
        idempotencyKey: input.idempotencyKey, asset: input.asset, amountMode: input.amountMode, requestedAtomic: input.requestedAtomic,
        destination: address?.address ?? 'none', addressId: address?.id ?? UNKNOWN_ID, requestedAt: input.now,
      });
      store.withdrawals.unshift(row);
      return { kind: 'created', withdrawal: row };
    },
    listWithdrawals: async (agentId, limit) => {
      store.listLimits.push(limit);
      return store.withdrawals.filter((row) => row.agentId === agentId).slice(0, limit);
    },
    cancelWithdrawal: async (agentId, withdrawalId) => {
      const row = store.withdrawals.find((item) => item.id === withdrawalId && item.agentId === agentId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.state !== 'requested') return { ok: false, reason: 'not_cancellable' };
      row.state = 'cancelled';
      row.finalizedAt = NOW;
      return { ok: true, withdrawal: row };
    },
    readWithdrawSummary: async (agentId) => ({
      address: store.addresses.find((row) => row.agentId === agentId && row.revokedAt === null) ?? null,
      open: store.withdrawals.find((row) => row.agentId === agentId && ['requested', 'dispatching', 'sent', 'unknown'].includes(row.state)) ?? null,
    }),
    readWithdrawAddress: async (agentId) => store.addresses.find((row) => row.agentId === agentId && row.revokedAt === null) ?? null,
  };
}

function app(options: { auth?: MiddlewareHandler[] | null } = {}) {
  const store = makeStore();
  const deps = makeDeps(store);
  const routes = createFloorArenaRoutes(deps, {
    ...(options.auth === null ? {} : { auth: options.auth ?? CHAIN }),
    limiters: {
      public: () => createRateLimiter({ maxPerWindow: 1_000 }),
      write: () => createRateLimiter({ maxPerWindow: 1_000 }),
      launch: () => createRateLimiter({ maxPerWindow: 1_000 }),
    },
  });
  const human = { 'x-test-user': USER };
  const agent = { 'x-test-user': USER, 'x-test-kind': 'agent' };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = human) =>
    await routes.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  return { store, deps, routes, call, human, agent };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

/** Challenge + sign with a real ed25519 keypair (the DESTINATION key), as a wallet or an agent does. */
async function signedProof(call: ReturnType<typeof app>['call'], keyPair = nacl.sign.keyPair(), headers?: Record<string, string>) {
  const address = bs58.encode(keyPair.publicKey);
  const challenge = await call('POST', '/me/withdraw-address/challenge', { address }, headers);
  expect(challenge.status).toBe(200);
  const body = await jsonOf(challenge);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(String(body.messageToSign)), keyPair.secretKey));
  return { address, nonce: String(body.nonce), messageToSign: String(body.messageToSign), signature, keyPair, challenge: body };
}

const WITHDRAW_ROUTES: Array<[string, string, unknown]> = [
  ['POST', '/me/withdraw-address/challenge', { address: SOURCE_WALLET }],
  ['POST', '/me/withdraw-address', { proof: 'linked_wallet' }],
  ['POST', '/me/withdraw-address/revoke', { addressId: UNKNOWN_ID }],
  ['POST', '/me/withdrawals', { asset: 'USDC', amount: '1' }],
  ['GET', '/me/withdrawals', undefined],
  ['POST', `/me/withdrawals/${UNKNOWN_ID}/cancel`, undefined],
];

describe('withdraw routes: auth chain (E5 parity, FLOOR_ARENA_AUTH_CHAIN)', () => {
  test('with the real default chain every withdraw route is 401 without a cookie or agent header', async () => {
    const { call } = app({ auth: null });
    for (const [method, path, body] of WITHDRAW_ROUTES) {
      const response = await call(method, path, body, { 'Idempotency-Key': 'key-00000001' });
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  });

  test('a guest (human or guest-owned agent) gets 403 guest_not_allowed on every withdraw route', async () => {
    const { call, store } = app();
    for (const kind of ['user', 'agent']) {
      for (const [method, path, body] of WITHDRAW_ROUTES) {
        const response = await call(method, path, body, { 'x-test-user': USER, 'x-test-kind': kind, 'x-test-guest': 'true', 'Idempotency-Key': 'key-00000001' });
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
        expect(await jsonOf(response)).toMatchObject({ code: 'guest_not_allowed' });
      }
    }
    expect(store.requests).toHaveLength(0);
    expect(store.challenges.size).toBe(0);
  });

  test('a non-ledger agent session gets 403 on every withdraw route (real requireLedgerCapableIdentity)', async () => {
    const { call, store } = app();
    for (const [method, path, body] of WITHDRAW_ROUTES) {
      const response = await call(method, path, body, { 'x-test-user': USER, 'x-test-kind': 'agent', 'x-test-ledger': 'false', 'Idempotency-Key': 'key-00000001' });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    expect(store.requests).toHaveLength(0);
    expect(store.setInputs).toHaveLength(0);
  });

  test('the ledger agent and the cookie human reach the SAME arena row (identity.userId), never one from the body', async () => {
    const { call, store, human, agent } = app();
    // The agent proves an address; the human reads it on the same arena agent.
    const proof = await signedProof(call, nacl.sign.keyPair(), agent);
    const set = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature }, agent);
    expect(set.status).toBe(201);
    expect(store.setInputs[0]).toMatchObject({ agentId: AGENT_ID, ownerUserId: USER, setBy: 'agent', setByAgentId: BOT_ID });
    const humanView = await jsonOf(await call('GET', '/me/withdrawals', undefined, human));
    expect(humanView.agentId).toBe(AGENT_ID);
    expect((humanView.address as { address: string; setBy: string }).address).toBe(proof.address);
    expect((humanView.address as { setBy: string }).setBy).toBe('agent');
    // Settle the address, then each subject requests: the row binds to the same agent, subject recorded.
    store.addresses[0]!.activeAt = new Date(NOW.getTime() - 1);
    const byAgent = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '0.5' }, { ...agent, 'Idempotency-Key': 'agent-key-0001' });
    expect(byAgent.status).toBe(202);
    expect(store.requests[0]).toMatchObject({ agentId: AGENT_ID, ownerUserId: USER, subjectKind: 'agent', subjectAgentId: BOT_ID });
    store.withdrawals[0]!.state = 'confirmed';
    const byHuman = await call('POST', '/me/withdrawals', { asset: 'SOL', amount: '0.01' }, { ...human, 'Idempotency-Key': 'human-key-0001' });
    expect(byHuman.status).toBe(202);
    expect(store.requests[1]).toMatchObject({ agentId: AGENT_ID, ownerUserId: USER, subjectKind: 'human', subjectAgentId: null });
    // Another account sees no arena agent at all.
    const other = await call('GET', '/me/withdrawals', undefined, { 'x-test-user': OTHER });
    expect(other.status).toBe(404);
    expect(await jsonOf(other)).toMatchObject({ code: 'no_agent' });
  });
});

describe('withdraw routes: strict bodies', () => {
  test('extra body keys answer 400 invalid_body and write nothing', async () => {
    const { call, store } = app();
    const cases: Array<[string, unknown, Record<string, string>?]> = [
      ['/me/withdraw-address/challenge', { address: SOURCE_WALLET, agentId: AGENT_ID }],
      ['/me/withdraw-address', { proof: 'linked_wallet', agentId: AGENT_ID }],
      ['/me/withdraw-address', { proof: 'signed', address: SOURCE_WALLET, nonce: 'n'.repeat(40), signature: 's'.repeat(88), extra: 1 }],
      ['/me/withdraw-address/revoke', { addressId: UNKNOWN_ID, agentId: AGENT_ID }],
      ['/me/withdrawals', { asset: 'USDC', amount: '1', agentId: AGENT_ID }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', { asset: 'USDC', amount: 1 }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', { asset: 'BONK', amount: '1' }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', { asset: 'SOL', amount: '0.1234567891' }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', { asset: 'SOL', amount: '1e3' }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', { asset: 'SOL', amount: '01' }, { 'Idempotency-Key': 'key-00000001' }],
      ['/me/withdrawals', 'not json', { 'Idempotency-Key': 'key-00000001' }],
    ];
    for (const [path, body, headers] of cases) {
      const response = await call('POST', path, body, { 'x-test-user': USER, ...(headers ?? {}) });
      expect({ path, body, status: response.status }).toEqual({ path, body, status: 400 });
      expect(await jsonOf(response)).toMatchObject({ code: 'invalid_body' });
    }
    // cancel takes no body: an object with a key is refused too.
    const row = withdrawalRow();
    store.withdrawals.push(row);
    const cancel = await call('POST', `/me/withdrawals/${row.id}/cancel`, { agentId: AGENT_ID });
    expect(cancel.status).toBe(400);
    expect(row.state).toBe('requested');
    expect(store.requests).toHaveLength(0);
    expect(store.setInputs).toHaveLength(0);
    expect(store.challenges.size).toBe(0);
  });
});

describe('POST /me/withdraw-address/challenge', () => {
  test('issues a DB challenge bound to user, agent and address with the exact message', async () => {
    const { call, store } = app();
    const address = bs58.encode(nacl.sign.keyPair().publicKey);
    const response = await call('POST', '/me/withdraw-address/challenge', { address: `  ${address} ` });
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(Object.keys(body).sort()).toEqual(['address', 'expiresAt', 'messageToSign', 'nonce']);
    expect(body.address).toBe(address);
    expect(String(body.nonce).length).toBeGreaterThanOrEqual(32);
    expect(String(body.nonce).length).toBeLessThanOrEqual(64);
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.challengeTtlMs).toISOString());
    expect(body.messageToSign).toBe(buildFloorArenaWithdrawAddressMessage({
      agentId: AGENT_ID, userId: USER, address, nonce: String(body.nonce), expiresAt: String(body.expiresAt),
    }));
    expect(store.challenges.get(String(body.nonce))).toMatchObject({ agentId: AGENT_ID, ownerUserId: USER, address });
  });

  test('refuses a bad address, an arena wallet, no agent, a wallet not ready and the 6th live challenge', async () => {
    const { call, store } = app();
    for (const address of [offCurveAddress(), bs58.encode(new Uint8Array(31).fill(9))]) {
      const response = await call('POST', '/me/withdraw-address/challenge', { address });
      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toMatchObject({ code: 'invalid_address' });
    }
    // Not base58 at all: the schema refuses it.
    expect((await call('POST', '/me/withdraw-address/challenge', { address: '0OIl'.repeat(10) })).status).toBe(400);
    const own = await call('POST', '/me/withdraw-address/challenge', { address: SOURCE_WALLET });
    expect(own.status).toBe(400);
    expect(await jsonOf(own)).toMatchObject({ code: 'address_not_allowed' });
    expect(store.challenges.size).toBe(0);
    const fresh = () => bs58.encode(nacl.sign.keyPair().publicKey);
    for (let i = 0; i < FLOOR_ARENA_WITHDRAW_LIMITS.maxLiveChallengesPerAgent; i++) {
      expect((await call('POST', '/me/withdraw-address/challenge', { address: fresh() })).status).toBe(200);
    }
    const sixth = await call('POST', '/me/withdraw-address/challenge', { address: fresh() });
    expect(sixth.status).toBe(429);
    expect(await jsonOf(sixth)).toMatchObject({ code: 'too_many_challenges' });
    store.agent = userAgent({ provisionState: 'pending', clawpumpAgentId: null, clawpumpWallet: null });
    const pending = await call('POST', '/me/withdraw-address/challenge', { address: fresh() });
    expect(pending.status).toBe(409);
    expect(await jsonOf(pending)).toMatchObject({ code: 'wallet_not_ready' });
    store.agent = null;
    const none = await call('POST', '/me/withdraw-address/challenge', { address: fresh() });
    expect(none.status).toBe(404);
    expect(await jsonOf(none)).toMatchObject({ code: 'no_agent' });
  });
});

describe('POST /me/withdraw-address (signed)', () => {
  test('a real nacl signature over the challenge sets a pending address, active 24 h later', async () => {
    const { call, store } = app();
    const proof = await signedProof(call);
    const response = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature });
    expect(response.status).toBe(201);
    const text = await response.text();
    const body = JSON.parse(text) as { address: Record<string, unknown> };
    expect(body.address).toEqual({
      id: store.addresses[0]!.id, address: proof.address, proof: 'signed', setBy: 'human', createdAt: NOW.toISOString(),
      activeAt: new Date(NOW.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.addressDelayMs).toISOString(), state: 'pending',
    });
    expect(store.setInputs[0]).toMatchObject({
      agentId: AGENT_ID, ownerUserId: USER, address: proof.address, proofKind: 'signed', message: proof.messageToSign,
      signature: proof.signature, challengeNonce: proof.nonce, setBy: 'human', setByAgentId: null,
    });
    expect(store.setInputs[0]!.activeAt.getTime()).toBe(NOW.getTime() + 24 * 60 * 60_000);
    // The view never carries the message, the signature or the owner id.
    expect(text).not.toContain(proof.signature);
    expect(text).not.toContain(USER);
    expect(text).not.toContain('message');
    // The nonce works once: the same proof again answers 401 invalid_challenge.
    const reused = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature });
    expect(reused.status).toBe(401);
    expect(await jsonOf(reused)).toMatchObject({ code: 'invalid_challenge' });
    expect(store.setInputs).toHaveLength(1);
  });

  test('a bad signature answers 400 invalid_signature and still spends the nonce (consumed first)', async () => {
    const { call, store } = app();
    const proof = await signedProof(call);
    const wrongKey = bs58.encode(nacl.sign.detached(new TextEncoder().encode(proof.messageToSign), nacl.sign.keyPair().secretKey));
    const bad = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: wrongKey });
    expect(bad.status).toBe(400);
    expect(await jsonOf(bad)).toMatchObject({ code: 'invalid_signature' });
    expect(store.challenges.get(proof.nonce)!.consumed).toBe(true);
    const retry = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature });
    expect(retry.status).toBe(401);
    expect(store.setInputs).toHaveLength(0);
    // Malformed signature text (not base58, or not 64 bytes) is invalid_signature too.
    for (const signature of ['0'.repeat(88), bs58.encode(new Uint8Array(63).fill(1)).padEnd(84, '1')]) {
      const next = await signedProof(call);
      const response = await call('POST', '/me/withdraw-address', { proof: 'signed', address: next.address, nonce: next.nonce, signature });
      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toMatchObject({ code: 'invalid_signature' });
    }
    expect(store.setInputs).toHaveLength(0);
  });

  test('domain separation: a signature over buildWalletLinkMessage(userId, nonce) answers 400 invalid_signature', async () => {
    const { call, store } = app();
    const proof = await signedProof(call);
    const linkSignature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(buildWalletLinkMessage(USER, proof.nonce)), proof.keyPair.secretKey));
    const response = await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: linkSignature });
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({ code: 'invalid_signature' });
    expect(store.setInputs).toHaveLength(0);
  });

  test('a nonce bound to another address, an off-curve address, an arena wallet and the same address are refused', async () => {
    const { call, store } = app();
    const proof = await signedProof(call);
    const otherKey = nacl.sign.keyPair();
    const otherAddress = bs58.encode(otherKey.publicKey);
    const otherSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(proof.messageToSign), otherKey.secretKey));
    const swapped = await call('POST', '/me/withdraw-address', { proof: 'signed', address: otherAddress, nonce: proof.nonce, signature: otherSig });
    expect(swapped.status).toBe(401);
    expect(await jsonOf(swapped)).toMatchObject({ code: 'invalid_challenge' });
    const offCurve = await call('POST', '/me/withdraw-address', { proof: 'signed', address: offCurveAddress(), nonce: proof.nonce, signature: proof.signature });
    expect(offCurve.status).toBe(400);
    expect(await jsonOf(offCurve)).toMatchObject({ code: 'invalid_address' });
    const arena = await call('POST', '/me/withdraw-address', { proof: 'signed', address: SOURCE_WALLET, nonce: proof.nonce, signature: proof.signature });
    expect(arena.status).toBe(400);
    expect(await jsonOf(arena)).toMatchObject({ code: 'address_not_allowed' });
    // The original challenge still works (nothing above consumed it), then the same address again is 409.
    expect((await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature })).status).toBe(201);
    const again = await signedProof(call, proof.keyPair);
    const same = await call('POST', '/me/withdraw-address', { proof: 'signed', address: again.address, nonce: again.nonce, signature: again.signature });
    expect(same.status).toBe(409);
    expect(await jsonOf(same)).toMatchObject({ code: 'same_address' });
    expect(store.addresses.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });
});

describe('POST /me/withdraw-address (linked_wallet)', () => {
  test('a wallet linked more than 24 h ago is active now; a younger one waits 24 h; none is 404', async () => {
    const { call, store } = app();
    const none = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    expect(none.status).toBe(404);
    expect(await jsonOf(none)).toMatchObject({ code: 'no_linked_wallet' });
    const old = bs58.encode(nacl.sign.keyPair().publicKey);
    store.linked.set(USER, { address: old, linkedAt: new Date(NOW.getTime() - DAY) });
    const active = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    expect(active.status).toBe(201);
    expect((await jsonOf(active)).address).toMatchObject({ address: old, proof: 'linked_wallet', activeAt: NOW.toISOString(), state: 'active' });
    expect(store.setInputs[0]).toMatchObject({ proofKind: 'linked_wallet', message: null, signature: null, challengeNonce: null, setBy: 'human' });
    const young = bs58.encode(nacl.sign.keyPair().publicKey);
    store.linked.set(USER, { address: young, linkedAt: new Date(NOW.getTime() - DAY + 1) });
    const pending = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' }, { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(pending.status).toBe(201);
    expect((await jsonOf(pending)).address).toMatchObject({
      address: young, setBy: 'agent', state: 'pending', activeAt: new Date(NOW.getTime() + DAY).toISOString(),
    });
    expect(store.setInputs[1]).toMatchObject({ setBy: 'agent', setByAgentId: BOT_ID });
    // The new address replaced the old one.
    expect(store.addresses.find((row) => row.address === old)!.revokeReason).toBe('replaced');
    const same = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    expect(same.status).toBe(409);
    expect(await jsonOf(same)).toMatchObject({ code: 'same_address' });
    store.linked.set(USER, { address: SOURCE_WALLET, linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    const arena = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    expect(arena.status).toBe(400);
    expect(await jsonOf(arena)).toMatchObject({ code: 'address_not_allowed' });
  });
});

describe('POST /me/withdraw-address (clock)', () => {
  test('regression (real-DB smoke): the 201 view reads the state with a clock taken AFTER the write', async () => {
    // The query stores GREATEST(activeAt, the DB's now()), a few ms after the handler's start time,
    // so a linked wallet that is "active at once" must not read pending in the 201 body.
    const { call, store, deps } = app();
    let clock = NOW.getTime();
    deps.now = () => new Date(clock++);
    const realSet = deps.setWithdrawAddress;
    deps.setWithdrawAddress = async (input) => {
      clock += 5; // the write (and the DB's now()) happens later than the handler's first clock read
      const result = await realSet({ ...input, activeAt: new Date(Math.max(input.activeAt.getTime(), clock)) });
      return result;
    };
    store.linked.set(USER, { address: bs58.encode(nacl.sign.keyPair().publicKey), linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    const response = await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    expect(response.status).toBe(201);
    expect((await jsonOf(response)).address).toMatchObject({ state: 'active' });
  });
});

describe('POST /me/withdraw-address/revoke', () => {
  test('revokes at once; a second revoke is 409; an unknown id is 404', async () => {
    const { call, store } = app();
    store.linked.set(USER, { address: bs58.encode(nacl.sign.keyPair().publicKey), linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    const id = store.addresses[0]!.id;
    const ok = await call('POST', '/me/withdraw-address/revoke', { addressId: id });
    expect(ok.status).toBe(200);
    expect(await jsonOf(ok)).toEqual({ ok: true });
    expect(store.addresses[0]!.revokeReason).toBe('owner');
    const twice = await call('POST', '/me/withdraw-address/revoke', { addressId: id });
    expect(twice.status).toBe(409);
    expect(await jsonOf(twice)).toMatchObject({ code: 'already_revoked' });
    const unknown = await call('POST', '/me/withdraw-address/revoke', { addressId: UNKNOWN_ID });
    expect(unknown.status).toBe(404);
    expect(await jsonOf(unknown)).toMatchObject({ code: 'address_not_found' });
    expect((await call('POST', '/me/withdraw-address/revoke', { addressId: 'not-a-uuid' })).status).toBe(400);
  });
});

describe('POST /me/withdrawals', () => {
  test('needs a valid Idempotency-Key header', async () => {
    const { call, store } = app();
    const missing = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '1' });
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toMatchObject({ code: 'idempotency_key_required' });
    for (const key of ['short', 'has space key', 'x'.repeat(65), 'bad!chars!']) {
      const bad = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '1' }, { 'x-test-user': USER, 'Idempotency-Key': key });
      expect(bad.status).toBe(400);
      expect(await jsonOf(bad)).toMatchObject({ code: 'idempotency_key_invalid' });
    }
    expect(store.requests).toHaveLength(0);
  });

  test('parses the decimal string exactly (no float), refuses extra decimals, zero, int64 overflow and below-minimum', async () => {
    const { call, store } = app();
    const key = (n: number) => ({ 'x-test-user': USER, 'Idempotency-Key': `amount-key-${n}` });
    const invalid: Array<[string, string]> = [
      ['USDC', '0.1234567'], ['USDC', '0'], ['USDC', '0.000000'], ['SOL', '0.0'],
      // 12 integer digits x 1e9 lamports overflows int64 (2^63-1 = 9223372036854775807).
      ['SOL', '999999999999.999999999'], ['SOL', '9223372036.854775808'],
    ];
    let n = 0;
    for (const [asset, amount] of invalid) {
      const response = await call('POST', '/me/withdrawals', { asset, amount }, key(n++));
      expect({ asset, amount, status: response.status }).toEqual({ asset, amount, status: 400 });
      expect(await jsonOf(response)).toMatchObject({ code: 'invalid_amount' });
    }
    for (const [asset, amount] of [['USDC', '0.09'], ['USDC', '0.099999'], ['SOL', '0.000999999']] as const) {
      const response = await call('POST', '/me/withdrawals', { asset, amount }, key(n++));
      expect({ asset, amount, status: response.status }).toEqual({ asset, amount, status: 400 });
      expect(await jsonOf(response)).toMatchObject({ code: 'below_minimum' });
    }
    expect(store.requests).toHaveLength(0);
    // Exact atomic values reach the query; the int64 maximum itself passes the route.
    const ok: Array<[string, string, bigint | null, string]> = [
      ['USDC', '0.1', 100_000n, 'exact'], ['USDC', '0.10', 100_000n, 'exact'], ['USDC', '123.456789', 123_456_789n, 'exact'],
      ['SOL', '0.001', 1_000_000n, 'exact'], ['SOL', '1.5', 1_500_000_000n, 'exact'],
      ['SOL', '9223372036.854775807', 9_223_372_036_854_775_807n, 'exact'], ['USDC', 'max', null, 'max'],
    ];
    for (const [asset, amount, atomic, mode] of ok) {
      store.refuseNext = { kind: 'refused', code: 'withdrawal_open' };
      await call('POST', '/me/withdrawals', { asset, amount }, key(n++));
      expect(store.requests[store.requests.length - 1]).toMatchObject({ asset, amountMode: mode, requestedAtomic: atomic });
    }
  });

  test('created 202, replay 200 with the same id, conflict 409 with withdrawalId', async () => {
    const { call, store } = app();
    const headers = { 'x-test-user': USER, 'Idempotency-Key': 'same-key-0001' };
    const created = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '2.5' }, headers);
    expect(created.status).toBe(202);
    const createdText = await created.text();
    const first = (JSON.parse(createdText) as { withdrawal: Record<string, unknown> }).withdrawal;
    expect(first).toMatchObject({ asset: 'USDC', amountMode: 'exact', amount: '2.5', state: 'requested', subjectKind: 'human' });
    expect(Object.keys(first).sort()).toEqual(['amount', 'amountMode', 'asset', 'destination', 'dispatchedAt', 'errorCode', 'finalizedAt',
      'id', 'requestedAt', 'state', 'subjectKind', 'txSignature']);
    expect(createdText).not.toContain('same-key-0001');
    expect(createdText).not.toContain(USER);
    expect(store.requests[0]).toMatchObject({ idempotencyKey: 'same-key-0001', now: NOW });
    const replay = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '2.50' }, headers);
    expect(replay.status).toBe(200);
    const replayBody = await jsonOf(replay);
    expect(replayBody.replay).toBe(true);
    expect((replayBody.withdrawal as { id: string }).id).toBe(String(first.id));
    const conflict = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '3' }, headers);
    expect(conflict.status).toBe(409);
    expect(await jsonOf(conflict)).toMatchObject({ code: 'idempotency_conflict', withdrawalId: first.id });
    // A max row shows amount null until the leader fixes it, then the atomic amount.
    store.withdrawals[0]!.state = 'confirmed';
    const max = await call('POST', '/me/withdrawals', { asset: 'SOL', amount: 'max' }, { 'x-test-user': USER, 'Idempotency-Key': 'max-key-00001' });
    expect(max.status).toBe(202);
    expect((await jsonOf(max)).withdrawal).toMatchObject({ amountMode: 'max', amount: null });
    store.withdrawals[0]!.amountAtomic = 1_234_000_000n;
    const listed = await jsonOf(await call('GET', '/me/withdrawals'));
    expect((listed.withdrawals as Array<{ amount: string | null }>)[0]!.amount).toBe('1.234');
  });

  test('every request refusal code answers its status and its fields', async () => {
    const { call, store } = app();
    const retryAt = new Date(NOW.getTime() + 600_000);
    const activeAt = new Date(NOW.getTime() + DAY);
    const expected: Record<(typeof FLOOR_ARENA_WITHDRAW_REQUEST_CODES)[number], [number, Record<string, unknown>]> = {
      idempotency_conflict: [409, { withdrawalId: UNKNOWN_ID }],
      wallet_not_ready: [409, {}],
      no_withdraw_address: [409, {}],
      address_pending: [409, { activeAt: activeAt.toISOString() }],
      withdrawal_open: [409, { withdrawalId: UNKNOWN_ID }],
      cooldown: [429, { retryAt: retryAt.toISOString() }],
      daily_count_cap: [429, { retryAt: retryAt.toISOString() }],
      agent_daily_cap: [409, {}],
      invalid_amount: [400, {}],
      below_minimum: [400, {}],
    };
    expect(Object.keys(expected).sort()).toEqual([...FLOOR_ARENA_WITHDRAW_REQUEST_CODES].sort());
    let n = 0;
    for (const [code, [status, fields]] of Object.entries(expected)) {
      store.refuseNext = { kind: 'refused', code: code as (typeof FLOOR_ARENA_WITHDRAW_REQUEST_CODES)[number],
        ...(fields.retryAt ? { retryAt } : {}), ...(fields.activeAt ? { activeAt } : {}), ...(fields.withdrawalId ? { withdrawalId: UNKNOWN_ID } : {}) };
      const response = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '1' }, { 'x-test-user': USER, 'Idempotency-Key': `refuse-key-${n++}` });
      expect({ code, status: response.status }).toEqual({ code, status });
      const body = await jsonOf(response);
      expect(body).toMatchObject({ code, ...fields });
      expect(typeof body.error).toBe('string');
    }
    store.agent = null;
    const none = await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '1' }, { 'x-test-user': USER, 'Idempotency-Key': 'no-agent-key-1' });
    expect(none.status).toBe(404);
    expect(await jsonOf(none)).toMatchObject({ code: 'no_agent' });
  });
});

describe('GET /me/withdrawals and cancel', () => {
  test('returns the address, the linked wallet, the rows, every limit and the wallet; limit 1..50, default 20', async () => {
    const { call, store } = app();
    const linked = bs58.encode(nacl.sign.keyPair().publicKey);
    store.linked.set(USER, { address: linked, linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    store.withdrawals.push(withdrawalRow({ asset: 'SOL', requestedAtomic: 2_000_000n, amountAtomic: 2_000_000n, state: 'sent', txSignature: 'SigSig',
      dispatchedAt: NOW, idempotencyKey: 'hidden-key-001' }));
    const response = await call('GET', '/me/withdrawals');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['address', 'agentId', 'limits', 'linkedWallet', 'wallet', 'withdrawals']);
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.address).toMatchObject({ address: linked, proof: 'linked_wallet', state: 'active' });
    expect(body.linkedWallet).toEqual({ address: linked, linkedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), activeNow: true });
    expect(body.limits).toEqual(JSON.parse(JSON.stringify(FLOOR_ARENA_WITHDRAW_LIMITS)));
    for (const field of ['minUsdcAtomic', 'minSolLamports', 'agentDailyRequests', 'agentDailyUsdcAtomic', 'cooldownMs', 'addressDelayMs', 'solKeepLamports']) {
      expect(typeof (body.limits as Record<string, unknown>)[field]).toBe('number');
    }
    expect((body.limits as Record<string, unknown>).recommendedSolText).toBe('0.01');
    expect(body.wallet).toEqual({ address: SOURCE_WALLET, usdc: 1.5, sol: 0.012, updatedAt: NOW.toISOString() });
    expect(body.withdrawals).toEqual([{
      id: store.withdrawals[0]!.id, asset: 'SOL', amountMode: 'exact', amount: '0.002', destination: store.withdrawals[0]!.destination,
      state: 'sent', errorCode: null, txSignature: 'SigSig', subjectKind: 'human', requestedAt: NOW.toISOString(),
      dispatchedAt: NOW.toISOString(), finalizedAt: null,
    }]);
    expect(text).not.toContain('hidden-key-001');
    expect(text).not.toContain(USER);
    expect(store.listLimits).toEqual([20]);
    await call('GET', '/me/withdrawals?limit=10');
    expect(store.listLimits).toEqual([20, 10]);
    for (const limit of ['0', '51', 'x']) {
      const bad = await call('GET', `/me/withdrawals?limit=${limit}`);
      expect(bad.status).toBe(400);
      expect(await jsonOf(bad)).toMatchObject({ code: 'invalid_query' });
    }
    // A young linked wallet reads activeNow false; none reads null.
    store.linked.set(USER, { address: linked, linkedAt: NOW });
    expect((await jsonOf(await call('GET', '/me/withdrawals'))).linkedWallet).toMatchObject({ activeNow: false });
    store.linked.clear();
    expect((await jsonOf(await call('GET', '/me/withdrawals'))).linkedWallet).toBeNull();
  });

  test('cancel: requested -> 200 cancelled; dispatching -> 409; bad or unknown id -> 404', async () => {
    const { call, store } = app();
    const requested = withdrawalRow();
    const dispatching = withdrawalRow({ state: 'dispatching', amountAtomic: 100_000n, dispatchedAt: NOW });
    store.withdrawals.push(requested, dispatching);
    const ok = await call('POST', `/me/withdrawals/${requested.id}/cancel`);
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).withdrawal).toMatchObject({ id: requested.id, state: 'cancelled', finalizedAt: NOW.toISOString() });
    const busy = await call('POST', `/me/withdrawals/${dispatching.id}/cancel`);
    expect(busy.status).toBe(409);
    expect(await jsonOf(busy)).toMatchObject({ code: 'not_cancellable' });
    expect(dispatching.state).toBe('dispatching');
    for (const id of ['not-a-uuid', UNKNOWN_ID]) {
      const missing = await call('POST', `/me/withdrawals/${id}/cancel`);
      expect(missing.status).toBe(404);
      expect(await jsonOf(missing)).toMatchObject({ code: 'withdrawal_not_found' });
    }
  });
});

describe('GET /me and the event streams', () => {
  test('GET /me carries withdraw {address, open}, and withdraw null before launch', async () => {
    const { call, store } = app();
    const before = await jsonOf(await call('GET', '/me'));
    expect(before.withdraw).toEqual({ address: null, open: null });
    store.linked.set(USER, { address: bs58.encode(nacl.sign.keyPair().publicKey), linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' });
    await call('POST', '/me/withdrawals', { asset: 'USDC', amount: '1' }, { 'x-test-user': USER, 'Idempotency-Key': 'me-key-000001' });
    const response = await call('GET', '/me');
    const text = await response.text();
    const me = JSON.parse(text) as { withdraw: { address: Record<string, unknown>; open: Record<string, unknown> } };
    expect(me.withdraw.address).toMatchObject({ proof: 'linked_wallet', state: 'active' });
    expect(me.withdraw.open).toMatchObject({ asset: 'USDC', amount: '1', state: 'requested' });
    expect(text).not.toContain('me-key-000001');
    store.agent = null;
    expect((await jsonOf(await call('GET', '/me'))).withdraw).toBeNull();
  });

  test('a public /agents/:id/events never shows a withdraw event; the owner /me/events does', async () => {
    const { call, routes, store } = app();
    const publicBody = await (await routes.request(`/agents/${AGENT_ID}/events`)).json() as { events: ArenaEvent[] };
    expect(publicBody.events.map((event) => event.type)).toEqual(['entry', 'status']);
    expect(store.eventTypes[0]).not.toBeNull();
    expect(store.eventTypes[0]).not.toContain('withdraw');
    const own = await jsonOf(await call('GET', '/me/events'));
    expect((own.events as ArenaEvent[]).map((event) => event.type)).toContain('withdraw');
  });
});

describe('admin withdraw routes (moneyOperatorOnly)', () => {
  async function admin() {
    const { createAdminArenaWithdrawRoutes } = await import('../admin-floor-arena');
    const marks: Array<[string, string]> = [];
    const lists: Array<{ state: string | null; limit: number }> = [];
    let markResult = true;
    const row = withdrawalRow({ state: 'unknown', amountAtomic: 100_000n, preBalanceAtomic: 5_000_000n, preSolLamports: 9_000_000n,
      dispatchedAt: NOW, txSignature: 'SigX', errorCode: 'timeout' });
    const routes = createAdminArenaWithdrawRoutes({
      listWithdrawals: async (input) => { lists.push(input); return [row]; },
      markNeedsReview: async (id, note) => { marks.push([id, note]); return markResult; },
    });
    const post = async (path: string, body: unknown) =>
      await routes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { routes, post, marks, lists, row, setMark: (value: boolean) => { markResult = value; } };
  }

  test('every admin withdraw route is 401 without a session (same guard as the other operator routes)', async () => {
    const { adminFloorArenaRoutes } = await import('../admin-floor-arena');
    const json = { 'content-type': 'application/json', origin: 'http://localhost' };
    expect((await adminFloorArenaRoutes.request('/withdrawals')).status).toBe(401);
    expect((await adminFloorArenaRoutes.request(`/withdrawals/${UNKNOWN_ID}/needs-review`, {
      method: 'POST', headers: json, body: JSON.stringify({ note: 'x' }),
    })).status).toBe(401);
  });

  test('GET /withdrawals: full records with atomic numbers as strings; state and limit validated', async () => {
    const { routes, lists, row } = await admin();
    const response = await routes.request('/withdrawals?state=unknown&limit=200');
    expect(response.status).toBe(200);
    const body = await response.json() as { withdrawals: Array<Record<string, unknown>> };
    expect(lists).toEqual([{ state: 'unknown', limit: 200 }]);
    expect(body.withdrawals[0]).toMatchObject({
      id: row.id, agentId: AGENT_ID, ownerUserId: USER, state: 'unknown', errorCode: 'timeout', txSignature: 'SigX',
      amountAtomic: '100000', requestedAtomic: '100000', preBalanceAtomic: '5000000', preSolLamports: '9000000', postBalanceAtomic: null,
      dispatchedAt: NOW.toISOString(),
    });
    expect(body.withdrawals[0]).not.toHaveProperty('message');
    expect(body.withdrawals[0]).not.toHaveProperty('signature');
    expect((await routes.request('/withdrawals')).status).toBe(200);
    expect(lists[1]).toEqual({ state: null, limit: 50 });
    for (const query of ['?state=bogus', '?limit=0', '?limit=201', '?limit=x']) {
      const bad = await routes.request(`/withdrawals${query}`);
      expect({ query, status: bad.status }).toEqual({ query, status: 400 });
    }
  });

  test('POST /withdrawals/:id/needs-review: 200 from sent or unknown, 409 otherwise; note 1..280; never sends', async () => {
    const { post, marks, setMark } = await admin();
    const ok = await post(`/withdrawals/${UNKNOWN_ID}/needs-review`, { note: 'Chain shows no transfer; checking.' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(marks).toEqual([[UNKNOWN_ID, 'Chain shows no transfer; checking.']]);
    setMark(false);
    const refused = await post(`/withdrawals/${UNKNOWN_ID}/needs-review`, { note: 'x' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'not_reviewable' });
    for (const body of [{ note: '' }, { note: 'x'.repeat(281) }, { note: 'x', state: 'confirmed' }, {}]) {
      expect((await post(`/withdrawals/${UNKNOWN_ID}/needs-review`, body)).status).toBe(400);
    }
    expect((await post('/withdrawals/not-a-uuid/needs-review', { note: 'x' })).status).toBe(404);
    expect(marks).toHaveLength(2);
  });
});

describe('single writer (I4): no withdraw route reaches ClawPump, the RPC or the network', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  test('every route runs with 0 writer calls and 0 fetch calls', async () => {
    const transfer = spyOn(writer.clawPumpArenaWithdrawWriter, 'transfer');
    const live = spyOn(writer.clawPumpArenaWithdrawWriter, 'readWalletLive');
    const fetchSpy = spyOn(globalThis, 'fetch');
    spies.push(transfer, live, fetchSpy);
    const { call, store } = app();
    store.linked.set(USER, { address: bs58.encode(nacl.sign.keyPair().publicKey), linkedAt: new Date(NOW.getTime() - 2 * DAY) });
    const proof = await signedProof(call);
    expect((await call('POST', '/me/withdraw-address', { proof: 'signed', address: proof.address, nonce: proof.nonce, signature: proof.signature })).status).toBe(201);
    expect((await call('POST', '/me/withdraw-address', { proof: 'linked_wallet' })).status).toBe(201);
    store.addresses[store.addresses.length - 1]!.activeAt = NOW;
    const created = await jsonOf(await call('POST', '/me/withdrawals', { asset: 'USDC', amount: 'max' }, { 'x-test-user': USER, 'Idempotency-Key': 'spy-key-00001' }));
    expect((await call('GET', '/me/withdrawals')).status).toBe(200);
    expect((await call('GET', '/me')).status).toBe(200);
    expect((await call('POST', `/me/withdrawals/${(created.withdrawal as { id: string }).id}/cancel`)).status).toBe(200);
    expect((await call('POST', '/me/withdraw-address/revoke', { addressId: store.addresses[store.addresses.length - 1]!.id })).status).toBe(200);
    expect(transfer).toHaveBeenCalledTimes(0);
    expect(live).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test('the route files name no withdraw writer function and import only pure helpers from the writer module', () => {
    for (const file of ['../floor-arena.ts', '../admin-floor-arena.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\b(transferFromArenaWallet|readArenaWalletLive|clawPumpArenaWithdrawWriter|admitArenaWithdrawal|finalizeArenaWithdrawal|runArenaWithdrawTick)\b/);
      expect(source).not.toMatch(/floor-arena\/withdraw'/);
    }
  });
});
