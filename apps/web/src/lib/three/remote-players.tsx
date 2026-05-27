'use client';

import { Suspense, memo, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { NpcSpriteState } from '@/stores/npc';
import { usePlayerStore, type RemotePlayerState } from '@/stores/players';
import { useLodStore } from '@/stores/lod';
import { GLBNpcMesh, VRMNpcMesh } from '@/lib/three/arena-npcs';
import { MODEL_REGISTRY } from '@/lib/three/agent-model-registry';
import { RemotePlayerProxy } from '@/lib/three/remote-player-proxy';

/**
 * Adapt a `RemotePlayerState` to the `NpcSpriteState` shape consumed by
 * `VRMNpcMesh` / `GLBNpcMesh`. The mesh reads x/y, prevX/prevY, ts/tsDelta,
 * direction, species, color, and id — every other field gets a benign default
 * because remote players don't have HP / combat / inventory / OpenClaw
 * semantics today.
 *
 * `id` is the player's sessionId, which is also the VRM instanceId. The
 * vrm-loader cache invariant (one instance per `(path, instanceId)`) means
 * two remote players on the same species get distinct VRM scenes — no
 * cross-clobber of skeleton/animation state.
 *
 * `direction` is derived from `dirZ`: VRM facing follows atan2(vx, vz)
 * elsewhere in the renderer, but `direction` is only used downstream for
 * very coarse animation routing (idle vs walking). We map `activity` to
 * those buckets and let the mesh's velocity-derived facing math do the
 * heavy lifting from prev → current position.
 */
function adaptPlayer(player: RemotePlayerState): NpcSpriteState {
  const direction: NpcSpriteState['direction'] =
    player.activity === 'idle' ? 'idle' : 'down';
  return {
    id: player.sessionId,
    name: player.name,
    x: player.x,
    y: player.y,
    prevX: player.prevX,
    prevY: player.prevY,
    ts: player.ts,
    tsDelta: player.tsDelta,
    direction,
    species: player.species,
    color: player.color,
    hp: 100,
    maxHp: 100,
    isDead: false,
    hasSword: false,
    inCombat: false,
    inConversation: false,
    inventory: [],
    isOpenClaw: false,
    combatAction: null,
    combatActionAt: 0,
    facingAngle: null,
  };
}

interface RemotePlayerEntryProps {
  player: RemotePlayerState;
}

/**
 * Per-player wrapper. Reads its own `fullSet` membership from the LOD store
 * so a single player switching tiers does NOT re-render any sibling entry.
 *
 * When `isFull` is true → mount a full VRM (or GLB) mesh routed through the
 * existing arena-npcs renderers. When false → mount the cheap capsule proxy.
 *
 * `memo` on the entry component plus stable `npcLike` ref (rebuilt only when
 * identity-relevant fields shift) preserves the React.memo bailout inside
 * VRMNpcMesh / GLBNpcMesh, so a full-tier player only re-renders when its
 * own snapshot mutates — sibling players never trigger re-renders.
 */
const RemotePlayerEntry = memo(function RemotePlayerEntry({ player }: RemotePlayerEntryProps) {
  const isFull = useLodStore((s) => s.fullSet.has(player.sessionId));
  // npcLike is rebuilt on every render of this entry — but the entry only
  // re-renders when player or isFull changes (memo on player ref equality
  // from the store + zustand shallow on isFull). Cheap allocation; we trade
  // the alloc for keeping VRMNpcMesh / GLBNpcMesh untouched.
  const npcLike = useMemo(() => adaptPlayer(player), [player]);

  if (!isFull) {
    return <RemotePlayerProxy player={player} />;
  }

  const regEntry = MODEL_REGISTRY[player.species as keyof typeof MODEL_REGISTRY];
  if (regEntry?.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <VRMNpcMesh npc={npcLike} />
      </Suspense>
    );
  }
  return <GLBNpcMesh npc={npcLike} />;
});

/**
 * Top-level remote-players renderer. Mounts inside `World3DCanvas` next to
 * `ArenaNpcs`. The local viewer is rendered by `player-avatar.tsx` and is
 * filtered out here so we never double-render the player.
 *
 * Subscription pattern: `useShallow((s) => s.players)` so the parent
 * re-renders only when the player array reference changes; sibling entries
 * are isolated by memo + per-entry LOD subscription.
 */
export default function RemotePlayers() {
  const players = usePlayerStore(useShallow((s) => s.players));

  return (
    <Suspense fallback={null}>
      <group>
        {players.map((p) => {
          if (p.isLocal) return null;
          return <RemotePlayerEntry key={p.sessionId} player={p} />;
        })}
      </group>
    </Suspense>
  );
}
