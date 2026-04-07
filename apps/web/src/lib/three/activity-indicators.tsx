'use client';

import { useRef, memo } from 'react';
import { useFrame } from '@react-three/fiber';
// Text removed
import * as THREE from 'three';
import { useNpcStore } from '@/stores/npc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

const PULSE_SPEED = 3; // Hz for scale pulse
const PULSE_MIN = 1.0;
const PULSE_MAX = 1.25;
const INDICATOR_Y = 10; // height above NPC position
const TYPING_Y = 9;

// ---------------------------------------------------------------------------
// Activity emoji map (NPC activity -> emoji string)
// ---------------------------------------------------------------------------

const ACTIVITY_EMOJIS: Record<string, string> = {
  idle: '',
  walking: '',
  patrolling: '',
  gathering: '\u{1F33F}',    // herb emoji
  crafting: '\u{1F528}',     // hammer
  trading: '\u{1F4B0}',      // money bag
  fishing: '\u{1F3A3}',      // fishing pole
  cooking: '\u{1F373}',      // cooking
  mining: '\u{26CF}',        // pick
  resting: '\u{1F634}',      // sleeping face
  socializing: '\u{1F4AC}',  // speech bubble
  fighting: '\u{2694}',      // crossed swords
  exploring: '\u{1F9ED}',    // compass
  singing: '\u{1F3B5}',      // music note
  reading: '\u{1F4D6}',      // book
  building: '\u{1F3D7}',     // construction
};

// ---------------------------------------------------------------------------
// Single NPC indicator (pulsing emoji + typing dots)
// ---------------------------------------------------------------------------

interface NpcIndicatorProps {
  npcId: string;
  x: number;
  y: number;
  activity?: string;
  isTyping: boolean;
  inConversation: boolean;
}

const NpcIndicator = memo(function NpcIndicator({
  npcId,
  x,
  y,
  activity,
  isTyping,
  inConversation,
}: NpcIndicatorProps) {
  const groupRef = useRef<THREE.Group>(null);
  const scaleRef = useRef(1);

  const worldX = x - HALF_W;
  const worldZ = y - HALF_H;

  const emoji = activity ? ACTIVITY_EMOJIS[activity] ?? '' : '';

  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    const elapsed = state.clock.elapsedTime;
    const pulse = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 + 0.5 * Math.sin(elapsed * PULSE_SPEED * Math.PI * 2));
    scaleRef.current = pulse;
    group.scale.setScalar(pulse);
  });

  const showEmoji = emoji.length > 0 && !inConversation;
  const showTyping = isTyping;

  if (!showEmoji && !showTyping) return null;

  return (
    <group ref={groupRef} position={[worldX, 0, worldZ]}>
      {/* Activity indicator — glowing sphere instead of Text */}
      {showEmoji && (
        <mesh position={[0, INDICATOR_Y, 0]}>
          <sphereGeometry args={[1.5, 8, 8]} />
          <meshBasicMaterial color={0x00e5ff} transparent opacity={0.6} />
        </mesh>
      )}

      {/* Typing indicator: animated "..." */}
      {showTyping && (
        <TypingDots x={0} y={TYPING_Y} z={0} />
      )}
    </group>
  );
});

// ---------------------------------------------------------------------------
// Animated typing dots
// ---------------------------------------------------------------------------

const TypingDots = memo(function TypingDots({
  x,
  y,
  z,
}: {
  x: number;
  y: number;
  z: number;
}) {
  const dot1Ref = useRef<THREE.Mesh>(null);
  const dot2Ref = useRef<THREE.Mesh>(null);
  const dot3Ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const refs = [dot1Ref, dot2Ref, dot3Ref];
    for (let i = 0; i < 3; i++) {
      const mesh = refs[i].current;
      if (!mesh) continue;
      // Stagger bounce: each dot offset by 0.2s
      const bounce = Math.abs(Math.sin((t + i * 0.2) * 4));
      mesh.position.y = y + bounce * 1.5;
    }
  });

  return (
    <group position={[x, 0, z]}>
      <mesh ref={dot1Ref} position={[-1.2, y, 0]}>
        <sphereGeometry args={[0.4, 6, 4]} />
        <meshBasicMaterial color={0xcccccc} />
      </mesh>
      <mesh ref={dot2Ref} position={[0, y, 0]}>
        <sphereGeometry args={[0.4, 6, 4]} />
        <meshBasicMaterial color={0xcccccc} />
      </mesh>
      <mesh ref={dot3Ref} position={[1.2, y, 0]}>
        <sphereGeometry args={[0.4, 6, 4]} />
        <meshBasicMaterial color={0xcccccc} />
      </mesh>
    </group>
  );
});

// ---------------------------------------------------------------------------
// ActivityIndicators — reads NPC store and renders indicators for all NPCs
// ---------------------------------------------------------------------------

function ActivityIndicators() {
  const npcs = useNpcStore((s) => s.npcs);

  // NPC store doesn't have typingNpcIds or activities in ClawVille's npc.ts,
  // but we can derive typing from inConversation and activity from direction.
  // For now, show conversation bubble indicators for NPCs in conversation.
  return (
    <group>
      {npcs.map((npc) => {
        // Derive simple activity from NPC state
        let activity: string | undefined;
        if (npc.isDead) activity = 'resting';
        else if (npc.inCombat) activity = 'fighting';
        else if (npc.inConversation) activity = 'socializing';
        else if (npc.direction !== 'idle') activity = undefined; // walking, no emoji
        else activity = undefined;

        return (
          <NpcIndicator
            key={npc.id}
            npcId={npc.id}
            x={npc.x}
            y={npc.y}
            activity={activity}
            isTyping={npc.inConversation}
            inConversation={npc.inConversation}
          />
        );
      })}
    </group>
  );
}

export default memo(ActivityIndicators);
