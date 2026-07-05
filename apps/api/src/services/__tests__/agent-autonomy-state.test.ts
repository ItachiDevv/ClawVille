/**
 * Unit tests for the P3 slice-2 autonomy-state PURE core: the directive request
 * schema, the stored-value builder, the stored-value parser, the shared
 * top-priority prompt-bias formatter (used verbatim by BOTH the avatar-sim
 * bridge planner and the autonomy driver), and the wake-up event summarizer.
 *
 * The DB wrappers (setAgentDirective / getAgentDirective(ForAvatar) / cursor)
 * are atomic jsonb merges exercised by the live staging e2e (plan §4 slice-2),
 * not here — these tests pin the logic a slow/absent DB can never change.
 */
import { describe, it, expect } from 'bun:test';
import {
  directiveBodySchema,
  buildDirectiveValue,
  parseStoredDirective,
  formatDirectiveContext,
  summarizeAutonomyEvents,
  DIRECTIVE_MAX_LEN,
} from '../agent-autonomy-state';

describe('directiveBodySchema', () => {
  it('accepts a valid directive string', () => {
    const r = directiveBodySchema.safeParse({ directive: 'go to the cron building' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.directive).toBe('go to the cron building');
  });

  it('trims and rejects a blank/whitespace-only directive', () => {
    expect(directiveBodySchema.safeParse({ directive: '   ' }).success).toBe(false);
    expect(directiveBodySchema.safeParse({ directive: '' }).success).toBe(false);
  });

  it('rejects a directive longer than the cap', () => {
    expect(directiveBodySchema.safeParse({ directive: 'x'.repeat(DIRECTIVE_MAX_LEN + 1) }).success).toBe(
      false,
    );
    expect(directiveBodySchema.safeParse({ directive: 'x'.repeat(DIRECTIVE_MAX_LEN) }).success).toBe(true);
  });

  it('accepts clear:true with no directive', () => {
    const r = directiveBodySchema.safeParse({ clear: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.clear).toBe(true);
  });

  it('rejects an empty body (neither directive nor clear)', () => {
    expect(directiveBodySchema.safeParse({}).success).toBe(false);
  });

  it('strips unknown keys and rejects when only unknown keys are present', () => {
    const r = directiveBodySchema.safeParse({ foo: 'bar' });
    expect(r.success).toBe(false);
  });
});

describe('buildDirectiveValue', () => {
  it('trims + caps the text and stamps setAt/setBy', () => {
    const now = new Date('2026-07-04T12:00:00.000Z');
    const v = buildDirectiveValue('  learn about RAG  ', 'chat-bar', now);
    expect(v.text).toBe('learn about RAG');
    expect(v.setBy).toBe('chat-bar');
    expect(v.setAt).toBe('2026-07-04T12:00:00.000Z');
  });

  it('hard-caps an over-length directive to DIRECTIVE_MAX_LEN', () => {
    const v = buildDirectiveValue('y'.repeat(DIRECTIVE_MAX_LEN + 50), 'api');
    expect(v.text.length).toBe(DIRECTIVE_MAX_LEN);
  });
});

describe('parseStoredDirective', () => {
  it('parses a well-formed stored value', () => {
    const d = parseStoredDirective({ text: 'visit reef', setAt: '2026-07-04T00:00:00.000Z', setBy: 'chat-bar' });
    expect(d).not.toBeNull();
    expect(d!.text).toBe('visit reef');
    expect(d!.setBy).toBe('chat-bar');
  });

  it('returns null for absent/garbage/empty-text values', () => {
    expect(parseStoredDirective(null)).toBeNull();
    expect(parseStoredDirective(undefined)).toBeNull();
    expect(parseStoredDirective('nope')).toBeNull();
    expect(parseStoredDirective({})).toBeNull();
    expect(parseStoredDirective({ text: '   ' })).toBeNull();
  });

  it('defaults an unknown setBy to "api" and missing setAt to epoch', () => {
    const d = parseStoredDirective({ text: 'x', setBy: 'weird' });
    expect(d!.setBy).toBe('api');
    expect(d!.setAt).toBe(new Date(0).toISOString());
  });
});

describe('formatDirectiveContext (shared planner-bias formatter)', () => {
  it('produces a top-priority block containing the directive text', () => {
    const s = formatDirectiveContext('go to the cron building');
    expect(s).toContain('go to the cron building');
    expect(s.toLowerCase()).toContain('top priority');
  });

  it('collapses whitespace and caps length', () => {
    const s = formatDirectiveContext('a\n\n   b   c');
    expect(s).toContain('a b c');
    const long = formatDirectiveContext('z'.repeat(DIRECTIVE_MAX_LEN + 100));
    // the directive substring is capped; the whole block adds a fixed wrapper
    expect(long).toContain('z'.repeat(DIRECTIVE_MAX_LEN));
    expect(long).not.toContain('z'.repeat(DIRECTIVE_MAX_LEN + 1));
  });

  it('returns "" for null/empty so callers stay byte-identical without a directive', () => {
    expect(formatDirectiveContext(null)).toBe('');
    expect(formatDirectiveContext(undefined)).toBe('');
    expect(formatDirectiveContext('   ')).toBe('');
  });
});

describe('summarizeAutonomyEvents', () => {
  it('returns "" for no rows', () => {
    expect(summarizeAutonomyEvents([])).toBe('');
  });

  it('summarizes types with building + net hints', () => {
    const s = summarizeAutonomyEvents([
      { eventType: 'building.visited', payload: { buildingId: 'cron-automation' } },
      { eventType: 'cove.blackjack.hand.settled', payload: { net: 5 } },
      { eventType: 'cove.holdem.hand.settled', payload: { net: -3 } },
    ]);
    expect(s).toContain('building.visited(cron-automation)');
    expect(s).toContain('cove.blackjack.hand.settled net +5');
    expect(s).toContain('cove.holdem.hand.settled net -3');
  });

  it('keeps only the last `max` rows and bounds total length', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      eventType: 'building.visited',
      payload: { buildingId: `b${i}` },
    }));
    const s = summarizeAutonomyEvents(rows, 3);
    expect(s).toContain('b17');
    expect(s).toContain('b19');
    expect(s).not.toContain('b16');
    expect(s.length).toBeLessThanOrEqual(400);
  });
});
