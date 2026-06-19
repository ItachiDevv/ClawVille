'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { triggerCoveWalkIn } from '@/lib/three/arena-buildings';

/**
 * Building-entry prompt — replaces the prior tiny top-center hint
 * with a prominent bottom-center action pill that's hard to miss on
 * any device.
 *
 * Design:
 *   - Bottom-center, anchored above the mobile joystick zone (safe-area
 *     respected so it never hides under iOS Safari chrome).
 *   - Large tap target (≥64px tall, 320px wide on phone, capped on desktop).
 *   - Pulses a soft cyan glow so the player notices it the moment they
 *     wander into range.
 *   - Single tap / click / press-E enters. Keyboard E binding is owned
 *     by the canvas controller upstream — this component is the visual
 *     + tap surface only.
 *   - Shows the character name when one is in front of the player, the
 *     building name otherwise.
 */
export default function LocationHUD() {
  const nearLocation = useGameStore((s: GameState) => s.nearLocation);
  const nearCharacter = useGameStore((s: GameState) => s.nearCharacter);
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const enterBuilding = useGameStore((s: GameState) => s.enterBuilding);
  const buildingChatOpen = useGameStore((s: GameState) => s.chatOpen);
  const systemAgentChatOpen = useGameStore((s: GameState) => s.guideChatOpen);
  const isMobile = useIsMobile();

  // Spectator/explore mode has no character to walk in — suppress the
  // prompt so it doesn't dangle from the free-cam.
  if (controlMode === 'explore') return null;
  // A chat panel is open — the prompt would float over the chat UI.
  if (buildingChatOpen || systemAgentChatOpen) return null;
  if (!nearLocation) return null;

  const location = MAP_LOCATIONS.find((l) => l.id === nearLocation);
  if (!location) return null;

  const theme = BUILDING_OPENCLAW_THEMES[nearLocation];
  const characterName = nearCharacter;
  // S5 — in NPC mode the transient TalkToCharacterBar owns "Talk to {resident}"
  // (cheap GPT, no login); LocationHUD becomes the DISTINCT "Enter {building}"
  // action (full ElizaOS resident chat) so the two bottom prompts aren't
  // conflated/duplicated. In player/autonomous there is no TalkToCharacterBar,
  // so LocationHUD keeps the "Talk to {resident}" wording.
  const npcMode = controlMode === 'npc';
  const isCove = nearLocation === 'cove';
  const showTalk = !npcMode && !isCove && !!characterName;
  // Cove gets a distinct CTA — it's an entertainment venue, not a teacher building.
  const subjectLabel = isCove
    ? 'The Cove'
    : showTalk
      ? characterName!
      : (theme?.label ?? location.name);
  const ctaLine = isCove
    ? 'Enter the Cove'
    : showTalk
      ? `Talk to ${characterName}`
      : theme?.label
        ? `Enter ${theme.label}`
        : `Enter ${location.name}`;

  // The cove has its own walk-in flow (avatar pathfinds to the door then a
  // SceneTransition fires) — not the standard teacher-chat enterBuilding modal.
  const handleTap = () => {
    if (nearLocation === 'cove') {
      triggerCoveWalkIn();
    } else {
      enterBuilding(nearLocation, characterName ?? undefined);
    }
  };

  // Lift above joystick zones (joysticks anchor at
  // max(env(safe-area-inset-bottom,0)+60px, 80px)); add another ~150px
  // so the pill sits above the nipples on every phone/tablet.
  // S5 — every non-explore mode has a bottom chat pill (AvatarChatBar in
  // player/autonomous, TalkToCharacterBar in npc); lift the prompt above the
  // ~54px pill band so it never overlaps. Mobile already clears it (+220px).
  // Non-explore modes all carry a bottom chat pill: AvatarChatBar in player/
  // autonomous (/game/page.tsx mounts LocationHUD only when hasAvatar, so the
  // pill is present) or TalkToCharacterBar in npc. (AvatarChatBar's avatar comes
  // from the useAvatar() query, NOT the game store — do not read s.avatar here.)
  const hasBottomChatBar = npcMode || controlMode === 'player' || controlMode === 'autonomous';
  const bottomOffset = isMobile
    ? 'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)'
    : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;

  return (
    <button
      type="button"
      onClick={handleTap}
      aria-label={ctaLine}
      style={{
        position: 'fixed',
        bottom: bottomOffset,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 45,
        minWidth: 280,
        maxWidth: 'min(420px, calc(100vw - 32px))',
        padding: '14px 28px',
        borderRadius: 999,
        background:
          'linear-gradient(135deg, rgba(8,28,52,0.96) 0%, rgba(14,52,96,0.96) 100%)',
        border: '1.5px solid rgba(56,189,248,0.65)',
        boxShadow:
          '0 0 0 1px rgba(56,189,248,0.25), 0 18px 44px -10px rgba(56,189,248,0.45), 0 0 38px rgba(56,189,248,0.35)',
        color: '#e0f2fe',
        cursor: 'pointer',
        textAlign: 'center',
        touchAction: 'manipulation',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        animation: 'cv-enter-pulse 2.4s ease-in-out infinite',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <style jsx>{`
        @keyframes cv-enter-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 1px rgba(56, 189, 248, 0.25),
              0 18px 44px -10px rgba(56, 189, 248, 0.45),
              0 0 38px rgba(56, 189, 248, 0.35);
          }
          50% {
            box-shadow:
              0 0 0 1px rgba(56, 189, 248, 0.45),
              0 22px 52px -10px rgba(56, 189, 248, 0.6),
              0 0 58px rgba(56, 189, 248, 0.55);
          }
        }
      `}</style>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: 'rgba(186, 230, 253, 0.85)',
          textTransform: 'uppercase',
        }}
      >
        {isMobile ? 'Tap' : 'Press E'} · {subjectLabel}
      </span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span aria-hidden style={{ fontSize: 22 }}>
          {isCove ? '🎰' : showTalk ? '💬' : location.icon}
        </span>
        {ctaLine}
      </span>
      {theme && !isCove && (
        <span
          style={{
            fontSize: 11,
            color: 'rgba(186,230,253,0.75)',
            fontWeight: 500,
          }}
        >
          {agentConnected ? '🔌 Your bot will learn: ' : 'Learn about '}
          {theme.focus.split(',')[0]}
        </span>
      )}
    </button>
  );
}
