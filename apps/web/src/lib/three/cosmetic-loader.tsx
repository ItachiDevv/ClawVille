'use client';

/**
 * cosmetic-loader.tsx — Phase 3.3 cosmetic render pipeline
 *
 * Subscribes to the user's equipped cosmetics and renders them on top of the
 * existing avatar mesh. Categories handled:
 *
 *   hat / glasses — GLB attached to a bone anchor (Head / J_Bip_C_Head)
 *   palette       — texture albedo swap on the avatar body material
 *   aura          — GLSL sphere shader around the avatar root
 *   particle      — emitParticles() calls into the existing particle pool
 *   board         — GLB prop displayed only in reef-race context, at player pos
 *   outfit        — stub (complex; deferred to follow-up per plan)
 *
 * Safety invariants (from memory):
 *   - NEVER use drei <Text> or <Billboard> — hard crash on Iris Xe
 *   - NEVER InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NEVER import 'three/webgpu' here — this component lives inside the
 *     main world R3F canvas which uses WebGLRenderer. NodeMaterial in a
 *     WebGLRenderer causes a per-frame .replace() crash on undefined.
 *   - compileAsync is called once after the aura material mounts
 *   - All geometry / material refs are module-scope or useRef — zero per-frame
 *     new THREE.Vector3() allocations
 *   - Dispose everything on unmount (Iris Xe leaks fast)
 */

import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useQuery } from '@tanstack/react-query';
import { emitParticles } from '@/lib/three/particle-system';
import { applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import {
  computeCosmeticHeadFit,
  hideHeadGeometryUnderHat,
  SCALP_HIDE_RADIUS_FACTOR,
  type CosmeticHeadFitResult,
} from '@/lib/three/vrm-avatar-sizing';

// Scratch objects for equip-time calculations — never allocated per frame.
// Declared module-scope so they're never re-created per effect run.
const _scratchSize   = new THREE.Vector3();
const _scratchScale  = new THREE.Vector3();
const _scratchBox    = new THREE.Box3();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row from GET /api/cosmetics/owned */
export interface OwnedCosmetic {
  id: string;
  equipped: boolean;
  sku: {
    id: string;
    slug: string;
    category: string; // 'hat' | 'glasses' | 'aura' | 'board' | 'particle' | 'outfit' | 'palette'
    scope: string;    // 'world' | 'avatar' | 'activity:reef-race' | 'all' | ...
    displayName: string;
  };
  variants: Array<{
    id: string;
    rigType: string; // 'milady-vrm' | 'lobster' | 'crab' | 'reef-race-board' | 'universal' | ...
    assetUrl: string;
    assetMeta: Record<string, unknown> | null;
  }>;
}

export interface OwnedCosmeticsResponse {
  owned: OwnedCosmetic[];
  generatedAt: string;
}

/** Which scene context the loader is rendering into */
export type CosmeticContext =
  | 'world'
  | 'activity:reef-race'
  | 'activity:bumper-shells';

/** Props for <CosmeticLoader /> */
export interface CosmeticLoaderProps {
  /** The avatar's ID — used as the React Query cache key */
  avatarId: string;
  /**
   * The avatar's rig type. Determines which variant is selected.
   * Must match a `rigType` value in cosmetic_variants. Pass 'universal' for
   * any humanoid VRM rig — the loader prefers 'universal' variants first.
   * Non-humanoid rigs (lobster, crab, etc.) receive no hat/glasses placement.
   */
  rigType: 'milady-vrm' | 'lobster' | 'crab' | 'universal' | string;
  /**
   * Current scene context. Board cosmetics only render when
   * context === 'activity:reef-race'. World cosmetics render everywhere except
   * activity-specific scenes, unless their scope is 'all'.
   */
  context: CosmeticContext;
  /**
   * The Three.js Object3D that is the avatar root (or scene root for boards).
   * All bone lookups and children are attached to / relative to this object.
   */
  parentObject: THREE.Object3D;
  /**
   * Optional: the loaded VRM instance for HUMANOID avatars.
   * When provided, HatOrGlassesRenderer uses computeCosmeticHeadFit() for
   * proportion-aware placement — the cosmetic is scaled to the avatar's
   * actual head size and positioned at the correct height/forward-offset.
   *
   * When absent (non-humanoid GLB avatars), the renderer falls back to the
   * legacy bone-name lookup path (findHeadBone). Hat/glasses on non-humanoid
   * rigs are a Phase D concern.
   */
  vrm?: Pick<VRM, 'humanoid' | 'scene'> | null;
  /**
   * The world render scale applied to vrm.scene (from computeVRMAvatarFit).
   * Required by computeCosmeticHeadFit to convert head metrics from rig-native
   * units to world units. Ignored when vrm is absent.
   */
  vrmRenderScale?: number;
  /** Avatar rig key (e.g. 'hermes', 'chibi') for per-rig fit overrides
   *  (RIG_HEAD_OVERRIDE in vrm-avatar-sizing). Derived from the avatar's
   *  animatorId. Omit/undefined → pure auto-fit (correct for well-rigged VRMs). */
  avatarRigKey?: string;
  /** Optional scene budget/safety allowlist. Omitted means all equipped SKUs. */
  allowedSkuSlugs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Module-scope GLTFLoader with MeshoptDecoder (shared, lazy-init)
// ---------------------------------------------------------------------------

let _loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!_loader) {
    _loader = new GLTFLoader();
    (_loader as any).setMeshoptDecoder(MeshoptDecoder);
  }
  return _loader;
}

// ---------------------------------------------------------------------------
// Module-scope geometry / material for the aura sphere (shared, never disposed)
// Created once on first aura mount, reused across all instances.
// ---------------------------------------------------------------------------

let _auraGeo: THREE.SphereGeometry | null = null;
function getAuraGeometry(): THREE.SphereGeometry {
  if (!_auraGeo) {
    // 32-segment sphere, slightly larger than avatar bounding sphere.
    // Segments high enough to look smooth at typical zoom, low enough for Iris Xe.
    _auraGeo = new THREE.SphereGeometry(1, 20, 14);
  }
  return _auraGeo;
}

// ---------------------------------------------------------------------------
// Scope / context compatibility
// ---------------------------------------------------------------------------

/**
 * Returns true if a SKU with the given scope is renderable in the current context.
 */
function scopeCompatible(skuScope: string, context: CosmeticContext): boolean {
  if (skuScope === 'all') return true;
  if (skuScope === 'world') return context === 'world';
  if (skuScope === context) return true; // e.g. 'activity:reef-race' === 'activity:reef-race'
  if (skuScope === 'avatar') return context === 'world'; // avatar cosmetics are world-only
  return false;
}

/**
 * Pick the best variant for the current rig.
 * Priority: exact rig match > 'universal' > first available row.
 *
 * The "first available" fallback prevents nothing rendering when the DB still
 * has legacy rows under a specific rigType (e.g. 'milady-vrm') while the
 * caller passes 'universal'. Without this fallback: exact=undefined,
 * universal=undefined → null → NOTHING renders (BUG 3).
 */
function pickVariant(
  variants: OwnedCosmetic['variants'],
  rigType: string,
): OwnedCosmetic['variants'][0] | null {
  const exact     = variants.find((v) => v.rigType === rigType);
  const universal = variants.find((v) => v.rigType === 'universal');
  return exact ?? universal ?? variants[0] ?? null;
}

// ---------------------------------------------------------------------------
// Bone anchor helper
// ---------------------------------------------------------------------------

/**
 * Find a bone by name inside an Object3D hierarchy.
 *
 * Checks common naming conventions used across VRM and standard glTF rigs:
 *   - VRM 0.x / Mixamo: 'J_Bip_C_Head' or 'mixamorig:Head' / 'mixamorigHead'
 *   - Standard glTF: 'Head' or 'head'
 *   - Custom: whatever boneAnchor is set to in assetMeta
 *
 * Returns the first matching Object3D or null.
 */
export function findBone(
  root: THREE.Object3D,
  boneName: string,
): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (found) return;
    // Exact match first (fastest path)
    if (child.name === boneName) {
      found = child;
      return;
    }
    // Case-insensitive match for 'head' variants
    const nameLower = child.name.toLowerCase();
    const targetLower = boneName.toLowerCase();
    if (nameLower === targetLower) {
      found = child;
    }
  });
  return found;
}

/**
 * Find the head bone using a prioritised list of known names.
 * Returns the first match or null.
 */
function findHeadBone(root: THREE.Object3D): THREE.Object3D | null {
  // VRM 0.x canonical / Mixamo sanitised / plain glTF / fallback
  const candidates = [
    'J_Bip_C_Head',
    'mixamorigHead',
    'mixamorig:Head',
    'Head',
    'head',
    'Bip001_Head',
  ];
  for (const name of candidates) {
    const bone = findBone(root, name);
    if (bone) return bone;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aura GLSL shader (WebGL-safe, no TSL)
//
// Reason for GLSL instead of TSL:
//   The main world scene uses R3F's default Canvas → WebGLRenderer (plain
//   'three' import). NodeMaterial / MeshBasicNodeMaterial in that context
//   causes per-frame ".replace() on undefined" crashes (gotcha documented in
//   memory: two-three-instances-nodemat-webgl-crash.md). The aura must use
//   ShaderMaterial with raw GLSL.
//
//   For WebGPU activity scenes (reef-race / bumper-shells), the board cosmetic
//   also uses MeshStandardMaterial (no shader) so there's no TSL needed there
//   either.
// ---------------------------------------------------------------------------

const AURA_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURA_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uOpacity;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  // Fresnel: brighter at glancing angles
  float fresnel = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
  fresnel = pow(fresnel, 2.0);

  // Pulsing glow via sine wave on uTime
  float pulse = 0.7 + 0.3 * sin(uTime * uSpeed);

  float alpha = fresnel * pulse * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * Create a ShaderMaterial for the aura effect.
 * Returns [material, uniformsRef] so the caller can update uTime each frame.
 */
function createAuraMaterial(
  color: THREE.Color,
  speed: number,
): { mat: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uColor:   { value: color.clone() },
    uTime:    { value: 0 },
    uSpeed:   { value: speed },
    uOpacity: { value: 0.7 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader:   AURA_VERT,
    fragmentShader: AURA_FRAG,
    transparent:    true,
    depthWrite:     false,
    side:           THREE.FrontSide,
    blending:       THREE.AdditiveBlending,
  });
  return { mat, uniforms };
}

// ---------------------------------------------------------------------------
// GLB asset cache — avoid re-loading the same asset URL multiple times
// per session. Maps assetUrl → loaded THREE.Group (cloned per use).
// ---------------------------------------------------------------------------

const GLB_CACHE = new Map<string, THREE.Group>();
const GLB_LOADING = new Map<string, Promise<THREE.Group>>();

async function loadGlbAsset(assetUrl: string): Promise<THREE.Group> {
  if (GLB_CACHE.has(assetUrl)) {
    return GLB_CACHE.get(assetUrl)!.clone(true);
  }
  if (GLB_LOADING.has(assetUrl)) {
    const base = await GLB_LOADING.get(assetUrl)!;
    return base.clone(true);
  }

  const promise = new Promise<THREE.Group>((resolve, reject) => {
    getLoader().load(
      assetUrl,
      (gltf) => {
        const group = gltf.scene;
        // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
        // 2026-05-22 perf wave 3). Hat/glasses GLBs may contain SkinnedMesh nodes
        // whose T-pose spheres are too tight for animated poses. applyFattenedFrustumCulling
        // fattens each sphere by 1.6× and re-enables culling so accessories attached to
        // off-screen avatars are correctly skipped. Idempotent via _fattenedBy tag.
        applyFattenedFrustumCulling(group);
        GLB_CACHE.set(assetUrl, group);
        resolve(group.clone(true));
      },
      undefined,
      reject,
    );
  });

  GLB_LOADING.set(assetUrl, promise.then((g) => {
    GLB_LOADING.delete(assetUrl);
    return g;
  }));

  return promise;
}

// ---------------------------------------------------------------------------
// useEquippedCosmetics hook
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

async function fetchOwnedCosmetics(): Promise<OwnedCosmeticsResponse> {
  const res = await fetch(`${API_BASE}/api/cosmetics/owned`, {
    credentials: 'include',
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Unauthenticated — empty inventory, no error
      return { owned: [], generatedAt: new Date().toISOString() };
    }
    throw new Error(`cosmetics/owned ${res.status}`);
  }
  return res.json();
}

/**
 * Subscribes to the avatar's equipped cosmetics via React Query.
 * Re-fetches every 30s so equip/unequip from the drawer propagates quickly.
 *
 * Returns only SKUs that are equipped=true and have at least one variant.
 */
export function useEquippedCosmetics(
  avatarId: string,
  context: CosmeticContext,
  rigType: string,
): OwnedCosmetic[] {
  // IMPORTANT: query key must match `useOwnedCosmetics()` in
  // use-cosmetics.ts so that the drawer's optimistic equip/unequip
  // mutations propagate to the live render instantly. avatarId is kept on the
  // signature for forward-compat with multi-avatar rendering (NPC cosmetics)
  // but is intentionally NOT in the cache key today — the API resolves
  // ownership from the session cookie, so all callers share a single
  // 'caller-avatar' cache slot.
  //
  // Polling tuning (perf audit 2026-04-29 #2): cosmetics only change when
  // the user equips something via the drawer, which goes through
  // `useEquipCosmetic()` and explicitly invalidates this query key. The
  // previous 30s+refetchOnWindowFocus combo fired a fresh /owned fetch
  // every alt-tab return AND every 30s of play, each one cascading through
  // a useMemo + reconciler pass inside an active R3F useFrame loop on Iris
  // Xe (causing visible jitter spikes). Dropped to 120s polling and
  // disabled focus refetch — equip mutations remain instant via the
  // explicit invalidate path.
  void avatarId;
  const { data } = useQuery<OwnedCosmeticsResponse>({
    queryKey:   ['cosmetics', 'owned'],
    queryFn:    fetchOwnedCosmetics,
    staleTime:  120_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: false,
    // Don't throw on auth failure — the hook returns empty
    retry:      false,
  });

  return useMemo(() => {
    if (!data?.owned) return [];
    return data.owned.filter((item) => {
      if (!item.equipped) return false;
      if (!scopeCompatible(item.sku.scope, context)) return false;
      const variant = pickVariant(item.variants, rigType);
      return variant !== null;
    });
  }, [data, context, rigType]);
}

// ---------------------------------------------------------------------------
// Per-cosmetic renderers
// ---------------------------------------------------------------------------

/**
 * HatOrGlassesRenderer — attaches a GLB to a head bone.
 *
 * Phase B (2026-06-07): When `vrm` + `vrmRenderScale` are provided, uses
 * `computeCosmeticHeadFit()` for proportion-aware placement (axis-sign safe,
 * works across all humanoid rigs: Milady, Hermes, Tekk, Phanes, chibi).
 *
 * Any per-item assetMeta nudge (offsetXYZ / scaleHint / rotationXYZ) is
 * applied ON TOP of the computed fit so artists can tweak individual items
 * without breaking the universal baseline.
 *
 * Fallback (legacy path): when vrm is absent, falls back to findHeadBone()
 * with the raw assetMeta offsets.  This covers non-humanoid GLB avatars
 * (Phase D) and any callsite that hasn't been wired up yet.
 */
function HatOrGlassesRenderer({
  parentObject,
  variant,
  category,
  vrm,
  vrmRenderScale,
  avatarRigKey,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
  category: 'hat' | 'glasses';
  vrm?: CosmeticLoaderProps['vrm'];
  vrmRenderScale?: number;
  avatarRigKey?: string;
  // onDispose accepted for backwards compat but no longer used — React's
  // own useEffect cleanup handles disposal correctly across variant changes.
  onDispose?: (fn: () => void) => void;
}) {
  // Re-run effect whenever asset content changes (URL or meta). Including
  // assetMeta as a JSON-stringified dep means changing offsetXYZ/scale/etc
  // via re-seed automatically re-attaches with the new values without a
  // page reload. Also re-runs if the VRM changes (vrm identity check via
  // vrm?.scene?.uuid).
  const metaKey = JSON.stringify(variant.assetMeta ?? {});
  const vrmSceneId = vrm?.scene?.uuid ?? 'no-vrm';

  useEffect(() => {
    const meta = variant.assetMeta ?? {};
    // Per-item assetMeta nudge — applied ON TOP of auto-fit.
    const nudgeOffsetXYZ = (meta.offsetXYZ as [number, number, number] | undefined) ?? [0, 0, 0];
    const nudgeScaleMult = (meta.scaleHint as number | undefined) ??
                          (meta.scale as number | undefined) ?? 1;
    const rotationXYZ = (meta.rotationXYZ as [number, number, number] | undefined) ?? [0, 0, 0];
    // Legacy boneAnchor (only used when VRM fit is unavailable)
    const boneAnchorName = (meta.boneAnchor as string | undefined) ?? null;

    let mounted = true;
    let attachedGroup: THREE.Group | null = null;
    let anchor: THREE.Object3D | null = null;
    let scalpRestore: (() => void) | null = null;

    loadGlbAsset(variant.assetUrl).then((glbGroup) => {
      if (!mounted) {
        // Component unmounted (or effect re-ran) while loading — dispose
        // the loaded GLB so it doesn't leak.
        glbGroup.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            (c as THREE.Mesh).geometry?.dispose();
            const mat = (c as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose();
          }
        });
        return;
      }

      // ─── Phase B: proportion-aware head fit (humanoid VRM path) ──────────
      let fit: CosmeticHeadFitResult | null = null;
      if (vrm && vrmRenderScale) {
        fit = computeCosmeticHeadFit(vrm, category, vrmRenderScale, avatarRigKey);
      }

      if (fit) {
        // AUTO-FIT PATH: anchor = raw head bone (the bone the animator drives).
        // getRawBoneNode returns the same Object3D that is the parent of the
        // head geometry; parenting to it means the cosmetic follows head
        // animation naturally (the animator drives it via the VRMCharacterAnimator
        // order: mixer.update → vrm.update → updateMatrixWorld).
        anchor = vrm!.humanoid?.getRawBoneNode?.('head') ?? findHeadBone(parentObject);
        if (!anchor) {
          console.warn('[CosmeticLoader] VRM has no head bone, attaching at root', variant.assetUrl);
          anchor = parentObject;
        }

        // BUG 2 FIX — asset-aware, bone-scale-aware local scale.
        //
        // The cosmetic Group is parented to the head bone whose world scale
        // already includes the avatar render-scale (~169–320×). Setting
        // localScale = desiredWorldWidth / 30 was wrong: effective world size
        // = boneWorldScale × groupLocalScale, so we need:
        //
        //   groupLocalScale = desiredWorldWidth / (assetWidth × boneWorldScale)
        //
        // where assetWidth is the GLB's authored X-axis span (glbGroup not yet
        // added to any scene so it is in authored/asset-local units).
        //
        // If assetWidth is 0 or cannot be measured (degenerate asset), fall
        // back to a scale of 1.0 so we at least render something visible.
        _scratchBox.setFromObject(glbGroup);
        _scratchBox.getSize(_scratchSize);
        const assetWidth = _scratchSize.x;

        anchor.getWorldScale(_scratchScale);
        const boneWorldScaleX = _scratchScale.x;

        let groupLocalScale: number;
        if (assetWidth > 1e-6 && boneWorldScaleX > 1e-6) {
          groupLocalScale = (fit.desiredWorldWidth / (assetWidth * boneWorldScaleX)) * nudgeScaleMult;
          // Clamp to a sane range to guard against degenerate inputs.
          groupLocalScale = Math.max(0.01, Math.min(1000, groupLocalScale));
        } else {
          // Degenerate asset or bone scale — fall back so something renders.
          groupLocalScale = nudgeScaleMult;
          console.warn('[CosmeticLoader] Cannot measure asset width or bone scale; using fallback scale', variant.assetUrl, { assetWidth, boneWorldScaleX });
        }

        attachedGroup = new THREE.Group();
        attachedGroup.name = `cosmetic-${category}-${variant.id}`;
        // Apply computed position then add nudge on top.
        attachedGroup.position.copy(fit.localPosition);
        attachedGroup.position.x += nudgeOffsetXYZ[0];
        attachedGroup.position.y += nudgeOffsetXYZ[1];
        attachedGroup.position.z += nudgeOffsetXYZ[2];
        // Scale: asset-aware + bone-scale-corrected local scale.
        attachedGroup.scale.setScalar(groupLocalScale);
        attachedGroup.rotation.set(rotationXYZ[0], rotationXYZ[1], rotationXYZ[2]);
        attachedGroup.frustumCulled = false;
        attachedGroup.add(glbGroup);
        anchor.add(attachedGroup);

        // Hide the head/scalp geometry UNDER the hat so baked-in hair can't poke
        // through it (most avatars are a single fused mesh; see hideHeadGeometryUnderHat).
        if (category === 'hat' && vrm) {
          attachedGroup.updateWorldMatrix(true, false);
          const hatWorld = new THREE.Vector3();
          attachedGroup.getWorldPosition(hatWorld);
          scalpRestore = hideHeadGeometryUnderHat(
            vrm,
            hatWorld.y,
            hatWorld.x,
            hatWorld.z,
            fit.headWidthWU * SCALP_HIDE_RADIUS_FACTOR,
          );
        }
      } else {
        // ─── LEGACY PATH: bone name lookup + raw assetMeta offsets ──────────
        // Used for non-humanoid avatars (Phase D) and fallback when vrm is
        // absent.  Preserves previous behaviour exactly.
        anchor = boneAnchorName
          ? (findBone(parentObject, boneAnchorName) ?? findHeadBone(parentObject))
          : findHeadBone(parentObject);

        if (!anchor) {
          console.warn('[CosmeticLoader] No head bone found, attaching at root', variant.assetUrl);
          anchor = parentObject;
        }

        attachedGroup = new THREE.Group();
        attachedGroup.name = `cosmetic-${category}-${variant.id}`;
        attachedGroup.position.set(nudgeOffsetXYZ[0], nudgeOffsetXYZ[1], nudgeOffsetXYZ[2]);
        attachedGroup.scale.setScalar(nudgeScaleMult);
        attachedGroup.rotation.set(rotationXYZ[0], rotationXYZ[1], rotationXYZ[2]);
        // Intentionally kept false on this Group wrapper (not a SkinnedMesh / Mesh).
        // A Group's frustum test uses its children's world AABBs; leaving it true
        // would cull the wrapper before Three.js checks the children's actual bounds.
        // The GLB meshes INSIDE (glbGroup) already have correct culling applied by
        // applyFattenedFrustumCulling in loadGlbAsset above.
        attachedGroup.frustumCulled = false;
        attachedGroup.add(glbGroup);
        anchor.add(attachedGroup);
      }
    }).catch((err) => {
      console.error('[CosmeticLoader] Failed to load hat/glasses GLB', variant.assetUrl, err);
    });

    return () => {
      mounted = false;
      if (scalpRestore) { scalpRestore(); scalpRestore = null; } // restore hidden head geometry
      if (attachedGroup && anchor) {
        anchor.remove(attachedGroup);
        attachedGroup.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            (c as THREE.Mesh).geometry?.dispose();
            const mat = (c as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose();
          }
        });
        attachedGroup = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.assetUrl, variant.id, metaKey, parentObject, vrmSceneId, category, vrmRenderScale]);

  return null;
}

// ---------------------------------------------------------------------------
// AuraRenderer — GLSL shader sphere around avatar root
// ---------------------------------------------------------------------------

function AuraRenderer({
  parentObject,
  variant,
  onDispose,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
  onDispose: (fn: () => void) => void;
}) {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    const meta = variant.assetMeta ?? {};
    const rawColor = (meta.color as string | number | undefined) ?? 0x44aaff;
    const speed = (meta.speed as number | undefined) ?? 1.5;
    // Scale the sphere to be ~1.5× the avatar's approximate world radius.
    // Default avatar radius ~22 wu (half of 45wu height). Can be overridden in meta.
    const radius = (meta.radius as number | undefined) ?? 35;

    const color = new THREE.Color(rawColor);
    const { mat, uniforms } = createAuraMaterial(color, speed);

    const geo = getAuraGeometry();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `cosmetic-aura-${variant.id}`;
    mesh.scale.setScalar(radius);
    mesh.frustumCulled = false;

    parentObject.add(mesh);

    // compileAsync after attach — eliminates the first-frame pipeline hitch.
    // Guard: WebGPU renderer may not have compileAsync (it has compile instead);
    // WebGLRenderer r170+ has it. Use feature-detect.
    if (typeof (gl as any).compileAsync === 'function') {
      ;(gl as any).compileAsync(mesh, camera, scene).catch((err: unknown) => {
        console.warn('[CosmeticLoader] compileAsync failed for aura', err);
      });
    }

    // Store uniforms ref so the frame loop can update uTime
    // We communicate via the mesh's userData
    mesh.userData.cosmeticUniforms = uniforms;

    onDispose(() => {
      parentObject.remove(mesh);
      mat.dispose();
      // Do NOT dispose geo — it's module-scope shared
    });
  }, [variant, parentObject, gl, scene, camera, onDispose]);

  return null;
}

// ---------------------------------------------------------------------------
// Pearl of the Depths — one merged draw, both renderer backends
// ---------------------------------------------------------------------------

const PEARL_AURA_ASSET = 'builtin:pearl-of-depths-aura';

function PearlAuraRenderer({
  parentObject,
  variant,
  worldScale = 1,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
  worldScale?: number;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  const meta = variant.assetMeta ?? {};
  const color = String(meta.color ?? '#d9fff7');
  const orbitRadiusWu = Number(meta.orbitRadiusWu ?? 72);
  const pearlRadiusWu = Number(meta.pearlRadiusWu ?? 8);
  const orbitHeightWu = Number(meta.orbitHeightWu ?? 112);
  const orbitSpeed = Number(meta.orbitSpeed ?? 0.85);
  const safeScale = Math.max(0.001, worldScale);

  const resources = useMemo(() => {
    const sources: THREE.BufferGeometry[] = [];
    try {
      for (let index = 0; index < 6; index++) {
        const angle = index / 6 * Math.PI * 2;
        const pearl = new THREE.IcosahedronGeometry(pearlRadiusWu / safeScale, 1);
        pearl.translate(
          Math.cos(angle) * orbitRadiusWu / safeScale,
          Math.sin(angle * 2) * 10 / safeScale,
          Math.sin(angle) * orbitRadiusWu / safeScale,
        );
        sources.push(pearl);
      }
      const geometry = mergeGeometries(sources, false);
      if (!geometry) throw new Error('Pearl aura geometry merge failed');
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const group = new THREE.Group();
      group.position.y = orbitHeightWu / safeScale;
      group.add(new THREE.Mesh(geometry, material));
      return { group, geometry, material };
    } finally {
      for (const source of sources) source.dispose();
    }
  }, [color, orbitHeightWu, orbitRadiusWu, pearlRadiusWu, safeScale]);

  useEffect(() => {
    groupRef.current = resources.group;
    parentObject.add(resources.group);
    return () => {
      groupRef.current = null;
      parentObject.remove(resources.group);
      resources.geometry.dispose();
      resources.material.dispose();
    };
  }, [parentObject, resources]);

  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * orbitSpeed;
  });
  return null;
}

// ---------------------------------------------------------------------------
// ParticleRenderer — wraps emitParticles() at a throttled rate
// ---------------------------------------------------------------------------

function ParticleRenderer({
  parentObject,
  variant,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
}) {
  const accRef = useRef(0);
  const meta = variant.assetMeta ?? {};
  // emitRate: particles per second. Default 2/s (light ambient effect).
  const emitRate = (meta.emitRate as number | undefined) ?? 2;
  // lifetime not directly controllable via emitParticles() API — handled by pool
  const particleType = (meta.particleType as string | undefined) ?? 'sparkle';

  // Scratch vector — reused every frame, zero alloc
  const scratchPos = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    accRef.current += delta;
    const interval = 1 / emitRate;
    if (accRef.current < interval) return;
    accRef.current -= interval;

    // Get world position of the avatar root for the particle spawn point
    parentObject.getWorldPosition(scratchPos);
    emitParticles({
      type: particleType as any,
      x: scratchPos.x,
      y: scratchPos.y + 20, // spawn slightly above avatar feet
      z: scratchPos.z,
      count: 1,
    });
  });

  return null;
}

// ---------------------------------------------------------------------------
// BoardRenderer — surf board prop (reef-race context only)
// Attaches the GLB at the player's world-space position offset by yOffset.
// The board floats just below the avatar.
// ---------------------------------------------------------------------------

function BoardRenderer({
  parentObject,
  variant,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
  onDispose?: (fn: () => void) => void;
}) {
  const metaKey = JSON.stringify(variant.assetMeta ?? {});

  useEffect(() => {
    const meta = variant.assetMeta ?? {};
    const yOffset = (meta.yOffset as number | undefined) ?? -8;

    let mounted = true;
    let wrapper: THREE.Group | null = null;

    loadGlbAsset(variant.assetUrl).then((glbGroup) => {
      if (!mounted) {
        glbGroup.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            (c as THREE.Mesh).geometry?.dispose();
            const mat = (c as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose();
          }
        });
        return;
      }

      wrapper = new THREE.Group();
      wrapper.name = `cosmetic-board-${variant.id}`;
      wrapper.position.set(0, yOffset, 0);
      wrapper.frustumCulled = false;
      wrapper.add(glbGroup);
      parentObject.add(wrapper);
    }).catch((err) => {
      console.error('[CosmeticLoader] Failed to load board GLB', variant.assetUrl, err);
    });

    return () => {
      mounted = false;
      if (wrapper) {
        parentObject.remove(wrapper);
        wrapper.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            (c as THREE.Mesh).geometry?.dispose();
            const mat = (c as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose();
          }
        });
        wrapper = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.assetUrl, variant.id, metaKey, parentObject]);

  return null;
}

// ---------------------------------------------------------------------------
// PaletteRenderer — texture albedo swap on avatar materials
//
// Finds all MeshStandardMaterial / MeshBasicMaterial instances on the
// parentObject that match the uvMap region specified in assetMeta. Swaps
// their map property to the palette texture loaded from assetUrl.
//
// Limitation: this is a whole-material swap. Full UV-region-specific palette
// painting (only the region described by assetMeta.uvMap) requires a canvas
// composite blit — deferred to a follow-up once we have actual palette assets.
// For Phase 3 launch with the surfboard test bed this path is not exercised.
// ---------------------------------------------------------------------------

function PaletteRenderer({
  parentObject,
  variant,
  onDispose,
}: {
  parentObject: THREE.Object3D;
  variant: OwnedCosmetic['variants'][0];
  onDispose: (fn: () => void) => void;
}) {
  useEffect(() => {
    const loader = new THREE.TextureLoader();
    let mounted = true;
    const originalMaps = new Map<THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, THREE.Texture | null>();

    loader.load(
      variant.assetUrl,
      (texture) => {
        if (!mounted) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;

        // Collect and patch all body materials on the avatar
        parentObject.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mesh = child as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            if (
              mat instanceof THREE.MeshStandardMaterial ||
              mat instanceof THREE.MeshBasicMaterial
            ) {
              // Skip MToon materials (VRM) — they have their own map structure
              if ((mat as any).isMToonMaterial) continue;
              originalMaps.set(mat, mat.map);
              mat.map = texture;
              mat.needsUpdate = true;
            }
          }
        });
      },
      undefined,
      (err) => {
        console.error('[CosmeticLoader] Failed to load palette texture', variant.assetUrl, err);
      },
    );

    onDispose(() => {
      mounted = false;
      // Restore original maps
      for (const [mat, originalMap] of originalMaps) {
        mat.map = originalMap;
        mat.needsUpdate = true;
      }
      originalMaps.clear();
    });
  }, [variant, parentObject, onDispose]);

  return null;
}

// ---------------------------------------------------------------------------
// OutfitRenderer — stub for Phase 3 launch
//
// Full Marvelous Designer GLB skin binding is complex (skinned mesh attachment,
// morph matching, secondary bone registration). This stub logs a warning and
// does nothing. The slot is wired so outfit variants in the DB don't cause
// errors — they just silently skip rendering until the follow-up implements it.
// ---------------------------------------------------------------------------

function OutfitRenderer({ variant }: { variant: OwnedCosmetic['variants'][0] }) {
  useEffect(() => {
    console.info(
      '[CosmeticLoader] Outfit rendering deferred to Phase 3 follow-up.',
      variant.assetUrl,
    );
  }, [variant]);
  return null;
}

// ---------------------------------------------------------------------------
// Aura frame-loop updater
// Must live inside the R3F tree (uses useFrame). Finds all aura meshes by
// userData tag and updates their uTime uniform.
// ---------------------------------------------------------------------------

function AuraFrameUpdater({ parentObject }: { parentObject: THREE.Object3D }) {
  useFrame((_, delta) => {
    parentObject.traverse((child) => {
      const uniforms = child.userData?.cosmeticUniforms as
        | Record<string, THREE.IUniform>
        | undefined;
      if (!uniforms?.uTime) return;
      uniforms.uTime.value += delta;
    });
  });
  return null;
}

// ---------------------------------------------------------------------------
// CosmeticLoader — main component
// ---------------------------------------------------------------------------

/**
 * Renders all equipped cosmetics for an avatar onto its avatar.
 *
 * Mount inside the R3F Canvas, as a sibling or child of the avatar component.
 * parentObject must be the live Three.js Object3D of the avatar root.
 *
 * Example:
 *   <CosmeticLoader
 *     avatarId={avatar.id}
 *     rigType="universal"
 *     context="world"
 *     parentObject={vrm.scene}
 *     vrm={vrm}
 *     vrmRenderScale={vrmRenderScale}
 *   />
 */
export function CosmeticLoader({
  avatarId,
  rigType,
  context,
  parentObject,
  vrm,
  vrmRenderScale,
  avatarRigKey,
  allowedSkuSlugs,
}: CosmeticLoaderProps) {
  const equipped = useEquippedCosmetics(avatarId, context, rigType);
  const renderableEquipped = useMemo(() => {
    if (!allowedSkuSlugs) return equipped;
    return equipped.filter((item) => allowedSkuSlugs.includes(item.sku.slug));
  }, [allowedSkuSlugs, equipped]);

  // Dispose registry: maps cosmetic skin id → cleanup fn
  // Populated by each per-category renderer via the onDispose callback.
  const disposeRegistry = useRef<Map<string, () => void>>(new Map());

  // When the equipped list changes, clean up any renderers that are no longer
  // in the list, then let React render the new ones.
  const prevEquippedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(renderableEquipped.map((e) => e.id));

    // Dispose cosmetics that were removed
    for (const [id, disposeFn] of disposeRegistry.current) {
      if (!currentIds.has(id)) {
        disposeFn();
        disposeRegistry.current.delete(id);
      }
    }

    prevEquippedIds.current = currentIds;
  }, [renderableEquipped]);

  // Cleanup everything on unmount
  useEffect(() => {
    return () => {
      for (const disposeFn of disposeRegistry.current.values()) {
        disposeFn();
      }
      disposeRegistry.current.clear();
    };
  }, []);

  /**
   * onDispose callback factory — called by per-category renderers to
   * register their cleanup function. The id is the avatar_skins.id (unique per
   * owned cosmetic), so each renderer slot has exactly one cleanup entry.
   */
  const makeOnDispose = useCallback(
    (id: string) => (fn: () => void) => {
      // If this slot already has a disposer (e.g. variant changed), run old one first
      const existing = disposeRegistry.current.get(id);
      if (existing) existing();
      disposeRegistry.current.set(id, fn);
    },
    [],
  );

  const hasShaderAura = renderableEquipped.some((item) => {
    if (item.sku.category !== 'aura') return false;
    return pickVariant(item.variants, rigType)?.assetUrl !== PEARL_AURA_ASSET;
  });

  return (
    <>
      {hasShaderAura && <AuraFrameUpdater parentObject={parentObject} />}

      {renderableEquipped.map((item) => {
        const variant = pickVariant(item.variants, rigType);
        if (!variant) return null;

        const cat = item.sku.category;
        const onDispose = makeOnDispose(item.id);

        if (cat === 'aura' && variant.assetUrl === PEARL_AURA_ASSET) {
          return (
            <PearlAuraRenderer
              key={item.id}
              parentObject={parentObject}
              variant={variant}
              worldScale={vrmRenderScale}
            />
          );
        }

        if (cat === 'hat' || cat === 'glasses') {
          return (
            <HatOrGlassesRenderer
              key={item.id}
              parentObject={parentObject}
              variant={variant}
              category={cat as 'hat' | 'glasses'}
              vrm={vrm}
              vrmRenderScale={vrmRenderScale}
              avatarRigKey={avatarRigKey}
            />
          );
        }

        if (cat === 'aura') {
          return (
            <AuraRenderer
              key={item.id}
              parentObject={parentObject}
              variant={variant}
              onDispose={onDispose}
            />
          );
        }

        if (cat === 'particle') {
          return (
            <ParticleRenderer
              key={item.id}
              parentObject={parentObject}
              variant={variant}
            />
          );
        }

        if (cat === 'board' && context === 'activity:reef-race') {
          return (
            <BoardRenderer
              key={item.id}
              parentObject={parentObject}
              variant={variant}
              onDispose={onDispose}
            />
          );
        }

        if (cat === 'palette') {
          // Phase B guard: PaletteRenderer is a stub (UV-region blit not implemented).
          // Returning null prevents log spam from OutfitRenderer and avoids any
          // unexpected material mutations on the player avatar until the full
          // canvas-composite blit is built. DB palette rows are safe — they just
          // don't visually render yet.
          return null;
        }

        if (cat === 'outfit') {
          // Phase B guard: OutfitRenderer is a stub (Marvelous Designer skin binding
          // not implemented). Returning null suppresses the console.info noise that
          // the previous stub emitted on every equipped outfit row.
          return null;
        }

        if (cat === 'emote') {
          // Emotes are not rendered as 3D geometry. Equipping an emote
          // just adds it to the player's emote hotbar; the trigger flows
          // through the emote-bus and VRMCharacterAnimator.playOneShot.
          // Returning null here keeps the loader from logging an unknown
          // category every render.
          return null;
        }

        return null;
      })}
    </>
  );
}

export default CosmeticLoader;
