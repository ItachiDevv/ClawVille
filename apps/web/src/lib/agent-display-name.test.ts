import { describe, expect, test } from 'bun:test';
import { agentDisplayName } from './agent-display-name';

describe('agentDisplayName', () => {
  test('is "<username> agent"', () => {
    expect(agentDisplayName('itachi', '444hoodie')).toBe('itachi agent');
  });
  test('falls back to the avatar name when there is no username', () => {
    expect(agentDisplayName(null, 'LandTest1')).toBe('LandTest1 agent');
    expect(agentDisplayName('  ', 'LandTest1')).toBe('LandTest1 agent');
  });
  test('never doubles the suffix', () => {
    expect(agentDisplayName('itachi agent', null)).toBe('itachi agent');
    expect(agentDisplayName(null, 'Scout Agent')).toBe('Scout Agent');
  });
  test('has a neutral label when nothing is known', () => {
    expect(agentDisplayName(undefined, undefined)).toBe('Your agent');
  });
});
