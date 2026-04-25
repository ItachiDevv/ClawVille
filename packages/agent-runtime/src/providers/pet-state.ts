import type { Provider, ProviderResult } from './types';

/**
 * Pet State Provider — surfaces the pet's current stats into the agent prompt.
 *
 * Expects `state.petData` to contain the pet row from the DB with fields:
 *   name, species, color, clawTokens, level, xp, archetype, loginStreak,
 *   stats ({ strength, defence, movement }), learningFocus (Phase 6.1)
 */
export const petStateProvider: Provider = {
  name: 'pet-state',
  description: 'Current pet status: name, level, tokens, stats, login streak, learning focus',
  position: 10,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const pet = state?.petData;
    if (!pet) {
      return { text: '', values: {}, data: {} };
    }

    const name = pet.name ?? 'Unknown';
    const species = pet.species ?? 'creature';
    const archetype = pet.archetype ?? '';
    const level = pet.level ?? 1;
    const clawTokens = pet.clawTokens ?? 0;
    const loginStreak = pet.loginStreak ?? 0;
    // Phase 6.1 — surface the focus on every chat turn so existing pets
    // that picked up a focus through /connect-token (after their
    // characterConfig was already baked at creation time) still get the
    // bias applied. The build-time injection in
    // `apps/api/src/routes/pets.ts:buildCharacterConfig` covers
    // newly-created pets; this provider line covers everyone else.
    const learningFocus =
      typeof pet.learningFocus === 'string' && pet.learningFocus.trim()
        ? pet.learningFocus.trim()
        : null;

    const stats = pet.stats as { strength?: number; defence?: number; movement?: number } | null;
    const str = stats?.strength ?? 0;
    const def = stats?.defence ?? 0;
    const mov = stats?.movement ?? 0;

    const archetypeLabel = archetype ? `, ${archetype} archetype` : '';

    const lines = [
      `[Pet Status]`,
      `Name: ${name} (${species}${archetypeLabel})`,
      `Level ${level} | ${clawTokens} ClawTokens`,
      `Stats: STR ${str} \u00b7 DEF ${def} \u00b7 MOV ${mov}`,
      `Login streak: ${loginStreak} day${loginStreak === 1 ? '' : 's'}`,
    ];
    if (learningFocus) {
      lines.push(
        `Learning focus (set by human): ${learningFocus}. Bias toward the matching building's teacher.`,
      );
    }

    return {
      text: lines.join('\n'),
      values: {
        petName: name,
        petSpecies: species,
        petLevel: level,
        clawTokens,
        learningFocus: learningFocus ?? '',
      },
      data: {
        petData: pet,
      },
    };
  },
};
