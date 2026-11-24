import { describe, expect, test } from 'bun:test';
import { clipBoardText, createBoardCanvasWriter, type BoardCanvasText } from './brainchain-board-canvas';

function canvas() {
  const text: string[] = [];
  let clears = 0;
  const transforms: number[][] = [];
  const ctx = {
    setTransform: (...values: number[]) => { transforms.push(values); },
    fillRect: (_x: number, _y: number, width: number) => { if (width === 1024) { clears++; text.length = 0; } },
    beginPath: () => {}, moveTo: () => {}, arcTo: () => {}, closePath: () => {},
    arc: () => {}, fill: () => {}, stroke: () => {}, drawImage: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    shadowBlur: 0, shadowColor: '', save: () => {}, restore: () => {}, clip: () => {},
    textAlign: 'left', letterSpacing: '0px',
    fillText: (value: string) => { text.push(value); },
    measureText: (value: string) => ({ width: value.length * 14 }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, text, transforms, clears: () => clears };
}
const summary: BoardCanvasText = {
  title: 'JOB BOARD', lines: ['No tasks indexed yet'], footer: 'Income counts only after settlement.', updated: null,
  view: { kind: 'message', heading: 'No tasks indexed yet', body: [], tone: 'neutral' },
};
function message(heading: string): BoardCanvasText {
  return { ...summary, lines: [heading], view: { kind: 'message', heading, body: [], tone: 'neutral' } };
}

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
    expect(writer.update('owner-b', { ...summary, updated: '3:41 PM' })).toBe(true);
    expect(c.text).toContain('UPDATED 3:41 PM');
    expect(writer.update('owner-b', message('New view'))).toBe(true);
    expect(c.text).toContain('New view');
  });
  test('account change clears private text and the font callback draws only the latest account', async () => {
    const c = canvas(); let resolve!: () => void;
    const writer = createBoardCanvasWriter(c.ctx, () => {}, new Promise<void>(done => { resolve = done; }));
    writer.update('owner-a', message('private worker'));
    writer.update(null, message('Sign in to see your workers'));
    expect(c.clears()).toBe(2);
    expect(c.transforms).toEqual([[2, 0, 0, 2, 0, 0], [2, 0, 0, 2, 0, 0]]);
    expect(c.text).toEqual([]);
    resolve(); await Promise.resolve();
    expect(c.text).toContain('Sign in to see your workers');
    expect(c.text).not.toContain('private worker');
    expect(c.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
  });
  test('clears an already drawn account immediately', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner-a', message('private worker'));
    await Promise.resolve();
    writer.update(null, message('Sign in to see your workers'));
    expect(c.text).not.toContain('private worker');
    expect(c.text).toContain('Sign in to see your workers');
  });
  test('bounds message lines and clips long text with an ellipsis', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner', { ...summary, view: { kind: 'message', heading: 'Heading', tone: 'error',
      body: Array.from({ length: 20 }, (_, i) => `${i}: ${'x'.repeat(100)}`) } });
    await Promise.resolve();
    expect(c.text).toHaveLength(6);
    expect(c.text[2]!.endsWith('\u2026')).toBe(true);
    expect(c.ctx.measureText(c.text[2]!).width).toBeLessThanOrEqual(936);
    expect(clipBoardText(c.ctx, 'short')).toBe('short');
    expect(clipBoardText(c.ctx, 'long', 1)).toBe('');
    expect(c.ctx.textAlign).toBe('left');
    expect(c.ctx.letterSpacing).toBe('0px');
  });
  test('draws only three task rows with a bounded worker card and no text dump', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner', { ...summary, lines: ['never draw the window text'], view: {
      kind: 'tasks', worker: { network: 'TESTNET', address: '0x1234\u2026abcd', state: 'Paused',
        eligibility: 'Eligibility not checked yet', more: 1 },
      rows: Array.from({ length: 5 }, (_, i) => ({ id: `#${i}`, status: 'WORKING ON IT', highlight: true,
        amount: '4.50', displayAmount: '4.50 tUSDG', progress: 2, muted: false, unit: 'tUSDG' as const, detail: 'Due 11/24 3:00 PM' })),
    } });
    await Promise.resolve();
    expect(c.text).toContain('#2'); expect(c.text).not.toContain('#3');
    expect(c.text).toContain('+1 more');
    expect(c.text).not.toContain('never draw the window text');
    expect(c.text.some(value => value.startsWith('UPDATED'))).toBe(false);
    expect(c.ctx.letterSpacing).toBe('0px');
  });
  test('wraps task empty text to at most three lines without letterSpacing support', async () => {
    const c = canvas();
    Reflect.deleteProperty(c.ctx, 'letterSpacing');
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner', { ...summary, view: { kind: 'tasks',
      worker: { network: 'MAINNET', address: '0x1234\u2026abcd', state: 'Running', eligibility: 'Not eligible yet', more: 0 },
      rows: [], emptyHeading: 'No tasks yet', emptyBody: 'word '.repeat(100),
    } });
    await Promise.resolve();
    expect(c.text).toContain('No tasks yet');
    const lines = c.text.filter(value => value.startsWith('word'));
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith('\u2026')).toBe(true);
    expect(lines.every(value => c.ctx.measureText(value).width <= 522)).toBe(true);
    expect('letterSpacing' in c.ctx).toBe(false);
  });
  test('draws three numbered setup steps and the BRAIN stake footer', async () => {
    const c = canvas();
    const writer = createBoardCanvasWriter(c.ctx, () => {}, Promise.resolve());
    writer.update('owner', {...summary, footer:'Joining needs a BRAIN stake. Cortex explains the costs first.', view:{kind:'steps', heading:'Your AI is not doing jobs yet', steps:[['Talk to Cortex','She explains how AI jobs and pay work.'],['Set up your AI at a pod','A pod connects your AI to BrainChain.'],['Watch this board','Jobs and pay show up here.']]}});
    await Promise.resolve();
    for (const value of ['1','2','3','Talk to Cortex','Watch this board']) expect(c.text).toContain(value);
    expect(c.text.join(' ')).toContain('Joining needs a BRAIN stake.');
    expect(c.ctx.shadowBlur).toBe(0);
  });
  test('tolerates a null 2D context', async () => {
    let uploads = 0;
    const writer = createBoardCanvasWriter(null, () => uploads++, Promise.resolve());
    writer.update(null, summary);
    await Promise.resolve();
    expect(uploads).toBe(0);
  });
});
