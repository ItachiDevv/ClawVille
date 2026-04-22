'use client';

/**
 * TownGuide — the new town-center anchor for ClawVille.
 *
 * Replaces the paused Bazaar Pedestals, Bounty Board, and Auction Podium that
 * formerly occupied world center. She stands at (0, GROUND_Y, 0), is ~150 world
 * units tall, and will gain Eliza teacher chat wiring in Phase 2.
 *
 * Model: /models/guide.glb
 *   - Native height: ~1.49m, scale ≈ 100 → ~149 world units
 *   - Faces roughly -Z at rest
 *   - Key bones: Hips_04 (skirt parent), Chest_06 (breathing), Head_031 (look-around)
 *   - Cloth material (opacity=0) hides most clothing; we selectively override Shoes
 *
 * Procedural idle:
 *   - Head_031: gentle Y-axis drift (sin, 0.4 Hz, ±0.05 rad)
 *   - Chest_06: subtle scale.y breathing (sin, 1.8 Hz, ±0.008)
 *
 * Skirt: CylinderGeometry cone parented to Hips_04, dark navy #1e3a5f, DoubleSide
 *
 * GPU constraints:
 *   - Plain `three` imports (NOT three/webgpu) — skinned body/face/hair materials
 *     are stock MeshStandardMaterial from the GLB loader; they work on either renderer
 *   - NO drei Text/Billboard — Iris Xe crash (documented in memory)
 *   - NO InstancedMesh + ShaderMaterial — WebGPU silent crash
 *   - No per-frame allocations — all scratch objects at module scope
 *
 * Phase 2 TODO: wire onClick to open guide chat (Eliza teacher, 11th character)
 */

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

// ---------------------------------------------------------------------------
// Preload at module scope — non-critical, deferred via Suspense fallback={null}
// ---------------------------------------------------------------------------
useGLTF.preload('/models/guide.glb');

// ---------------------------------------------------------------------------
// World position constants
// ---------------------------------------------------------------------------
// GROUND_Y = -2: matches the sand floor Y used by all other center objects
// (bazaar-pedestals BASE_Y=-2, bounty-board BOARD_Y=-2, auction-podium floor=-2).
// guide.glb feet sit at y≈0 in model space; the scale group lifts geometry above
// floor by bone offsets, so GROUND_Y=-2 gives correct floor contact.
const GROUND_Y = -2;

// GUIDE_Z = +240 places her DECISIVELY south of the auction podium's ground-level
// footprint (podium at z=+50 with 144u bottom radius → south edge at z=+194).
// First Rev-3 attempt used z=+100 but her body half-depth (~37u) still put her
// inside the podium's base ring; she rendered as "head peeking over podium" from
// player POV. z=+240 clears the edge by ~46u so she stands fully in front, with
// the podium visible as a landmark ~190u behind her from player spawn at z=+380.
const GUIDE_Z = 240;

// ---------------------------------------------------------------------------
// Scale — native height 1.49m, target ~150 world units
// ---------------------------------------------------------------------------
const GUIDE_SCALE = 100; // 100 × 1.49 = 149 world units

// ---------------------------------------------------------------------------
// Materials — created once per module load, reused across mounts
// ---------------------------------------------------------------------------

// Replacement shoe material (the cloth material has opacity=0; we only show shoes)
const _shoeMaterial = new THREE.MeshStandardMaterial({
  color: 0x111111,
  roughness: 0.5,
  metalness: 0.1,
});

// Procedural skirt — cone, double-sided, dark navy
const _skirtMaterial = new THREE.MeshStandardMaterial({
  color: 0x1e3a5f,
  roughness: 0.7,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

// Open-ended cone: top radius 0.08m, bottom radius 0.25m, height 0.42m, 20 segments
// open=true so no caps (saves 2 fill triangles; skirt reads as fabric, not a solid)
const _skirtGeometry = new THREE.CylinderGeometry(0.08, 0.25, 0.42, 20, 1, true);

// ---------------------------------------------------------------------------
// Module-scope scratch — NEVER allocate in useFrame
// ---------------------------------------------------------------------------
const _scratchEuler = new THREE.Euler();

// ---------------------------------------------------------------------------
// TownGuideInner — loaded inside <Suspense fallback={null}>
// ---------------------------------------------------------------------------
const TownGuideInner = memo(function TownGuideInner() {
  const groupRef  = useRef<THREE.Group>(null!);

  // Bone refs — populated in useMemo after clone
  const headBoneRef     = useRef<THREE.Bone | null>(null);
  const chestBoneRef    = useRef<THREE.Bone | null>(null);
  const hipBoneRef      = useRef<THREE.Bone | null>(null);
  const upperArmLRef    = useRef<THREE.Bone | null>(null);
  const upperArmRRef    = useRef<THREE.Bone | null>(null);
  const lowerArmLRef    = useRef<THREE.Bone | null>(null);
  const lowerArmRRef    = useRef<THREE.Bone | null>(null);

  // Skirt mesh ref — parented to Hips_04 after clone
  const skirtRef = useRef<THREE.Mesh | null>(null);

  const { scene: gltfScene } = useGLTF('/models/guide.glb');

  // Clone the scene using SkeletonUtils to preserve the full skinned rig.
  // Plain scene.clone(true) does not rebind SkinnedMesh.skeleton correctly —
  // all clones share the same bones and stomp each other's pose matrices.
  // SkeletonUtils.clone() creates independent bone trees + rebinds each SkinnedMesh.
  const cloned = useMemo(() => {
    const clone = skeletonClone(gltfScene) as THREE.Group;

    // Walk clone tree: fix cloth material visibility
    clone.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const hasCloth = mats.some(
        (m) => m && (m as THREE.MeshStandardMaterial).name === 'cloth'
      );
      if (!hasCloth) return;

      // Shoes: make opaque with our shoe material
      if (mesh.name === 'Shoes_low_cloth_0') {
        mesh.material = _shoeMaterial;
        mesh.visible  = true;
        return;
      }

      // All other cloth meshes (coat, scarf, buttons, pants waistband, torso deco):
      // hide entirely — cheaper than opacity=0 on blended geometry
      mesh.visible = false;
    });

    // Find key bones — exact match for known names, regex for mirror/index-suffixed
    clone.traverse((obj) => {
      if (!(obj as THREE.Bone).isBone) return;
      const bone = obj as THREE.Bone;
      const n = bone.name;

      if (n === 'Head_031')  headBoneRef.current  = bone;
      if (n === 'Chest_06')  chestBoneRef.current = bone;
      if (n === 'Hips_04')   hipBoneRef.current   = bone;

      // Arm bones — Sketchfab export adds `_NNN` suffix. Left-side known exact,
      // right-side uses regex since the index isn't predictable.
      if (n === 'Upper_arm_L_08')                     upperArmLRef.current = bone;
      if (n === 'Lower_arm_L_09')                     lowerArmLRef.current = bone;
      if (/^Upper_arm_R(\.|_)/i.test(n) && !upperArmRRef.current) upperArmRRef.current = bone;
      if (/^Lower_arm_R(\.|_)/i.test(n) && !lowerArmRRef.current) lowerArmRRef.current = bone;
    });

    // -------------------------------------------------------------------------
    // REST POSE — rotate arms down from the authored T-pose so she doesn't look
    // like she's doing airplane arms. The rig is Sketchfab/Blender-exported with
    // bone local Y along length; rotating the upper arm ~1.2 rad around local Z
    // swings it from horizontal (T-pose) to near-vertical at the side.
    // Mirrored sign for the right arm. Sub-rad values leave arms slightly away
    // from the torso for a natural relaxed stance (not a rigid attention pose).
    // If deploy shows the axis/sign is wrong, flip here and redeploy.
    // -------------------------------------------------------------------------
    if (upperArmLRef.current) upperArmLRef.current.rotation.z = -1.20;
    if (upperArmRRef.current) upperArmRRef.current.rotation.z =  1.20;
    // Slight forward bend at the elbows so forearms don't stick straight out
    if (lowerArmLRef.current) lowerArmLRef.current.rotation.x =  0.15;
    if (lowerArmRRef.current) lowerArmRRef.current.rotation.x =  0.15;

    // Attach procedural skirt to Hips_04
    const hipBone = hipBoneRef.current;
    if (hipBone) {
      const skirtMesh = new THREE.Mesh(_skirtGeometry, _skirtMaterial);
      // Hang 0.22m below the hip joint center in model (bone-local) space.
      // guide.glb native height is 1.49m; hips are roughly at 0.85m (57% of height).
      // 0.22m below hips → ~0.63m from floor = mid-thigh region at native scale.
      skirtMesh.position.set(0, -0.22, 0);
      skirtMesh.name = 'ProceduralSkirt';
      hipBone.add(skirtMesh);
      skirtRef.current = skirtMesh;
    }

    return clone;
  }, [gltfScene]);

  // Dispose cloned geometry + materials on unmount
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Only dispose non-module-scope materials (the GLB's own materials, not
        // _shoeMaterial or _skirtMaterial which live for the lifetime of the module)
        if (
          mesh.material !== _shoeMaterial &&
          mesh.material !== _skirtMaterial
        ) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material?.dispose();
          }
        }
        // Geometry: only dispose the skirt (all others belong to the cached GLTF)
        if (mesh.name === 'ProceduralSkirt') {
          // _skirtGeometry is module-scope and reused — do NOT dispose it here.
          // The mesh itself is cloned, but geometry is shared. Leave it.
        }
      });
    };
  }, [cloned]);

  // Procedural idle — no allocations, no matrix rebuilds beyond bone mutations
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;

    // Head: gentle Y-axis look-around drift — 0.4 Hz, ±0.05 rad
    const head = headBoneRef.current;
    if (head) {
      head.rotation.y = Math.sin(t * (Math.PI * 2 * 0.4)) * 0.05;
    }

    // Chest: subtle breathing scale — 1.8 Hz, ±0.008
    const chest = chestBoneRef.current;
    if (chest) {
      chest.scale.y = 1 + Math.sin(t * 1.8) * 0.008;
    }

    // Arms: tiny sway around the static rest pose so she's not a frozen statue.
    // Stays additive with the rest-pose rotation.z values set at clone time.
    const armL = upperArmLRef.current;
    if (armL) {
      armL.rotation.z = -1.20 + Math.sin(t * 0.9) * 0.025;
      armL.rotation.x =         Math.sin(t * 1.1 + 0.7) * 0.02;
    }
    const armR = upperArmRRef.current;
    if (armR) {
      armR.rotation.z =  1.20 + Math.sin(t * 0.9 + Math.PI) * 0.025;
      armR.rotation.x =         Math.sin(t * 1.1 + 2.1) * 0.02;
    }
  });

  return (
    <group
      ref={groupRef}
      position={[0, GROUND_Y, GUIDE_Z]}
      onClick={(e) => {
        e.stopPropagation();
        // TODO Phase 2: open guide chat (Eliza teacher, 11th character)
        console.log('[TownGuide] guide clicked — Phase 2 will wire chat here');
      }}
      onPointerEnter={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'auto';
      }}
    >
      <group scale={[GUIDE_SCALE, GUIDE_SCALE, GUIDE_SCALE]}>
        <primitive object={cloned} />
      </group>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Public export — Suspense boundary so GLB miss doesn't crash the scene
// ---------------------------------------------------------------------------
export default function TownGuide() {
  return (
    <Suspense fallback={null}>
      <TownGuideInner />
    </Suspense>
  );
}
