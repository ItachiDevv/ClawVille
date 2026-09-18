import { create } from 'zustand';

import type {
  TradeRefusalCode,
  TradeUnscoredReason,
} from '@clawville/shared';

interface TapeEntryBase {
  /** Every dedupe key owned by this entry. Eviction removes all of them. */
  keys: readonly string[];
}

export interface FloorTrade extends TapeEntryBase {
  kind: 'trade';
  signature: string;
  subject: {
    type: 'avatar' | 'agent';
    id: string;
    avatarName: string | null;
  } | null;
  wallet: string | null;
  inputMint: string;
  outputMint: string;
  notionalUsd: number | null;
  dex: 'jupiter' | 'pumpswap' | 'pumpfun';
  blockTime: number | null;
  multiplier: 1 | 1.5 | 2;
  multiplierTier: 'base' | 'clv' | 'ansem';
  decisionId: string | null;
  scored: boolean;
  unscoredReason: TradeUnscoredReason | null;
  operatedByClawville: boolean;
  operator?: 'clawville' | 'clawpump' | null;
}

export interface FloorDecision extends TapeEntryBase {
  kind: 'decision';
  decisionId: string;
  subject: {
    type: 'agent';
    id: string;
    avatarName: string | null;
  };
  verdict: 'submitted' | 'refused' | 'executed';
  reason: TradeRefusalCode | null;
  inputMint: string;
  outputMint: string;
  requestedUsd: number | null;
  operatedByClawville: boolean;
  at: string;
}

export type TapeEntry = FloorTrade | FloorDecision;

interface TradeTickerState {
  entries: TapeEntry[];
  seen: Set<string>;
  dismissed: boolean;
  consumers: number;
  addConsumer: () => void;
  removeConsumer: () => void;
  addTrades: (incoming: FloorTrade[]) => void;
  addDecisions: (incoming: FloorDecision[]) => void;
  seedTrades: (rows: FloorTrade[]) => void;
  dismiss: () => void;
  clear: () => void;
}

export const MAX_TICKER_TRADES = 25;

function tradeKeys(trade: FloorTrade): readonly string[] {
  return trade.decisionId
    ? [`t:${trade.signature}`, `d:${trade.decisionId}`]
    : [`t:${trade.signature}`];
}

function decisionKey(decisionId: string): string {
  return `d:${decisionId}`;
}

function rebuildSeen(entries: readonly TapeEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => entry.keys));
}

function cap(entries: TapeEntry[]): TapeEntry[] {
  return entries.length > MAX_TICKER_TRADES
    ? entries.slice(0, MAX_TICKER_TRADES)
    : entries;
}

function joinAndInsert(
  current: readonly TapeEntry[],
  incoming: readonly FloorTrade[],
): { entries: TapeEntry[]; changed: boolean } {
  let entries = [...current];
  let seen = rebuildSeen(entries);
  let changed = false;

  for (const rawTrade of incoming) {
    const tradeKey = `t:${rawTrade.signature}`;
    if (seen.has(tradeKey)) continue;

    const dKey = rawTrade.decisionId
      ? decisionKey(rawTrade.decisionId)
      : null;
    const decisionIndex = dKey
      ? entries.findIndex(
          (entry) => entry.kind === 'decision' && entry.keys.includes(dKey),
        )
      : -1;

    if (
      decisionIndex >= 0 &&
      entries[decisionIndex]?.kind === 'decision' &&
      entries[decisionIndex].verdict !== 'refused'
    ) {
      const inherited = entries[decisionIndex]!.keys;
      entries[decisionIndex] = {
        ...rawTrade,
        keys: [...new Set([...tradeKeys(rawTrade), ...inherited])],
      };
    } else {
      entries.unshift({ ...rawTrade, keys: tradeKeys(rawTrade) });
    }
    entries = cap(entries);
    seen = rebuildSeen(entries);
    changed = true;
  }

  return { entries, changed };
}

export const useTradeTickerStore = create<TradeTickerState>((set) => ({
  entries: [],
  seen: new Set<string>(),
  dismissed: false,
  consumers: 0,
  addConsumer: () => set((state) => ({ consumers: state.consumers + 1 })),
  removeConsumer: () =>
    set((state) =>
      state.consumers === 0
        ? state
        : { consumers: state.consumers - 1 },
    ),
  addTrades: (incoming) =>
    set((state) => {
      const next = joinAndInsert(state.entries, incoming);
      if (!next.changed) return state;
      return { entries: next.entries, seen: rebuildSeen(next.entries) };
    }),
  seedTrades: (rows) =>
    set((state) => {
      const next = joinAndInsert(state.entries, rows);
      if (!next.changed) return state;
      return { entries: next.entries, seen: rebuildSeen(next.entries) };
    }),
  addDecisions: (incoming) =>
    set((state) => {
      let entries = [...state.entries];
      let seen = rebuildSeen(entries);
      let changed = false;

      for (const rawDecision of incoming) {
        const key = decisionKey(rawDecision.decisionId);
        const existingIndex = entries.findIndex((entry) =>
          entry.keys.includes(key),
        );

        if (rawDecision.verdict === 'executed') {
          if (existingIndex < 0) continue;
          const existing = entries[existingIndex]!;
          if (existing.kind === 'trade' || existing.verdict !== 'submitted') {
            continue;
          }
          entries[existingIndex] = {
            ...rawDecision,
            keys: existing.keys,
          };
          changed = true;
          continue;
        }

        if (seen.has(key)) continue;
        entries.unshift({ ...rawDecision, keys: [key] });
        entries = cap(entries);
        seen = rebuildSeen(entries);
        changed = true;
      }

      if (!changed) return state;
      return { entries, seen: rebuildSeen(entries) };
    }),
  dismiss: () => set((state) => (state.dismissed ? state : { dismissed: true })),
  clear: () =>
    set((state) =>
      state.entries.length === 0 && state.seen.size === 0
        ? state
        : { entries: [], seen: new Set<string>() },
    ),
}));
