import { describe, expect, test } from 'bun:test';
import { clipBoardText, createBoardCanvasWriter } from './brainchain-board-canvas';

function canvas() {
  const text: string[] = [];
  let clears = 0;
  const ctx = {
    fillRect: () => { clears++; text.length = 0; },
    strokeRect: () => {},
    fillText: (value: string) => { text.push(value); },
    measureText: (value: string) => ({ width: value.length * 14 }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, text, clears: () => clears };
}
const summary = { title: 'TASK BOARD', lines: ['No tasks indexed yet'], footer: 'Updated 10:00' };

describe('BrainChain retained board canvases', () => {
  test('redraws only when owner or text changes', async () => {
    const c = canvas(); let uploads = 0;
    const writer = createBoardCanvasWriter(c.ctx, () => uploads++, Promise.resolve());
    writer.update('owner-a', summary);
    await Promise.resolve();
    const previous = uploads;
    expect(writer.update('owner-a', { ...summary, lines: [...summary.lines] })).toBe(false);
    expect(uploads).toBe(previous);
    expect(writer.update('owner-b', summary)).toBe(true);
    expect(uploads).toBe(previous + 1);
  });
  test('account change clears private text and the font callback draws only the latest account', async () => {
    const c = canvas(); let resolve!: () => void;
    const writer = createBoardCanvasWriter(c.ctx, () => {}, new Promise<void>(done => { resolve = done; }));
    writer.update('owner-a', { ...summary, lines: ['private worker'] });
    writer.update(null, { ...summary, lines: ['Sign in to see your workers'] });
    expect(c.clears()).toBe(2);
    expect(c.text).toEqual([]);
    resolve(); await Promise.resolve();
    expect(c.text).toContain('Sign in to see your workers');
    expect(c.text).not.toContain('private worker');
  });
  test('clears an already drawn account immediately', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner-a', { ...summary, lines: ['private worker'] });
    await Promise.resolve();
    writer.update(null, { ...summary, lines: ['Sign in to see your workers'] });
    expect(c.text).not.toContain('private worker');
    expect(c.text).toContain('Sign in to see your workers');
  });
  test('bounds line count and clips long text with an ellipsis', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner', { ...summary, lines: Array.from({ length: 20 }, (_, i) => `${i}: ${'x'.repeat(100)}`) });
    await Promise.resolve();
    expect(c.text).toHaveLength(14);
    expect(c.text[1]!.endsWith('…')).toBe(true);
    expect(c.ctx.measureText(c.text[1]!).width).toBeLessThanOrEqual(914);
    expect(clipBoardText(c.ctx, 'short')).toBe('short');
  });
  test('tolerates a null 2D context', async () => {
    let uploads = 0;
    const writer = createBoardCanvasWriter(null, () => uploads++, Promise.resolve());
    writer.update(null, summary);
    await Promise.resolve();
    expect(uploads).toBe(0);
  });
});
