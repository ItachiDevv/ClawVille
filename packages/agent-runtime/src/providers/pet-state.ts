import type { Provider, ProviderResult } from './types';

/**
 * Pet State Provider — surfaces the pet's current stats into the agent prompt.
 *
 * Expects `state.petData` to contain the pet row from the DB with fields:
 *   name, species, color, neoTokens, level, xp, archetype, loginStreak,
 *   stats ({ strength, defence, movement })
 */
export const petStateProvider: Provider = {
  name: 'pet-state',
  description: 'Current pet status: name, level, tokens, stats, login streak',
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
    const neoTokens = pet.neoTokens ?? 0;
    const loginStreak = pet.loginStreak ?? 0;

    const stats = pet.stats as { strength?: number; defence?: number; movement?: number } | null;
    const str = stats?.strength ?? 0;
    const def = stats?.defence ?? 0;
    const mov = stats?.movement ?? 0;

    const archetypeLabel = archetype ? `, ${archetype} archetype` : '';

    const text = [
      `[Pet Status]`,
      `Name: ${name} (${species}${archetypeLabel})`,
      `Level ${level} | ${neoTokens} NeoTokens`,
      `Stats: STR ${str} \u00b7 DEF ${def} \u00b7 MOV ${mov}`,
      `Login streak: ${loginStreak} day${loginStreak === 1 ? '' : 's'}`,
    ].join('\n');

    return {
      text,
      values: {
        petName: name,
        petSpecies: species,
        petLevel: level,
        neoTokens,
      },
      data: {
        petData: pet,
      },
    };
  },
};
