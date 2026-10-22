/**
 * services/wallet-view-record.ts — the context-free `wallet.viewed` recorder
 * shared by GET /api/wallet/balances and the hosted-agent `view_wallet` verb
 * (2026-10-22 quests wire). Once per avatar, guests and house agents skipped,
 * never throws, retries after a failed write. Leak-guarded mocks.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
const databaseUrlWasSet = !!process.env.DATABASE_URL;
if (!databaseUrlWasSet) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realEventLogger from '../event-logger';
import * as realNonGuest from '../../middleware/require-non-guest';
import * as realHouseBinding from '../autonomous-cove-agent-binding';

let intercept = true;
afterAll(() => {
  intercept = false;
});

const REAL_logReturningId = realEventLogger.logEventReturningId;
const REAL_isGuest = realNonGuest.isGuestUser;
const REAL_isHouse = realHouseBinding.isHouseAgentId;

const viewedInDb = new Set<string>();
const guestUserIds = new Set<string>();
const houseAgentIds = new Set<string>();
let dbFails = false;
let dbChecks = 0;
let loggerMode: 'ok' | 'throw' | 'null' = 'ok';
const logged: realEventLogger.EventInput[] = [];

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  execute: async (query: unknown) => {
    dbChecks += 1;
    if (dbFails) throw new Error('db down');
    const params = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    return params.some((p) => typeof p === 'string' && viewedInDb.has(p)) ? [{ one: 1 }] : [];
  },
};
const DELEGATE_DB = (realDatabase as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (t, p, r) => (intercept ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));
mock.module('../event-logger', () => ({
  ...realEventLogger,
  logEventReturningId: async (input: realEventLogger.EventInput) => {
    if (!intercept) return REAL_logReturningId(input);
    if (loggerMode === 'throw') throw new Error('logger exploded');
    if (loggerMode === 'null') return null;
    logged.push(input);
    if (input.avatarId) viewedInDb.add(input.avatarId);
    return BigInt(logged.length);
  },
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realNonGuest,
  isGuestUser: async (userId: string) => (intercept ? guestUserIds.has(userId) : REAL_isGuest(userId)),
}));
mock.module('../autonomous-cove-agent-binding', () => ({
  ...realHouseBinding,
  isHouseAgentId: async (agentId: string) => (intercept ? houseAgentIds.has(agentId) : REAL_isHouse(agentId)),
}));

const { recordFirstWalletView } = await import('../wallet-view-record');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const human = (avatarId: string) => ({ kind: 'user', userId: `user-${avatarId}`, avatarId, agentId: null });
const viewedFor = (avatarId: string) => logged.filter((e) => e.avatarId === avatarId);

beforeEach(() => {
  logged.length = 0;
  dbFails = false;
  dbChecks = 0;
  loggerMode = 'ok';
});

// The recorder keeps a module-level Set, so every case uses its own avatarId.
describe('recordFirstWalletView', () => {
  it('logs once across two calls, with the given anti-farm tags', async () => {
    const actor = human('a-two');
    await recordFirstWalletView(actor, { fpHash: 'fp-1', ipPrefixHash: 'ip-1' });
    await recordFirstWalletView(actor, { fpHash: 'fp-1', ipPrefixHash: 'ip-1' });
    expect(viewedFor('a-two')).toHaveLength(1);
    expect(viewedFor('a-two')[0]).toMatchObject({
      eventType: 'wallet.viewed',
      userId: 'user-a-two',
      payload: { subjectKind: 'user' },
      fpHash: 'fp-1',
      ipPrefixHash: 'ip-1',
    });
    expect(dbChecks).toBe(1); // the second call is served by the in-process Set
  });

  it('agent actor without ledger authority records nothing, and the refusal is not cached', async () => {
    await recordFirstWalletView({ kind: 'agent', userId: 'owner', avatarId: 'a-noledger', agentId: 'oc-2', ledgerCapable: false });
    await recordFirstWalletView({ kind: 'agent', userId: 'owner', avatarId: 'a-noledger', agentId: 'oc-2' });
    expect(viewedFor('a-noledger')).toHaveLength(0);
    // Authority granted later: the same avatar now records its first view.
    await recordFirstWalletView({ kind: 'agent', userId: 'owner', avatarId: 'a-noledger', agentId: 'oc-2', ledgerCapable: true });
    expect(viewedFor('a-noledger')).toHaveLength(1);
  });

  it('agent actor with no meta (the executor path): logs against the bound avatar, untagged', async () => {
    await recordFirstWalletView({ kind: 'agent', userId: 'owner', avatarId: 'a-agent', agentId: 'oc-1', ledgerCapable: true });
    expect(viewedFor('a-agent')).toHaveLength(1);
    expect(viewedFor('a-agent')[0]).toMatchObject({
      userId: 'owner',
      payload: { subjectKind: 'agent' },
      fpHash: null,
      ipPrefixHash: null,
    });
  });

  it('does not log again when the events table already has a row', async () => {
    viewedInDb.add('a-existing');
    await recordFirstWalletView(human('a-existing'));
    expect(dbChecks).toBe(1);
    expect(viewedFor('a-existing')).toHaveLength(0);
  });

  it('never throws when the logger throws, and retries on a later call', async () => {
    loggerMode = 'throw';
    await expect(recordFirstWalletView(human('a-throw'))).resolves.toBeUndefined();
    expect(viewedFor('a-throw')).toHaveLength(0);
    loggerMode = 'ok';
    await recordFirstWalletView(human('a-throw'));
    expect(viewedFor('a-throw')).toHaveLength(1);
  });

  it('never throws when the existence check throws', async () => {
    dbFails = true;
    await expect(recordFirstWalletView(human('a-dbdown'))).resolves.toBeUndefined();
    expect(viewedFor('a-dbdown')).toHaveLength(0);
  });

  it('retries when the insert fell back to the failure table', async () => {
    loggerMode = 'null';
    await recordFirstWalletView(human('a-null'));
    loggerMode = 'ok';
    await recordFirstWalletView(human('a-null'));
    expect(viewedFor('a-null')).toHaveLength(1);
    expect(dbChecks).toBe(2);
  });

  it('skips a guest user, a guest kind, and a house agent with no DB check', async () => {
    guestUserIds.add('user-a-guest');
    await recordFirstWalletView(human('a-guest'));
    await recordFirstWalletView({ kind: 'guest', userId: 'g', avatarId: 'a-guest-kind' });
    houseAgentIds.add('house-dealer');
    await recordFirstWalletView({ kind: 'agent', userId: 'h', avatarId: 'a-house', agentId: 'house-dealer', ledgerCapable: true });
    expect(dbChecks).toBe(0);
    expect(logged).toHaveLength(0);
  });
});
