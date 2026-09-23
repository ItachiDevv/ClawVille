import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ElizaRuntime, type ElizaMessage } from './eliza-runtime';
import { clawvillePlugin } from './plugins/clawville-plugin';
import type { Action } from './actions/types';

const AGENT_ID = '60000000-0000-0000-0000-000000000006';
const registeredActions = clawvillePlugin.actions;
const registeredProviders = clawvillePlugin.providers;
const doorDashActions = registeredActions.filter((action) => action.name.startsWith('DOORDASH_'));

function action(name: string, overrides: Partial<Action> = {}): Action {
  return {
    name,
    description: `${name} description`,
    validate: mock(async () => true),
    handler: mock(async () => ({ success: true, text: `${name} output` })),
    ...overrides,
  };
}

function harness(reply: string, actions: Action[] = registeredActions, rememberHistory = false) {
  clawvillePlugin.actions = actions;
  const memories: any[] = [];
  const onMessage = mock((_message: ElizaMessage) => {});
  const generateText = mock(async (_prompt: string) => ({ text: reply }));
  const runtime = new ElizaRuntime({
    agentId: AGENT_ID,
    agentType: 'avatar-agent',
    agentConfig: {},
    onMessage,
  });
  Object.assign(runtime, {
    state: 'running',
    runtime: {
      ensureWorldExists: async () => {},
      getRoom: async () => ({}),
      getEntityById: async () => ({}),
      getMemories: async () => rememberHistory ? structuredClone(memories.slice(-20)) : [],
      createMemory: async (memory: any) => { memories.push(structuredClone(memory)); },
      generateText,
    },
  });
  return { runtime, memories, generateText, onMessage };
}

function fakeBridge() {
  return {
    addresses: mock(async () => ({ ok: true, data: [{ address_id: 1, printable_address: '17 Private Street' }], durationMs: 1 })),
    search: mock(async () => ({ ok: true, data: { stores: [{ store_id: 2, store_name: 'Private Restaurant' }] }, durationMs: 1 })),
    menu: mock(async () => ({ ok: true, data: { menu_id: 3, items: [{ item_id: 4, name: 'Private Soup' }] }, durationMs: 1 })),
    orderHistory: mock(async () => ({ ok: true, data: [{ order_uuid: 'private-order', store_id: 2, store_name: 'Private Restaurant' }], durationMs: 1 })),
    orderStatus: mock(async () => ({ ok: true, data: { order_uuid: 'private-order', status: 'placed' }, durationMs: 1 })),
  };
}

let restoreLogs: Array<() => void>;
beforeEach(() => {
  clawvillePlugin.providers = [];
  restoreLogs = ['log', 'warn', 'error'].map((method) => {
    const spy = spyOn(console, method as 'log').mockImplementation(() => {});
    return () => spy.mockRestore();
  });
});
afterEach(() => {
  clawvillePlugin.actions = registeredActions;
  clawvillePlugin.providers = registeredProviders;
  for (const restore of restoreLogs) restore();
});

describe('action capability gates', () => {
  it('hides every DoorDash action without a bridge and advertises them with a bridge', async () => {
    // Five read-only actions plus cart, preview and submit.
    expect(doorDashActions).toHaveLength(8);
    const h = harness('Hello.');
    await h.runtime.processMessage('Hello', { state: { services: {} } });
    const absentPrompt = h.generateText.mock.calls[0]![0];
    expect(absentPrompt).not.toContain('DOORDASH_');
    expect(absentPrompt).toContain('CHECK_BALANCE');
    await h.runtime.processMessage('Hello', { state: { services: { doordash: fakeBridge() } } });
    const presentPrompt = h.generateText.mock.calls[1]![0];
    for (const a of doorDashActions) expect(presentPrompt).toContain(a.name);
  });

  it('a Hatcher or non-founder agent never sees a DoorDash action name, even with every other service present', async () => {
    // Mirrors exactly what buildRuntimeServices(db, { actorKind: 'agent', doordash: undefined })
    // returns for a resolveDoordashOperator() === null identity (doordash-chat-wiring.test.ts
    // proves that resolution); this test proves the OTHER half of the chain: what the prompt
    // built from that exact services object contains. Every non-DoorDash capability a real
    // Hatcher agent has is present here on purpose, so the absence below is not an artifact
    // of an empty/minimal services object.
    const nonFounderAgentServices = {
      db: {},
      doordash: undefined,
      creditClawTokens: mock(async () => ({ balanceAfter: 0 })),
      debitClawTokens: mock(async () => ({ balanceAfter: 0 })),
      recordCovenantAction: mock(async () => ({ id: null, deduped: false })),
    };
    const h = harness('Hello.');
    await h.runtime.processMessage('Hello', { state: { services: nonFounderAgentServices } });
    const prompt = h.generateText.mock.calls[0]![0];
    for (const a of doorDashActions) expect(prompt).not.toContain(a.name);
    expect(prompt).not.toContain('DOORDASH_');
    expect(prompt).toContain('CHECK_BALANCE');
  });

  for (const [label, unavailable] of [
    ['returns false', () => false],
    ['throws', () => { throw new Error('unavailable'); }],
  ] as const) {
    it(`fails closed before validation when availability ${label}`, async () => {
      const denied = action('DENIED', { available: unavailable });
      const h = harness('[ACTION: DENIED()]', [denied]);
      await h.runtime.processMessage('Try it', { state: { services: {} } });
      expect(h.generateText.mock.calls[0]![0]).not.toContain('DENIED');
      expect(denied.validate).not.toHaveBeenCalled();
      expect(denied.handler).not.toHaveBeenCalled();
    });
  }

  it('refuses a forged DoorDash tag without calling its handler', async () => {
    const original = doorDashActions.find((a) => a.name === 'DOORDASH_ADDRESSES')!;
    const handler = mock(original.handler);
    const h = harness('[ACTION: DOORDASH_ADDRESSES()]', [{ ...original, handler }]);
    await h.runtime.processMessage('Try it', { state: { services: {} } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks availability again when the capability disappears after advertisement', async () => {
    const services: { doordash?: unknown } = { doordash: fakeBridge() };
    const original = doorDashActions.find((a) => a.name === 'DOORDASH_ADDRESSES')!;
    const handler = mock(original.handler);
    const h = harness('[ACTION: DOORDASH_ADDRESSES()]', [{ ...original, handler }]);
    h.generateText.mockImplementation(async () => {
      delete services.doordash;
      return { text: '[ACTION: DOORDASH_ADDRESSES()]' };
    });
    await h.runtime.processMessage('Read addresses', { state: { services } });
    expect(h.generateText.mock.calls[0]![0]).toContain('DOORDASH_ADDRESSES');
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves legacy availability and validate-throws-open behavior', async () => {
    const legacy = action('LEGACY', { validate: mock(async () => { throw new Error('old validation'); }) });
    const h = harness('[ACTION: LEGACY()]', [legacy]);
    const reply = await h.runtime.processMessage('Try it', { state: { services: {} } });
    expect(h.generateText.mock.calls[0]![0]).toContain('LEGACY');
    expect(legacy.handler).toHaveBeenCalledTimes(1);
    expect(reply.content).toBe('LEGACY output');
  });
});

describe('per-reply action budgets', () => {
  it('executes six read-only DoorDash actions and drops the seventh', async () => {
    const bridge = fakeBridge();
    const h = harness(Array(7).fill('[ACTION: DOORDASH_ADDRESSES()]').join(' '));
    await h.runtime.processMessage('Read addresses', { state: { services: { doordash: bridge } } });
    expect(bridge.addresses).toHaveBeenCalledTimes(6);
    // Each new reply receives a new budget.
    await h.runtime.processMessage('Read addresses', { state: { services: { doordash: bridge } } });
    expect(bridge.addresses).toHaveBeenCalledTimes(12);
  });

  it('executes all five distinct read-only DoorDash actions in one reply', async () => {
    const bridge = fakeBridge();
    const h = harness('[ACTION: DOORDASH_ADDRESSES()] [ACTION: DOORDASH_SEARCH(query=soup)] ' +
      '[ACTION: DOORDASH_MENU(storeId=2)] [ACTION: DOORDASH_ORDER_HISTORY()] [ACTION: DOORDASH_ORDER_STATUS(orderUuid=private-order)]');
    await h.runtime.processMessage('Read details', { state: { services: { doordash: bridge } } });
    for (const method of Object.values(bridge)) expect(method).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ['success', 'failure', 'throw'] as const) {
    it(`allows one money handler attempt when the first outcome is ${outcome}`, async () => {
      const money = action('MONEY', { writesMoney: true, handler: mock(async () => {
        if (outcome === 'throw') throw new Error('uncertain write');
        return { success: outcome === 'success', text: 'Money outcome' };
      }) });
      const secondMoney = action('OTHER_MONEY', { writesMoney: true });
      const read = action('READ');
      const h = harness('[ACTION: MONEY()] [ACTION: OTHER_MONEY()] [ACTION: MONEY()] [ACTION: READ()]', [money, secondMoney, read]);
      await h.runtime.processMessage('Try it', { state: { services: {} } });
      expect(money.handler).toHaveBeenCalledTimes(1);
      expect(secondMoney.handler).not.toHaveBeenCalled();
      expect(read.handler).toHaveBeenCalledTimes(1);
    });
  }

  it('does not charge unknown, unavailable, or invalid tags against the budget', async () => {
    const unavailable = action('UNAVAILABLE', { available: () => false, writesMoney: true });
    const invalid = action('INVALID', { validate: mock(async () => false), writesMoney: true });
    const read = action('READ');
    const money = action('MONEY', { writesMoney: true });
    const reply = '[ACTION: UNKNOWN()] [ACTION: UNAVAILABLE()] [ACTION: INVALID()] ' +
      Array(5).fill('[ACTION: READ()]').join(' ') + ' [ACTION: MONEY()] [ACTION: READ()]';
    const h = harness(reply, [unavailable, invalid, read, money]);
    await h.runtime.processMessage('Try it', { state: { services: {} } });
    expect(unavailable.handler).not.toHaveBeenCalled();
    expect(invalid.handler).not.toHaveBeenCalled();
    expect(read.handler).toHaveBeenCalledTimes(5);
    expect(money.handler).toHaveBeenCalledTimes(1);
  });
});

describe('ephemeral action persistence', () => {
  it('dispatches conversational menu follow-ups without putting vendor results into the next prompt', async () => {
    // Scripted model responses prove prompt wiring, dispatch, and retention.
    // They do not prove that a real model understands these user phrases.
    const bridge = {
      search: mock(async () => ({ ok: true, durationMs: 1, data: { stores: [
        { store_id: 'private-first', store_name: 'Private Cafe Alpha' },
        { store_id: 'private-second', store_name: 'Private Cafe Beta' },
      ] } })),
      menu: mock(async () => ({ ok: true, durationMs: 1, data: {
        menu_id: 'private-menu', storeName: 'Private Cafe Beta',
        items: [{ item_id: 'private-item', name: 'Private Orchard Drink' }],
      } })),
      submit: mock(async () => { throw new Error('No payment belongs in this test'); }),
    };
    const h = harness('', registeredActions, true);
    const replies = [
      '[ACTION: DOORDASH_SEARCH(query=food)]',
      '[ACTION: DOORDASH_MENU(storeName=the second one)]',
      '[ACTION: DOORDASH_MENU(query=drinks)]',
    ];
    h.generateText.mockImplementation(async () => ({ text: replies.shift()! }));
    const state = { services: { doordash: bridge } };
    const discovery = await h.runtime.processMessage('I am hungry. What is nearby?', { state });
    const selection = await h.runtime.processMessage('The second one, please.', { state });
    const followup = await h.runtime.processMessage('What drinks do they have?', { state });

    expect(discovery.content).toContain('Private Cafe Alpha');
    expect(selection.content).toContain('Private Orchard Drink');
    expect(followup.content).toContain('Private Orchard Drink');
    expect(bridge.search).toHaveBeenCalledWith({ query: 'food' });
    expect(bridge.menu.mock.calls).toEqual([
      [{ storeId: undefined, storeName: 'the second one', query: undefined }],
      [{ storeId: undefined, storeName: undefined, query: 'drinks' }],
    ]);
    expect(bridge.submit).not.toHaveBeenCalled();

    const menu = doorDashActions.find((a) => a.name === 'DOORDASH_MENU')!;
    for (const [prompt] of h.generateText.mock.calls) {
      expect(prompt).toContain(menu.description);
      for (const phrase of menu.similes ?? []) expect(prompt).toContain(phrase);
      for (const parameter of menu.parameters ?? []) expect(prompt).toContain(parameter.description);
      for (const vendorText of ['Private Cafe Alpha', 'Private Cafe Beta', 'Private Orchard Drink', 'private-menu', 'private-item']) {
        expect(prompt).not.toContain(vendorText);
      }
    }
    const lastPrompt = h.generateText.mock.calls[2]![0];
    expect(lastPrompt).toContain('Previous conversation:');
    expect(lastPrompt).toContain('The second one, please.');
    expect(lastPrompt).toContain('[Action output omitted]');
    expect(h.memories.filter((memory) => memory.entityId === AGENT_ID).map((memory) => memory.content.text))
      .toEqual(Array(3).fill('[Action output omitted]'));
    expect(JSON.stringify(h.memories)).not.toContain('Private Cafe');
    expect(JSON.stringify(h.memories)).not.toContain('Private Orchard');
  });

  it('displays DoorDash results but persists only a marker and ordinary action text', async () => {
    const read = action('READ');
    const bridge = fakeBridge();
    const h = harness('Here are the results. [ACTION: DOORDASH_ADDRESSES()] [ACTION: READ()]', [...doorDashActions, read]);
    const response = await h.runtime.processMessage('Read my addresses and game state', { state: { services: { doordash: bridge } } });
    expect(response.content).toContain('17 Private Street');
    expect(response.content).toContain('READ output');
    expect(h.onMessage.mock.calls[0]![0].content).toBe(response.content);
    // A DoorDash result replaces the model's prose (founder, 2026-09-18): the
    // persona paragraph buried the one line that mattered.
    expect(response.content).not.toContain('Here are the results.');
    expect(h.memories).toHaveLength(2);
    expect(h.memories[0].content.text).toBe('Read my addresses and game state');
    expect(h.memories[1].content.text).toBe('[Action output omitted]\n\nREAD output');
    expect(JSON.stringify(h.memories)).not.toContain('17 Private Street');
  });

  it('excludes all five DoorDash action outputs and data from persisted rows', async () => {
    const bridge = fakeBridge();
    const h = harness('[ACTION: DOORDASH_ADDRESSES()] [ACTION: DOORDASH_SEARCH(query=soup)] ' +
      '[ACTION: DOORDASH_MENU(storeId=2)] [ACTION: DOORDASH_ORDER_HISTORY()] [ACTION: DOORDASH_ORDER_STATUS(orderUuid=private-order)]');
    const response = await h.runtime.processMessage('Read details', { state: { services: { doordash: bridge } } });
    expect(response.content).toContain('Private Soup');
    expect(h.memories[1].content.text).toBe(Array(5).fill('[Action output omitted]').join('\n\n'));
    const persisted = JSON.stringify(h.memories);
    for (const text of ['17 Private Street', 'Private Restaurant', 'Private Soup', 'private-order']) {
      expect(persisted).not.toContain(text);
    }
  });

  // Live on staging 2026-09-18: "choices=Shorti Roll, Not Toasted, Provolone"
  // arrived as choices="Shorti Roll" plus three stray flags, and a Wawa item
  // named "Coke (20 oz)" stopped the whole tag from matching.
  it('keeps commas, parentheses and quotes inside a parameter value', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture = action('CAPTURE', {
      handler: mock(async (_r: unknown, message: any) => {
        seen.push({ ...message.parameters });
        return { success: true, text: 'captured' };
      }),
    });
    const h = harness(
      'Sure. [ACTION: CAPTURE(op=add, choices=Shorti Roll, Not Toasted, Provolone, Ranch)] ' +
      '[ACTION: CAPTURE(op=add, itemName=Coke (20 oz), quantity=2)] ' +
      '[ACTION: CAPTURE(choices="classic roll, provolone")]',
      [capture],
    );
    const response = await h.runtime.processMessage('order', { state: { services: {} } });
    expect(seen).toEqual([
      { op: 'add', choices: 'Shorti Roll, Not Toasted, Provolone, Ranch' },
      { op: 'add', itemName: 'Coke (20 oz)', quantity: '2' },
      { choices: 'classic roll, provolone' },
    ]);
    expect(response.content).not.toContain('[ACTION:');
  });

  it('preserves ordinary action and no-action persistence exactly', async () => {
    const h = harness('Hello. [ACTION: READ()]', [action('READ')]);
    const response = await h.runtime.processMessage('Hello', { state: { services: {} } });
    expect(h.memories[1].content.text).toBe(response.content);
    expect(h.memories[1].content.text).toBe('Hello.\n\nREAD output');
    const plain = harness('Hello.');
    await plain.runtime.processMessage('Hello');
    expect(plain.memories[1].content.text).toBe('Hello.');
  });
});
