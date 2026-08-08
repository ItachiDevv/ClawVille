'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import type { GLTFLoader } from 'three-stdlib';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { extendLoaderWithKTX2 } from '@/lib/three/ktx2-loader-setup';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { useStageStore } from '@/components/three/world-stage/stage-store';

const COVE_INTERIOR_GLB =
  '/models/cove/cove-interior-cleaned-v1-mo-ktx.glb';
const TARGET_MAX_DIMENSION = 8;
const FIT_BOX = new THREE.Box3();
const FIT_SIZE = new THREE.Vector3();
const FIT_CENTER = new THREE.Vector3();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(
  'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
);

function extendCoveLoader(loader: GLTFLoader): void {
  loader.setDRACOLoader(
    dracoLoader as unknown as Parameters<
      GLTFLoader['setDRACOLoader']
    >[0],
  );
  extendLoaderWithKTX2(loader);
}

if (typeof window !== 'undefined') {
  dracoLoader.preload();
}

function useCoveSpikeReady(): void {
  const active = useStageStore(
    (state) => state.activeScene === 'cove-spike',
  );
  const generation = useStageStore(
    (state) => state.scenes['cove-spike']?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === 'cove-spike',
  );

  useEffect(() => {
    if (!active || !requested || generation <= 0) return;
    const state = useStageStore.getState();
    state.setSceneWarming('cove-spike', generation);
    const frame = requestAnimationFrame(() => {
      useStageStore.getState().ackReady('cove-spike', generation);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, generation, requested]);
}

function makeSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = 'rgba(15, 25, 40, 0.94)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#00ffe0';
    context.lineWidth = 8;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.fillStyle = '#00ffe0';
    context.font = '700 62px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('COVE SPIKE', 256, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

export function CoveStageSpike() {
  const propRef = useRef<THREE.Mesh>(null);
  const { scene } = useGLTF(
    COVE_INTERIOR_GLB,
    true,
    true,
    extendCoveLoader,
  );
  useCoveSpikeReady();

  const room = useMemo(() => {
    const clone = scene.clone(true);
    clone.updateMatrixWorld(true);
    FIT_BOX.setFromObject(clone);
    FIT_BOX.getSize(FIT_SIZE);
    FIT_BOX.getCenter(FIT_CENTER);
    const maxDimension = Math.max(FIT_SIZE.x, FIT_SIZE.y, FIT_SIZE.z);
    const scale =
      maxDimension > 0
        ? TARGET_MAX_DIMENSION / maxDimension
        : 1;
    clone.scale.setScalar(scale);
    clone.position.set(
      -FIT_CENTER.x * scale,
      -FIT_BOX.min.y * scale - 2.2,
      -FIT_CENTER.z * scale,
    );
    clone.traverse((object) => {
      object.matrixAutoUpdate = false;
    });
    clone.updateMatrixWorld(true);
    return clone;
  }, [scene]);

  const sign = useMemo(() => {
    const texture = makeSignTexture();
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    return { texture, material };
  }, []);

  const standardMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x2a1800,
        emissive: 0xffaa00,
        emissiveIntensity: 0.22,
        roughness: 0.55,
        metalness: 0.55,
      }),
    [],
  );

  useEffect(
    () => () => {
      sign.material.dispose();
      sign.texture.dispose();
      standardMaterial.dispose();
    },
    [sign, standardMaterial],
  );

  useSceneFrame('cove-spike', (_state, delta) => {
    if (propRef.current) {
      propRef.current.rotation.y += delta * 0.5;
    }
  });

  return (
    <>
      <ambientLight color={0x1a0a2e} intensity={6} />
      <hemisphereLight args={[0x4a3a7a, 0x6a4a3a, 2.5]} />
      <pointLight
        position={[-1.8, 2, -0.6]}
        color={0x00ffe0}
        intensity={8}
        distance={14}
        decay={1}
        castShadow={false}
      />
      <primitive object={room} />
      <mesh
        position={[-1.15, -0.4, 1.5]}
        material={sign.material}
      >
        <planeGeometry args={[1.8, 0.45]} />
      </mesh>
      <mesh
        ref={propRef}
        position={[1.25, -1.4, 0.8]}
        material={standardMaterial}
      >
        <boxGeometry args={[0.7, 1.3, 0.7]} />
      </mesh>
    </>
  );
}
