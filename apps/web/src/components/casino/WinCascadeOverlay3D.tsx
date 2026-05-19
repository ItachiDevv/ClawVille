'use client';

/**
 * WinCascadeOverlay3D — R3F win-highlight cascade for the 3D reel rig.
 *
 * Fires after impl-1's SlotReels3D emits `onStopComplete`. Renders:
 *   - Per winning cell: additive-blend glow plane + thin ring, staggered
 *     200ms apart (reel order, left→right).
 *   - Per wild-multiplier cell: brighter glow + the multiplier value as a
 *     DOM label positioned via camera projection (NOT drei Text/Billboard —
 *     Iris Xe safe).
 *
 * Coordinate system (props):
 *   The origin point is the centre of reel 0, row 0 (top-left cell).
 *   `reelSpacingX` is the world-unit pitch between adjacent reels (X axis).
 *   `rowSpacingY` is the world-unit pitch between adjacent rows (Y axis, +Y down).
 *   These default to impl-1's cylinder constants and can be overridden.
 *
 * Iris Xe invariants:
 *   - No drei Text / Billboard anywhere.
 *   - No per-frame `new Vector3()` — module-scope scratch only.
 *   - All geometry + materials allocated at module scope (once).
 *   - MeshBasicMaterial only (no ShaderMaterial).
 *   - depthWrite false, AdditiveBlending for glow planes.
 *
 * Lifecycle:
 *   - `active` false → nothing renders, no timers.
 *   - `active` true → cascade starts (stagger 200ms/cell in reel order).
 *   - `onCascadeComplete` fires after last cell + 800ms hold.
 *   - On `active` false (parent closes modal), any running timers are cleared.
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WildMultiplier } from '@/lib/casino/types';

// ---------------------------------------------------------------------------
// Module-scope geometry + materials — built once, never re-allocated.
// ---------------------------------------------------------------------------

/** Glow plane: 80wu × 80wu quad, matches a 1-cell footprint at default spacing. */
const GLOW_PLANE_GEO = new THREE.PlaneGeometry(80, 80);

/** Ring: thin torus in the XY plane, matches cell footprint. */
const RING_GEO = new THREE.TorusGeometry(38, 2.5, 6, 32);

/** Standard cell glow — additive blend, gold. */
const GLOW_MAT = new THREE.MeshBasicMaterial({
  color: 0xffcc44,
  transparent: true,
  opacity: 0.55,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Wild cell glow — brighter magenta additive glow. */
const GLOW_WILD_MAT = new THREE.MeshBasicMaterial({
  color: 0xff44cc,
  transparent: true,
  opacity: 0.75,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Ring outline — thin gold ring, additive. */
const RING_MAT = new THREE.MeshBasicMaterial({
  color: 0xffdd88,
  transparent: true,
  opacity: 0.90,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

/** Ring outline for wild cells — magenta. */
const RING_WILD_MAT = new THREE.MeshBasicMaterial({
  color: 0xff88ff,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// Module-scope scratch vector — never allocated inside useFrame.
const _scratchVec = new THREE.Vector3();
const _scratchNDC = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WinCell {
  /** 0..4 — reel index (left to right). */
  reel: number;
  /** 0..2 — row index (top to bottom). */
  row: number;
}

export interface WinCascadeOverlay3DProps {
  /**
   * Winning cells to highlight — derived from SpinResult.winningLines.
   * Deduplicated by caller (same cell can appear on multiple paylines;
   * render it once).
   */
  winningCells: WinCell[];

  /**
   * Wild multiplier cells from SpinResult.wildMultipliers.
   * Cells with a wild multiplier get a brighter glow + DOM label.
   */
  wildMultipliers?: WildMultiplier[];

  /**
   * Flip true to trigger the cascade. Set to false when the slot screen
   * closes to cancel any in-flight timers.
   */
  active: boolean;

  /** Called when the last cascade cell's glow fades out. */
  onCascadeComplete?: () => void;

  // ── Coordinate system — impl-1 fills these in; sane defaults for 5×3 grid ──

  /**
   * World-space position of the centre of reel 0, row 0 (top-left cell).
   * Defaults to [0, 0, 0] — impl-1 overrides with its cylinder rig origin.
   */
  originX?: number;
  originY?: number;
  originZ?: number;

  /**
   * World-unit pitch between adjacent reels (X axis, positive = right).
   * Default: 90wu — matches a nominal 5-reel rig at ~450wu total width.
   */
  reelSpacingX?: number;

  /**
   * World-unit pitch between adjacent rows (Y axis, positive = down = -Y in
   * Three.js). Default: 90wu.
   */
  rowSpacingY?: number;

  /**
   * Normal direction the glow plane faces. Default: +Z (facing the camera in
   * a front-facing rig). Impl-1 may pass [0,0,1] or [0,0,-1] depending on
   * cylinder orientation.
   */
  glowNormalZ?: number;

  /**
   * Bounding rect of the R3F canvas element, used to offset projected pixel
   * coordinates for wild multiplier DOM labels. Pass
   * `gl.domElement.getBoundingClientRect()` from the parent component.
   * If null, wild labels are suppressed (no crash).
   */
  canvasRect?: DOMRect | null;
}

// ---------------------------------------------------------------------------
// CellGlow — one glow plane + ring per winning cell
// Each instance owns cloned materials so per-frame opacity mutations don't
// bleed across concurrent glows. At most 15 cells → 2 clones each = 30
// material instances — negligible cost during the brief win animation.
// ---------------------------------------------------------------------------

interface CellGlowProps {
  worldPos: { x: number; y: number; z: number };
  isWild: boolean;
  visible: boolean;
  pulsePhase: number; // per-cell phase offset for staggered pulse
  glowNormalZ: number;
}

function CellGlow({ worldPos, isWild, visible, pulsePhase, glowNormalZ }: CellGlowProps) {
  const groupRef  = useRef<THREE.Group>(null);
  const planeRef  = useRef<THREE.Mesh>(null);
  const ringRef   = useRef<THREE.Mesh>(null);

  // Per-instance material clones — avoid shared-material opacity bleed when
  // multiple cells are active simultaneously.
  const { instanceGlowMat, instanceRingMat } = useMemo(() => ({
    instanceGlowMat: (isWild ? GLOW_WILD_MAT : GLOW_MAT).clone(),
    instanceRingMat: (isWild ? RING_WILD_MAT  : RING_MAT).clone(),
  }), [isWild]);

  // Dispose cloned materials on unmount.
  useEffect(() => {
    return () => {
      instanceGlowMat.dispose();
      instanceRingMat.dispose();
    };
  }, [instanceGlowMat, instanceRingMat]);

  // Orient the plane so it faces the camera.
  const planeRot: [number, number, number] = glowNormalZ >= 0 ? [0, 0, 0] : [0, Math.PI, 0];

  const baseGlowOpacity = isWild ? 0.75 : 0.55;
  const baseRingOpacity = isWild ? 0.95 : 0.90;

  useFrame(() => {
    const g = groupRef.current;
    const p = planeRef.current;
    const ring = ringRef.current;
    if (!g || !p || !ring) return;

    // Visibility toggled via group.visible — avoids conditional rendering
    // and the resulting mount/unmount/dispose churn on every cascade step.
    g.visible = visible;
    if (!visible) return;

    // Pulsing opacity: sin wave at ~1.8Hz with per-cell phase offset.
    const t = performance.now() * 0.0018;
    const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + pulsePhase));

    instanceGlowMat.opacity = baseGlowOpacity * pulse;
    instanceRingMat.opacity = baseRingOpacity * pulse;
  });

  return (
    <group ref={groupRef} position={[worldPos.x, worldPos.y, worldPos.z]} visible={visible}>
      <mesh
        ref={planeRef}
        geometry={GLOW_PLANE_GEO}
        material={instanceGlowMat}
        rotation={planeRot}
      />
      <mesh
        ref={ringRef}
        geometry={RING_GEO}
        material={instanceRingMat}
        rotation={[Math.PI / 2, 0, 0]}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// WildLabelsOverlay — DOM labels for wild multiplier values.
// Iris Xe safe: no drei Html / Text / Billboard.
//
// Runs INSIDE the R3F canvas tree (to access useThree/useFrame for projection)
// but renders DOM content via React.createPortal to document.body.
// This is the correct pattern for DOM overlays that need canvas coordinates
// without three.js objects in the scene graph.
// ---------------------------------------------------------------------------

interface WildLabelEntry {
  worldPos: { x: number; y: number; z: number };
  multiplier: number;
  key: string;
}

interface WildLabelsOverlayProps {
  labels: WildLabelEntry[];
  visible: boolean;
  /** Canvas DOM rect — used to offset projected pixel coords relative to viewport. */
  canvasRect: DOMRect | null;
}

type PositionEntry = { x: number; y: number; label: string; key: string };

function WildLabelsOverlay({ labels, visible, canvasRect }: WildLabelsOverlayProps) {
  const { camera, size } = useThree();

  // Accumulate projected positions in a ref — no React re-render per frame.
  // Flush to state at ~10Hz (every 6 frames at 60fps) so the DOM label updates
  // smoothly without triggering 60Hz reconciler pressure.
  const posAccumRef  = useRef<PositionEntry[]>([]);
  const lastFlushRef = useRef(0);
  const prevVisibleRef = useRef(false);
  const [positions, setPositions] = useState<PositionEntry[]>([]);

  useFrame(() => {
    const nowVisible = visible && labels.length > 0 && canvasRect !== null;

    // On visible → false transition: clear state exactly once, reset flush clock.
    if (!nowVisible) {
      if (prevVisibleRef.current) {
        setPositions([]);
        posAccumRef.current = [];
        lastFlushRef.current = 0;
      }
      prevVisibleRef.current = false;
      return;
    }
    prevVisibleRef.current = true;

    // Project world → screen (every frame into the ref — cheap, no alloc).
    const next: PositionEntry[] = [];
    for (const l of labels) {
      _scratchVec.set(l.worldPos.x, l.worldPos.y, l.worldPos.z);
      _scratchNDC.copy(_scratchVec).project(camera);
      if (_scratchNDC.z > 1) continue; // behind camera
      const canvasX = (_scratchNDC.x * 0.5 + 0.5) * size.width;
      const canvasY = (1 - (_scratchNDC.y * 0.5 + 0.5)) * size.height;
      next.push({ x: canvasRect!.left + canvasX, y: canvasRect!.top + canvasY, label: `${l.multiplier}×`, key: l.key });
    }
    posAccumRef.current = next;

    // Flush to React state at 10Hz (every 6 frames) — tolerable label lag for
    // a static 3D rig where positions only matter at first appear.
    lastFlushRef.current += 1;
    if (lastFlushRef.current % 6 === 0) {
      setPositions(posAccumRef.current);
    }
  });

  if (!visible || positions.length === 0 || typeof document === 'undefined') return null;

  return createPortal(
    <>
      {positions.map((p) => (
        <div
          key={p.key}
          style={{
            position: 'fixed',
            left: p.x,
            top: p.y,
            transform: 'translate(-50%, -110%)',
            background: 'linear-gradient(180deg, #ff37c1 0%, #7b2ff7 100%)',
            color: '#fff',
            fontFamily: 'monospace',
            fontSize: 13,
            fontWeight: 900,
            padding: '2px 8px',
            borderRadius: 999,
            boxShadow: '0 0 10px rgba(255,55,193,0.85)',
            border: '1px solid rgba(255,255,255,0.4)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          {p.label}
        </div>
      ))}
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WinCascadeOverlay3D({
  winningCells,
  wildMultipliers = [],
  active,
  onCascadeComplete,
  originX = 0,
  originY = 0,
  originZ = 0,
  reelSpacingX = 90,
  rowSpacingY = 90,
  glowNormalZ = 1,
  canvasRect = null,
}: WinCascadeOverlay3DProps) {

  // Set of "activated" cell keys (in cascade order)
  const [activeCellKeys, setActiveCellKeys] = useState<Set<string>>(() => new Set());
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];
  }, []);

  // Build deduplicated list of cells in reel order.
  const orderedCells = useMemo((): WinCell[] => {
    const seen = new Set<string>();
    const result: WinCell[] = [];
    // Sort: reel asc, then row asc
    const sorted = [...winningCells].sort((a, b) =>
      a.reel !== b.reel ? a.reel - b.reel : a.row - b.row
    );
    for (const c of sorted) {
      const k = `${c.reel}-${c.row}`;
      if (!seen.has(k)) { seen.add(k); result.push(c); }
    }
    return result;
  }, [winningCells]);

  // World position for a cell — plain object, no Vector3 allocation.
  const cellWorldPos = useCallback((reel: number, row: number): { x: number; y: number; z: number } => ({
    x: originX + reel * reelSpacingX,
    y: originY - row * rowSpacingY, // +Y = up in Three.js, rows go down = subtract
    z: originZ,
  }), [originX, originY, originZ, reelSpacingX, rowSpacingY]);

  // Build wild multiplier lookup (reel-row key → multiplier value)
  const wildMap = useMemo((): Map<string, number> => {
    const m = new Map<string, number>();
    for (const wm of wildMultipliers) {
      m.set(`${wm.reelIndex}-${wm.rowIndex}`, wm.multiplier);
    }
    return m;
  }, [wildMultipliers]);

  // Wild label entries for the DOM overlay
  const wildLabels = useMemo((): WildLabelEntry[] => {
    return orderedCells
      .filter(c => wildMap.has(`${c.reel}-${c.row}`))
      .map(c => ({
        worldPos: cellWorldPos(c.reel, c.row),
        multiplier: wildMap.get(`${c.reel}-${c.row}`)!,
        key: `wild-${c.reel}-${c.row}`,
      }));
  }, [orderedCells, wildMap, cellWorldPos]);

  // Cascade trigger
  useEffect(() => {
    if (!active || orderedCells.length === 0) {
      clearTimers();
      setActiveCellKeys(new Set());
      return;
    }

    clearTimers();
    setActiveCellKeys(new Set());

    const STAGGER_MS = 200;

    orderedCells.forEach((cell, i) => {
      const key = `${cell.reel}-${cell.row}`;
      const t = setTimeout(() => {
        setActiveCellKeys(prev => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }, i * STAGGER_MS);
      timerRefs.current.push(t);
    });

    // Fire onCascadeComplete after last cell + 800ms hold
    const totalMs = (orderedCells.length - 1) * STAGGER_MS + 800;
    const tDone = setTimeout(() => {
      onCascadeComplete?.();
    }, totalMs);
    timerRefs.current.push(tDone);

    return clearTimers;
  }, [active, orderedCells, onCascadeComplete, clearTimers]);

  // Cleanup on unmount
  useEffect(() => clearTimers, [clearTimers]);

  if (!active || orderedCells.length === 0) return null;

  return (
    <>
      {orderedCells.map((cell, i) => {
        const key = `${cell.reel}-${cell.row}`;
        const isVisible = activeCellKeys.has(key);
        const isWild = wildMap.has(key);
        const worldPos = cellWorldPos(cell.reel, cell.row);
        return (
          <CellGlow
            key={key}
            worldPos={worldPos}
            isWild={isWild}
            visible={isVisible}
            pulsePhase={(i / Math.max(orderedCells.length, 1)) * Math.PI * 2}
            glowNormalZ={glowNormalZ}
          />
        );
      })}

      {/* Wild multiplier DOM labels — positioned via camera projection, portalled to document.body */}
      <WildLabelsOverlay
        labels={wildLabels}
        visible={activeCellKeys.size > 0}
        canvasRect={canvasRect}
      />
    </>
  );
}
