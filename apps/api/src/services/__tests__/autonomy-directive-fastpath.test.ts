import { describe, expect, it } from 'bun:test';
import {
  AUTONOMY_ENTERABLE_PLACES,
  BUILDING_OPENCLAW_THEMES,
  MAP_LOCATIONS,
  NPC_BUILDING_CENTERS,
} from '@clawville/shared';
import { parseDriverAction } from '../agent-autonomy-driver';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from '../house-refused-verbs';
import {
  DIRECTIVE_FASTPATH_ALIASES,
  DIRECTIVE_FASTPATH_DROPPED_ALIASES,
  directiveFastPathAction,
} from '../autonomy-directive-fastpath';

type Expected = { verb: string; params: Record<string, string> };

const lower = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const stripThe = (s: string): string => (s.startsWith('the ') ? s.slice(4) : s);
const dropped = new Set(DIRECTIVE_FASTPATH_DROPPED_ALIASES);

/** Every destination name generated from the real constants, with the call the decide prompt shows. */
function destinationCases(): Array<{ name: string; expected: Expected }> {
  const cases: Array<{ name: string; expected: Expected }> = [];
  for (const slug of Object.keys(NPC_BUILDING_CENTERS)) {
    const expected = { verb: 'enter_building', params: { buildingId: slug } };
    const names = new Set<string>([slug]);
    const label = BUILDING_OPENCLAW_THEMES[slug]?.label;
    if (label) names.add(label);
    const mapName = MAP_LOCATIONS.find((location) => location.id === slug)?.name;
    if (mapName) names.add(mapName);
    for (const name of names) cases.push({ name, expected });
  }
  for (const place of AUTONOMY_ENTERABLE_PLACES) {
    cases.push({ name: place.label, expected: { verb: place.actionVerb, params: {} } });
  }
  return cases.filter((c) => !dropped.has(stripThe(lower(c.name))));
}

function expectLine(text: string, expected: Expected, isHouse = false): void {
  const line = directiveFastPathAction({ text, isHouse });
  expect(line).not.toBeNull();
  const parsed = parseDriverAction(line!);
  expect(parsed).toEqual(expected);
}

describe('directive fast path: alias table', () => {
  it('drops exactly the Trading Floor aliases (building + place share them)', () => {
    expect([...DIRECTIVE_FASTPATH_DROPPED_ALIASES]).toEqual(['cron-automation', 'trading floor']);
  });

  it('every teaching building and place except the Trading Floor stays reachable', () => {
    const lines = new Set(DIRECTIVE_FASTPATH_ALIASES.values());
    for (const slug of Object.keys(NPC_BUILDING_CENTERS)) {
      if (slug === 'cron-automation') continue;
      expect(lines.has(`[ACTION: enter_building(buildingId=${slug})]`)).toBe(true);
    }
    for (const place of AUTONOMY_ENTERABLE_PLACES) {
      if (place.placeId === 'trading-floor') continue;
      expect(lines.has(`[ACTION: ${place.actionSyntax}]`)).toBe(true);
    }
    expect([...lines].some((line) => line.includes('cron-automation'))).toBe(false);
    expect(lines.has('[ACTION: enter_trading_floor()]')).toBe(false);
  });

  it('every alias round-trips through parseDriverAction', () => {
    for (const [alias, line] of DIRECTIVE_FASTPATH_ALIASES) {
      const parsed = parseDriverAction(line);
      expect(parsed).not.toBeNull();
      expect(directiveFastPathAction({ text: `go to ${alias}`, isHouse: false })).toBe(line);
    }
  });

  it('non-building map rows and prototype keys are not aliases', () => {
    for (const key of ['arcade city', 'claw-arcade', 'predictive gaming cove', 'constructor', '__proto__', 'tostring']) {
      expect(DIRECTIVE_FASTPATH_ALIASES.has(key)).toBe(false);
      expect(directiveFastPathAction({ text: `go to ${key}`, isHouse: false })).toBeNull();
    }
  });
});

describe('directive fast path: positives generated from the constants', () => {
  const cases = destinationCases();

  it('has a case for every non-dropped destination name', () => {
    expect(cases.length).toBeGreaterThanOrEqual(Object.keys(NPC_BUILDING_CENTERS).length);
  });

  for (const { name, expected } of cases) {
    it(`"${name}" across verb phrases and variants`, () => {
      const n = lower(name);
      const bare = stripThe(n);
      const variants = [
        `go to ${bare}`,
        `go to the ${bare}`,
        `walk to ${bare}`,
        `head to ${bare}`,
        `head over to ${bare}`,
        `go over to ${bare}`,
        `visit ${bare}`,
        `enter ${bare}`,
        `go into ${bare}`,
        `go in ${bare}`,
        `please go to ${bare}`,
        `go to ${bare} now`,
        `go to ${bare} please`,
        `go to ${bare}.`,
        `go to ${bare}!!`,
        `Go To ${name}`,
        `   GO   to    ${name.toUpperCase()}   `,
        `Please head over to the ${bare.toUpperCase()}!`,
      ];
      for (const text of variants) {
        expectLine(text, expected);
        expectLine(text, expected, true);
      }
    });
  }

  it('named spot checks', () => {
    expectLine('go to the cove', { verb: 'enter_cove', params: {} });
    expectLine('Go to cove.', { verb: 'enter_cove', params: {} });
    expectLine('go to the cove poker room', { verb: 'enter_poker_room', params: {} });
    expectLine('enter the kelp forest', { verb: 'enter_kelp_forest', params: {} });
    expectLine("go to sandy's treedome", { verb: 'enter_building', params: { buildingId: 'messaging-channels' } });
    expectLine("visit Squidward's House now", { verb: 'enter_building', params: { buildingId: 'memory-rag' } });
    expectLine('go to memory-rag', { verb: 'enter_building', params: { buildingId: 'memory-rag' } });
    expect(directiveFastPathAction({ text: 'go to the cove', isHouse: false })).toBe('[ACTION: enter_cove()]');
    expect(directiveFastPathAction({ text: 'go to memory-rag', isHouse: false })).toBe(
      '[ACTION: enter_building(buildingId=memory-rag)]',
    );
  });
});

describe('directive fast path: negatives return null', () => {
  const negatives = [
    'go to the cove and then play slots',
    'go to the cove after you learn about cron',
    "don't go to the cove",
    'dont go to the cove',
    'do not go to the cove',
    'never go to the cove',
    'go to the cove?',
    'learn about cron jobs',
    'go to cove 2',
    'go somewhere fun',
    'go to the trading floor',
    'go to cron-automation',
    'enter_trading_floor()',
    '',
    '   ',
    'go to the cove '.repeat(14),
    'x'.repeat(200),
    'visit the cove, please',
    'go to the cove\nplay slots',
    'go to the cove but stay safe',
    'if rich go to the cove',
    'go to the cove when ready',
    'go to the cove before noon',
    'go to the the cove',
    'go to the cove now please',
    'go to',
    'go to the',
    'cove',
    'the cove',
    'go to the cove. play slots',
    'go to the cove and play',
    'go to the cove then the kelp forest',
    'go to arcade city',
    'go to patricks rock',
    'go into to the cove',
    'please please go to the cove',
    'go to the cove... maybe',
    '[ACTION: enter_cove()]',
    'play slots at the cove',
  ];
  for (const text of negatives) {
    it(JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text), () => {
      expect(directiveFastPathAction({ text, isHouse: false })).toBeNull();
      expect(directiveFastPathAction({ text, isHouse: true })).toBeNull();
    });
  }

  it('non-string input is null', () => {
    expect(directiveFastPathAction({ text: undefined as unknown as string, isHouse: false })).toBeNull();
  });
});

describe('directive fast path: house agents', () => {
  it('no emitted verb is house-refused today (the refusal branch is a guard)', () => {
    const verbs = new Set(
      [...DIRECTIVE_FASTPATH_ALIASES.values()].map((line) => parseDriverAction(line)!.verb),
    );
    expect(verbs.size).toBeGreaterThan(0);
    for (const verb of verbs) expect(HOUSE_REFUSED_AUTONOMY_VERBS.has(verb)).toBe(false);
  });

  it('a house agent gets the same line as a user agent', () => {
    for (const alias of DIRECTIVE_FASTPATH_ALIASES.keys()) {
      expect(directiveFastPathAction({ text: `go to ${alias}`, isHouse: true })).toBe(
        directiveFastPathAction({ text: `go to ${alias}`, isHouse: false }),
      );
    }
  });
});
