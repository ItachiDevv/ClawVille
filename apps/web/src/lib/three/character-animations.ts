import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Universal Character Animation System
//
// Works for any static GLB — no hardcoded part names, no InstancedMesh.
// Each character type gets a tailored animation profile built from spatial
// heuristics: the model is analysed once at load time, then animated every
// frame using pure math (sin/cos, easing, phase offsets).
//
// Two top-level states:
//   idle  — standing on select platform or at building
//   walk  — moving through the game world
//
// All oscillators use a per-character seed so NPCs never look in-sync.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Character types (maps to MODEL_REGISTRY keys)
// ---------------------------------------------------------------------------

export type CharacterType =
  | 'crab'
  | 'lobster_plush'
  | 'hermit_crab'
  | 'anime'
  | 'jellyfish'
  | 'octopus'
  | 'seahorse'
  | 'generic';

/** Map MODEL_REGISTRY keys → CharacterType */
export const MODEL_KEY_TO_TYPE: Record<string, CharacterType> = {
  sweet_crab:    'crab',
  lobster_plush: 'lobster_plush',
  hermitcrab:    'hermit_crab',
  // chihiro / priestess / chibi_goku removed 2026-04-21 — GLBs deleted from disk.
  // Replaced by 8 Milady VRM avatars which use VRMCharacterAnimator, not this map.
  jellyfish:     'jellyfish',
  octopus:       'octopus',
  seahorse:      'seahorse',
  // Existing models keep their LobsterAnimator — these are fallbacks
  lobster:       'generic',
  crayfish:      'generic',
};

// ---------------------------------------------------------------------------
// Discovered geometry — result of one-time spatial analysis
// ---------------------------------------------------------------------------

export interface CharacterGeometry {
  /** The root THREE.Group/Object3D for the model */
  root: THREE.Object3D;
  /** Whole-model bounding box (world space, after clone) */
  modelBox: THREE.Box3;
  modelCenter: THREE.Vector3;
  modelSize: THREE.Vector3;
  /** Top of model Y (for oscillation baseline) */
  topY: number;
  /** Bottom of model Y */
  bottomY: number;
  /** All meshes sorted largest→smallest by volume */
  byVolume: MeshData[];
  /** Meshes in the upper third */
  upperMeshes: MeshData[];
  /** Meshes in the middle third */
  middleMeshes: MeshData[];
  /** Meshes in the lower third */
  lowerMeshes: MeshData[];
  /** Meshes left of centre */
  leftMeshes: MeshData[];
  /** Meshes right of centre */
  rightMeshes: MeshData[];
  /** Meshes in the front half (model-space -Z) */
  frontMeshes: MeshData[];
  /** Meshes in the back half (model-space +Z) */
  backMeshes: MeshData[];
  /** Elongated meshes (thin appendages) */
  appendages: MeshData[];
}

export interface MeshData {
  mesh: THREE.Mesh;
  box: THREE.Box3;
  size: THREE.Vector3;
  center: THREE.Vector3;
  volume: number;
  /** How elongated: max(dims) / median(dims) */
  elongation: number;
}

// ---------------------------------------------------------------------------
// Analyser — call once per cloned GLB
// ---------------------------------------------------------------------------

export function analyseCharacter(root: THREE.Object3D): CharacterGeometry {
  // Force matrix world update so bounding boxes are accurate
  root.updateWorldMatrix(true, true);

  const all: MeshData[] = [];
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const volume = size.x * size.y * size.z;
    if (volume < 0.0001) return; // skip degenerate

    const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
    const elongation = dims[0] / (dims[1] + 0.0001);

    all.push({ mesh, box, size, center, volume, elongation });
  });

  if (all.length === 0) {
    // Return empty placeholder
    const dummy = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const mc = new THREE.Vector3();
    const ms = new THREE.Vector3(2, 2, 2);
    return {
      root, modelBox: dummy, modelCenter: mc, modelSize: ms,
      topY: 1, bottomY: -1,
      byVolume: [], upperMeshes: [], middleMeshes: [], lowerMeshes: [],
      leftMeshes: [], rightMeshes: [], frontMeshes: [], backMeshes: [],
      appendages: [],
    };
  }

  const modelBox = new THREE.Box3().setFromObject(root);
  const modelCenter = new THREE.Vector3();
  modelBox.getCenter(modelCenter);
  const modelSize = new THREE.Vector3();
  modelBox.getSize(modelSize);
  const topY    = modelBox.max.y;
  const bottomY = modelBox.min.y;

  const upperThreshold  = modelCenter.y + modelSize.y * 0.17;
  const lowerThreshold  = modelCenter.y - modelSize.y * 0.17;
  const sideThreshold   = modelSize.x  * 0.06;
  const frontThreshold  = modelCenter.z;

  const byVolume   = [...all].sort((a, b) => b.volume - a.volume);
  const appendages = all.filter((m) => m.elongation > 2.5);

  return {
    root, modelBox, modelCenter, modelSize,
    topY, bottomY,
    byVolume,
    upperMeshes:  all.filter((m) => m.center.y  > upperThreshold),
    middleMeshes: all.filter((m) => m.center.y >= lowerThreshold && m.center.y <= upperThreshold),
    lowerMeshes:  all.filter((m) => m.center.y  < lowerThreshold),
    leftMeshes:   all.filter((m) => m.center.x  < modelCenter.x - sideThreshold),
    rightMeshes:  all.filter((m) => m.center.x  > modelCenter.x + sideThreshold),
    frontMeshes:  all.filter((m) => m.center.z  < frontThreshold),
    backMeshes:   all.filter((m) => m.center.z  > frontThreshold),
    appendages,
  };
}

// ---------------------------------------------------------------------------
// Easing helpers (all plain functions — no allocations)
// ---------------------------------------------------------------------------

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}
function easeOutElastic(t: number): number {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}
function softLerp(current: number, target: number, speed: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-speed * dt));
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Per-character seed
// ---------------------------------------------------------------------------

export function idToSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 100; // 0..10
}

// ---------------------------------------------------------------------------
// The Animator class — one instance per character, kept alive for the session
// ---------------------------------------------------------------------------

export class CharacterAnimator {
  private geo: CharacterGeometry;
  private type: CharacterType;
  private seed: number;

  // Per-animator mutable state (no object allocations in hot path)
  private bodyBobY    = 0;
  private swayZ       = 0;
  private swayX       = 0;
  private scaleY      = 1;
  private scaleXZ     = 1;
  private groupRotX   = 0;
  private groupRotZ   = 0;
  private groupScaleY = 1;
  private groupScaleXZ= 1;

  // Jellyfish pulse state
  private bellScale   = 1;

  constructor(geo: CharacterGeometry, type: CharacterType, seed: number) {
    this.geo  = geo;
    this.type = type;
    this.seed = seed;
  }

  /**
   * Main entry point — call every frame.
   *
   * @param group      The outer THREE.Group whose scale/rotation is driven
   *                   (same group as animGroupRef in existing code)
   * @param elapsed    clock.elapsedTime
   * @param dt         clamped delta (Math.min(delta, 0.1))
   * @param isMoving   true when NPC is walking
   * @param walkPhase  continuous speed-matched phase for walk cycles
   */
  update(group: THREE.Group, elapsed: number, dt: number, isMoving: boolean, walkPhase = elapsed): void {
    const idleT = elapsed + this.seed;
    const walkT = walkPhase + this.seed;

    switch (this.type) {
      case 'crab':        isMoving ? this.walkCrab(group, walkT, dt)    : this.idleCrab(group, idleT, dt);    break;
      case 'lobster_plush': isMoving ? this.walkPlush(group, walkT, dt) : this.idlePlush(group, idleT, dt);   break;
      case 'hermit_crab': isMoving ? this.walkHermit(group, walkT, dt)  : this.idleHermit(group, idleT, dt);  break;
      case 'anime':       isMoving ? this.walkAnime(group, walkT, dt)   : this.idleAnime(group, idleT, dt);   break;
      case 'jellyfish':   isMoving ? this.walkJelly(group, walkT, dt)   : this.idleJelly(group, idleT, dt);   break;
      case 'octopus':     isMoving ? this.walkOcto(group, walkT, dt)    : this.idleOcto(group, idleT, dt);    break;
      case 'seahorse':    isMoving ? this.walkSeahorse(group, walkT, dt): this.idleSeahorse(group, idleT, dt);break;
      default:            isMoving ? this.walkGeneric(group, walkT, dt) : this.idleGeneric(group, idleT, dt); break;
    }

    // Always animate individual meshes for richness
    this.animateMeshes(isMoving ? walkT : idleT, dt, isMoving);
  }

  // =========================================================================
  // CRAB — sideways swagger, heavy claw-snap energy
  // =========================================================================

  private idleCrab(group: THREE.Group, t: number, dt: number): void {
    // Breathing: exaggerated belly puff (crabs breathe through gills in body)
    const breathe = Math.sin(t * 1.1) * 0.055 + Math.sin(t * 2.3) * 0.015;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,        6, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - breathe * 0.4,  6, dt);

    // Slow lateral sway — crabs rock side to side even when still
    const rock = Math.sin(t * 0.65) * 0.07 + Math.sin(t * 1.4 + 1.1) * 0.025;
    this.groupRotZ = softLerp(this.groupRotZ, rock, 4, dt);

    // Gentle forward/back shuffle (weight shift)
    const shift = Math.sin(t * 0.42) * 0.035;
    this.groupRotX = softLerp(this.groupRotX, shift, 3, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkCrab(group: THREE.Group, t: number, dt: number): void {
    const step = 9; // fast scuttle
    // Crabs walk sideways — the "bounce" is more horizontal shimmy than vertical
    const shimmy = Math.sin(t * step) * 0.06;
    const bounce  = Math.abs(Math.sin(t * step * 0.5)) * 0.04;

    this.groupScaleY  = softLerp(this.groupScaleY,  1 + bounce,        10, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - bounce * 0.3,  10, dt);

    // Rock harder when walking
    const rock = shimmy * 1.5;
    this.groupRotZ = softLerp(this.groupRotZ, rock, 8, dt);

    // Forward lean — crabs hunch forward
    this.groupRotX = softLerp(this.groupRotX, -0.1, 6, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // LOBSTER PLUSH — soft toy bouncy squash/stretch, plush weight
  // =========================================================================

  private idlePlush(group: THREE.Group, t: number, dt: number): void {
    // Plush toys have a heavy, dumpy sag — breathe slowly and deeply
    const breathe = Math.sin(t * 0.9) * 0.07;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,       5, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - breathe * 0.5, 5, dt);

    // Drunk wobble — soft toys tip over slightly
    const wobble = Math.sin(t * 0.55) * 0.09 + Math.sin(t * 1.3 + 0.8) * 0.03;
    this.groupRotZ = softLerp(this.groupRotZ, wobble, 3, dt);
    this.groupRotX = softLerp(this.groupRotX, Math.sin(t * 0.38) * 0.04, 2.5, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkPlush(group: THREE.Group, t: number, dt: number): void {
    const step = 6;
    // Very bouncy — plush stuffing makes each step exaggerated
    const bounce = Math.sin(t * step) * 0.22;
    const squash  = 1 + bounce;
    const squashXZ = 1 - bounce * 0.55;

    this.groupScaleY  = softLerp(this.groupScaleY,  squash,   12, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, squashXZ, 12, dt);

    const lean = Math.sin(t * step * 0.5) * 0.13;
    this.groupRotZ = softLerp(this.groupRotZ, lean, 8, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.18, 5, dt); // forward hunch

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // HERMIT CRAB — heavy shell, slow deliberate rock, shell-sway
  // =========================================================================

  private idleHermit(group: THREE.Group, t: number, dt: number): void {
    // Shell makes the whole body pendulum slowly
    const pendulum = Math.sin(t * 0.5) * 0.06 + Math.sin(t * 1.1 + 1.4) * 0.02;
    this.groupRotZ = softLerp(this.groupRotZ, pendulum, 2, dt);

    // Shell weight causes forward lean that oscillates slightly
    const forwardLean = -0.08 + Math.sin(t * 0.35) * 0.03;
    this.groupRotX = softLerp(this.groupRotX, forwardLean, 2, dt);

    // Gentle breathing scale — shell constrains expansion
    const breathe = Math.sin(t * 1.2) * 0.03;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,       3.5, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - breathe * 0.2, 3.5, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkHermit(group: THREE.Group, t: number, dt: number): void {
    const step = 5; // slower than crab — shell is heavy
    const bounce = Math.sin(t * step) * 0.08;
    // Shell causes more X sway than Y bounce when walking
    const sideRock = Math.sin(t * step * 0.5) * 0.12;

    this.groupScaleY  = softLerp(this.groupScaleY,  1 + bounce * 0.5, 8, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - bounce * 0.2, 8, dt);
    this.groupRotZ = softLerp(this.groupRotZ, sideRock, 6, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.12, 4, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // ANIME — human proportions, secondary motion, weight shift
  // =========================================================================

  private idleAnime(group: THREE.Group, t: number, dt: number): void {
    // Subtle chest breathing (barely visible — anime characters breathe finely)
    const breathe = Math.sin(t * 1.3) * 0.025 + Math.sin(t * 2.7) * 0.008;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,        7, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - breathe * 0.35, 7, dt);

    // Weight shift — hip sway, very gentle
    const hipSway = Math.sin(t * 0.45) * 0.035;
    this.groupRotZ = softLerp(this.groupRotZ, hipSway, 2.5, dt);

    // Micro rock — alive but not fidgety
    const rock = Math.sin(t * 0.67 + 1.2) * 0.018;
    this.groupRotX = softLerp(this.groupRotX, rock, 2, dt);

    // Subtle y float — underwater buoyancy even for humanoids
    const floatY = Math.sin(t * 0.6) * 0.008;
    group.position.y = floatY;

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkAnime(group: THREE.Group, t: number, dt: number): void {
    const step = 7;
    // Natural human gait bounce — less than cartoon
    const bounce = Math.sin(t * step) * 0.06;
    const lean   = Math.sin(t * step * 0.5) * 0.055;

    this.groupScaleY  = softLerp(this.groupScaleY,  1 + Math.abs(bounce) * 0.5, 10, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1,                          10, dt);
    this.groupRotZ = softLerp(this.groupRotZ, lean, 7, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.08, 5, dt); // subtle lean forward

    group.position.y = 0;
    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // JELLYFISH — pulsing bell, slow drift, tentacle flow
  // =========================================================================

  private idleJelly(group: THREE.Group, t: number, dt: number): void {
    // Bell contracts and expands — main defining motion
    // Use easeInOutSine for organic pulse
    const pulseRaw = (Math.sin(t * 1.6) + 1) * 0.5;    // 0..1
    const pulse    = easeInOutSine(pulseRaw);
    const bellScaleXZ = 1 + pulse * 0.18;
    const bellScaleY  = 1 - pulse * 0.12;

    this.bellScale    = softLerp(this.bellScale, pulse, 5, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, bellScaleXZ, 8, dt);
    this.groupScaleY  = softLerp(this.groupScaleY,  bellScaleY,  8, dt);

    // Drift — jellyfish rotate lazily in current
    const drift = Math.sin(t * 0.28) * 0.08 + Math.sin(t * 0.71 + 2.0) * 0.04;
    this.groupRotZ = softLerp(this.groupRotZ, drift, 1.5, dt);

    // Very slight tilt fore/aft
    const tilt = Math.sin(t * 0.35 + 1.5) * 0.04;
    this.groupRotX = softLerp(this.groupRotX, tilt, 1.5, dt);

    // Vertical drift — float up/down gently
    group.position.y = Math.sin(t * 0.4) * 0.12;

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkJelly(group: THREE.Group, t: number, dt: number): void {
    // Jellyfish propel by pulsing harder — faster contraction when moving
    const pulseRaw = (Math.sin(t * 2.8) + 1) * 0.5;
    const pulse    = easeInOutSine(pulseRaw);
    const bellScaleXZ = 1 + pulse * 0.28;
    const bellScaleY  = 1 - pulse * 0.2;

    this.groupScaleXZ = softLerp(this.groupScaleXZ, bellScaleXZ, 12, dt);
    this.groupScaleY  = softLerp(this.groupScaleY,  bellScaleY,  12, dt);

    // Slight forward lean during propulsion
    const sway = Math.sin(t * 2.8 * 0.5) * 0.06;
    this.groupRotX = softLerp(this.groupRotX, -0.07 + sway, 6, dt);
    this.groupRotZ = softLerp(this.groupRotZ, 0, 4, dt);

    group.position.y = Math.sin(t * 0.8) * 0.06;
    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // OCTOPUS — mantle pulse, sinuous tentacle wave on the group level
  // =========================================================================

  private idleOcto(group: THREE.Group, t: number, dt: number): void {
    // Mantle inflation/deflation (chromatophore breathing)
    const mantle = Math.sin(t * 0.9) * 0.07 + Math.sin(t * 2.1) * 0.025;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + mantle,        5, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - mantle * 0.45, 5, dt);

    // Drift — octopi have very fluid, directionless sway when resting
    const swayZ = Math.sin(t * 0.52) * 0.09 + Math.sin(t * 1.3 + 1.1) * 0.04;
    const swayX = Math.sin(t * 0.38 + 0.7) * 0.05;
    this.groupRotZ = softLerp(this.groupRotZ, swayZ, 2, dt);
    this.groupRotX = softLerp(this.groupRotX, swayX, 2, dt);

    // Float up/down
    group.position.y = Math.sin(t * 0.35) * 0.1;

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkOcto(group: THREE.Group, t: number, dt: number): void {
    // Jet propulsion — mantle pumps sharply
    const jetPhase = (t * 2.2) % (Math.PI * 2);
    const jet      = jetPhase < Math.PI ? Math.sin(jetPhase) : 0;
    const jelly    = easeOutElastic(clamp(jet, 0, 1));

    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 + jelly * 0.22,  15, dt);
    this.groupScaleY  = softLerp(this.groupScaleY,  1 - jelly * 0.18,  15, dt);

    const drift = Math.sin(t * 1.1) * 0.07;
    this.groupRotZ = softLerp(this.groupRotZ, drift, 5, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.1, 4, dt);

    group.position.y = Math.sin(t * 1.1) * 0.07;
    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // SEAHORSE — upright float, tail curl, dorsal fin flutter
  // =========================================================================

  private idleSeahorse(group: THREE.Group, t: number, dt: number): void {
    // Seahorses are nearly rigid — they float upright with tiny oscillations
    const floatY = Math.sin(t * 0.55) * 0.08;
    const tilter  = Math.sin(t * 0.38) * 0.06 + Math.sin(t * 1.1 + 0.9) * 0.025;

    this.groupRotZ = softLerp(this.groupRotZ, tilter, 2, dt);
    this.groupRotX = softLerp(this.groupRotX, Math.sin(t * 0.3) * 0.025, 1.5, dt);

    // Barely any scale change — rigid body
    const breathe = Math.sin(t * 1.4) * 0.015;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,       4, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1,                 4, dt);

    group.position.y = floatY;
    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkSeahorse(group: THREE.Group, t: number, dt: number): void {
    // Seahorse locomotion is pure dorsal fin — body stays nearly still,
    // a very slight forward lean and subtle wobble is all we add at group level
    const flutter = Math.sin(t * 18) * 0.012; // captured in mesh animation below
    const drift   = Math.sin(t * 0.6) * 0.04;

    this.groupRotZ = softLerp(this.groupRotZ, drift, 4, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.07, 3, dt);

    // Micro bob — unlike other creatures seahorse barely moves up/down
    group.position.y = Math.sin(t * 4) * 0.04;
    group.scale.set(1, 1, 1);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // GENERIC — good default for any model that doesn't match a specific type
  // =========================================================================

  private idleGeneric(group: THREE.Group, t: number, dt: number): void {
    const breathe = Math.sin(t * 1.5) * 0.055;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + breathe,       6, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - breathe * 0.4, 6, dt);

    const sway = Math.sin(t * 0.68) * 0.06 + Math.sin(t * 1.1 + 1.5) * 0.03;
    this.groupRotZ = softLerp(this.groupRotZ, sway, 4, dt);
    this.groupRotX = softLerp(this.groupRotX, Math.sin(t * 0.9) * 0.04, 3, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  private walkGeneric(group: THREE.Group, t: number, dt: number): void {
    const step  = 8;
    const bounce = Math.sin(t * step) * 0.18;
    this.groupScaleY  = softLerp(this.groupScaleY,  1 + bounce,       12, dt);
    this.groupScaleXZ = softLerp(this.groupScaleXZ, 1 - bounce * 0.5, 12, dt);

    const lean = Math.sin(t * step * 0.5) * 0.1;
    this.groupRotZ = softLerp(this.groupRotZ, lean, 8, dt);
    this.groupRotX = softLerp(this.groupRotX, -0.15, 6, dt);

    group.scale.set(this.groupScaleXZ, this.groupScaleY, this.groupScaleXZ);
    group.rotation.z = this.groupRotZ;
    group.rotation.x = this.groupRotX;
  }

  // =========================================================================
  // Per-mesh secondary motion — layered on top of group animation
  // These manipulate individual meshes directly for richer detail.
  // =========================================================================

  private animateMeshes(t: number, dt: number, isMoving: boolean): void {
    switch (this.type) {
      case 'crab':
      case 'hermit_crab':
        this.animateCrustaceanMeshes(t, dt, isMoving);
        break;
      case 'lobster_plush':
        this.animatePlushMeshes(t, dt, isMoving);
        break;
      case 'anime':
        this.animateAnimeMeshes(t, dt, isMoving);
        break;
      case 'jellyfish':
        this.animateJellyMeshes(t, dt, isMoving);
        break;
      case 'octopus':
        this.animateOctoMeshes(t, dt, isMoving);
        break;
      case 'seahorse':
        this.animateSeahorseMeshes(t, dt, isMoving);
        break;
      default:
        this.animateGenericMeshes(t, dt, isMoving);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Crustacean meshes: appendage wave, eye sway, antennae flutter
  // -----------------------------------------------------------------------
  private animateCrustaceanMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages, upperMeshes, leftMeshes, rightMeshes, lowerMeshes } = this.geo;
    const walkMult = isMoving ? 2.5 : 1;

    // Appendages (legs/antennae) — wave pattern from front to back
    appendages.forEach((md, i) => {
      const phase = i * 0.7;
      const side  = md.center.x < this.geo.modelCenter.x ? 1 : -1;
      if (isMoving) {
        // Alternating gait — pairs offset by PI
        const pair = Math.floor(i / 2);
        const gait = Math.sin(t * 10 * walkMult + pair * (Math.PI * 2 / 3)) * 0.35;
        md.mesh.rotation.z = softLerp(md.mesh.rotation.z, side * 0.5 + gait, 10, dt);
        md.mesh.rotation.x = softLerp(md.mesh.rotation.x, gait * 0.2, 8, dt);
      } else {
        const restSway = Math.sin(t * 1.5 + phase) * 0.05;
        md.mesh.rotation.z = softLerp(md.mesh.rotation.z, side * 0.5 + restSway, 3, dt);
        md.mesh.rotation.x = softLerp(md.mesh.rotation.x, 0, 2, dt);
      }
    });

    // Upper meshes (eye stalks / head area) — nod toward points of interest
    upperMeshes.slice(0, 2).forEach((md, i) => {
      const lookCycle = Math.sin(t * 0.4 + i * 1.2) * 0.08;
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x, lookCycle, 2, dt);
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, Math.sin(t * 0.55 + i) * 0.06, 2, dt);
    });

    // Claws — largest left/right meshes snap periodically
    const clawLeft  = leftMeshes.sort((a, b)  => b.volume - a.volume)[0];
    const clawRight = rightMeshes.sort((a, b) => b.volume - a.volume)[0];
    if (clawLeft && clawRight) {
      // Periodic claw snap: every ~4s one claw snaps forward
      const snapCycle = Math.floor(t / 4) % 2;
      const snapT     = (t % 4) / 4;
      const snapAngle = snapT < 0.15
        ? -0.6 * easeOutElastic(snapT / 0.15)
        : -0.6 * (1 - easeInOutSine(Math.min(1, (snapT - 0.15) / 0.4)));

      const leftTarget  = snapCycle === 0 ? snapAngle : Math.sin(t * 1.1) * 0.08;
      const rightTarget = snapCycle === 1 ? snapAngle : Math.sin(t * 1.1 + 1) * 0.08;

      clawLeft.mesh.rotation.x  = softLerp(clawLeft.mesh.rotation.x,  leftTarget,  6, dt);
      clawRight.mesh.rotation.x = softLerp(clawRight.mesh.rotation.x, rightTarget, 6, dt);
    }
  }

  // -----------------------------------------------------------------------
  // Plush meshes: soft cloth-like secondary wobble
  // -----------------------------------------------------------------------
  private animatePlushMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages, upperMeshes } = this.geo;

    // "Floppy" appendages — plush limbs flop around with lag
    appendages.forEach((md, i) => {
      const phase = i * 1.1;
      const speed = isMoving ? 6 : 1.5;
      const amp   = isMoving ? 0.25 : 0.08;
      const flopZ = Math.sin(t * speed + phase) * amp;
      const flopX = Math.sin(t * speed * 0.7 + phase + 1) * amp * 0.5;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, flopZ, isMoving ? 8 : 3, dt);
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x, flopX, isMoving ? 7 : 2.5, dt);
    });

    // Eyes — plush toys have big, expressive eyes that wobble
    upperMeshes.slice(0, 2).forEach((md, i) => {
      const bigWobble = Math.sin(t * 2.2 + i * Math.PI) * 0.1;
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x, bigWobble, 4, dt);
    });
  }

  // -----------------------------------------------------------------------
  // Anime meshes: hair flow, skirt/fabric secondary motion
  // -----------------------------------------------------------------------
  private animateAnimeMeshes(t: number, dt: number, isMoving: boolean): void {
    const { upperMeshes, appendages } = this.geo;

    // Upper meshes near top of model — likely hair — sway with wind/motion
    const topThird = upperMeshes.filter(
      (m) => m.center.y > this.geo.modelCenter.y + this.geo.modelSize.y * 0.25
    );

    topThird.forEach((md, i) => {
      const windFreq = isMoving ? 4.5 : 1.8;
      const windAmp  = isMoving ? 0.07 : 0.04;
      // Hair has a nice secondary wobble — offset each strand
      const hairSway = Math.sin(t * windFreq + i * 0.9) * windAmp
                     + Math.sin(t * windFreq * 0.6 + i * 1.4) * windAmp * 0.4;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, hairSway, isMoving ? 5 : 2.5, dt);
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x,
        Math.sin(t * windFreq * 0.8 + i) * windAmp * 0.3, 2, dt);
    });

    // Lower meshes — skirt/robe hem sways opposite to walk direction
    const lowerFabric = this.geo.lowerMeshes.filter(
      (m) => m.center.y < this.geo.modelCenter.y - this.geo.modelSize.y * 0.1
    );
    lowerFabric.forEach((md, i) => {
      const hemSway = isMoving
        ? Math.sin(t * 7 + i * 0.5) * 0.06
        : Math.sin(t * 0.8 + i * 1.2) * 0.025;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, hemSway, isMoving ? 9 : 2, dt);
    });

    // Arms/sleeves — any elongated upper appendages
    appendages
      .filter((m) => m.center.y > this.geo.modelCenter.y)
      .forEach((md, i) => {
        const swingAmp = isMoving ? 0.2 : 0.05;
        const swing    = Math.sin(t * (isMoving ? 7 : 1.2) + i * Math.PI) * swingAmp;
        md.mesh.rotation.x = softLerp(md.mesh.rotation.x, swing, isMoving ? 10 : 2.5, dt);
      });
  }

  // -----------------------------------------------------------------------
  // Jellyfish meshes: tentacle undulation
  // -----------------------------------------------------------------------
  private animateJellyMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages, lowerMeshes } = this.geo;
    const speed = isMoving ? 2.5 : 1.4;

    // Tentacles: wave propagates down from bell (top) to tips
    const tentacles = [...appendages, ...lowerMeshes]
      .filter((m) => m.center.y < this.geo.modelCenter.y)
      .sort((a, b) => b.center.y - a.center.y); // top-most first

    tentacles.forEach((md, i) => {
      // Higher tentacles (closer to bell) move LESS than lower ones
      const depthFactor = (i + 1) / Math.max(tentacles.length, 1);
      const amp  = 0.15 * depthFactor;
      const phase = i * 0.45;
      const wave  = Math.sin(t * speed + phase) * amp;

      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, wave, 3, dt);
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x,
        Math.sin(t * speed * 0.7 + phase + 0.8) * amp * 0.6, 2.5, dt);
    });
  }

  // -----------------------------------------------------------------------
  // Octopus meshes: 8 tentacle undulation, asymmetric
  // -----------------------------------------------------------------------
  private animateOctoMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages, lowerMeshes, leftMeshes, rightMeshes } = this.geo;
    const speed = isMoving ? 3 : 1.2;

    const tentacles = [
      ...appendages,
      ...lowerMeshes.filter((m) => m.center.y < this.geo.modelCenter.y),
    ].sort((a, b) => a.volume - b.volume); // thinnest = tentacle tips

    tentacles.forEach((md, i) => {
      // Octopus tentacles move in gorgeous undulating waves, each slightly offset
      const wave = Math.sin(t * speed + i * 0.78) * 0.2
                 + Math.sin(t * speed * 1.3 + i * 1.1 + 1.5) * 0.09;

      const side = md.center.x < this.geo.modelCenter.x ? 1 : -1;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z, wave, 4, dt);
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x,
        Math.sin(t * speed * 0.9 + i * 0.6) * 0.15, 3.5, dt);
    });
  }

  // -----------------------------------------------------------------------
  // Seahorse meshes: dorsal fin flutter + tail curl
  // -----------------------------------------------------------------------
  private animateSeahorseMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages, backMeshes, lowerMeshes } = this.geo;

    // Tail curl — the back/lower elongated meshes form the prehensile tail
    const tailParts = [...backMeshes, ...lowerMeshes]
      .filter((m) => m.center.y < this.geo.modelCenter.y)
      .sort((a, b) => a.center.y - b.center.y); // bottom-most first

    tailParts.forEach((md, i) => {
      // Tail curls rhythmically — wave travels from base (top) to tip (bottom)
      const curlPhase = (tailParts.length - 1 - i) / Math.max(tailParts.length - 1, 1);
      const curlAmp   = 0.12 * (1 + curlPhase); // tips curl more
      const curl      = Math.sin(t * 1.1 + curlPhase * 1.5) * curlAmp;

      md.mesh.rotation.x = softLerp(md.mesh.rotation.x, curl, 3, dt);
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z,
        Math.sin(t * 0.7 + curlPhase) * 0.05, 2, dt);
    });

    // Dorsal fin flutter — any small upper/front appendage
    const dorsals = appendages
      .filter((m) => m.center.y > this.geo.modelCenter.y - this.geo.modelSize.y * 0.15)
      .slice(0, 3);

    dorsals.forEach((md, i) => {
      const flutterSpeed = isMoving ? 22 : 14;
      const flutterAmp   = isMoving ? 0.08 : 0.05;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z,
        Math.sin(t * flutterSpeed + i * 0.4) * flutterAmp, 15, dt);
    });
  }

  // -----------------------------------------------------------------------
  // Generic meshes: appendage sway for any unclassified model
  // -----------------------------------------------------------------------
  private animateGenericMeshes(t: number, dt: number, isMoving: boolean): void {
    const { appendages } = this.geo;
    const speed = isMoving ? 6 : 1.5;
    const amp   = isMoving ? 0.18 : 0.06;

    appendages.forEach((md, i) => {
      const phase = i * 0.8;
      const side  = md.center.x < this.geo.modelCenter.x ? 1 : -1;
      md.mesh.rotation.z = softLerp(md.mesh.rotation.z,
        side * 0.4 + Math.sin(t * speed + phase) * amp, isMoving ? 8 : 2, dt);
      md.mesh.rotation.x = softLerp(md.mesh.rotation.x,
        Math.sin(t * speed * 0.7 + phase) * amp * 0.5, isMoving ? 6 : 2, dt);
    });
  }
}

// ---------------------------------------------------------------------------
// Factory — build the right animator for a model key.
// Call once after clone; store the result on the component ref.
// ---------------------------------------------------------------------------

export function createCharacterAnimator(
  modelKey: string,
  clonedScene: THREE.Object3D,
): CharacterAnimator {
  const type = MODEL_KEY_TO_TYPE[modelKey] ?? 'generic';
  const geo  = analyseCharacter(clonedScene);
  const seed = idToSeed(modelKey);
  return new CharacterAnimator(geo, type, seed);
}

// ---------------------------------------------------------------------------
// Colour tinting — replaces material colours with a lerp toward a tint.
// Reuses the same pattern as the existing code but is exported so
// character-animations.ts is the single import for setup.
// ---------------------------------------------------------------------------

/**
 * Module-scope tinted-material cache.
 *
 * Key: `${baseMaterial.uuid}|${tintHex}|${lerpFactor}|${emissiveIntensity}`
 *
 * Why this key is correct:
 *   - `baseMaterial.uuid` is stable and unique per source material instance.
 *     It ties the cached clone to the exact original color/roughness/etc.
 *   - `tintHex` captures the full 24-bit tint color.
 *   - `lerpFactor` and `emissiveIntensity` are call-time parameters that
 *     affect the output material; two calls with different values must
 *     produce different cached instances.
 *
 * Result: pipeline count drops from ~(numNPCs × numSubmeshes) ≈ 100 unique
 * materials to ~(numSpecies × numTintColors) ≈ 10-20.
 */
const _tintCache = new Map<string, THREE.Material>();

function _getTintedMaterial(
  baseMat: THREE.Material,
  tint: THREE.Color,
  lerpFactor: number,
  emissiveIntensity: number,
): THREE.Material {
  const tintHex = tint.getHex();
  const key = `${baseMat.uuid}|${tintHex}|${lerpFactor}|${emissiveIntensity}`;

  const cached = _tintCache.get(key);
  if (cached) return cached;

  // First time we've seen this (base, tint, params) combo — clone once, apply
  // tint, cache forever. The result is byte-identical to what the old per-call
  // clone() produced, just shared across all NPCs with the same combo.
  const tinted = (baseMat as THREE.MeshStandardMaterial).clone();
  (tinted as THREE.MeshStandardMaterial).color.lerp(tint, lerpFactor);
  (tinted as THREE.MeshStandardMaterial).emissive = tint.clone();
  (tinted as THREE.MeshStandardMaterial).emissiveIntensity = emissiveIntensity;

  _tintCache.set(key, tinted);
  return tinted;
}

export function applyColorTint(
  root: THREE.Object3D,
  tint: THREE.Color,
  lerpFactor = 0.6,
  emissiveIntensity = 0.2,
): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.material) return;

    // Handle multi-material meshes: apply tint to each slot independently.
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) =>
        _getTintedMaterial(m, tint, lerpFactor, emissiveIntensity)
      );
    } else {
      mesh.material = _getTintedMaterial(
        mesh.material,
        tint,
        lerpFactor,
        emissiveIntensity,
      );
    }
  });
}
