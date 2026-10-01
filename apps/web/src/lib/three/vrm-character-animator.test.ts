import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VRMHumanoid, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { retargetMeshyClip, retargetMixamoClip } from './mixamo-retarget';
import { applyTradingFloorSeatPose, tradingFloorSeatBones } from './trading-floor/trading-floor-sit';
import { MODEL_REGISTRY } from './agent-model-registry';
import { VRMCharacterAnimator, type AnimName } from './vrm-character-animator';

function harness() {
  const root = new THREE.Group();
  const bone = new THREE.Object3D();
  bone.name = 'dummy';
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  const names: AnimName[] = ['idle', 'walk', 'run', 'sit_stand_to_sit', 'sit_idle_m', 'sit_to_stand_m'];
  const actions = Object.fromEntries(names.map((name, index) => [name, mixer.clipAction(
    new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('dummy.position[y]', [0, 1], [index, index])]),
  )])) as Record<AnimName, THREE.AnimationAction>;
  actions.idle.play();
  const animator = Object.create(VRMCharacterAnimator.prototype) as VRMCharacterAnimator;
  Object.assign(animator, {
    ready: true, disposed: false, mixer, actions, currentAction: actions.idle,
    oneShotRequestToken: 0, oneShotActive: false, oneShotFinishedHandler: null,
    wasMotion: 'idle', wasMoving: false, surfaceClip: 'idle', _skeletonUpdateFns: new Map(),
    vrm: { scene: root, update() {} },
  });
  return { animator, actions, mixer };
}

describe('VRM animator prepared one-shot lifecycle', () => {
  test('prepared clips start synchronously and finish only at the clip end', async () => {
    const { animator, mixer } = harness();
    await animator.prepareClips(['sit_stand_to_sit', 'sit_idle_m']);
    const events: string[] = [];
    const started = animator.playOneShot('sit_stand_to_sit', 'sit_idle_m', 1, {
      onStart: () => events.push('start'), onFinish: () => events.push('finish'),
    });
    expect(events).toEqual(['start']);
    expect(await started).toBe(true);
    mixer.update(0.99);
    expect(events).toEqual(['start']);
    mixer.update(0.02);
    expect(events).toEqual(['start', 'finish']);
    mixer.update(2);
    expect(events).toEqual(['start', 'finish']);
  });

  test('a superseded one-shot cannot notify completion', async () => {
    const { animator, mixer } = harness();
    let stale = 0;
    let current = 0;
    await animator.playOneShot('sit_stand_to_sit', undefined, 1, { onFinish: () => stale++ });
    await animator.playOneShot('sit_to_stand_m', undefined, 1, { onFinish: () => current++ });
    mixer.update(1.1);
    expect(stale).toBe(0);
    expect(current).toBe(1);
  });

  test('every unavailable start returns false without hooks', async () => {
    const { animator } = harness();
    let calls = 0;
    const hooks = { onStart: () => calls++, onFinish: () => calls++ };
    Object.assign(animator, { ready: false });
    expect(await animator.playOneShot('sit_stand_to_sit', undefined, 1, hooks)).toBe(false);
    Object.assign(animator, { ready: true, mixer: null });
    expect(await animator.playOneShot('sit_stand_to_sit', undefined, 1, hooks)).toBe(false);
    expect(calls).toBe(0);
  });

  test('self-transition and disposed animator return false', async () => {
    const { animator } = harness();
    expect(await animator.playOneShot('sit_idle_m', 'sit_idle_m')).toBe(false);
    Object.assign(animator, { disposed: true });
    expect(await animator.playOneShot('sit_stand_to_sit')).toBe(false);
  });

  test('a held sit loop fades to full walk weight in 0.2 seconds', async () => {
    const { animator, actions, mixer } = harness();
    await animator.playOneShot('sit_stand_to_sit', 'sit_idle_m');
    mixer.update(1.01);
    mixer.update(0.31);
    expect(actions.sit_idle_m.getEffectiveWeight()).toBeCloseTo(1);
    animator.returnToLocomotion(true, false, 0.2);
    animator.update(0.21, true);
    expect(actions.walk.getEffectiveWeight()).toBeCloseTo(1);
    expect(actions.sit_idle_m.getEffectiveWeight()).toBe(0);
  });

  test('movement cancels a running exit and suppresses its finish callback', async () => {
    const { animator, actions } = harness();
    let finished = 0;
    await animator.playOneShot('sit_to_stand_m', undefined, 1, { onFinish: () => finished++ });
    animator.update(0.1, false);
    animator.returnToLocomotion(true, false, 0.2);
    animator.update(0.21, true);
    expect(actions.walk.getEffectiveWeight()).toBeCloseTo(1);
    expect(actions.sit_to_stand_m.getEffectiveWeight()).toBe(0);
    animator.update(1, true);
    expect(finished).toBe(0);
  });

  test('exit without an explicit loop returns to walk while moving', async () => {
    const { animator, actions } = harness();
    await animator.playOneShot('sit_to_stand_m');
    animator.update(1.01, true);
    animator.update(0.31, true);
    expect(actions.walk.getEffectiveWeight()).toBeCloseTo(1);
    expect(actions.sit_to_stand_m.getEffectiveWeight()).toBe(0);
  });
});

interface BoneGlb {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: { name: string; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; type: 'SCALAR' | 'VEC3' | 'VEC4' }[];
  bufferViews: { byteOffset?: number }[];
  animations?: {
    name: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number }[];
  }[];
  extensions?: {
    VRM?: { humanoid: { humanBones: { bone: VRMHumanBoneName; node: number }[] } };
    VRMC_vrm?: { humanoid: { humanBones: Partial<Record<VRMHumanBoneName, { node: number }>> } };
  };
}

/** Read actual bone rest transforms and quaternion channels without textures or a network. */
function boneAsset(relative: string) {
  const bytes = readFileSync(join(import.meta.dir, '../../../public', relative));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) as BoneGlb;
  const binary = bytes.subarray(28 + jsonLength);
  const nodes = json.nodes.map((node) => {
    const object = new THREE.Object3D();
    // Match GLTFLoader's node-name sanitization, including Mixamo colons.
    object.name = THREE.PropertyBinding.sanitizeNodeName(node.name);
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
    return object;
  });
  json.nodes.forEach((node, index) => node.children?.forEach((child) => nodes[index]!.add(nodes[child]!)));
  const scene = new THREE.Group();
  json.scenes[json.scene ?? 0]!.nodes.forEach((node) => scene.add(nodes[node]!));
  scene.updateMatrixWorld(true);
  const values = (index: number) => {
    const accessor = json.accessors[index]!;
    const view = json.bufferViews[accessor.bufferView]!;
    return new Float32Array(binary.buffer, binary.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
      accessor.count * ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type]));
  };
  const animations = (json.animations ?? []).map((animation) => new THREE.AnimationClip(animation.name, -1,
    animation.channels.filter((channel) => channel.target.path === 'rotation').map((channel) => {
      const sampler = animation.samplers[channel.sampler]!;
      return new THREE.QuaternionKeyframeTrack(`${nodes[channel.target.node]!.name}.quaternion`,
        values(sampler.input), values(sampler.output));
    })));
  return { scene, nodes, json, animations };
}

test('actual Milady rig: sit arm tracks exist; room lap pose releases to locomotion', () => {
  const target = boneAsset('avatars/milady-official-1.vrm');
  const humanBones = Object.fromEntries(target.json.extensions!.VRM!.humanoid.humanBones.map((bone) =>
    [bone.bone, { node: target.nodes[bone.node]! }])) as ConstructorParameters<typeof VRMHumanoid>[0];
  const humanoid = new VRMHumanoid(humanBones);
  target.scene.add(humanoid.normalizedHumanBonesRoot);
  target.scene.rotation.y = Math.PI; // VRM0 load convention.
  const vrm = { scene: target.scene, humanoid, meta: { metaVersion: '0' } } as VRM;
  const source = boneAsset('avatars/animations/_cove_sit.glb');
  const bones = tradingFloorSeatBones(humanoid);
  const mixer = new THREE.AnimationMixer(target.scene);
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const handDrop = (side: 'left' | 'right', out: THREE.Vector3) => {
    humanoid.getRawBoneNode(`${side}Hand`)!.getWorldPosition(out);
    humanoid.getRawBoneNode(`${side}UpperArm`)!.getWorldPosition(origin);
    return out.sub(origin).y;
  };
  for (const name of ['sit_stand_to_sit', 'sit_idle_m', 'sit_to_stand_m']) {
    const native = source.animations.find((clip) => clip.name === name)!;
    if (name === 'sit_stand_to_sit') expect(native.duration).toBeCloseTo(4.8, 5);
    const clip = retargetMeshyClip({ scene: source.scene, animations: [native] }, vrm, name);
    expect(clip.tracks.filter((track) => /Shoulder|Arm|ForeArm|Hand/.test(track.name))).toHaveLength(8);
    const action = mixer.clipAction(clip).play();
    for (const time of [0, clip.duration / 2, clip.duration - 0.001]) {
      mixer.setTime(time);
      humanoid.update();
      target.scene.updateMatrixWorld(true);
      console.info('sit-arm-trace', name, time.toFixed(3), 'uncorrected hand drop', handDrop('left', left), handDrop('right', right));
      applyTradingFloorSeatPose(bones, 1, false);
      humanoid.update();
      target.scene.updateMatrixWorld(true);
      expect(handDrop('left', left)).toBeLessThan(-0.15);
      expect(handDrop('right', right)).toBeLessThan(-0.15);
    }
    action.stop();
  }
  const locomotion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, -0.5));
  bones.leftArm!.quaternion.copy(locomotion);
  applyTradingFloorSeatPose(bones, 0, false);
  expect(bones.leftArm!.quaternion.equals(locomotion)).toBe(true);

  // Real locomotion tracks regain bone ownership after the held sit loop.
  const walkSource = boneAsset('avatars/animations/walk.glb');
  const walk = mixer.clipAction(retargetMixamoClip(walkSource, vrm, 'walk'));
  const hold = mixer.clipAction(retargetMeshyClip({ scene: source.scene,
    animations: [source.animations.find((clip) => clip.name === 'sit_idle_m')!] }, vrm, 'sit_idle_m')).play();
  mixer.update(0.1);
  const animator = Object.create(VRMCharacterAnimator.prototype) as VRMCharacterAnimator;
  Object.assign(animator, {
    ready: true, disposed: false, mixer, actions: { walk, sit_idle_m: hold }, currentAction: hold,
    oneShotRequestToken: 0, oneShotActive: false, oneShotFinishedHandler: null,
    wasMotion: 'idle', wasMoving: false, surfaceClip: 'idle', _skeletonUpdateFns: new Map(),
    vrm: { scene: target.scene, update: () => humanoid.update() },
  });
  animator.returnToLocomotion(true, false, 0.2);
  animator.update(0.21, true);
  applyTradingFloorSeatPose(bones, 0, false);
  expect(walk.getEffectiveWeight()).toBeCloseTo(1);
  expect(hold.getEffectiveWeight()).toBe(0);
  expect(handDrop('left', left)).toBeLessThan(-0.15);
  expect(handDrop('right', right)).toBeLessThan(-0.15);
});

test('room arm pose lowers both hands on every registered VRM rig', () => {
  const paths = new Set(Object.values(MODEL_REGISTRY).filter((reg) => reg.avatar_type === 'vrm').map((reg) => reg.path));
  for (const path of paths) {
    const target = boneAsset(path.slice(1).split('?')[0]!);
    const extension = target.json.extensions!;
    const mapping = extension.VRM
      ? extension.VRM.humanoid.humanBones.map((bone) => [bone.bone, { node: target.nodes[bone.node]! }])
      : Object.entries(extension.VRMC_vrm!.humanoid.humanBones).map(([bone, value]) => [bone, { node: target.nodes[value!.node]! }]);
    const humanoid = new VRMHumanoid(Object.fromEntries(mapping) as ConstructorParameters<typeof VRMHumanoid>[0]);
    target.scene.add(humanoid.normalizedHumanBonesRoot);
    applyTradingFloorSeatPose(tradingFloorSeatBones(humanoid), 1, false);
    humanoid.update();
    target.scene.updateMatrixWorld(true);
    const hand = new THREE.Vector3();
    const arm = new THREE.Vector3();
    for (const side of ['left', 'right'] as const) {
      humanoid.getRawBoneNode(`${side}Hand`)!.getWorldPosition(hand);
      humanoid.getRawBoneNode(`${side}UpperArm`)!.getWorldPosition(arm);
      expect({ path, side, handsBelowArms: hand.y < arm.y }).toEqual({ path, side, handsBelowArms: true });
    }
  }
});
