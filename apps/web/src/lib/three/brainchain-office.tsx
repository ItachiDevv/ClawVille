'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  BRAINCHAIN_OFFICE_WORLD_CENTER as center,
  BRAINCHAIN_OFFICE_HALF_X_WU,
  BRAINCHAIN_OFFICE_HALF_Z_WU,
  BRAINCHAIN_OFFICE_GUIDE_WORLD as guide,
} from '@clawville/shared';
import { cloneOfficeSceneForGpu } from './brainchain-office-geometry';
import { groundedYOffset } from './utils/ground-prop';
import { useGLTFWithKTX2, readGLTFWithKTX2, preloadKTX2Bytes } from './use-gltf-ktx2';
import { BOOT_STREAM_TIER_PROPS, onBootStreamEligible } from './decorative-release';
import { bootStreamPriority } from './use-boot-stream-release';
import { BootStreamedContent } from './boot-streamed-content';
import { useWorldLabel, WorldLabel } from './world-labels-overlay';
import { approachBrainchainOffice } from './brainchain-office-transition';

export const BRAINCHAIN_OFFICE_MODEL = '/models/brainchain/brainchain-office-exterior-v2-mips-mo-ktx.glb?v=1';
// Already loaded for the resident. Reuse bytes and GPU resources, with a separate scene instance.
const GUIDE_MODEL = '/models/lobster_plush-nonorm-ktx.glb';

if (typeof window !== 'undefined') {
  onBootStreamEligible(() => {
    void preloadKTX2Bytes(BRAINCHAIN_OFFICE_MODEL);
    void preloadKTX2Bytes(GUIDE_MODEL);
  }, bootStreamPriority(BOOT_STREAM_TIER_PROPS, center.x, center.z));
}

function warmOffice(): unknown {
  readGLTFWithKTX2(BRAINCHAIN_OFFICE_MODEL);
  return readGLTFWithKTX2(GUIDE_MODEL);
}

function freezeStatic(root: THREE.Object3D): void {
  root.traverse((object) => {
    object.updateMatrix();
    object.matrixAutoUpdate = false;
    if ((object as THREE.Mesh).isMesh) {
      object.frustumCulled = true;
      object.userData.isOccluder = true;
    }
  });
}

const OfficeInner = memo(function OfficeInner({ showGuide, attachmentVisible }: { showGuide: boolean; attachmentVisible: boolean }) {
  const office = useGLTFWithKTX2(BRAINCHAIN_OFFICE_MODEL);
  const teacher = useGLTFWithKTX2(GUIDE_MODEL);
  const officeAnchor = useRef<THREE.Group>(null);
  const guideAnchor = useRef<THREE.Group>(null);
  const officeLabel = useWorldLabel({ id: 'brainchain-office-label', anchorRef: officeAnchor, offset: [0, 0, 0], initialVisible: attachmentVisible, fadeNear: 800, fadeFar: 4500 });
  const guideLabel = useWorldLabel({ id: 'brainchain-guide-label', anchorRef: guideAnchor, offset: [0, 0, 0], initialVisible: attachmentVisible, fadeNear: 800, fadeFar: 4500 });
  useEffect(() => { officeLabel.setVisible(attachmentVisible); guideLabel.setVisible(attachmentVisible && showGuide); }, [attachmentVisible, showGuide, officeLabel.setVisible, guideLabel.setVisible]);
  const building = useMemo(() => {
    const prepared = cloneOfficeSceneForGpu(office.scene);
    const scene = prepared.scene;
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = Math.min(2 * BRAINCHAIN_OFFICE_HALF_X_WU / size.x, 2 * BRAINCHAIN_OFFICE_HALF_Z_WU / size.z) * 0.98;
    const mid = box.getCenter(new THREE.Vector3());
    const y = groundedYOffset(scene, scale);
    freezeStatic(scene);
    return { scene, scale, x: center.x - mid.x * scale, z: center.z - mid.z * scale, y, height: size.y * scale, dispose: prepared.dispose };
  }, [office.scene]);
  useEffect(() => () => building.dispose(), [building]);
  const figure = useMemo(() => {
    const scene = teacher.scene.clone(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    const scale = Math.min(96 / size.y, 80 / size.x, 80 / size.z);
    const y = groundedYOffset(scene, scale);
    freezeStatic(scene);
    return { scene, scale, x: guide.x - mid.x * scale, z: guide.z - mid.z * scale, y, height: size.y * scale };
  }, [teacher.scene]);

  return <>
    <group position={[building.x, building.y, building.z]} scale={building.scale}
      onClick={(event) => { event.stopPropagation(); approachBrainchainOffice(); }}>
      <primitive object={building.scene} />
    </group>
    {showGuide && <group position={[figure.x, figure.y, figure.z]} scale={figure.scale}
      onClick={(event) => { event.stopPropagation(); approachBrainchainOffice(true); }}>
      <primitive object={figure.scene} />
    </group>}
    <group ref={officeAnchor} position={[center.x, building.height + 45, center.z]} />
    <group ref={guideAnchor} position={[guide.x, figure.height + 40, guide.z]} />
    <WorldLabel divRef={officeLabel.divRef} pointerEvents="auto">
      <button type="button" onClick={() => approachBrainchainOffice()} style={{ color: '#fff', background: '#29262b', border: '1px solid #f581b4', borderRadius: 8, padding: '8px 12px', minHeight: 44, whiteSpace: 'nowrap' }}>BrainChain Office</button>
    </WorldLabel>
    {showGuide && <WorldLabel divRef={guideLabel.divRef} pointerEvents="auto">
      <button type="button" onClick={() => approachBrainchainOffice(true)} style={{ color: '#fff', background: '#29262b', border: '1px solid #80c0b8', borderRadius: 8, padding: '6px 10px', minHeight: 44 }}>Office Guide</button>
    </WorldLabel>}
  </>;
});

export default function BrainchainOfficeWorld({ showGuide = true }: { showGuide?: boolean }) {
  return <BootStreamedContent cohortId="prop:brainchain-office" warmRead={warmOffice}
    priority={bootStreamPriority(BOOT_STREAM_TIER_PROPS, center.x, center.z)}>
    {(ready) => <OfficeInner showGuide={showGuide} attachmentVisible={ready} />}
  </BootStreamedContent>;
}
