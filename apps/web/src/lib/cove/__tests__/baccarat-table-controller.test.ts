import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type {
  BaccaratTablePublicState,
  BaccaratTableRoundResult,
} from '@clawville/shared';
import { CoveApiError } from '../slot-api-client';
import {
  bettingMsLeft,
  CLOSE_REFETCH_DELAY_MS,
  handleBaccaratTableVisibility,
  refreshBaccaratTable,
  SEATED_POLL_MS,
  SHARED_FINAL_REVEAL_STAGE_MS,
  SHARED_REVEAL_STEP_MS,
  SPECTATOR_POLL_MS,
  sharedFeltView,
  startBaccaratTablePolling,
  stopBaccaratTablePolling,
  type TableControllerDeps,
  useBaccaratTableController,
} from '../baccarat-table-controller';

const TABLE_ID = '11111111-1111-4111-8111-111111111111';

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

/** Deterministic clock + timers (no bun fake timers). */
class FakeClock {
  t = 1_000_000;
  private id = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    this.id += 1;
    this.timers.set(this.id, { at: this.t + Math.max(0, ms), fn });
    return this.id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = timer.at;
      timer.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

function makeRound(roundSeq: number, overrides: Partial<BaccaratTableRoundResult> = {}): BaccaratTableRoundResult {
  return {
    roundSeq,
    coupId: `coup-${roundSeq}`,
    shoeId: 'shoe-1',
    coupIndex: roundSeq,
    winner: 'banker',
    player: {
      cards: [{ suit: 'clubs', rank: '2' }, { suit: 'diamonds', rank: '3' }],
      total: 5,
      isNatural: false,
    },
    banker: {
      cards: [{ suit: 'hearts', rank: '4' }, { suit: 'spades', rank: '2' }],
      total: 6,
      isNatural: false,
    },
    dealtAfter: 4,
    settledAt: 999_000,
    seatResults: [],
    ...overrides,
  };
}

function makeTable(overrides: Partial<BaccaratTablePublicState> = {}): BaccaratTablePublicState {
  return {
    tableId: TABLE_ID,
    tierKey: 'low',
    minBet: 5,
    maxBet: 50,
    maxSeats: 6,
    serverNow: 1_000_000,
    roundSeq: 7,
    phase: 'betting',
    bettingClosesAt: 1_012_000,
    nextBettingOpensAt: null,
    shoe: { id: 'shoe-1', serverSeedHash: 'a'.repeat(64), clientSeed: 'c', nextCoupIndex: 7, dealtCount: 28 },
    previousShoe: null,
    seats: [],
    lastRound: null,
    me: null,
    ...overrides,
  };
}

function seatedMe(): NonNullable<BaccaratTablePublicState['me']> {
  return {
    seated: true,
    seatIndex: 2,
    currentBet: null,
    nextRoundBet: null,
    lastResult: null,
    voidedLastRound: null,
    balance: 500,
  };
}

interface Harness {
  clock: FakeClock;
  deps: TableControllerDeps;
  getCalls: number[];
  betCalls: Array<{ roundSeq: number; bet: string; stake: number }>;
  setTable(table: BaccaratTablePublicState): void;
  setHidden(hidden: boolean): void;
  betImpl: (body: { roundSeq: number; bet: string; stake: number }) => Promise<unknown>;
  /** Override to control when a GET resolves; default returns the current table. */
  getImpl: (() => Promise<BaccaratTablePublicState>) | null;
}

function harness(initial: BaccaratTablePublicState): Harness {
  const clock = new FakeClock();
  let current = initial;
  let hidden = false;
  const h: Harness = {
    clock,
    getCalls: [],
    betCalls: [],
    setTable: (table) => { current = table; },
    setHidden: (value) => { hidden = value; },
    betImpl: async (body) => ({ ok: true, ...body, seatIndex: 2, bettingClosesAt: current.bettingClosesAt }),
    getImpl: null,
    deps: undefined as unknown as TableControllerDeps,
  };
  h.deps = {
    api: {
      getTable: async () => {
        h.getCalls.push(clock.t);
        if (h.getImpl) return { ok: true, table: await h.getImpl() };
        // serverNow follows the fake server clock (local clock + 0 offset by default).
        return { ok: true, table: { ...current } };
      },
      sit: async () => ({ ok: true, seatIndex: 2, alreadySeated: false, roundSeq: current.roundSeq, bettingClosesAt: current.bettingClosesAt }),
      leave: async () => ({ ok: true, left: true, lockedBet: null }),
      placeBet: async (_tableId, body) => {
        h.betCalls.push({ ...body });
        return await h.betImpl(body) as never;
      },
      cancelBet: async () => ({ ok: true, cancelled: true }),
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isHidden: () => hidden,
  };
  return h;
}

afterEach(() => {
  stopBaccaratTablePolling();
});

describe('shared baccarat table controller', () => {
  test('countdown uses bettingClosesAt and the serverNow clock offset', async () => {
    // The local clock runs 10 s BEHIND the server.
    const h = harness(makeTable({ serverNow: 1_010_000, bettingClosesAt: 1_018_000 }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    const state = useBaccaratTableController.getState();
    expect(state.clockOffsetMs).toBe(10_000);
    expect(bettingMsLeft(state.table, state.clockOffsetMs, h.clock.now())).toBe(8_000);
    expect(bettingMsLeft(state.table, state.clockOffsetMs, h.clock.now() + 3_000)).toBe(5_000);
    expect(bettingMsLeft(state.table, state.clockOffsetMs, h.clock.now() + 9_000)).toBe(0);
    expect(bettingMsLeft({ phase: 'reveal', bettingClosesAt: 1_018_000 }, 10_000, h.clock.now())).toBe(0);
  });

  test('fires one extra GET 1200 ms after the countdown reaches 0', async () => {
    // Spectator (3000 ms poll); window closes 500 ms after the first read.
    const h = harness(makeTable({ bettingClosesAt: 1_000_500 }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    expect(h.getCalls).toEqual([1_000_000]);
    await h.clock.advance(500 + CLOSE_REFETCH_DELAY_MS);
    expect(h.getCalls).toEqual([1_000_000, 1_000_000 + 500 + CLOSE_REFETCH_DELAY_MS]);
    // The table still says betting on the same round: no second extra GET,
    // only the normal spectator cadence.
    await h.clock.advance(SPECTATOR_POLL_MS);
    expect(h.getCalls.length).toBe(3);
    expect(h.getCalls[2]! - h.getCalls[1]!).toBe(SPECTATOR_POLL_MS);
  });

  test('polls every 3000 ms as a spectator and every 1500 ms when seated', async () => {
    const h = harness(makeTable({ phase: 'idle', bettingClosesAt: null }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    await h.clock.advance(SPECTATOR_POLL_MS * 2);
    expect(h.getCalls).toEqual([1_000_000, 1_003_000, 1_006_000]);

    h.setTable(makeTable({ phase: 'idle', bettingClosesAt: null, me: seatedMe() }));
    await h.clock.advance(SPECTATOR_POLL_MS); // this poll returns the seated state
    const seatedAt = h.getCalls[h.getCalls.length - 1]!;
    await h.clock.advance(SEATED_POLL_MS * 2);
    expect(h.getCalls.slice(-3)).toEqual([seatedAt, seatedAt + SEATED_POLL_MS, seatedAt + 2 * SEATED_POLL_MS]);
  });

  test('stops polling while the tab is hidden and fetches once on return', async () => {
    const h = harness(makeTable({ phase: 'idle', bettingClosesAt: null }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    expect(h.getCalls.length).toBe(1);

    h.setHidden(true);
    handleBaccaratTableVisibility();
    await h.clock.advance(SPECTATOR_POLL_MS * 5);
    expect(h.getCalls.length).toBe(1);

    h.setHidden(false);
    handleBaccaratTableVisibility();
    await flush();
    expect(h.getCalls.length).toBe(2);
    await h.clock.advance(SPECTATOR_POLL_MS);
    expect(h.getCalls.length).toBe(3);
  });

  test('a timer that fires while hidden does not fetch', async () => {
    const h = harness(makeTable({ phase: 'idle', bettingClosesAt: null }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    h.setHidden(true); // no visibilitychange delivered yet
    await h.clock.advance(SPECTATOR_POLL_MS * 3);
    expect(h.getCalls.length).toBe(1);
  });

  test('a new lastRound.roundSeq starts the reveal once', async () => {
    const h = harness(makeTable({
      phase: 'reveal',
      bettingClosesAt: null,
      nextBettingOpensAt: 1_004_000,
      roundSeq: 8,
      lastRound: makeRound(7),
      me: seatedMe(),
    }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    let state = useBaccaratTableController.getState();
    expect(state.revealedRoundSeq).toBe(7);
    expect(state.revealedStep).toBe(0);
    expect(state.dealSteps.length).toBe(4);
    expect(sharedFeltView(state).phase).toBe('revealing');

    await h.clock.advance(SHARED_REVEAL_STEP_MS * 2);
    expect(useBaccaratTableController.getState().revealedStep).toBe(2);

    // Next poll returns the same round: the reveal keeps going, no restart.
    await h.clock.advance(SEATED_POLL_MS - SHARED_REVEAL_STEP_MS * 2);
    state = useBaccaratTableController.getState();
    expect(h.getCalls.length).toBe(2);
    expect(state.revealedStep).toBe(4);
    await h.clock.advance(SHARED_FINAL_REVEAL_STAGE_MS);
    state = useBaccaratTableController.getState();
    expect(state.revealDone).toBe(true);
    expect(sharedFeltView(state).phase).toBe('settled');
    expect(sharedFeltView(state).bannerText).toBe('BANKER WINS');
    expect(state.revealedStep).toBe(4);

    // A later round starts a fresh reveal from step 0.
    h.setTable(makeTable({
      phase: 'reveal',
      bettingClosesAt: null,
      nextBettingOpensAt: 1_020_000,
      roundSeq: 9,
      lastRound: makeRound(8, { winner: 'player' }),
      me: seatedMe(),
    }));
    await h.clock.advance(SEATED_POLL_MS);
    state = useBaccaratTableController.getState();
    expect(state.revealedRoundSeq).toBe(8);
    expect(state.revealDone).toBe(false);
    expect(state.revealedStep).toBeLessThan(4);
  });

  test('an old result seen first during betting never animates and the felt stays clear', async () => {
    const h = harness(makeTable({ phase: 'betting', roundSeq: 8, lastRound: makeRound(7) }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    const state = useBaccaratTableController.getState();
    expect(state.revealedRoundSeq).toBe(7);
    expect(state.revealCoup).toBeNull();
    expect(sharedFeltView(state).coup).toBeNull();
    expect(sharedFeltView(state).phase).toBe('idle');
  });

  test('stale_round refetches the table and retries the bet exactly once', async () => {
    const h = harness(makeTable({ roundSeq: 7, me: seatedMe() }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    let first = true;
    h.betImpl = async (body) => {
      if (first) {
        first = false;
        h.setTable(makeTable({ roundSeq: 8, bettingClosesAt: 1_020_000, me: seatedMe() }));
        throw new CoveApiError(409, 'stale_round', 'stale_round');
      }
      h.setTable(makeTable({
        roundSeq: 8,
        bettingClosesAt: 1_020_000,
        me: { ...seatedMe(), currentBet: { roundSeq: body.roundSeq, bet: 'banker', stake: body.stake } },
      }));
      return { ok: true, ...body, seatIndex: 2, bettingClosesAt: 1_020_000 };
    };
    const getsBefore = h.getCalls.length;
    await useBaccaratTableController.getState().bet('banker', 20);
    await flush();
    expect(h.betCalls).toEqual([
      { roundSeq: 7, bet: 'banker', stake: 20 },
      { roundSeq: 8, bet: 'banker', stake: 20 },
    ]);
    expect(h.getCalls.length).toBeGreaterThan(getsBefore);
    const state = useBaccaratTableController.getState();
    expect(state.inFlight).toBeNull();
    expect(state.table?.me?.currentBet).toEqual({ roundSeq: 8, bet: 'banker', stake: 20 });
  });

  test('a second stale_round is not retried again and shows a toast', async () => {
    const h = harness(makeTable({ roundSeq: 7, me: seatedMe() }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    h.betImpl = async () => {
      throw new CoveApiError(409, 'stale_round', 'stale_round');
    };
    await useBaccaratTableController.getState().bet('player', 10);
    await flush();
    expect(h.betCalls.length).toBe(2);
    const state = useBaccaratTableController.getState();
    expect(state.inFlight).toBeNull();
    expect(state.toast?.tone).toBe('warn');
  });

  test('no bet is sent after the local countdown reached 0', async () => {
    const h = harness(makeTable({ bettingClosesAt: 1_001_000, me: seatedMe() }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    h.clock.t += 1_000; // countdown now 0, before any extra GET
    await useBaccaratTableController.getState().bet('tie', 5);
    expect(h.betCalls.length).toBe(0);
  });

  test('a GET sent before the bet that resolves after the echo does not hide the bet', async () => {
    const h = harness(makeTable({ roundSeq: 7, me: seatedMe() }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    await flush();
    expect(h.getCalls.length).toBe(1);

    // Every later GET waits until the test resolves it.
    const pending: Array<(table: BaccaratTablePublicState) => void> = [];
    h.getImpl = () => new Promise<BaccaratTablePublicState>((resolve) => { pending.push(resolve); });

    // GET #2 starts BEFORE the bet and stays in flight.
    void refreshBaccaratTable();
    await flush();
    expect(pending.length).toBe(1);

    await useBaccaratTableController.getState().bet('banker', 20);
    await flush();
    const echo = { roundSeq: 7, bet: 'banker' as const, stake: 20 };
    expect(useBaccaratTableController.getState().table?.me?.currentBet).toEqual(echo);
    // GET #3 is the one sent after the bet; it is still in flight too.
    expect(pending.length).toBe(2);

    // GET #2 resolves now with the pre-bet state (no bet on the felt).
    pending[0]!(makeTable({ roundSeq: 7, me: seatedMe() }));
    await flush();
    expect(useBaccaratTableController.getState().table?.me?.currentBet).toEqual(echo);

    // GET #3 carries the server's view of the bet and applies.
    pending[1]!(makeTable({
      roundSeq: 7,
      me: { ...seatedMe(), balance: 480, currentBet: { roundSeq: 7, bet: 'banker', stake: 20 } },
    }));
    await flush();
    const state = useBaccaratTableController.getState();
    expect(state.table?.me?.currentBet).toEqual(echo);
    expect(state.table?.me?.balance).toBe(480);
  });

  test('stop drops in-flight responses and clears every timer', async () => {
    const h = harness(makeTable({ phase: 'idle', bettingClosesAt: null }));
    startBaccaratTablePolling(TABLE_ID, h.deps);
    stopBaccaratTablePolling();
    await flush();
    await h.clock.advance(SPECTATOR_POLL_MS * 3);
    expect(h.getCalls.length).toBe(1);
  });
});

/*
 * Layout and contrast guards for the shared HUD + lobby (R4 fix pass). These
 * read the CSS / TSX as text (same pattern as hud-layout.test.tsx). They pin
 * the rules; only a browser proves the pixels.
 */
const CHAT_BAR_TOP = 'max(70px, env(safe-area-inset-top) + 58px)';

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

function cssBlock(css: string, selector: string): { body: string; index: number } {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`missing CSS block: ${selector}`);
  return { body: match[1]!, index: match.index };
}

function cssValue(block: string, property: string): string | null {
  const match = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1]!.trim() : null;
}

describe('shared baccarat HUD layout guards', () => {
  const hudCss = readSource('../../../components/cove/baccarat/SharedBaccaratHud.module.css');
  const lobbyCss = readSource('../../../components/cove/baccarat/BaccaratTableLobby.module.css');
  const hudTsx = readSource('../../../components/cove/baccarat/SharedBaccaratHud.tsx');

  test('phone layouts start the ring, hands and seat rail below the table chat bar', () => {
    expect(cssValue(cssBlock(hudCss, '.phonePortrait .ring').body, 'top'))
      .toBe(`calc(${CHAT_BAR_TOP} + 52px)`);
    expect(cssValue(cssBlock(hudCss, '.phonePortrait .hands').body, 'top'))
      .toBe(`calc(${CHAT_BAR_TOP} + 144px)`);
    expect(cssValue(cssBlock(hudCss, '.phoneLandscape .seatRail').body, 'top'))
      .toBe(`calc(${CHAT_BAR_TOP} + 52px)`);
  });

  test('a disabled primary button keeps light text on a muted background, no opacity', () => {
    const hudDisabled = cssBlock(hudCss, '.primary:disabled');
    expect(hudDisabled.index).toBeGreaterThan(cssBlock(hudCss, '.button:disabled,\n.betSpot:disabled,\n.chip:disabled').index);
    expect(cssValue(hudDisabled.body, 'opacity')).toBe('1');
    expect(cssValue(hudDisabled.body, 'color')).toBe('#c9bba6');
    expect(cssValue(hudDisabled.body, 'background')).toBe('#3a2d36');

    const lobbyDisabled = cssBlock(lobbyCss, '.primaryButton:disabled');
    expect(lobbyDisabled.index).toBeGreaterThan(cssBlock(lobbyCss, '.primaryButton:disabled,\n.secondaryButton:disabled').index);
    expect(cssValue(lobbyDisabled.body, 'opacity')).toBe('1');
    expect(cssValue(lobbyDisabled.body, 'color')).toBe('#c9bba6');
    expect(cssValue(lobbyDisabled.body, 'background')).toBe('#3a2d36');
  });

  test('the Fairness dialog portals into document.body after mount, above the chat bar', () => {
    expect(hudTsx).toContain("import { createPortal } from 'react-dom';");
    expect(hudTsx).toMatch(/fairnessOpen && mounted && createPortal\(/);
    expect(hudTsx).toMatch(/<\/div>,\s*document\.body,\s*\)\}/);
    const zIndex = Number(cssValue(cssBlock(hudCss, '.dialogBackdrop').body, 'z-index'));
    expect(zIndex).toBeGreaterThanOrEqual(80);
  });
});
