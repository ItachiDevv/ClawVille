'use client';

import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useGLTFWithKTX2 } from '../use-gltf-ktx2';
import { makeObject3DWebGPUSafe } from '../webgpu-geometry';
import { BRAINCHAIN_PROP_BOUNDS, BRAINCHAIN_STATIONS } from './brainchain-room';

/** Replace each null with a KTX2 GLB URL. Bottom centre and +Z front stay fixed. */
export const BRAINCHAIN_SCULPTURE_MODEL: string | null = '/models/brainchain/brainchain-sculpture-v1-ktx.glb';
export const BRAINCHAIN_POD_MODEL: string | null = '/models/brainchain/brainchain-pod-v1-ktx.glb';
export const BRAINCHAIN_DESK_MODEL: string | null = '/models/brainchain/brainchain-desk-v1-ktx.glb';
type Part = { geometry: THREE.BufferGeometry; material: THREE.Material };
let shell: Part[] | null = null;
const ink = new THREE.MeshStandardMaterial({ color: '#1d1d1d', roughness: 0.72 });
const paper = new THREE.MeshStandardMaterial({ color: '#f8f7f4', roughness: 0.42 });
const pink = new THREE.MeshStandardMaterial({ color: '#f386a1', emissive: '#f386a1', emissiveIntensity: 0.3, roughness: 0.35 });
const sea = new THREE.MeshBasicMaterial({ color: '#25859a', side: THREE.BackSide });

function canvasTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d'); if (!ctx) return null;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonindexed = parts.map(p => { const n = p.index ? p.toNonIndexed() : p; if (n !== p) p.dispose(); n.deleteAttribute('uv'); return n; });
  const result = mergeGeometries(nonindexed)!;
  for (const p of nonindexed) p.dispose();
  return result;
}
function box(x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
}
function torus(radius: number, tube: number, x: number, y: number, z: number, tilt = Math.PI / 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, tube, 8, 96).rotateX(tilt).translate(x, y, z);
}
/** Runtime-authored shell with exact floor datum, merged by material. No network shell or import-time canvas. */
function resources(): Part[] {
  if (shell) return shell;
  const floorTexture = canvasTexture(ctx => {
    ctx.fillStyle = '#f8f7f4'; ctx.fillRect(0, 0, 1024, 512);
    ctx.strokeStyle = 'rgba(182,197,198,0.26)'; ctx.lineWidth = 2;
    for (let row = -1; row < 10; row++) for (let col = -1; col < 17; col++) {
      ctx.beginPath(); const x = col * 64 + (row % 2) * 32, y = row * 60;
      ctx.ellipse(x, y, 44 + Math.sin(col) * 7, 36, Math.sin(row + col) * 0.4, 0, Math.PI * 2); ctx.stroke();
    }
  });
  if (floorTexture) { floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping; floorTexture.repeat.set(3, 3); }
  const floor = new THREE.MeshStandardMaterial({ color: '#f8f7f4', map: floorTexture, roughness: 0.55 });
  const wall = new THREE.MeshStandardMaterial({ color: '#1d1d1d', side: THREE.BackSide, roughness: 0.8 });
  const seaTexture = canvasTexture(ctx => {
    const g = ctx.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#439db3'); g.addColorStop(0.55, '#12617d'); g.addColorStop(1, '#052c43');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 35; i++) {
      const x = (i * 173) % 1024; ctx.fillStyle = 'rgba(183,239,244,0.14)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 100, 512); ctx.lineTo(x + 90, 512); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#154659'; ctx.beginPath(); ctx.ellipse(x, 510, 60, 45 + i % 4 * 23, 0, 0, Math.PI * 2); ctx.fill();
    }
  });
  sea.map = seaTexture; sea.needsUpdate = true;
  const trims: THREE.BufferGeometry[] = [torus(2190, 18, 0, 620, 0), torus(2190, 18, 0, 1070, 0)];
  const ribs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    ribs.push(box(Math.sin(a) * 2180, 850, Math.cos(a) * 2180, 34, 460, 34));
  }
  shell = [
    { geometry: new THREE.CircleGeometry(2200, 96).rotateX(-Math.PI / 2), material: floor },
    { geometry: merged([new THREE.CylinderGeometry(2200, 2200, 620, 96, 1, true).translate(0, 310, 0), new THREE.CylinderGeometry(2200, 2200, 230, 96, 1, true).translate(0, 1185, 0)]), material: wall },
    { geometry: new THREE.CylinderGeometry(2202, 2202, 450, 96, 1, true).translate(0, 845, 0), material: sea },
    { geometry: merged(ribs), material: ink },
    { geometry: merged(trims), material: pink },
    { geometry: merged([torus(1750, 30, 0, 1080, 0, 1.48), torus(1650, 24, 0, 1100, 0, 1.66)]), material: paper },
    { geometry: new THREE.CircleGeometry(2200, 96).rotateX(Math.PI / 2).translate(0, 1300, 0), material: ink },
  ];
  return shell;
}
let sculpture: Part[] | null = null;
let desk: Part[] | null = null;
let pod: Part[] | null = null;
function brainRing(x: number, y: number, perpendicular: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(120, 35, 12, 32)];
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    parts.push(new THREE.SphereGeometry(39, 10, 8).scale(1, 1, 0.9).translate(Math.cos(angle) * 120, Math.sin(angle) * 120, (i % 2 ? 1 : -1) * 8));
  }
  return merged(parts).rotateY(perpendicular ? Math.PI / 2 : 0).translate(x, y, 0);
}
function placeholder(kind: keyof typeof BRAINCHAIN_PROP_BOUNDS): Part[] {
  if (kind === 'sculpture') return sculpture ??= [
    { geometry: new THREE.CylinderGeometry(350, 350, 65, 64).scale(1, 1, 460 / 700).translate(0, 32.5, 0), material: ink },
    { geometry: merged([-180, 0, 180].map((x, i) => brainRing(x, 260 + i * 50, i === 1))), material: pink },
  ];
  if (kind === 'desk') return desk ??= [
    { geometry: new THREE.CylinderGeometry(410, 410, 160, 48, 1, false, Math.PI / 2, Math.PI).scale(1, 1, 390 / 410).translate(0, 80, 195), material: paper },
    { geometry: new THREE.CylinderGeometry(410, 410, 14, 48, 1, true, Math.PI / 2, Math.PI).scale(1, 1, 390 / 410).translate(0, 18, 195), material: pink },
  ];
  return pod ??= [
    { geometry: merged([new THREE.TorusGeometry(155, 25, 8, 32, Math.PI).translate(0, 200, 0), box(-155, 100, 0, 50, 200, 100), box(155, 100, 0, 50, 200, 100), box(0, 120, 40, 280, 20, 170), box(0, 10, 0, 360, 20, 320)]), material: paper },
    { geometry: box(0, 220, 10, 210, 120, 14), material: pink },
  ];
}
function AuthoredProp({ kind, url }: { kind: keyof typeof BRAINCHAIN_PROP_BOUNDS; url: string }) {
  const { scene } = useGLTFWithKTX2(url);
  const object = useMemo(() => {
    const clone = scene.clone(true); makeObject3DWebGPUSafe(clone);
    const bounds = new THREE.Box3().setFromObject(clone), size = bounds.getSize(new THREE.Vector3());
    const target = BRAINCHAIN_PROP_BOUNDS[kind];
    const scale = Math.min(target.width / Math.max(size.x, 0.001), target.height / Math.max(size.y, 0.001), target.depth / Math.max(size.z, 0.001));
    clone.scale.setScalar(scale); clone.position.set(-(bounds.min.x + bounds.max.x) / 2 * scale, -bounds.min.y * scale, -(bounds.min.z + bounds.max.z) / 2 * scale);
    return clone;
  }, [scene, kind]);
  return <primitive object={object} dispose={null} />;
}
function Prop({ kind, url }: { kind: keyof typeof BRAINCHAIN_PROP_BOUNDS; url: string | null }) {
  return url ? <AuthoredProp kind={kind} url={url} /> : <>{placeholder(kind).map((p, i) => <mesh key={i} {...p} dispose={null} />)}</>;
}
let boards: THREE.MeshBasicMaterial[] | null = null;
function boardMaterials() {
  return boards ??= ['TASK BOARD', 'RECEIPTS'].map((title, i) => new THREE.MeshBasicMaterial({ map: canvasTexture(ctx => {
    ctx.fillStyle = '#1d1d1d'; ctx.fillRect(0, 0, 1024, 512);
    ctx.strokeStyle = '#f386a1'; ctx.lineWidth = 8; ctx.strokeRect(8, 8, 1008, 496);
    ctx.fillStyle = '#f8f7f4'; ctx.font = '52px "Fragment Mono", monospace'; ctx.fillText(title, 55, 110);
    ctx.font = '28px Geist, sans-serif'; ctx.fillText(i ? 'Earnings and account records' : 'Work status / Hire help', 55, 190);
    ctx.fillStyle = '#f386a1'; ctx.fillText('Open the Office window to view your data', 55, 400);
  }), toneMapped: false }));
}
const boardGeometry = new THREE.PlaneGeometry(1000, 500);
export function BrainchainShell() {
  const materials = boardMaterials();
  return <group dispose={null}>
    {resources().map((p, i) => <mesh key={i} {...p} />)}
    <Prop kind="sculpture" url={BRAINCHAIN_SCULPTURE_MODEL} />
    {/* Meshy GLBs face +Z; the desk front must face the room (-Z), so a GLB desk turns 180 degrees.
        The procedural placeholder is already built facing -Z. */}
    <group position={[-1140, 0, 1000]} rotation={[0, BRAINCHAIN_DESK_MODEL ? Math.PI : 0, 0]}><Prop kind="desk" url={BRAINCHAIN_DESK_MODEL} /></group>
    {BRAINCHAIN_STATIONS.slice(1, 5).map(s => <group key={s.id} position={[s.x, 0, s.z]} rotation={[0, Math.atan2(-s.x, -s.z), 0]}><Prop kind="pod" url={BRAINCHAIN_POD_MODEL} /></group>)}
    <mesh geometry={boardGeometry} material={materials[0]} position={[1980, 370, -180]} rotation={[0, -Math.PI / 2, 0]} />
    <mesh geometry={boardGeometry} material={materials[1]} position={[540, 370, -1900]} />
  </group>;
}
