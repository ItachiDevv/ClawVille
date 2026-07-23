import { describe, expect, test } from 'bun:test';
import {
  agentBrowserExecutable,
  serializeAgentBrowserEval,
  type Driver,
} from '../driver';
import { resolveScenarioState } from '../runner-env';
import { driveScenario, nextJournalStep } from '../scenarios/runtime';
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

  test('fixture teardown rejects a non-2xx delete result', async () => {
    const driver = new PlanDriver();
    driver.evalJson = async <T>() => false as T;
    expect(closeFixtureRun(
      driver,
      { runId: 'recorded-run' },
      'http://127.0.0.1:4002',
    )).rejects.toThrow(
      'fixture teardown failed',
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
});
