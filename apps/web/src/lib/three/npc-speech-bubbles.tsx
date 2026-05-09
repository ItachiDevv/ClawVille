'use client';

import { memo, useMemo, useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import { useNpcStore, type NpcChatBubble, type NpcSpriteState } from '@/stores/npc';
import { useShallow } from 'zustand/react/shallow';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// NPC Speech Bubbles — Dom overlay speech bubbles for wandering NPCs
// Uses <Html> from drei (DOM overlay, not GPU rendered — safe on Intel Iris Xe)
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

// Y height above ground in world units (wandering NPCs sit ~2 units above terrain,
// scaled by NPC_SCALE=13, so their tops are roughly 26-36 units up).
const BUBBLE_Y = 20;

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
