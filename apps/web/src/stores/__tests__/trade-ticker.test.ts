import { beforeEach, describe, expect, test } from 'bun:test';

import { decisionRowState } from '@/components/game/trading-floor/format';
import {
  MAX_TICKER_TRADES,
  useTradeTickerStore,
  type FloorDecision,
  type FloorTrade,
  type TapeEntry,
} from '@/stores/trade-ticker';

function decision(
  decisionId: string,
  verdict: FloorDecision['verdict'] = 'submitted',
  at = '2026-09-16T10:00:00.000Z',
): FloorDecision {
  return {
    kind: 'decision',
    keys: [`d:${decisionId}`],
    decisionId,
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Ralph' },
    verdict,
    reason: verdict === 'refused' ? 'cooldown_active' : null,
    inputMint: 'mint-in',
    outputMint: 'mint-out',
    requestedUsd: 25,
    operatedByClawville: true,
    at,
  };
}

function trade(signature: string, decisionId: string | null): FloorTrade {
  return {
    kind: 'trade',
    keys: decisionId
      ? [`t:${signature}`, `d:${decisionId}`]
      : [`t:${signature}`],
    signature,
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Ralph' },
    wallet: null,
    inputMint: 'mint-in',
    outputMint: 'mint-out',
    notionalUsd: 24.5,
    dex: 'jupiter',
    blockTime: 1_789_000_000,
    multiplier: 2,
    multiplierTier: 'ansem',
    decisionId,
    scored: true,
    unscoredReason: null,
    operatedByClawville: true,
  };
}

function reset(): void {
  useTradeTickerStore.setState({
    entries: [],
    seen: new Set<string>(),
    dismissed: false,
    consumers: 0,
  });
}

function expectOneTrade(decisionId: string): void {
  const { entries } = useTradeTickerStore.getState();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.kind).toBe('trade');
  expect(entries[0]?.keys).toContain(`d:${decisionId}`);
}

function liveKeyUnion(entries: readonly TapeEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => entry.keys));
}

beforeEach(reset);

describe('Trading Floor tape store', () => {
  test('dedupes verified trades by signature', () => {
    const store = useTradeTickerStore.getState();
    store.addTrades([trade('same-signature', null)]);
    store.addTrades([trade('same-signature', null)]);
    expect(useTradeTickerStore.getState().entries).toHaveLength(1);
  });

  test('caps 60 plain trades and their key set at 25', () => {
    for (let index = 0; index < 60; index += 1) {
      useTradeTickerStore.getState().addTrades([trade(`plain-${index}`, null)]);
    }
    const { entries, seen } = useTradeTickerStore.getState();
    expect(entries).toHaveLength(MAX_TICKER_TRADES);
    expect(seen).toHaveLength(MAX_TICKER_TRADES);
    expect(seen).toEqual(liveKeyUnion(entries));
  });

  test('a duplicate call preserves the store snapshot', () => {
    useTradeTickerStore.getState().addTrades([trade('stable', null)]);
    const before = useTradeTickerStore.getState();
    useTradeTickerStore.getState().addTrades([trade('stable', null)]);
    expect(Object.is(useTradeTickerStore.getState(), before)).toBe(true);
  });

  test('REST seed merges without duplicating a live frame', () => {
    useTradeTickerStore.getState().addTrades([trade('seed-live', null)]);
    useTradeTickerStore.getState().seedTrades([trade('seed-live', null)]);
    expect(useTradeTickerStore.getState().entries).toHaveLength(1);
  });

  test('dismiss is idempotent and clear removes entries and keys', () => {
    const store = useTradeTickerStore.getState();
    store.addTrades([trade('clear-me', null)]);
    store.dismiss();
    const dismissed = useTradeTickerStore.getState();
    useTradeTickerStore.getState().dismiss();
    expect(Object.is(useTradeTickerStore.getState(), dismissed)).toBe(true);
    useTradeTickerStore.getState().clear();
    expect(useTradeTickerStore.getState()).toMatchObject({ entries: [], dismissed: true });
    expect(useTradeTickerStore.getState().seen.size).toBe(0);
  });

  test('submitted, executed, trade converges to one verified row', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('d1')]);
    store.addDecisions([decision('d1', 'executed')]);
    expect(useTradeTickerStore.getState().entries[0]).toMatchObject({
      kind: 'decision',
      verdict: 'executed',
    });
    store.addTrades([trade('sig-1', 'd1')]);
    expectOneTrade('d1');
  });

  test('submitted, trade, executed keeps the verified row', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('d2')]);
    store.addTrades([trade('sig-2', 'd2')]);
    store.addDecisions([decision('d2', 'executed')]);
    expectOneTrade('d2');
  });

  test('trade, submitted, executed keeps the verified row', () => {
    const store = useTradeTickerStore.getState();
    store.addTrades([trade('sig-3', 'd3')]);
    store.addDecisions([decision('d3')]);
    store.addDecisions([decision('d3', 'executed')]);
    expectOneTrade('d3');
  });

  test('executed before trade is dropped and the later trade is unique', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('d4', 'executed')]);
    expect(useTradeTickerStore.getState().entries).toHaveLength(0);
    store.addTrades([trade('sig-4', 'd4')]);
    expectOneTrade('d4');
  });

  test('duplicate submitted frames keep one pending row', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('d5')]);
    store.addDecisions([decision('d5')]);
    const entries = useTradeTickerStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'decision', verdict: 'submitted' });
  });

  test('duplicate executed frames promote once', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('d6')]);
    store.addDecisions([decision('d6', 'executed')]);
    const promoted = useTradeTickerStore.getState().entries[0];
    store.addDecisions([decision('d6', 'executed')]);
    expect(useTradeTickerStore.getState().entries).toEqual([promoted]);
  });

  test('an unconfirmed row promotes to clock-terminal executed', () => {
    const submitted = decision('clock', 'submitted', '2026-09-16T10:00:00.000Z');
    useTradeTickerStore.getState().addDecisions([submitted]);
    expect(decisionRowState(submitted, Date.parse(submitted.at) + 900_000)).toBe('unconfirmed');
    useTradeTickerStore.getState().addDecisions([decision('clock', 'executed')]);
    const promoted = useTradeTickerStore.getState().entries[0];
    expect(promoted?.kind).toBe('decision');
    if (promoted?.kind === 'decision') {
      expect(decisionRowState(promoted, Date.parse(promoted.at) + 9_000_000)).toBe('executed');
    }
  });

  test('executed never creates or changes an unrelated row', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('keep')]);
    const before = useTradeTickerStore.getState().entries;
    store.addDecisions([decision('missing', 'executed')]);
    expect(useTradeTickerStore.getState().entries).toEqual(before);
  });

  test('trade first drops later submitted and executed frames', () => {
    const store = useTradeTickerStore.getState();
    store.addTrades([trade('trade-first', 'trade-first-id')]);
    const verified = useTradeTickerStore.getState().entries[0];
    store.addDecisions([decision('trade-first-id')]);
    store.addDecisions([decision('trade-first-id', 'executed')]);
    expect(useTradeTickerStore.getState().entries).toEqual([verified]);
  });

  test('promotion and verified replacement stay at index one', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('right')]);
    store.addDecisions([decision('target')]);
    store.addDecisions([decision('left')]);
    const before = useTradeTickerStore.getState().entries;
    store.addDecisions([decision('target', 'executed')]);
    let entries = useTradeTickerStore.getState().entries;
    expect(entries[0]).toBe(before[0]);
    expect(entries[2]).toBe(before[2]);
    expect(entries[1]).toMatchObject({ verdict: 'executed' });

    store.addTrades([trade('target-signature', 'target')]);
    entries = useTradeTickerStore.getState().entries;
    expect(entries[0]).toBe(before[0]);
    expect(entries[2]).toBe(before[2]);
    expect(entries[1]).toMatchObject({ kind: 'trade', signature: 'target-signature' });
    expect(entries[1]?.keys).toEqual(expect.arrayContaining(['d:target', 't:target-signature']));
  });

  test('REST seed uses the same in-place join', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('seed-neighbour')]);
    store.addDecisions([decision('seed-target')]);
    const neighbour = useTradeTickerStore.getState().entries[1];
    store.seedTrades([trade('seed-signature', 'seed-target')]);
    const entries = useTradeTickerStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'trade', signature: 'seed-signature' });
    expect(entries[1]).toBe(neighbour);
  });

  test('kind-prefixed ids never collide', () => {
    const store = useTradeTickerStore.getState();
    store.addDecisions([decision('same')]);
    store.addTrades([trade('same', null)]);
    expect(useTradeTickerStore.getState().entries).toHaveLength(2);
  });

  test('interleaved trades and decisions evict complete entry key sets', () => {
    for (let index = 0; index < 40; index += 1) {
      const id = `interleaved-${index}`;
      useTradeTickerStore.getState().addDecisions([decision(id)]);
      if (index % 2 === 0) {
        useTradeTickerStore.getState().addTrades([trade(`interleaved-sig-${index}`, id)]);
      }
    }
    const { entries, seen } = useTradeTickerStore.getState();
    expect(entries).toHaveLength(MAX_TICKER_TRADES);
    expect(seen).toEqual(liveKeyUnion(entries));
  });

  test('a resolved trade after decision eviction prepends once', () => {
    useTradeTickerStore.getState().addDecisions([decision('evicted')]);
    for (let index = 0; index < MAX_TICKER_TRADES; index += 1) {
      useTradeTickerStore.getState().addDecisions([decision(`new-${index}`)]);
    }
    expect(useTradeTickerStore.getState().seen.has('d:evicted')).toBe(false);
    useTradeTickerStore.getState().addTrades([trade('evicted-sig', 'evicted')]);
    expect(useTradeTickerStore.getState().entries[0]).toMatchObject({
      kind: 'trade',
      signature: 'evicted-sig',
    });
    expect(useTradeTickerStore.getState().entries.filter((entry) => entry.keys.includes('d:evicted'))).toHaveLength(1);
  });

  test('a null decision id never replaces a pending row', () => {
    useTradeTickerStore.getState().addDecisions([decision('pending')]);
    useTradeTickerStore.getState().addTrades([trade('no-decision-id', null)]);
    expect(useTradeTickerStore.getState().entries).toHaveLength(2);
    expect(useTradeTickerStore.getState().entries[1]).toMatchObject({ kind: 'decision' });
  });

  test('a refused decision is never replaced by a verified trade', () => {
    useTradeTickerStore.getState().addDecisions([decision('refused', 'refused')]);
    useTradeTickerStore.getState().addTrades([trade('refused-sig', 'refused')]);
    const entries = useTradeTickerStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ kind: 'decision', verdict: 'refused' });
  });

  test('consumer removal is symmetric and stops at zero', () => {
    const store = useTradeTickerStore.getState();
    store.addConsumer();
    store.addConsumer();
    useTradeTickerStore.getState().removeConsumer();
    useTradeTickerStore.getState().removeConsumer();
    useTradeTickerStore.getState().removeConsumer();
    expect(useTradeTickerStore.getState().consumers).toBe(0);
  });

  test('500 replacement cycles keep seen equal to live entry keys', () => {
    for (let index = 0; index < 500; index += 1) {
      const id = `churn-${index}`;
      const store = useTradeTickerStore.getState();
      store.addDecisions([decision(id)]);
      store.addDecisions([decision(id, 'executed')]);
      store.addTrades([trade(`signature-${index}`, id)]);

      const { entries, seen } = useTradeTickerStore.getState();
      expect(entries.length).toBeLessThanOrEqual(MAX_TICKER_TRADES);
      expect(seen).toEqual(liveKeyUnion(entries));
      expect(seen.size).toBeLessThanOrEqual(2 * MAX_TICKER_TRADES);
    }
  });
});
