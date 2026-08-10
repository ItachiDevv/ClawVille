import { describe, expect, test } from 'bun:test';
import type { Driver } from '../driver';
import { clickText, driveScenario } from '../scenarios/runtime';

class ButtonTextDriver implements Driver {
  clicks = 0;

  constructor(private readonly buttonText: string) {}

  async evalJson<T>(js: string): Promise<T> {
    const button = {
      textContent: this.buttonText,
      disabled: false,
      click: () => { this.clicks += 1; },
    };
    const document = {
      querySelectorAll: (selector: string) => selector === 'button' ? [button] : [],
    };
    const evaluate = new Function('document', `return (${js});`) as (
      fakeDocument: typeof document,
    ) => T;
    return evaluate(document);
  }

  async waitFn(): Promise<void> {}
  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

class CapturingBaccaratDriver implements Driver {
  private selectedBet: 'player' | 'banker' | 'tie' = 'player';
  readonly requests: Array<{ bet: 'player' | 'banker' | 'tie' }> = [];

  async evalJson<T>(js: string): Promise<T> {
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    const label = labelsSource
      ? String((JSON.parse(labelsSource) as string[])[0])
      : '';
    if (['PLAYER', 'BANKER', 'TIE'].includes(label)) {
      this.selectedBet = label.toLowerCase() as typeof this.selectedBet;
    }
    if (label === 'Deal') {
      this.requests.push({ bet: this.selectedBet });
    }
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

async function drive(row: string, phases: readonly string[]) {
  const driver = new CapturingBaccaratDriver();
  for await (const _checkpoint of driveScenario(
    'baccarat',
    row,
    'baccarat-2d',
    phases,
    driver,
  )) {
    // Resume the driver through every coup.
  }
  return driver.requests;
}

describe('baccarat bet-zone traversal', () => {
  test('frozen PLAYER label matches both 3D and 2D button casing', async () => {
    for (const renderedText of ['Player · 1:1', 'PLAYER']) {
      const driver = new ButtonTextDriver(renderedText);
      expect(await clickText(driver, ['PLAYER'])).toBe(true);
      expect(driver.clicks).toBe(1);
    }
  });

  test('C5 captures a tie coup request', async () => {
    expect(await drive('C5', ['settled'])).toEqual([{ bet: 'tie' }]);
  });

  test('C7 captures a banker coup request', async () => {
    expect(await drive('C7', ['settled'])).toEqual([{ bet: 'banker' }]);
  });

  test('C6 captures player, banker, tie in order', async () => {
    expect(await drive('C6', [
      'settled-player',
      'settled-banker',
      'settled-tie',
    ])).toEqual([
      { bet: 'player' },
      { bet: 'banker' },
      { bet: 'tie' },
    ]);
  });

  test('a missing required bet-zone click throws', async () => {
    const driver = new CapturingBaccaratDriver();
    driver.evalJson = async <T>() => false as T;
    await expect(async () => {
      for await (const _checkpoint of driveScenario(
        'baccarat',
        'C5',
        'baccarat-2d',
        ['settled'],
        driver,
      )) {
        // The required TIE selection must fail before a checkpoint is yielded.
      }
    }).toThrow('Action disappeared before click: TIE');
  });
});
