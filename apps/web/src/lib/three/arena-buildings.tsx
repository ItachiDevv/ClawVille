'use client';

import { useMemo, useRef, useState, useEffect, useCallback, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF, Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB model buildings with terrain raycasting
// Each building sits on the actual terrain surface
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Shared raycaster -- only hits layer 1 (terrain)
const _buildRaycaster = new THREE.Raycaster();
_buildRaycaster.layers.set(TERRAIN_LAYER);
const _buildRayOrigin = new THREE.Vector3();
const _buildRayDir = new THREE.Vector3(0, -1, 0);

// Target height for all buildings (world units) — must dominate the landscape
const BUILDING_TARGET_HEIGHT = 100;

// Map each building ID to a GLB model + display config
// tint: color overlay to make dome-shaped buildings visually distinct from each other
const BUILDING_MODELS: Record<string, { model: string; yOffset: number; rotY?: number }> = {
  'cron-hub':          { model: '/models/downtown-building.glb', yOffset: 0 },
  'webhook-gateway':   { model: '/models/salty-spitoon.glb', yOffset: 0 },
  'memory-vault':      { model: '/models/bb-building.glb', yOffset: 0 },
  'skill-forge':       { model: '/models/chum-bucket.glb', yOffset: 0 },
  'channel-bridge':    { model: '/models/building-cave.glb', yOffset: 0 },
  'tool-workshop':     { model: '/models/patty-building.glb', yOffset: 0 },
  'canvas-studio':     { model: '/models/pineapple-house.glb', yOffset: 0 },
  'voice-tower':       { model: '/models/boating-school.glb', yOffset: 0 },
  'security-fortress': { model: '/models/building-submarine.glb', yOffset: 0 },
  'config-citadel':    { model: '/models/building-lighthouse.glb', yOffset: 0 },
};

/** Strip ground planes from a cloned scene.
 *  ONLY removes meshes that are trivially thin (< 0.5% height ratio) AND sit at the
 *  very bottom of the model (within 5% of min Y). This prevents eating actual building
 *  geometry like Patrick's Rock (which is flat+wide but IS the building). */
function stripGroundPlanes(scene: THREE.Object3D): void {
  // First pass: measure the full model bounds
  const fullBox = new THREE.Box3().setFromObject(scene);
  const fullMinY = fullBox.min.y;
  const fullHeight = fullBox.max.y - fullBox.min.y;
  if (fullHeight === 0) return;

  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;

    const sy = bb.max.y - bb.min.y;
    const sx = bb.max.x - bb.min.x;
    const sz = bb.max.z - bb.min.z;
    const maxXZ = Math.max(sx, sz);

    // Must be: extremely flat (< 0.5% height ratio), wide, AND at the model's floor
    const isFlat = maxXZ > 2 && sy / maxXZ < 0.005;
    const isAtBottom = bb.max.y < fullMinY + fullHeight * 0.05;
    if (isFlat && isAtBottom) {
      toRemove.push(mesh);
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

/** Measure bounding box and return scale to reach target height.
 *  Called AFTER stripping ground planes. */
function computeBuildingScale(scene: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0) return 1;
  return BUILDING_TARGET_HEIGHT / maxDim;
}

// Preload all models
Object.values(BUILDING_MODELS).forEach(({ model }) => {
  useGLTF.preload(model);
});

// ---------------------------------------------------------------------------
// Normal mode: static buildings with terrain raycasting
// ---------------------------------------------------------------------------

function GLBBuilding({ zone }: { zone: BuildingZone }) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const [cx, , cz] = zoneCenter(zone);
  const { scene } = useGLTF(config.model);
  const groupRef = useRef<THREE.Group>(null);

  const { cloned, buildingScale } = useMemo(() => {
    const c = scene.clone(true);
    // Strip flat ground planes before measuring height so BUILDING_TARGET_HEIGHT
    // is accurate — ground planes inflate the bounding box and make buildings appear
    // shorter than 100 world units after scaling.
    stripGroundPlanes(c);
    const s = computeBuildingScale(c);
    return { cloned: c, buildingScale: s };
  }, [scene, config.model]);

  const theme = BUILDING_OPENCLAW_THEMES[zone.id];

  // Buildings sit on the sand floor (y=-2). No raycasting needed — the sand floor
  // is flat at y=-2 and buildings are large enough that dune ripples don't matter.
  return (
    <group ref={groupRef} position={[cx, -2 + config.yOffset, cz]} rotation={[0, config.rotY ?? 0, 0]}>
      <primitive object={cloned} scale={buildingScale} />
      {/* Floating building label */}
      {theme && (
        <Html position={[0, BUILDING_TARGET_HEIGHT + 12, 0]} center distanceFactor={400} style={{ pointerEvents: 'auto' }}>
          <div
            style={{
              background: 'rgba(10, 22, 40, 0.85)',
              backdropFilter: 'blur(4px)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              borderRadius: 8,
              padding: '6px 12px',
              cursor: 'pointer',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <div style={{ color: '#7dd3fc', fontWeight: 'bold', fontSize: 13 }}>{theme.label}</div>
            <div style={{ color: 'rgba(148,163,184,0.7)', fontSize: 10, marginTop: 2 }}>{theme.category}</div>
          </div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Edit mode: draggable buildings with labels + copy button
// Activate by visiting /game?edit=1
// ---------------------------------------------------------------------------

interface EditZone extends BuildingZone {
  worldX: number;
  worldZ: number;
}

function toEditZone(z: BuildingZone): EditZone {
  const [cx, , cz] = zoneCenter(z);
  return { ...z, worldX: cx, worldZ: cz };
}

function EditableBuilding({
  zone,
  isDragging,
  onDragStart,
}: {
  zone: EditZone;
  isDragging: boolean;
  onDragStart: (id: string) => void;
}) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const { scene } = useGLTF(config.model);
  const { scene: threeScene } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const terrainY = useRef(-15);

  const { cloned, buildingScale } = useMemo(() => {
    const c = scene.clone(true);
    stripGroundPlanes(c);
    const s = computeBuildingScale(c);
    return { cloned: c, buildingScale: s };
  }, [scene]);

  // Re-raycast terrain Y whenever position changes
  useFrame(() => {
    if (!groupRef.current) return;
    _buildRayOrigin.set(zone.worldX, 200, zone.worldZ);
    _buildRaycaster.set(_buildRayOrigin, _buildRayDir);
    _buildRaycaster.layers.set(TERRAIN_LAYER);
    _buildRaycaster.far = 400;

    const intersects = _buildRaycaster.intersectObjects(threeScene.children, true);
    if (intersects.length > 0) {
      terrainY.current = intersects[0].point.y;
    }
    groupRef.current.position.set(zone.worldX, terrainY.current + config.yOffset, zone.worldZ);
  });

  return (
    <group ref={groupRef} rotation={[0, config.rotY ?? 0, 0]}>
      <primitive object={cloned} scale={buildingScale} />
      {/* Invisible click box for drag detection */}
      <mesh
        position={[0, 20, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart(zone.id);
        }}
      >
        <boxGeometry args={[50, 80, 50]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {/* Label */}
      <Html position={[0, 50, 0]} center distanceFactor={400} style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: isDragging ? '#d97706' : '#1e293b',
            color: 'white',
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            border: isDragging ? '2px solid #fbbf24' : '1px solid #475569',
            boxShadow: isDragging ? '0 0 12px rgba(251,191,36,0.5)' : '0 2px 8px rgba(0,0,0,0.4)',
            userSelect: 'none',
          }}
        >
          <strong>{zone.id}</strong>
          <br />
          x:{zone.x} y:{zone.y}
        </div>
      </Html>
    </group>
  );
}

function EditMode() {
  const [zones, setZones] = useState<EditZone[]>(() => buildingZones.map(toEditZone));
  const [dragging, setDragging] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const controls = useThree((s) => s.controls) as any;
  const { camera, pointer } = useThree();

  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersection = useMemo(() => new THREE.Vector3(), []);
  const dragRaycaster = useMemo(() => new THREE.Raycaster(), []);
  const lastTile = useRef({ x: -1, y: -1 });

  // Disable orbit controls during drag
  useEffect(() => {
    if (controls) controls.enabled = !dragging;
    return () => {
      if (controls) controls.enabled = true;
    };
  }, [dragging, controls]);

  // Track drag position — only update state when tile changes
  useFrame(() => {
    if (!dragging) return;
    dragRaycaster.setFromCamera(pointer, camera);
    if (!dragRaycaster.ray.intersectPlane(dragPlane, intersection)) return;

    const zone = zones.find((z) => z.id === dragging);
    if (!zone) return;

    const newTileX = Math.max(
      0,
      Math.min(MAP_COLS - zone.width, Math.round((intersection.x - OFFSET_X) / TILE_SIZE - zone.width / 2)),
    );
    const newTileY = Math.max(
      0,
      Math.min(MAP_ROWS - zone.height, Math.round((intersection.z - OFFSET_Z) / TILE_SIZE - zone.height / 2)),
    );

    if (newTileX === lastTile.current.x && newTileY === lastTile.current.y) return;
    lastTile.current = { x: newTileX, y: newTileY };

    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== dragging) return z;
        return {
          ...z,
          x: newTileX,
          y: newTileY,
          worldX: OFFSET_X + (newTileX + z.width / 2) * TILE_SIZE,
          worldZ: OFFSET_Z + (newTileY + z.height / 2) * TILE_SIZE,
        };
      }),
    );
  });

  // End drag on pointer up (window-level to catch releases outside canvas)
  useEffect(() => {
    const onUp = () => {
      setDragging(null);
      lastTile.current = { x: -1, y: -1 };
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  const copyPositions = useCallback(() => {
    const lines = zones.map(
      (z) =>
        `  { id: '${z.id}',${' '.repeat(Math.max(1, 21 - z.id.length))}x: ${String(z.x).padStart(2)},  y: ${String(z.y).padStart(2)},  width: ${z.width}, height: ${z.height} },`,
    );
    const code = `export const buildingZones: BuildingZone[] = [\n${lines.join('\n')}\n];`;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    console.log('[EditMode] Building positions:\n' + code);
  }, [zones]);

  return (
    <Suspense fallback={null}>
      <group>
        {zones.map((zone) => (
          <EditableBuilding
            key={zone.id}
            zone={zone}
            isDragging={dragging === zone.id}
            onDragStart={setDragging}
          />
        ))}
      </group>

      {/* Floating edit panel */}
      <Html position={[HALF_W + 50, 150, -HALF_H]} center style={{ pointerEvents: 'auto' }}>
        <div
          style={{
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 10,
            padding: 16,
            minWidth: 200,
            color: 'white',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 8, color: '#38bdf8' }}>
            Building Editor
          </div>
          <div style={{ color: '#94a3b8', marginBottom: 12, lineHeight: 1.4 }}>
            Click and drag buildings
            <br />
            to reposition them.
          </div>
          <button
            onClick={copyPositions}
            style={{
              background: copied ? '#16a34a' : '#2563eb',
              color: 'white',
              padding: '8px 16px',
              borderRadius: 6,
              fontWeight: 'bold',
              fontSize: 13,
              cursor: 'pointer',
              border: 'none',
              width: '100%',
              transition: 'background 0.2s',
            }}
          >
            {copied ? 'Copied!' : 'Copy Positions'}
          </button>
          <div style={{ marginTop: 12, color: '#64748b', fontSize: 11 }}>
            {zones.map((z) => (
              <div key={z.id}>
                {z.id}: ({z.x},{z.y})
              </div>
            ))}
          </div>
        </div>
      </Html>
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Main export — switches between normal and edit mode
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  const [editMode] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('edit'),
  );

  if (editMode) return <EditMode />;

  return (
    <Suspense fallback={null}>
      <group>
        {buildingZones.map((zone) => (
          <GLBBuilding key={zone.id} zone={zone} />
        ))}
      </group>
    </Suspense>
  );
}
