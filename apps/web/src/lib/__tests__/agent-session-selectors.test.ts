import { describe, expect, test } from 'bun:test';
import { isBoundAgentSessionMode } from '../agent-session-selectors';

describe('isBoundAgentSessionMode', () => {
  test.each([
    [undefined, false],
    ['dismissed', false],
    ['none', false],
    ['provisioning-pending', false],
    ['hosted', true],
    ['external-active', true],
    ['external-idle', true],
    ['external-expired', true],
  ] as const)('mode %p has bound status %p', (mode, expected) => {
    expect(isBoundAgentSessionMode(mode)).toBe(expected);
  });
});
