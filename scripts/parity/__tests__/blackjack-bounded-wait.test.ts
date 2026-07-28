import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Driver } from '../driver';
import { submitBlackjackHitAndWait } from '../scenarios/runtime';

class HitProgressDriver implements Driver {
  readonly waits: string[] = [];
  readonly actions: string[] = [];

  async evalJson<T>(js: string): Promise<T> {
    if (js.includes('CV_BLACKJACK_HIT_READY')) {
      return { terminal: false, actionSeq: 4 } as T;
    }
    if (js.includes('CV_ACTION_REVISION_FLOOR')) {
      return { revision: 8, correlationHand: 'hand-1' } as T;
    }
    if (js.includes('CV_BLACKJACK_HIT_PROGRESS')) {
      return {
        terminal: false,
        newerRevision: false,
        hitEnabled: true,
        actionStatus: 200,
      } as T;
    }
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labelsSource) {
      this.actions.push(String((JSON.parse(labelsSource) as string[])[0]));
      return true as T;
    }
    throw new Error(`Unexpected eval: ${js.slice(0, 80)}`);
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

describe('blackjack bounded action waits', () => {
  test('a pending Hit waits for a response/revision/terminal proof', async () => {
    const driver = new HitProgressDriver();
    expect(await submitBlackjackHitAndWait(
      driver,
      'blackjack-2d',
      'hand-1',
    )).toEqual({ revision: 8, correlationHand: 'hand-1' });
    expect(driver.actions).toEqual(['Hit']);
    expect(driver.waits[0]).toContain("startsWith('Hit') && !button.disabled");
    expect(driver.waits[1]).toContain('response.status >= 200');
    expect(driver.waits[1]).toContain('newerRevision');
    expect(driver.waits[1]).toContain('terminal');
  });

  test('B-neg/B5 no longer use fixed 100/120ms sleeps', () => {
    const source = readFileSync(
      new URL('../scenarios/runtime.ts', import.meta.url),
      'utf8',
    );
    const blackjackStart = source.indexOf(
      "if (game === 'blackjack')",
      source.indexOf('export async function* driveScenario'),
    );
    const baccaratStart = source.indexOf(
      "if (game === 'baccarat')",
      blackjackStart,
    );
    const blackjackDrive = source.slice(blackjackStart, baccaratStart);
    expect(blackjackDrive).not.toContain('setTimeout(resolveWait, 100)');
    expect(blackjackDrive).not.toContain('setTimeout(resolveWait, 120)');
  });
});
