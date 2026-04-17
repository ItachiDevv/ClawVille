'use client';

import { useGameStore, type GameState } from '@/stores/game';

export default function ControlModeToggle() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const hasAgent = useGameStore((s: GameState) => s.hasAgent);
  const isSpectator = useGameStore((s: GameState) => s.isSpectator);
  const toggleControlMode = useGameStore((s: GameState) => s.toggleControlMode);

  // Per GameFeatures.md §1 + §12: the toggle labels follow `hasAgent`, which
  // only flips true after the Moltbook gateway handshake completes (not on
  // magic-link / plain Lucia login — a avatar alone is not an "agent").
  //   hasAgent=false → Explore  ↔ NPC Mode    (spectator / possess NPC)
  //   hasAgent=true  → Autonomous ↔ Controlled (autonomy engine / manual)
  const optionA = hasAgent ? 'Autonomous' : 'Explore';
  const optionB = hasAgent ? 'Controlled' : 'NPC Mode';

  const aActive = hasAgent
    ? controlMode === 'autonomous'
    : controlMode === 'explore';

  // Position below NanoClawBanner:
  // Spectator: banner sits at top-[4.5rem], banner height ~36px → toggle at top-[8rem]
  // No spectator: banner sits at top-3, banner height ~36px → toggle at top-[3.5rem]
  const topClass = isSpectator ? 'top-[8rem]' : 'top-[3.5rem]';

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 ${topClass} z-50 pointer-events-auto`}
      aria-label="Control mode toggle"
    >
      <div className="flex items-center gap-0 rounded-full bg-[rgba(10,22,40,0.85)] backdrop-blur-md border border-cyan-500/20 shadow-[0_0_16px_rgba(0,229,255,0.07)] p-0.5">
        <button
          onClick={() => {
            if (!aActive) toggleControlMode();
          }}
          className={`
            px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 whitespace-nowrap
            ${aActive
              ? 'bg-cyan-500/90 text-white shadow-[0_0_10px_rgba(56,189,248,0.4)]'
              : 'text-white/40 hover:text-white/70'
            }
          `}
        >
          {optionA}
        </button>
        <button
          onClick={() => {
            if (aActive) toggleControlMode();
          }}
          className={`
            px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 whitespace-nowrap
            ${!aActive
              ? 'bg-cyan-500/90 text-white shadow-[0_0_10px_rgba(56,189,248,0.4)]'
              : 'text-white/40 hover:text-white/70'
            }
          `}
        >
          {optionB}
        </button>
      </div>
    </div>
  );
}
