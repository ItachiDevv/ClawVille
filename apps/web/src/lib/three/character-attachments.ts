import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

export type CharacterAttachmentState = 'idle' | 'moving';

interface AttachmentAnchor {
  bone: VRMHumanBoneName;
  pos: [number, number, number];
  rotDeg: [number, number, number];
  scaleMult?: number;
}

interface CharacterAttachment {
  url: string;
  /** Target prop length as a fraction of the avatar's pre-render-scale height. */
  lengthFrac: number;
  anchors: Record<CharacterAttachmentState, AttachmentAnchor>;
}

// Anchor transforms tuned live against the built preview (2026-07-30, this
// avatar + this sword asset; QC-harness handle window.__PREVIEW_VRM_SCENE on
// /preview/hermes). Units are BONE-LOCAL (raw Meshy rig ≈ cm). The sword GLB
// is authored grip-up (+Y), blade-down (−Y), origin at its center; the
// runtime local scale resolves to ≈78.2 for this pair, so the idle Y of 61
// places the grip center (asset +0.78) in the palm after the 180° X flip.
const ANSEM_SWORD_IDLE_POS: [number, number, number] = [0, 61, 0];
const ANSEM_SWORD_IDLE_ROT_DEG: [number, number, number] = [180, 0, 0];
// Back carry: upperChest-local +Z is the character's FRONT for this rig, so
// the sword sits at −16 behind the spine, tilted 40° — grip over the right
// shoulder, tip past the left hip, resting on (not inside) the coat.
const ANSEM_SWORD_MOVING_POS: [number, number, number] = [0, -4, -16];
const ANSEM_SWORD_MOVING_ROT_DEG: [number, number, number] = [0, 0, 40];

const CHARACTER_ATTACHMENTS: Record<string, CharacterAttachment> = {
  ansem: {
    url: '/avatars/ansem-sword.glb',
    lengthFrac: 0.80,
    anchors: {
      // Right-hand grip, blade down-forward in the Meshy 334 idle.
      idle: {
        bone: 'rightHand',
        pos: ANSEM_SWORD_IDLE_POS,
        rotDeg: ANSEM_SWORD_IDLE_ROT_DEG,
      },
      // Slung diagonally across the back, grip above the right shoulder.
      moving: {
        bone: 'upperChest',
        pos: ANSEM_SWORD_MOVING_POS,
        rotDeg: ANSEM_SWORD_MOVING_ROT_DEG,
      },
    },
  },
};

interface CachedAttachmentAsset {
  scene: THREE.Group;
  nativeLength: number;
}

const ATTACHMENT_ASSET_CACHE = new Map<string, Promise<CachedAttachmentAsset>>();
let _attachmentLoader: GLTFLoader | null = null;

const _attachmentBox = new THREE.Box3();
const _attachmentSize = new THREE.Vector3();
const _attachmentSceneScale = new THREE.Vector3();
const _attachmentBoneWorldScale = new THREE.Vector3();
const _attachmentSceneWorldScale = new THREE.Vector3();
const DEG_TO_RAD = Math.PI / 180;

function getAttachmentLoader(): GLTFLoader {
  if (_attachmentLoader) return _attachmentLoader;
  _attachmentLoader = new GLTFLoader();
  _attachmentLoader.setMeshoptDecoder(MeshoptDecoder);
  return _attachmentLoader;
}

function loadAttachmentAsset(url: string): Promise<CachedAttachmentAsset> {
  const cached = ATTACHMENT_ASSET_CACHE.get(url);
  if (cached) return cached;

  const pending = getAttachmentLoader().loadAsync(url).then((gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    _attachmentBox.setFromObject(scene);
    _attachmentBox.getSize(_attachmentSize);
    const nativeLength = Math.max(_attachmentSize.x, _attachmentSize.y, _attachmentSize.z);
    if (!(nativeLength > 0) || !Number.isFinite(nativeLength)) {
      throw new Error(`[character-attachments] Degenerate attachment bounds: ${url}`);
    }
    return { scene, nativeLength };
  });

  ATTACHMENT_ASSET_CACHE.set(url, pending);
  return pending;
}

/**
 * Measure the rendered avatar silhouette in VRM-local units. This runs only for
 * configured characters, before VRMCharacterAnimator patches skeleton.update().
 */
function measureAvatarNativeHeight(vrm: VRM): number {
  const scene = vrm.scene;
  _attachmentSceneScale.copy(scene.scale);
  scene.scale.setScalar(1);
  scene.updateMatrixWorld(true);

  scene.traverse((object) => {
    const skinned = object as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) skinned.skeleton.update();
  });

  _attachmentBox.setFromObject(scene);
  _attachmentBox.getSize(_attachmentSize);
  scene.getWorldScale(_attachmentSceneWorldScale);
  const inheritedScaleY = Math.abs(_attachmentSceneWorldScale.y) || 1;
  const nativeHeight = _attachmentSize.y / inheritedScaleY;

  scene.scale.copy(_attachmentSceneScale);
  scene.updateMatrixWorld(true);
  return nativeHeight;
}

/**
 * Bone scale relative to vrm.scene. Meshy rigs carry a 0.01 armature scale;
 * dividing out the scene's render scale keeps attachment sizing native-space
 * correct while allowing the parent bone to apply the final avatar render scale.
 */
function measureBoneScaleInAvatarSpace(vrm: VRM, bone: THREE.Object3D): number {
  vrm.scene.updateWorldMatrix(true, true);
  bone.getWorldScale(_attachmentBoneWorldScale);
  vrm.scene.getWorldScale(_attachmentSceneWorldScale);

  const sx = Math.abs(_attachmentBoneWorldScale.x / (_attachmentSceneWorldScale.x || 1));
  const sy = Math.abs(_attachmentBoneWorldScale.y / (_attachmentSceneWorldScale.y || 1));
  const sz = Math.abs(_attachmentBoneWorldScale.z / (_attachmentSceneWorldScale.z || 1));
  return Math.max(sx, sy, sz);
}

class CharacterAttachmentController {
  private readonly avatarNativeHeight: number;
  private wrapper: THREE.Group | null = null;
  private assetNativeLength = 0;
  private desiredState: CharacterAttachmentState = 'idle';
  private appliedState: CharacterAttachmentState | null = null;
  private disposed = false;

  constructor(
    private readonly vrm: VRM,
    private readonly spec: CharacterAttachment,
  ) {
    this.avatarNativeHeight = measureAvatarNativeHeight(vrm);
  }

  async init(initialState: CharacterAttachmentState): Promise<void> {
    this.desiredState = initialState;
    const asset = await loadAttachmentAsset(this.spec.url);
    if (this.disposed) return;

    const wrapper = new THREE.Group();
    wrapper.name = 'character-attachment';
    // Disable culling on the wrapper only. Child mesh culling remains intact.
    wrapper.frustumCulled = false;
    wrapper.add(asset.scene.clone(true));

    this.assetNativeLength = asset.nativeLength;
    this.wrapper = wrapper;
    this.applyState(this.desiredState);
  }

  setState(state: CharacterAttachmentState): void {
    this.desiredState = state;
    this.applyState(state);
  }

  private applyState(state: CharacterAttachmentState): void {
    if (!this.wrapper || this.appliedState === state) return;

    const anchorSpec = this.spec.anchors[state];
    const bone = this.vrm.humanoid?.getRawBoneNode(anchorSpec.bone);
    if (!bone) {
      console.warn(
        `[character-attachments] Missing ${anchorSpec.bone} bone for ${this.spec.url}`,
      );
      return;
    }

    const boneScale = measureBoneScaleInAvatarSpace(this.vrm, bone);
    if (!(boneScale > 0) || !(this.avatarNativeHeight > 0) || !(this.assetNativeLength > 0)) {
      console.warn(`[character-attachments] Invalid sizing inputs for ${this.spec.url}`);
      return;
    }

    const localScale =
      (this.avatarNativeHeight * this.spec.lengthFrac / this.assetNativeLength / boneScale) *
      (anchorSpec.scaleMult ?? 1);

    // Object3D.add reparents automatically. This path runs only on state changes.
    bone.add(this.wrapper);
    this.wrapper.position.set(anchorSpec.pos[0], anchorSpec.pos[1], anchorSpec.pos[2]);
    this.wrapper.rotation.set(
      anchorSpec.rotDeg[0] * DEG_TO_RAD,
      anchorSpec.rotDeg[1] * DEG_TO_RAD,
      anchorSpec.rotDeg[2] * DEG_TO_RAD,
    );
    this.wrapper.scale.setScalar(localScale);
    this.appliedState = state;
  }

  dispose(): void {
    this.disposed = true;
    this.wrapper?.removeFromParent();
    // The cloned hierarchy shares cached geometry/material references. Do not
    // dispose them here; dropping the wrapper is the cosmetic-loader contract.
    this.wrapper = null;
    this.appliedState = null;
  }
}

export function createCharacterAttachmentController(
  vrm: VRM,
  animatorId?: string,
): CharacterAttachmentController | null {
  if (!animatorId) return null;
  const spec = CHARACTER_ATTACHMENTS[animatorId];
  return spec ? new CharacterAttachmentController(vrm, spec) : null;
}
