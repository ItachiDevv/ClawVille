'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useAuthMe } from '@/hooks/use-auth-me';

export default function ControlModeToggle() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const setControlMode = useGameStore((s: GameState) => s.setControlMode);
  const toggleControlMode = useGameStore((s: GameState) => s.toggleControlMode);

  // P2 toggle reconcile (2026-07-04, model doc §2/§7 B-class fix). The
  // mode-pair labels used to gate ONLY on `agentConnected`, while the /game
  // promotion effect embodies ANY resolved authenticated non-guest avatar
  // owner in 'player' — so an owner whose agent session wasn't paired (idle
  // external agent, provisioning race, pre-hydration frame) drove their body
  // in 'player' while the toggle showed "Explore / NPC Mode" and clicking it
  // hijacked their mode.
  //
  // Fix: derive `hasProvisionedAgent` from the SAME predicate the promotion
  // effect uses (game/page.tsx: resolved authenticated non-guest + avatar —
  // under P2, account ≡ agent, signup provisions) UNIONED with the
  // reload-survivable paired flag. `agentConnected` itself keeps its
  // paired-union semantics untouched for every other reader
  // (showDemoProgressHud, cove autonomous availability, chat bar). Both
  // queries are pre-existing keys (['avatar'], ['auth-me']) — cache-shared
  // with /game, zero new keys, no new controlMode writer (the buttons call
  // the same setControlMode/toggleControlMode they always did).
  //
  // Guest exemption preserved VERBATIM: a guest (or unresolved auth) never
  // derives true here, so guests keep the Explore ↔ NPC pair — the
  // guest-promotion-hijack class cannot recur through the labels.
  const { data: avatar } = useAvatar();
  const { data: authData, isLoading: authLoading } = useAuthMe();
  const isResolvedNonGuest =
    !authLoading && !!authData?.user && !authData.user.isGuest;
  const hasProvisionedAgent = agentConnected || (isResolvedNonGuest && !!avatar);

  //   hasProvisionedAgent=false → Explore    ↔ NPC Mode    (spectator / possess NPC)
  //   hasProvisionedAgent=true  → Controlled ↔ Autonomous  (manual / autonomy engine)
  const optionA = hasProvisionedAgent ? 'Controlled' : 'Explore';
  const optionB = hasProvisionedAgent ? 'Autonomous' : 'NPC Mode';

  const aActive = hasProvisionedAgent
    ? controlMode !== 'autonomous' // default: Controlled highlighted when mode isn't autonomous
    : controlMode === 'explore';

  // Position below NanoClawBanner. The banner is ~36–40px tall plus its
  // shadow/glow; the toggle needs ≥16px of breathing room or its own glow
  // visually merges into the banner above.
  //
  // 2026-06-10: fixed at top-[5rem] for ALL modes. The old
  // `isSpectator ? 'top-[9.5rem]' : 'top-[5rem]'` cleared a second
  // "spectator" banner at top-[4.5rem] that no longer exists anywhere in the
  // codebase — so in Explore mode the toggle floated 72px below its slot and
  // visibly jumped up when flipped to NPC mode (user report 2026-06-10).
  const topClass = 'top-[5rem]';

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 ${topClass} z-50 pointer-events-auto`}
      aria-label="Control mode toggle"
    >
      <div className="flex items-center gap-0 rounded-full bg-[rgba(10,22,40,0.85)] backdrop-blur-md border border-cyan-500/20 shadow-[0_0_16px_rgba(0,229,255,0.07)] p-0.5">
        <button
          onClick={() => {
            // Direct setControlMode for the player pair (also ends
            // hatcherSpectate — the owner takes the wheel); toggleControlMode
            // keys on store `hasAgent`, which only tracks the PAIRED slice, so
            // it must never route the provisioned pair.
            if (hasProvisionedAgent) setControlMode('player');
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
            if (hasProvisionedAgent) setControlMode('autonomous');
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
