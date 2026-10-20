import { describe, expect, test } from 'bun:test';

import { QUEST_DEFINITIONS, QUEST_DEFINITIONS_BY_ID } from '@/lib/quests';

// Roundup 2026-10-20: hints must name controls a prod player can reach and
// must not promise retired or dated features.
describe('tutorial quest hints', () => {
  test('no hint names the dev-only Quick Queue, Phase 4, or the retired Milady sideload', () => {
    for (const q of QUEST_DEFINITIONS) {
      expect(q.hint).not.toMatch(/quick queue/i);
      expect(q.hint).not.toMatch(/phase 4/i);
      expect(q.hint).not.toMatch(/milady/i);
    }
  });

  test('first-match points at the building portal flow', () => {
    const hint = QUEST_DEFINITIONS_BY_ID['first-match'].hint;
    expect(hint).toContain('Salty Spitoon');
    expect(hint).toContain('Boating School');
    expect(hint).toContain('Play Now');
    expect(hint).toContain('Queue Solo');
  });

  test('pending quests say they are not claimable and use no em dash', () => {
    for (const id of ['style-statement', 'big-spender', 'wallet-aware', 'brand-ambassador'] as const) {
      const q = QUEST_DEFINITIONS_BY_ID[id];
      expect(q.isPending).toBe(true);
      expect(q.condition.type).toBe('pending');
      expect(q.hint).toMatch(/^Not claimable/);
      expect(q.hint).not.toContain('—');
    }
  });
});
