import { describe, expect, test } from 'bun:test';
import { TRADING_FLOOR_NEAR_ID } from '@/lib/three/trading-floor/trading-floor-location';
import { locationPromptText } from './location-prompt-text';

/**
 * The Trading Floor door band publishes its OWN nearLocation id, separate from
 * the `cron-automation` building id that means "the resident's chat is in
 * range". These pin that the two never blur into one prompt — the exact class
 * of bug the Nori/Cove extraction was made to stop (Codex review 2026-09-18:
 * the pill said "Enter the Cove" while E opened Nori's chat).
 */
describe('Trading Floor entry prompt', () => {
  test('reads as an ENTER prompt, not a teacher chat', () => {
    const prompt = locationPromptText({
      isGuide: false,
      nearLocation: TRADING_FLOOR_NEAR_ID,
      characterName: null,
    });
    expect(prompt.isTradingFloor).toBe(true);
    expect(prompt.showTalk).toBe(false);
    expect(prompt.subjectLabel).toBe('Trading Floor');
    expect(prompt.ctaLine).toBe('Enter the Trading Floor');
  });

  test('a resident standing in range cannot turn it into "Talk to"', () => {
    const prompt = locationPromptText({
      isGuide: false,
      nearLocation: TRADING_FLOOR_NEAR_ID,
      characterName: 'Pearl',
      themeLabel: 'Cron Automation',
    });
    expect(prompt.showTalk).toBe(false);
    expect(prompt.ctaLine).toBe('Enter the Trading Floor');
  });

  test('Nori still wins the slot when she is the owner', () => {
    const prompt = locationPromptText({
      isGuide: true,
      nearLocation: TRADING_FLOOR_NEAR_ID,
      characterName: 'Pearl',
    });
    expect(prompt.isTradingFloor).toBe(false);
    expect(prompt.ctaLine).toBe('Talk to Nori');
  });

  test('the building id itself is still the resident chat prompt', () => {
    const prompt = locationPromptText({
      isGuide: false,
      nearLocation: 'cron-automation',
      characterName: 'Pearl',
      themeLabel: 'Cron Automation',
    });
    expect(prompt.isTradingFloor).toBe(false);
    expect(prompt.showTalk).toBe(true);
    expect(prompt.ctaLine).toBe('Talk to Pearl');
  });

  test('the cove and the kelp portal are untouched', () => {
    const cove = locationPromptText({
      isGuide: false,
      nearLocation: 'cove',
      characterName: null,
    });
    expect(cove.ctaLine).toBe('Enter the Cove');
    expect(cove.isTradingFloor).toBe(false);

    const kelp = locationPromptText({
      isGuide: false,
      nearLocation: 'kelp-forest-portal',
      characterName: null,
    });
    expect(kelp.ctaLine).toBe('Walk through to enter the Kelp Forest');
    expect(kelp.isTradingFloor).toBe(false);
  });
});
