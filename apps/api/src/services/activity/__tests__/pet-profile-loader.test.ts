/**
 * Phase 3 — pet-profile-loader unit tests.
 *
 * Mocks @clawville/database so we can drive the loader without a real
 * Supabase connection. Spec: `.claude/plans/reef-race-phase3-detailed.md`
 * §8 P3-L1..P3-L3.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Mock the db module BEFORE the importer pulls it in. The loader chains
// db.select(...).from(pets).where(inArray(...)) — so we return a thenable
// at the end of the chain that yields the rows we want for the test.
let mockRows: Array<{
  id: string;
  level: number | null;
  archetype: string | null;
}> = [];
let mockShouldThrow = false;

mock.module('@clawville/database', () => {
  function thenable<T>(value: T) {
    return {
      then(onFulfilled: (value: T) => unknown, onRejected?: (e: unknown) => unknown) {
        if (mockShouldThrow) {
          if (onRejected) return onRejected(new Error('mock db throw'));
          throw new Error('mock db throw');
        }
        return Promise.resolve(value).then(onFulfilled);
      },
    };
  }
  const chain = {
    where: (_arg: unknown) => thenable(mockRows),
  };
  const fromChain = {
    from: (_table: unknown) => chain,
  };
  return {
    db: {
      select: (_cols: unknown) => fromChain,
    },
    pets: { id: {}, level: {}, archetype: {} },
  };
});

mock.module('drizzle-orm', () => ({
  inArray: (_col: unknown, _vals: unknown) => ({ kind: 'inArray' }),
}));

const { loadRacingProfiles } = await import('../pet-profile-loader');

beforeEach(() => {
  mockRows = [];
  mockShouldThrow = false;
});

describe('loadRacingProfiles (Phase 3 P3-L1..P3-L3)', () => {
  // P3-L1
  it('P3-L1 — loads humans + bots in a single Map', async () => {
    mockRows = [
      { id: 'h1', level: 25, archetype: 'mischievous-trickster' },
      { id: 'h2', level: 50, archetype: 'fierce-battler' },
    ];
    const out = await loadRacingProfiles(['h1', 'h2'], ['b1']);
    expect(out.size).toBe(3);
    expect(out.get('h1')).toEqual({
      petId: 'h1',
      level: 25,
      archetype: 'mischievous-trickster',
      isBot: false,
    });
    expect(out.get('h2')).toEqual({
      petId: 'h2',
      level: 50,
      archetype: 'fierce-battler',
      isBot: false,
    });
    expect(out.get('b1')).toEqual({
      petId: 'b1',
      level: 1,
      archetype: null,
      isBot: true,
    });
  });

  // P3-L2
  it('P3-L2 — unknown human petId falls back to neutral profile', async () => {
    mockRows = [
      { id: 'h1', level: 10, archetype: 'curious-scholar' },
    ];
    const out = await loadRacingProfiles(['h1', 'h2'], []);
    expect(out.size).toBe(2);
    // h2 row was missing — neutral fallback (level 1, archetype null).
    expect(out.get('h2')).toEqual({
      petId: 'h2',
      level: 1,
      archetype: null,
      isBot: false,
    });
  });

  // P3-L3
  it('P3-L3 — DB error returns all-neutral, never throws', async () => {
    mockShouldThrow = true;
    const out = await loadRacingProfiles(['h1', 'h2'], ['b1']);
    expect(out.size).toBe(3);
    // Bots are still neutral (added before DB call).
    expect(out.get('b1')?.isBot).toBe(true);
    // Humans get neutral fallback (level 1, archetype null).
    expect(out.get('h1')).toEqual({
      petId: 'h1',
      level: 1,
      archetype: null,
      isBot: false,
    });
    expect(out.get('h2')).toEqual({
      petId: 'h2',
      level: 1,
      archetype: null,
      isBot: false,
    });
  });

  it('returns only bot map when humans list is empty (no DB call)', async () => {
    const out = await loadRacingProfiles([], ['b1', 'b2']);
    expect(out.size).toBe(2);
    expect(out.get('b1')?.isBot).toBe(true);
    expect(out.get('b2')?.isBot).toBe(true);
  });
});
