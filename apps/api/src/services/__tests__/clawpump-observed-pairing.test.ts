import { describe, expect, test } from 'bun:test';
import { agentBots, avatars, clawpumpAgentLinks, tradingWallets, users } from '@clawville/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ClawPumpClientError, getClawPumpAgent, listClawPumpAgents, type ClawPumpAgent, type ClawPumpAgentReader } from '../clawpump-client';
import { identityFingerprint } from '../identity-service';
import {
  classifyObservedPairState,
  listObservedClawPumpAgents,
  observedAvatarName,
  pairObservedClawPumpAgent,
  provisionObservedClawPumpAccount,
  readOwnedClawPumpAgent,
  unpairObservedClawPumpAgent,
  type TradingProvisioningDependencies,
} from '../trading-provisioning';

const USER = '11111111-1111-4111-8111-111111111111';
const AVATAR = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const GENESIS = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
const WALLET = '4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n';
const input = { avatarId: AVATAR, clawpumpAgentId: GENESIS, objective: 'momentum-board' as const };
const agent: ClawPumpAgent = { id: GENESIS, name: 'Genesis', userId: USER, status: 'running', walletAddress: WALLET };
const dialect = new PgDialect();
type PairState = Parameters<typeof classifyObservedPairState>[0];

function walletRow(): PairState['wallets'][number] & { boundSlot: number } {
  return {
    avatarId: AVATAR, agentId: AGENT, pubkey: WALLET, source: 'clawpump',
    subjectKind: 'agent', operatedByClawville: false, metadata: { clawpumpAgentId: GENESIS }, boundSlot: 101,
  };
}

function linkRow(): PairState['links'][number] {
  return { ...input, walletPubkey: WALLET, operatedByClawville: false, armed: false };
}

function reader(overrides: Partial<ClawPumpAgentReader> = {}): ClawPumpAgentReader {
  return { listAgents: async () => [agent], getAgent: async () => agent, ...overrides };
}

function state() {
  return {
    order: [] as string[], locks: [] as unknown[], inserts: [] as Record<string, unknown>[],
    updates: [] as { table: unknown; values: Record<string, unknown>; predicate: ReturnType<PgDialect['sqlToQuery']> }[],
    deletes: [] as ReturnType<PgDialect['sqlToQuery']>[],
    wallets: [] as PairState['wallets'], links: [] as PairState['links'],
    fingerprint: identityFingerprint('clawpump-observed', GENESIS), guest: false,
    avatar: { id: AVATAR, userId: USER, platformAgentId: AGENT as string | null },
    lockedAvatar: undefined as { id: string; userId: string; platformAgentId: string | null } | undefined,
    missingAvatar: false, bot: true, created: true, transactionCount: 0,
    insertError: undefined as unknown, revoked: [] as { pubkey: string }[],
    identityCalls: [] as unknown[], provisionCalls: [] as unknown[], hostedCalls: [] as string[],
    bindCalls: [] as Parameters<TradingProvisioningDependencies['bindClawPumpWallet']>[0][],
    tx: undefined as unknown,
  };
}
type State = ReturnType<typeof state>;

function dependencies(s: State): TradingProvisioningDependencies {
  function select(inTransaction: boolean) {
    return { from: (table: unknown) => ({ where: () => {
      const rows = () => {
        if (table === avatars) return s.missingAvatar ? [] : [inTransaction ? s.lockedAvatar ?? s.avatar : s.avatar];
        if (table === users) return [{ fingerprint: s.fingerprint, isGuest: s.guest }];
        if (table === agentBots) return s.bot ? [{ agentId: AGENT }] : [];
        if (table === tradingWallets) return s.wallets;
        if (table === clawpumpAgentLinks) return s.links;
        throw new Error('Unexpected table');
      };
      const terminal = { limit: async () => rows() };
      return { ...terminal, for: () => terminal };
    } }) };
  }
  const update = (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (predicate: SQL) => ({
    returning: async () => {
      s.updates.push({ table, values, predicate: dialect.sqlToQuery(predicate) });
      return table === agentBots ? [{ agentId: AGENT }] : s.revoked;
    },
  }) }) });
  const tx = {
    execute: async (query: SQL) => { s.locks.push(...dialect.sqlToQuery(query).params); },
    select: () => select(true), update,
    insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => {
      expect(table).toBe(clawpumpAgentLinks);
      if (s.insertError) throw s.insertError;
      s.inserts.push(values);
    } }),
    delete: (table: unknown) => ({ where: async (predicate: SQL) => {
      expect(table).toBe(clawpumpAgentLinks);
      s.deletes.push(dialect.sqlToQuery(predicate));
    } }),
  };
  s.tx = tx;
  return {
    database: {
      select: () => select(false), update,
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
        s.transactionCount++;
        s.order.push('transaction');
        return callback(tx);
      },
    },
    resolveIdentity: async (type: string, id: string) => {
      s.identityCalls.push([type, id]);
      return { id: USER, identityFingerprint: s.fingerprint };
    },
    provisionAvatar: async (userId: string, params: unknown, options: unknown) => {
      s.provisionCalls.push({ userId, params, options });
      return { created: s.created, avatar: { id: AVATAR, name: 'Genesis', platformAgentId: AGENT }, agentId: AGENT };
    },
    ensureHostedSession: async (agentId: string) => { s.hostedCalls.push(agentId); return { agentId }; },
    readBindSlot: async () => { s.order.push('slot'); return 123; },
    bindClawPumpWallet: async (request: Parameters<TradingProvisioningDependencies['bindClawPumpWallet']>[0]) => {
      s.bindCalls.push(request);
      return { ...walletRow(), boundSlot: request.boundSlot };
    },
    activateAutonomy: async () => { throw new Error('Autonomy must stay inactive'); },
    bindCustodialWallet: async () => { throw new Error('No custodial wallet'); },
  } as unknown as TradingProvisioningDependencies;
}

describe('ClawPump ownership proof', () => {
  test('requires list membership before reading the public agent', async () => {
    let gets = 0;
    await expect(readOwnedClawPumpAgent(GENESIS, reader({ listAgents: async () => [], getAgent: async () => { gets++; return agent; } })))
      .rejects.toMatchObject({ code: 'clawpump_agent_not_owned', status: 404 });
    expect(gets).toBe(0);
  });

  test.each([
    [{ walletAddress: '11111111111111111111111111111111' }, 'agent_has_no_wallet', 409],
    [{ userId: 'another-owner' }, 'clawpump_agent_not_owned', 404],
    [{ id: AGENT }, 'clawpump_agent_not_owned', 404],
  ] as const)('rejects disagreeing detail fields %j', async (change, code, status) => {
    await expect(readOwnedClawPumpAgent(GENESIS, reader({ getAgent: async () => ({ ...agent, ...change }) })))
      .rejects.toMatchObject({ code, status });
  });

  test.each([null, '', 'invalid!'])('rejects invalid wallet %j', async (walletAddress) => {
    const invalid = { ...agent, walletAddress };
    await expect(readOwnedClawPumpAgent(GENESIS, reader({ listAgents: async () => [invalid], getAgent: async () => invalid })))
      .rejects.toMatchObject({ code: 'agent_has_no_wallet', status: 409 });
  });

  test.each([
    ['not_configured', 'clawpump_not_configured', 503],
    ['invalid_base_url', 'clawpump_not_configured', 503],
    ['unauthorized', 'clawpump_unavailable', 503],
    ['timeout', 'clawpump_unavailable', 503],
    ['schema_invalid', 'clawpump_unavailable', 503],
    ['not_found', 'clawpump_agent_not_owned', 404],
  ] as const)('maps %s to a stable service error', async (failure, code, status) => {
    await expect(readOwnedClawPumpAgent(GENESIS, reader({ listAgents: async () => { throw new ClawPumpClientError(failure, 401); } })))
      .rejects.toMatchObject({ code, status });
  });

  test('never forwards unexpected provider error details', async () => {
    await expect(readOwnedClawPumpAgent(GENESIS, reader({ listAgents: async () => { throw new Error('private provider body'); } })))
      .rejects.toMatchObject({ code: 'clawpump_unavailable', message: 'The ClawPump read failed.' });
  });

  test('maps a real client detail ID mismatch to ownership refusal', async () => {
    const wire = { id: GENESIS, user_id: USER, wallet_address: WALLET, name: 'Genesis' };
    const paths: string[] = [];
    const options = {
      env: { CLAWPUMP_API_KEY: 'synthetic-test-key' },
      fetchImpl: (async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return Response.json(path === '/agents' ? [wire] : { ...wire, id: AGENT });
      }) as typeof fetch,
    };
    await expect(readOwnedClawPumpAgent(GENESIS, {
      listAgents: () => listClawPumpAgents(options),
      getAgent: (agentId) => getClawPumpAgent(agentId, options),
    })).rejects.toMatchObject({ code: 'clawpump_agent_not_owned', status: 404 });
    expect(paths).toEqual(['/agents', `/agents/${GENESIS}`]);
  });
});

describe('observed service account', () => {
  test.each([true, false])('provisions or reuses without custody or autonomy, created=%s', async (created) => {
    const s = state();
    s.created = created;
    const result = await provisionObservedClawPumpAccount({ clawpumpAgentId: GENESIS }, dependencies(s), reader());
    expect(s.identityCalls).toEqual([['clawpump-observed', GENESIS]]);
    expect(s.provisionCalls).toEqual([{
      userId: USER, params: expect.objectContaining({ name: 'Genesis' }),
      options: { onNameCollision: 'suffix-retry', wallet: 'skip', initialEconomy: 'zero', skipIfAvatarExists: true },
    }]);
    expect(s.hostedCalls).toEqual([AGENT]);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]?.table).toBe(agentBots);
    expect(s.updates[0]?.values).toEqual({ leaderboardEligible: true, isHouse: false, updatedAt: expect.any(Date) });
    expect(s.inserts).toHaveLength(0);
    expect(result).toEqual({ ok: true, created, userId: USER, avatarId: AVATAR, avatarName: 'Genesis', clawvilleAgentId: AGENT, clawpumpAgentId: GENESIS, walletPubkey: WALLET });
  });

  test.each([
    ['Genesis', 'Genesis'], ['Ge', 'ClawPumpTrader'], ['Genesis Runner!!', 'GenesisRunner'],
    ['a'.repeat(30), 'a'.repeat(20)], [null, 'ClawPumpTrader'],
  ])('sanitizes avatar name %j', (name, expected) => { expect(observedAvatarName(name)).toBe(expected); });
});

describe('observed pair state', () => {
  const classify = (wallets: PairState['wallets'], links: PairState['links']) => classifyObservedPairState({
    ...input, agentId: AGENT, walletPubkey: WALLET, wallets, links,
  });
  test('accepts only an empty state or an exact row pair', () => {
    expect(classify([], [])).toBe('fresh');
    expect(classify([walletRow()], [linkRow()])).toBe('replay');
    expect(classify([walletRow()], [{ ...linkRow(), objective: 'conservative-rebalancer' }])).toBe('conflict');
    expect(classify([walletRow()], [])).toBe('conflict');
    expect(classify([], [linkRow()])).toBe('conflict');
    expect(classify([walletRow()], [{ ...linkRow(), operatedByClawville: true }])).toBe('conflict');
    expect(classify([{ ...walletRow(), avatarId: USER }], [linkRow()])).toBe('conflict');
    expect(classify([walletRow(), walletRow()], [linkRow()])).toBe('conflict');
    expect(classify([walletRow()], [{ ...linkRow(), armed: Boolean(1) }])).toBe('conflict');
    expect(classify([{ ...walletRow(), metadata: {} }], [linkRow()])).toBe('conflict');
  });
});

describe('observed pair transaction', () => {
  test('reads providers before ordered locks and atomically binds a disabled zero-float link', async () => {
    const s = state();
    const client = reader({
      listAgents: async () => { s.order.push('list'); return [agent]; },
      getAgent: async () => { s.order.push('detail'); return agent; },
    });
    const result = await pairObservedClawPumpAgent(input, dependencies(s), client);
    expect(s.order).toEqual(['list', 'detail', 'slot', 'transaction']);
    expect(s.locks).toEqual([`trading-clawpump:${GENESIS}`, `trading-bind:${AVATAR}`]);
    expect(s.bindCalls).toHaveLength(1);
    expect(s.bindCalls[0]).toMatchObject({ operatedByClawville: false, boundSlot: 123, tx: s.tx,
      subject: { kind: 'agent', userId: USER, avatarId: AVATAR, agentId: AGENT } });
    expect(s.inserts).toEqual([{
      avatarId: AVATAR, userId: USER, clawvilleAgentId: AGENT, clawpumpAgentId: GENESIS,
      walletPubkey: WALLET, objective: input.objective, armed: false, killed: true,
      operatedByClawville: false, floatStartLamports: '0', floatStartUsdMicros: '0', baselineSlot: null, baselineEvidence: null,
    }]);
    expect(result).toMatchObject({ replayed: false, boundSlot: 123, operatedByClawville: false });
  });

  test.each(['fleet', 'guest'])('refuses %s ownership before any transaction', async (kind) => {
    const s = state();
    if (kind === 'fleet') s.fingerprint = identityFingerprint('clawville-fleet', 'trading-floor-slot-1');
    else s.guest = true;
    await expect(pairObservedClawPumpAgent(input, dependencies(s), reader()))
      .rejects.toMatchObject({ code: 'avatar_not_observed_account', status: 409 });
    expect(s.transactionCount).toBe(0);
    expect(s.order).not.toContain('slot');
  });

  test.each(['avatar', 'platformAgent', 'bot'])('refuses missing %s', async (missing) => {
    const s = state();
    if (missing === 'avatar') s.missingAvatar = true;
    if (missing === 'platformAgent') s.avatar.platformAgentId = null;
    if (missing === 'bot') s.bot = false;
    await expect(pairObservedClawPumpAgent(input, dependencies(s), reader())).rejects.toMatchObject({
      code: missing === 'avatar' ? 'avatar_not_found' : 'no_bound_clawville_agent', status: missing === 'avatar' ? 404 : 400,
    });
    expect(s.transactionCount).toBe(0);
  });

  test('refuses subject changes under lock', async () => {
    const s = state();
    s.lockedAvatar = { ...s.avatar, userId: AGENT };
    await expect(pairObservedClawPumpAgent(input, dependencies(s), reader()))
      .rejects.toMatchObject({ code: 'ownership_proof_invalid', status: 409 });
    expect(s.bindCalls).toHaveLength(0);
  });

  test('replays without writes and preserves the original bind slot', async () => {
    const s = state();
    s.wallets = [walletRow()];
    s.links = [linkRow()];
    expect(await pairObservedClawPumpAgent(input, dependencies(s), reader())).toMatchObject({ replayed: true, boundSlot: 101 });
    expect(s.bindCalls).toHaveLength(0);
    expect(s.inserts).toHaveLength(0);
  });

  test('rejects partial pairs instead of repairing them', async () => {
    const s = state();
    s.wallets = [walletRow()];
    await expect(pairObservedClawPumpAgent(input, dependencies(s), reader())).rejects.toMatchObject({ code: 'already_linked', status: 409 });
    expect(s.bindCalls).toHaveLength(0);
  });

  test.each([{ code: '23505' }, { cause: { code: '23505' } }])('maps a unique violation to conflict', async (failure) => {
    const s = state();
    s.insertError = failure;
    await expect(pairObservedClawPumpAgent(input, dependencies(s), reader())).rejects.toMatchObject({ code: 'already_linked', status: 409 });
  });
});

describe('observed unpair and list', () => {
  test('revokes the wallet and deletes only the observe-only link with the same lock order', async () => {
    const s = state();
    s.links = [linkRow()];
    s.revoked = [{ pubkey: WALLET }];
    expect(await unpairObservedClawPumpAgent(input, dependencies(s))).toMatchObject({ alreadyUnpaired: false, walletPubkey: WALLET });
    expect(s.locks).toEqual([`trading-clawpump:${GENESIS}`, `trading-bind:${AVATAR}`]);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]?.table).toBe(tradingWallets);
    expect(s.updates[0]?.values).toMatchObject({ revokedAt: expect.any(Date), updatedAt: expect.any(Date) });
    expect(s.updates[0]?.predicate.params).toEqual([AVATAR, 'clawpump', false, GENESIS]);
    expect(s.updates[0]?.predicate.sql).toContain('"revoked_at" is null');
    expect(s.deletes).toHaveLength(1);
    expect(s.deletes[0]?.params).toEqual([AVATAR, GENESIS, false, false]);
    expect(s.deletes[0]?.sql).toContain('"operated_by_clawville"');
    expect(s.deletes[0]?.sql).toContain('"armed"');
  });

  test('reports an absent pair as already unpaired', async () => {
    const s = state();
    expect(await unpairObservedClawPumpAgent(input, dependencies(s))).toMatchObject({ alreadyUnpaired: true, walletPubkey: null });
    expect(s.deletes).toHaveLength(0);
  });

  test('revokes an orphan wallet without a link', async () => {
    const s = state();
    s.revoked = [{ pubkey: WALLET }];
    expect(await unpairObservedClawPumpAgent(input, dependencies(s))).toMatchObject({ alreadyUnpaired: false, walletPubkey: WALLET });
    expect(s.deletes).toHaveLength(0);
  });

  test.each(['operated', 'armed'])('refuses a %s link without mutation', async (kind) => {
    const s = state();
    s.links = [{ ...linkRow(), operatedByClawville: kind === 'operated', armed: kind === 'armed' }];
    await expect(unpairObservedClawPumpAgent(input, dependencies(s))).rejects.toMatchObject({ code: 'not_observed_link', status: 409 });
    expect(s.updates).toHaveLength(0);
    expect(s.deletes).toHaveLength(0);
  });

  test('maps observe-only links to listed agents', async () => {
    const s = state();
    s.links = [linkRow()];
    expect(await listObservedClawPumpAgents(dependencies(s), reader({ listAgents: async () => [agent, { ...agent, id: AGENT }] })))
      .toEqual({ agents: [
        { clawpumpAgentId: GENESIS, name: 'Genesis', status: 'running', walletPubkey: WALLET, pairedAvatarId: AVATAR },
        { clawpumpAgentId: AGENT, name: 'Genesis', status: 'running', walletPubkey: WALLET, pairedAvatarId: null },
      ] });
  });
});
