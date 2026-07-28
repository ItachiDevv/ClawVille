import { describe, expect, test } from 'bun:test';
import type { Driver } from '../driver';
import { driveScenario } from '../scenarios/runtime';

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
