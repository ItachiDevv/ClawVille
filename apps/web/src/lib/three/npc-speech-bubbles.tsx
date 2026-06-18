'use client';

import { memo, useMemo, useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import { useNpcStore, PLAYER_NPC_ID, type NpcChatBubble, type NpcSpriteState } from '@/stores/npc';
import { useShallow } from 'zustand/react/shallow';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// NPC Speech Bubbles — Dom overlay speech bubbles for wandering NPCs
// Uses <Html> from drei (DOM overlay, not GPU rendered — safe on Intel Iris Xe)
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

// Y height above ground in world units — raised from 20 to 150 (2026-05-22).
//
// WHY 150 INSTEAD OF 20:
//   Occlusion raycasting uses the bubble anchor as the ray target. At Y=20 the ray
//   from the camera struck the BASE of structures (shisha-oasis, stalls) from above.
//   Those base-platform triangles have normals pointing +Y (upward). The ray coming
//   DOWN from the camera hits them on their back face. Three.js Raycaster skips
//   back-face hits when material.side === FrontSide, so the intersection returned 0
//   hits → bubble rendered in front of the structure instead of being hidden.
//
//   At Y=150 the anchor sits within the walls/canopy area of every structure (all are
//   ≥500wu tall). Wall triangles face horizontally toward the camera — the ray hits
//   their front face and the intersection is counted → bubble is correctly hidden.
//
//   Visual bonus: speech bubbles floating above the NPC's head (~150wu = 3× NPC
//   height of 45wu) is the conventional game convention for chat bubbles.
const BUBBLE_Y = 150;

// Maximum concurrent speech bubbles to render
const MAX_BUBBLES = 10;

// Maximum characters before truncation
const MAX_CHARS = 80;

// ---------------------------------------------------------------------------
// Single speech bubble rendered at an NPC's world position
// ---------------------------------------------------------------------------

interface SpeechBubbleProps {
  npc: NpcSpriteState;
  bubble: NpcChatBubble;
}

const SpeechBubble = memo(function SpeechBubble({ npc, bubble }: SpeechBubbleProps) {
  const worldX = npc.x - HALF_W;
  const worldZ = npc.y - HALF_H;
  const text = bubble.text.length > MAX_CHARS
    ? bubble.text.slice(0, MAX_CHARS) + '…'
    : bubble.text;

  // groupRef serves as the 3D anchor for WorldLabelsOverlay.
  // The overlay handles behind-camera detection via NDC z > 1 — no manual
  // camera.matrixWorldInverse viewZ calculation needed.
  const groupRef = useRef<THREE.Group>(null);

  // Keep world coords in refs so useFrame reads fresh values without closure capture.
  // Still needed to update the group position each frame (NPC moves with server ticks).
  const worldXRef = useRef(worldX);
  const worldZRef = useRef(worldZ);
  worldXRef.current = worldX;
  worldZRef.current = worldZ;

  const { divRef: bubbleDivRef } = useWorldLabel({
    id: `speech-bubble-${npc.id}-${bubble.expiresAt}`,
    anchorRef: groupRef,
    // offset [0,0,0]: group is already positioned at [worldX, BUBBLE_Y, worldZ].
    offset: [0, 0, 0],
    initialVisible: true,
    // Light proximity fade so distant NPC chatter doesn't clutter the screen
    // with unreadable text — bubbles stay full opacity within ~1800wu of the
    // camera and fade out by ~5000wu (was 4000/10000 — too generous; off-ring
    // NPCs filled the screen with unreadable bubbles). NPC name labels above
    // are NOT faded this aggressively (they're identity, not content).
    fadeNear: 1800,
    fadeFar: 5000,
    fadeBaseOpacity: 1.0,
    // Same occlusion raycast NPC name tags use — hides bubbles behind buildings,
    // shisha-oasis, bazaar/marketplace stalls, auction podium, quest pavilion,
    // town-directory sign, and Nori. Every structure with userData.isOccluder
    // blocks the camera→anchor ray; the 10Hz staggered raycast keeps cost low.
    occlude: true,
    // S4 — a possessed-player self-bubble must not be hidden by its own body.
    skipLocalAvatarOcclusion: npc.id === PLAYER_NPC_ID,
  });

  // Update group world position each frame to track NPC movement.
  // Also keeps visibility in sync — the overlay's NDC z > 1 check replaces the
  // manual viewZ calculation from the previous drei <Html> implementation.
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    g.position.x = worldXRef.current;
    g.position.z = worldZRef.current;
  });

  return (
    <group ref={groupRef} position={[worldX, BUBBLE_Y, worldZ]}>
      {/* WorldLabelsOverlay projects this bubble to screen space.
          width:180 preserves the original layout — see prior comment about
          drei <Html center> collapsing to min-content width. */}
      <WorldLabel divRef={bubbleDivRef}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(8, 20, 38, 0.88)',
            border: '1px solid rgba(100, 200, 255, 0.3)',
            borderRadius: 8,
            padding: '5px 9px',
            width: 180,
            boxSizing: 'border-box',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            userSelect: 'none',
            whiteSpace: 'normal',
            wordBreak: 'normal',
            overflowWrap: 'break-word',
          }}
        >
          {/* Speaker name */}
          <div
            style={{
              color: '#7dd3fc',
              fontWeight: 700,
              fontSize: 10,
              marginBottom: 3,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {bubble.speaker}
          </div>
          {/* Message text */}
          <div
            style={{
              color: 'rgba(255,255,255,0.92)',
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {text}
          </div>
          {/* Bubble tail triangle */}
          <div
            style={{
              position: 'absolute',
              bottom: -6,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: '6px solid rgba(8, 20, 38, 0.88)',
            }}
          />
        </div>
      </WorldLabel>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export — reads NPC store, renders active bubbles for wandering NPCs
// ---------------------------------------------------------------------------

function NpcSpeechBubbles() {
  // useShallow on both array selectors so that SSE ticks where chatBubbles or
  // npcs array content is unchanged (same element references) don't cause re-renders.
  // Combined with B7 (NPC object identity preservation), npcs stays stable when
  // no NPC fields changed — preventing the useMemo(npcMap) from rebuilding each tick.
  const chatBubbles = useNpcStore(useShallow((s) => s.chatBubbles));
  const npcs = useNpcStore(useShallow((s) => s.npcs));

  // Tick every second so expired bubbles are removed from the rendered output
  // even when the zustand store stops updating (quiet demo mode or idle server).
  // Without this, `now` would be stale from the last React render — bubbles
  // would stay on screen past their expiresAt timestamp until the next store update.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  // tick is read so the effect dependency is correct and eslint doesn't strip it
  void tick;

  // Build a lookup map from npcId -> NpcSpriteState for O(1) access
  const npcMap = useMemo(() => {
    const map = new Map<string, NpcSpriteState>();
    for (const npc of npcs) {
      map.set(npc.id, npc);
    }
    return map;
  }, [npcs]);

  // Filter to active, non-expired bubbles — cap at MAX_BUBBLES
  const activeBubbles = chatBubbles
    .filter((b) => b.expiresAt > now && npcMap.has(b.npcId))
    .slice(0, MAX_BUBBLES);

  if (activeBubbles.length === 0) return null;

  return (
    <group>
      {activeBubbles.map((bubble) => {
        const npc = npcMap.get(bubble.npcId)!;
        return (
          <SpeechBubble
            key={`${bubble.npcId}-${bubble.expiresAt}-${bubble.text.slice(0, 16)}`}
            npc={npc}
            bubble={bubble}
          />
        );
      })}
    </group>
  );
}

export default memo(NpcSpeechBubbles);
