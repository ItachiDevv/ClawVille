/**
 * Unit coverage for the P3 slice-2 directive→building resolver (spec Advisory-1:
 * id + label matching). The resolver is a pure function in @clawville/agent-runtime;
 * imported from source (no ElizaOS/DB chain) and driven directly here in the
 * apps/api bun suite (the runtime package has no test runner of its own).
 */
import { describe, expect, it } from 'bun:test';
import { resolveDirectiveBuildingId } from '@clawville/agent-runtime';
import { NPC_BUILDING_CENTERS, MAP_LOCATIONS } from '@clawville/shared';

// Real id→label map exactly as the bridge builds it (memory-rag → "Squidward's House").
const LABELS: Record<string, string> = Object.fromEntries(MAP_LOCATIONS.map((l) => [l.id, l.name]));

const directive = (body: string) =>
  `YOUR HUMAN'S CURRENT DIRECTIVE (top priority — act on this before anything else): "${body}"`;

describe('resolveDirectiveBuildingId', () => {
  it('matches by building id token (memory-rag)', () => {
    expect(
      resolveDirectiveBuildingId(
        directive('Walk to the memory-rag building immediately and stay there.'),
        NPC_BUILDING_CENTERS,
        LABELS,
      ),
    ).toBe('memory-rag');
  });

  it('matches by DISPLAY NAME even when the id is not present (Advisory-1)', () => {
    // The live founder-facing case: natural language, no machine id.
    expect(
      resolveDirectiveBuildingId(
        directive("Walk to Squidward's House and stay there."),
        NPC_BUILDING_CENTERS,
        LABELS,
      ),
    ).toBe('memory-rag');
  });

  it('returns null for a directive that names no known building (bare topic / free text)', () => {
    expect(
      resolveDirectiveBuildingId(directive('learn about cron jobs and have fun'), NPC_BUILDING_CENTERS, LABELS),
    ).toBeNull();
    expect(resolveDirectiveBuildingId('', NPC_BUILDING_CENTERS, LABELS)).toBeNull();
    expect(resolveDirectiveBuildingId('   ', NPC_BUILDING_CENTERS, LABELS)).toBeNull();
  });

  it('prefers the LONGEST needle so a specific label beats a shorter accidental token', () => {
    // Synthetic centers + labels where a short label is a token-prefix of a longer one.
    const centers = { alpha: { x: 0, y: 0 }, beta: { x: 1, y: 1 } } as typeof NPC_BUILDING_CENTERS;
    const labels = { alpha: 'Foo', beta: 'Foo Bar' };
    // "Foo Bar" (beta) must win over "Foo" (alpha) even though "Foo" also matches.
    expect(resolveDirectiveBuildingId(directive('please go to Foo Bar now'), centers, labels)).toBe('beta');
    // And the shorter one still resolves on its own.
    expect(resolveDirectiveBuildingId(directive('please go to Foo now'), centers, labels)).toBe('alpha');
  });

  it('respects token boundaries — a building id embedded in a larger word does NOT match', () => {
    // "code development" is a raw substring of "decode developmental" but not a whole token.
    expect(
      resolveDirectiveBuildingId(directive('I decode developmental patterns'), NPC_BUILDING_CENTERS, LABELS),
    ).toBeNull();
    // Sanity: the same id matched as a whole token DOES resolve.
    expect(
      resolveDirectiveBuildingId(directive('head to code-development now'), NPC_BUILDING_CENTERS, LABELS),
    ).toBe('code-development');
  });

  it('is id-only (no throw, byte-identical) when no labels are supplied', () => {
    expect(
      resolveDirectiveBuildingId(directive('go to memory-rag'), NPC_BUILDING_CENTERS),
    ).toBe('memory-rag');
    // Without labels, a name-only directive can no longer resolve.
    expect(
      resolveDirectiveBuildingId(directive("go to Squidward's House"), NPC_BUILDING_CENTERS),
    ).toBeNull();
  });
});
