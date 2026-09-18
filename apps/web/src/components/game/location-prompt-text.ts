/**
 * The words and icon on the bottom-centre "Press E" prompt, as a pure function
 * so every proximity combination can be tested without rendering the HUD.
 *
 * Extracted 2026-09-18 when Nori joined the prompt: with Nori AND the Cove
 * entrance both in range, the slot belongs to Nori (E opens her chat), but the
 * inline `isCove` check still produced "Enter the Cove" (Codex review, round 2).
 * The guide case is resolved FIRST here so no venue branch can claim her prompt.
 */

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
  readonly showTalk: boolean;
}

export function locationPromptText(input: LocationPromptInput): LocationPromptText {
  if (input.isGuide) {
    return {
      subjectLabel: 'Nori', ctaLine: 'Talk to Nori', icon: '💬',
      isCove: false, isKelpForest: false, showTalk: true,
    };
  }
  const isKelpForest = input.nearLocation === 'kelp-forest-portal';
  const isCove = input.nearLocation === 'cove';
  // 2026-06-20 — knowledge buildings are CHAT-ONLY: "Talk to {resident}" in
  // every mode. Only the Cove (a real walk-in interior) keeps "Enter".
  const showTalk = !isCove && !isKelpForest && !!input.characterName;
  const buildingName = input.themeLabel ?? input.locationName ?? 'this place';
  const subjectLabel = isKelpForest
    ? 'Kelp Forest'
    : isCove
      ? 'The Cove'
      : showTalk
        ? input.characterName!
        : buildingName;
  const ctaLine = isKelpForest
    ? 'Walk through to enter the Kelp Forest'
    : isCove
      ? 'Enter the Cove'
      : showTalk
        ? `Talk to ${input.characterName}`
        : `Enter ${buildingName}`;
  const icon = isKelpForest ? '🪸' : isCove ? '🎰' : showTalk ? '💬' : (input.locationIcon ?? '📍');
  return { subjectLabel, ctaLine, icon, isCove, isKelpForest, showTalk };
}
