'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * All-procedural. Two vertical posts + one horizontal plank (BoxGeometry).
 * Text is BAKED into a CanvasTexture applied to a thin plane on the plank's
 * front face — no drei <Html> portal, no <Text>/<Billboard> (both banned
 * on Iris Xe), just a textured quad. Guaranteed to render.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard GPU crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NO per-frame allocations — all geo/mat/texture are module-scope
 */

import { memo } from 'react';
import * as THREE from 'three/webgpu';

// ---------------------------------------------------------------------------
// Post / plank dims
// ---------------------------------------------------------------------------
const POST_W = 20;
const POST_H = 420;
const POST_D = 20;
const POST_SPACING = 420;

const PLANK_W = POST_SPACING + POST_W + 80;
const PLANK_H = 240;
const PLANK_D = 12;
const PLANK_Y = POST_H - PLANK_H / 2; // plank top aligns with post tops

// World position — raised well above sand to stay clear of terrain bumps
const SIGN_X = 0;
const SIGN_Y = 150;
const SIGN_Z = -120;

const WOOD_COLOR = 0x7c4a1b;

// ---------------------------------------------------------------------------
// Text canvas texture — rendered ONCE at module load, cached for all mounts
// ---------------------------------------------------------------------------
function buildTextTexture(): THREE.Texture {
  // Use a placeholder during SSR / non-browser contexts
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();

  // Wood-grain background (matches the plank)
  ctx.fillStyle = '#7c4a1b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle grain stripes
  ctx.fillStyle = 'rgba(60, 35, 15, 0.18)';
  for (let y = 30; y < canvas.height; y += 60) {
    ctx.fillRect(0, y, canvas.width, 6);
  }

  // Dark border
  ctx.strokeStyle = '#3c230f';
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

  // Text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f5e6c8';

  // Title
  ctx.font = 'bold 140px Georgia, serif';
  ctx.fillText('TOWN CENTER', canvas.width / 2, 130);

  // Divider
  ctx.strokeStyle = '#f5e6c8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 260, 210);
  ctx.lineTo(canvas.width / 2 + 260, 210);
  ctx.stroke();

  // Subheaders
  ctx.font = '80px Georgia, serif';
  ctx.fillText('Auction', canvas.width / 2, 290);
  ctx.fillText('Bazaar', canvas.width / 2, 370);
  ctx.fillText('Marketplace', canvas.width / 2, 450);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  return tex;
}

const textTexture = buildTextTexture();

// ---------------------------------------------------------------------------
// Shared module-scope geometries + materials
// ---------------------------------------------------------------------------
const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);
const plankGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);
const textPlaneGeo = new THREE.PlaneGeometry(PLANK_W - 40, PLANK_H - 40);

const woodMat = new THREE.MeshBasicNodeMaterial();
woodMat.color = new THREE.Color(WOOD_COLOR);

const textMat = new THREE.MeshBasicNodeMaterial();
textMat.map = textTexture;
textMat.transparent = false;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  return (
    <group position={[SIGN_X, SIGN_Y, SIGN_Z]}>
      {/* Left post */}
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[-POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />

      {/* Right post */}
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />

      {/* Horizontal plank */}
      <mesh
        geometry={plankGeo}
        material={woodMat}
        position={[0, PLANK_Y, 0]}
        matrixAutoUpdate={false}
      />

      {/* Text plane — on the front (+Z) face of the plank, with baked text */}
      <mesh
        geometry={textPlaneGeo}
        material={textMat}
        position={[0, PLANK_Y, PLANK_D / 2 + 0.5]}
        matrixAutoUpdate={false}
      />
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
