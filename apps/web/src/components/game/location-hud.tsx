'use client';

import { useGameStore } from '@/stores/game';
import { MAP_LOCATIONS } from '@elizapets/shared';

export default function LocationHUD() {
  const nearLocation = useGameStore((s) => s.nearLocation);

  if (!nearLocation) return null;

  const location = MAP_LOCATIONS.find((l) => l.id === nearLocation);
  if (!location) return null;

  return (
    <div className="neopets-panel fixed top-4 left-1/2 -translate-x-1/2 z-40 text-center">
      <p className="text-black font-bold text-lg">
        {location.icon} {location.name}
      </p>
      <p className="text-black/70 text-sm mt-1">Press E to enter</p>
    </div>
  );
}
