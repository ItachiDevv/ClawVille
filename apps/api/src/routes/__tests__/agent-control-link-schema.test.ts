import { describe, expect, test } from 'bun:test';
import { controlLinkSchema } from '../agent-gateway';

describe('agent control-link identity schema', () => {
  test('accepts exactly the four supported public identity types', () => {
    for (const identityType of ['milady', 'hermes', 'openclaw', 'custom']) {
      expect(controlLinkSchema.safeParse({ identityType, identityKey: 'secret' }).success).toBe(true);
    }
    for (const identityType of ['nanoclaw', 'anonymous', 'ironclaw', 'hatcher']) {
      expect(controlLinkSchema.safeParse({ identityType, identityKey: 'secret' }).success).toBe(false);
    }
  });
});
