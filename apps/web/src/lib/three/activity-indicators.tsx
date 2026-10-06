'use client';

import { useRef, useEffect, useMemo, memo } from 'react';
import {
  useSceneActive,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
// Text removed
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState, type NpcStoreState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { getNpcRenderGroup } from '@/lib/three/arena-npcs';

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
// next show would then compile again). The release is deferred one tick and
// a retain cancels it, so a StrictMode setup/cleanup/setup keeps the same
// objects; a real last unmount disposes them and empties the map, and the
// next mount builds fresh objects.

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

/** Pending teardown after the last layer unmounted (cancelled by a retain). */
let pendingLookRelease: ReturnType<typeof setTimeout> | null = null;

function retainIndicatorLooks(): void {
  sharedLookUsers += 1;
  // A StrictMode re-setup (or a remount in the same tick) keeps the objects
  // its render already holds: cancel the teardown instead of rebuilding.
  if (pendingLookRelease !== null) {
    clearTimeout(pendingLookRelease);
    pendingLookRelease = null;
  }
}

function releaseIndicatorLooks(): void {
  sharedLookUsers = Math.max(0, sharedLookUsers - 1);
  if (sharedLookUsers > 0 || pendingLookRelease !== null) return;
  // Deferred one tick (Codex E3 on 1ea42199): StrictMode runs cleanup and
  // setup back to back with no re-render, so a synchronous teardown would
  // dispose objects the mounted meshes still use. On a real last unmount
  // the timer runs: dispose every resource once and DROP it from the map, so
  // a later mount builds fresh objects instead of reusing disposed ones.
  pendingLookRelease = setTimeout(() => {
    pendingLookRelease = null;
    if (sharedLookUsers > 0) return;
    for (const { geometry, material } of sharedLooks.values()) {
      geometry.dispose();
      material.dispose();
    }
    sharedLooks.clear();
  }, 0);
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
  npcId: string;
  activity?: string;
  isTyping: boolean;
}

/** Id lookup without a closure (runs once per store write, not per frame). */
function findNpcById(npcs: readonly NpcSpriteState[], id: string): NpcSpriteState | null {
  for (let i = 0; i < npcs.length; i += 1) {
    if (npcs[i].id === id) return npcs[i];
  }
  return null;
}

const NpcIndicator = memo(function NpcIndicator({
  npcId,
  activity,
  isTyping,
}: NpcIndicatorProps) {
  const groupRef = useRef<THREE.Group>(null);
  const scaleRef = useRef(1);
  // The indicator follows its NPC from the frame loop and never needs a React
  // render to move (web-load T10). First choice: the NPC's rendered body
  // group (getNpcRenderGroup, the smoothed position the mesh draws at).
  // Fallback: the store object, whose position the store MUTATES in place
  // (stores/npc.ts updateFromSnapshot / moveNpc); it is looked up again only
  // when the store's npcs ARRAY changes (one id scan per store write), since
  // an identity change (conversation flip, rename, species swap) replaces it.
  const npcsSeenRef = useRef<readonly NpcSpriteState[] | null>(null);
  const npcRef = useRef<NpcSpriteState | null>(null);

  // Render-time position, so the indicator is in place before the first frame.
  const renderNpc = findNpcById(useNpcStore.getState().npcs, npcId);
  const worldX = renderNpc ? renderNpc.x - HALF_W : 0;
  const worldZ = renderNpc ? renderNpc.y - HALF_H : 0;

  const emoji = activity ? ACTIVITY_EMOJIS[activity] ?? '' : '';
  const activityLook = getIndicatorLook('activity');

  useSceneFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    // Follow the rendered (smoothed) body when it is mounted; else the raw
    // store position (body not mounted yet, or its model failed).
    const body = getNpcRenderGroup(npcId);
    if (body) {
      group.position.x = body.position.x;
      group.position.z = body.position.z;
    } else {
      const npcs = useNpcStore.getState().npcs;
      if (npcs !== npcsSeenRef.current) {
        npcsSeenRef.current = npcs;
        npcRef.current = findNpcById(npcs, npcId);
      }
      const npc = npcRef.current;
      if (npc) {
        group.position.x = npc.x - HALF_W;
        group.position.z = npc.y - HALF_H;
      }
    }

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

// PERF (web-load T10): the layer selects ONE primitive string, so its store
// subscription bails (Object.is) on every position-only snapshot. Before, it
// selected NEW snapshot objects through useShallow, which compares elements
// with Object.is and so NEVER bailed: one SyncLane render of the R3F root per
// 200 ms snapshot while any NPC talked, and each render discarded pending
// Suspense retry work (gotchas/suspense-retry-lane-starvation-sync-store-updates.md).
// Positions are not in the key: each indicator follows its NPC from the frame
// loop (NpcIndicator above).
//
// Key: one length-prefixed entry per indicated NPC, `<id.length>:<id><flags>`,
// concatenated. NPC ids are free server strings, so no separator character is
// safe; the length prefix reads any id back exactly (Codex E3). Flags is ONE
// digit: 1 = isDead, 2 = inCombat, 4 = inConversation (never 0 here).

function selectIndicatorKey(s: NpcStoreState): string {
  const npcs = s.npcs;
  let key = '';
  for (let i = 0; i < npcs.length; i += 1) {
    const n = npcs[i];
    // Only NPCs that have an indicator to show
    if (!n.isDead && !n.inCombat && !n.inConversation) continue;
    const flags = (n.isDead ? 1 : 0) | (n.inCombat ? 2 : 0) | (n.inConversation ? 4 : 0);
    key += n.id.length + ':' + n.id + flags;
  }
  return key;
}

interface IndicatorEntry {
  id: string;
  isDead: boolean;
  inCombat: boolean;
  inConversation: boolean;
}

function parseIndicatorKey(key: string): IndicatorEntry[] {
  const entries: IndicatorEntry[] = [];
  let at = 0;
  while (at < key.length) {
    const colon = key.indexOf(':', at);
    const idLength = Number(key.slice(at, colon));
    const idStart = colon + 1;
    const flags = Number(key[idStart + idLength]);
    entries.push({
      id: key.slice(idStart, idStart + idLength),
      isDead: (flags & 1) !== 0,
      inCombat: (flags & 2) !== 0,
      inConversation: (flags & 4) !== 0,
    });
    at = idStart + idLength + 1;
  }
  return entries;
}

function ActivityIndicators() {
  const sceneActive = useSceneActive();
  // The layer is the only user of the shared indicator looks (see above):
  // they stay allocated while it is mounted, even with no indicator showing.
  useEffect(() => {
    retainIndicatorLooks();
    return releaseIndicatorLooks;
  }, []);
  const indicatorKey = useNpcStore(selectIndicatorKey);
  const entries = useMemo(() => parseIndicatorKey(indicatorKey), [indicatorKey]);

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

  if (entries.length === 0) return null;

  return (
    <group>
      {entries.map((npc) => {
        // Derive simple activity from NPC state
        let activity: string | undefined;
        if (npc.isDead) activity = 'resting';
        else if (npc.inCombat) activity = 'fighting';
        else if (npc.inConversation) activity = 'socializing';
        else activity = undefined;

        return (
          <NpcIndicator
            key={npc.id}
            npcId={npc.id}
            activity={activity}
            isTyping={npc.inConversation}
          />
        );
      })}
    </group>
  );
}

export default memo(ActivityIndicators);
