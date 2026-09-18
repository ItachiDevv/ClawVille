import { describe, expect, test } from 'bun:test';
import { getAllColliders } from './collision/world-colliders';
import { NORI_TALK_RADIUS_SQ, NORI_WORLD_X, NORI_WORLD_Z } from './town-guide-position';
import { resolveBottomPromptOwner, type BottomPromptSlotInput } from '@/hooks/use-bottom-prompt-slot';
import { locationPromptText } from '@/components/game/location-prompt-text';

describe('the prompt text matches what E and a tap do', () => {
  test('Nori owns the prompt even beside the Cove entrance (Codex round-2 finding)', () => {
    const nori = locationPromptText({ isGuide: true, nearLocation: 'cove', characterName: 'Nori' });
    expect(nori).toMatchObject({ subjectLabel: 'Nori', ctaLine: 'Talk to Nori', icon: '💬', isCove: false, isKelpForest: false });
    expect(locationPromptText({ isGuide: true, nearLocation: null, characterName: 'Nori' }).ctaLine).toBe('Talk to Nori');
  });

  test('venues and residents keep their existing words', () => {
    expect(locationPromptText({ isGuide: false, nearLocation: 'cove', characterName: null }))
      .toMatchObject({ subjectLabel: 'The Cove', ctaLine: 'Enter the Cove', icon: '🎰', isCove: true });
    expect(locationPromptText({ isGuide: false, nearLocation: 'kelp-forest-portal', characterName: null }))
      .toMatchObject({ subjectLabel: 'Kelp Forest', ctaLine: 'Walk through to enter the Kelp Forest', icon: '🪸' });
    expect(locationPromptText({ isGuide: false, nearLocation: 'krusty-krab', characterName: 'Mr. Krabs', themeLabel: 'Krusty Krab' }))
      .toMatchObject({ subjectLabel: 'Mr. Krabs', ctaLine: 'Talk to Mr. Krabs', icon: '💬' });
    expect(locationPromptText({ isGuide: false, nearLocation: 'krusty-krab', characterName: null, themeLabel: 'Krusty Krab', locationName: 'Krusty Krab', locationIcon: '🍔' }))
      .toMatchObject({ subjectLabel: 'Krusty Krab', ctaLine: 'Enter Krusty Krab', icon: '🍔' });
    expect(locationPromptText({ isGuide: false, nearLocation: 'x', characterName: null, locationName: 'Library', locationIcon: '📚' }))
      .toMatchObject({ subjectLabel: 'Library', ctaLine: 'Enter Library', icon: '📚' });
  });
});

// 2026-09-18, founder: "Nori is not showing up for proximity to click E to talk
// to her". Two defects, both locked here.

describe('Nori stands where the collision table says she stands', () => {
  test('her collider is centred on her rendered position, not the pre-May spot', () => {
    const nori = getAllColliders().find((c) => c.id === 'town-guide');
    expect(nori).toBeDefined();
    expect(nori!.centerX).toBe(NORI_WORLD_X);
    expect(nori!.centerZ).toBe(NORI_WORLD_Z);
    expect(NORI_WORLD_Z).toBe(400);
  });

  test('her collider sits well inside her talk radius, so walking up to her always arms the prompt', () => {
    const nori = getAllColliders().find((c) => c.id === 'town-guide')!;
    const edge = Math.max(nori.halfX, nori.halfZ);
    expect((edge + 1) ** 2).toBeLessThan(NORI_TALK_RADIUS_SQ);
  });
});

describe('Nori gets the bottom "Press E" prompt', () => {
  const base: BottomPromptSlotInput = {
    controlMode: 'player', chatOpen: false, guideChatOpen: false, landOfficeOpen: false,
    buildModeOpen: false, nearLocation: null, nearGuide: false, nearParcelCode: null,
    nearParcelOwnedByViewer: false, nearSalvageNodeId: null,
  };

  test('near Nori and nothing else, the slot is hers', () => {
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true })).toBe('guide');
    expect(resolveBottomPromptOwner({ ...base, controlMode: 'npc', nearGuide: true })).toBe('guide');
  });

  test('the prompt advertises what E does: Nori over a resident, owned parcel over Nori', () => {
    // E already opens Nori first when both are in range (player-avatar and
    // npc-controller onInteract); the prompt must say the same thing.
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, nearLocation: 'krusty-krab' })).toBe('guide');
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, nearParcelCode: 'A1' })).toBe('guide');
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, nearSalvageNodeId: 's1' })).toBe('guide');
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, nearParcelCode: 'A1', nearParcelOwnedByViewer: true })).toBe('parcel');
  });

  test('no prompt while her chat is open, in explore mode, or out of range', () => {
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, guideChatOpen: true })).toBeNull();
    expect(resolveBottomPromptOwner({ ...base, nearGuide: true, controlMode: 'explore' })).toBeNull();
    expect(resolveBottomPromptOwner(base)).toBeNull();
  });
});
