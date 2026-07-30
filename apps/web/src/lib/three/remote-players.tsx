'use client';

import { Suspense, memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AT_COVE_ACTIVITY, AT_KELP_ACTIVITY } from '@clawville/shared';
import type { NpcSpriteState } from '@/stores/npc';
import { usePlayerStore, type RemotePlayerState } from '@/stores/players';
import { GLBNpcMesh, VRMNpcMesh } from '@/lib/three/arena-npcs';
import { MODEL_REGISTRY } from '@/lib/three/agent-model-registry';
import { preloadVRMBytes } from '@/lib/three/vrm-loader';

/**
 * Adapt a `RemotePlayerState` to the `NpcSpriteState` shape consumed by
 * `VRMNpcMesh` / `GLBNpcMesh`. The mesh reads x/y, prevX/prevY, ts/tsDelta,
 * direction, species, color, and id — every other field gets a benign default
 * because remote players don't have HP / combat / inventory / OpenClaw
 * semantics today.
 *
 * `id` is the player's opaque presence id (PlayerSnapshot.id → RemotePlayerState.id),
 * which is also the VRM instanceId. The vrm-loader cache invariant (one
 * instance per `(path, instanceId)`) means two remote players on the same
 * species get distinct VRM scenes (no cross-clobber of skeleton/animation
 * state).
 *
 * `isOpenClaw` is mapped from `kind === 'agent'` so a connected/hosted agent
 * playing AS ITSELF gets the same connected-agent indicator dot the arena
 * NPC renderers already draw for OpenClaw entities (Rule E5 agent parity).
 *
 * `direction` is derived from `dirZ`: VRM facing follows atan2(vx, vz)
 * elsewhere in the renderer, but `direction` is only used downstream for
 * very coarse animation routing (idle vs walking). We map `activity` to
 * those buckets and let the mesh's velocity-derived facing math do the
 * heavy lifting from prev to current position.
 *
 * `facingAngle` is set to `player.dirZ` (the server-authoritative heading)
 * so that when a remote player stops or turns in place the VRM facing
 * locks to the server value instead of freezing at the last velocity-
 * derived angle. The VRMNpcMesh facing block prefers `d.facingAngle` over
 * velocity when non-null, so this path takes precedence for remote players.
 *
 * `isRunning` is derived from `activity === 'running'` so remote players
 * switch to the run clip when the server reports them sprinting.
 *
 * `isRemotePlayer` is set to true so the entity-vs-local-player push-out
 * in arena-npcs.tsx is skipped (each client would compute a different push
 * vector, causing per-client divergence). The AABB building clamp is still
 * applied -- static colliders are identical across clients.
 */
function adaptPlayer(player: RemotePlayerState): NpcSpriteState {
  const isAtCove = player.activity === AT_COVE_ACTIVITY;
  const isAtKelp = player.activity === AT_KELP_ACTIVITY;
  const direction: NpcSpriteState['direction'] =
    player.activity === 'idle' || isAtCove || isAtKelp ? 'idle' : 'down';
  const name = isAtCove
    ? `${player.name} · at the Cove`
    : isAtKelp
      ? `${player.name} · at the Kelp Forest`
      : player.name;
  return {
    id: player.id,
    name,
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
    isOpenClaw: player.kind === 'agent',
    combatAction: null,
    combatActionAt: 0,
    // Server-authoritative heading. VRMNpcMesh uses this when non-null,
    // overriding velocity-derived facing so stopped/turning players
    // immediately show the correct direction from the server.
    facingAngle: player.dirZ,
    // Remote players use the 'run' animation when the server reports them
    // sprinting. Local NPC sprints are set by NpcController via moveNpc.
    isRunning: player.activity === 'running',
    // Skip the entity-vs-local-player push-out for remote players
    // (see NpcSpriteState.isRemotePlayer JSDoc for the full rationale).
    isRemotePlayer: true,
  };
}

interface RemotePlayerEntryProps {
  player: RemotePlayerState;
}

/**
 * Per-player wrapper. Remote players render as their real GLB/VRM model;
 * visible capsule stand-ins were rejected for player-facing world quality.
 *
 * IMPORTANT: `memo` is applied here but the `<Suspense>` boundary is
 * intentionally kept OUTSIDE this component (at the RemotePlayers map
 * level). Placing Suspense inside a memo wrapper deadlocks the first VRM
 * load: React's Suspense retry needs to re-render through the memo to reach
 * the boundary, but a memo bailout (same `player` ref while the load is
 * in flight) returns the previous (suspended) output unchanged forever,
 * leaving permanent zero-mesh. So every player's Suspense boundary lives
 * one level up, outside memo (the D3a fix).
 *
 * MOVEMENT (2026-06-12, Codex finding #5): the players store does IMMUTABLE
 * updates — `updateFromSnapshot` emits a NEW object for any player whose
 * position / heading / activity changed and keeps the previous reference only
 * for players that are perfectly still. So when a remote player moves, `player`
 * identity flips: memo re-renders this entry, `useMemo([player])` recomputes the
 * adapter with the fresh interpolation endpoints, and `VRMNpcMesh`/`GLBNpcMesh`
 * pick up the new `npcRef.current` — the mesh's entity-interp then lerps
 * prevX→x over tsDelta and the remote player VISIBLY moves. A still player keeps
 * its reference, so memo bails and costs zero reconciliation. (Before this, the
 * store mutated in place; identity never changed; the adapter froze at mount and
 * remote players mounted once then never moved.)
 */
const RemotePlayerEntry = memo(function RemotePlayerEntry({ player }: RemotePlayerEntryProps) {
  // Rebuilt whenever `player` identity changes — i.e. every snapshot in which
  // this player moved (immutable store update, see header). Still players keep
  // their ref so this memo bails and nothing recomputes. Cheap allocation; we
  // trade the alloc for keeping VRMNpcMesh / GLBNpcMesh untouched.
  const npcLike = useMemo(() => adaptPlayer(player), [player]);

  const regEntry = MODEL_REGISTRY[player.species as keyof typeof MODEL_REGISTRY];
  if (regEntry?.avatar_type === 'vrm') {
    // Eagerly warm the VRM byte cache (HTTP fetch only; no parse) so the
    // VRMNpcMesh Suspense boundary (in the parent) can start parsing as
    // soon as possible. Remote player VRMs like `phanes` and `eliza-chibi`
    // are NOT in the module-scope preload list in arena-npcs.tsx (which
    // only covers the 11 wandering NPC VRMs). Without this, the bytes
    // fetch starts only AFTER useVRMInstance throws its first Suspense
    // promise — adding one full HTTP round-trip to an already-queued
    // parse. `preloadVRMBytes` is a no-op if the bytes are already cached.
    preloadVRMBytes(regEntry.path);
    // VRMNpcMesh calls useVRMInstance which throws a Suspense promise while
    // loading. The promise is caught by the <Suspense> boundary in
    // RemotePlayers (one level up, outside this memo wrapper).
    return <VRMNpcMesh npc={npcLike} />;
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
 *
 * Each remote player gets its OWN <Suspense> boundary keyed to the player
 * id. This is required because the Suspense boundary must be OUTSIDE the
 * React.memo wrapper on RemotePlayerEntry — see the comment on that
 * component for the full deadlock explanation. One boundary per player also
 * ensures that a stalled VRM load for player A does not hold back player B's
 * render (no shared fallback state between entries).
 */
export default function RemotePlayers() {
  const players = usePlayerStore(useShallow((s) => s.players));

  return (
    <group>
      {players.map((p) => {
        if (p.isLocal) return null;
        return (
          <Suspense key={p.id} fallback={null}>
            <RemotePlayerEntry player={p} />
          </Suspense>
        );
      })}
    </group>
  );
}
