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

  // Quests wire 2026-10-22: the three formerly pending quests are live and
  // server-validated; brand-ambassador is gone from the ladder.
  test('style-statement, big-spender and wallet-aware are live, serverOnly, and say where to go', () => {
    for (const id of ['style-statement', 'big-spender', 'wallet-aware'] as const) {
      const q = QUEST_DEFINITIONS_BY_ID[id];
      expect(q.isPending).toBe(false);
      expect(q.condition.type).toBe('serverOnly');
      expect(q.hint).not.toMatch(/not claimable/i);
      expect(q.hint).not.toContain('—');
    }
    expect(QUEST_DEFINITIONS_BY_ID['style-statement'].hint).toContain('Wardrobe');
    expect(QUEST_DEFINITIONS_BY_ID['big-spender'].hint).toMatch(/books/);
    expect(QUEST_DEFINITIONS_BY_ID['big-spender'].hint).toMatch(/Land Office/);
    expect(QUEST_DEFINITIONS_BY_ID['big-spender'].hint).toMatch(/do not count/);
    expect(QUEST_DEFINITIONS_BY_ID['wallet-aware'].hint).toMatch(/wallet chip/);
  });

  // Fix pass 2026-10-22: the chip and the sidebar Wallet entry are hidden for
  // an avatar with no custodial wallet; My Agent always shows the panel.
  test('wallet-aware names My Agent before the chip', () => {
    const hint = QUEST_DEFINITIONS_BY_ID['wallet-aware'].hint;
    expect(hint.indexOf('My Agent')).toBeGreaterThanOrEqual(0);
    expect(hint.indexOf('My Agent')).toBeLessThan(hint.indexOf('wallet chip'));
  });

  // The server allowlist (BIG_SPENDER_REASONS) has no shop-item, parcel or
  // peer-service reason; the hint must not promise them.
  test('big-spender does not promise shop items, parcels or services', () => {
    const hint = QUEST_DEFINITIONS_BY_ID['big-spender'].hint;
    expect(hint).not.toMatch(/shop items/i);
    expect(hint).not.toMatch(/parcels/i);
    expect(hint).not.toMatch(/\bservices\)/i);
    expect(hint).toMatch(/prepaid rent weeks/);
  });

  test('brand-ambassador is removed and no quest is pending', () => {
    expect(QUEST_DEFINITIONS.map((q) => q.id)).not.toContain('brand-ambassador');
    expect(QUEST_DEFINITIONS.length).toBe(33);
    expect(QUEST_DEFINITIONS.filter((q) => q.isPending)).toEqual([]);
  });
});
