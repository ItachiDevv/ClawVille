import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readReport, type FloorArenaTunerCheck } from '@/hooks/use-floor-arena';
import { paramPathLabel } from './arena-format';
import { ArenaReport, arenaTunerLine } from './arena-parts';

// D33: each arena report says in one line why the tuner changed, suggested or
// kept the rules. An older report has no tuner field and shows no line.

function tuner(overrides: Partial<FloorArenaTunerCheck>): FloorArenaTunerCheck {
  return { decision: 'none', reason: 'no_candidate', n: 30, needed: 20, best: null, p: null, checkpoint: null, alpha: null, ...overrides };
}

const BEST = { path: 'filters.chg5m_max', from: 25, to: 12.5, edge: 0.0215 };

describe('arenaTunerLine', () => {
  test('no tuner field (an older report) gives no line', () => {
    expect(arenaTunerLine(null)).toBeNull();
    expect(arenaTunerLine(undefined)).toBeNull();
  });

  test('each "no change" reason maps to one plain line', () => {
    expect(arenaTunerLine(tuner({ reason: 'below_sample', n: 16, needed: 20 }))).toBe(
      'Tuner: no change, needs 20 closed trades on these rules (has 16)',
    );
    expect(arenaTunerLine(tuner({ reason: 'below_sample', n: null, needed: null }))).toBe(
      'Tuner: no change, needs more closed trades on these rules',
    );
    expect(arenaTunerLine(tuner({ reason: 'no_candidate' }))).toBe('Tuner: no change, no filter change splits the trades 8 and 8');
    expect(arenaTunerLine(tuner({ reason: 'rate_limited' }))).toBe('Tuner: no change, the last rule change is too recent');
    expect(arenaTunerLine(tuner({ reason: 'params_changed' }))).toBe('Tuner: no change, the rules changed during the check');
    expect(arenaTunerLine(tuner({ reason: 'not_tunable' }))).toBe('Tuner: no change, the rules could not be checked');
  });

  test('checkpoints: a look between checkpoints names the next one; a spent budget says when it checks again', () => {
    expect(arenaTunerLine(tuner({ reason: 'waiting_checkpoint', n: 27, needed: 40 }))).toBe(
      'Tuner: no change, next check at 40 trades on these rules (has 27)',
    );
    expect(arenaTunerLine(tuner({ reason: 'waiting_checkpoint', n: null, needed: null }))).toBe(
      'Tuner: no change, next check after more trades on these rules',
    );
    expect(arenaTunerLine(tuner({ reason: 'budget_spent', n: 812, needed: null }))).toBe(
      'Tuner: no change, these rules used their test budget; it checks again after a rule change',
    );
  });

  test('not_significant compares p with the checkpoint alpha, not 0.05', () => {
    // p above alpha: the filter is not significant, and the line says what p it needed.
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.74, checkpoint: 20, alpha: 0.01 }))).toBe(
      'Tuner: no change, best filter not significant (p 0.740 needs 0.01 or less)',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.03, checkpoint: 400, alpha: 0.0025 }))).toBe(
      'Tuner: no change, best filter not significant (p 0.030 needs 0.0025 or less)',
    );
    // 3 decimals would print 0.005 for 0.0051 and read as passing: 4 decimals then.
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.0051, checkpoint: 200, alpha: 0.005 }))).toBe(
      'Tuner: no change, best filter not significant (p 0.0051 needs 0.005 or less)',
    );
    // p at or below alpha: the split failed only the edge rule.
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.004, checkpoint: 40, alpha: 0.01 }))).toBe(
      'Tuner: no change, edge too small (+0.0215)',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: { ...BEST, edge: 0.02 }, p: 0.0005, alpha: 0.01 }))).toBe(
      'Tuner: no change, edge too small (+0.02)',
    );
    // 0.0299 must not print as the 0.03 bar it failed.
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: { ...BEST, edge: 0.0299 }, p: 0.002, alpha: 0.01 }))).toBe(
      'Tuner: no change, edge too small (+0.0299)',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: null, p: 0.002, alpha: 0.01 }))).toBe(
      'Tuner: no change, edge too small',
    );
    // An older report with no alpha: p only; no p at all: no number.
    expect(arenaTunerLine(tuner({ reason: 'not_significant', best: BEST, p: 0.74 }))).toBe(
      'Tuner: no change, best filter not significant (p 0.740)',
    );
    expect(arenaTunerLine(tuner({ reason: 'not_significant', p: null }))).toBe('Tuner: no change, best filter not significant');
  });

  test('a change or a suggestion names the rule, the old and new value, p and the alpha it needed', () => {
    const label = paramPathLabel(BEST.path);
    const changed = arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.004, checkpoint: 20, alpha: 0.01 }));
    expect(changed).toStartWith(`Tuner: changed ${label} `);
    expect(changed).toContain(' -> ');
    expect(changed).toEndWith(' (p 0.004, needs 0.01)');
    const suggested = arenaTunerLine(
      tuner({ decision: 'suggested', reason: 'suggested', best: BEST, p: 0.0004, checkpoint: 400, alpha: 0.0025 }),
    );
    expect(suggested).toStartWith(`Tuner: suggested ${label} `);
    expect(suggested).toContain(' -> ');
    expect(suggested).toEndWith(' (p < 0.001, needs 0.0025)');
    // 3 decimals would print 0.003 for 0.0025 and read as failing: 4 decimals then.
    expect(arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.0025, alpha: 0.0025 }))).toEndWith(
      ' (p 0.0025, needs 0.0025)',
    );
    // An older report: p only, or nothing when p is absent.
    expect(arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.03 }))).toEndWith(' (p 0.030)');
    expect(arenaTunerLine(tuner({ decision: 'suggested', reason: 'suggested', best: BEST, p: null }))).not.toContain('(p');
    expect(arenaTunerLine(tuner({ decision: 'changed', reason: 'changed', best: null }))).toBe('Tuner: changed a rule');
  });

  test('copy rules: no em dash, no "CT", no "casino", and at most two lines in a 390 px panel', () => {
    const lines = [
      tuner({ reason: 'below_sample', n: 16, needed: 20 }),
      tuner({ reason: 'waiting_checkpoint', n: 127, needed: 160 }),
      tuner({ reason: 'budget_spent', n: 812, needed: null }),
      tuner({ reason: 'not_significant', best: BEST, p: 0.0051, alpha: 0.0025 }),
      tuner({ reason: 'not_significant', best: BEST, p: 0.002, alpha: 0.01 }),
      tuner({ reason: 'no_candidate' }),
      tuner({ reason: 'rate_limited' }),
      tuner({ reason: 'params_changed' }),
      tuner({ reason: 'not_tunable' }),
      tuner({ decision: 'changed', reason: 'changed', best: BEST, p: 0.0004, alpha: 0.0025 }),
    ].map((check) => arenaTunerLine(check)!);
    for (const line of lines) {
      expect(line).not.toMatch(/\u2014|\bCT\b|casino/i);
      // The 11 px line wraps (overflowWrap: anywhere) at about 55 characters in a 390 px panel.
      expect(line.length).toBeLessThanOrEqual(110);
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
    expect(html).toContain('Tuner: no change, needs 20 closed trades on these rules (has 16)');
  });

  test('the line wraps inside a 390 px panel', () => {
    const report = wire({ suggestionCheck: { tuner: { decision: 'none', reason: 'budget_spent', n: 812, needed: null } } });
    const html = renderToStaticMarkup(createElement(ArenaReport, { report, nowMs: Date.parse('2026-10-01T12:30:00Z') }));
    expect(html).toContain('Tuner: no change, these rules used their test budget; it checks again after a rule change');
    expect(html).toMatch(/data-testid="arena-tuner-line" style="[^"]*overflow-wrap:anywhere/);
  });

  test('a rejected suggestion says the rules changed or it was outside the limits (m4)', () => {
    const report = readReport({
      id: 'r2',
      suggestionState: 'rejected',
      periodEnd: '2026-10-01T12:00:00Z',
      suggestion: { path: 'filters.chg5m_max', from: 25, to: 12.5, reason: 'Fewer fast pumps.' },
    });
    const html = renderToStaticMarkup(createElement(ArenaReport, { report, nowMs: Date.parse('2026-10-01T12:30:00Z') }));
    expect(html).toContain('Not applied: the rules changed or it was outside the limits');
  });

  test('an older report with no tuner field renders no line', () => {
    const report = wire({ suggestionCheck: { llm: 'skipped' } });
    const html = renderToStaticMarkup(createElement(ArenaReport, { report, nowMs: Date.parse('2026-10-01T12:30:00Z') }));
    expect(html).toContain('Quiet half hour.');
    expect(html).not.toContain('arena-tuner-line');
    expect(html).not.toContain('Tuner:');
  });
});
