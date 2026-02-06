import type { AvatarSpecies, AvatarColor } from '@legacyapp/shared';

// --- Sprite sheet layout constants (for future real sprite sheets) ---
export const SPRITE_FRAME_WIDTH = 64;
export const SPRITE_FRAME_HEIGHT = 64;
export const SPRITE_SHEET_COLS = 4;
export const SPRITE_SHEET_ROWS = 5;

/** Animation state frame ranges within a sprite sheet */
export const ANIMATION_STATES = {
  idle: { start: 0, end: 3 },
  'walk-down': { start: 4, end: 7 },
  'walk-up': { start: 8, end: 11 },
  'walk-left': { start: 12, end: 15 },
  'walk-right': { start: 16, end: 19 },
} as const;

export type AnimationState = keyof typeof ANIMATION_STATES;

/** Maps species to avatar PNG sprite path */
export const SPECIES_SPRITE_MAP: Record<AvatarSpecies, string> = {
  cat: '/sprites/avatars/cat.png',
  dragon: '/sprites/avatars/dragon.png',
  fox: '/sprites/avatars/fox.png',
  owl: '/sprites/avatars/owl.png',
  wolf: '/sprites/avatars/wolf.png',
  bunny: '/sprites/avatars/bunny.png',
  phoenix: '/sprites/avatars/phoenix.png',
  turtle: '/sprites/avatars/turtle.png',
};

/** Color tinting hex values */
export const COLOR_TINT_MAP: Record<AvatarColor, number> = {
  green: 0x4caf50,
  red: 0xf44336,
  blue: 0x2196f3,
  yellow: 0xffeb3b,
};

/** Base body colors per species (before tinting) */
export const SPECIES_BASE_COLORS: Record<AvatarSpecies, number> = {
  cat: 0xffa726,
  dragon: 0x7e57c2,
  fox: 0xff7043,
  owl: 0x8d6e63,
  wolf: 0x78909c,
  bunny: 0xf48fb1,
  phoenix: 0xff5722,
  turtle: 0x66bb6a,
};

/** Accent colors per species (ears, wings, markings) */
export const SPECIES_ACCENT_COLORS: Record<AvatarSpecies, number> = {
  cat: 0xffe0b2,
  dragon: 0xce93d8,
  fox: 0xffccbc,
  owl: 0xbcaaa4,
  wolf: 0xb0bec5,
  bunny: 0xfce4ec,
  phoenix: 0xffab40,
  turtle: 0xa5d6a7,
};

export interface SpeciesSpriteConfig {
  species: AvatarSpecies;
  sheetPath: string;
  baseColor: number;
  accentColor: number;
}

/** Get the sprite configuration for a given species */
export function getSpeciesConfig(species: string): SpeciesSpriteConfig {
  const s = species as AvatarSpecies;
  return {
    species: s,
    sheetPath: SPECIES_SPRITE_MAP[s] ?? SPECIES_SPRITE_MAP.cat,
    baseColor: SPECIES_BASE_COLORS[s] ?? SPECIES_BASE_COLORS.cat,
    accentColor: SPECIES_ACCENT_COLORS[s] ?? SPECIES_ACCENT_COLORS.cat,
  };
}

/**
 * Blend a base color toward a tint color.
 * factor: 0 = pure base, 1 = pure tint
 */
export function blendColors(base: number, tint: number, factor: number): number {
  const br = (base >> 16) & 0xff;
  const bg = (base >> 8) & 0xff;
  const bb = base & 0xff;
  const tr = (tint >> 16) & 0xff;
  const tg = (tint >> 8) & 0xff;
  const tb = tint & 0xff;
  const r = Math.round(br + (tr - br) * factor);
  const g = Math.round(bg + (tg - bg) * factor);
  const b = Math.round(bb + (tb - bb) * factor);
  return (r << 16) | (g << 8) | b;
}
