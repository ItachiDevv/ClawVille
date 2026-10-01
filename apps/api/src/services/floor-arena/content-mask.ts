import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  fixedPhraseCensorStrategy,
} from 'obscenity';
import { FLOOR_ARENA_CONFUSABLES } from './confusables.generated';
import { FLOOR_ARENA_EXTRA_FOLDS } from './name-folds';

/**
 * Arena content mask (prod finding 2026-10-01: a coin symbol with a racial slur on the public
 * discovery feed). The ONE helper every public arena serializer uses for third-party text (coin
 * symbols and names from the vendors) and player text (trader names), and the launch name check.
 *
 * Matcher: the MIT-licensed `obscenity` package, its English dataset and its recommended
 * transformers (confusable characters, leetspeak, case, repeated letters). Three arena forms are
 * added, because coin symbols are short and written to evade a filter:
 * - a ticker's leading `$` ($CAT) is a prefix, not leetspeak for s;
 * - a word is also read with `. _ ' -` removed (N.I.G.G.A), then folded: each non-ASCII letter,
 *   lower-cased, to its Unicode prototype (confusables.generated.ts, the table names.ts uses; the
 *   obscenity table misses capitals such as Cyrillic І and Greek Ι), and the arena's extra folds
 *   (name-folds.ts: 9 -> g, which the obscenity leetspeak table does not have);
 * - a whole field is also read with its words joined (N I G G A).
 *
 * A masked field reads ARENA_MASK and its object carries `masked: true`; the mint address stays,
 * so a client still identifies the coin. Free text (event and report summaries) has only the
 * matched words replaced. The data in the database is never changed.
 */

export const ARENA_MASK = '***';

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor().setStrategy(fixedPhraseCensorStrategy(ARENA_MASK));

/** A word of free text: no space and no bracket, comma, colon, semicolon or slash. */
const FREE_TEXT_WORD = /[^\s()[\]{}<>,;:/]+/g;

function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/** The forms one word is read in: as written (a leading `$` dropped), with separators removed, and folded. */
function wordForms(word: string): string[] {
  const body = word.replace(/^\$+/, '');
  const joined = body.replace(/[._'-]+/g, '');
  let folded = '';
  for (const ch of joined) {
    const proto = ch.charCodeAt(0) < 0x80 ? ch : FLOOR_ARENA_CONFUSABLES[ch.toLowerCase()] ?? FLOOR_ARENA_CONFUSABLES[ch] ?? ch;
    for (const part of proto) folded += FLOOR_ARENA_EXTRA_FOLDS[part] ?? part;
  }
  return [...new Set([body, joined, folded])].filter((form) => form.length > 0);
}

function wordOffensive(word: string): boolean {
  return wordForms(word).some((form) => matcher.hasMatch(form));
}

/** Each leading `$` of a word becomes a space, so `$CAT` is not read as "scat" and every index stays. */
function blankTickerSigns(text: string): string {
  return text.replace(/(^|\s)(\$+)/g, (_match, lead: string, signs: string) => lead + ' '.repeat(signs.length));
}

/**
 * True when a coin symbol, a coin name or a trader name reads as an offensive word, in any of the
 * forms above. Launch refuses such a trader name (400 `name_not_allowed`).
 */
export function isArenaTextOffensive(text: string): boolean {
  const clean = text.normalize('NFKC');
  if (matcher.hasMatch(blankTickerSigns(clean))) return true;
  const words = clean.split(/\s+/).filter((word) => word.length > 0);
  if (words.some(wordOffensive)) return true;
  return words.length > 1 && wordOffensive(words.join(''));
}

/**
 * Free text (an event or report summary) with each offensive word replaced by ARENA_MASK. Only a
 * word with at least two letters is read: the summaries print figures such as `1.53x`, which the
 * leetspeak table reads as a word. A phrase of several words is matched last.
 */
export function maskArenaFreeText(text: string): { text: string; masked: boolean } {
  let masked = false;
  const byWord = text.replace(FREE_TEXT_WORD, (word) => {
    if (letterCount(word) < 2 || !wordOffensive(word.normalize('NFKC'))) return word;
    masked = true;
    return ARENA_MASK;
  });
  // Figures and short codes are blanked (same length) before the phrase match, so it cannot read them.
  const readable = blankTickerSigns(byWord).replace(FREE_TEXT_WORD, (word) => (letterCount(word) < 2 ? ' '.repeat(word.length) : word));
  const matches = matcher.getAllMatches(readable, true);
  if (matches.length === 0) return { text: byWord, masked };
  return { text: censor.applyTo(byWord, matches), masked: true };
}

export type ArenaMasked<T> = T & { masked?: true };

/** A copy of `value` with each offensive string field in `keys` replaced by ARENA_MASK and `masked: true`; `value` itself when nothing matched. */
export function maskArenaFields<T extends object>(value: T, keys: ReadonlyArray<keyof T>): ArenaMasked<T> {
  let copy: Record<string, unknown> | null = null;
  for (const key of keys) {
    const field = value[key];
    if (typeof field !== 'string' || !isArenaTextOffensive(field)) continue;
    copy ??= { ...value } as Record<string, unknown>;
    copy[key as string] = ARENA_MASK;
  }
  return copy ? ({ ...copy, masked: true } as ArenaMasked<T>) : value;
}

/** A copy of an event or a report with offensive words in its `summary` masked (and `masked: true`). */
export function maskArenaSummary<T extends { summary: string }>(value: T): ArenaMasked<T> {
  const result = maskArenaFreeText(value.summary);
  return result.masked ? { ...value, summary: result.text, masked: true } : value;
}

// ─── The public payloads (routes/floor-arena.ts) ──────────────────────────────

/** Discovery row: the vendor's coin `symbol` and `name`. */
export function maskArenaDiscoveryRow<T extends { symbol: string | null; name: string | null }>(row: T): ArenaMasked<T> {
  return maskArenaFields(row, ['symbol', 'name']);
}

/** Tape item: the coin `symbol` and the trader `agentName`. */
export function maskArenaTapeItem<T extends { symbol: string | null; agentName: string }>(item: T): ArenaMasked<T> {
  return maskArenaFields(item, ['symbol', 'agentName']);
}

/** Position: the coin `symbol`. */
export function maskArenaPosition<T extends { symbol: string | null }>(position: T): ArenaMasked<T> {
  return maskArenaFields(position, ['symbol']);
}

/** Leaderboard row, contest row or agent profile: the trader `name`. */
export function maskArenaName<T extends { name: string }>(value: T): ArenaMasked<T> {
  return maskArenaFields(value, ['name']);
}
