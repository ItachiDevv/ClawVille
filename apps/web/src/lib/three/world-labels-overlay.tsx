'use client';

/**
 * WorldLabelsOverlay
 *
 * Single DOM overlay component mounted once at the Canvas root.
 * Replaces 30+ per-NPC/per-building drei <Html> portals with one rAF
 * projection pass and one batched DOM write per label per frame.
 *
 * Architecture:
 *   - One <div> overlay (absolute, pointer-events: none, inset: 0, overflow: hidden).
 *   - Module-scope registry: Map<string, LabelEntry> tracks every registered label.
 *   - Single useFrame: projects each anchor's world position to screen, updates
 *     each label's transform in one pass with zero per-frame allocations.
 *   - Consumers call useWorldLabel() hook to register an entry, render content
 *     via <WorldLabel>, and get back a divRef + setVisible.
 *
 * Perf rules (non-negotiable):
 *   - ZERO per-frame allocations: all scratch Vector3 at module scope.
 *   - Canvas DOMRect read once per frame (not per label).
 *   - transform only written when NDC moved ≥ 0.5 px.
 *   - display only written when it changes.
 */

import {
  useRef,
  useEffect,
  useState,
  useMemo,
  type RefObject,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LabelEntry {
  id: string;
  anchorRef: RefObject<THREE.Object3D | null>;
  offset: [number, number, number];
  visible: boolean;
  divRef: RefObject<HTMLDivElement | null>;
  /** Previous state — avoid redundant DOM writes. */
  _prevDisplay: string;
  _prevX: number;
  _prevY: number;
}

// ---------------------------------------------------------------------------
// Module-scope registry — mutated in place, never replaced
// ---------------------------------------------------------------------------
const _registry = new Map<string, LabelEntry>();

// Module-scope scratch — ZERO allocations per frame.
const _scratchPos = new THREE.Vector3();
const _scratchOffset = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Module-scope overlay node reference.
// Set by WorldLabelsOverlayMount on mount, cleared on unmount.
// WorldLabel reads this synchronously — safe because:
//   1. WorldLabelsOverlayMount mounts early in SceneContents (before consumers).
//   2. Consumer components mount in the same commit cycle or later.
//   3. React commit order is parent → child, SceneContents renders children after itself.
// On the first frame consumers may see null and render nothing; the next render
// (triggered by the overlay-ready state below) shows labels.
// ---------------------------------------------------------------------------
let _overlayNode: HTMLDivElement | null = null;
const _overlayReadyListeners = new Set<() => void>();

function setOverlayNode(node: HTMLDivElement | null) {
  _overlayNode = node;
  if (node) {
    _overlayReadyListeners.forEach((fn) => fn());
    _overlayReadyListeners.clear();
  }
}

// ---------------------------------------------------------------------------
// WorldLabelsOverlayMount — mount once inside Canvas (SceneContents)
// ---------------------------------------------------------------------------

/**
 * Mount exactly once inside `<Canvas>`.
 * Creates the DOM overlay container and runs the single projection pass each frame.
 * Add `<WorldLabelsOverlayMount />` to SceneContents in World3DCanvas.tsx.
 */
export function WorldLabelsOverlayMount() {
  const { gl, camera } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    // Append to canvas parent so it sits in the same stacking context as the canvas.
    const container = canvas.parentElement ?? document.body;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-world-labels', '1');
    overlay.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:10';
    container.appendChild(overlay);
    setOverlayNode(overlay);

    return () => {
      overlay.remove();
      setOverlayNode(null);
    };
  // gl is stable after init — intentional omission
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single projection pass — one read of canvas rect, one write per label.
  useFrame(() => {
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

      // World position = anchor.worldPos + offset
      anchor.getWorldPosition(_scratchPos);
      _scratchOffset.set(entry.offset[0], entry.offset[1], entry.offset[2]);
      _scratchPos.add(_scratchOffset);

      // Project to NDC [-1, 1]
      _scratchPos.project(camera);

      // NDC z > 1 = behind camera clipping plane → hide
      if (_scratchPos.z > 1) {
        if (entry._prevDisplay !== 'none') {
          div.style.display = 'none';
          entry._prevDisplay = 'none';
        }
        return;
      }

      // NDC → CSS pixel (center-anchored; WorldLabel applies translate(-50%,-50%))
      const cssX = (_scratchPos.x * 0.5 + 0.5) * W;
      const cssY = (1 - (_scratchPos.y * 0.5 + 0.5)) * H;

      // Only write display when it changes
      if (entry._prevDisplay !== 'block') {
        div.style.display = 'block';
        entry._prevDisplay = 'block';
      }

      // Only write transform when moved ≥ 0.5 px (avoids constant layout invalidation)
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

  return null;
}

// ---------------------------------------------------------------------------
// useWorldLabel — consumer hook
// ---------------------------------------------------------------------------

export interface UseWorldLabelOpts {
  id: string;
  anchorRef: RefObject<THREE.Object3D | null>;
  offset?: [number, number, number];
  zIndex?: number;
  /**
   * Initial visibility state. Defaults to true.
   * Set false for labels that use imperative setVisible() to control display
   * (wandering NPC labels, speech bubbles). Set true for labels that are always
   * visible (location NPC names, building labels).
   */
  initialVisible?: boolean;
}

export interface UseWorldLabelReturn {
  divRef: RefObject<HTMLDivElement | null>;
  setVisible: (visible: boolean) => void;
}

/**
 * Register a label in the overlay registry.
 * Returns a stable divRef (attach to the label root div) and setVisible.
 *
 * Mount: registers entry. Unmount: deregisters and removes DOM node.
 */
export function useWorldLabel({
  id,
  anchorRef,
  offset = [0, 0, 0],
  initialVisible = true,
}: UseWorldLabelOpts): UseWorldLabelReturn {
  const divRef = useRef<HTMLDivElement | null>(null);

  // Stable setVisible — reads/writes registry entry directly.
  const setVisible = useMemo(
    () => (visible: boolean) => {
      const entry = _registry.get(id);
      if (entry) entry.visible = visible;
    },
    [id],
  );

  // Register on mount, deregister on unmount.
  useEffect(() => {
    const entry: LabelEntry = {
      id,
      anchorRef,
      offset: [offset[0], offset[1], offset[2]],
      visible: initialVisible,
      divRef,
      _prevDisplay: '',
      _prevX: -9999,
      _prevY: -9999,
    };
    _registry.set(id, entry);

    return () => {
      _registry.delete(id);
      // Detach DOM node from overlay if it was portaled there.
      const div = divRef.current;
      if (div && div.parentElement) {
        div.parentElement.removeChild(div);
      }
    };
  // id is the stable key; anchorRef and initialVisible intentionally not in deps
  // (they don't change after mount and including them causes spurious re-registers).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Sync offset when it changes (rare — only if parent component changes offset prop)
  useEffect(() => {
    const entry = _registry.get(id);
    if (entry) {
      entry.offset[0] = offset[0];
      entry.offset[1] = offset[1];
      entry.offset[2] = offset[2];
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, offset[0], offset[1], offset[2]]);

  return { divRef, setVisible };
}

// ---------------------------------------------------------------------------
// WorldLabel — portals label content into the overlay container
// ---------------------------------------------------------------------------

export interface WorldLabelProps {
  divRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
  /**
   * Pointer events on the label container div.
   * Default 'none' — overlay is transparent to mouse events.
   * Set 'auto' for interactive labels (building click targets).
   */
  pointerEvents?: 'none' | 'auto';
}

/**
 * Renders label content into the overlay DOM container via a separate
 * react-dom root.
 *
 * IMPORTANT: this component is invoked from inside the R3F-reconciled
 * Canvas subtree. We CANNOT return `<div>` JSX (or `createPortal(<div/>)`
 * from `react-dom`) — R3F's reconciler walks portal children too and will
 * throw "Div is not part of the THREE namespace". Instead we mount our own
 * `react-dom/client` root inside the overlay div and render the label
 * children there, the same trick drei's `<Html>` uses. The component
 * itself returns null, so R3F has nothing to reconcile.
 */
export function WorldLabel({
  divRef,
  className,
  children,
  pointerEvents = 'none',
}: WorldLabelProps) {
  // Subscribe to overlay-ready so this component re-runs the mount effect
  // once the overlay node is created.
  const overlayReady = useOverlayReady();
  const rootRef = useRef<Root | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Mount: create the per-label container div, attach to the overlay,
  // wire divRef so the projection useFrame can write transform/display,
  // then spin up a fresh react-dom root and render the children there.
  useEffect(() => {
    if (!overlayReady || !_overlayNode) return;

    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.top = '0';
    div.style.left = '0';
    div.style.display = 'none';
    div.style.pointerEvents = pointerEvents;
    if (className) div.className = className;
    _overlayNode.appendChild(div);
    containerRef.current = div;

    // Expose the real DOM node to the projection registry. divRef is the
    // ref returned from useWorldLabel(); the projection useFrame in
    // WorldLabelsOverlayMount writes div.style.{display,transform} on it.
    (divRef as { current: HTMLDivElement | null }).current = div;

    const root = createRoot(div);
    rootRef.current = root;
    root.render(<>{children}</>);

    return () => {
      const r = rootRef.current;
      const c = containerRef.current;
      rootRef.current = null;
      containerRef.current = null;
      (divRef as { current: HTMLDivElement | null }).current = null;
      // Defer unmount — calling Root.unmount() during the parent's commit
      // phase logs a React warning. queueMicrotask runs after commit.
      queueMicrotask(() => {
        r?.unmount();
        c?.remove();
      });
    };
    // children/className/pointerEvents are handled by the second effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayReady]);

  // Re-render content + sync className/pointerEvents when they change.
  useEffect(() => {
    const div = containerRef.current;
    if (div) {
      div.style.pointerEvents = pointerEvents;
      div.className = className ?? '';
    }
    rootRef.current?.render(<>{children}</>);
  }, [children, className, pointerEvents]);

  return null;
}

// ---------------------------------------------------------------------------
// useOverlayReady — triggers a re-render when the overlay DOM node is ready.
// ---------------------------------------------------------------------------

/** Returns true once the overlay DOM node has been created. */
function useOverlayReady(): boolean {
  const [ready, setReady] = useState(() => _overlayNode !== null);

  useEffect(() => {
    if (_overlayNode !== null) {
      setReady(true);
      return;
    }
    // Not ready yet — subscribe to the ready event.
    const handler = () => setReady(true);
    _overlayReadyListeners.add(handler);
    return () => {
      _overlayReadyListeners.delete(handler);
    };
  }, []);

  return ready;
}
