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

function normalize(value: string): string {
  return ` ${value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Whole-phrase match: "roll" must not match inside "rolled", "ham" not inside "hamburger". */
function mentions(haystack: string, name: string): boolean {
  const needle = normalize(name).trim();
  return needle.length > 0 && haystack.includes(` ${needle} `);
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
  const said = normalize(choicesText);
  const nested: NestedOption[] = [];
  const picked: string[] = [];
  const missing: ChoiceGap[] = [];
  const tooMany: ChoiceGap[] = [];
  const optionalTitles: string[] = [];

  for (const group of groups) {
    const gap: ChoiceGap = {
      title: cleanVendorText(group.title),
      min: group.min_num_options,
      max: group.max_num_options,
      options: group.options.map((o) => cleanVendorText(o.name)),
    };
    let matches = group.options.filter((o) => mentions(said, o.name));
    if (group.max_num_options === 1 && matches.length > 1) matches = mostSpecific(matches);
    if (matches.length > group.max_num_options) {
      tooMany.push(gap);
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
    ...result.missing.map((g) => `${g.title} (${range(g)}): ${g.options.slice(0, 12).join(', ')}`),
    ...result.tooMany.map((g) => `${g.title}: too many picked, ${range(g)}`),
  ];
  const optional = result.optionalTitles.length
    ? ` Optional: ${result.optionalTitles.slice(0, 8).join(', ')}.`
    : '';
  return `${cleanVendorText(itemName)} needs your choices. ${lines.join('. ')}.${optional} Tell me your picks in one message.`;
}
