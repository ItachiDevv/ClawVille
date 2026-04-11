/**
 * `@/components/rpg` — the ClawVille RPG visual language toolkit.
 *
 * Import the side-effect CSS once via this barrel (`./glow.css`) and then
 * consume any primitive from a single path:
 *
 *   import {
 *     RpgModal, RpgButton, ItemCard, RuneFrame,
 *     RarityBadge, RpgTooltip, RuneSpinner,
 *     getRarity, RARITY_TIERS,
 *   } from '@/components/rpg';
 *
 * Stage 2 agents: DO NOT bring back local `bg-black/30 border border-white/10`
 * styling. If you need a rarity colour that isn't in RARITY_TIERS, add it to
 * `rarity.ts` and every downstream modal gets it for free.
 */

import './glow.css';

export { RARITY_TIERS, getRarity, compareRarity, deriveRarityFromKnowledgeCount } from './rarity';
export type { RarityId, RarityTier } from './rarity';

export { RuneFrame } from './rune-frame';
export type { RuneFrameProps, RuneFrameGlow } from './rune-frame';

export { RarityBadge } from './rarity-badge';
export type { RarityBadgeProps } from './rarity-badge';

export { RuneSpinner } from './rune-spinner';
export type { RuneSpinnerProps } from './rune-spinner';

export { RpgTooltip } from './rpg-tooltip';
export type { RpgTooltipProps, RpgTooltipSide } from './rpg-tooltip';

export { RpgButton } from './rpg-button';
export type { RpgButtonProps, RpgButtonVariant, RpgButtonSize } from './rpg-button';

export { ItemCard } from './item-card';
export type { ItemCardProps, ItemCardStat } from './item-card';

export { RpgModal } from './rpg-modal';
export type { RpgModalProps } from './rpg-modal';
