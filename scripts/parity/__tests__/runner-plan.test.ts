import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  agentBrowserExecutable,
  createOneShotStatePath,
  serializeAgentBrowserEval,
  type Driver,
  waitForParityCheckpoint,
} from '../driver';
import {
  fixtureTeardownRunsFirst,
  requiresGuestShoeReset,
  requiresFixtureOwnerPreflight,
  resolveScenarioState,
} from '../runner-env';
import {
  driveScenario,
  isActiveHoldemCorrelation,
  isMatchingHoldemShowdown,
  nextJournalStep,
  reachedFor,
  shouldEndBlackjackNegativeTraversal,
  shouldEndHoldemNegativeTraversal,
} from '../scenarios/runtime';
import { closeFixtureRun } from '../teardown';

class PlanDriver implements Driver {
  actions: string[] = [];
  async evalJson<T>(js: string): Promise<T> {
    if (js.includes('__CV_READ_PARITY')) return 'showdown' as T;
    const labels = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labels) this.actions.push(JSON.parse(labels)[0]);
    return true as T;
  }
  async waitFn(): Promise<void> {}
  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

class PracticePlanDriver extends PlanDriver {
  private revision = 4;
  private stepIndex = 0;
  override async evalJson<T>(js: string): Promise<T> {
    if (js.includes('CV_PRACTICE_HAND')) {
      return 'practice-hand' as T;
    }
    if (js.includes('CV_PRACTICE_EXISTING_STEP')) {
      return false as T;
    }
    if (js.includes('CV_PRACTICE_ACTION_CLICK')) {
      const action = this.stepIndex === 0 ? 'Call 2 vCLAW' : 'Check';
      this.actions.push(action.split(' ')[0]!);
      return {
        clicked: true,
        label: action,
        actionSeq: this.stepIndex,
        renderRevision: this.revision,
        dealStep: this.stepIndex === 0 ? 'hole' : 'flop',
        correlationHand: 'practice-hand',
        actions: ['Fold', action],
      } as T;
    }
    if (js.includes('CV_PRACTICE_ACTION_PROGRESS')) {
      this.stepIndex += 1;
      this.revision += 1;
      return {
        actionSeen: true,
        actionStatus: 200,
        expectedRevision: this.revision,
        renderRevision: this.revision,
        dealStep: this.stepIndex === 1 ? 'flop' : 'turn',
        correlationHand: 'new-current-hand-after-staged-step',
        actions: ['Fold', 'Check'],
      } as T;
    }
    return super.evalJson<T>(js);
  }
}

class CashPlanDriver extends PlanDriver {
  override async evalJson<T>(js: string): Promise<T> {
    if (js.includes("startsWith('Walk Away')")) return false as T;
    return super.evalJson<T>(js);
  }
}

async function consume(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _value of generator) {
    // advancing the generator executes the next declarative action
  }
}

describe('offline live-runner plans', () => {
  test('async browser eval awaits promise values before JSON serialization', () => {
    const expression = serializeAgentBrowserEval('(async () => ({ ok: true }))()');
    expect(expression).toContain('Promise.resolve(');
    expect(expression).toContain('.then((value) => JSON.stringify(value))');
  });

  test('Windows resolves the native executable rather than an unspawnable .cmd', () => {
    if (process.platform === 'win32') {
      expect(agentBrowserExecutable().endsWith('agent-browser-win32-x64.exe')).toBe(true);
    }
  });

  test('saved browser state is consumed only by the first command', () => {
    const takeStatePath = createOneShotStatePath('live.state.json');
    expect(takeStatePath()).toBe('live.state.json');
    expect(takeStatePath()).toBeNull();
    expect(takeStatePath()).toBeNull();
  });

  test('B4 stands, B8 completes both subhands, B9 insures, H6 folds', async () => {
    const b4 = new PlanDriver();
    await consume(driveScenario(
      'blackjack',
      'B4',
      'blackjack-3d',
      ['dealer-reveal', 'settled'],
      b4,
    ));
    expect(b4.actions).toContain('Deal');
    expect(b4.actions).toContain('Stand');

    const b8 = new PlanDriver();
    await consume(driveScenario(
      'blackjack',
      'B8',
      'blackjack-3d',
      ['hole', 'player-turn', 'split', 'player-turn', 'dealer-reveal', 'settled'],
      b8,
    ));
    expect(b8.actions).toContain('Split');
    expect(b8.actions.filter((action) => action === 'Stand')).toHaveLength(2);

    const b9 = new PlanDriver();
    await consume(driveScenario(
      'blackjack',
      'B9',
      'blackjack-2d',
      ['hole', 'player-turn', 'settled'],
      b9,
    ));
    expect(b9.actions).toContain('Insure');

    const h6 = new PlanDriver();
    await consume(driveScenario(
      'holdem',
      'H6',
      'holdem-felt-practice',
      ['showdown', 'muck-fading', 'idle'],
      h6,
    ));
    expect(h6.actions).toContain('Fold');
    expect(h6.actions).not.toContain('Check');
  });

  test('H2-H4 advance practice streets with Check/Call and never Fold', async () => {
    const h3 = new PracticePlanDriver();
    await consume(driveScenario(
      'holdem',
      'H3',
      'holdem-tray-practice',
      ['hole', 'flop', 'turn'],
      h3,
    ));
    expect(h3.actions).toEqual(['Call', 'Check']);
    expect(h3.actions).not.toContain('Fold');
  });

  test('H8 cash opens and hydrates the exact seat before its checkpoint', async () => {
    const h8 = new CashPlanDriver();
    await consume(driveScenario(
      'holdem',
      'H8',
      'holdem-tray-3d',
      ['hole'],
      h8,
    ));
    expect(h8.actions.slice(0, 2)).toEqual([
      'Sit down',
      'Confirm buy-in',
    ]);
  });

  test('fixture guest, live identity, and cash table requirements stay distinct', () => {
    expect(resolveScenarioState(
      { game: 'blackjack', tier: 'guest', fixtureName: 'bj-split' },
      { CV_PARITY_GUEST_AUTH_STATE: 'guest.state.json' },
    )).toEqual({ statePath: 'guest.state.json', cashTableId: null });
    expect(resolveScenarioState(
      { game: 'blackjack', tier: 'live', fixtureName: 'bj-split' },
      { CV_PARITY_AUTH_STATE: 'live.state.json' },
    )).toEqual({ statePath: 'live.state.json', cashTableId: null });
    expect(() => resolveScenarioState(
      { game: 'blackjack', tier: 'guest', fixtureName: 'bj-split' },
      { CV_PARITY_AUTH_STATE: 'must-not-be-reused.state.json' },
    )).toThrow('dedicated CV_PARITY_GUEST_AUTH_STATE');
    expect(() => resolveScenarioState(
      { game: 'holdem', tier: 'live' },
      { CV_PARITY_AUTH_STATE: 'live.state.json' },
    )).toThrow('CV_PARITY_CASH_TABLE_ID');
  });

  test('fixture owner recovery is isolated from organic live rows', () => {
    expect(requiresFixtureOwnerPreflight({
      fixtureName: 'bac-player-third',
    })).toBe(true);
    expect(requiresFixtureOwnerPreflight({
      fixtureName: undefined,
    })).toBe(false);
  });

  test('fixture shoes/practice close before document-replacing UI teardown', () => {
    expect(fixtureTeardownRunsFirst({
      game: 'baccarat',
      tier: 'live',
      fixtureName: 'bac-player-third',
    })).toBe(true);
    expect(fixtureTeardownRunsFirst({
      game: 'blackjack',
      tier: 'live',
      fixtureName: 'bj-split',
    })).toBe(true);
    expect(fixtureTeardownRunsFirst({
      game: 'holdem',
      tier: 'guest',
      fixtureName: 'holdem-fold-win',
    })).toBe(true);
    expect(fixtureTeardownRunsFirst({
      game: 'holdem',
      tier: 'live',
      fixtureName: 'holdem-multiway-showdown',
    })).toBe(false);
  });

  test('standalone guest shoe fixtures reset stale demo shoes before arming', () => {
    expect(requiresGuestShoeReset({
      game: 'baccarat',
      tier: 'guest',
      fixtureName: 'bac-player-natural',
    })).toBe(true);
    expect(requiresGuestShoeReset({
      game: 'blackjack',
      tier: 'guest',
      fixtureName: 'bj-natural',
    })).toBe(true);
    expect(requiresGuestShoeReset({
      game: 'holdem',
      tier: 'guest',
      fixtureName: 'holdem-fold-win',
    })).toBe(false);
    expect(requiresGuestShoeReset({
      game: 'baccarat',
      tier: 'live',
      fixtureName: 'bac-player-third',
    })).toBe(false);
  });

  test('fixture teardown rejects a non-2xx delete result', async () => {
    const driver = new PlanDriver();
    driver.evalJson = async <T>() => ({
      closed: false,
      status: 500,
      code: 'fixture_cleanup_failed',
      message: 'recorded failure',
    }) as T;
    expect(closeFixtureRun(
      driver,
      { runId: 'recorded-run' },
      'http://127.0.0.1:4002',
    )).rejects.toThrow(
      'HTTP 500, code=fixture_cleanup_failed, message=recorded failure',
    );
  });

  test('negative traversal calls the landed surface journal accessor', async () => {
    const surfaces: string[] = [];
    const driver = new PlanDriver();
    driver.evalJson = async <T>(js: string) => new Function(
      'window',
      `return ${js}`,
    )({
      __CV_PARITY_JOURNAL: (surface: string) => {
        surfaces.push(surface);
        return [
          {
            surface,
            revision: 2,
            dealStep: 'turn',
            signature: JSON.stringify([surface, 2, 'hand-callable']),
          },
        ];
      },
    }) as T;
    expect(await nextJournalStep(
      driver,
      'holdem-tray-practice',
      1,
      'hand-callable',
    )).toEqual({ revision: 2, dealStep: 'turn' });
    expect(surfaces).toEqual(['holdem-tray-practice']);
  });

  test('cash negative traversal accepts showdown or an observed hand boundary', () => {
    expect(shouldEndHoldemNegativeTraversal(
      { dealStep: 'turn', correlation: { hand: 'hand-a' } },
      'hand-a',
    )).toBe(false);
    expect(shouldEndHoldemNegativeTraversal(
      { dealStep: 'showdown', correlation: { hand: 'hand-a' } },
      'hand-a',
    )).toBe(true);
    expect(shouldEndHoldemNegativeTraversal(
      { dealStep: 'hole', correlation: { hand: 'hand-b' } },
      'hand-a',
    )).toBe(true);
  });

  test('blackjack negative traversal accepts settlement or a hand boundary', () => {
    expect(shouldEndBlackjackNegativeTraversal(
      { dealStep: 'player-turn', correlation: { hand: 'hand-a' } },
      'hand-a',
    )).toBe(false);
    expect(shouldEndBlackjackNegativeTraversal(
      { dealStep: 'settled', correlation: { hand: 'hand-a' } },
      'hand-a',
    )).toBe(true);
    expect(shouldEndBlackjackNegativeTraversal(
      { dealStep: 'hole', correlation: { hand: 'hand-b' } },
      'hand-a',
    )).toBe(true);
  });

  test('checkpoint journal selection filters by expected hand correlation', async () => {
    const signature = (hand: string) => JSON.stringify([
      'holdem-tray-practice',
      2,
      hand,
      1,
      '',
      'flop',
      'player-turn',
      'dealing',
      [],
      [],
    ]);
    const driver = new PlanDriver();
    driver.evalJson = async <T>() => [
      {
        surface: 'holdem-tray-practice',
        instanceId: 'wrong',
        revision: 2,
        dealStep: 'flop',
        transition: 'dealing',
        signature: signature('wrong-hand'),
        ts: 1,
      },
      {
        surface: 'holdem-tray-practice',
        instanceId: 'wanted',
        revision: 3,
        dealStep: 'flop',
        transition: 'dealing',
        signature: signature('wanted-hand'),
        ts: 2,
      },
    ] as T;
    const root = await waitForParityCheckpoint(
      driver,
      {
        label: 'flop-2',
        surface: 'holdem-tray-practice',
        expectRevisionAdvance: true,
        expectDealStep: 'flop',
        expectCorrelationHand: 'wanted-hand',
      },
      0,
    );
    expect(root.correlation.hand).toBe('wanted-hand');
    expect(root.renderRevision).toBe(3);
  });

  test('checkpoint journal selection can pin one immutable revision', async () => {
    const signature = (dealStep: string) => JSON.stringify([
      'holdem-tray-practice',
      2,
      'same-hand',
      1,
      '',
      dealStep,
      'player-turn',
      'revealing',
      [],
      [],
    ]);
    const entries = [
      {
        surface: 'holdem-tray-practice',
        instanceId: 'same',
        revision: 2,
        dealStep: 'flop',
        transition: 'revealing',
        signature: signature('flop'),
        ts: 1,
      },
      {
        surface: 'holdem-tray-practice',
        instanceId: 'same',
        revision: 4,
        dealStep: 'turn',
        transition: 'revealing',
        signature: signature('turn'),
        ts: 2,
      },
    ];
    const driver = new PlanDriver();
    driver.evalJson = async <T>() => entries as T;
    const root = await waitForParityCheckpoint(
      driver,
      {
        label: 'every-step-2',
        surface: 'holdem-tray-practice',
        expectRevisionAdvance: true,
        expectRenderRevision: 4,
        expectCorrelationHand: 'same-hand',
      },
      0,
    );
    expect(root.renderRevision).toBe(4);
  });

  test('practice street reach reads the landed session/current hand shape', () => {
    const wire = {
      hand: {
        humanHole: [{ rank: 'A', suit: 's' }, { rank: 'K', suit: 's' }],
        board: [
          { rank: '2', suit: 'c' },
          { rank: '3', suit: 'd' },
          { rank: '4', suit: 'h' },
        ],
      },
    };
    expect(reachedFor('holdem', 'H2')(wire)).toBe(true);
    expect(reachedFor('holdem', 'H3')(wire)).toBe(false);
  });

  test('Holdem showdown drive ignores idle and cross-hand correlations', () => {
    expect(isActiveHoldemCorrelation({
      correlation: { hand: 'practice:idle', handNumber: null },
    })).toBe(false);
    expect(isActiveHoldemCorrelation({
      correlation: { hand: 'hand-1', handNumber: 1 },
    })).toBe(true);
    expect(isMatchingHoldemShowdown({
      dealStep: 'showdown',
      correlationHand: 'hand-2',
    }, 'hand-1')).toBe(false);
    expect(isMatchingHoldemShowdown({
      dealStep: 'showdown',
      correlationHand: 'hand-1',
    }, 'hand-1')).toBe(true);
  });

  test('visible settlement probes run before checkpoint screenshots', () => {
    const source = readFileSync(
      new URL('../run-parity.ts', import.meta.url),
      'utf8',
    );
    const visibleProbe = source.indexOf('const visible = await assertVisibleSurface');
    const screenshot = source.indexOf('await driver.screenshot(screenshot)');
    expect(visibleProbe).toBeGreaterThan(-1);
    expect(screenshot).toBeGreaterThan(-1);
    expect(visibleProbe).toBeLessThan(screenshot);
  });

  test('showdown drive pins the mounted settlement witness to its revision', () => {
    const source = readFileSync(
      new URL('../scenarios/runtime.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('window.__CV_HOLDEM_SETTLEMENT_WITNESS = {');
    expect(source).toContain('revision: entry.revision');
    expect(source).toContain(`correlationHand: \${JSON.stringify(correlationHand)}`);
    expect(source).toContain(`'[data-testid="holdem-settlement-narration"]'`);
  });

  test('felt settlement replay keeps immutable showdown to muck journal order', () => {
    const source = readFileSync(
      new URL('../run-parity.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(`checkpoint.surface.includes('-felt-')`);
    expect(source).toContain(`scenario.phases.includes('muck-fading')`);
    expect(source).toContain(`root.transition === 'muck-fading'`);
    expect(source).toContain('Math.max(after, root.renderRevision - 1)');
  });

  test('holdem settlement visibility is captured before transient felt replay', () => {
    const source = readFileSync(
      new URL('../run-parity.ts', import.meta.url),
      'utf8',
    );
    const firstCapture = source.indexOf(`if (scenario.game === 'holdem') {
        await captureTerminalSurface();`);
    const transientLoop = source.indexOf(
      'while (!result.pass && Date.now() < settleDeadline)',
    );
    expect(firstCapture).toBeGreaterThan(-1);
    expect(firstCapture).toBeLessThan(transientLoop);
    expect(source).toContain('holdemTerminalVisibleCaptured = true');
  });

  test('H7 practice reach recognizes authoritative blind log types only', () => {
    const dealtWithBlinds = {
      humanHole: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ],
      publicActionLog: [
        { seat: 1, street: 'preflop', type: 'post-sb', amount: '1' },
        { seat: 2, street: 'preflop', type: 'post-bb', amount: '2' },
      ],
    };
    const dealtWithoutBlindOrPot = {
      humanHole: dealtWithBlinds.humanHole,
      publicActionLog: [
        { seat: 1, street: 'preflop', type: 'check', amount: '0' },
      ],
    };

    expect(reachedFor('holdem', 'H7')(dealtWithBlinds)).toBe(true);
    expect(reachedFor('holdem', 'H7')(dealtWithoutBlindOrPot)).toBe(false);
  });

  test('cash felt negative reach uses the public seat projection', () => {
    const wire = {
      live: {
        seats: [
          { seatIndex: 0, status: 'active' },
          { seatIndex: 1, status: 'folded' },
        ],
      },
    };
    expect(reachedFor('holdem', 'H-neg', 'holdem-felt-3d')(wire)).toBe(true);
    expect(reachedFor('holdem', 'H-neg', 'holdem-tray-3d')(wire)).toBe(false);
  });
});
