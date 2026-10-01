import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ARENA_MASK,
  isArenaTextOffensive,
  maskArenaDiscoveryRow,
  maskArenaFreeText,
  maskArenaName,
  maskArenaPosition,
  maskArenaSummary,
  maskArenaTapeItem,
} from './content-mask';

// The slur is built from parts, so the word itself is not written in the source.
const SLUR = ['N', 'I', 'G', 'G', 'A'].join('');
const SLUR_ER = ['n', 'i', 'g', 'g', 'e', 'r'].join('');
// Every evasion below is built from SLUR at run time (review m1), so no string literal in this file reads as a slur.
/** SLUR with `separator` between each two letters. */
const withSeparator = (separator: string): string => SLUR.split('').join(separator);
/** SLUR in leetspeak: 1 for I, 4 for A. */
const SLUR_LEET = SLUR.replace('I', '1').replace('A', '4');
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** ROT13 (its own inverse): the term lists below are built at run time, so the source does not print them. */
function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * The review's term list (B1, 2026-10-01), ROT13, by category: [term, glued forms caught]. `c` is
 * TERMCOIN and `p` is BIGTERM. A short term that is also part of common words has a word-edge guard,
 * so it is not caught glued on that side: the known glued-form limit (docs/trading-floor-arena.md
 * §8 P12). Every term is caught in every other form. The reclaimed q(5) is not in the list.
 */
const REVIEW_TERMS: Record<'racial' | 'homophobic' | 'ableist', ReadonlyArray<readonly [string, '' | 'c' | 'p' | 'cp']>> = {
  racial: [
    ['avttre', 'cp'], ['avttn', 'cp'], ['avttnu', 'cp'], ['avtthu', 'cp'], ['avtyrg', 'cp'], ['avtabt', 'cp'],
    ['arteb', 'cp'], ['arterff', 'cp'], ['fcvp', 'c'], ['fcvpx', 'c'], ['fcvx', ''], ['pbba', 'c'], ['puvax', 'cp'],
    ['puvaxl', 'cp'], ['tbbx', ''], ['xvxr', 'cp'], ['xlxr', 'cp'], ['ulzvr', 'c'], ['urro', ''], ['uror', ''],
    ['lvq', ''], ['jrgonpx', 'cp'], ['ornare', 'cp'], ['enturnq', 'cp'], ['gbjryurnq', 'cp'], ['fnaqavttre', 'cp'],
    ['cnxv', ''], ['wnc', ''], ['qntb', ''], ['jbc', ''], ['tlc', ''], ['tlcfl', ''], ['erqfxva', 'cp'],
    ['vawha', ''], ['fdhnj', ''], ['wvtnobb', 'cp'], ['wvttnobb', 'cp'], ['cbepuzbaxrl', 'cp'], ['fnzob', ''],
    ['qnexvr', 'c'], ['qnexl', ''], ['tbyyvjbt', 'cp'], ['jbt', ''], ['mvccreurnq', 'cp'], ['fynagrlr', 'cp'],
    ['ubaxl', ''], ['ubaxrl', ''], ['juvgrl', ''], ['nob', ''], ['noob', ''], ['pbbyvr', ''], ['xnssve', ''],
    ['xnsve', ''], ['cbynpx', 'c'], ['pnzrywbpxrl', 'cp'], ['gneonol', 'cp'], ['cvpxnavaal', 'cp'],
    ['unysoerrq', 'cp'], ['whatyrohaal', 'cp'], ['fcrnepuhpxre', 'cp'], ['puvatpubat', 'cp'], ['puvanzna', 'cp'],
    ['ternfronyy', 'cp'], ['jvttre', ''], ['jvttn', ''], ['zhqfunex', 'cp'], ['pbbanff', 'cp'], ['hapyrgbz', 'cp'],
  ],
  homophobic: [
    ['snttbg', 'c'], ['snt', 'c'], ['snttvg', 'c'], ['sntbg', 'c'], ['sntt', 'c'], ['qlxr', 'cp'],
    ['ohyyqlxr', 'cp'], ['ubzb', ''], ['yrfob', ''], ['genaal', 'c'], ['genaavr', 'c'], ['furznyr', 'c'],
    ['cbbs', ''], ['cbbsgre', 'c'], ['cbhs', ''], ['shqtrcnpxre', 'cp'], ['pnecrgzhapure', 'cp'],
    ['cvyybjovgre', 'cp'], ['ongglobl', 'cp'], ['ongglzna', 'cp'], ['ynqlobl', 'cp'], ['anaplobl', 'cp'],
  ],
  ableist: [
    ['ergneq', 'cp'], ['ergneqrq', 'cp'], ['fcnm', 'c'], ['fcnfgvp', 'c'], ['zbatbybvq', 'cp'],
  ],
};

/** Form + term not pinned, with the reason: the plural of l(5) is the Greek island Lesbos. */
const NOT_PINNED = new Set(['yrfob:plural']);

/** The review's forms (B1): as written, case, ticker, plural, leetspeak, separators, spaced letters, Cyrillic look-alikes, inside a phrase. */
function reviewForms(term: string): Record<string, string> {
  const upper = term.toUpperCase();
  return {
    lower: term,
    upper,
    ticker: `$${upper}`,
    plural: `${term}s`,
    leet: upper.replace(/I/g, '1').replace(/O/g, '0').replace(/E/g, '3').replace(/A/g, '4'),
    dots: upper.split('').join('.'),
    spaced: upper.split('').join(' '),
    cyrillic: term.replace(/a/g, 'а').replace(/o/g, 'о').replace(/e/g, 'е').replace(/c/g, 'с').replace(/p/g, 'р'),
    phrase: `Big ${upper} Energy`,
  };
}

describe('arena content mask: fields', () => {
  test('a slur and its evasions read as offensive', () => {
    for (const text of [
      SLUR, SLUR_ER, `$${SLUR}`, `SUPER${SLUR}`, `${SLUR}COIN`,
      SLUR_LEET, SLUR.replace(/G/g, '6'), SLUR.replace(/G/g, '9'), // leetspeak; 9 -> g comes from the arena folds (name-folds.ts)
      withSeparator('.'), withSeparator('-'), withSeparator('_'), // separators
      // runs of short pieces
      withSeparator(' '), withSeparator('. '), `${SLUR[0]}' ${SLUR.slice(1).split('').join(' ')}`, `$${withSeparator(' ')}`,
      `${SLUR.slice(0, 2)} ${SLUR.slice(2, 4)} ${SLUR.slice(4)}`, `${SLUR[0]} ${SLUR.slice(1, 3)} ${SLUR.slice(3)}`,
      `Big ${withSeparator(' ')} Energy`,
      // Cyrillic, Greek, dotless and full-width look-alikes
      SLUR.replace('I', 'І'), SLUR.replace('A', 'А'), SLUR.replace('I', 'Ι'), SLUR.toLowerCase().replace('i', 'ı'),
      [...SLUR].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join(''),
      `Big ${SLUR[0]}1${SLUR.slice(2).toLowerCase()} Energy`,
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: true });
    }
  });

  test('B1: every review term is caught in every form the review used (glued forms per the table)', () => {
    const missed: string[] = [];
    let terms = 0;
    for (const [category, list] of Object.entries(REVIEW_TERMS)) {
      for (const [encoded, glued] of list) {
        terms += 1;
        const term = rot13(encoded);
        const forms: Record<string, string> = { ...reviewForms(term) };
        if (glued.includes('c')) forms.coin = `${term.toUpperCase()}COIN`;
        if (glued.includes('p')) forms.pre = `BIG${term.toUpperCase()}`;
        for (const [name, text] of Object.entries(forms)) {
          // The failure message names the term in ROT13 only.
          if (!NOT_PINNED.has(`${encoded}:${name}`) && !isArenaTextOffensive(text)) missed.push(`${category} ${encoded} ${name}`);
        }
      }
    }
    expect(terms).toBe(95);
    expect(missed).toEqual([]);
  });

  test("B1: the dataset's own slur entries stay; the reclaimed q(5) is not masked", () => {
    for (const encoded of ['norrq', 'nob', 'nsevpbba', 'nenohfu', 'obbatn', 'puvatpubat', 'puvax', 'qlxr', 'snt', 'xvxr', 'arteb', 'avttre', 'ergneq', 'fcnfgvp', 'genaal']) {
      expect({ encoded, offensive: isArenaTextOffensive(rot13(encoded).toUpperCase()) }).toEqual({ encoded, offensive: true });
    }
    expect(isArenaTextOffensive(rot13('DHRRE'))).toBe(false);
  });

  test('B1 scope: profanity and sexual words are not masked, so real coins and stocks show as written', () => {
    for (const text of [
      'SCAT', '$SCAT', 'Supa Cat', 'Thanus', 'Cummins xStock', "Dick's Sporting Goods xStock", 'Becton Dickinson xStock',
      'Annaly Capital Management xStock', 'Analytics', 'Cummingtonite', 'cummunity', 'BORGY', 'SHITCOIN', 'ASSDAQ',
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: false });
    }
  });

  test('B1: whitelisted words, and words that only contain a term, are not masked', () => {
    for (const text of [
      'Spicy', 'Spice', 'SPICE', 'Spicy Cat', 'Allspice', 'Spica', 'Spick and Span', 'Tycoon', 'Raccoon', 'Cocoon', 'Racoon',
      'Coonhound', 'Cooney', 'Japan', 'Japanese', 'Pakistan', 'Homogeneous', 'Homer', 'Homeboy', 'Homo Sapiens', 'Lesbos',
      'Pouffe', 'Beanery', 'Hebrew', 'Darkness', 'Dagobert', 'Wogan', 'Injunction', 'Squawk', 'Coolidge', 'Honkytonk',
      'Honky Tonk', 'honky-tonk', 'Kaffir Lime', 'Kafirstan', 'Spearmint', 'Gooky', 'Yiddish', 'Battery', 'Batty', 'Tranquil',
      'Transform', 'Ladybug', 'Poofy', 'Pillow', 'Chinatown', 'Greaser', 'Wiggle', 'Mudskipper', 'Uncle Sam', 'Samba',
      'Pikachu', 'Jigsaw', 'Tarzan', 'Zipper', 'Polka', 'Gypsum', 'Egypt', 'Egyptian', 'Niger', 'Nigeria', 'Nigerian', 'Spaza',
      'Mongolia', 'Mongoose', 'Mongo', 'Hymn', 'Van Dyke', 'Snigger',
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: false });
    }
  });

  test('M1: two real words are never glued into a match; only runs of one- or two-character pieces join', () => {
    for (const text of [
      "Ansem's Cat", "Hasbulla's Cat", "Simon's Cat", "Taylor Swift's Cat",
      'Valentine Grok Companion', 'KEANU SLEAZE', 'GNOME MINING GAME', 'Verisk Analytics xStock',
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: false });
    }
  });

  test('R1: a term split into two words is masked; a match inside a pair of real words is not', () => {
    // Failure messages name the term in ROT13 only.
    for (const term of [SLUR, SLUR_ER.toUpperCase(), rot13('ERGNEQ')]) {
      for (let split = 1; split < term.length; split++) {
        const offensive = isArenaTextOffensive(`${term.slice(0, split)} ${term.slice(split)}`);
        expect({ term: rot13(term), split, offensive }).toEqual({ term: rot13(term), split, offensive: true });
      }
    }
    expect(isArenaTextOffensive(`$${SLUR_ER.slice(0, 3)} ${SLUR_ER.slice(3)}`)).toBe(true);
    for (const text of ["Ansem's Cat", 'Valentine Grok Companion', 'GNOME MINING GAME', 'Honky Tonk']) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: false });
    }
  });

  test('M-A: each punctuation, symbol and invisible separator between the letters is masked', () => {
    const separators = ['*', '/', '+', '~', '|', ',', ':', '^', '=', '#', '!', '·', '•', '​', '‌', '‍', '­', '⁠'];
    expect(separators.length).toBe(18);
    for (const term of [SLUR, rot13('SNTTBG')]) {
      for (const separator of separators) {
        const code = separator.codePointAt(0)?.toString(16);
        const offensive = isArenaTextOffensive(term.split('').join(separator));
        expect({ term: rot13(term), code, offensive }).toEqual({ term: rot13(term), code, offensive: true });
      }
    }
  });

  test('clean symbols, coin names and trader names are not offensive', () => {
    for (const text of [
      'WIF', 'BONK', 'CAT', '$CAT', '$AURA', '$LABEAST', 'BTC', 'AK47', 'DOGEPAID', 'Pump Fighter', 'Scared Black Lab',
      'Sussex', 'Essex', 'cocktail', 'Hancock', 'Dickens', 'Assassin', 'grasshopper', 'Scunthorpe', 'Genesis Fan', 'Trader 4200',
      'かのくん', '逆袭人生',
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: false });
    }
  });

  test('a discovery row: symbol and name masked, the mint kept, masked: true; a clean row is returned unchanged', () => {
    const row = { mint: MINT, symbol: `$${SLUR}`, name: `${SLUR} Coin`, firstSource: 'ds:token-profiles' };
    expect(maskArenaDiscoveryRow(row)).toEqual({ mint: MINT, symbol: ARENA_MASK, name: ARENA_MASK, firstSource: 'ds:token-profiles', masked: true });
    expect(row.symbol).toBe(`$${SLUR}`); // the input is not changed
    const clean = { mint: MINT, symbol: 'WIF', name: 'dogwifhat', firstSource: 'ds:token-profiles' };
    expect(maskArenaDiscoveryRow(clean)).toBe(clean);
    expect(maskArenaDiscoveryRow({ mint: MINT, symbol: null, name: null })).toEqual({ mint: MINT, symbol: null, name: null });
  });

  test('a tape item masks the symbol and the trader name separately', () => {
    const item = { id: 'entry:1', mint: MINT, symbol: 'WIF', agentName: `Big ${SLUR}` };
    expect(maskArenaTapeItem(item)).toEqual({ id: 'entry:1', mint: MINT, symbol: 'WIF', agentName: ARENA_MASK, masked: true });
    expect(maskArenaTapeItem({ ...item, symbol: SLUR_LEET, agentName: 'Genesis' })).toEqual({
      id: 'entry:1', mint: MINT, symbol: ARENA_MASK, agentName: 'Genesis', masked: true,
    });
  });

  test('a position and a name', () => {
    expect(maskArenaPosition({ id: 'p1', mint: MINT, symbol: SLUR_ER })).toEqual({ id: 'p1', mint: MINT, symbol: ARENA_MASK, masked: true });
    expect(maskArenaName({ rank: 1, name: withSeparator('.') })).toEqual({ rank: 1, name: ARENA_MASK, masked: true });
    const clean = { rank: 2, name: 'Mid-Cap Climber' };
    expect(maskArenaName(clean)).toBe(clean);
  });
});

describe('arena content mask: free text (summaries)', () => {
  test('only the offensive word is replaced; figures and the rest stay', () => {
    expect(maskArenaFreeText(`Bought $20 of ${SLUR} at $0.00123 (mcap 250k, age 12 min)`)).toEqual({
      text: `Bought $20 of ${ARENA_MASK} at $0.00123 (mcap 250k, age 12 min)`, masked: true,
    });
    expect(maskArenaFreeText(`Exit of $${withSeparator('.')} (tp) at 1.53x: +$10.60`)).toEqual({
      text: `Exit of ${ARENA_MASK} (tp) at 1.53x: +$10.60`, masked: true,
    });
  });

  test('our own figures are never read as words: 1.53x and 0.53x read as a leetspeak word to the plain matcher', () => {
    for (const text of [
      'Exit of WIF (tp) at 1.53x: +$10.60',
      'Exit of WIF (TP 1) not booked yet: no route (mark 0.53x, quote 0.53x). Retrying.',
      'Held WIF: the mark shows 1.53x (TP 2.00x) but the quote is 0.53x/1.20x. Waiting for the quote to confirm the take-profit.',
      'Scanned 40 coins: 3 passed. Top reasons to skip: liq_min 12, mcap_max 5',
      'Skipped $CAT: cooldown',
      'Changed 2 settings: filters.mcap_max 250000 -> 300000; exits.max_hold_s 900 -> 1200',
      'Closed 5eX7...9Kq2 as unresolved: no usable sell price for 30 min. Not counted in P&L.',
    ]) {
      expect(maskArenaFreeText(text)).toEqual({ text, masked: false });
    }
  });

  test('a term from the added list is masked as a word; a whitelisted phrase and a profane coin stay', () => {
    const term = rot13('FCVP');
    expect(maskArenaFreeText(`Bought $20 of ${term} at $0.001`)).toEqual({ text: `Bought $20 of ${ARENA_MASK} at $0.001`, masked: true });
    expect(maskArenaFreeText(`Exit of $${term.split('').join('.')} (tp)`)).toEqual({ text: `Exit of ${ARENA_MASK} (tp)`, masked: true });
    // A pattern of two words masks each word it touches.
    expect(maskArenaFreeText(`Skipped ${rot13('Cbepu Zbaxrl')}: cooldown`)).toEqual({ text: `Skipped ${ARENA_MASK} ${ARENA_MASK}: cooldown`, masked: true });
    for (const text of ['Bought $20 of SCAT at $0.001', 'Skipped Homo Sapiens: cooldown', "Skipped Ansem's Cat: cooldown"]) {
      expect(maskArenaFreeText(text)).toEqual({ text, masked: false });
    }
  });

  test('maskArenaSummary copies an event only when a word was masked', () => {
    const event = { id: 1, type: 'entry', mint: MINT, summary: `Bought $20 of ${SLUR_ER}`, data: { sizeUsd: 20 } };
    expect(maskArenaSummary(event)).toEqual({ ...event, summary: `Bought $20 of ${ARENA_MASK}`, masked: true });
    const clean = { ...event, summary: 'Bought $20 of WIF' };
    expect(maskArenaSummary(clean)).toBe(clean);
  });
});

describe('arena content mask: dependency', () => {
  test('obscenity is MIT licensed (no AGPL/GPL in the API)', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('obscenity/package.json'), 'utf8')) as { license: string };
    expect(pkg.license).toBe('MIT');
  });
});
