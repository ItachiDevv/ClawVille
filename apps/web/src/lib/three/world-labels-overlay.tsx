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

export function WorldLabelsOverlayMount() {
  const { gl, camera } = useThree();

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

    return () => {
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

  // Single projection pass — one read of canvas rect, one write per visible label.
  useFrame(() => {
    measureSpike('uF:labels', () => {
    if (!_overlayNode) return;

    const rect = gl.domElement.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W <= 0 || H <= 0) return;

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
