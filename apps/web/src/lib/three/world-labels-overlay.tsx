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
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { measureSpike } from '@/lib/perf-tracker';

// ---------------------------------------------------------------------------
// Registry — single source of truth for all labels
// ---------------------------------------------------------------------------

interface LabelEntry {
  id: string;
  anchorRef: RefObject<THREE.Object3D | null>;
  offset: [number, number, number];
  visible: boolean;
  content: ReactNode;
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
  /** Frame-stagger phase (0–29) so not all labels raycast in the same frame. */
  occludePhase: number;
  /** Cached occlude result — updated at 2Hz, read every frame. */
  _occludeResult: boolean;
}

const _registry = new Map<string, LabelEntry>();

/** Reverse lookup so <WorldLabel divRef={...}> can find its entry in O(1). */
const _refToId = new WeakMap<RefObject<HTMLDivElement | null>, string>();

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
// Holds the anchor world-position before .project(camera) destroys it — needed
// for distance calculation and occlusion raycast direction.
const _scratchAnchorWorld = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Occlusion raycaster (module-scope — one allocation at module load)
// ---------------------------------------------------------------------------

const _occRaycaster = new THREE.Raycaster();
const _occDir = new THREE.Vector3();
const _occHits: THREE.Intersection[] = [];
/** Lazily built from userData.isOccluder meshes; rebuilt every 2 s (wall-clock)
 *  so late-mounted buildings and hot-swaps in edit mode are picked up regardless
 *  of framerate. Frame-counter cadence (300 frames) caused a 10 s stale window
 *  at 30 fps (Iris Xe), letting the empty-on-first-frame cache persist forever. */
let _occluderMeshes: THREE.Mesh[] | null = null;
/** Timestamp (performance.now()) of the last occluder-list rebuild. 0 = force rebuild on first frame. */
let _occluderRebuildTime = 0;
/** Frame counter incremented in the projection useFrame for 2Hz stagger. */
let _occFrameCounter = 0;
/** Three.js scene reference captured in WorldLabelsOverlayMount. */
let _sceneRef: THREE.Scene | null = null;

function _buildOccluderList(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (!obj.userData.isOccluder) return;
    obj.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
  });
  return meshes;
}

/** Returns true if the camera→anchor ray is blocked by a building mesh. */
function _checkOcclusion(anchorWorld: THREE.Vector3, cameraPos: THREE.Vector3): boolean {
  if (!_sceneRef) return false;
  // Rebuild every 2 s (wall-clock) so late-mounted buildings are picked up.
  // Initialised to 0 so the very first call always builds the list.
  const now = performance.now();
  if (!_occluderMeshes || now - _occluderRebuildTime > 2000) {
    _occluderMeshes = _buildOccluderList(_sceneRef);
    _occluderRebuildTime = now;
  }
  const anchorDist = cameraPos.distanceTo(anchorWorld);
  if (anchorDist < 10) return false;
  _occDir.subVectors(anchorWorld, cameraPos).normalize();
  _occRaycaster.set(cameraPos, _occDir);
  // Stop 80wu before anchor to avoid catching the building in front of which
  // an NPC is standing (teacher NPCs at building entrances).
  _occRaycaster.far = Math.max(0, anchorDist - 80);
  _occHits.length = 0;
  _occRaycaster.intersectObjects(_occluderMeshes, false, _occHits);
  return _occHits.length > 0;
}

// ---------------------------------------------------------------------------
// Module-scope overlay node (set by WorldLabelsOverlayMount)
// ---------------------------------------------------------------------------

let _overlayNode: HTMLDivElement | null = null;
let _overlayRoot: Root | null = null;

// ---------------------------------------------------------------------------
// LabelsHost — single React tree that renders every label
// ---------------------------------------------------------------------------

function LabelsHost() {
  const entries = useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);

  return (
    <>
      {entries.map((entry) => (
        <LabelView key={entry.id} entry={entry} />
      ))}
    </>
  );
}

function LabelView({ entry }: { entry: LabelEntry }) {
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

  // Capture scene for the module-scope occluder raycaster.
  useEffect(() => {
    _sceneRef = scene;
    // Invalidate cached occluder list when scene changes; 0 forces rebuild on next frame.
    _occluderMeshes = null;
    _occluderRebuildTime = 0;
    return () => { _sceneRef = null; };
  }, [scene]);

  useEffect(() => {
    const canvas = gl.domElement;
    const container = canvas.parentElement ?? document.body;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-world-labels', '1');
    overlay.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:10';
    container.appendChild(overlay);

    _overlayNode = overlay;

    const root = createRoot(overlay);
    _overlayRoot = root;
    _rebuildSnapshot();
    root.render(<LabelsHost />);

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
      const r = _overlayRoot;
      _overlayRoot = null;
      _overlayNode = null;
      // Defer unmount past the parent's commit phase to avoid React's "race
      // calling root.unmount() while reconciling" warning.
      queueMicrotask(() => {
        r?.unmount();
        overlay.remove();
      });
    };
    // gl is stable post-init.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single projection pass — uses ResizeObserver-cached canvas size to avoid
  // the forced reflow from getBoundingClientRect after the previous frame's
  // display:none/block writes invalidated layout.
  useFrame(() => {
    measureSpike('uF:labels', () => {
    if (!_overlayNode) return;

    const W = _canvasW;
    const H = _canvasH;
    if (W <= 0 || H <= 0) return;

    _occFrameCounter++;

    _registry.forEach((entry) => {
      const div = entry.divRef.current;
      if (!div) return;

      if (!entry.visible) {
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      const anchor = entry.anchorRef.current;
      if (!anchor) {
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      anchor.getWorldPosition(_scratchPos);
      _scratchOffset.set(entry.offset[0], entry.offset[1], entry.offset[2]);
      _scratchPos.add(_scratchOffset);

      // --- Distance fade ---
      // Compute camera→anchor distance BEFORE project() clobbers _scratchPos.
      // _scratchAnchorWorld holds the world-space anchor for the occlusion ray.
      _scratchAnchorWorld.copy(_scratchPos);
      const distToCamera = camera.position.distanceTo(_scratchAnchorWorld);

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
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      // --- Occlusion check (2Hz stagger) ---
      // Only runs for NPC labels (occlude: true). Skip building labels.
      if (entry.occlude) {
        if ((_occFrameCounter + entry.occludePhase) % 30 === 0) {
          entry._occludeResult = _checkOcclusion(_scratchAnchorWorld, camera.position);
        }
        if (entry._occludeResult) {
          targetOpacity = 0;
        }
      }

      // If occlusion made it fully transparent, hide the div entirely.
      if (targetOpacity < 0.01) {
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      _scratchPos.project(camera);

      // NDC z > 1 → behind near plane → hide.
      if (_scratchPos.z > 1) {
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      const cssX = (_scratchPos.x * 0.5 + 0.5) * W;
      const cssY = (1 - (_scratchPos.y * 0.5 + 0.5)) * H;

      if (entry._prevDisplay !== 'block') {
        div.style.display = 'block';
        entry._prevDisplay = 'block';
      }

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
}: UseWorldLabelOpts): UseWorldLabelReturn {
  // Stable ref the consumer + LabelView share.
  const divRef = useRef<HTMLDivElement | null>(null);
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
      // Stagger phase based on registry size at registration time (0–29).
      occludePhase: _registry.size % 30,
      _occludeResult: false,
    };
    _registry.set(id, entry);
    _refToId.set(divRef, id);
    _scheduleNotify();
  }

  // Cleanup on unmount; reset registeredRef so a strict-mode remount re-registers.
  useEffect(() => {
    return () => {
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
    if (entry.content !== children) {
      entry.content = children;
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
