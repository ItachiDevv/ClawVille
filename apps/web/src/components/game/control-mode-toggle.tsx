'use client';

import { useGameStore, type GameState } from '@/stores/game';

export default function ControlModeToggle() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const isSpectator = useGameStore((s: GameState) => s.isSpectator);
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const setControlMode = useGameStore((s: GameState) => s.setControlMode);
  const toggleControlMode = useGameStore((s: GameState) => s.toggleControlMode);

  // Toggle labels gate strictly on `agentConnected` (the real Moltbook
  // handshake completed), NOT on `hasAvatar`. Guest auto-create mints a
  // throwaway avatar for unauthenticated visitors so they can play activity
  // games — but they remain NPC-mode visitors. The toggle is the
  // "I have an agent in the world" switch, which only flips after a
  // real connect.
  //   agentConnected=false → Explore    ↔ NPC Mode    (spectator / possess NPC)
  //   agentConnected=true  → Controlled ↔ Autonomous  (manual / autonomy engine)
  const optionA = agentConnected ? 'Controlled' : 'Explore';
  const optionB = agentConnected ? 'Autonomous' : 'NPC Mode';

  const aActive = agentConnected
    ? controlMode !== 'autonomous' // default: Controlled highlighted when mode isn't autonomous
    : controlMode === 'explore';

  // Position below NanoClawBanner. The banner is ~36–40px tall plus its
  // shadow/glow; the toggle needs ≥16px of breathing room or its own glow
  // visually merges into the banner above. Previous values (top-[3.5rem] /
  // top-[8rem]) left ~4–8px of gap — buttons "stacked on top of" the banner
  // CTAs per the user's 2026-05-21 report.
  //
  // No spectator: banner ends ~52px from top → toggle at top-[5rem] (80px = 28px gap).
  // Spectator:    second banner ends ~108px  → toggle at top-[9.5rem] (152px = 24px gap).
  const topClass = isSpectator ? 'top-[9.5rem]' : 'top-[5rem]';

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 ${topClass} z-50 pointer-events-auto`}
      aria-label="Control mode toggle"
    >
      <div className="flex items-center gap-0 rounded-full bg-[rgba(10,22,40,0.85)] backdrop-blur-md border border-cyan-500/20 shadow-[0_0_16px_rgba(0,229,255,0.07)] p-0.5">
        <button
          onClick={() => {
            if (agentConnected) setControlMode('player');
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
            if (agentConnected) setControlMode('autonomous');
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
