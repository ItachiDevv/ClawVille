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
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('arena content mask: fields', () => {
  test('a slur and its evasions read as offensive', () => {
    for (const text of [
      SLUR, SLUR_ER, `$${SLUR}`, `SUPER${SLUR}`, `${SLUR}COIN`,
      'N1GG4', 'NI66A', 'NI99A', // leetspeak; 9 -> g comes from the arena folds (name-folds.ts)
      'N.I.G.G.A', 'N-I-G-G-A', 'N_I_G_G_A', // separators
      'N I G G A', // spaced letters
      'NІGGA', 'NIGGА', 'NΙGGA', 'nıgga', 'ＮＩＧＧＡ', // Cyrillic, Greek, dotless and full-width look-alikes
      'Big N1gga Energy',
    ]) {
      expect({ text, offensive: isArenaTextOffensive(text) }).toEqual({ text, offensive: true });
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
    expect(maskArenaTapeItem({ ...item, symbol: 'N1GG4', agentName: 'Genesis' })).toEqual({
      id: 'entry:1', mint: MINT, symbol: ARENA_MASK, agentName: 'Genesis', masked: true,
    });
  });

  test('a position and a name', () => {
    expect(maskArenaPosition({ id: 'p1', mint: MINT, symbol: SLUR_ER })).toEqual({ id: 'p1', mint: MINT, symbol: ARENA_MASK, masked: true });
    expect(maskArenaName({ rank: 1, name: 'N.I.G.G.A' })).toEqual({ rank: 1, name: ARENA_MASK, masked: true });
    const clean = { rank: 2, name: 'Mid-Cap Climber' };
    expect(maskArenaName(clean)).toBe(clean);
  });
});

describe('arena content mask: free text (summaries)', () => {
  test('only the offensive word is replaced; figures and the rest stay', () => {
    expect(maskArenaFreeText(`Bought $20 of ${SLUR} at $0.00123 (mcap 250k, age 12 min)`)).toEqual({
      text: `Bought $20 of ${ARENA_MASK} at $0.00123 (mcap 250k, age 12 min)`, masked: true,
    });
    expect(maskArenaFreeText(`Exit of $N.I.G.G.A (tp) at 1.53x: +$10.60`)).toEqual({
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
