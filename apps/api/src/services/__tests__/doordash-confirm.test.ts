import { describe, expect, test } from 'bun:test';
import {
  codeStatedByRequester,
  hashConfirmCode,
  isWellFormedConfirmCode,
  maskConfirmCode,
  mintConfirmCode,
  tipStatedByRequester,
} from '../doordash-confirm';

describe('confirm codes', () => {
  test('minted codes are six characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = mintConfirmCode();
      expect(code).toMatch(/^[ACDEFGHJKLMNPQRTUVWXY34679]{6}$/);
      expect(isWellFormedConfirmCode(code)).toBe(true);
    }
  });

  test('codes are not predictable across mints', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(mintConfirmCode());
    // Anything close to a constant or a short cycle collapses this count.
    expect(seen.size).toBeGreaterThan(450);
  });

  test('look-alike characters are rejected rather than coerced', () => {
    for (const code of ['A1B2C3', 'ABCDE0', 'ABCDEI', 'ABCDES', 'ABCDEZ']) {
      expect(isWellFormedConfirmCode(code)).toBe(false);
    }
  });

  test('the hash is stable, case-insensitive, and never the code itself', () => {
    const hash = hashConfirmCode('ACDEFG');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashConfirmCode(' acdefg '));
    expect(hash).not.toContain('ACDEFG');
    expect(hashConfirmCode('ACDEFH')).not.toBe(hash);
  });
});

describe('the code must come from the requester, not the responder', () => {
  test('accepts a code the human typed, in any case or position', () => {
    expect(codeStatedByRequester('ACDEFG', 'ACDEFG')).toBe(true);
    expect(codeStatedByRequester('yes, acdefg, tip 4 please', 'ACDEFG')).toBe(true);
    expect(codeStatedByRequester('order it: ACDEFG', 'acdefg')).toBe(true);
  });

  test('refuses when the human turn does not contain the code', () => {
    // This is the whole safety property: a model can emit a confirm tag with a
    // code it just invented, and that must not be enough to spend money.
    expect(codeStatedByRequester('yes go ahead and place the order', 'ACDEFG')).toBe(false);
    expect(codeStatedByRequester('confirm ACDEFH', 'ACDEFG')).toBe(false);
    expect(codeStatedByRequester('', 'ACDEFG')).toBe(false);
  });

  test('refuses a malformed code even when the turn contains it verbatim', () => {
    expect(codeStatedByRequester('my code is ABC', 'ABC')).toBe(false);
    expect(codeStatedByRequester('code A1B2C3 go', 'A1B2C3')).toBe(false);
  });
});

describe('the tip must come from the requester too', () => {
  test('accepts the natural ways a person writes an amount', () => {
    expect(tipStatedByRequester('ACDEFG tip 4', 400)).toBe(true);
    expect(tipStatedByRequester('ACDEFG tip $4', 400)).toBe(true);
    expect(tipStatedByRequester('ACDEFG tip 4.00', 400)).toBe(true);
    expect(tipStatedByRequester('ACDEFG tip 4.50', 450)).toBe(true);
    expect(tipStatedByRequester('ACDEFG tip 3.25 please', 325)).toBe(true);
  });

  test('accepts an explicit refusal to tip', () => {
    expect(tipStatedByRequester('ACDEFG no tip', 0)).toBe(true);
    expect(tipStatedByRequester('ACDEFG skip the tip', 0)).toBe(true);
    expect(tipStatedByRequester('ACDEFG tip 0', 0)).toBe(true);
  });

  test('refuses an amount the human never wrote', () => {
    expect(tipStatedByRequester('ACDEFG place the order', 400)).toBe(false);
    expect(tipStatedByRequester('ACDEFG tip 4', 500)).toBe(false);
    expect(tipStatedByRequester('', 400)).toBe(false);
  });

  test('does not read a tip out of the middle of a longer number', () => {
    // "$45" must not satisfy a claimed $4 tip, and an order id full of digits
    // must not accidentally authorise an amount.
    expect(tipStatedByRequester('ACDEFG tip 45', 400)).toBe(false);
    expect(tipStatedByRequester('ACDEFG tip 4.50', 400)).toBe(false);
  });

  test('refuses negative and non-integer cent amounts outright', () => {
    expect(tipStatedByRequester('tip 4', -400)).toBe(false);
    expect(tipStatedByRequester('tip 4', 4.5)).toBe(false);
    expect(tipStatedByRequester('tip 4', Number.NaN)).toBe(false);
  });
});

describe('the confirmation code must not become the tip', () => {
  // THE BUG THIS BLOCK EXISTS FOR. The code alphabet contains 3, 4, 6, 7 and 9,
  // and the tip check reads the same turn the code must appear in. So without
  // masking, the code is a digit source on EVERY order: a turn of just
  // "yes K7Y46D" would authorise a $46 tip the founder never asked for.
  //
  // It survived the first round of tests because every one of them used the
  // code ACDEFG — the single shape with no digits in it. Digit-bearing codes
  // are the point of these cases.
  test('a tip hiding inside the code is refused', () => {
    const turn = 'yes K7Y46D';
    expect(tipStatedByRequester(turn, 4600)).toBe(true); // unmasked: the hole
    expect(tipStatedByRequester(maskConfirmCode(turn, 'K7Y46D'), 4600)).toBe(false);
  });

  test('single digits in the code cannot authorise a small tip either', () => {
    for (const [code, cents] of [['A4C7DE', 400], ['A4C7DE', 700], ['K9YMND', 900]] as const) {
      const turn = `place it ${code}`;
      expect(tipStatedByRequester(turn, cents)).toBe(true);
      expect(tipStatedByRequester(maskConfirmCode(turn, code), cents)).toBe(false);
    }
  });

  test('a tip the human really typed still passes with a digit-bearing code', () => {
    const turn = 'K7Y46D tip 3';
    expect(tipStatedByRequester(maskConfirmCode(turn, 'K7Y46D'), 300)).toBe(true);
  });

  test('masking removes every occurrence, in any case, and nothing else', () => {
    expect(maskConfirmCode('K7Y46D and again k7y46d', 'K7Y46D').trim()).toBe('and again');
    expect(maskConfirmCode('tip 3 please', 'K7Y46D')).toBe('tip 3 please');
    expect(maskConfirmCode('anything', '')).toBe('anything');
  });

  test('masking a minted code never leaves a digit from it behind', () => {
    // Property check across real mints rather than one hand-picked code.
    for (let i = 0; i < 300; i += 1) {
      const code = mintConfirmCode();
      const masked = maskConfirmCode(`yes ${code}`, code);
      expect(/\d/.test(masked)).toBe(false);
    }
  });
});
