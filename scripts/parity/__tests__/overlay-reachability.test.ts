import { describe, expect, test } from 'bun:test';
import type { Driver } from '../driver';
import { driveScenario } from '../scenarios/runtime';

class OrderedDriver implements Driver {
  readonly events: string[] = [];

  async evalJson<T>(js: string): Promise<T> {
    if (js.includes('CV_2D_OVERLAY_PAINT')) {
      this.events.push('overlay-paint');
      return true as T;
    }
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labelsSource) {
      this.events.push(
        `click:${String((JSON.parse(labelsSource) as string[])[0])}`,
      );
    }
    return true as T;
  }

  async waitFn(js: string): Promise<void> {
    this.events.push(
      js.includes("style.pointerEvents === 'none'")
        ? 'overlay-transparent'
        : 'action-ready',
    );
  }

  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('2D first-beat reachability', () => {
  test('the overlay is transparent and painted before blackjack Deal', async () => {
    const driver = new OrderedDriver();
    const generator = driveScenario(
      'blackjack',
      'B1',
      'blackjack-2d',
      ['hole'],
      driver,
    );
    await generator.next();
    expect(driver.events.slice(0, 4)).toEqual([
      'overlay-transparent',
      'overlay-paint',
      'action-ready',
      'click:Deal',
    ]);
  });

  test('3D actions do not wait for the 2D overlay', async () => {
    const driver = new OrderedDriver();
    const generator = driveScenario(
      'blackjack',
      'B1',
      'blackjack-3d',
      ['hole'],
      driver,
    );
    await generator.next();
    expect(driver.events).not.toContain('overlay-transparent');
    expect(driver.events.at(-1)).toBe('click:Deal');
  });
});
