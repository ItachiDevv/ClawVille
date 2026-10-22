/**
 * Directive fast path (founder go 2026-10-20: "faster path, same decision").
 *
 * An owner gives an autonomous agent a free-text directive. The driver sends
 * every decision to the agent's own model (about 5 s), with the directive as top
 * priority. When the directive is NOTHING BUT a plain "go to <one destination>"
 * command, the model has exactly one correct answer, so this pure function
 * returns that answer (the exact `[ACTION: ...]` line) and the driver can skip
 * the model call for that first decision.
 *
 * Contract: anything that is not a plain single-destination command returns
 * null and goes to the model as today. When in doubt, null. No I/O, no LLM, no
 * randomness.
 *
 * Destinations come from the SAME constants the decide prompt and the executor
 * use:
 *   - teaching buildings: Object.keys(NPC_BUILDING_CENTERS) (the set
 *     `resolveBuildingId` accepts) -> `enter_building(buildingId=<slug>)`;
 *     aliases are the slug, BUILDING_OPENCLAW_THEMES label, MAP_LOCATIONS name.
 *   - enterable places: AUTONOMY_ENTERABLE_PLACES -> the place's own
 *     `actionSyntax`; aliases are the label, plus the destinationId when no
 *     other place shares it.
 *   - explicit override: "cove" / "the cove" -> enter_cove().
 * An alias that maps to more than one action line is dropped entirely (see
 * DIRECTIVE_FASTPATH_DROPPED_ALIASES; today "trading floor" and
 * "cron-automation" drop, because the Trading Floor is both the cron-automation
 * teaching building and the enter_trading_floor place).
 */
import {
  AUTONOMY_ENTERABLE_PLACES,
  BUILDING_OPENCLAW_THEMES,
  HATCHER_ACTION_MENU,
  MAP_LOCATIONS,
  NPC_BUILDING_CENTERS,
} from '@clawville/shared';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from './house-refused-verbs';

export interface DirectiveFastPathInput {
  text: string;
  isHouse: boolean;
}

const MAX_DIRECTIVE_CHARS = 80;

/** Whole-word stop words: any of these means the directive is not a plain go-to. */
const REJECT_WORDS: ReadonlySet<string> = new Set([
  'and',
  'then',
  'after',
  'before',
  'but',
  "don't",
  'dont',
  'not',
  'never',
  'if',
  'when',
]);

/** Longest first so "go into" never parses as "go in" + "to ...". */
const VERB_PHRASES = [
  'head over to',
  'go over to',
  'go into',
  'walk to',
  'head to',
  'go to',
  'visit',
  'enter',
  'go in',
] as const;

const COMMAND_RE = new RegExp(`^(?:please )?(?:${VERB_PHRASES.join('|')}) (.+)$`);

/** Lowercase, collapse whitespace, and remove ONE leading "the ". */
function aliasKey(raw: string): string {
  const collapsed = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return collapsed.startsWith('the ') ? collapsed.slice(4) : collapsed;
}

interface AliasTable {
  aliases: Map<string, string>;
  dropped: string[];
}

function buildAliasTable(): AliasTable {
  // Map, not a plain object: "constructor" / "__proto__" can never resolve.
  const candidates = new Map<string, Set<string>>();
  const add = (alias: string | undefined, line: string): void => {
    if (!alias) return;
    const key = aliasKey(alias);
    if (!key) return;
    let lines = candidates.get(key);
    if (!lines) {
      lines = new Set<string>();
      candidates.set(key, lines);
    }
    lines.add(line);
  };

  for (const slug of Object.keys(NPC_BUILDING_CENTERS)) {
    const line = `[ACTION: enter_building(buildingId=${slug})]`;
    add(slug, line);
    add(BUILDING_OPENCLAW_THEMES[slug]?.label, line);
    add(MAP_LOCATIONS.find((location) => location.id === slug)?.name, line);
  }

  const destinationUse = new Map<string, number>();
  for (const place of AUTONOMY_ENTERABLE_PLACES) {
    destinationUse.set(place.destinationId, (destinationUse.get(place.destinationId) ?? 0) + 1);
  }
  for (const place of AUTONOMY_ENTERABLE_PLACES) {
    const line = `[ACTION: ${place.actionSyntax}]`;
    add(place.label, line);
    if (destinationUse.get(place.destinationId) === 1) add(place.destinationId, line);
  }

  const aliases = new Map<string, string>();
  const dropped: string[] = [];
  for (const [key, lines] of candidates) {
    if (lines.size === 1) aliases.set(key, [...lines][0]);
    else dropped.push(key);
  }

  // Explicit rule: "cove" / "the cove" is the Cove itself (enter_cove), never
  // the poker room that shares its destinationId.
  const cove = AUTONOMY_ENTERABLE_PLACES.find((place) => place.placeId === 'cove');
  if (cove) {
    const coveKey = aliasKey('cove');
    aliases.set(coveKey, `[ACTION: ${cove.actionSyntax}]`);
    const idx = dropped.indexOf(coveKey);
    if (idx >= 0) dropped.splice(idx, 1);
  }

  return { aliases, dropped: dropped.sort() };
}

const TABLE = buildAliasTable();

/** Destination alias (lowercase, no leading "the ") -> exact action line. */
export const DIRECTIVE_FASTPATH_ALIASES: ReadonlyMap<string, string> = TABLE.aliases;

/** Aliases dropped because they map to more than one action line. */
export const DIRECTIVE_FASTPATH_DROPPED_ALIASES: readonly string[] = TABLE.dropped;

const MENU_VERBS: ReadonlySet<string> = new Set(HATCHER_ACTION_MENU.map((action) => action.verb));

function lineVerb(line: string): string | null {
  const match = /^\[ACTION: (\w+)\(/.exec(line);
  return match ? match[1] : null;
}

/**
 * `rest` is everything after the verb phrase: optional "the " + DESTINATION +
 * optional " now" / " please". Stored keys never start with "the " (aliasKey
 * strips one), so a doubled article ("the the cove") can never match.
 */
function resolveDestination(rest: string): string | null {
  const direct = DIRECTIVE_FASTPATH_ALIASES.get(aliasKey(rest));
  if (direct !== undefined) return direct;
  for (const suffix of [' now', ' please']) {
    if (rest.endsWith(suffix)) {
      const viaSuffix = DIRECTIVE_FASTPATH_ALIASES.get(aliasKey(rest.slice(0, -suffix.length)));
      if (viaSuffix !== undefined) return viaSuffix;
    }
  }
  return null;
}

/**
 * Returns the exact action line (e.g. "[ACTION: enter_cove()]" or
 * "[ACTION: enter_building(buildingId=memory-rag)]") or null.
 */
export function directiveFastPathAction(input: DirectiveFastPathInput): string | null {
  if (typeof input?.text !== 'string') return null;
  const trimmed = input.text.trim();
  if (!trimmed || trimmed.length > MAX_DIRECTIVE_CHARS) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  if (/[,?\d]/.test(trimmed)) return null;

  const text = trimmed.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trimEnd();
  if (!text) return null;
  if (text.split(' ').some((word) => REJECT_WORDS.has(word))) return null;

  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  const line = resolveDestination(match[1]);
  if (!line) return null;

  const verb = lineVerb(line);
  if (!verb || !MENU_VERBS.has(verb)) return null;
  if (input.isHouse && HOUSE_REFUSED_AUTONOMY_VERBS.has(verb)) return null;
  return line;
}
