import { describe, expect, test } from 'bun:test';

import { arenaNameProblem } from './launch-trader';

// P8: the board's TRADER column prints the name beside the P&L, so a name such
// as `-4200.00` read as a number. The form now needs one letter, like the route.

describe('arenaNameProblem (launch form name rule)', () => {
  test('a name with no letter is refused with a plain reason', () => {
    for (const name of ['-4200.00', '4200', '0.00', '1 2 3', "'-'", '_._']) {
      expect({ name, problem: arenaNameProblem(name) }).toEqual({
        name,
        problem: 'Use at least one letter, so the name does not look like a number.',
      });
    }
  });

  test('one letter in any script is enough', () => {
    for (const name of ['Trader 4200', 'x-4200.00', 'R2 D2', 'Ж 42', '吉 7']) {
      expect({ name, problem: arenaNameProblem(name) }).toEqual({ name, problem: null });
    }
  });

  test('every other rule is unchanged: empty is allowed, length and characters come first', () => {
    expect(arenaNameProblem('')).toBeNull();
    expect(arenaNameProblem('   ')).toBeNull();
    expect(arenaNameProblem('a'.repeat(33))).toBe('Use 32 characters or fewer.');
    expect(arenaNameProblem('$4200')).toBe("Use letters, numbers, spaces and . _ ' - only.");
    expect(arenaNameProblem('<script>')).toBe("Use letters, numbers, spaces and . _ ' - only.");
  });
});
