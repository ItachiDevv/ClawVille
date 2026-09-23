/**
 * Turn the operator's plain-words choices into DoorDash `nested_options`.
 *
 * WHY THE SERVER DOES THIS, NOT THE MODEL. An item like a Wawa custom hoagie has
 * REQUIRED option groups (bread, toasting, cheese) with option ids the model
 * never sees across turns, because DoorDash output is excluded from chat memory.
 * Letting the model invent or recall ids would put vendor ids under model
 * control on the path that builds a real cart. So the model passes only the
 * words the operator used ("classic roll, not toasted, provolone, mayo") and
 * this module matches them against the option list DoorDash returned for that
 * exact item. Anything it cannot match unambiguously is reported back as a
 * question; it never guesses a required choice.
 *
 * Shape: `restaurant-item-details` item.extras[], LIVE-CAPTURED 2026-09-18 from
 * Wawa store 897466, item "Custom Italian Hoagie" (see the test fixture).
 */

export interface DdOption {
  option_id: string | number;
  name: string;
  is_default?: boolean;
  extras?: DdOptionGroup[];
}
export interface DdOptionGroup {
  extra_id: string | number;
  title: string;
  min_num_options: number;
  max_num_options: number;
  options: DdOption[];
}
export interface NestedOption {
  id: string;
  name: string;
  quantity: number;
  options?: NestedOption[];
}
export interface ChoiceGap {
  title: string;
  min: number;
  max: number;
  options: string[];
  reason?: string;
}
export type ChoiceResult =
  | { ok: true; nested: NestedOption[]; picked: string[] }
  | { ok: false; missing: ChoiceGap[]; tooMany: ChoiceGap[]; optionalTitles: string[] };

/** Most options one item may carry. Bounds the argv and the vendor payload. */
export const MAX_NESTED_OPTIONS = 40;

/** Vendor text is data. Strip anything that could read as markup or an action tag. */
export function cleanVendorText(value: string, max = 60): string {
  return value.replace(/[\u0000-\u001f\u007f\[\]<>{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Plural-insensitive word: "hoagies" = "hoagie", "pickles" = "pickle", but "swiss" stays. */
export function singularWord(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function normalize(value: string): string {
  const words = value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map(singularWord);
  return ` ${words.join(' ')} `;
}

/** A small literal matcher, not a parser that invents ingredient substitutions. */
function choiceMentions(groups: DdOptionGroup[], text: string): {
  mentions: Map<DdOption, Set<'yes' | 'no' | 'unclear'>>;
  unsupportedRemoval: boolean;
} {
  // Keep clause punctuation. normalize() alone destroys exclusion boundaries.
  const tokenize = (value: string) => value.toLowerCase().replace(/[’']/g, "'").replace(/\bdon'?t\b/g, 'do not')
    .split(/([,;.!?])/).flatMap((part) => /^[,;.!?]$/.test(part)
      ? [part] : part.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
  const tokens = tokenize(text);
  const options = groups.flatMap((group) => group.options).map((option) => ({
    // Preserve punctuation inside literal names (e.g. Dr. Pepper). Matching
    // the full name first prevents its period from becoming a clause break.
    option, words: tokenize(option.name).map(singularWord),
  }));
  const negativeLiteralGroups = new Set<DdOptionGroup>();
  const result = new Map<DdOption, Set<'yes' | 'no' | 'unclear'>>();
  let excluded = false;
  let exclusionPending = false;
  let uncertain = false;
  let alternative = false;
  let unsupportedRemoval = false;
  const clausePicks: DdOption[] = [];
  const record = (option: DdOption, state: 'yes' | 'no' | 'unclear') => {
    const states = result.get(option) ?? new Set<'yes' | 'no' | 'unclear'>();
    states.add(state);
    result.set(option, states);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // Match vendor names first: "No Mayo" and "Not Toasted" are real choices,
    // and "Toast Roll or Bread Only" contains an ordinary word "or".
    const matches = options.flatMap(({ option, words }) => {
      let consumed = 0;
      const literal = words.every((word) => {
        // A vendor abbreviation period is optional in the user's spelling;
        // arbitrary user periods still remain clause boundaries.
        if (word === '.' && tokens[index + consumed] !== '.') return true;
        if (singularWord(tokens[index + consumed] ?? '') !== word) return false;
        consumed += 1;
        return true;
      });
      const compact = words.filter((word) => /^[a-z0-9]+$/.test(word)).join('');
      const length = words.length && literal ? consumed
        : words.length > 1 && singularWord(token) === compact ? 1 : 0;
      return length ? [{ option, length }] : [];
    });
    const longest = Math.max(0, ...matches.map((match) => match.length));
    if (longest) {
      const postfixExclusion = ['free', 'removed', 'excluded'].includes(tokens[index + longest] ?? '');
      for (const { option } of matches.filter((match) => match.length === longest)) {
        const ownGroups = groups.filter((group) => group.options.includes(option));
        const afterNegativeLiteral = ownGroups.some((group) => negativeLiteralGroups.has(group));
        record(option, uncertain || afterNegativeLiteral ? 'unclear' : excluded || postfixExclusion ? 'no' : 'yes');
        if (!excluded && alternative) {
          record(option, 'unclear');
          for (const prior of clausePicks) record(prior, 'unclear');
        }
        if (!excluded) clausePicks.push(option);
        if (/^(no|not|without)\b/.test(option.name.toLowerCase())) {
          for (const group of ownGroups) negativeLiteralGroups.add(group);
        }
      }
      exclusionPending = false;
      index += longest - 1;
      continue;
    }
    if (/^[;.!?]$/.test(token)) {
      unsupportedRemoval ||= exclusionPending;
      excluded = exclusionPending = uncertain = alternative = false;
      clausePicks.length = 0;
      negativeLiteralGroups.clear();
    } else if (token === ',') {
      // "No mayo, ranch" can be an exclusion list or a new choice. Ask.
      uncertain ||= excluded;
      alternative = false;
      clausePicks.length = 0;
    } else if (token === 'not' && tokens[index + 1] === 'only') {
      uncertain = true;
      index += 1;
    } else if (['no', 'not', 'without', 'hold', 'skip', 'omit', 'remove', 'minus', 'except', 'avoid'].includes(token)
      || (token === 'but' && ['anything', 'everything', 'all'].includes(tokens[index - 1] ?? ''))
      || (token === 'leave' && ['off', 'out'].includes(tokens[index + 1] ?? ''))) {
      excluded = exclusionPending = true;
      uncertain = alternative = false;
    } else if (['add', 'with', 'include', 'plus', 'but', 'instead'].includes(token) && !exclusionPending) {
      excluded = uncertain = alternative = false;
      clausePicks.length = 0;
      negativeLiteralGroups.clear();
    } else if (token === 'or' && !excluded) {
      alternative = true;
    } else if (((excluded || negativeLiteralGroups.size > 0)
      && !['the', 'a', 'an', 'any', 'and', 'or', 'please', 'thanks', 'do', 'want', 'use', 'add', 'include', 'put', 'have', 'off', 'out', 'on', 'it', 'for', 'me', 'at', 'all'].includes(token))
      || ['free', 'removed', 'excluded'].includes(tokens[index + 1] ?? '')) {
      // An unrecognized ingredient cannot be removed by omitting vendor IDs.
      unsupportedRemoval = true;
    }
  }
  return { mentions: result, unsupportedRemoval: unsupportedRemoval || exclusionPending };
}

/**
 * Among matches for a pick-one group, drop any whose name is contained in a
 * longer match. If a group offered both "Wheat Roll" and "Shorti Wheat Roll",
 * saying "shorti wheat roll" matches both phrases; the longer, more specific
 * name is the one the operator meant.
 */
function mostSpecific(matches: DdOption[]): DdOption[] {
  return matches.filter((a) => !matches.some((b) => b !== a
    && normalize(b.name).includes(normalize(a.name))));
}

function subSelections(option: DdOption): { nested: NestedOption[]; gap: ChoiceGap | null } {
  const nested: NestedOption[] = [];
  for (const group of option.extras ?? []) {
    if (group.min_num_options < 1) continue;
    // A required sub-choice (e.g. Oil -> Little Bit / Regular / Extra) takes the
    // vendor's own default. Sub-option names repeat across parents ("Little
    // Bit" exists under both Oil and Vinegar), so free-text matching here would
    // guess which parent the operator meant; the default is the honest answer.
    const defaults = group.options.filter((o) => o.is_default).slice(0, group.max_num_options);
    if (defaults.length < group.min_num_options) {
      return {
        nested: [],
        gap: {
          title: `${cleanVendorText(option.name)}: ${cleanVendorText(group.title)}`,
          min: group.min_num_options,
          max: group.max_num_options,
          options: group.options.map((o) => cleanVendorText(o.name)),
        },
      };
    }
    for (const pick of defaults) nested.push({ id: String(pick.option_id), name: cleanVendorText(pick.name, 120), quantity: 1 });
  }
  return { nested, gap: null };
}

export function resolveChoices(groups: DdOptionGroup[], choicesText: string): ChoiceResult {
  // These constructions relate two ingredients. The literal matcher cannot
  // determine that relation, so it must not turn either phrase into additions.
  // Ask for separate positive/exclusion clauses instead of guessing a swap.
  if (/\b(?:neither|nor|cannot)\b|\b(?:instead\s+of|rather\s+than)\b|\b(?:can|won|wouldn|shouldn|couldn|isn|aren|wasn|weren|mustn|haven|hasn|hadn|needn)['’]t\b/i.test(choicesText)) {
    return { ok: false, missing: [{
      title: 'Your choices', min: 0, max: 0, options: [],
      reason: 'Please state each choice separately, such as "add ranch; no mayo". I have not added the item',
    }], tooMany: [], optionalTitles: [] };
  }
  const { mentions, unsupportedRemoval } = choiceMentions(groups, choicesText);
  const nested: NestedOption[] = [];
  const picked: string[] = [];
  const missing: ChoiceGap[] = [];
  const tooMany: ChoiceGap[] = [];
  const optionalTitles: string[] = [];
  if (unsupportedRemoval) missing.push({
    title: 'Ingredient removal', min: 0, max: 0, options: [],
    reason: 'I cannot confirm that ingredient removal from this item’s options. Please choose a listed removal option or another item',
  });

  for (const group of groups) {
    const gap: ChoiceGap = {
      title: cleanVendorText(group.title),
      min: group.min_num_options,
      max: group.max_num_options,
      options: group.options.map((o) => cleanVendorText(o.name)),
    };
    let matches = group.options.filter((o) => mentions.get(o)?.has('yes'));
    if (group.max_num_options === 1 && matches.length > 1) matches = mostSpecific(matches);
    if (matches.length > group.max_num_options) {
      tooMany.push(gap);
      continue;
    }
    if (group.options.some((option) => {
      const states = mentions.get(option);
      return states?.has('unclear') || (states?.has('yes') && states.has('no'))
        // Omitting an option does not prove removal of a vendor default.
        || (option.is_default && states?.has('no'));
    })) {
      missing.push(gap);
      continue;
    }
    if (matches.length < group.min_num_options) {
      missing.push(gap);
      continue;
    }
    if (group.min_num_options === 0 && matches.length === 0) optionalTitles.push(gap.title);
    for (const option of matches) {
      const sub = subSelections(option);
      if (sub.gap) {
        missing.push(sub.gap);
        continue;
      }
      nested.push({
        id: String(option.option_id),
        name: cleanVendorText(option.name, 120),
        quantity: 1,
        ...(sub.nested.length ? { options: sub.nested } : {}),
      });
      picked.push(cleanVendorText(option.name));
    }
  }

  if (missing.length || tooMany.length) return { ok: false, missing, tooMany, optionalTitles };
  const count = nested.reduce((n, o) => n + 1 + (o.options?.length ?? 0), 0);
  if (count > MAX_NESTED_OPTIONS) {
    return { ok: false, missing: [], tooMany: [{ title: 'Total choices', min: 0, max: MAX_NESTED_OPTIONS, options: [] }], optionalTitles };
  }
  return { ok: true, nested, picked };
}

/** One plain sentence per unresolved group, for the operator to answer. */
export function describeGaps(itemName: string, result: Extract<ChoiceResult, { ok: false }>): string {
  const range = (g: ChoiceGap) => (g.min === g.max ? `pick ${g.min}` : `pick ${g.min} to ${g.max}`);
  const lines = [
    ...result.missing.map((g) => g.reason ?? `${g.title} (${range(g)}): ${g.options.slice(0, 12).join(', ')}`),
    ...result.tooMany.map((g) => `${g.title}: too many picked, ${range(g)}`),
  ];
  const optional = result.optionalTitles.length
    ? ` Optional: ${result.optionalTitles.slice(0, 8).join(', ')}.`
    : '';
  return `${cleanVendorText(itemName)} needs your choices. ${lines.join('. ')}.${optional} Tell me your picks in one message.`;
}
