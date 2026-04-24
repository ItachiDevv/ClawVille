'use client';

import { memo, useMemo, useState, useEffect, useRef } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
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

  // bubbleDivRef: imperative behind-camera cull — drei <Html> does not hide its
  // DOM portal when the 3D anchor is behind the camera (NDC z > 1 still produces
  // a screen XY), so ghost bubbles float over empty world space. Starts hidden
  // (display:'none'); useFrame below opens it only when the NPC is in front.
  // Zero-allocation: camera.matrixWorldInverse viewZ test (no Vector3 alloc).
  const bubbleDivRef = useRef<HTMLDivElement>(null);
  const { camera } = useThree();

  // Keep world coords in refs so useFrame reads fresh values without closure capture.
  const worldXRef = useRef(worldX);
  const worldZRef = useRef(worldZ);
  worldXRef.current = worldX;
  worldZRef.current = worldZ;

  useFrame(() => {
    const div = bubbleDivRef.current;
    if (!div) return;
    // camera.matrixWorldInverse transforms world→view; viewZ < 0 = in front of camera.
    // Anchor world position: (worldX, BUBBLE_Y, worldZ) — no group.matrixWorld needed.
    const m = camera.matrixWorldInverse.elements;
    const wx = worldXRef.current;
    const wy = BUBBLE_Y;
    const wz = worldZRef.current;
    const viewZ = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
    const inFront = viewZ < 0;
    if (!inFront) {
      if (div.style.display !== 'none') div.style.display = 'none';
    } else {
      if (div.style.display !== 'block') div.style.display = 'block';
    }
  });

  return (
    <group position={[worldX, BUBBLE_Y, worldZ]}>
      {/* NO distanceFactor. Earlier version set distanceFactor={300} claiming
          it was required to preserve maxWidth — in practice the opposite was
          true. drei computes `scale = distanceFactor / cameraDistance`. At
          the default spectate camera ~1217wu from town center, scale ≈ 0.25,
          which shrunk the inner `maxWidth: 180` to ~45px visual — narrow
          enough to force 1-char-per-line wrapping (the tall skinny column
          the user reported 2026-04-24). Constant CSS size (no
          distanceFactor) matches the NPC name-label pattern and keeps the
          bubble readable at all camera distances. */}
      <Html
        center
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          ref={bubbleDivRef}
          style={{
            display: 'none',
            background: 'rgba(8, 20, 38, 0.88)',
            border: '1px solid rgba(100, 200, 255, 0.3)',
            borderRadius: 8,
            padding: '5px 9px',
            // width (not maxWidth!): drei's <Html center> wrapper collapses
            // to min-content around this div. With only `maxWidth: 180`,
            // the actual computed width becomes 1 character (min-content of
            // `word-break: break-word` broken text) and text renders as a
            // vertical column of letters. Setting `width: 180` forces the
            // div to be exactly that wide, and text wraps normally inside.
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
      </Html>
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
