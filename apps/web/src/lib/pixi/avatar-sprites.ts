import type { AvatarSpecies, AvatarColor } from '@legacyapp/shared';

// --- Sprite sheet layout constants ---
export const SPRITE_FRAME_WIDTH = 128;
export const SPRITE_FRAME_HEIGHT = 128;
export const SPRITE_SHEET_COLS = 8;
export const SPRITE_SHEET_ROWS = 10;

/** Animation state frame ranges within a sprite sheet (8 cols x 10 rows = 80 frames) */
export const ANIMATION_STATES = {
  idle:         { start: 0,  end: 7,  fps: 6,  mode: 'loop' as const },
  'walk-down':  { start: 8,  end: 15, fps: 10, mode: 'loop' as const },
  'walk-up':    { start: 16, end: 23, fps: 10, mode: 'loop' as const },
  'walk-left':  { start: 24, end: 31, fps: 10, mode: 'loop' as const },
  'walk-right': { start: 32, end: 39, fps: 10, mode: 'loop' as const },
  attack:       { start: 40, end: 47, fps: 14, mode: 'once' as const },
  hurt:         { start: 48, end: 55, fps: 12, mode: 'once' as const },
  death:        { start: 56, end: 63, fps: 6,  mode: 'once' as const },
  block:        { start: 64, end: 67, fps: 6,  mode: 'hold' as const },
  dodge:        { start: 68, end: 71, fps: 12, mode: 'once' as const },
  special:      { start: 72, end: 79, fps: 12, mode: 'once' as const },
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

/** Maps species to sprite sheet path (8-col x 10-row, 128px frames) */
export const SPECIES_SPRITESHEET_MAP: Record<AvatarSpecies, string> = {
  cat: '/sprites/avatars/cat-sheet.png',
  dragon: '/sprites/avatars/dragon-sheet.png',
  fox: '/sprites/avatars/fox-sheet.png',
  owl: '/sprites/avatars/owl-sheet.png',
  wolf: '/sprites/avatars/wolf-sheet.png',
  bunny: '/sprites/avatars/bunny-sheet.png',
  phoenix: '/sprites/avatars/phoenix-sheet.png',
  turtle: '/sprites/avatars/turtle-sheet.png',
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
  spritesheetPath: string;
  baseColor: number;
  accentColor: number;
}

/** Get the sprite configuration for a given species */
export function getSpeciesConfig(species: string): SpeciesSpriteConfig {
  const s = species as AvatarSpecies;
  return {
    species: s,
    sheetPath: SPECIES_SPRITE_MAP[s] ?? SPECIES_SPRITE_MAP.cat,
    spritesheetPath: SPECIES_SPRITESHEET_MAP[s] ?? SPECIES_SPRITESHEET_MAP.cat,
    baseColor: SPECIES_BASE_COLORS[s] ?? SPECIES_BASE_COLORS.cat,
    accentColor: SPECIES_ACCENT_COLORS[s] ?? SPECIES_ACCENT_COLORS.cat,
  };
}

/** Darken a hex color by a factor (0 = black, 1 = unchanged) */
export function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
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
