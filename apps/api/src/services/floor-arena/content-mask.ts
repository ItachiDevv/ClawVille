import { DataSet, RegExpMatcher, englishDataset, englishRecommendedTransformers, parseRawPattern } from 'obscenity';
import { FLOOR_ARENA_CONFUSABLES } from './confusables.generated';
import { FLOOR_ARENA_EXTRA_FOLDS } from './name-folds';

/**
 * Arena content mask (prod finding 2026-10-01: a coin symbol with a racial slur on the public
 * discovery feed). The ONE helper every public arena serializer uses for third-party text (coin
 * symbols and names from the vendors) and player text (trader names), and the launch name check.
 *
 * Scope (founder default 2026-10-01; the founder may revise it): HATE SLURS only (racial, ethnic,
 * religious, homophobic, transphobic, ableist). General profanity and sexual words are NOT masked,
 * so a coin such as SCAT ("Supa Cat") and stocks such as Cummins, Dick's Sporting Goods, Becton
 * Dickinson or Annaly show as written. One reclaimed word (q, 5 letters) is not masked.
 *
 * Matcher: the MIT-licensed `obscenity` package and its recommended transformers (confusable
 * characters, leetspeak, case, repeated letters). Of its English dataset only the slur entries stay
 * (DATASET_SLUR_WORDS); ARENA_SLUR_PHRASES adds the slurs that dataset lacks (review 2026-10-01).
 * Both lists are ROT13 here, so this file does not print the terms; decode one with
 * `echo <term> | tr 'A-Za-z' 'N-ZA-Mn-za-m'`. A pattern is written in the transformed form:
 * lower-case ASCII, a doubled letter written once except b, e, o, l, s and g. A `|` is a word edge:
 * a short term that also starts or ends common words matches only at that edge, so it is NOT
 * found glued to other letters on that side (BIGxxx, xxxCOIN): the glued-form limit,
 * docs/trading-floor-arena.md §5 and §8 P12. A whitelisted term contains a term but is not a slur
 * (spice, raccoon, Pakistan, "honky tonk", "Homo sapiens").
 *
 * Arena forms, because coin symbols are short and written to evade a filter:
 * - a ticker's leading `$` ($CAT) is a prefix, not leetspeak for s;
 * - a word is also read with `. _ ' -` removed (N.I.G.G.A), then folded: each non-ASCII letter,
 *   lower-cased, to its Unicode prototype (confusables.generated.ts, the table names.ts uses; the
 *   obscenity table misses capitals such as Cyrillic І and Greek Ι), and the arena's extra folds
 *   (name-folds.ts: 9 -> g, which the obscenity leetspeak table does not have);
 * - a run of pieces of one or two characters (after `$ . _ ' -` are removed) is read joined
 *   (N I G G A, N. I GG A). Only short pieces join (review M1): joining whole words read
 *   "Valentine Grok Companion" and "GNOME MINING GAME" as slurs.
 * The whole field is read first, so a whitelisted phrase of several words applies; a word is then
 * read alone only in a form the whole-field read did not see.
 *
 * A masked field reads ARENA_MASK and its object carries `masked: true`; the mint address stays,
 * so a client still identifies the coin. Free text (event and report summaries) has only the
 * offensive words replaced. The data in the database is never changed.
 */

export const ARENA_MASK = '***';

/** ROT13 (its own inverse): the term lists below are stored encoded. */
function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** The `originalWord` of each slur entry of obscenity's English dataset (ROT13). Every other entry is removed. */
const DATASET_SLUR_WORDS: ReadonlySet<string> = new Set([
  'norrq', 'nob', 'nsevpbba', 'nenohfu', 'obbatn', 'puvatpubat', 'puvax', 'qlxr', 'snt', 'xvxr', 'arteb', 'avttre',
  'ergneq', 'fcnfgvp', 'genaal',
].map(rot13));

/** Slurs the English dataset lacks (review 2026-10-01), ROT13: [term, patterns, whitelisted terms]. */
const ARENA_SLUR_PHRASES: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>?]> = [
  ['avtthu', ['avt[t]hu']],
  ['avtyrg', ['avtyrg']],
  ['avtabt', ['avtabt']],
  ['arterff', ['arterff']],
  ['fcvp', ['|fcvp', '|fcvx[f]|'], ['fcvpr', 'fcvpl', 'fcvpvre', 'fcvpvrfg', 'fcvprf', 'nyyfcvpr', 'fcvphyr', 'fcvpn', 'fcvpx naq fcna', 'fcvp naq fcna']],
  ['pbba', ['|pbba'], ['pbbaubhaq', 'pbbaubhaqf', 'glpbba', 'enppbba', 'enpbba', 'pbpbba', 'pbbarl']],
  ['tbbx', ['|tbbx[f]|']],
  ['xlxr', ['xlxr']],
  ['ulzvr', ['|ulzvr']],
  ['urro', ['|urro[f]|', '|uror[f]|']],
  ['lvq', ['|lvq[f]|']],
  ['jrgonpx', ['jrgonpx']],
  ['ornare', ['ornare'], ['ornarel']],
  ['enturnq', ['enturnq']],
  ['gbjryurnq', ['gbjryurnq']],
  ['cnxv', ['|cnxv[f]|'], ['cnxvfgna']],
  ['wnc', ['|wnc[f]|'], ['wncna']],
  ['qntb', ['|qntb[f]|']],
  ['jbc', ['|jbc[f]|']],
  ['tlc', ['|tlc[f]|', '|tlcfl[f]|', '|tlcfvrf|']],
  ['erqfxva', ['erqfxva']],
  ['vawha', ['|vawha[f]|']],
  ['fdhnj', ['|fdhnj[f]|']],
  ['wvtnobb', ['wvt[t]nobb', 'wvt[t]nob']],
  ['cbepuzbaxrl', ['cbepuzbaxrl', 'cbepu zbaxrl']],
  ['fnzob', ['|fnzob[f]|']],
  ['qnexvr', ['|qnexvr', '|qnexl|', '|qnexlf|']],
  ['tbyyvjbt', ['tbyyvjbt', 'tbyvjbt']],
  ['jbt', ['|jbt[f]|']],
  ['mvccreurnq', ['mvcreurnq']],
  ['fynagrlr', ['fynagrlr', 'fynag rlr']],
  ['ubaxl', ['|ubaxl[f]|', '|ubaxrl[f]|', '|ubaxvr[f]|'], ['ubaxl gbax', 'ubaxl-gbax']],
  ['juvgrl', ['|juvgrl[f]|']],
  ['pbbyvr', ['|pbbyvr[f]|']],
  ['xnsve', ['|xnsve[f]|'], ['xnssve yvzr', 'xnsve yvzr']],
  ['cbynpx', ['|cbynpx']],
  ['pnzrywbpxrl', ['pnzrywbpxrl', 'pnzry wbpxrl']],
  ['gneonol', ['gneonol', 'gne onol']],
  ['cvpxnavaal', ['cvpxnaval']],
  ['unysoerrq', ['unysoerrq', 'unys oerrq']],
  ['whatyrohaal', ['whatyrohal', 'whatyr ohal']],
  ['fcrnepuhpxre', ['fcrnepuhpxre']],
  ['puvanzna', ['puvanzna', 'puvanzra']],
  ['ternfronyy', ['ternfronyy']],
  ['jvttre', ['|jvt[t]re[f]|', '|jvt[t]n[f]|']],
  ['zhqfunex', ['zhqfunex']],
  ['pbbanff', ['pbbanff']],
  ['hapyrgbz', ['hapyrgbz', '|hapyr gbz[f]|']],
  ['ubzb', ['|ubzb[f]|'], ['ubzb fncvraf', 'ubzb rerpghf']],
  ['yrfob', ['|yrfob|']],
  ['genaavr', ['|genavr']],
  ['furznyr', ['|furznyr']],
  ['cbbs', ['|cbbs[f]|', '|cbbsgre', '|cbhs[f]|']],
  ['shqtrcnpxre', ['shqtrcnpxre']],
  ['pnecrgzhapure', ['pnecrgzhapure']],
  ['cvyybjovgre', ['cvyybjovgre']],
  ['ongglobl', ['onglobl', 'onglzna']],
  ['anaplobl', ['anaplobl']],
  ['ynqlobl', ['ynqlobl']],
  ['fcnm', ['|fcnm'], ['fcnmn']],
  ['zbatbybvq', ['zbatbybvq']],
];

function buildArenaDataset(): DataSet<{ originalWord: string }> {
  // A new DataSet: removePhrasesIf changes the set it is called on, and englishDataset is shared.
  const dataset = new DataSet<{ originalWord: string }>()
    .addAll(englishDataset)
    .removePhrasesIf((phrase) => !DATASET_SLUR_WORDS.has(phrase.metadata?.originalWord ?? ''));
  for (const [word, patterns, whitelist = []] of ARENA_SLUR_PHRASES) {
    dataset.addPhrase((phrase) => {
      let built = phrase.setMetadata({ originalWord: rot13(word) });
      for (const raw of patterns) built = built.addPattern(parseRawPattern(rot13(raw)));
      for (const term of whitelist) built = built.addWhitelistedTerm(rot13(term));
      return built;
    });
  }
  return dataset;
}

const matcher = new RegExpMatcher({ ...buildArenaDataset().build(), ...englishRecommendedTransformers });

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

/**
 * True when a form of `word` that the whole-text read did not see (`seen`) is offensive alone. The
 * form it saw is skipped, so a whitelisted phrase of several words is not undone word by word.
 */
function otherFormOffensive(word: string, seen: string): boolean {
  return wordForms(word).some((form) => form !== seen && matcher.hasMatch(form));
}

/** Each leading `$` of a word becomes a space, so `$CAT` is not read as "scat" and every index stays. */
function blankTickerSigns(text: string): string {
  return text.replace(/(^|\s)(\$+)/g, (_match, lead: string, signs: string) => lead + ' '.repeat(signs.length));
}

/** Each run of two or more pieces of one or two characters (`$ . _ ' -` removed), read joined: N I G G A. */
function shortRunOffensive(words: readonly string[]): boolean {
  let run: string[] = [];
  for (const piece of [...words.map((word) => word.replace(/^\$+/, '').replace(/[._'-]+/g, '')), '']) {
    const length = [...piece].length;
    if (length >= 1 && length <= 2) {
      run.push(piece);
      continue;
    }
    if (run.length > 1 && wordOffensive(run.join(''))) return true;
    run = [];
  }
  return false;
}

/**
 * True when a coin symbol, a coin name or a trader name reads as a slur, in any of the forms above.
 * Launch refuses such a trader name (400 `name_not_allowed`).
 */
export function isArenaTextOffensive(text: string): boolean {
  const clean = text.normalize('NFKC');
  if (matcher.hasMatch(blankTickerSigns(clean))) return true;
  const words = clean.split(/\s+/).filter((word) => word.length > 0);
  if (words.some((word) => otherFormOffensive(word, word.replace(/^\$+/, '')))) return true;
  return shortRunOffensive(words);
}

/**
 * Free text (an event or report summary) with each offensive word replaced by ARENA_MASK. Only a
 * word with at least two letters is read: the summaries print figures such as `1.53x`, which the
 * leetspeak table reads as a word. The whole text is read first (a match there masks every word it
 * touches), then each word alone in the forms that read did not see.
 */
export function maskArenaFreeText(text: string): { text: string; masked: boolean } {
  // Figures and short codes are blanked (same length), so the whole-text read cannot see them.
  const readable = blankTickerSigns(text).replace(FREE_TEXT_WORD, (word) => (letterCount(word) < 2 ? ' '.repeat(word.length) : word));
  const hits = matcher.getAllMatches(readable);
  let masked = false;
  const result = text.replace(FREE_TEXT_WORD, (word: string, offset: number) => {
    if (letterCount(word) < 2) return word;
    const last = offset + word.length - 1;
    const inContext = hits.some((hit) => hit.startIndex <= last && hit.endIndex >= offset);
    if (!inContext && !otherFormOffensive(word.normalize('NFKC'), readable.slice(offset, last + 1).trim())) return word;
    masked = true;
    return ARENA_MASK;
  });
  return { text: result, masked };
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
