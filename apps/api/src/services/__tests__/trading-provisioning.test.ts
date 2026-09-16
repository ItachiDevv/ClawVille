import { describe, expect, test } from 'bun:test';
import { agentBots, avatars, clawpumpAgentLinks, tradingWallets, wallets } from '@clawville/database';
import {
  FLEET_SLOT_IDS,
  pairFounderAgent,
  provisionFleetAccount,
  TradingProvisioningError,
  type TradingProvisioningDependencies,
} from '../trading-provisioning';
import { identityFingerprint } from '../identity-service';
import { executeTrade } from '../trading-execution';
import type { TradeIntent } from '../trading-guardrails';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AVATAR_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const WALLET = '11111111111111111111111111111111';

type TestState = {
  order: string[];
  insertedLinks: Array<Record<string, unknown>>;
  killUpdates: Array<Record<string, unknown>>;
  locks: string[];
  occupied?: boolean;
  preflightAvatar?: { id: string; userId: string; platformAgentId: string | null };
  preflightBot?: boolean;
  preflightExisting?: boolean;
  transactionExisting?: boolean;
  linkInsertError?: Error;
};

function rowsForTable(state: TestState, table: unknown) {
  if (table === wallets) {
    return [{ publicKey: WALLET, subjectType: 'avatar', subjectId: AVATAR_ID, custodyVerified: true }];
  }
  if (table === avatars) {
    const avatar = state.preflightAvatar;
    return avatar ? [avatar] : [];
  }
  if (table === agentBots) return state.preflightBot ? [{ agentId: AGENT_ID }] : [];
  if (table === tradingWallets) return state.transactionExisting ? [{ id: 'existing-wallet' }] : [];
  return [];
}

function chainRows(rows: unknown[]) {
  const terminal = {
    limit: async () => rows,
    for: () => ({ limit: async () => rows }),
  };
  return {
    where: () => terminal,
  };
}

function fakeDatabase(state: TestState) {
  const tx = {
    execute: async (query: unknown) => {
      state.locks.push(String(query));
      return [];
    },
    select: () => ({
      from: (table: unknown) => chainRows(rowsForTable(state, table)),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => table === agentBots ? [{ agentId: AGENT_ID }] : [],
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === clawpumpAgentLinks) {
          if (state.linkInsertError) throw state.linkInsertError;
          state.insertedLinks.push(values);
        }
        return [];
      },
    }),
  };

  return {
    query: {
      avatars: {
        findFirst: async () => state.preflightAvatar
          ? state.preflightAvatar
          : state.occupied ? { id: AVATAR_ID } : undefined,
      },
      agentBots: {
        findFirst: async () => state.preflightBot ? { id: 'bot-row' } : undefined,
      },
      tradingWallets: {
        findFirst: async () => state.preflightExisting ? { id: 'existing-wallet' } : undefined,
      },
    },
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.killUpdates.push(values);
          return [];
        },
      }),
    }),
  };
}

function provisionDeps(state: TestState, overrides: Partial<TradingProvisioningDependencies> = {}) {
  const deps = {
    database: fakeDatabase(state),
    resolveIdentity: async (_type: string, slotId: string) => ({
      id: USER_ID,
      email: null,
      name: 'fleet',
      identityFingerprint: identityFingerprint('clawville-fleet', slotId),
      isNewUser: true,
    }),
    provisionAvatar: async (_userId: string, _params: unknown, options: unknown) => {
      state.order.push(`provision:${JSON.stringify(options)}`);
      return {
        created: true,
        avatar: { id: AVATAR_ID, walletAddress: WALLET },
        agentId: AGENT_ID,
        wallet: { address: WALLET, secretKey: 'must-not-escape', chain: 'solana' },
      };
    },
    ensureHostedSession: async () => {
      state.order.push('session');
      return { bearer: 'server-only', agentId: AGENT_ID, bodyId: 'body', reused: false };
    },
    readBindSlot: async () => {
      state.order.push('slot');
      return 123;
    },
    bindCustodialWallet: async (input: any) => {
      state.order.push(`bind:${input.boundSlot}`);
      return {
        id: 'trading-wallet', pubkey: WALLET, source: 'custodial', subjectKind: 'agent',
        userId: USER_ID, avatarId: AVATAR_ID, agentId: AGENT_ID, boundAt: new Date(),
        boundSlot: 123, cursorSignature: null, cursorBlockTime: null, lastPolledAt: null,
        operatedByClawville: true,
      };
    },
    bindClawPumpWallet: async () => { throw new Error('not used'); },
    activateAutonomy: async () => {
      state.order.push('activate');
      return { ok: true as const, reused: false, bodyId: 'body' };
    },
    ...overrides,
  };
  return deps as unknown as TradingProvisioningDependencies;
}

function pairDeps(state: TestState, overrides: Partial<TradingProvisioningDependencies> = {}) {
  const deps = provisionDeps(state, {
    bindClawPumpWallet: async (input: any) => {
      state.order.push(`pair-bind:${input.clawpumpAgentId}`);
      return {
        id: 'observed-wallet', pubkey: WALLET, source: 'clawpump', subjectKind: 'agent',
        userId: USER_ID, avatarId: AVATAR_ID, agentId: AGENT_ID, boundAt: new Date(),
        boundSlot: 123, cursorSignature: null, cursorBlockTime: null, lastPolledAt: null,
        operatedByClawville: false,
      };
    },
    ...overrides,
  });
  return deps;
}

function state(): TestState {
  return {
    order: [], insertedLinks: [], killUpdates: [], locks: [],
    preflightAvatar: { id: AVATAR_ID, userId: USER_ID, platformAgentId: AGENT_ID },
    preflightBot: true,
  };
}

describe('Trading Floor fleet provisioning service', () => {
  test('creates one literal disabled link and activates autonomy last without exposing the secret', async () => {
    const s = state();
    delete s.preflightAvatar;
    const result = await provisionFleetAccount({
      objective: 'momentum-board',
      traderName: 'MomentumTrader',
      leaderboardEligible: true,
      operatedByClawville: true,
    }, provisionDeps(s));
    expect(result).toEqual({
      ok: true, userId: USER_ID, avatarId: AVATAR_ID, clawvilleAgentId: AGENT_ID,
      walletPubkey: WALLET, objective: 'momentum-board', armed: false, killed: true,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
    expect(s.insertedLinks).toHaveLength(1);
    expect(s.insertedLinks[0]).toMatchObject({
      armed: false, killed: true, floatStartLamports: '0', floatStartUsdMicros: '0',
      baselineSlot: null, baselineEvidence: null,
    });
    expect(s.order.at(-1)).toBe('activate');
    expect(s.order[0]).toContain('"wallet":"include-fatal"');
    expect(s.order[0]).toContain('"initialEconomy":"zero"');
  });

  test('makes the non-fleet leaderboard refusal reachable before avatar creation', async () => {
    const s = state();
    delete s.preflightAvatar;
    let provisionCalls = 0;
    const deps = provisionDeps(s, {
      resolveIdentity: async () => ({
        id: USER_ID, email: null, name: 'not-fleet', identityFingerprint: 'other', isNewUser: false,
      }),
      provisionAvatar: async () => {
        provisionCalls++;
        throw new Error('must not provision');
      },
    });
    await expect(provisionFleetAccount({
      objective: 'momentum-board', traderName: 'MomentumTrader',
      leaderboardEligible: false, operatedByClawville: true,
    }, deps)).rejects.toMatchObject({ code: 'leaderboard_eligible_non_fleet', status: 409 });
    expect(provisionCalls).toBe(0);
  });

  test('propagates a raw 23505 from the bind/link transaction', async () => {
    const s = state();
    delete s.preflightAvatar;
    const unique = Object.assign(new Error('unique'), { code: '23505' });
    s.linkInsertError = unique;
    await expect(provisionFleetAccount({
      objective: 'momentum-board', traderName: 'MomentumTrader',
      leaderboardEligible: true, operatedByClawville: true,
    }, provisionDeps(s))).rejects.toBe(unique);
    expect(s.order).not.toContain('activate');
  });

  test('maps a thrown autonomy failure to a stable code and reasserts killed true', async () => {
    const s = state();
    delete s.preflightAvatar;
    const deps = provisionDeps(s, {
      activateAutonomy: async () => { throw new Error('driver unavailable'); },
    });
    await expect(provisionFleetAccount({
      objective: 'momentum-board', traderName: 'MomentumTrader',
      leaderboardEligible: true, operatedByClawville: true,
    }, deps)).rejects.toMatchObject({ code: 'autonomy_activation_failed', status: 500 });
    expect(s.killUpdates).toEqual([{ killed: true, updatedAt: expect.any(Date) }]);
  });
});

describe('Trading Floor founder pairing service', () => {
  const input = {
    avatarId: AVATAR_ID,
    clawpumpAgentId: 'genesis',
    walletPubkey: WALLET,
    objective: 'momentum-board' as const,
    operatedByClawville: false,
  };

  test('binds an agent-subject wallet, acquires label then avatar locks, and inserts no fleet link', async () => {
    const s = state();
    const result = await pairFounderAgent(input, pairDeps(s));
    expect(result).toMatchObject({
      ok: true, subjectKind: 'agent', avatarId: AVATAR_ID,
      clawvilleAgentId: AGENT_ID, clawpumpAgentId: 'genesis', walletPubkey: WALLET,
    });
    expect(s.insertedLinks).toHaveLength(0);
    expect(s.locks).toHaveLength(2);
    expect(s.order).toContain('pair-bind:genesis');
  });

  test('a paired avatar remains observe-only and executeTrade refuses no_link', async () => {
    const s = state();
    const paired = await pairFounderAgent(input, pairDeps(s));
    const intent: TradeIntent = {
      avatarId: paired.avatarId,
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountUsdMicros: 1_000_000n,
      reason: 'observe-only test',
      origin: 'admin-test',
      sessionId: null,
      agentId: paired.clawvilleAgentId,
      directiveId: null,
      directiveOrdinal: null,
    };
    const verdict = await executeTrade(intent, {
      findLink: async () => s.insertedLinks[0] as never,
      recordRefusal: async (_intent, code, detail) => ({
        kind: 'refuse', code, detail, decisionId: 'decision-no-link',
      }),
      publishDecision: async () => {},
    });
    expect(verdict).toMatchObject({ kind: 'refused', code: 'no_link', signature: null });
    expect(s.insertedLinks).toHaveLength(0);
  });

  test('rejects malformed wallets, missing bound agents, and existing labels before the slot RPC', async () => {
    const malformed = state();
    await expect(pairFounderAgent({ ...input, walletPubkey: 'not-base58!' }, pairDeps(malformed)))
      .rejects.toMatchObject({ code: 'agent_has_no_wallet' });
    expect(malformed.order).not.toContain('slot');

    const unbound = state();
    unbound.preflightAvatar = { id: AVATAR_ID, userId: USER_ID, platformAgentId: null };
    await expect(pairFounderAgent(input, pairDeps(unbound)))
      .rejects.toMatchObject({ code: 'no_bound_clawville_agent' });
    expect(unbound.order).not.toContain('slot');

    const existing = state();
    existing.preflightExisting = true;
    await expect(pairFounderAgent(input, pairDeps(existing)))
      .rejects.toMatchObject({ code: 'already_linked' });
    expect(existing.order).not.toContain('slot');
  });

  test('rejects any active same-avatar wallet before the bind can reuse it', async () => {
    const s = state();
    s.preflightExisting = true;
    let bindCalls = 0;
    const deps = pairDeps(s, {
      bindClawPumpWallet: async () => {
        bindCalls++;
        throw new Error('must not bind');
      },
    });
    await expect(pairFounderAgent(input, deps))
      .rejects.toMatchObject({ code: 'already_linked', status: 409 });
    expect(bindCalls).toBe(0);
    expect(s.order).not.toContain('slot');
  });

  test('rechecks active bindings under the label and avatar locks', async () => {
    const s = state();
    s.transactionExisting = true;
    let bindCalls = 0;
    const deps = pairDeps(s, {
      bindClawPumpWallet: async () => {
        bindCalls++;
        throw new Error('must not bind');
      },
    });
    await expect(pairFounderAgent(input, deps))
      .rejects.toMatchObject({ code: 'already_linked', status: 409 });
    expect(s.locks).toHaveLength(2);
    expect(bindCalls).toBe(0);
  });

  test('rejects a bind helper result that does not store the ClawPump binding', async () => {
    const s = state();
    const deps = pairDeps(s, {
      bindClawPumpWallet: async () => ({
        id: 'wrong-binding', pubkey: WALLET, source: 'custodial', subjectKind: 'agent',
        userId: USER_ID, avatarId: AVATAR_ID, agentId: AGENT_ID, boundAt: new Date(),
        boundSlot: 123, cursorSignature: null, cursorBlockTime: null, lastPolledAt: null,
        operatedByClawville: false,
      }),
    });
    await expect(pairFounderAgent(input, deps))
      .rejects.toMatchObject({ code: 'already_linked', status: 409 });
  });

  test('propagates a raw 23505 from the observed-wallet bind', async () => {
    const s = state();
    const unique = Object.assign(new Error('unique'), { code: '23505' });
    const deps = pairDeps(s, { bindClawPumpWallet: async () => { throw unique; } });
    await expect(pairFounderAgent(input, deps)).rejects.toBe(unique);
    expect(s.insertedLinks).toHaveLength(0);
  });
});
