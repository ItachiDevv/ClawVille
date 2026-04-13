'use client';

import { memo, useMemo } from 'react';
import { Html } from '@react-three/drei';
import { useNpcStore, type NpcChatBubble, type NpcSpriteState } from '@/stores/npc';

// ---------------------------------------------------------------------------
// NPC Speech Bubbles — Dom overlay speech bubbles for wandering NPCs
// Uses <Html> from drei (DOM overlay, not GPU rendered — safe on Intel Iris Xe)
// ---------------------------------------------------------------------------

const MAP_WIDTH = 2048;
const MAP_HEIGHT = 1280;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

// Y height above ground in world units (wandering NPCs sit ~2 units above terrain,
// scaled by NPC_SCALE=8, so their tops are roughly 16-20 units up).
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

  return (
    <group position={[worldX, BUBBLE_Y, worldZ]}>
      <Html
        center
        distanceFactor={300}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            background: 'rgba(8, 20, 38, 0.88)',
            border: '1px solid rgba(100, 200, 255, 0.3)',
            borderRadius: 8,
            padding: '5px 9px',
            maxWidth: 180,
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            userSelect: 'none',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
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
  const chatBubbles = useNpcStore((s) => s.chatBubbles);
  const npcs = useNpcStore((s) => s.npcs);

  const now = Date.now();

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
            key={`${bubble.npcId}-${bubble.expiresAt}`}
            npc={npc}
            bubble={bubble}
          />
        );
      })}
    </group>
  );
}

export default memo(NpcSpeechBubbles);
