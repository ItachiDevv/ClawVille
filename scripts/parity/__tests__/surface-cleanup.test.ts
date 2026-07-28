import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Driver } from '../driver';
import { preflight } from '../preflight';

class SurfaceCleanupDriver implements Driver {
  readonly scripts: string[] = [];
  readonly waits: string[] = [];
  readonly actions: string[] = [];
  private browserRequests = 0;
  private blackjackSettled = false;
  private rootPresent = true;

  async evalJson<T>(js: string): Promise<T> {
    this.scripts.push(js);
    if (js.includes('const text = await response.text()')) {
      this.browserRequests += 1;
      return {
        status: this.browserRequests === 1 ? 200 : 404,
        body: null,
      } as T;
    }
    if (js.includes('Boolean(document.querySelector')) return true as T;
    if (js.includes('return response.status')) return 404 as T;
    if (js.includes('?.renderRevision ?? 0')) return 7 as T;
    if (js.includes("?.dealStep === 'settled'")) {
      return this.blackjackSettled as T;
    }
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labelsSource) {
      const labels = JSON.parse(labelsSource) as string[];
      const action = labels[0]!;
      this.actions.push(action);
      if (action === 'Stand') this.blackjackSettled = true;
      if (action === 'Walk Away') this.rootPresent = false;
      return true as T;
    }
    return this.rootPresent as T;
  }

  async waitFn(js: string): Promise<void> {
    this.waits.push(js);
  }

  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('surface-aware preflight cleanup', () => {
  test('reconciles a nonterminal B1-style blackjack-2d hand', async () => {
    const driver = new SurfaceCleanupDriver();
    const result = await preflight(
      driver,
      'blackjack',
      'blackjack-2d',
      'http://api.test',
    );
    expect(result).toEqual({ clean: true, notes: [] });
    expect(driver.actions).toEqual(['Stand', 'Walk Away']);
    expect(driver.scripts.join('\n')).toContain(
      '[aria-label=\\"Blackjack table\\"]',
    );
    expect(driver.waits.join('\n')).toContain("blackjack-2d");
    expect(driver.waits.join('\n')).toContain("root.transition === 'idle'");
    expect(driver.waits.join('\n')).toContain(
      "['Stand', 'Surrender']",
    );
  });

  test('3D blackjack teardown does not accept enabled Walk Away mid-hand', async () => {
    const driver = new SurfaceCleanupDriver();
    const result = await preflight(
      driver,
      'blackjack',
      'blackjack-3d',
      'http://api.test',
    );
    expect(result).toEqual({ clean: true, notes: [] });
    const settleWait = driver.waits.find((script) =>
      script.includes('const closeEnabled')
    );
    expect(settleWait).toBeDefined();
    const evaluate = new Function(
      'window',
      'document',
      `return ${settleWait};`,
    ) as (windowValue: unknown, documentValue: unknown) => boolean;
    expect(evaluate(
      {
        __CV_READ_PARITY: () => ({
          dealStep: 'player-turn',
          transition: 'idle',
        }),
      },
      {
        querySelectorAll: () => [{
          textContent: 'Walk Away',
          disabled: false,
        }],
      },
    )).toBe(false);
  });

  test('closes a settled baccarat-2d coup and proves session absence', async () => {
    const driver = new SurfaceCleanupDriver();
    const result = await preflight(
      driver,
      'baccarat',
      'baccarat-2d',
      'http://api.test',
    );
    expect(result).toEqual({ clean: true, notes: [] });
    expect(driver.actions).toEqual(['Walk Away']);
    expect(driver.scripts.join('\n')).toContain(
      '[aria-label=\\"Baccarat table\\"]',
    );
    expect(driver.waits.join('\n')).toContain("baccarat-2d");
    expect(driver.waits.join('\n')).toContain("root.dealStep === 'settled'");
  });

  test('idle authenticated surface cleanup retains the labeled close fallback', () => {
    const source = readFileSync(
      new URL('../teardown.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("'Close blackjack table'");
    expect(source).toContain("'Close baccarat table'");
    expect(source).toContain('waitForClosedStatus');
  });
});
