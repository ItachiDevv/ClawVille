/**
 * RPG rarity tier definitions — the visual language backbone shared by every
 * Gameify modal (Quest Board, Bounty Board, Land Office, Agent Setup).
 *
 * Tiers are WoW-flavoured item quality colours harmonized with the ClawVille
 * dark-navy + cyan HUD baseline. The gradients are deliberately subtle so the
 * rarity reads at a glance without blowing out the ocean palette.
 *
 * Backend truth
 * -------------
 * Peer skill commerce (`apps/api/src/routes/bazaar.ts`, the original source
 * of a server-computed rarity from a skill's knowledge entry count) was
 * removed 2026-07-02 — a sold/published "skill" was a prompt-injection
 * vector. No live route auto-computes rarity today; features that use this
 * module (quests, bounties, land) set a tier explicitly. The 5-tier naming
 * below is kept stable for any future feature that DOES compute rarity
 * server-side and needs a matching pgEnum:
 *   <5  = common, 5-9 = uncommon, 10-14 = rare, 15-19 = epic, 20+ = legendary
 *
 * `mythic` is reserved client-side for future ultra-rare items that surpass
 * the 20-entry legendary ceiling. No backend rows use it today.
 *
 * Usage
 * -----
 *   import { getRarity, RARITY_TIERS } from '@/components/rpg';
 *   const tier = getRarity(listing.rarity); // safe fallback to 'common'
 *   <div style={{ color: tier.base, background: tier.bgGradient }}>...</div>
 */

export type RarityId =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic';

export interface RarityTier {
  /** Stable machine id — matches backend `published_skills.rarity` enum for the first 5. */
  id: RarityId;
  /** Human-readable label shown on badges and tooltips. */
  label: string;
  /** Sort order, 0 = least rare. */
  order: number;
  /** Base hex for text, icons, and solid borders. */
  base: string;
  /** Lighter hex for hover halos, glowing edges, and rune-corner highlights. */
  glow: string;
  /** Card background CSS `linear-gradient(...)`. Kept subtle so navy baseline still reads. */
  bgGradient: string;
  /** Rune-frame border CSS gradient (used as `border-image` or overlay). */
  borderGradient: string;
  /** Outer box-shadow glow string, keyed to the rarity colour. */
  shadow: string;
  /** Whether this tier should breathe (pulse-rarity animation). Reserved for legendary+. */
  pulse: boolean;
}

/**
 * Frozen tier registry. Iterate via `RARITY_TIERS` when building filters,
 * lookup by id via `getRarity()`.
 */
export const RARITY_TIERS: readonly RarityTier[] = Object.freeze([
  {
    id: 'common',
    label: 'Common',
    order: 0,
    base: '#9ca3af',
    glow: '#d1d5db',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(30, 41, 59, 0.72) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(156, 163, 175, 0.45) 0%, rgba(156, 163, 175, 0.15) 100%)',
    shadow: '0 0 0 1px rgba(156, 163, 175, 0.2), 0 4px 18px rgba(0, 0, 0, 0.45)',
    pulse: false,
  },
  {
    id: 'uncommon',
    label: 'Uncommon',
    order: 1,
    base: '#22c55e',
    glow: '#4ade80',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(6, 58, 36, 0.70) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(34, 197, 94, 0.55) 0%, rgba(34, 197, 94, 0.18) 100%)',
    shadow:
      '0 0 0 1px rgba(34, 197, 94, 0.28), 0 4px 20px rgba(34, 197, 94, 0.15)',
    pulse: false,
  },
  {
    id: 'rare',
    label: 'Rare',
    order: 2,
    base: '#3b82f6',
    glow: '#60a5fa',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(15, 37, 82, 0.78) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(59, 130, 246, 0.6) 0%, rgba(59, 130, 246, 0.2) 100%)',
    shadow:
      '0 0 0 1px rgba(59, 130, 246, 0.35), 0 6px 22px rgba(59, 130, 246, 0.22)',
    pulse: false,
  },
  {
    id: 'epic',
    label: 'Epic',
    order: 3,
    base: '#a855f7',
    glow: '#c084fc',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(49, 18, 82, 0.78) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(168, 85, 247, 0.65) 0%, rgba(168, 85, 247, 0.22) 100%)',
    shadow:
      '0 0 0 1px rgba(168, 85, 247, 0.4), 0 8px 26px rgba(168, 85, 247, 0.28)',
    pulse: false,
  },
  {
    id: 'legendary',
    label: 'Legendary',
    order: 4,
    base: '#f97316',
    glow: '#fb923c',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(74, 35, 8, 0.82) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(249, 115, 22, 0.72) 0%, rgba(249, 115, 22, 0.24) 100%)',
    shadow:
      '0 0 0 1px rgba(249, 115, 22, 0.5), 0 10px 32px rgba(249, 115, 22, 0.32)',
    pulse: true,
  },
  {
    id: 'mythic',
    label: 'Mythic',
    order: 5,
    base: '#dc2626',
    glow: '#f87171',
    bgGradient:
      'linear-gradient(140deg, rgba(10, 22, 40, 0.88) 0%, rgba(69, 10, 10, 0.84) 100%)',
    borderGradient:
      'linear-gradient(140deg, rgba(220, 38, 38, 0.8) 0%, rgba(220, 38, 38, 0.28) 100%)',
    shadow:
      '0 0 0 1px rgba(220, 38, 38, 0.55), 0 12px 38px rgba(220, 38, 38, 0.35)',
    pulse: true,
  },
]);

const RARITY_INDEX: Readonly<Record<RarityId, RarityTier>> = Object.freeze(
  RARITY_TIERS.reduce(
    (acc, tier) => {
      acc[tier.id] = tier;
      return acc;
    },
    {} as Record<RarityId, RarityTier>
  )
);

/**
 * Resolve a rarity id to its tier definition. Falls back to `common` if the
 * input is null/undefined/unknown (e.g. legacy rows with missing rarity).
 *
 * TODO: once the backend guarantees every rarity-bearing row (quest, land
 * structure, etc.) ships a rarity field, drop the fallback and treat unknown
 * ids as a type error.
 */
export function getRarity(id: string | null | undefined): RarityTier {
  if (!id) return RARITY_INDEX.common;
  const tier = RARITY_INDEX[id as RarityId];
  return tier ?? RARITY_INDEX.common;
}

/** Compare two rarities for sorting (ascending = common first). */
export function compareRarity(a: RarityId, b: RarityId): number {
  return RARITY_INDEX[a].order - RARITY_INDEX[b].order;
}

/**
 * Client-side fallback mapper — ONLY use when a data source (e.g. a future
 * endpoint that forgets to expose rarity) doesn't return one.
 *
 * TODO: remove once every Gameify endpoint ships rarity server-side.
 */
export function deriveRarityFromKnowledgeCount(count: number): RarityId {
  if (count >= 20) return 'legendary';
  if (count >= 15) return 'epic';
  if (count >= 10) return 'rare';
  if (count >= 5) return 'uncommon';
  return 'common';
}
