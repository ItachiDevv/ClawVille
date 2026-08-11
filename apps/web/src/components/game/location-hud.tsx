'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  bottomPromptOffset,
  useBottomPromptOwner,
} from '@/hooks/use-bottom-prompt-slot';
import { MAP_LOCATIONS, BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { triggerCoveWalkIn } from '@/lib/three/arena-buildings';
import { triggerKelpForestWalkIn } from '@/lib/three/kelp-forest-transition';

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
  const isMobile = useIsMobile();
  // The bottom-centre slot has ONE authority (hooks/use-bottom-prompt-slot).
  // It folds in every rule this component used to spell out itself — explore
  // mode, an open chat panel — plus the two it never knew about: the Land
  // Office modal and the yard editor. It also hands the slot to the parcel
  // pill when the player is standing on a lot they own, which is the priority
  // change this pass is about.
  const promptOwner = useBottomPromptOwner();

  if (promptOwner !== 'building') return null;
  // Narrowing only — `promptOwner === 'building'` already implies this.
  if (!nearLocation) return null;

  const isKelpForest = nearLocation === 'kelp-forest-portal';
  const location = MAP_LOCATIONS.find((l) => l.id === nearLocation);
  if (!location && !isKelpForest) return null;

  const theme = BUILDING_OPENCLAW_THEMES[nearLocation];
  const characterName = nearCharacter;
  // 2026-06-20 — knowledge buildings are CHAT-ONLY (no interior to "enter").
  // The single proximity prompt is "Talk to {resident}" in ALL modes; tapping
  // opens the ElizaOS resident chat MODAL (chat-panel — full chat + skill-claim).
  // The old NPC-mode TalkToCharacterBar bottom bar was REMOVED (it duplicated
  // this prompt — founder report: "entrance + chatbox when only chat exists").
  // Only the Cove (a real walk-in interior with a SceneTransition) keeps "Enter".
  const isCove = nearLocation === 'cove';
  const showTalk = !isCove && !isKelpForest && !!characterName;
  // Cove gets a distinct CTA — it's an entertainment venue, not a teacher building.
  const subjectLabel = isKelpForest
    ? 'Kelp Forest'
    : isCove
      ? 'The Cove'
    : showTalk
      ? characterName!
      : (theme?.label ?? location!.name);
  const ctaLine = isKelpForest
    ? 'Walk through to enter the Kelp Forest'
    : isCove
      ? 'Enter the Cove'
    : showTalk
      ? `Talk to ${characterName}`
      : theme?.label
        ? `Enter ${theme.label}`
        : `Enter ${location!.name}`;

  // The cove has its own walk-in flow (avatar pathfinds to the door then a
  // SceneTransition fires) — not the standard teacher-chat enterBuilding modal.
  const handleTap = () => {
    if (isKelpForest) {
      triggerKelpForestWalkIn();
    } else if (nearLocation === 'cove') {
      triggerCoveWalkIn();
    } else {
      enterBuilding(nearLocation, characterName ?? undefined);
    }
  };

  // Shared with the parcel + salvage pills so all three sit on exactly the same
  // line. Lifts above the joystick zone on touch and above the AvatarChatBar on
  // desktop player/autonomous. See hooks/use-bottom-prompt-slot.
  const bottomOffset = bottomPromptOffset(isMobile, controlMode);

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
          {isKelpForest ? '🪸' : isCove ? '🎰' : showTalk ? '💬' : location!.icon}
        </span>
        {ctaLine}
      </span>
      {theme && !isCove && !isKelpForest && (
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
