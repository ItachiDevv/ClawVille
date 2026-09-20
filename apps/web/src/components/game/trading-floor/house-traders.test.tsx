import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import { HOUSE_TRADER_LINEUP } from '@clawville/shared';

import { normaliseHouseSlotRealisedForTest } from '@/hooks/use-trading-floor';
import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';
import type { FloorTrade } from '@/stores/trade-ticker';

// Same DOM harness as floor-components.test.tsx.
const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;

const AVATAR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

let createRoot: typeof import('react-dom/client').createRoot;
let HouseTradersView: typeof import('./house-traders').HouseTradersView;
let useTradeTickerStore: typeof import('@/stores/trade-ticker').useTradeTickerStore;
let root: Root | null = null;
let container: HTMLElement | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function rememberDom(): void {
  previousDescriptors = new Map(
    installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function installDom(): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: testWindow[name as keyof typeof testWindow],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
}

/** The zero block the route really sends for an unpaired or freshly paired
 *  desk. Kept in one place so every fixture below starts from the real shape. */
function emptyRealisedFixture(): NonNullable<HouseTraderSlotView['realised']> {
  return {
    closedPositions: 0, wins: 0, losses: 0, realisedUsd: 0,
    bestUsd: null, worstUsd: null, openPositions: 0, openCostUsd: 0,
    basis: 'gross_usdc_leg', costBasis: 'round_trip_fifo',
    noExitHours: 24, noExitClosures: 0, unmatchedSells: 0, excludedNonUsdc: 0,
    computedOverTrades: 0, undatedLegs: 0, invalidLegs: 0, partial: false,
    note: 'Gross realised on the USDC leg, excludes network fees.',
    preBindIncluded: false, unpricedLegs: 0, unclassifiedLegs: 0,
    computedAt: '2026-09-20T05:00:00.000Z',
  };
}

function slot(overrides: Partial<HouseTraderSlotView> = {}): HouseTraderSlotView {
  return {
    objective: 'momentum-board',
    slotName: 'Genesis',
    // The REAL shipping note, not a paraphrase, so the render assertions below
    // exercise the owner-supplied string the route actually serves.
    strategyNote: HOUSE_TRADER_LINEUP[0]!.strategyNote,
    status: 'not-yet-running',
    realised: emptyRealisedFixture(),
    subject: null,
    counts: { verified: 0, scored: 0, lastTradeAt: null },
    recentTrades: [],
    ...overrides,
  };
}

function tickerTrade(): FloorTrade {
  return {
    kind: 'trade',
    keys: ['t:live-sig'],
    signature: 'LIVE000000000000000000000000000000000000000000000000000000000000',
    subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
    wallet: null,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    notionalUsd: 12,
    dex: 'jupiter',
    blockTime: 1_789_000_000,
    multiplier: 1,
    multiplierTier: 'base',
    decisionId: null,
    scored: true,
    unscoredReason: null,
    operatedByClawville: false,
  };
}

/** Drives the presentational half directly. No module stubbing: a module
 *  namespace object cannot be patched, and `mock.module` is process global and
 *  would poison every sibling file in the lane. */
async function renderWithSlots(slots: HouseTraderSlotView[]): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(HouseTradersView, {
        slots,
        isLoading: false,
        isError: false,
        nowMs: Date.now(),
        compact: false,
      }),
    );
  });
  return container;
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ useTradeTickerStore } = await import('@/stores/trade-ticker'));
  ({ HouseTradersView } = await import('./house-traders'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useTradeTickerStore.setState({ entries: [] });
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('House traders section', () => {
  // 2026-09-19: the lineup dropped to Genesis alone. This panel renders
  // whatever the route returns and pins no count, so it is fed a two-slot
  // fixture on purpose: that proves the component is lineup-agnostic and will
  // not need another edit the next time the lineup changes. The names in the
  // fixture are arbitrary slot data, not a claim about the live lineup, which
  // `house-trader-lineup.test.ts` pins instead.
  test('renders every slot the route returns, with the not-running copy on each', async () => {
    const host = await renderWithSlots([
      slot(),
      slot({
        objective: 'sol-usdc-mean-reversion',
        slotName: 'Second Slot',
        strategyNote: 'Arbitrary fixture, not the live lineup.',
      }),
    ]);
    const text = host.textContent ?? '';
    const occurrences = text.split('Not running yet. This slot has no paired trader.').length - 1;
    expect(occurrences).toBe(2);
    // Unpair deletes the link, so an unpaired slot cannot show `stopped` while
    // its old trades stay on the tape. This sentence is what keeps the two
    // public surfaces in one tab from contradicting each other.
    expect(text).toContain('can still appear on the tape');
    // A spinner would imply pending activity that does not exist.
    expect(text).not.toContain('Loading house traders');
    expect(text).toContain('Genesis');
    expect(text).toContain('Second Slot');
    // Dip Hunter was dropped from the lineup, so the panel must never name it
    // again; it is not a template either.
    expect(text).not.toContain('Dip Hunter');
    // The four dropped profiles are TEMPLATES, not house traders.
    for (const dropped of ['AnsemDCA', 'MeanRevert', 'SignalFollower', 'SafeRebalancer']) {
      expect(text).not.toContain(dropped);
    }
  });

  test('renders the LIVE lineup: every trader named, in order, with its own note', async () => {
    const host = await renderWithSlots(
      HOUSE_TRADER_LINEUP.map((entry) =>
        slot({ objective: entry.objective, slotName: entry.label, strategyNote: entry.strategyNote }),
      ),
    );
    const text = host.textContent ?? '';
    // Derived from the lineup, so adding or removing a trader moves this test
    // with it instead of going red on a hard-coded name or count.
    for (const entry of HOUSE_TRADER_LINEUP) {
      expect(text).toContain(entry.label);
      expect(text).toContain(entry.strategyNote);
    }
    // Lineup ORDER is part of the contract: Genesis first, Runner second.
    const positions = HOUSE_TRADER_LINEUP.map((entry) => text.indexOf(entry.label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).not.toContain('Dip Hunter');
    const occurrences = text.split('Not running yet. This slot has no paired trader.').length - 1;
    expect(occurrences).toBe(HOUSE_TRADER_LINEUP.length);
  });

  test('renders the lineup strategy note, never the profile brief or its mints', async () => {
    const host = await renderWithSlots([slot()]);
    const text = host.textContent ?? '';
    // The owner string reaches the panel whole, not truncated or reformatted.
    expect(text).toContain(HOUSE_TRADER_LINEUP[0]!.strategyNote);
    expect(text).toContain('Rules only, no AI decisions.');
    // Genesis holds the momentum-board slot but trades far outside that
    // profile's allowed outputs, so the profile text would be a false claim.
    expect(text).not.toContain('Buy strength and take profit back into SOL or USDC');
    expect(text).not.toContain('SOL, USDC');
  });

  // 2026-09-20 FOUNDER ORDER: the no-P&L rule is REVOKED. The house traders
  // carry a PUBLIC, LIVE realised figure. The rule that replaces it is narrower
  // and stricter: every number on this panel comes from the route, and the
  // panel never hard-codes or re-derives one.
  test('renders realised P&L from the ROUTE, signed, and never a hard-coded figure', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-genesis', avatarName: 'Genesis' },
        counts: { verified: 20, scored: 12, lastTradeAt: '2026-09-20T04:30:00.000Z' },
        // Genesis's real staging shape: a LOSS, with rugs written off.
        realised: {
          ...emptyRealisedFixture(),
          closedPositions: 20, wins: 8, losses: 12, realisedUsd: -5.2,
          bestUsd: 3.15, worstUsd: -2.4, openPositions: 1, openCostUsd: 12,
          noExitClosures: 3, preBindIncluded: true, computedOverTrades: 41,
        },
      }),
    ]);
    const text = host.textContent ?? '';
    // A LOSS must render with its minus sign. Dropping the sign, or Math.abs on
    // the way to the DOM, is the worst bug this board could ship.
    expect(text).toContain('-$5.20');
    expect(text).not.toContain('+$5.20');
    expect(text).toContain('20 closed');
    expect(text).toContain('8W / 12L');
    expect(text).toContain('best +$3.15');
    expect(text).toContain('worst -$2.40');
    expect(text).toContain('1 open');
    // The gross basis travels with the number, so nobody reads it as net.
    expect(text).toContain('excludes network fees');
    // Pre-bind history is declared rather than silently mixed in.
    expect(text).toContain('before this wallet was bound');
    // Rugs are shown as such, in the board's wording. Without this the desk
    // looks like it simply holds three bags rather than having lost them.
    expect(text).toContain('3 closed with no exit');
    // Still no boast wording, even though P&L is now public.
    for (const boast of [/profitable/i, /outperform/i, /beats? the market/i, /crushing/i]) {
      expect(text).not.toMatch(boast);
    }
  });

  // One render per test on purpose: the harness tracks a single root in
  // `afterEach`, so a test that renders twice leaks the first root and its
  // scheduler callback fires after the DOM is torn down ("window is not
  // defined" between tests).
  test('a positive figure renders with a plus sign', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-runner', avatarName: 'ClawVille Runner' },
        realised: {
          ...emptyRealisedFixture(),
          closedPositions: 7, wins: 5, losses: 2, realisedUsd: 4.05,
          bestUsd: 2.1, worstUsd: -0.8, computedOverTrades: 14,
        },
      }),
    ]);
    expect(host.textContent ?? '').toContain('+$4.05');
  });

  test('a trader with nothing closed says so, and never renders $0.00', async () => {
    // `closedPositions === 0` is NOT a flat result. A "$0.00" here would claim
    // the desk traded and came out level, which is a different and false
    // statement, so the whole figure is replaced by words.
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-new', avatarName: 'New' },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('No closed trades yet.');
    expect(text).not.toContain('$0.00');
    // The basis still travels, even with no figure to qualify.
    expect(text).toContain('excludes network fees');
  });

  test('an UNREADABLE block says unavailable, never "no closed trades"', async () => {
    // THREE distinct absences, and conflating any two is a false claim:
    //   null block        -> "P&L unavailable"      (about OUR READ)
    //   closedPositions 0 -> "No closed trades yet" (about the TRADER)
    //   a real figure     -> the number
    // Saying the trader has closed nothing when we merely failed to parse its
    // figures asserts something about a live desk that we do not know.
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-genesis', avatarName: 'Genesis' },
        realised: null,
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('P&L unavailable');
    expect(text).not.toContain('No closed trades yet');
    expect(text).not.toContain('$0.00');
  });

  test('the normaliser rejects an invalid value in ANY numeric field', () => {
    // Codex R4: validating only the headline five let a malformed payload
    // through with per-field fallbacks, and the fallbacks LIE:
    // `bestUsd: "12.34"` became null and read as "no best trade";
    // `openCostUsd: NaN` became 0 and hid money at risk;
    // `noExitHours: "48"` became 24 and made the panel STATE A METHOD THE
    // SERVER DID NOT USE. A payload we cannot fully parse is one we do not
    // understand, so the only honest render is "P&L unavailable".
    const full = emptyRealisedFixture();
    expect(normaliseHouseSlotRealisedForTest({ ...full })).not.toBeNull();
    const numeric = [
      'closedPositions', 'wins', 'losses', 'realisedUsd', 'openPositions',
      'openCostUsd', 'noExitHours', 'noExitClosures', 'unmatchedSells',
      'excludedNonUsdc', 'computedOverTrades', 'undatedLegs', 'invalidLegs',
      'unpricedLegs', 'unclassifiedLegs',
    ];
    for (const key of numeric) {
      const missing: Record<string, unknown> = { ...full };
      delete missing[key];
      expect({ key, out: normaliseHouseSlotRealisedForTest(missing) }).toEqual({ key, out: null });
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, true]) {
        expect({ key, bad, out: normaliseHouseSlotRealisedForTest({ ...full, [key]: bad }) })
          .toEqual({ key, bad, out: null });
      }
    }
  });

  test('a count must be a NON-NEGATIVE INTEGER, and money must not be', () => {
    // Codex R5: `-1 wins` and `1.5 closed positions` are impossible, not small
    // errors, and a finite-number check waved them through. The headline would
    // render confidently beside a nonsense breakdown.
    const full = emptyRealisedFixture();
    const counts = [
      'closedPositions', 'wins', 'losses', 'openPositions', 'noExitClosures',
      'excludedNonUsdc', 'unpricedLegs', 'unclassifiedLegs', 'undatedLegs',
      'invalidLegs', 'unmatchedSells', 'computedOverTrades', 'noExitHours',
    ];
    for (const key of counts) {
      // Codex R6: 2**53 and 1e21 satisfy `Number.isInteger` but are past the
      // point where a JSON integer survives the trip intact, so a count we
      // cannot represent exactly must not be published either.
      for (const bad of [-1, 1.5, -0.5, 2 ** 53, 1e21]) {
        expect({ key, bad, out: normaliseHouseSlotRealisedForTest({ ...full, [key]: bad }) })
          .toEqual({ key, bad, out: null });
      }
      // A legitimate count still passes, including the largest exact one.
      expect(normaliseHouseSlotRealisedForTest({ ...full, [key]: 3 })).not.toBeNull();
      expect(normaliseHouseSlotRealisedForTest({ ...full, [key]: 2 ** 53 - 1 })).not.toBeNull();
    }
    // MONEY is signed and fractional: a loss in cents must NOT be rejected by
    // the same rule, or a real losing desk would read as unavailable.
    expect(normaliseHouseSlotRealisedForTest({ ...full, realisedUsd: -5.2 })).not.toBeNull();
    expect(normaliseHouseSlotRealisedForTest({ ...full, openCostUsd: 31.5 })).not.toBeNull();
  });

  test('bestUsd and worstUsd may be null, but nothing else', () => {
    const full = emptyRealisedFixture();
    // A real state: nothing has closed.
    expect(normaliseHouseSlotRealisedForTest({ ...full, bestUsd: null, worstUsd: null })).not.toBeNull();
    expect(normaliseHouseSlotRealisedForTest({ ...full, bestUsd: 1.5, worstUsd: -2 })).not.toBeNull();
    for (const key of ['bestUsd', 'worstUsd']) {
      for (const bad of ['12.34', Number.NaN, undefined, true]) {
        expect({ key, bad, out: normaliseHouseSlotRealisedForTest({ ...full, [key]: bad }) })
          .toEqual({ key, bad, out: null });
      }
    }
  });

  test('the normaliser rejects a bad string or boolean field', () => {
    const full = emptyRealisedFixture();
    for (const key of ['basis', 'costBasis', 'note', 'computedAt']) {
      for (const bad of ['', 42, null, undefined]) {
        expect({ key, bad, out: normaliseHouseSlotRealisedForTest({ ...full, [key]: bad }) })
          .toEqual({ key, bad, out: null });
      }
    }
    for (const key of ['preBindIncluded', 'partial']) {
      for (const bad of ['true', 1, null, undefined]) {
        expect({ key, bad, out: normaliseHouseSlotRealisedForTest({ ...full, [key]: bad }) })
          .toEqual({ key, bad, out: null });
      }
    }
    expect(normaliseHouseSlotRealisedForTest(undefined)).toBeNull();
    expect(normaliseHouseSlotRealisedForTest(null)).toBeNull();
    expect(normaliseHouseSlotRealisedForTest([])).toBeNull();
  });

  test('an open-but-unclosed desk reports its cost at risk, not a result', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-new', avatarName: 'New' },
        realised: {
          ...emptyRealisedFixture(),
          openPositions: 2,
          openCostUsd: 31.5,
        },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('No closed trades yet.');
    expect(text).toContain('2 open');
    expect(text).toContain('$31.50');
  });

  test('flags a PARTIAL figure when legs could not be valued', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: 'clawville-agent-genesis', avatarName: 'Genesis' },
        realised: {
          ...emptyRealisedFixture(),
          closedPositions: 3, wins: 2, losses: 1, realisedUsd: 1.5,
          bestUsd: 2, worstUsd: -0.5,
          unpricedLegs: 2, unclassifiedLegs: 1, excludedNonUsdc: 1,
        },
      }),
    ]);
    expect(host.textContent ?? '').toContain('this figure is partial');
  });

  test('shows an occupied slot as live with its counts', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 7, scored: 4, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('Live as Genesis');
    expect(text).toContain('7 verified');
    expect(text).toContain('4 scored');
    expect(text).not.toContain('Not running yet');
  });

  test('prepends a live ticker row for the slot avatar', async () => {
    useTradeTickerStore.setState({ entries: [tickerTrade()] });
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 1, scored: 1, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    // The ticker row reaches the card without a second poller.
    expect(host.querySelectorAll('[data-testid="floor-tape-row"]').length).toBeGreaterThan(0);
  });

  test('ignores ticker rows belonging to another avatar', async () => {
    useTradeTickerStore.setState({
      entries: [{ ...tickerTrade(), subject: { type: 'agent', id: 'someone-else', avatarName: 'Other' } }],
    });
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 0, scored: 0, lastTradeAt: null },
      }),
    ]);
    expect(host.querySelectorAll('[data-testid="floor-tape-row"]')).toHaveLength(0);
  });

  test('shows a stopped slot as stopped and keeps its counts', async () => {
    // Unpair revokes the wallet but the verified trades stay on the tape, so
    // the card must not flip to "not running yet" with a zero count and
    // contradict the tape two cards above it.
    const host = await renderWithSlots([
      slot({
        status: 'stopped',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 9, scored: 5, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('Stopped.');
    expect(text).toContain('past trades stay on the floor');
    expect(text).toContain('9 verified');
    expect(text).not.toContain('Not running yet');
  });

  test('states at section level that the tape outlives a pairing', async () => {
    // The ONLY thing covering a full unpair: `unpairObservedClawPumpAgent`
    // DELETES the link row, so that trader leaves the panel entirely while its
    // verified trades keep scrolling on the floor below. The per-card
    // `stopped` copy cannot cover it, because there is no card left.
    const host = await renderWithSlots([slot()]);
    const text = host.textContent ?? '';
    expect(text).toContain('This panel shows the traders paired right now.');
    expect(text).toContain('including trades from a trader that is no longer paired');
  });

  test('links to the templates section rather than duplicating it', async () => {
    const host = await renderWithSlots([slot()]);
    const link = [...host.querySelectorAll('a')].find(
      (node) => node.getAttribute('href') === '#clawpump-templates',
    );
    expect(link).toBeDefined();
  });
});
