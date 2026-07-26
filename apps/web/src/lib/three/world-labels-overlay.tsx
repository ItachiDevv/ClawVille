'use client';

/**
 * WorldLabelsOverlay — single-root architecture
 *
 * Replaces 30+ per-label `createRoot()` instances with ONE React root for the
 * entire overlay. All labels render as children of one tree, so React's
 * reconciler diffs them efficiently in a single pass.
 *
 * Why this matters
 *   The previous version (commits f54331d + 88f8a75) created one createRoot()
 *   per <WorldLabel>, then re-ran root.render() on every children-prop change.
 *   With ~30 labels × 10Hz SSE-driven parent re-renders, that produced ~300
 *   independent React reconciliations per second. Memory pressure compounded
 *   over ~20s of gameplay until the tab crashed.
 *
 * Now
 *   - WorldLabelsOverlayMount creates ONE overlay <div> and ONE createRoot.
 *   - That root renders <LabelsHost />, a single component that maps the
 *     module-scope registry into a flat list of <LabelView> children.
 *   - <WorldLabel> consumers update their entry's `content` field. When
 *     anything changes, _scheduleNotify() coalesces in a microtask and
 *     LabelsHost re-renders ONCE — React diffs N labels in one tree.
 *   - The projection useFrame stays the same: zero per-frame allocations,
 *     DOMRect read once per frame, transform writes skipped if NDC moved
 *     <0.5 px, display writes skipped on no-change.
 *
 * Consumer API is unchanged
 *   const { divRef, setVisible } = useWorldLabel({ id, anchorRef, offset });
 *   ...
 *   <WorldLabel divRef={divRef} pointerEvents="auto">
 *     <span>{npc.name}</span>
 *   </WorldLabel>
 *
 *   `divRef.current` is set by LabelView once it mounts in the overlay tree.
 *   The projection useFrame reads `divRef.current` to write transform/display.
 */

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useThree } from '@react-three/fiber';
import { useSceneActive, useSceneFrame, useSceneId } from '@/components/three/world-stage/use-scene-frame';
import * as THREE from 'three';
import { measureSpike } from '@/lib/perf-tracker';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { jumpState } from '@/lib/three/jump-state';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// S4 — the local player avatar acts as an analytic-sphere label occluder so an
// NPC label BEHIND the player no longer draws over the player's body. Buildings
// are mesh occluders (userData.isOccluder); avatars are not in that set, which is
// the whole bug. Coarse 2 Hz boolean — fixed torso sphere, no skinned-mesh raycast.
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
/** Body silhouette radius (wu) — covers a humanoid (ENTITY_HALF=50) + margin. */
const LOCAL_AVATAR_OCCLUDER_RADIUS = 80;
/** Torso height above the sand floor (-2) — avatar height ~270, so ~half. */
const LOCAL_AVATAR_OCCLUDER_TORSO_Y = 135;

// ---------------------------------------------------------------------------
// Registry — single source of truth for all labels
// ---------------------------------------------------------------------------

interface LabelEntry {
  id: string;
  anchorRef: RefObject<THREE.Object3D | null>;
  offset: [number, number, number];
  visible: boolean;
  content: ReactNode;
  contentSignature: string;
  className: string | undefined;
  pointerEvents: 'none' | 'auto';
  /** Public ref the consumer holds; LabelView writes its real DOM node here. */
  divRef: RefObject<HTMLDivElement | null>;
  /** Track previous DOM state to skip redundant writes from the projection useFrame. */
  _prevDisplay: string;
  _prevX: number;
  _prevY: number;
  // ---------------------------------------------------------------------------
  // Distance fade — opacity blends from 1 at fadeNear to 0 at fadeFar.
  // 0/Infinity disables fade (always-full or always-visible).
  // ---------------------------------------------------------------------------
  /** World-unit distance at which label reaches full opacity. 0 = immediate. */
  fadeNear: number;
  /** World-unit distance at which label is fully faded out. Infinity = no fade. */
  fadeFar: number;
  /** Base opacity at/within fadeNear (0–1). Buildings: 0.40, NPCs: 0.65. */
  fadeBaseOpacity: number;
  _prevOpacity: number;
  // ---------------------------------------------------------------------------
  // Occlusion raycast — skip for building labels (occlude: false).
  // ---------------------------------------------------------------------------
  /** Whether to run low-rate occluder raycasts against building meshes. */
  occlude: boolean;
  /** S4 — skip the local-player analytic-sphere occluder for this label (set
   *  on the possessed-player "You" label + self speech bubble so the player's
   *  own body never hides its own label). */
  skipLocalAvatarOcclusion: boolean;
  /** Frame-stagger phase (0–29) — used ONLY by the distant-label mid-rate
   *  projection stagger (LABEL_MID_DISTANCE_FRAME_MOD). Occlusion checks are
   *  scheduled by the module-scope round-robin cursor instead (see
   *  _occludeList / _occludeCursor) so at most one label's occlusion state
   *  refreshes per frame. */
  occludePhase: number;
  /** Cached occlude result — updated at 2Hz, read every frame. */
  _occludeResult: boolean;
  /** Whether the projection pass currently keeps this label displayed. */
  _active: boolean;
  /** Stage scene slot this label belongs to (null on legacy canvases).
   *  Captured from SceneIdContext at registration. Under the persistent stage
   *  BOTH the world host and the cove host are mounted simultaneously against
   *  ONE module registry — each host renders/projects ONLY its own scene's
   *  entries, otherwise world labels bleed into the cove overlay (P1b review
   *  finding 2026-07-26). */
  sceneId: string | null;
}

const _registry = new Map<string, LabelEntry>();

/** Reverse lookup so <WorldLabel divRef={...}> can find its entry in O(1). */
const _refToId = new WeakMap<RefObject<HTMLDivElement | null>, string>();
let _labelRenderWindowStart = 0;
let _labelRenderCount = 0;
let _labelRenderRate = 0;
let _overlayActive = false;

const LABEL_HARD_CULL_FAR = 6500;
const LABEL_FULL_RATE_FAR = 3500;
const LABEL_MID_DISTANCE_FRAME_MOD = 3;
const LABEL_NDC_MARGIN = 1.15;

function _recordLabelRender(): void {
  if (typeof performance === 'undefined') return;
  const now = performance.now();
  if (_labelRenderWindowStart === 0) _labelRenderWindowStart = now;
  _labelRenderCount++;
  const elapsed = now - _labelRenderWindowStart;
  if (elapsed >= 1000) {
    _labelRenderRate = (_labelRenderCount * 1000) / elapsed;
    _labelRenderCount = 0;
    _labelRenderWindowStart = now;
  }
}

export function getWorldLabelPerfStats(): { labelCount: number; reactRendersPerSec: number } {
  if (typeof performance !== 'undefined' && _labelRenderWindowStart > 0) {
    const elapsed = performance.now() - _labelRenderWindowStart;
    if (elapsed >= 1000) {
      _labelRenderRate = _labelRenderCount > 0 ? (_labelRenderCount * 1000) / elapsed : 0;
      _labelRenderCount = 0;
      _labelRenderWindowStart = performance.now();
    }
  }
  const activeLabelCount = _overlayActive
    ? Array.from(_registry.values()).filter((entry) => entry._active).length
    : 0;
  return {
    labelCount: activeLabelCount,
    reactRendersPerSec: _overlayActive ? Math.round(_labelRenderRate * 10) / 10 : 0,
  };
}

function _styleSignature(style: unknown): string {
  if (!style || typeof style !== 'object') return '';
  const record = style as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}:${String(record[key])}`)
    .join(';');
}

function _contentSignature(node: ReactNode, depth = 0): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    return node.map((child) => _contentSignature(child, depth + 1)).join('|');
  }
  if (isValidElement(node)) {
    const typeName = typeof node.type === 'string'
      ? node.type
      : ((node.type as { displayName?: string; name?: string }).displayName
        ?? (node.type as { name?: string }).name
        ?? 'component');
    const props = node.props as {
      children?: ReactNode;
      className?: string;
      style?: unknown;
      ['data-bio-capsule']?: unknown;
    };
    const children = depth > 12
      ? ''
      : Children.toArray(props.children).map((child) => _contentSignature(child, depth + 1)).join('|');
    return [
      typeName,
      props.className ?? '',
      props['data-bio-capsule'] != null ? 'bio' : '',
      _styleSignature(props.style),
      children,
    ].join(':');
  }
  return typeof node;
}

function _hideEntry(entry: LabelEntry, div: HTMLDivElement): void {
  entry._active = false;
  if (entry._prevDisplay !== 'none') {
    div.style.display = 'none';
    entry._prevDisplay = 'none';
  }
}

// ---------------------------------------------------------------------------
// Subscribers + microtask-coalesced notify
// ---------------------------------------------------------------------------

const _subscribers = new Set<() => void>();
let _scheduledNotify = false;
/**
 * The snapshot is the array of entries in registry order. We re-build it on
 * every notify so React's `useSyncExternalStore` sees a new reference and
 * re-renders. Since LabelsHost iterates the array via .map() with stable
 * `key={entry.id}`, React's diff per child is cheap when individual entries
 * don't actually change.
 */
let _snapshot: ReadonlyArray<LabelEntry> = [];

function _rebuildSnapshot() {
  _snapshot = Array.from(_registry.values());
}

function _scheduleNotify() {
  if (_scheduledNotify) return;
  _scheduledNotify = true;
  queueMicrotask(() => {
    _scheduledNotify = false;
    _rebuildSnapshot();
    _subscribers.forEach((fn) => fn());
  });
}

function _subscribe(cb: () => void) {
  _subscribers.add(cb);
  return () => {
    _subscribers.delete(cb);
  };
}

function _getSnapshot(): ReadonlyArray<LabelEntry> {
  return _snapshot;
}

// ---------------------------------------------------------------------------
// Module-scope scratch (zero per-frame allocations)
// ---------------------------------------------------------------------------

const _scratchPos = new THREE.Vector3();
const _scratchOffset = new THREE.Vector3();
/** View-space copy for the behind-camera cull — see the reversed-depth note at the project() call. */
const _scratchView = new THREE.Vector3();
// Holds the anchor world-position before .project(camera) destroys it — needed
// for distance calculation and occlusion raycast direction.
const _scratchAnchorWorld = new THREE.Vector3();
// S4 — raw anchor (NPC body) world pos BEFORE the label offset. The local-player
// occluder rays to the BODY, not the high label point (a torso sphere misses a
// ray aimed above the head); buildings still occlude against the label point.
const _scratchRawAnchor = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Occlusion raycaster (module-scope — one allocation at module load)
// ---------------------------------------------------------------------------

const _occDir = new THREE.Vector3();
/** S4 — module scratch for the local-player occluder sphere center (no per-call alloc). */
const _avatarOccluderCenter = new THREE.Vector3();
/** Cached world-space AABB per occluder mesh, keyed by mesh.uuid. The world is
 *  static, so an existing entry's box is NEVER recomputed — only meshes not yet
 *  seen get a fresh (one-time) `setFromObject()`. This turns the hot path from
 *  a full-mesh Raycaster.intersectObjects (10–30ms against merged high-poly
 *  building geometry with no BVH, the measured 2026-07-07 uF:labels spike)
 *  into an analytic ray-vs-box slab test (zero allocations, sub-microsecond). */
const _occluderBoxCache = new Map<string, THREE.Box3>();
/** Flat list of boxes matching the currently-mounted occluder mesh set. Rebuilt
 *  every 2 s alongside the scan below; the hot loop reads ONLY this array, never
 *  the cache Map (so removed/hot-swapped meshes can't leave stale hits behind). */
let _occluderBoxes: THREE.Box3[] = [];
/** Timestamp (performance.now()) of the last occluder-list rebuild. 0 = force rebuild on first frame. */
let _occluderRebuildTime = 0;
/** Frame counter incremented in the projection useFrame — drives the distant-
 *  label mid-rate projection stagger (LABEL_MID_DISTANCE_FRAME_MOD). Occlusion
 *  checks no longer use this counter; see _occludeList / _occludeCursor. */
let _occFrameCounter = 0;
/** Three.js scene reference captured in WorldLabelsOverlayMount. */
let _sceneRef: THREE.Scene | null = null;

/** Ordered list of every registered entry with occlude:true. Maintained by
 *  useWorldLabel's register/unregister (push on mount, splice on unmount) so
 *  the round-robin cursor below can advance through it without a scene scan. */
const _occludeList: LabelEntry[] = [];
/** Round-robin cursor into _occludeList — advances exactly one step per frame
 *  so AT MOST ONE label's occlusion state is (re)computed per frame. Wraps at
 *  list length; a full cycle over ≤30 labels still refreshes each at ≥1Hz. */
let _occludeCursor = 0;
/** Ray + scratch hit point for the slab test — module-scope, zero per-check alloc. */
const _occRay = new THREE.Ray();
const _occBoxHit = new THREE.Vector3();

function _refreshOccluderBoxes(scene: THREE.Scene): void {
  const seen = new Set<string>();
  const boxes: THREE.Box3[] = [];
  scene.traverse((obj) => {
    if (!obj.userData.isOccluder) return;
    obj.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      seen.add(mesh.uuid);
      let box = _occluderBoxCache.get(mesh.uuid);
      if (!box) {
        box = new THREE.Box3().setFromObject(mesh);
        _occluderBoxCache.set(mesh.uuid, box);
      }
      boxes.push(box);
    });
  });
  // Prune cache entries for meshes no longer present (unmounted/hot-swapped)
  // so the cache can't grow unbounded across edit-mode swaps.
  for (const uuid of _occluderBoxCache.keys()) {
    if (!seen.has(uuid)) _occluderBoxCache.delete(uuid);
  }
  _occluderBoxes = boxes;
}

/** Analytic ray-vs-AABB slab test against the cached occluder boxes. Zero
 *  allocations: `_occRay`/`_occBoxHit` are module-scope scratch, reused every
 *  call. `maxDist` reproduces the old Raycaster.far cutoff (stop short of the
 *  anchor so an NPC's own building doesn't occlude it). Returns true on the
 *  first box hit whose distance-from-origin is within maxDist.
 *
 *  A box containing the camera OR the label anchor is skipped entirely — it
 *  can never occlude THIS label. Building AABBs are looser than the visual
 *  mesh (roof overhangs, entrance recesses stick outside the silhouette but
 *  are still inside the box), so "inside the box" does not imply "behind a
 *  wall" the way the old FrontSide mesh raycast (which tested actual
 *  triangles, not a bbox) implicitly guaranteed. Without this exclusion:
 *  (1) origin-inside-box makes Ray.intersectBox return the EXIT point
 *  (tmin<0 → resolves at tmax), which can still be <= maxDist — so pushing
 *  the chase camera near/under an overhang would false-occlude every label;
 *  (2) teacher NPCs standing at their own building's entrance sit INSIDE
 *  that building's full-bbox XZ footprint, so the ray can enter the box
 *  100-300wu before the anchor (beyond the 80wu margin) even though the real
 *  geometry is beside/above them — false-occluding their own label in their
 *  default standing pose. `containsPoint` is branch-only, no allocations. */
function _rayHitsAnyBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  anchorWorld: THREE.Vector3,
): boolean {
  _occRay.origin.copy(origin);
  _occRay.direction.copy(dir);
  for (let i = 0; i < _occluderBoxes.length; i++) {
    const box = _occluderBoxes[i];
    if (box.containsPoint(origin) || box.containsPoint(anchorWorld)) continue;
    const hit = _occRay.intersectBox(box, _occBoxHit);
    if (hit !== null && hit.distanceTo(origin) <= maxDist) return true;
  }
  return false;
}

/** Returns true if the camera→LABEL ray is blocked by a building mesh, OR (S4)
 *  the camera→BODY ray is blocked by the local player avatar's coarse occluder
 *  sphere. `labelWorld` = anchor+offset (above the head); `bodyWorld` = raw
 *  anchor (the NPC body the player actually covers). `skipLocalAvatar` is set on
 *  the player's OWN label so its own body never hides it. */
function _checkOcclusion(
  labelWorld: THREE.Vector3,
  bodyWorld: THREE.Vector3,
  cameraPos: THREE.Vector3,
  skipLocalAvatar: boolean,
): boolean {
  if (!_sceneRef) return false;
  // Rebuild every 2 s (wall-clock) so late-mounted buildings are picked up.
  // Initialised to 0 so the very first call always builds the list.
  const now = performance.now();
  if (now - _occluderRebuildTime > 2000) {
    _refreshOccluderBoxes(_sceneRef);
    _occluderRebuildTime = now;
  }
  const labelDist = cameraPos.distanceTo(labelWorld);
  if (labelDist < 10) return false;
  _occDir.subVectors(labelWorld, cameraPos).normalize();
  // Stop 80wu before anchor to avoid catching the building in front of which
  // an NPC is standing (teacher NPCs at building entrances).
  const maxDist = Math.max(0, labelDist - 80);
  if (_rayHitsAnyBox(cameraPos, _occDir, maxDist, labelWorld)) return true;

  // --- S4: local player avatar as an analytic-sphere occluder ---
  // Tests the camera→BODY ray (NOT the high label point — a torso sphere misses
  // a ray aimed above the head). Only when a controllable local avatar is
  // actually rendered (explore mode has none, but avatarPositionRef carries a
  // stale value). Pure scalar math — no alloc, no raycast.
  if (skipLocalAvatar) return false;
  const mode = useGameStore.getState().controlMode;
  if (mode !== 'player' && mode !== 'autonomous' && mode !== 'npc') return false;

  const bodyDx = bodyWorld.x - cameraPos.x;
  const bodyDy = bodyWorld.y - cameraPos.y;
  const bodyDz = bodyWorld.z - cameraPos.z;
  const bodyDist = Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy + bodyDz * bodyDz);
  if (bodyDist < 10) return false;
  const inv = 1 / bodyDist;
  const dirX = bodyDx * inv, dirY = bodyDy * inv, dirZ = bodyDz * inv;

  _avatarOccluderCenter.set(
    avatarPositionRef.x - HALF_W,
    -2 + LOCAL_AVATAR_OCCLUDER_TORSO_Y + jumpState.heightOffset + jumpState.playerAltitude,
    avatarPositionRef.y - HALF_H,
  );
  const cx = _avatarOccluderCenter.x - cameraPos.x;
  const cy = _avatarOccluderCenter.y - cameraPos.y;
  const cz = _avatarOccluderCenter.z - cameraPos.z;
  // t = projection of (center - camera) onto the unit camera→body ray; clamp to
  // the SEGMENT so a sphere behind the camera or behind the NPC can't occlude.
  const t = cx * dirX + cy * dirY + cz * dirZ;
  const R = LOCAL_AVATAR_OCCLUDER_RADIUS;
  if (t <= R || t >= bodyDist - R) return false;
  const perpSq = (cx * cx + cy * cy + cz * cz) - t * t;
  return perpSq <= R * R;
}

// ---------------------------------------------------------------------------
// Module-scope overlay node (set by WorldLabelsOverlayMount)
// ---------------------------------------------------------------------------

let _overlayNode: HTMLDivElement | null = null;
let _overlayRoot: Root | null = null;

// ---------------------------------------------------------------------------
// LabelsHost — single React tree that renders every label
// ---------------------------------------------------------------------------

function LabelsHost({ hostSceneId }: { hostSceneId: string | null }) {
  const entries = useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);

  return (
    <>
      {entries
        .filter((entry) => (entry.sceneId ?? null) === hostSceneId)
        .map((entry) => (
          <LabelView key={entry.id} entry={entry} />
        ))}
    </>
  );
}

function LabelView({ entry }: { entry: LabelEntry }) {
  _recordLabelRender();
  const localRef = useRef<HTMLDivElement | null>(null);

  // Wire entry.divRef to this DOM node so the projection useFrame can write
  // transform/display imperatively.
  useEffect(() => {
    (entry.divRef as { current: HTMLDivElement | null }).current = localRef.current;
    return () => {
      (entry.divRef as { current: HTMLDivElement | null }).current = null;
    };
  }, [entry]);

  return (
    <div
      ref={localRef}
      className={entry.className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        display: 'none',
        pointerEvents: entry.pointerEvents,
      }}
    >
      {entry.content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorldLabelsOverlayMount — mount once inside <Canvas>
// ---------------------------------------------------------------------------

// Canvas size cache — updated via ResizeObserver instead of polled via
// getBoundingClientRect every frame. The per-frame read was triggering a
// forced reflow (~211ms/s confirmed via Chrome trace) because label divs'
// display:none/block writes invalidate layout, and the read after them
// forces a synchronous recompute.
let _canvasW = 0;
let _canvasH = 0;

export function WorldLabelsOverlayMount() {
  const { gl, camera, scene } = useThree();
  const sceneActive = useSceneActive();
  // Stage slot this host serves (null on legacy canvases). Each host renders
  // and projects ONLY its own scene's labels — under the persistent stage the
  // world host and the cove host coexist against one module registry, and an
  // unfiltered host paints the other scene's labels over its page (P1b review
  // finding 2026-07-26).
  const hostSceneId = useSceneId();
  // Instance-scoped overlay element. The module-level _overlayNode is
  // last-host-wins (kept for legacy metrics); the projection pass and the
  // visibility gate below MUST target THIS host's node or a second host's
  // mount/unmount corrupts the first host's wiring.
  const overlayElRef = useRef<HTMLDivElement | null>(null);

  // Capture scene for the module-scope occluder raycaster.
  useEffect(() => {
    _sceneRef = scene;
    // Force an immediate occluder-box rebuild for the new scene; stale boxes
    // from a prior scene self-prune on that rebuild (see _refreshOccluderBoxes).
    _occluderRebuildTime = 0;
    return () => { _sceneRef = null; };
  }, [scene]);

  // Stage-slot visibility gate: the projection pass FREEZES when this slot is
  // hidden (useSceneFrame stops dispatching), but frozen is not hidden — this
  // host's label DOM keeps painting at its last projected position over the
  // ACTIVE slot's page. Hide this instance's container while its slot is
  // inactive. Legacy canvases have no SceneIdContext → always active.
  useEffect(() => {
    const node = overlayElRef.current;
    if (node) node.style.display = sceneActive ? '' : 'none';
  }, [sceneActive]);

  useEffect(() => {
    const canvas = gl.domElement;
    const container = canvas.parentElement ?? document.body;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-world-labels', hostSceneId ?? '1');
    overlay.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:10';
    container.appendChild(overlay);

    overlayElRef.current = overlay;
    _overlayNode = overlay;
    _overlayActive = true;

    const root = createRoot(overlay);
    _overlayRoot = root;
    _rebuildSnapshot();
    root.render(<LabelsHost hostSceneId={hostSceneId ?? null} />);

    // Initialise + track canvas size without per-frame getBoundingClientRect.
    const rect = canvas.getBoundingClientRect();
    _canvasW = rect.width;
    _canvasH = rect.height;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        _canvasW = cr.width;
        _canvasH = cr.height;
      }
    });
    ro.observe(canvas);

    return () => {
      ro.disconnect();
      const r = root;
      overlayElRef.current = null;
      // Equality-guarded: only clear the module singletons if they still point
      // at THIS instance — a second host (cove) unmounting must never null the
      // first host's (world's) registration.
      if (_overlayRoot === root) _overlayRoot = null;
      if (_overlayNode === overlay) {
        _overlayNode = null;
        _overlayActive = false;
      }
      _labelRenderRate = 0;
      _labelRenderCount = 0;
      // Defer unmount past the parent's commit phase to avoid React's "race
      // calling root.unmount() while reconciling" warning.
      queueMicrotask(() => {
        r?.unmount();
        overlay.remove();
      });
    };
    // gl is stable post-init; hostSceneId is fixed for the host's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single projection pass — uses ResizeObserver-cached canvas size to avoid
  // the forced reflow from getBoundingClientRect after the previous frame's
  // display:none/block writes invalidated layout.
  useSceneFrame(() => {
    measureSpike('uF:labels', () => {
    // Instance-scoped node — never the module singleton, which the other
    // stage host may have replaced. Also self-heal the occluder scene ref:
    // a second host's mount/unmount clobbers the singleton _sceneRef, and
    // this host only runs while ACTIVE, so reasserting here is correct.
    if (!overlayElRef.current) return;
    _sceneRef = scene;

    const W = _canvasW;
    const H = _canvasH;
    if (W <= 0 || H <= 0) return;

    // Refresh the camera's world matrix ONCE before the label pass. R3F runs
    // useFrame subscribers BEFORE gl.render() (where three normally refreshes
    // camera matrices), and earlier subscribers (e.g. the cove entrance camera
    // push) mutate camera.position this same frame. Camera.updateMatrixWorld()
    // also refreshes matrixWorldInverse (three r185 Camera override), so both
    // the view-space behind-camera cull and .project() below read a current
    // inverse (Codex review 2026-07-14; second round removed a redundant
    // manual copy/invert).
    camera.updateMatrixWorld();

    _occFrameCounter++;

    // --- Occlusion round-robin ---
    // Exactly ONE occlude:true label (re)computes its occlusion state this
    // frame; every other label reuses its cached entry._occludeResult below.
    // Replaces the old mod-30-phase stagger, which clustered 2+ raycasts into
    // the same frame whenever two labels' `occludePhase % 30` collided (the
    // measured 22–36ms uF:labels pairs @ ~533ms cadence). A full round-robin
    // cycle over ≤30 labels still refreshes each label at ≥1Hz.
    if (_occludeList.length > 0) {
      if (_occludeCursor >= _occludeList.length) _occludeCursor = 0;
      const occEntry = _occludeList[_occludeCursor];
      _occludeCursor++;
      const occAnchor = occEntry.anchorRef.current;
      if (
        occAnchor &&
        occEntry.visible &&
        (occEntry.sceneId ?? null) === (hostSceneId ?? null)
      ) {
        occAnchor.getWorldPosition(_scratchRawAnchor);
        _scratchAnchorWorld.set(
          _scratchRawAnchor.x + occEntry.offset[0],
          _scratchRawAnchor.y + occEntry.offset[1],
          _scratchRawAnchor.z + occEntry.offset[2],
        );
        occEntry._occludeResult = _checkOcclusion(
          _scratchAnchorWorld,
          _scratchRawAnchor,
          camera.position,
          occEntry.skipLocalAvatarOcclusion,
        );
      }
    }

    _registry.forEach((entry) => {
      // Foreign-scene entries belong to the other stage host's overlay — their
      // divs live in that host's DOM tree; writing to them corrupts it.
      if ((entry.sceneId ?? null) !== (hostSceneId ?? null)) return;
      const div = entry.divRef.current;
      if (!div) return;

      if (!entry.visible) {
        _hideEntry(entry, div);
        return;
      }

      const anchor = entry.anchorRef.current;
      if (!anchor) {
        _hideEntry(entry, div);
        return;
      }

      anchor.getWorldPosition(_scratchPos);
      _scratchRawAnchor.copy(_scratchPos); // NPC body point (pre-offset) for the S4 player occluder
      _scratchOffset.set(entry.offset[0], entry.offset[1], entry.offset[2]);
      _scratchPos.add(_scratchOffset);

      // --- Distance fade ---
      // Compute camera→anchor distance BEFORE project() clobbers _scratchPos.
      // _scratchAnchorWorld holds the world-space anchor for the occlusion ray.
      _scratchAnchorWorld.copy(_scratchPos);
      const distToCamera = camera.position.distanceTo(_scratchAnchorWorld);
      if (distToCamera > LABEL_HARD_CULL_FAR) {
        _hideEntry(entry, div);
        return;
      }

      if (
        distToCamera > LABEL_FULL_RATE_FAR &&
        (_occFrameCounter + entry.occludePhase) % LABEL_MID_DISTANCE_FRAME_MOD !== 0
      ) {
        return;
      }

      // Compute target opacity from distance band.
      let targetOpacity: number;
      if (entry.fadeFar <= 0 || distToCamera >= entry.fadeFar) {
        targetOpacity = 0;
      } else if (distToCamera <= entry.fadeNear) {
        targetOpacity = entry.fadeBaseOpacity;
      } else {
        const t = (distToCamera - entry.fadeNear) / (entry.fadeFar - entry.fadeNear);
        targetOpacity = entry.fadeBaseOpacity * (1 - t);
      }

      // If distance fade already hides the label, skip projection and the
      // expensive occlusion raycast entirely.
      if (targetOpacity < 0.01) {
        _hideEntry(entry, div);
        return;
      }

      // --- Occlusion check ---
      // Only NPC labels (occlude: true) carry a result, refreshed by the
      // round-robin pass above (at most one label/frame) — just read it here.
      if (entry.occlude && entry._occludeResult) {
        targetOpacity = 0;
      }

      // If occlusion made it fully transparent, hide the div entirely.
      if (targetOpacity < 0.01) {
        _hideEntry(entry, div);
        return;
      }

      // Behind-camera cull MUST use view-space z, not projected NDC z. The
      // r185 renderer runs with reversedDepthBuffer (camera.reversedDepth),
      // which inverts NDC z semantics (near→1, far→0) — a behind-camera point
      // projects to z ≈ -0.002, so the old `ndc.z > 1` check never fired and
      // behind-camera labels rendered at mirrored screen coords (2026-07-14
      // staging regression). View-space z ≥ 0 = at/behind the camera plane,
      // true under standard Z, reversed Z, and orthographic projection alike.
      _scratchView.copy(_scratchPos).applyMatrix4(camera.matrixWorldInverse);
      if (_scratchView.z >= 0) {
        _hideEntry(entry, div);
        return;
      }

      _scratchPos.project(camera);

      if (
        _scratchPos.x < -LABEL_NDC_MARGIN ||
        _scratchPos.x > LABEL_NDC_MARGIN ||
        _scratchPos.y < -LABEL_NDC_MARGIN ||
        _scratchPos.y > LABEL_NDC_MARGIN
      ) {
        _hideEntry(entry, div);
        return;
      }

      const cssX = (_scratchPos.x * 0.5 + 0.5) * W;
      const cssY = (1 - (_scratchPos.y * 0.5 + 0.5)) * H;

      if (entry._prevDisplay !== 'block') {
        div.style.display = 'block';
        entry._prevDisplay = 'block';
      }
      entry._active = true;

      if (
        Math.abs(cssX - entry._prevX) >= 0.5 ||
        Math.abs(cssY - entry._prevY) >= 0.5
      ) {
        div.style.transform = `translate3d(${cssX}px,${cssY}px,0) translate(-50%,-50%)`;
        entry._prevX = cssX;
        entry._prevY = cssY;
      }

      if (Math.abs(targetOpacity - entry._prevOpacity) >= 0.01) {
        div.style.opacity = String(targetOpacity.toFixed(2));
        entry._prevOpacity = targetOpacity;
      }
    });
    });
  });

  return null;
}

// ---------------------------------------------------------------------------
// useWorldLabel — consumer hook
//
// Registration happens via the lazy useRef pattern. The entry is created on
// the first render of the consumer, BEFORE any child component (including
// <WorldLabel>) renders. That solves the children-effects-run-first ordering
// problem: by the time WorldLabel.useEffect tries to look up the entry by
// divRef, the entry is already in the registry.
// ---------------------------------------------------------------------------

export interface UseWorldLabelOpts {
  id: string;
  anchorRef: RefObject<THREE.Object3D | null>;
  offset?: [number, number, number];
  /** Initial visibility. Default true. */
  initialVisible?: boolean;
  /**
   * Distance (world units) at which the label reaches full opacity.
   * Labels remain at full opacity below this distance.
   * Default: 0 (always full within fadeFar).
   */
  fadeNear?: number;
  /**
   * Distance (world units) at which the label fades to opacity 0.
   * Default: Infinity (no distance fade).
   */
  fadeFar?: number;
  /**
   * Base opacity at/within fadeNear. Buildings: 0.40, NPCs: 0.65.
   * Default: 1.0 (no dimming at near range).
   */
  fadeBaseOpacity?: number;
  /**
   * If true, runs a low-rate raycast against building occluder meshes.
   * Use for NPC labels. Default: false.
   */
  occlude?: boolean;
  /**
   * S4 — if true, the local-player analytic-sphere occluder is NOT applied to
   * this label. Set on the possessed-player "You" label + self speech bubble so
   * the player's own body can't hide its own label. Default: false.
   */
  skipLocalAvatarOcclusion?: boolean;
}

export interface UseWorldLabelReturn {
  /** The DOM node ref the projection useFrame writes to. Wired by LabelView. */
  divRef: RefObject<HTMLDivElement | null>;
  setVisible: (visible: boolean) => void;
}

export function useWorldLabel({
  id,
  anchorRef,
  offset = [0, 0, 0],
  initialVisible = true,
  fadeNear = 0,
  fadeFar = Infinity,
  fadeBaseOpacity = 1.0,
  occlude = false,
  skipLocalAvatarOcclusion = false,
}: UseWorldLabelOpts): UseWorldLabelReturn {
  // Stable ref the consumer + LabelView share.
  const divRef = useRef<HTMLDivElement | null>(null);
  // Stage slot ownership — read during render (hook), captured into the entry
  // at synchronous registration below. Null outside the stage (legacy canvas).
  const labelSceneId = useSceneId();
  // Tracks whether we've registered our entry. Used to handle React 18 strict
  // mode (mount → unmount → mount) and re-register after cleanup.
  const registeredRef = useRef(false);

  // SYNCHRONOUS REGISTRATION DURING RENDER.
  // Idempotent: only fires when registeredRef is false (first render OR after
  // a strict-mode unmount cleared it). Mutating the registry here is a
  // controlled module-state side-effect, not a render anti-pattern — it's
  // equivalent to React's lazy-ref initialization idiom.
  if (!registeredRef.current) {
    registeredRef.current = true;
    const entry: LabelEntry = {
      id,
      anchorRef,
      offset: [offset[0], offset[1], offset[2]],
      visible: initialVisible,
      content: null,
      contentSignature: '',
      className: undefined,
      pointerEvents: 'none',
      divRef,
      _prevDisplay: '',
      _prevX: -9999,
      _prevY: -9999,
      fadeNear,
      fadeFar,
      fadeBaseOpacity,
      _prevOpacity: -1,
      occlude,
      skipLocalAvatarOcclusion,
      // Stagger phase based on registry size at registration time (0–29).
      occludePhase: _registry.size % 30,
      _occludeResult: false,
      _active: false,
      sceneId: labelSceneId,
    };
    _registry.set(id, entry);
    _refToId.set(divRef, id);
    // occlude is fixed for the entry's lifetime (not synced like offset below),
    // so it's safe to add to _occludeList once here and remove once on cleanup.
    if (entry.occlude) _occludeList.push(entry);
    _scheduleNotify();
  }

  // Cleanup on unmount; reset registeredRef so a strict-mode remount re-registers.
  useEffect(() => {
    return () => {
      const existing = _registry.get(id);
      if (existing) {
        const idx = _occludeList.indexOf(existing);
        if (idx !== -1) _occludeList.splice(idx, 1);
      }
      _registry.delete(id);
      _refToId.delete(divRef);
      registeredRef.current = false;
      _scheduleNotify();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Sync offset if it changes (rare).
  useEffect(() => {
    const entry = _registry.get(id);
    if (entry) {
      entry.offset[0] = offset[0];
      entry.offset[1] = offset[1];
      entry.offset[2] = offset[2];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, offset[0], offset[1], offset[2]]);

  // Stable setVisible — closes over `id`, mutates the entry directly. No
  // re-render needed; the projection useFrame reads entry.visible each frame.
  const setVisible = useMemo(
    () =>
      (visible: boolean) => {
        const e = _registry.get(id);
        if (e) e.visible = visible;
      },
    [id],
  );

  return { divRef, setVisible };
}

// ---------------------------------------------------------------------------
// resetLabelPrevOpacity — forces the projection useFrame to re-write opacity
// on the very next frame after an external caller (e.g. onMouseLeave) has
// cleared or overridden the div's style.opacity without going through
// entry._prevOpacity. Without this, the "|targetOpacity - _prevOpacity| < 0.01"
// skip-guard keeps the stale hover opacity alive until the camera moves enough
// to change targetOpacity by ≥0.01.
// ---------------------------------------------------------------------------

export function resetLabelPrevOpacity(divRef: RefObject<HTMLDivElement | null>): void {
  const id = _refToId.get(divRef);
  if (!id) return;
  const entry = _registry.get(id);
  if (entry) entry._prevOpacity = -1;
}

// ---------------------------------------------------------------------------
// WorldLabel — declarative content updater
//
// Reports children/className/pointerEvents to the registry entry. Does NOT
// render any DOM itself — the host root renders all labels in a single tree.
// ---------------------------------------------------------------------------

export interface WorldLabelProps {
  divRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
  pointerEvents?: 'none' | 'auto';
}

export function WorldLabel({
  divRef,
  className,
  children,
  pointerEvents = 'none',
}: WorldLabelProps) {
  // No deps array — runs after every render. Cheap: a WeakMap lookup, three
  // identity checks, and (only if anything changed) a microtask schedule.
  // The actual reconciliation is batched into a single LabelsHost re-render.
  useEffect(() => {
    const id = _refToId.get(divRef);
    if (!id) return;
    const entry = _registry.get(id);
    if (!entry) return;

    let dirty = false;
    const contentSignature = _contentSignature(children);
    if (entry.contentSignature !== contentSignature) {
      entry.content = children;
      entry.contentSignature = contentSignature;
      dirty = true;
    }
    if (entry.className !== className) {
      entry.className = className;
      dirty = true;
    }
    if (entry.pointerEvents !== pointerEvents) {
      entry.pointerEvents = pointerEvents;
      dirty = true;
    }
    if (dirty) _scheduleNotify();
  });

  return null;
}
