import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readReport, type FloorArenaTunerCheck } from '@/hooks/use-floor-arena';
import { paramPathLabel } from './arena-format';
import { ArenaReport, arenaTunerLine } from './arena-parts';

// D33: each arena report says in one line why the tuner changed, suggested or
// kept the rules. An older report has no tuner field and shows no line.

function tuner(overrides: Partial<FloorArenaTunerCheck>): FloorArenaTunerCheck {
  return { decision: 'none', reason: 'no_candidate', n: 30, needed: 20, best: null, p: null, ...overrides };
}

const BEST = { path: 'filters.chg5m_max', from: 25, to: 12.5 };

describe('arenaTunerLine', () => {
  test('no tuner field (an older report) gives no line', () => {
    expect(arenaTunerLine(null)).toBeNull();
    expect(arenaTunerLine(undefined)).toBeNull();
  });

  test('each "no change" reason maps to one plain line', () => {
    expect(arenaTunerLine(tuner({ reason: 'below_sample', n: 16, needed: 20 }))).toBe(
      'Tuner: no change, needs 20 closed trades (has 16)',
    );
    expect(arenaTunerLine(tuner({ reason: 'below_sample', n: null, needed: null }))).toBe(
      'Tuner: no change, needs more closed trades',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.74 }))).toBe(
      'Tuner: no change, best filter not significant (p 0.74)',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', p: null }))).toBe(
      'Tuner: no change, best filter not significant',
    );
    expect(arenaTunerLine(tuner({ reason: 'no_candidate' }))).toBe('Tuner: no change, no filter passes the evidence gate');
    expect(arenaTunerLine(tuner({ reason: 'rate_limited' }))).toBe('Tuner: no change, the last rule change is too recent');
    expect(arenaTunerLine(tuner({ reason: 'params_changed' }))).toBe('Tuner: no change, the rules changed during the check');
    expect(arenaTunerLine(tuner({ reason: 'not_tunable' }))).toBe('Tuner: no change, the rules could not be checked');
  });

  test('a change or a suggestion names the rule, the old and new value, and p', () => {
    const label = paramPathLabel(BEST.path);
    const changed = arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.03 }));
    expect(changed).toStartWith(`Tuner: changed ${label} `);
    expect(changed).toContain(' -> ');
    expect(changed).toEndWith(' (p 0.03)');
    const suggested = arenaTunerLine(tuner({ decision: 'suggested', reason: 'suggested', best: BEST, p: null }));
    expect(suggested).toStartWith(`Tuner: suggested ${label} `);
    expect(suggested).toContain(' -> ');
    expect(suggested).not.toContain('(p');
    expect(arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.004 }))).toEndWith(' (p < 0.01)');
    expect(arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: null }))).toBe('Tuner: changed a rule');
  });

  test('copy rules: no em dash, no "CT", no "casino", and short enough for a 390 px panel', () => {
    const lines = [
      tuner({ reason: 'below_sample', n: 16, needed: 20 }),
      tuner({ reason: 'not_significant', p: 0.74 }),
      tuner({ reason: 'no_candidate' }),
      tuner({ reason: 'rate_limited' }),
      tuner({ reason: 'params_changed' }),
      tuner({ reason: 'not_tunable' }),
    ].map((check) => arenaTunerLine(check)!);
    for (const line of lines) {
      expect(line).not.toMatch(/—|\bCT\b|casino/i);
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('ArenaReport tuner line', () => {
  const wire = (stats: unknown) =>
    readReport({ id: 'r1', summary: 'Quiet half hour.', suggestionState: 'none', periodEnd: '2026-10-01T12:00:00Z', stats });

  test('a report with a tuner field renders the line under the report', () => {
    const report = wire({ suggestionCheck: { llm: 'ok', tuner: { decision: 'none', reason: 'below_sample', n: 16, needed: 20, best: null, p: null } } });
    const html = renderToStaticMarkup(createElement(ArenaReport, { report, nowMs: Date.parse('2026-10-01T12:30:00Z') }));
    expect(html).toContain('data-testid="arena-tuner-line"');
    expect(html).toContain('Tuner: no change, needs 20 closed trades (has 16)');
  });

  test('an older report with no tuner field renders no line', () => {
    const report = wire({ suggestionCheck: { llm: 'skipped' } });
    const html = renderToStaticMarkup(createElement(ArenaReport, { report, nowMs: Date.parse('2026-10-01T12:30:00Z') }));
    expect(html).toContain('Quiet half hour.');
    expect(html).not.toContain('arena-tuner-line');
    expect(html).not.toContain('Tuner:');
  });
});
