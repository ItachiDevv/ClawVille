'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES } from '@elizapets/shared';

export default function LocationHUD() {
  const nearLocation = useGameStore((s: GameState) => s.nearLocation);
  const openclawConnected = useGameStore((s: GameState) => s.openclawConnected);

  if (!nearLocation) return null;

  const location = MAP_LOCATIONS.find((l) => l.id === nearLocation);
  if (!location) return null;

  const theme = BUILDING_OPENCLAW_THEMES[nearLocation];

  return (
    <div className="claw-panel fixed top-28 left-1/2 -translate-x-1/2 z-40 text-center max-w-xs">
      {theme && (
        <p className="text-white font-bold text-lg">
          {location.icon} {theme.label}
        </p>
      )}
      <p className="text-white/60 text-xs mt-0.5">
        {location.name}
      </p>
      <p className="text-white/70 text-sm mt-1">
        <span className="hidden md:inline">Press <kbd className="font-mono bg-white/10 px-1.5 py-0.5 rounded text-xs">E</kbd> to enter</span>
        <span className="md:hidden">Tap to enter</span>
      </p>
      {theme && (
        <p className="text-white/50 text-xs mt-1">
          {openclawConnected ? '🔌 Your bot will learn: ' : 'Learn about '}
          {theme.focus.split(',')[0]}
        </p>
      )}
    </div>
  );
}
