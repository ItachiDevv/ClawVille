'use client';

import { Suspense, memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AT_ACTIVITY,
  AT_COVE_ACTIVITY,
  AT_KELP_ACTIVITY,
} from '@clawville/shared';
import type { NpcSpriteState } from '@/stores/npc';
import { usePlayerStore, type RemotePlayerState } from '@/stores/players';
import {
  GLBNpcMesh,
  VRMNpcMesh,
  useAmbientBodyRelease,
  useVRMOrphanCancel,
  useVRMWarmRead,
  vrmPathForSpecies,
} from '@/lib/three/arena-npcs';
import { DeferredWarmAttachment } from '@/lib/three/deferred-warm-attachment';
import { ModelLoadBoundary } from '@/lib/three/model-load-boundary';
import { MODEL_REGISTRY } from '@/lib/three/agent-model-registry';
import { preloadVRMBytes } from '@/lib/three/vrm-loader';

function isAtLabelledActivity(activity: string): boolean {
  return activity === AT_COVE_ACTIVITY || activity === AT_KELP_ACTIVITY || activity === AT_ACTIVITY;
}

function remotePlayerLabel(player: RemotePlayerState): string {
  switch (player.activity) {
    case AT_COVE_ACTIVITY:
      return `${player.name} · at the Cove`;
    case AT_KELP_ACTIVITY:
      return `${player.name} · at the Kelp Forest`;
    case AT_ACTIVITY:
      return `${player.name} · in an activity`;
    default:
      return player.name;
  }
}

/**
 * View a `RemotePlayerState` as the `NpcSpriteState` shape consumed by
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
 * `direction` is derived from `activity`: VRM facing follows atan2(vx, vz)
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
 *
 * LIVE READS (web-load T3, 2026-10-06): the players store now MUTATES the
 * player object in place on position-only snapshots (no new object, no
 * React render). So every field the mesh reads in its frame loop is a GETTER
 * onto that live object: x/y, prevX/prevY, ts/tsDelta, direction,
 * facingAngle, isRunning. One instance per player object (no per-frame
 * allocation). Copying these fields here would freeze the body at its mount
 * position (the 2026-06-12 Codex #5 freeze). Only render-time fields (id,
 * name label, species, color, isOpenClaw) are copied: changing one of them is
 * a structural store change that gives a new player object and so a new
 * instance.
 */
class RemotePlayerBody implements NpcSpriteState {
  /** The LIVE store object (mutated in place by updateFromSnapshot). */
  private readonly player: RemotePlayerState;
  readonly id: string;
  readonly name: string;
  readonly species: string;
  readonly color: number;
  readonly isOpenClaw: boolean;
  readonly hp = 100;
  readonly maxHp = 100;
  readonly isDead = false;
  readonly hasSword = false;
  readonly inCombat = false;
  readonly inConversation = false;
  readonly inventory: string[] = [];
  readonly combatAction = null;
  readonly combatActionAt = 0;
  // Skip the entity-vs-local-player push-out for remote players
  // (see NpcSpriteState.isRemotePlayer JSDoc for the full rationale).
  readonly isRemotePlayer = true;

  constructor(player: RemotePlayerState) {
    this.player = player;
    this.id = player.id;
    this.name = remotePlayerLabel(player);
    this.species = player.species;
    this.color = player.color;
    this.isOpenClaw = player.kind === 'agent';
  }

  get x(): number {
    return this.player.x;
  }
  get y(): number {
    return this.player.y;
  }
  get prevX(): number {
    return this.player.prevX;
  }
  get prevY(): number {
    return this.player.prevY;
  }
  get ts(): number {
    return this.player.ts;
  }
  get tsDelta(): number {
    return this.player.tsDelta;
  }
  get direction(): NpcSpriteState['direction'] {
    const activity = this.player.activity;
    return activity === 'idle' || isAtLabelledActivity(activity) ? 'idle' : 'down';
  }
  // Server-authoritative heading. VRMNpcMesh uses this when non-null,
  // overriding velocity-derived facing so stopped/turning players
  // immediately show the correct direction from the server.
  get facingAngle(): number {
    return this.player.dirZ;
  }
  // Remote players use the 'run' animation when the server reports them
  // sprinting. Local NPC sprints are set by NpcController via moveNpc.
  get isRunning(): boolean {
    return this.player.activity === 'running';
  }
}

interface RemotePlayerEntryProps {
  player: RemotePlayerState;
  /** Slice C: false while the DeferredWarmAttachment is warming — gates the
   *  DOM label (the three subtree is hidden by the attachment's group). */
  attachmentVisible?: boolean;
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
 * MOVEMENT (web-load T3, 2026-10-06): position-only snapshots MUTATE the
 * player object in place, so `player` identity does NOT change when a remote
 * player moves and this entry does not re-render (0 commits per snapshot).
 * The body still moves because `RemotePlayerBody` reads x/prevX/ts/tsDelta
 * and the other frame-loop fields LIVE from that object every frame. The
 * 2026-06-12 freeze (Codex #5) came from a COPY of those fields cached by
 * object identity; do not reintroduce one. A structural change (name, model,
 * color, kind, label activity, isLocal) gives a new player object, so memo
 * re-renders and a new `RemotePlayerBody` is built.
 */
const RemotePlayerEntry = memo(function RemotePlayerEntry({
  player,
  attachmentVisible = true,
}: RemotePlayerEntryProps) {
  // One live view per player object (see RemotePlayerBody): rebuilt only on a
  // structural change, never per snapshot, never per frame.
  const npcLike = useMemo(() => new RemotePlayerBody(player), [player]);

  const regEntry = MODEL_REGISTRY[player.species as keyof typeof MODEL_REGISTRY];
  if (regEntry?.avatar_type === 'vrm') {
    // Eagerly warm the VRM byte cache (HTTP fetch only; no parse) so the
    // VRMNpcMesh Suspense boundary (in the parent) can start parsing as
    // soon as possible. Remote player VRMs like `phanes` and `eliza-chibi`
    // are NOT preloaded anywhere else. Rung-4 slice C: this entry now mounts
    // only AFTER the decorative release (see DeferredRemoteBody below), so
    // this render-phase warm can no longer race the boot's tier-1 fetches.
    preloadVRMBytes(regEntry.path);
    // VRMNpcMesh calls useVRMInstance which throws a Suspense promise while
    // loading. The promise is caught by the <Suspense> boundary in
    // RemotePlayers (one level up, outside this memo wrapper).
    return <VRMNpcMesh npc={npcLike} attachmentVisible={attachmentVisible} />;
  }
  return <GLBNpcMesh npc={npcLike} attachmentVisible={attachmentVisible} />;
});

/**
 * Rung-4 slice C (Codex round-1 finding 1): remote bodies are ambient for
 * boot purposes — a multiplayer snapshot arriving pre-reveal must not enqueue
 * VRM parses into the vrmBulk gate. Same deferral + warm-queue treatment as
 * wanderers (useAmbientBodyRelease), plus the orphan-parse cancel bracket
 * for a remote player who LEAVES while their mesh is still suspended.
 * Mid-session joins initialize released and mount immediately with a real
 * distance priority.
 */
function DeferredRemoteBody({ player }: { player: RemotePlayerState }) {
  const { released, priority } = useAmbientBodyRelease(player.x, player.y, false);
  const regEntry = MODEL_REGISTRY[player.species as keyof typeof MODEL_REGISTRY];
  const vrmPath = regEntry?.avatar_type === 'vrm' ? vrmPathForSpecies(player.species) : null;
  // Order matters: the orphan bracket's retain runs before the warm starts.
  useVRMOrphanCancel(vrmPath, player.id);
  // web-load T9: same as wanderers — the VRM resolves outside React before
  // the body mounts, so a mid-session join never reveals through a Suspense
  // retry lane (starved by the 5 Hz world-stream SyncLane renders).
  const vrmWarmed = useVRMWarmRead(vrmPath, player.id, released);
  if (!released || !vrmWarmed) return null;
  // The Suspense boundary must live INSIDE this component, BELOW the
  // cancellation hook (Codex round-2 finding 1): a post-release join renders
  // the suspending VRM subtree on this component's very first render, and
  // with only the outer map-level boundary, this component itself would be
  // held un-committed — the orphan-cancel effect would never install, and a
  // player leaving before resolution would leak the parse. With the inner
  // boundary, only the subtree below it suspends; this component commits.
  // ModelLoadBoundary (2026-10-04): a remote player whose model fails to load
  // renders nothing and logs once instead of crashing the whole world canvas;
  // below the orphan-cancel hook so a remount retries (see the component).
  return (
    <ModelLoadBoundary
      assetUrl={vrmPath ?? regEntry?.path ?? player.species}
      label={`remote:${player.id}`}
      resetKey={player.species}
    >
      <Suspense fallback={null}>
        {/* key={player.species} (Codex round-3 finding 2): remote players can
            switch avatars under a stable id — the warm state is scoped to the
            model resource so the replacement gets its own warm pass instead of
            attaching unwarmed under a stale ready=true attachment. */}
        <DeferredWarmAttachment
          key={player.species}
          label={`remote:${player.id}`}
          priority={priority}
        >
          {(warmReady) => (
            <RemotePlayerEntry player={player} attachmentVisible={warmReady} />
          )}
        </DeferredWarmAttachment>
      </Suspense>
    </ModelLoadBoundary>
  );
}

/**
 * Top-level remote-players renderer. Mounts inside `World3DCanvas` next to
 * `ArenaNpcs`. The local viewer is rendered by `player-avatar.tsx` and is
 * filtered out here so we never double-render the player.
 *
 * Subscription pattern: `useShallow((s) => s.players)` so the parent
 * re-renders only on a structural store change (join, leave, reorder, or a
 * render field). Position-only snapshots keep the array and every object, and
 * do not even notify the store (web-load T3). Sibling entries are isolated by
 * memo + per-entry LOD subscription.
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
            <DeferredRemoteBody player={p} />
          </Suspense>
        );
      })}
    </group>
  );
}
