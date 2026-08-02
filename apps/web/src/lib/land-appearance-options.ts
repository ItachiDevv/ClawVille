import {
  PALETTE_PRESETS,
  SHELL_CATALOG,
  isPaletteAllowed,
  isShellAllowed,
  type LandStructureType,
  type LandTier,
  type PalettePreset,
  type ShellCatalogEntry,
} from '@clawville/shared';

export interface ShellAppearanceOption {
  entry: ShellCatalogEntry;
  locked: boolean;
  levelLocked: boolean;
  tierLocked: boolean;
}

export interface PaletteAppearanceOption {
  entry: PalettePreset;
  locked: boolean;
}

/**
 * Build the shell picker rows from the shared catalog and server-matching
 * allowlist helper. Entries for the other structure type are never displayed.
 */
export function getShellAppearanceOptions(
  structureType: LandStructureType,
  level: number,
  parcelTier: LandTier,
): ShellAppearanceOption[] {
  return SHELL_CATALOG.filter((entry) => entry.structureType === structureType).map((entry) => ({
    entry,
    locked: !isShellAllowed(structureType, level, parcelTier, entry.key),
    levelLocked: level < entry.minLevel,
    // Probe the shell at its own unlock level. A false result means the
    // parcel tier itself cannot use this premium shell.
    tierLocked: entry.premium && !isShellAllowed(structureType, entry.minLevel, parcelTier, entry.key),
  }));
}

/** Build palette chips from the shared preset list and its allowlist helper. */
export function getPaletteAppearanceOptions(level: number): PaletteAppearanceOption[] {
  return PALETTE_PRESETS.map((entry) => ({
    entry,
    locked: !isPaletteAllowed(level, entry.key),
  }));
}
