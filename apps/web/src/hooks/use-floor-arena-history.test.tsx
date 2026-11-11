import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseArenaTimestamp, readEquity, readTradesPage } from './use-floor-arena';
import { EquityCurve } from '../components/game/trading-floor/terminal/terminal-history';

describe('arena history readers', () => {
  test('truncates six-digit fractions for Safari parsing without changing cursor text', () => {
    const parse = Date.parse;
    const inputs: string[] = [];
    Date.parse = (value: string) => { inputs.push(value); return /\.\d{4}/.test(value) ? NaN : parse(value); };
    try {
      const timestamp = '2026-11-11T12:00:00.123456Z';
      expect(parseArenaTimestamp(timestamp)).toBe(parse('2026-11-11T12:00:00.123Z'));
      expect(parseArenaTimestamp('2026-11-11T12:00:00.123456+01:00')).toBe(parse('2026-11-11T11:00:00.123Z'));
      const cursor = { before: timestamp, beforeId: '00000000-0000-4000-8000-000000000001' };
      expect(readTradesPage({ nextCursor: cursor }).nextCursor).toEqual(cursor);
      const html = renderToStaticMarkup(createElement(EquityCurve, { series: [{ closedAt: timestamp, equityUsd: 18 }] }));
      expect(html).toContain('2026-11-11 12:00 UTC');
      expect(html).not.toContain('NaN');
      expect(inputs.every((input) => !/\.\d{4}/.test(input))).toBe(true);
    } finally { Date.parse = parse; }
  });
  test('rejects malformed cursors and retains exact submillisecond cursor text', () => {
    const cursor = { before: '2026-11-11T12:00:00.123456Z', beforeId: '00000000-0000-4000-8000-000000000001' };
    expect(readTradesPage({ nextCursor: cursor }).nextCursor).toEqual(cursor);
    expect(readTradesPage({ nextCursor: { ...cursor, before: '1' } }).nextCursor).toBeNull();
    expect(readTradesPage({ nextCursor: { ...cursor, beforeId: 'invalid' } }).nextCursor).toBeNull();
    expect(readTradesPage(null)).toEqual({ trades: [], nextCursor: null });
  });
  test('keeps masked trades, numeric strings and unavailable exit prices', () => {
    const page = readTradesPage({ trades: [null, {}, { id: '1', mint: 'mint', symbol: '***', status: 'closed', pnlUsd: '-2.5', sizeUsd: '10' }, { id: 'open', mint: 'mint', status: 'open' }] });
    expect(page.trades).toHaveLength(1);
    expect(page.trades[0]?.symbol).toBe('***');
    expect(page.trades[0]?.pnlUsd).toBe(-2.5);
    expect(page.trades[0]).not.toHaveProperty('exitPriceUsd');
  });
  test('never makes unknown money or invalid dates into chart points', () => {
    const value = readEquity({ series: [{ closedAt: '1', equityUsd: 5 }, { closedAt: '2026-11-11T12:00:00Z', equityUsd: null }, { closedAt: '2026-11-11T13:00:00Z', equityUsd: '-3' }], openPnlUsd: 'NaN', startAt: false });
    expect(value.series).toEqual([{ closedAt: '2026-11-11T13:00:00Z', equityUsd: -3 }]);
    expect(value.openPnlUsd).toBeNull();
    expect(value.startAt).toBeNull();
    expect(readEquity({}).series).toEqual([]);
  });
  test('renders real points, USD labels and both gain and loss colors', () => {
    const html = renderToStaticMarkup(createElement(EquityCurve, { series: [{ closedAt: '2026-11-11T12:00:00Z', equityUsd: 2 }, { closedAt: '2026-11-11T14:00:00Z', equityUsd: -3 }] }));
    expect(html).toContain('USD');
    expect(html).toContain('#B8F800');
    expect(html).toContain('#FF8A75');
    expect(html.match(/<circle /g)).toHaveLength(2);
    expect(html).toContain('2026-11-11T14:00:00Z');
    expect(renderToStaticMarkup(createElement(EquityCurve, { series: [] }))).toContain('No closed trades in this window');
  });
});
