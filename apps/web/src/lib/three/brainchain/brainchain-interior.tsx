'use client';

import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject, type ReactNode } from 'react';
import * as THREE from 'three/webgpu';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { useThree } from '@react-three/fiber';
import { useGameStore } from '@/stores/game';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useBrainchainInteriorStore } from '@/components/brainchain/brainchain-interior-store';
import { useSceneActive, useSceneCamera, useSceneFrame, useSlotCapabilities } from '@/components/three/world-stage/use-scene-frame';
import { usePlayerCapabilityController, type PlayerSpaceAdapter } from '../player/player-capability-controller';
import { TRADING_FLOOR_POLICY } from '../player/player-motion-policy';
import { attachPlayerPointerOrbit, createPlayerPointerOrbitState } from '../player/player-pointer-orbit';
import { useWorldLabel, WorldLabel, WorldLabelsOverlayMount } from '../world-labels-overlay';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '../agent-model-registry';
import { useGLTFWithKTX2 } from '../use-gltf-ktx2';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '../vrm-loader';
import { computeVRMAvatarFit } from '../vrm-avatar-sizing';
import { VRMCharacterAnimator } from '../vrm-character-animator';
import { makeObject3DWebGPUSafe } from '../webgpu-geometry';
import { CORTEX_MODEL, CORTEX_SCALE, CORTEX_MAX_HEIGHT, npcRenderedHeightLimit } from '../brainchain-cortex-size';
import { vortexResources } from '../brainchain-vortex-resources';
import { OFFICE_VORTEX_MODEL } from '../brainchain-office-door';
import { BrainchainShell } from './brainchain-shell';
import { BRAINCHAIN_EXIT, BRAINCHAIN_PLAYER_SPAWN, BRAINCHAIN_STATIONS, brainchainStationAt, clampBrainchainMovement, placeBrainchainCamera, stepBrainchainExit, type BrainchainTab, type BrainchainExitEdge } from './brainchain-room';

export interface BrainchainInteriorProps {
  active?: boolean;
  onReady?: () => void;
  onOpen: (tab: BrainchainTab) => void;
  onExit: () => void;
  onTalk?: () => void;
  frozen: boolean;
}
let useAction: (() => boolean) | null = null;
/** Keyboard, touch USE, and labels share the same frozen/range checks. */
export function activateBrainchainUse(): boolean { return useAction?.() ?? false; }
interface Motion { x: number; z: number; facing: number; moving: boolean; running: boolean }

function Vortex() {
  const ref = useRef<THREE.Mesh>(null);
  const resources = vortexResources();
  useSceneFrame((_, delta) => { if (ref.current) ref.current.rotation.z -= Math.min(delta, 0.1) * 0.7; });
  return <mesh ref={ref} {...resources} dispose={null} position={[0, 290, BRAINCHAIN_EXIT.z]} scale={290 / OFFICE_VORTEX_MODEL.radius} rotation={[0, Math.PI, 0]} />;
}

function Cortex() {
  const { scene, animations } = useGLTFWithKTX2(CORTEX_MODEL);
  const { object, mixer, offsetY, scale } = useMemo(() => {
    const object = cloneSkeleton(scene); makeObject3DWebGPUSafe(object);
    object.traverse(o => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; });
    const mixer = new THREE.AnimationMixer(object), idle = animations.find(a => a.name.toLowerCase() === 'idle');
    if (idle) mixer.clipAction(idle).play();
    mixer.update(0);
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object);
    const scale = Math.min(CORTEX_SCALE, npcRenderedHeightLimit(CORTEX_MODEL, CORTEX_MAX_HEIGHT) / Math.max(0.001, bounds.max.y - bounds.min.y));
    return { object, mixer, scale, offsetY: -bounds.min.y * scale };
  }, [scene, animations]);
  useSceneFrame((_, delta) => mixer.update(Math.min(delta, 0.1)));
  useEffect(() => () => { mixer.stopAllAction(); mixer.uncacheRoot(object); }, [mixer, object]);
  return <primitive object={object} scale={scale} position={[-1140, offsetY, 1250]} rotation={[0, Math.PI, 0]} dispose={null} />;
}

function GLBAvatar({ reg }: { reg: ModelRegistryEntry }) {
  const { scene } = useGLTFWithKTX2(reg.path);
  const { object, scale, offsetY } = useMemo(() => {
    const object = cloneSkeleton(scene); makeObject3DWebGPUSafe(object);
    object.traverse(o => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; });
    const b = new THREE.Box3().setFromObject(object);
    const scale = Math.min(270 / Math.max(0.001, b.max.y - b.min.y), 190 / Math.max(0.001, b.max.x - b.min.x, b.max.z - b.min.z));
    return { object, scale, offsetY: -b.min.y * scale };
  }, [scene]);
  return <primitive object={object} scale={scale} position={[0, offsetY, 0]} dispose={null} />;
}
function VRMAvatar({ reg, motion, frozen }: { reg: ModelRegistryEntry; motion: RefObject<Motion>; frozen: boolean }) {
  const vrm = useVRMInstance(reg.path, 'brainchain-player');
  const fit = useMemo(() => computeVRMAvatarFit(vrm, reg.animatorId, 270), [vrm, reg.animatorId]);
  const animator = useRef<VRMCharacterAnimator | null>(null);
  useEffect(() => {
    retainVRMInstance(reg.path, 'brainchain-player');
    const next = new VRMCharacterAnimator(vrm, reg.animatorId); animator.current = next;
    void next.init().catch(error => console.warn('[BrainChain] avatar animation unavailable', error));
    return () => { animator.current = null; next.dispose(); disposeVRMInstance(reg.path, 'brainchain-player'); };
  }, [vrm, reg.path, reg.animatorId]);
  useSceneFrame((_, delta) => {
    const d = Math.min(delta, 0.1);
    animator.current?.update(d, !frozen && motion.current.moving, !frozen && motion.current.running);
    vrm.update(d);
  }, -50);
  return <primitive object={vrm.scene} scale={fit.scale} position={[0, fit.offsetY, 0]} dispose={null} />;
}
function Avatar({ motion, frozen }: { motion: RefObject<Motion>; frozen: boolean }) {
  const key = useGameStore(s => s.avatarModelKey);
  const reg = MODEL_REGISTRY[key as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;
  return reg.avatar_type === 'vrm' ? <VRMAvatar reg={reg} motion={motion} frozen={frozen} /> : <GLBAvatar reg={reg} />;
}

function StationLabel({ index, motion, frozen, onTalk }: { index: number; motion: RefObject<Motion>; frozen: boolean; onTalk?: () => void }) {
  const isMobile = useIsMobile();
  const station = BRAINCHAIN_STATIONS[index]!;
  const anchor = useRef<THREE.Group>(null);
  const { divRef, setVisible } = useWorldLabel({ id: `brainchain-${station.id}`, anchorRef: anchor, initialVisible: false, occlude: false });
  useSceneFrame(() => setVisible(!isMobile && !frozen && brainchainStationAt(motion.current.x, motion.current.z) === index));
  return <>
    <group ref={anchor} position={[station.x, 420, station.z]} />
    <WorldLabel divRef={divRef}>
      <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto', fontFamily: 'var(--font-geist), sans-serif' }}>
        <button type="button" onClick={() => activateBrainchainUse()} style={{ minHeight: 44, minWidth: 44, padding: '10px 16px', background: '#1d1d1d', color: '#f8f7f4', border: '1px solid #f386a1', borderRadius: 12 }}>
          {station.label}<br /><span style={{ fontSize: 11 }}>Press E / tap</span>
        </button>
        {index === 0 && onTalk && <button type="button" onClick={() => {
          if (!frozen && brainchainStationAt(motion.current.x, motion.current.z) === 0) onTalk();
        }} style={{ minHeight: 44, padding: '10px 16px', background: '#f386a1', color: '#0b0b0b', borderRadius: 12 }}>Talk to Cortex</button>}
      </div>
    </WorldLabel>
  </>;
}

class ActorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[BrainChain] actor unavailable', error); }
  render() { return this.state.failed ? null : this.props.children; }
}
function ActorMounted({ onMounted }: { onMounted: () => void }) {
  useLayoutEffect(onMounted, [onMounted]);
  return null;
}

export default function BrainchainOfficeInterior({ active = true, onReady, onOpen, onExit, onTalk, frozen }: BrainchainInteriorProps) {
  const sceneActive = useSceneActive();
  const capabilities = useSlotCapabilities();
  const camera = useSceneCamera();
  const get = useThree(s => s.get);
  const motion = useRef<Motion>({ ...BRAINCHAIN_PLAYER_SPAWN, facing: Math.PI, moving: false, running: false });
  const group = useRef<THREE.Group>(null);
  const yaw = useRef(0), pitch = useRef(0);
  const edge = useRef<BrainchainExitEdge>({ initialized: false, inside: false, allowed: false });
  const orbit = useRef(createPlayerPointerOrbitState());
  const cameraPosition = useRef({ x: 0, y: 300, z: 0 });
  const callbacks = useRef({ frozen, onOpen, onExit, active: active && sceneActive });
  callbacks.current = { frozen, onOpen, onExit, active: active && sceneActive };
  const ready = useRef(false), avatarMounted = useRef(false), cortexMounted = useRef(false);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  const signalReady = useCallback(() => {
    if (ready.current) return;
    ready.current = true; readyCallback.current?.();
  }, []);
  const checkActors = useCallback(() => {
    if (avatarMounted.current && cortexMounted.current) signalReady();
  }, [signalReady]);
  const markAvatar = useCallback(() => { avatarMounted.current = true; checkActors(); }, [checkActors]);
  const markCortex = useCallback(() => { cortexMounted.current = true; checkActors(); }, [checkActors]);
  // Warm slots do not tick useSceneFrame. Commit readiness must run before activation.
  // The bounded actor fallback matches the Trading Floor cold-load policy.
  useLayoutEffect(() => {
    checkActors();
    const timer = setTimeout(signalReady, 1500);
    return () => clearTimeout(timer);
  }, [checkActors, signalReady]);
  const reset = useCallback(() => {
    motion.current.x = BRAINCHAIN_PLAYER_SPAWN.x; motion.current.z = BRAINCHAIN_PLAYER_SPAWN.z;
    motion.current.facing = Math.PI; motion.current.moving = false; motion.current.running = false;
    yaw.current = pitch.current = 0; orbit.current.yawRad = orbit.current.pitchRad = 0;
    edge.current.initialized = false; edge.current.inside = false; edge.current.allowed = false;
  }, []);
  const activate = useCallback(() => {
    if (callbacks.current.frozen || !callbacks.current.active) return false;
    const index = brainchainStationAt(motion.current.x, motion.current.z);
    if (index < 0) return false;
    callbacks.current.onOpen(BRAINCHAIN_STATIONS[index]!.tab); return true;
  }, []);
  useEffect(() => { if (!active || !sceneActive) return; useAction = activate; return () => { if (useAction === activate) useAction = null; }; }, [active, sceneActive, activate]);
  useEffect(() => { if (active && sceneActive) reset(); }, [active, sceneActive, reset]);
  useEffect(() => {
    if (!active || !sceneActive || !capabilities.cameraOrbitDrag) return;
    const state = get(), element = state.events.connected ?? state.gl.domElement;
    const handler = attachPlayerPointerOrbit(element, orbit.current, { isBlocked: () => callbacks.current.frozen });
    return () => handler.detach();
  }, [active, sceneActive, capabilities.cameraOrbitDrag, get]);
  const space = useMemo<PlayerSpaceAdapter>(() => ({
    speedPerSec: 520,
    readPosition(out) { out.x = motion.current.x; out.z = motion.current.z; },
    clampMovement(cx, cz, dx, dz, out) { clampBrainchainMovement(cx, cz, dx, dz, out); out.groundY = 0; },
    commitPosition(out) { motion.current.x = out.x; motion.current.z = out.z; },
  }), []);
  usePlayerCapabilityController({
    sceneId: 'brainchain', capabilities, motion: TRADING_FLOOR_POLICY.motion, input: TRADING_FLOOR_POLICY.input, space,
    isDriving: () => true, isFrozen: () => callbacks.current.frozen,
    onActivationReset: reset,
    onFrameStart: () => { motion.current.moving = motion.current.running = false; },
    onInteractEdge: () => { if (activate()) return { consumeFrame: true }; },
    onAfterMove: state => {
      const m = motion.current; m.facing = state.facing; m.moving = state.moving; m.running = state.running;
      yaw.current += state.intent.cameraYawInput * 1.25 * state.integrationDelta;
      pitch.current = Math.max(-120, Math.min(150, pitch.current + state.intent.cameraPitchInput * 180 * state.integrationDelta));
      if (stepBrainchainExit(edge.current, m.x, m.z, !callbacks.current.frozen, state.moving)) callbacks.current.onExit();
    },
  });
  useSceneFrame(() => {
    if (frozen) { edge.current.allowed = false; orbit.current.yawRad = orbit.current.pitchRad = 0; }
    else {
      yaw.current += orbit.current.yawRad;
      pitch.current = Math.max(-120, Math.min(150, pitch.current + orbit.current.pitchRad * 520));
      orbit.current.yawRad = orbit.current.pitchRad = 0;
    }
    const m = motion.current;
    const nearby = frozen ? -1 : brainchainStationAt(m.x, m.z);
    const station = nearby < 0 ? null : nearby;
    if (useBrainchainInteriorStore.getState().nearbyStation !== station) useBrainchainInteriorStore.setState({ nearbyStation: station });
    if (group.current) { group.current.position.set(m.x, 0, m.z); group.current.rotation.y = m.facing; }
    if (camera) {
      placeBrainchainCamera(m.x, m.z, yaw.current, pitch.current, cameraPosition.current);
      const c = cameraPosition.current; camera.position.set(c.x, c.y, c.z);
      camera.lookAt(m.x + Math.sin(yaw.current) * 140, 180, m.z - Math.cos(yaw.current) * 140);
      camera.updateMatrixWorld();
    }
  }, -40);
  return <>
    <ambientLight intensity={0.4} />
    <hemisphereLight args={['#dcebf0', '#48404b', 0.65]} />
    <directionalLight position={[600, 1100, 500]} intensity={2.1} color="#fff5ef" castShadow={false} />
    <BrainchainShell />
    <Vortex />
    <WorldLabelsOverlayMount />
    {BRAINCHAIN_STATIONS.map((s, index) => <StationLabel key={s.id} index={index} motion={motion} frozen={frozen} onTalk={onTalk} />)}
    <ActorBoundary><Suspense fallback={null}><Cortex /><ActorMounted onMounted={markCortex} /></Suspense></ActorBoundary>
    <group ref={group} position={[0, 0, 1600]} rotation={[0, Math.PI, 0]}><ActorBoundary><Suspense fallback={null}><Avatar motion={motion} frozen={frozen} /><ActorMounted onMounted={markAvatar} /></Suspense></ActorBoundary></group>
  </>;
}
export { BrainchainOfficeInterior };
