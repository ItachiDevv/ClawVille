'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';

export default function ControlModeToggle() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const isSpectator = useGameStore((s: GameState) => s.isSpectator);
  const setControlMode = useGameStore((s: GameState) => s.setControlMode);
  const toggleControlMode = useGameStore((s: GameState) => s.toggleControlMode);
  const { data: pet } = usePet();
  const hasPet = !!pet;

  // Logged-in pet owner: Autonomous ↔ NPC (user owns an agent — they want
  // to either let it run or step out and possess a world NPC).
  // Spectator / not-logged-in: Explore ↔ NPC (original 2-mode toggle).
  const optionA = hasPet ? 'Autonomous' : 'Explore';
  const optionB = hasPet ? 'NPC' : 'NPC Mode';

  const aActive = hasPet
    ? controlMode !== 'npc' // default to Autonomous when mode is anything but NPC
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
            if (hasPet) setControlMode('autonomous');
            else if (!aActive) toggleControlMode();
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
            if (hasPet) setControlMode('npc');
            else if (aActive) toggleControlMode();
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
