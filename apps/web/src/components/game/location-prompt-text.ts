/**
 * The words and icon on the bottom-centre "Press E" prompt, as a pure function
 * so every proximity combination can be tested without rendering the HUD.
 *
 * Extracted 2026-09-18 when Nori joined the prompt: with Nori AND the Cove
 * entrance both in range, the slot belongs to Nori (E opens her chat), but the
 * inline `isCove` check still produced "Enter the Cove" (Codex review, round 2).
 * The guide case is resolved FIRST here so no venue branch can claim her prompt.
 */

import { TRADING_FLOOR_NEAR_ID } from '@/lib/three/trading-floor/trading-floor-location';

export interface LocationPromptInput {
  /** The slot owner is Nori (use-bottom-prompt-slot 'guide'). */
  readonly isGuide: boolean;
  readonly nearLocation: string | null;
  readonly characterName: string | null;
  /** BUILDING_OPENCLAW_THEMES label for the building, if any. */
  readonly themeLabel?: string;
  /** MAP_LOCATIONS name and icon for the building, if any. */
  readonly locationName?: string;
  readonly locationIcon?: string;
}

export interface LocationPromptText {
  readonly subjectLabel: string;
  readonly ctaLine: string;
  readonly icon: string;
  readonly isCove: boolean;
  readonly isKelpForest: boolean;
  readonly isTradingFloor: boolean;
  readonly showTalk: boolean;
}

export function locationPromptText(input: LocationPromptInput): LocationPromptText {
  if (input.isGuide) {
    return {
      subjectLabel: 'Nori', ctaLine: 'Talk to Nori', icon: '💬',
      isCove: false, isKelpForest: false, isTradingFloor: false, showTalk: true,
    };
  }
  const isKelpForest = input.nearLocation === 'kelp-forest-portal';
  const isCove = input.nearLocation === 'cove';
  // The Trading Floor door band publishes its OWN nearLocation id, not the
  // building id — the building id still means "the resident's chat is in
  // range", and the two prompts must stay distinguishable (founder order
  // 2026-09-19: enter the building like you enter the cove).
  const isTradingFloor = input.nearLocation === TRADING_FLOOR_NEAR_ID;
  // 2026-06-20 — knowledge buildings are CHAT-ONLY: "Talk to {resident}" in
  // every mode. Only real walk-in interiors keep "Enter".
  const isVenue = isCove || isKelpForest || isTradingFloor;
  const showTalk = !isVenue && !!input.characterName;
  const buildingName = input.themeLabel ?? input.locationName ?? 'this place';
  const subjectLabel = isKelpForest
    ? 'Kelp Forest'
    : isCove
      ? 'The Cove'
      : isTradingFloor
        ? 'Trading Floor'
        : showTalk
          ? input.characterName!
          : buildingName;
  const ctaLine = isKelpForest
    ? 'Walk through to enter the Kelp Forest'
    : isCove
      ? 'Enter the Cove'
      : isTradingFloor
        ? 'Enter the Trading Floor'
        : showTalk
          ? `Talk to ${input.characterName}`
          : `Enter ${buildingName}`;
  const icon = isKelpForest
    ? '🪸'
    : isCove
      ? '🎰'
      : isTradingFloor
        ? '↗'
        : showTalk
          ? '💬'
          : (input.locationIcon ?? '📍');
  return {
    subjectLabel,
    ctaLine,
    icon,
    isCove,
    isKelpForest,
    isTradingFloor,
    showTalk,
  };
}
