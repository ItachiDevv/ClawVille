'use client';

import { useRef, useEffect, memo } from 'react';
import {
  useSceneActive,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
// Text removed
import * as THREE from 'three';
import { useNpcStore } from '@/stores/npc';
import { useShallow } from 'zustand/react/shallow';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

const PULSE_SPEED = 3; // Hz for scale pulse
const PULSE_MIN = 1.0;
const PULSE_MAX = 1.25;
const INDICATOR_Y = 10; // height above NPC position
const TYPING_Y = 9;

// ---------------------------------------------------------------------------
// Shared GPU resources, one geometry + material per look (web-load T9)
// ---------------------------------------------------------------------------
//
// Why: the JSX <meshBasicMaterial> / <sphereGeometry> built NEW objects every
// time an indicator showed, so each show cost one synchronous pipeline
// creation on the live world (T8 probe: one every 8-16 s; an Iris Xe hitch).
// Now every indicator mesh uses these module-level objects: identity is
// stable for the whole session, so a look compiles once. The layer
// (ActivityIndicators) holds the only user count: GPU resources are released
// when the LAST mounted layer unmounts, never when one indicator hides (the
// next show would then compile again). The JS objects stay valid after
// dispose(); three re-uploads them on the next render, so a remount (and a
// StrictMode setup/cleanup/setup) keeps the same identity.

type IndicatorLook = 'activity' | 'typing-dot';
type IndicatorLookResources = { geometry: THREE.BufferGeometry; material: THREE.Material };

const INDICATOR_LOOKS: Record<IndicatorLook, () => IndicatorLookResources> = {
  activity: () => ({
    geometry: new THREE.SphereGeometry(1.5, 8, 8),
    material: new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.6 }),
  }),
  'typing-dot': () => ({
    geometry: new THREE.SphereGeometry(0.4, 6, 4),
    material: new THREE.MeshBasicMaterial({ color: 0xcccccc }),
  }),
};

const sharedLooks = new Map<IndicatorLook, IndicatorLookResources>();
let sharedLookUsers = 0;

function getIndicatorLook(look: IndicatorLook): IndicatorLookResources {
  let resources = sharedLooks.get(look);
  if (!resources) {
    resources = INDICATOR_LOOKS[look]();
    sharedLooks.set(look, resources);
  }
  return resources;
}

function retainIndicatorLooks(): void {
  sharedLookUsers += 1;
}

function releaseIndicatorLooks(): void {
  sharedLookUsers -= 1;
  if (sharedLookUsers > 0) return;
  sharedLookUsers = 0;
  for (const { geometry, material } of sharedLooks.values()) {
    geometry.dispose();
    material.dispose();
  }
}

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
  x: number;
  y: number;
  activity?: string;
  isTyping: boolean;
  inConversation: boolean;
}

const NpcIndicator = memo(function NpcIndicator({
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
  const activityLook = getIndicatorLook('activity');

  useSceneFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    const elapsed = state.clock.elapsedTime;
    const pulse = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 + 0.5 * Math.sin(elapsed * PULSE_SPEED * Math.PI * 2));
    scaleRef.current = pulse;
    group.scale.setScalar(pulse);
  });

  // Show activity emoji even during conversation (socializing speech bubble)
  const showEmoji = emoji.length > 0;
  const showTyping = isTyping;

  if (!showEmoji && !showTyping) return null;

  return (
    <group ref={groupRef} position={[worldX, 0, worldZ]}>
      {/* Activity indicator — glowing sphere instead of Text */}
      {showEmoji && (
        // Shared look (module-level); dispose={null}: the layer owns it.
        <mesh
          position={[0, INDICATOR_Y, 0]}
          geometry={activityLook.geometry}
          material={activityLook.material}
          dispose={null}
        />
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

/** Stagger bounce: each dot is offset by 0.2 s. */
function bounceTypingDot(mesh: THREE.Mesh | null, t: number, index: number, y: number): void {
  if (!mesh) return;
  mesh.position.y = y + Math.abs(Math.sin((t + index * 0.2) * 4)) * 1.5;
}

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

  const dotLook = getIndicatorLook('typing-dot');

  // No allocation per frame (Iris Xe rule): three direct calls, no array.
  useSceneFrame((state) => {
    const t = state.clock.elapsedTime;
    bounceTypingDot(dot1Ref.current, t, 0, y);
    bounceTypingDot(dot2Ref.current, t, 1, y);
    bounceTypingDot(dot3Ref.current, t, 2, y);
  });

  return (
    <group position={[x, 0, z]}>
      <mesh ref={dot1Ref} position={[-1.2, y, 0]} geometry={dotLook.geometry} material={dotLook.material} dispose={null} />
      <mesh ref={dot2Ref} position={[0, y, 0]} geometry={dotLook.geometry} material={dotLook.material} dispose={null} />
      <mesh ref={dot3Ref} position={[1.2, y, 0]} geometry={dotLook.geometry} material={dotLook.material} dispose={null} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// ActivityIndicators — reads NPC store and renders indicators for all NPCs
// ---------------------------------------------------------------------------

// PERF: subscribe only to the activity-relevant NPC fields (isDead, inCombat,
// inConversation, id, x, y) rather than the full NPC array. Full subscription
// re-renders this component every 100ms SSE snapshot (NPC positions change
// constantly), even though the emoji/typing state changes only rarely.
// We use a shallow-equal selector on a derived array of activity snapshots.
interface NpcActivitySnapshot {
  id: string;
  x: number;
  y: number;
  isDead: boolean;
  inCombat: boolean;
  inConversation: boolean;
}

// Stable empty array to avoid triggering re-renders when no NPCs are active
const EMPTY_SNAPSHOTS: NpcActivitySnapshot[] = [];

function ActivityIndicators() {
  const sceneActive = useSceneActive();
  // The layer is the only user of the shared indicator looks (see above):
  // they stay allocated while it is mounted, even with no indicator showing.
  useEffect(() => {
    retainIndicatorLooks();
    return releaseIndicatorLooks;
  }, []);
  // Subscribe to a derived array that only contains the fields we care about.
  // useShallow performs element-by-element shallow comparison on the returned
  // array, so a new array with identical elements does NOT trigger a re-render.
  // Without useShallow every SSE tick (10 Hz) caused a full re-render even when
  // no activity indicators changed.
  const npcSnapshots = useNpcStore(useShallow((s) => {
    const arr = s.npcs;
    if (arr.length === 0) return EMPTY_SNAPSHOTS;
    // Only include NPCs that have a non-empty indicator to show
    return arr.filter((n) => n.isDead || n.inCombat || n.inConversation)
              .map((n): NpcActivitySnapshot => ({
                id: n.id,
                x: n.x,
                y: n.y,
                isDead: n.isDead,
                inCombat: n.inCombat,
                inConversation: n.inConversation,
              }));
  }));

  // Periodically evict expired chatBubbles / combatEvents / lootEvents.
  // cleanupExpired() is defined in the store but was never called — in demo
  // mode (no server) updateFromSnapshot never runs, so stale bubbles accumulate.
  useEffect(() => {
    if (!sceneActive) return;
    const id = setInterval(() => {
      useNpcStore.getState().cleanupExpired();
    }, 5000);
    return () => clearInterval(id);
  }, [sceneActive]);

  if (npcSnapshots.length === 0) return null;

  return (
    <group>
      {npcSnapshots.map((npc) => {
        // Derive simple activity from NPC state
        let activity: string | undefined;
        if (npc.isDead) activity = 'resting';
        else if (npc.inCombat) activity = 'fighting';
        else if (npc.inConversation) activity = 'socializing';
        else activity = undefined;

        return (
          <NpcIndicator
            key={npc.id}
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
