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
  isCellPlaceable,
  isPiecePlacementAllowed,
  isRotationAllowed,
  type KitPieceKey,
  type KitStructureLevel,
  type ParcelSlot,
} from "@clawville/shared";
import { useSceneFrame } from "@/components/three/world-stage/use-scene-frame";
import { api } from "@/lib/api";
import {
  freshLandPieceIdempotencyKey,
  isIdempotencyConflict,
  landPieceErrorMessage,
} from "@/lib/land-yard-editor";
import { requestLandPiecesRefresh } from "@/lib/land-query-keys";
import { getParcelSlotByCode } from "@/lib/land-proximity";
import { MAP_HEIGHT, MAP_WIDTH } from "@/lib/pixi/tilemap-data";
import {
  KIT_CELL,
  KIT_FLOOR_Y,
  KIT_STACK_UNIT_WU,
  LAND_KIT_ASSET_PATHS,
  fitKitPieceToCell,
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

function cellStackLevel(
  pieces: readonly PlacedPiece[],
  cell: HoverCell,
  excludePieceId: string | null = null,
): number {
  let count = 0;
  for (const piece of pieces) {
    if (
      piece.id !== excludePieceId &&
      piece.gridX === cell.gridX &&
      piece.gridY === cell.gridY
    )
      count += 1;
  }
  return count + 1;
}

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
  const cell = KIT_CELL(parcel.size);
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
  const reservedGeometry = useMemo(
    () => new THREE.PlaneGeometry(cell * 10, cell * 10),
    [cell],
  );
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
  placeable,
}: {
  parcel: ParcelSlot;
  pieceKey: KitPieceKey;
  cell: HoverCell;
  rotationStep: number;
  stackLevel: number;
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
    () => fitKitPieceToCell(pieceKey, parcel.size, source.bounds),
    [parcel.size, pieceKey, source.bounds],
  );
  const world = kitGridToWorld(parcel, { ...cell, rotationStep, stackLevel });

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
  const ghostStackLevel = hoverCell
    ? cellStackLevel(
        parcelPieces,
        hoverCell,
        mode === "move" ? selectedPlacedPieceId : null,
      )
    : 1;
  let smallCount = 0;
  let largeCount = 0;
  for (const piece of parcelPieces) {
    if (!isKitPieceKey(piece.pieceKey)) continue;
    if (KIT_CATALOG[piece.pieceKey].size === "small") smallCount += 1;
    else largeCount += 1;
  }
  const ghostPlaceable = !!(
    hoverCell &&
    ghostPieceKey &&
    buildParcelId &&
    isCellPlaceable(hoverCell.gridX, hoverCell.gridY) &&
    isRotationAllowed(level, ghostRotation) &&
    ghostStackLevel <= levelRule.maxStackHeight &&
    (mode === "move" ||
      isPiecePlacementAllowed(
        level,
        smallCount,
        largeCount,
        KIT_CATALOG[ghostPieceKey].size,
      ))
  );

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
      const stackLevel = cellStackLevel(parcelPieces, cell);
      const pieceSize = KIT_CATALOG[selectedPieceKey].size;
      if (
        !isCellPlaceable(cell.gridX, cell.gridY) ||
        !isRotationAllowed(level, rotationStep) ||
        stackLevel > levelRule.maxStackHeight ||
        !isPiecePlacementAllowed(level, smallCount, largeCount, pieceSize)
      ) {
        useGameStore
          .getState()
          .addToast(
            "⚠️",
            stackLevel > levelRule.maxStackHeight
              ? "Needs a piece underneath first."
              : !isCellPlaceable(cell.gridX, cell.gridY)
                ? "That spot is under your building."
                : "Piece limit reached for your building level.",
            3800,
          );
        return;
      }

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
      } catch (error) {
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
      const stackLevel = cellStackLevel(
        parcelPieces,
        cell,
        selectedPlacedPiece.id,
      );
      if (
        !isCellPlaceable(cell.gridX, cell.gridY) ||
        !isRotationAllowed(level, selectedPlacedPiece.rotationStep) ||
        stackLevel > levelRule.maxStackHeight
      ) {
        useGameStore
          .getState()
          .addToast(
            "⚠️",
            !isCellPlaceable(cell.gridX, cell.gridY)
              ? "That spot is under your building."
              : "Needs a piece underneath first.",
            3800,
          );
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
  const cellSize = KIT_CELL(parcel.size);
  const selectedWorld = selectedPlacedPiece
    ? kitGridToWorld(parcel, selectedPlacedPiece)
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
        const world = kitGridToWorld(parcel, piece);
        const footprint =
          isKitPieceKey(piece.pieceKey) &&
          KIT_CATALOG[piece.pieceKey].size === "large"
            ? 1.8
            : 0.86;
        return (
          <mesh
            key={
              piece.id ??
              `${piece.pieceKey}:${piece.gridX}:${piece.gridY}:${piece.stackLevel}`
            }
            geometry={hitGeometry}
            material={hitMaterial}
            position={[
              world.worldX,
              world.worldY + KIT_STACK_UNIT_WU * 0.45,
              world.worldZ,
            ]}
            scale={[
              cellSize * footprint,
              KIT_STACK_UNIT_WU * 0.9,
              cellSize * footprint,
            ]}
            onPointerDown={(event) => handlePiecePointerDown(event, piece)}
          />
        );
      })}
      {selectedPlacedPiece && selectedWorld ? (
        <mesh
          geometry={selectionGeometry}
          material={selectionMaterial}
          position={[
            selectedWorld.worldX,
            selectedWorld.worldY + KIT_STACK_UNIT_WU * 0.45,
            selectedWorld.worldZ,
          ]}
          scale={[cellSize * 0.95, KIT_STACK_UNIT_WU * 0.92, cellSize * 0.95]}
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
