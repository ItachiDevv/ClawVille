"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useQueryClient } from "@tanstack/react-query";
import * as THREE from "three";
import {
  KIT_CATALOG,
  KIT_GRID_SIZE,
  KIT_LEVEL_RULES,
  evaluatePlacement,
  resolveFootprint,
  resolveParcelPlacements,
  shellEnvelopeHalfWu,
  type KitPieceKey,
  type KitStructureLevel,
  type ParcelSlot,
  type PlacedFootprint,
  type PlacementContext,
  type PlacementRefusalCode,
  type PlacementRequest,
  type StoredPlacement,
} from "@clawville/shared";
import { useSceneFrame } from "@/components/three/world-stage/use-scene-frame";
import { api } from "@/lib/api";
import {
  freshLandPieceIdempotencyKey,
  isIdempotencyConflict,
  landPieceErrorMessage,
} from "@/lib/land-yard-editor";
import { LAND_SALVAGE_REFRESH_EVENT, requestLandPiecesRefresh } from "@/lib/land-query-keys";
import { getParcelSlotByCode } from "@/lib/land-proximity";
import { MAP_HEIGHT, MAP_WIDTH } from "@/lib/pixi/tilemap-data";
import {
  KIT_CELL,
  KIT_FLOOR_Y,
  LAND_KIT_ASSET_PATHS,
  fitKitPieceToManifest,
  kitGridToWorld,
  kitWorldToGrid,
} from "@/lib/three/land-kit-assets";
import {
  KitPieceSourceErrorBoundary,
  resolvePieceSource,
} from "@/lib/three/land-kit-pieces";
import { extendLoaderWithMeshopt } from "@/lib/three/meshopt-loader-setup";
import { avatarPositionRef, useGameStore } from "@/stores/game";
import { useLandStore, type PlacedPiece } from "@/stores/land";

const EDITOR_EPSILON_Y = 0.3;
const HALF_MAP_WIDTH = MAP_WIDTH / 2;
const HALF_MAP_HEIGHT = MAP_HEIGHT / 2;
const EMPTY_PIECES: readonly PlacedPiece[] = Object.freeze([]);

/**
 * Floor for a click target's span. A `path-stone` is only 8 wu tall, which is
 * 0.03× an avatar — an exact-size hit box would be effectively unclickable.
 */
const MIN_HIT_SPAN_WU = 24;

interface HoverCell {
  gridX: number;
  gridY: number;
}

function isKitPieceKey(value: string): value is KitPieceKey {
  return Object.prototype.hasOwnProperty.call(KIT_CATALOG, value);
}

function toPlacedPiece(
  parcelCode: string,
  piece: {
    id: string;
    parcelId: string;
    pieceKey: KitPieceKey;
    gridX: number;
    gridY: number;
    rotationStep: number;
    stackLevel: number;
  },
): PlacedPiece {
  return { ...piece, parcelCode };
}

/** Stable identity for a row, matching the public render layer's synthesis. */
function pieceRefOf(piece: PlacedPiece): string {
  return (
    piece.id
    ?? `${piece.parcelCode}:${piece.gridX}:${piece.gridY}:${piece.stackLevel}`
  );
}

function toStoredPlacement(piece: PlacedPiece): StoredPlacement | null {
  if (!isKitPieceKey(piece.pieceKey)) return null;
  return {
    pieceRef: pieceRefOf(piece),
    pieceKey: piece.pieceKey,
    gridX: piece.gridX,
    gridY: piece.gridY,
    rotationStep: piece.rotationStep,
    stackLevel: piece.stackLevel,
  };
}

/**
 * The stack level the ghost should snap to at `cell`: the HIGHEST level that
 * evaluates legal there, so hovering a deck plank lifts the ghost onto it and
 * hovering bare sand drops it to the ground.
 *
 * This replaces `cellStackLevel`, which returned "one more than the number of
 * rows sharing this anchor cell". That was the client half of defect N-3 — it
 * let a player stack onto a lantern, which has no support surface at all, and
 * it ignored geometry entirely (two pieces at neighbouring anchors that
 * physically overlap counted as level 1 each).
 *
 * When nothing is legal it returns 1 so the refusal is drawn on the ground in
 * red rather than floating somewhere arbitrary.
 */
function preferredStackLevel(
  base: Omit<PlacementRequest, "stackLevel">,
  ctx: PlacementContext,
  maxStackHeight: number,
): number {
  for (let level = maxStackHeight; level >= 1; level--) {
    if (evaluatePlacement({ ...base, stackLevel: level }, ctx).ok) return level;
  }
  return 1;
}

/** Player-facing wording for each refusal the shared predicate can return. */
const PLACEMENT_REFUSAL_COPY: Record<PlacementRefusalCode, string> = {
  piece_unknown: "That piece is not in the catalog.",
  cell_out_of_bounds: "That spot is off your yard.",
  rotation_not_allowed: "This piece cannot face that way here.",
  level_cap_exceeded: "Piece limit reached for your building level.",
  stack_exceeds_height: "You cannot stack that high at this level.",
  unsupported_stack: "Nothing underneath can hold that.",
  outside_parcel: "It would hang over your edge.",
  intersects_shell: "That spot is under your building.",
  intersects_piece: "Something is already there.",
};

function createGridGeometry(parcel: ParcelSlot): THREE.BufferGeometry {
  const half = parcel.size / 2;
  const cell = KIT_CELL(parcel.size);
  const vertices = new Float32Array((KIT_GRID_SIZE + 1) * 4 * 3);
  let offset = 0;
  for (let index = 0; index <= KIT_GRID_SIZE; index += 1) {
    const axis = -half + index * cell;
    vertices[offset++] = axis;
    vertices[offset++] = 0;
    vertices[offset++] = -half;
    vertices[offset++] = axis;
    vertices[offset++] = 0;
    vertices[offset++] = half;
    vertices[offset++] = -half;
    vertices[offset++] = 0;
    vertices[offset++] = axis;
    vertices[offset++] = half;
    vertices[offset++] = 0;
    vertices[offset++] = axis;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function EditorGrid({ parcel }: { parcel: ParcelSlot }) {
  const gridGeometry = useMemo(() => createGridGeometry(parcel), [parcel]);
  const gridMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      }),
    [],
  );
  // The TRUE reservation, from the same function the predicate subtracts.
  // This was `cell * 10` — the centre 10×10 cells of the grid — which matched
  // the retired `isCellPlaceable` but not the actual shell, and never grew with
  // the tier. Because `shellEnvelopeHalfWu` is computed at the tier's MAX
  // level, what the player sees reserved at Lv1 is what stays reserved at Lv5.
  const reservedGeometry = useMemo(() => {
    const side = shellEnvelopeHalfWu(parcel.tier) * 2;
    return new THREE.PlaneGeometry(side, side);
  }, [parcel.tier]);
  const reservedMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0x07111f,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  useEffect(
    () => () => {
      gridGeometry.dispose();
      gridMaterial.dispose();
      reservedGeometry.dispose();
      reservedMaterial.dispose();
    },
    [gridGeometry, gridMaterial, reservedGeometry, reservedMaterial],
  );

  return (
    <group position={[parcel.cx, KIT_FLOOR_Y + EDITOR_EPSILON_Y, parcel.cz]}>
      <lineSegments geometry={gridGeometry} material={gridMaterial} />
      <mesh
        geometry={reservedGeometry}
        material={reservedMaterial}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.05, 0]}
        renderOrder={3}
      />
    </group>
  );
}

function GhostPiece({
  parcel,
  pieceKey,
  cell,
  rotationStep,
  stackLevel,
  baseYWu,
  placeable,
}: {
  parcel: ParcelSlot;
  pieceKey: KitPieceKey;
  cell: HoverCell;
  rotationStep: number;
  stackLevel: number;
  /** Parcel-local base height, resolved from the supporter under the cursor. */
  baseYWu: number;
  placeable: boolean;
}) {
  const { scene } = useGLTF(
    LAND_KIT_ASSET_PATHS[pieceKey],
    undefined,
    undefined,
    extendLoaderWithMeshopt,
  );
  const source = useMemo(
    () => resolvePieceSource(scene, pieceKey),
    [pieceKey, scene],
  );
  const material = useMemo(() => {
    const clone = source.material.clone();
    clone.transparent = true;
    clone.opacity = 0.55;
    clone.depthWrite = false;
    return clone;
  }, [source]);
  const fit = useMemo(
    () => fitKitPieceToManifest(pieceKey, source.bounds),
    [pieceKey, source.bounds],
  );
  const world = kitGridToWorld(
    parcel,
    { ...cell, rotationStep, stackLevel },
    baseYWu,
  );

  useEffect(() => {
    const colorMaterial = material as THREE.Material & { color?: THREE.Color };
    colorMaterial.color?.set(placeable ? 0x55ef83 : 0xff5c66);
    material.needsUpdate = true;
  }, [material, placeable]);

  useEffect(
    () => () => {
      material.dispose();
      source.geometry.dispose();
    },
    [material, source],
  );

  return (
    <group
      position={[world.worldX, world.worldY, world.worldZ]}
      rotation={[0, world.yaw, 0]}
      scale={fit.scale}
    >
      <mesh
        geometry={source.geometry}
        material={material}
        position={[fit.offsetX, fit.offsetY, fit.offsetZ]}
        frustumCulled={false}
        renderOrder={5}
      />
    </group>
  );
}

function ActiveYardEditor({ parcel }: { parcel: ParcelSlot }) {
  const queryClient = useQueryClient();
  const buildMode = useLandStore((state) => state.buildMode);
  const buildParcelId = useLandStore((state) => state.buildParcelId);
  const mode = useLandStore((state) => state.yardEditorMode);
  const selectedPieceKey = useLandStore((state) => state.selectedPieceKey);
  const rotationStep = useLandStore((state) => state.rotationStep);
  const selectedPlacedPieceId = useLandStore(
    (state) => state.selectedPlacedPieceId,
  );
  const piecesMap = useLandStore((state) => state.pieces);
  const structure = useLandStore(
    (state) => state.structures.get(parcel.id) ?? null,
  );
  const addPiece = useLandStore((state) => state.addPiece);
  const updatePiece = useLandStore((state) => state.updatePiece);
  const removePiece = useLandStore((state) => state.removePiece);
  const exitBuildMode = useLandStore((state) => state.exitBuildMode);
  const paymentRail = useLandStore((state) => state.paymentRail);
  const setSelectedPlacedPieceId = useLandStore(
    (state) => state.setSelectedPlacedPieceId,
  );
  const [hoverCell, setHoverCell] = useState<HoverCell | null>(null);
  const mutationPending = useRef(false);
  const parcelPieces = piecesMap.get(parcel.id) ?? EMPTY_PIECES;
  const level = Math.min(
    5,
    Math.max(1, structure?.level ?? 1),
  ) as KitStructureLevel;
  const levelRule = KIT_LEVEL_RULES[level];
  const selectedPlacedPiece = selectedPlacedPieceId
    ? (parcelPieces.find((piece) => piece.id === selectedPlacedPieceId) ?? null)
    : null;
  const activePieceKey =
    mode === "move"
      ? (selectedPlacedPiece?.pieceKey ?? null)
      : mode === "place"
        ? selectedPieceKey
        : null;
  const ghostPieceKey =
    activePieceKey && isKitPieceKey(activePieceKey) ? activePieceKey : null;
  const ghostRotation =
    mode === "move"
      ? (selectedPlacedPiece?.rotationStep ?? rotationStep)
      : rotationStep;
  /**
   * The parcel's current occupancy, resolved through the SAME shared function
   * the public renderer uses, minus the piece being moved. Q5 grandfathering
   * means every stored row resolves to a footprint even if it is no longer a
   * legal placement, so a legacy piece still blocks the ground it sits on.
   */
  const excludedRef =
    mode === "move" && selectedPlacedPiece ? pieceRefOf(selectedPlacedPiece) : null;
  const { occupied, smallCount, largeCount } = useMemo(() => {
    const stored: StoredPlacement[] = [];
    let small = 0;
    let large = 0;
    for (const piece of parcelPieces) {
      const row = toStoredPlacement(piece);
      if (!row) continue;
      if (row.pieceRef === excludedRef) continue;
      stored.push(row);
      if (KIT_CATALOG[row.pieceKey].size === "small") small += 1;
      else large += 1;
    }
    const footprints: PlacedFootprint[] = resolveParcelPlacements(
      stored,
      parcel.tier,
    ).map((entry) => entry.footprint);
    return { occupied: footprints, smallCount: small, largeCount: large };
  }, [excludedRef, parcel.tier, parcelPieces]);

  const placementContext = useMemo<PlacementContext>(
    () => ({
      parcelTier: parcel.tier,
      structureLevel: level,
      currentSmall: smallCount,
      currentLarge: largeCount,
      occupied,
    }),
    [largeCount, level, occupied, parcel.tier, smallCount],
  );

  // Ghost legality is the SHARED predicate, so a ghost that reads green cannot
  // be refused by the server on submit and a red one always names a real
  // reason. Moving a piece re-checks caps against the reduced counts above,
  // which is what makes the Q5 free move actually possible for a legacy row.
  const ghostBase =
    hoverCell && ghostPieceKey
      ? { pieceKey: ghostPieceKey, gridX: hoverCell.gridX, gridY: hoverCell.gridY, rotationStep: ghostRotation }
      : null;
  const ghostStackLevel = ghostBase
    ? preferredStackLevel(ghostBase, placementContext, levelRule.maxStackHeight)
    : 1;
  const ghostVerdict =
    ghostBase && buildParcelId
      ? evaluatePlacement({ ...ghostBase, stackLevel: ghostStackLevel }, placementContext)
      : null;
  const ghostPlaceable = ghostVerdict?.ok === true;
  // A refused ghost still needs somewhere to draw, so fall back to the ground.
  const ghostBaseYWu = ghostVerdict?.ok
    ? ghostVerdict.footprint.minY
    : (ghostBase
        ? (resolveFootprint({ ...ghostBase, stackLevel: 1 }, parcel.tier, [])?.minY ?? 0)
        : 0);

  useSceneFrame(() => {
    const worldX = avatarPositionRef.x - HALF_MAP_WIDTH;
    const worldZ = avatarPositionRef.y - HALF_MAP_HEIGHT;
    const parcelRadius = parcel.size / 2;
    if (
      Math.max(Math.abs(worldX - parcel.cx), Math.abs(worldZ - parcel.cz)) >
      parcelRadius * 1.2
    )
      exitBuildMode();
  });

  const toastError = useCallback((error: unknown) => {
    useGameStore.getState().addToast("⚠️", landPieceErrorMessage(error), 4200);
  }, []);

  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      const cell = kitWorldToGrid(parcel, event.point.x, event.point.z);
      setHoverCell((current) => {
        if (current?.gridX === cell?.gridX && current?.gridY === cell?.gridY)
          return current;
        return cell;
      });
    },
    [parcel],
  );

  const placeAtCell = useCallback(
    async (cell: HoverCell) => {
      if (
        mutationPending.current ||
        !buildParcelId ||
        !isKitPieceKey(selectedPieceKey)
      )
        return;
      const base = {
        pieceKey: selectedPieceKey,
        gridX: cell.gridX,
        gridY: cell.gridY,
        rotationStep,
      };
      const stackLevel = preferredStackLevel(
        base,
        placementContext,
        levelRule.maxStackHeight,
      );
      const verdict = evaluatePlacement({ ...base, stackLevel }, placementContext);
      if (!verdict.ok) {
        useGameStore
          .getState()
          .addToast("⚠️", PLACEMENT_REFUSAL_COPY[verdict.code], 3800);
        return;
      }

      // Materials rail: OMIT the field entirely for vCLAW (byte-identical to
      // the request this route has always accepted). CONFIRMED SERVED — see
      // PlaceLandPieceRequest.paymentRail's doc comment: the route declares
      // `paymentRail` with a `default('vclaw')`, so both paths are live.
      const usingMaterialsRail = paymentRail === "materials";

      mutationPending.current = true;
      try {
        const request = (idempotencyKey: string) =>
          api.placeLandPiece(buildParcelId, {
            pieceKey: selectedPieceKey,
            gridX: cell.gridX,
            gridY: cell.gridY,
            rotationStep,
            stackLevel,
            idempotencyKey,
            ...(usingMaterialsRail ? { paymentRail: "materials" as const } : {}),
          });
        let response;
        try {
          response = await request(freshLandPieceIdempotencyKey());
        } catch (error) {
          if (!isIdempotencyConflict(error)) throw error;
          try {
            response = await request(freshLandPieceIdempotencyKey());
          } catch (retryError) {
            if (isIdempotencyConflict(retryError)) {
              useGameStore.getState().addToast("⚠️", "Try again.", 3500);
              return;
            }
            throw retryError;
          }
        }
        addPiece(toPlacedPiece(parcel.id, response.piece));
        requestLandPiecesRefresh();
        await queryClient.invalidateQueries({ queryKey: ["avatar"] });
        // Materials balance lives in useSalvageStore (poll-hydrated, not
        // react-query) — refresh it the same way a salvage claim does.
        if (usingMaterialsRail) window.dispatchEvent(new Event(LAND_SALVAGE_REFRESH_EVENT));
      } catch (error) {
        // The rail is confirmed served — `insufficient_materials` and any
        // other refusal here are real domain refusals, handled the same as
        // any other placement failure (landPieceErrorMessage already maps
        // `insufficient_materials` -> "Not enough materials.").
        toastError(error);
      } finally {
        mutationPending.current = false;
      }
    },
    [
      addPiece,
      buildParcelId,
      largeCount,
      level,
      levelRule.maxStackHeight,
      parcel.id,
      parcelPieces,
      paymentRail,
      queryClient,
      rotationStep,
      selectedPieceKey,
      smallCount,
      toastError,
    ],
  );

  const moveToCell = useCallback(
    async (cell: HoverCell) => {
      if (mutationPending.current || !selectedPlacedPiece?.id) return;
      const supportsAnotherPiece = parcelPieces.some(
        (piece) =>
          piece.gridX === selectedPlacedPiece.gridX &&
          piece.gridY === selectedPlacedPiece.gridY &&
          piece.stackLevel > selectedPlacedPiece.stackLevel,
      );
      if (supportsAnotherPiece) {
        useGameStore
          .getState()
          .addToast("!", "Move the top piece first.", 3500);
        return;
      }
      if (!isKitPieceKey(selectedPlacedPiece.pieceKey)) return;
      const base = {
        pieceKey: selectedPlacedPiece.pieceKey,
        gridX: cell.gridX,
        gridY: cell.gridY,
        rotationStep: selectedPlacedPiece.rotationStep,
      };
      // `placementContext` already excludes this piece, so a Q5 free move of a
      // now-illegal legacy row is checked against the destination only — the
      // row's own current position never blocks it.
      const stackLevel = preferredStackLevel(
        base,
        placementContext,
        levelRule.maxStackHeight,
      );
      const verdict = evaluatePlacement({ ...base, stackLevel }, placementContext);
      if (!verdict.ok) {
        useGameStore
          .getState()
          .addToast("⚠️", PLACEMENT_REFUSAL_COPY[verdict.code], 3800);
        return;
      }
      mutationPending.current = true;
      try {
        const response = await api.moveLandPiece(selectedPlacedPiece.id, {
          gridX: cell.gridX,
          gridY: cell.gridY,
          rotationStep: selectedPlacedPiece.rotationStep,
          stackLevel,
        });
        updatePiece(
          selectedPlacedPiece.id,
          toPlacedPiece(parcel.id, response.piece),
        );
        setSelectedPlacedPieceId(null);
        requestLandPiecesRefresh();
      } catch (error) {
        toastError(error);
      } finally {
        mutationPending.current = false;
      }
    },
    [
      level,
      levelRule.maxStackHeight,
      parcel.id,
      parcelPieces,
      selectedPlacedPiece,
      setSelectedPlacedPieceId,
      toastError,
      updatePiece,
    ],
  );

  const handleGroundPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      const cell = kitWorldToGrid(parcel, event.point.x, event.point.z);
      if (!cell) {
        setSelectedPlacedPieceId(null);
        return;
      }
      if (mode === "place") void placeAtCell(cell);
      else if (mode === "move" && selectedPlacedPieceId) void moveToCell(cell);
    },
    [
      mode,
      moveToCell,
      parcel,
      placeAtCell,
      selectedPlacedPieceId,
      setSelectedPlacedPieceId,
    ],
  );

  const handlePiecePointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>, piece: PlacedPiece) => {
      event.stopPropagation();
      if (event.button !== 0 || mode === "place") return;
      if (!piece.id) {
        useGameStore
          .getState()
          .addToast(
            "⚠️",
            "Yard pieces aren't synced — close and reopen Decorate to retry.",
            4200,
          );
        return;
      }
      if (mode === "move") {
        setSelectedPlacedPieceId(
          selectedPlacedPieceId === piece.id ? null : piece.id,
        );
        return;
      }
      const supportsAnotherPiece = parcelPieces.some(
        (candidate) =>
          candidate.gridX === piece.gridX &&
          candidate.gridY === piece.gridY &&
          candidate.stackLevel > piece.stackLevel,
      );
      if (supportsAnotherPiece) {
        useGameStore
          .getState()
          .addToast("!", "Remove the top piece first.", 3500);
        return;
      }
      if (!window.confirm("No refund — remove?")) return;
      if (mutationPending.current) return;
      mutationPending.current = true;
      void api
        .deleteLandPiece(piece.id)
        .then(() => {
          removePiece(piece.id!);
          requestLandPiecesRefresh();
        })
        .catch(toastError)
        .finally(() => {
          mutationPending.current = false;
        });
    },
    [
      mode,
      parcelPieces,
      removePiece,
      selectedPlacedPieceId,
      setSelectedPlacedPieceId,
      toastError,
    ],
  );

  const groundGeometry = useMemo(
    () => new THREE.PlaneGeometry(parcel.size, parcel.size),
    [parcel.size],
  );
  const groundMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const hitGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const hitMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [],
  );
  const selectionGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const selectionMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        wireframe: true,
      }),
    [],
  );

  useEffect(
    () => () => {
      groundGeometry.dispose();
      groundMaterial.dispose();
      hitGeometry.dispose();
      hitMaterial.dispose();
      selectionGeometry.dispose();
      selectionMaterial.dispose();
    },
    [
      groundGeometry,
      groundMaterial,
      hitGeometry,
      hitMaterial,
      selectionGeometry,
      selectionMaterial,
    ],
  );

  if (!buildMode || buildMode.parcelCode !== parcel.id) return null;

  // Draw every stored row where the RENDERER puts it, resolved through the same
  // shared function, so the click target sits on the piece rather than near it.
  // Grandfathered rows included — you cannot offer a free move for a piece the
  // editor refuses to draw a handle on.
  const drawnPieces = resolveParcelPlacements(
    parcelPieces.map(toStoredPlacement).filter((row): row is StoredPlacement => row !== null),
    parcel.tier,
  );
  const footprintByRef = new Map(drawnPieces.map((entry) => [entry.row.pieceRef, entry.footprint]));
  const selectedFootprint = selectedPlacedPiece
    ? (footprintByRef.get(pieceRefOf(selectedPlacedPiece)) ?? null)
    : null;

  return (
    <group name={`yard-editor:${parcel.id}`}>
      <EditorGrid parcel={parcel} />
      <mesh
        geometry={groundGeometry}
        material={groundMaterial}
        position={[parcel.cx, KIT_FLOOR_Y + EDITOR_EPSILON_Y + 0.12, parcel.cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverCell(null)}
        onPointerDown={handleGroundPointerDown}
      />
      {parcelPieces.map((piece) => {
        const footprint = footprintByRef.get(pieceRefOf(piece));
        if (!footprint) return null;
        // The hit box IS the piece's real rotated AABB now, not a fixed
        // cell-relative cube — so a 292 wu statue is clickable along its whole
        // height and a 8 wu path stone is not a 34 wu column of dead space.
        return (
          <mesh
            key={pieceRefOf(piece)}
            geometry={hitGeometry}
            material={hitMaterial}
            position={[
              parcel.cx + (footprint.minX + footprint.maxX) / 2,
              KIT_FLOOR_Y + (footprint.minY + footprint.maxY) / 2,
              parcel.cz + (footprint.minZ + footprint.maxZ) / 2,
            ]}
            scale={[
              Math.max(footprint.maxX - footprint.minX, MIN_HIT_SPAN_WU),
              Math.max(footprint.maxY - footprint.minY, MIN_HIT_SPAN_WU),
              Math.max(footprint.maxZ - footprint.minZ, MIN_HIT_SPAN_WU),
            ]}
            onPointerDown={(event) => handlePiecePointerDown(event, piece)}
          />
        );
      })}
      {selectedPlacedPiece && selectedFootprint ? (
        <mesh
          geometry={selectionGeometry}
          material={selectionMaterial}
          position={[
            parcel.cx + (selectedFootprint.minX + selectedFootprint.maxX) / 2,
            KIT_FLOOR_Y + (selectedFootprint.minY + selectedFootprint.maxY) / 2,
            parcel.cz + (selectedFootprint.minZ + selectedFootprint.maxZ) / 2,
          ]}
          scale={[
            Math.max(selectedFootprint.maxX - selectedFootprint.minX, MIN_HIT_SPAN_WU) * 1.06,
            Math.max(selectedFootprint.maxY - selectedFootprint.minY, MIN_HIT_SPAN_WU) * 1.06,
            Math.max(selectedFootprint.maxZ - selectedFootprint.minZ, MIN_HIT_SPAN_WU) * 1.06,
          ]}
          renderOrder={6}
        />
      ) : null}
      {hoverCell &&
      ghostPieceKey &&
      (mode === "place" || selectedPlacedPiece) ? (
        <KitPieceSourceErrorBoundary key={ghostPieceKey}>
          <Suspense fallback={null}>
            <GhostPiece
              parcel={parcel}
              pieceKey={ghostPieceKey}
              cell={hoverCell}
              rotationStep={ghostRotation}
              stackLevel={ghostStackLevel}
              baseYWu={ghostBaseYWu}
              placeable={ghostPlaceable}
            />
          </Suspense>
        </KitPieceSourceErrorBoundary>
      ) : null}
    </group>
  );
}

export default function YardEditorThree() {
  const buildMode = useLandStore((state) => state.buildMode);
  if (!buildMode) return null;
  const parcel = getParcelSlotByCode(buildMode.parcelCode);
  return parcel ? <ActiveYardEditor key={parcel.id} parcel={parcel} /> : null;
}
