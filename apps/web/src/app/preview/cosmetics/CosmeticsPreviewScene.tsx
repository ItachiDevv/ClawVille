'use client';

/**
 * CosmeticsPreviewScene — dev/QA only.
 *
 * Per-avatar cosmetic tuner: pick ONE avatar, the camera zooms to it, and you get
 * the full hat + glasses knobs to perfect THAT avatar. Bake the values, move on.
 * Base placement comes from computeCosmeticHeadFit (auto-fit, or bone-anchored
 * override for hermes/chibi); the sliders apply NUDGES on top + the scalp-hide
 * radius. WebGL renderer (screenshottable).
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '@/lib/three/vrm-loader';
import {
  computeVRMAvatarFit,
  computeCosmeticHeadFit,
  hideHeadGeometryUnderHat,
  RIG_HEAD_OVERRIDE,
} from '@/lib/three/vrm-avatar-sizing';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

interface AvatarDef {
  instanceId: string;
  vrmPath: string;
  animatorId: string;
  rigKey: string;
  label: string;
  xOffset: number;
  focusY: number; // approx head world-Y for the focus camera
}

const AVATARS: AvatarDef[] = [
  { instanceId: 'cp-milady', vrmPath: '/avatars/milady-official-1.vrm', animatorId: 'vrm-milady',   rigKey: 'milady', label: 'Milady', xOffset: -600, focusY: 250 },
  { instanceId: 'cp-hermes', vrmPath: '/avatars/hermes-female.vrm',     animatorId: 'hermes-female', rigKey: 'hermes', label: 'Hermes', xOffset: -300, focusY: 250 },
  { instanceId: 'cp-tekk',   vrmPath: '/avatars/tekk-nonorm.vrm',              animatorId: 'tekk',          rigKey: 'tekk',   label: 'Tekk',   xOffset: 0,    focusY: 300 },
  { instanceId: 'cp-phanes', vrmPath: '/avatars/phanes.vrm?v=1',        animatorId: 'hermes-male',   rigKey: 'phanes', label: 'Phanes', xOffset: 300,  focusY: 270 },
  { instanceId: 'cp-chibi',  vrmPath: '/avatars/eliza-chibi.vrm?v=2',   animatorId: 'chibi',         rigKey: 'chibi',  label: 'chibi',  xOffset: 600,  focusY: 90 },
];

const HAT_URL = '/cosmetics/hats/top-hat.glb';
const GLASSES_URL = '/cosmetics/glasses/classic-black.glb';

// ---------------------------------------------------------------------------
// Per-rig NUDGE state (what the sliders edit; bake into the code when happy)
// ---------------------------------------------------------------------------

interface Nudge {
  hatY: number; hatScale: number; hatRot: number;       // hat: up/down (wu), size ×, tilt-back (rad)
  glY: number; glScale: number; glFwd: number;          // glasses: up/down (wu), size ×, forward (wu)
  hideR: number;                                         // scalp-hide radius, fraction of head width
}
function defaultNudge(): Nudge {
  return { hatY: 0, hatScale: 1, hatRot: 0, glY: 0, glScale: 1, glFwd: 0, hideR: 0.62 };
}
type NudgeMap = Record<string, Nudge>;
function defaultNudges(): NudgeMap {
  const m: NudgeMap = {};
  for (const a of AVATARS) m[a.rigKey] = defaultNudge();
  return m;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

let _glbLoader: GLTFLoader | null = null;
function getGLBLoader(): GLTFLoader {
  if (!_glbLoader) { _glbLoader = new GLTFLoader(); _glbLoader.setMeshoptDecoder(MeshoptDecoder); }
  return _glbLoader;
}
const _glbCache = new Map<string, Promise<THREE.Group>>();
function loadCosmetic(url: string): Promise<THREE.Group> {
  let p = _glbCache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      getGLBLoader().load(url, (g) => { applyFattenedFrustumCulling(g.scene); resolve(g.scene); }, undefined, reject);
    });
    _glbCache.set(url, p);
  }
  return p.then((g) => g.clone(true));
}
function disposeGroup(g: THREE.Object3D) {
  g.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      (c as THREE.Mesh).geometry?.dispose();
      const mat = (c as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat?.dispose();
    }
  });
}
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();

// ---------------------------------------------------------------------------
// One avatar + its cosmetics (re-attaches when its nudge changes)
// ---------------------------------------------------------------------------

function AvatarWithCosmetics({ def, nudge }: { def: AvatarDef; nudge: Nudge }) {
  const vrm = useVRMInstance(def.vrmPath, def.instanceId);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!vrm || !groupRef.current) return;
    retainVRMInstance(def.vrmPath, def.instanceId); // cancel deferred dispose on StrictMode re-setup
    const group = groupRef.current;
    const { scale, offsetY } = computeVRMAvatarFit(vrm, def.animatorId);
    vrm.scene.scale.setScalar(scale);
    vrm.scene.position.set(0, offsetY, 0);
    group.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    return () => { group.remove(vrm.scene); disposeVRMInstance(def.vrmPath, def.instanceId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrm, def.instanceId, def.animatorId, def.vrmPath]);

  const nKey = `${nudge.hatY},${nudge.hatScale},${nudge.hatRot},${nudge.glY},${nudge.glScale},${nudge.glFwd},${nudge.hideR}`;

  useEffect(() => {
    if (!vrm) return;
    let mounted = true;
    const attached: THREE.Group[] = [];
    const restores: Array<() => void> = [];
    const headBone = vrm.humanoid?.getRawBoneNode?.('head') ?? null;
    const { scale } = computeVRMAvatarFit(vrm, def.animatorId);
    const override = RIG_HEAD_OVERRIDE[def.rigKey]; // auto-fit for milady/tekk/phanes; bone-anchored for hermes/chibi

    (async () => {
      for (const category of ['hat', 'glasses'] as const) {
        const url = category === 'hat' ? HAT_URL : GLASSES_URL;
        let glb: THREE.Group;
        try { glb = await loadCosmetic(url); } catch { continue; }
        if (!mounted || !headBone) { disposeGroup(glb); continue; }
        const fit = computeCosmeticHeadFit(vrm, category, scale, def.rigKey, override);
        if (!fit) { disposeGroup(glb); continue; }
        _box.setFromObject(glb); _box.getSize(_size);
        const assetW = _size.x;
        headBone.getWorldScale(_scale);
        const boneSX = _scale.x;
        let s = 1;
        if (assetW > 1e-6 && boneSX > 1e-6) s = Math.max(0.01, Math.min(1000, fit.desiredWorldWidth / (assetW * boneSX)));

        const grp = new THREE.Group();
        grp.name = `cosmetic-preview-${category}`;
        grp.position.copy(fit.localPosition);
        grp.scale.setScalar(s);
        if (category === 'hat') {
          grp.position.y += nudge.hatY;
          grp.scale.multiplyScalar(nudge.hatScale);
          grp.rotation.x += nudge.hatRot;
        } else {
          grp.position.y += nudge.glY;
          grp.position.z += nudge.glFwd;
          grp.scale.multiplyScalar(nudge.glScale);
        }
        grp.frustumCulled = false;
        grp.add(glb);
        headBone.add(grp);
        attached.push(grp);

        if (category === 'hat') {
          grp.updateWorldMatrix(true, false);
          grp.getWorldPosition(_pos);
          restores.push(hideHeadGeometryUnderHat(vrm, _pos.y, _pos.x, _pos.z, fit.headWidthWU * nudge.hideR));
        }
      }
    })();

    return () => {
      mounted = false;
      restores.forEach((r) => r());
      attached.forEach((g) => { g.parent?.remove(g); disposeGroup(g); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrm, def.instanceId, def.animatorId, def.rigKey, nKey]);

  useFrame((_, dt) => { if (vrm) vrm.update(dt); });

  return <group ref={groupRef} position={[def.xOffset, 0, 0]} />;
}

// ---------------------------------------------------------------------------
// Camera — frames the focused avatar, or the whole row for 'all'
// ---------------------------------------------------------------------------

function CameraRig({ focus }: { focus: string }) {
  const { camera } = useThree();
  useEffect(() => {
    const a = AVATARS.find((x) => x.rigKey === focus);
    if (a) {
      camera.position.set(a.xOffset, a.focusY + 10, 340);
      camera.lookAt(a.xOffset, a.focusY - 20, 0);
    } else {
      camera.position.set(0, 220, 900);
      camera.lookAt(0, 200, 0);
    }
    camera.updateProjectionMatrix();
  }, [camera, focus]);
  return null;
}

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function Slider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'monospace', color: '#cbe8ff' }}>
      <span style={{ width: 96, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ flex: 1 }} />
      <span style={{ width: 46, textAlign: 'right', color: '#7dd3fc' }}>{value.toFixed(2)}</span>
    </label>
  );
}

function Panel({ focus, setFocus, nudges, setNudges }: {
  focus: string; setFocus: (f: string) => void; nudges: NudgeMap; setNudges: (n: NudgeMap) => void;
}) {
  const n = nudges[focus];
  const set = (mut: (x: Nudge) => void) => {
    const next = structuredClone(nudges); mut(next[focus]); setNudges(next);
  };
  const btn = (rig: string, label: string) => (
    <button key={rig} onClick={() => setFocus(rig)} style={{
      fontSize: 11, fontFamily: 'monospace', padding: '4px 8px', cursor: 'pointer',
      background: focus === rig ? '#2563eb' : 'rgba(30,58,95,0.6)', color: '#e6f3ff',
      border: '1px solid #1e3a5f', borderRadius: 5,
    }}>{label}</button>
  );
  return (
    <div style={{
      position: 'absolute', top: 40, left: 16, width: 320, padding: 12,
      background: 'rgba(8,16,30,0.94)', border: '1px solid #1e3a5f', borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 6, zIndex: 10,
    }}>
      <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#7dd3fc' }}>cosmetic tuner — one avatar at a time</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {AVATARS.map((a) => btn(a.rigKey, a.label))}
        {btn('all', 'all')}
      </div>
      {n && (
        <>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#9fd0ff' }}>HAT</div>
          <Slider label="up / down" value={n.hatY} min={-40} max={40} step={0.5} onChange={(v) => set((x) => { x.hatY = v; })} />
          <Slider label="size ×" value={n.hatScale} min={0.3} max={3} step={0.02} onChange={(v) => set((x) => { x.hatScale = v; })} />
          <Slider label="tilt back" value={n.hatRot} min={-0.5} max={0.5} step={0.01} onChange={(v) => set((x) => { x.hatRot = v; })} />
          <Slider label="hair hide R" value={n.hideR} min={0.2} max={1.1} step={0.01} onChange={(v) => set((x) => { x.hideR = v; })} />
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#9fd0ff', marginTop: 4 }}>GLASSES</div>
          <Slider label="up / down" value={n.glY} min={-30} max={30} step={0.5} onChange={(v) => set((x) => { x.glY = v; })} />
          <Slider label="size ×" value={n.glScale} min={0.3} max={3} step={0.02} onChange={(v) => set((x) => { x.glScale = v; })} />
          <Slider label="forward" value={n.glFwd} min={-20} max={20} step={0.5} onChange={(v) => set((x) => { x.glFwd = v; })} />
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#64748b', marginTop: 4, userSelect: 'all' }}>
            {focus}: hatY={n.hatY} hatScale={n.hatScale} hatRot={n.hatRot} hideR={n.hideR} glY={n.glY} glScale={n.glScale} glFwd={n.glFwd}
          </div>
        </>
      )}
      {focus === 'all' && <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#64748b' }}>Pick an avatar above to tune it.</div>}
    </div>
  );
}

function LabelOverlay({ focus }: { focus: string }) {
  if (focus !== 'all') return null;
  return (
    <div style={{ position: 'absolute', bottom: 24, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 120, pointerEvents: 'none' }}>
      {AVATARS.map((a) => (
        <div key={a.instanceId} style={{ color: '#7dd3fc', fontFamily: 'monospace', fontSize: 11, textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>{a.label}</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function CosmeticsPreviewScene() {
  const [focus, setFocus] = useState<string>('milady');
  const [nudges, setNudges] = useState<NudgeMap>(() => defaultNudges());
  return (
    <>
      <Canvas camera={{ fov: 45, near: 1, far: 10000, position: [0, 220, 900] }} style={{ width: '100%', height: '100%' }} dpr={[1, 1.5]} frameloop="always">
        <CameraRig focus={focus} />
        <hemisphereLight args={[0xb0d8ff, 0x4a3010, 1.2]} />
        <directionalLight position={[200, 500, 300]} intensity={1.8} castShadow={false} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={false}>
          <planeGeometry args={[2000, 1000]} />
          <meshStandardMaterial color={0x1a2a3a} roughness={0.9} metalness={0} />
        </mesh>
        {AVATARS.map((def) => (
          <Suspense key={def.instanceId} fallback={null}>
            <AvatarWithCosmetics def={def} nudge={nudges[def.rigKey]} />
          </Suspense>
        ))}
      </Canvas>
      <Panel focus={focus} setFocus={setFocus} nudges={nudges} setNudges={setNudges} />
      <LabelOverlay focus={focus} />
    </>
  );
}
