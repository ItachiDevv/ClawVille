import type { Provider, ProviderResult } from './types';

/**
 * Avatar State Provider — surfaces the avatar's current stats into the agent prompt.
 *
 * Expects `state.petData` to contain the avatar row from the DB with fields:
 *   name, species, color, clawTokens, level, xp, archetype, loginStreak,
 *   stats ({ strength, defence, movement })
 */
export const petStateProvider: Provider = {
  name: 'avatar-state',
  description: 'Current avatar status: name, level, tokens, stats, login streak',
  position: 10,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const avatar = state?.petData;
    if (!avatar) {
      return { text: '', values: {}, data: {} };
    }

    const name = avatar.name ?? 'Unknown';
    const species = avatar.species ?? 'creature';
    const archetype = avatar.archetype ?? '';
    const level = avatar.level ?? 1;
    const clawTokens = avatar.clawTokens ?? 0;
    const loginStreak = avatar.loginStreak ?? 0;

    const stats = avatar.stats as { strength?: number; defence?: number; movement?: number } | null;
    const str = stats?.strength ?? 0;
    const def = stats?.defence ?? 0;
    const mov = stats?.movement ?? 0;

    const archetypeLabel = archetype ? `, ${archetype} archetype` : '';

    const text = [
      `[Avatar Status]`,
      `Name: ${name} (${species}${archetypeLabel})`,
      `Level ${level} | ${clawTokens} ClawTokens`,
      `Stats: STR ${str} \u00b7 DEF ${def} \u00b7 MOV ${mov}`,
      `Login streak: ${loginStreak} day${loginStreak === 1 ? '' : 's'}`,
    ].join('\n');

    return {
      text,
      values: {
        avatarName: name,
        avatarSpecies: species,
        petLevel: level,
        clawTokens,
      },
      data: {
        petData: avatar,
      },
    };
  },
};
