import { describe, expect, test } from 'bun:test';
import { CLAWVILLE_ORIENTATION_KNOWLEDGE, getServerColliders } from '@clawville/shared';
import { townGuide } from '@clawville/agent-templates';
import { buildProtocolManual } from '../skill-protocol';

// 2026-09-18, production: Nori told a player that Pearl held the bounties.
// All three knowledge surfaces described bounty rules but none said WHERE the
// board is, so the model invented a holder. Each surface must state the place.

const surfaces: Record<string, string> = {
  'Nori knowledge[]': townGuide.knowledge.join('\n'),
  'hosted-runtime orientation': CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n'),
  'protocol manual': buildProtocolManual('https://api.example.test'),
};

describe('every knowledge surface says where the bounty board is', () => {
  for (const [name, text] of Object.entries(surfaces)) {
    test(name, () => {
      expect(text).toContain('Quest + Bounty Pavilion');
      expect(text).toContain('-1220');
      expect(text).toMatch(/RIGHT\s+half/i);
      expect(text).toMatch(/no\s+(building\s+)?teacher\s+and\s+no\s+NPC\s+holds\s+bounties/i);
    });
  }

  test('the stated place is where the pavilion actually stands', () => {
    const pav = getServerColliders().find((c) => c.id === 'quest-bounty-pavilion');
    expect(pav).toBeDefined();
    expect(pav!.centerX).toBe(0);
    expect(pav!.centerZ).toBe(-1220);
  });
});
