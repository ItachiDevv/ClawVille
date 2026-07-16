import { describe, expect, test } from 'bun:test';
import { resolveRestoreAvatarIdFailOpen } from '../agent-session-restore';

describe('session restore covenant attribution', () => {
  test('returns the active avatar id when optional attribution resolves', async () => {
    const warnings: string[] = [];

    const result = await resolveRestoreAvatarIdFailOpen('user-1', {
      findActiveAvatarId: async () => ({ id: 'avatar-1' }),
      warn: (message) => warnings.push(message),
    });

    expect(result).toBe('avatar-1');
    expect(warnings).toEqual([]);
  });

  test('continues recordless when the optional attribution query fails', async () => {
    const warnings: string[] = [];

    const result = await resolveRestoreAvatarIdFailOpen('user-1', {
      findActiveAvatarId: async () => {
        throw new Error('database unavailable');
      },
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('continuing recordless');
  });

  test('does not query when the persisted session has no bound user', async () => {
    let queried = false;

    const result = await resolveRestoreAvatarIdFailOpen(null, {
      findActiveAvatarId: async () => {
        queried = true;
        return { id: 'unexpected' };
      },
      warn: () => undefined,
    });

    expect(result).toBeUndefined();
    expect(queried).toBe(false);
  });
});
