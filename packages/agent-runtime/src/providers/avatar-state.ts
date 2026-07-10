import type { Provider, ProviderResult } from './types';

/**
 * Avatar State Provider — surfaces the avatar's current stats into the agent prompt.
 *
 * Expects `state.avatarData` to contain the avatar row from the DB with fields:
 *   name, species, color, clawTokens, level, xp, archetype, loginStreak,
 *   stats ({ strength, defence, movement }), learningFocus (Phase 6.1)
 */
export const avatarStateProvider: Provider = {
  name: 'avatar-state',
  description: 'Current avatar status: name, level, tokens, stats, login streak, learning focus',
  position: 10,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const avatar = state?.avatarData;
    if (!avatar) {
      return { text: '', values: {}, data: {} };
    }

    const name = avatar.name ?? 'Unknown';
    const species = avatar.species ?? 'creature';
    const archetype = avatar.archetype ?? '';
    const level = avatar.level ?? 1;
    const clawTokens = avatar.clawTokens ?? 0;
    const loginStreak = avatar.loginStreak ?? 0;
    // Phase 6.1 — surface the focus on every chat turn so existing avatars
    // that picked up a focus through /connect-token (after their
    // characterConfig was already baked at creation time) still get the
    // bias applied. The build-time injection in
    // `apps/api/src/routes/avatars.ts:buildCharacterConfig` covers
    // newly-created avatars; this provider line covers everyone else.
    const learningFocus =
      typeof avatar.learningFocus === 'string' && avatar.learningFocus.trim()
        ? avatar.learningFocus.trim()
        : null;

    const stats = avatar.stats as { strength?: number; defence?: number; movement?: number } | null;
    const str = stats?.strength ?? 0;
    const def = stats?.defence ?? 0;
    const mov = stats?.movement ?? 0;

    const archetypeLabel = archetype ? `, ${archetype} archetype` : '';

    const lines = [
      `[Avatar Status]`,
      `Name: ${name} (${species}${archetypeLabel})`,
      `Level ${level} | ${clawTokens} vCLAW`,
      `Stats: STR ${str} · DEF ${def} · MOV ${mov}`,
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
        avatarName: name,
        avatarSpecies: species,
        avatarLevel: level,
        clawTokens,
        learningFocus: learningFocus ?? '',
      },
      data: {
        avatarData: avatar,
      },
    };
  },
};
