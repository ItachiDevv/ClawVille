#!/usr/bin/env node
/**
 * Phase 1 cosmetic content drop — generate 6 hat + 6 sunglasses GLBs
 * sized for the Milady VRM head bone.
 *
 * Output: apps/web/public/cosmetics/{hats,glasses}/<slug>.glb
 *
 * Geometry is authored in metric (meters) since VRM 1.0 is metric;
 * the cosmetic-loader attaches under the head bone whose local frame is
 * metric (the VRM root's PET_VRM_SCALE=112 happens at the parent level).
 *
 * Conventions for VRM head-bone-local frame:
 *   +Y = up (top of head)
 *   +Z = forward (face direction)   [NOTE: on Mixamo-rigged Milady VRMs;
 *        retargeter normalizes this. The cosmetic-loader's offsetXYZ in
 *        assetMeta lets us hand-tune per item if needed.]
 *
 * Run from apps/web (so node resolves three from apps/web/node_modules):
 *   cd apps/web && node scripts/generate-cosmetic-glbs.mjs
 */
// Node lacks FileReader (used by three's GLTFExporter to read its internal Blob).
// Polyfill using Blob.arrayBuffer() (available in Node 24+).
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
    }
    _fire(event) {
      this.onload?.(event);
      this.onloadend?.(event);
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((ab) => { this.result = ab; this._fire({ target: this }); })
        .catch((err) => this.onerror?.(err));
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((ab) => {
        const buf = Buffer.from(ab);
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${buf.toString('base64')}`;
        this._fire({ target: this });
      }).catch((err) => this.onerror?.(err));
    }
  };
}

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../apps/web/scripts → repo root is two levels up.
const REPO_ROOT = resolve(__dirname, '../../..');
const OUT_HATS = join(REPO_ROOT, 'apps/web/public/cosmetics/hats');
const OUT_GLASSES = join(REPO_ROOT, 'apps/web/public/cosmetics/glasses');

mkdirSync(OUT_HATS, { recursive: true });
mkdirSync(OUT_GLASSES, { recursive: true });

// --- materials (cached, reused) -------------------------------------------
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.1,
    roughness: opts.roughness ?? 0.6,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
}

// --- HATS ------------------------------------------------------------------

function makeTopHat() {
  const g = new THREE.Group();
  const black = mat(0x111111, { metalness: 0.05, roughness: 0.4 });
  const band = mat(0x661a2b, { metalness: 0.1, roughness: 0.8 });
  // Brim (flat disk)
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.012, 32), black);
  brim.position.y = 0;
  // Crown
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.105, 0.20, 32), black);
  crown.position.y = 0.106;
  // Band
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(0.108, 0.108, 0.022, 32), band);
  ribbon.position.y = 0.024;
  g.add(brim, crown, ribbon);
  return g;
}

function makeCowboy() {
  const g = new THREE.Group();
  const tan = mat(0x8b5a2b, { roughness: 0.8 });
  const dark = mat(0x3b2410, { roughness: 0.7 });
  // Wide brim with slight upturn (use thin torus + disk)
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.18, 0.012, 32), tan);
  brim.position.y = 0;
  // Crown — pinched dome
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.10, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), tan);
  crown.scale.set(1.0, 1.4, 0.85);
  crown.position.y = 0.012;
  // Band
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.103, 0.103, 0.018, 28), dark);
  band.position.y = 0.025;
  g.add(brim, crown, band);
  return g;
}

function makeBeanie() {
  const g = new THREE.Group();
  const red = mat(0xc0392b, { roughness: 0.9 });
  const cuffMat = mat(0x922b1f, { roughness: 0.95 });
  // Dome
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 18, 0, Math.PI * 2, 0, Math.PI / 1.9), red);
  dome.scale.y = 1.05;
  // Cuff
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.118, 0.118, 0.04, 28), cuffMat);
  cuff.position.y = 0.02;
  // Pom-pom
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), mat(0xfff5e1, { roughness: 1 }));
  pom.position.y = 0.21;
  g.add(dome, cuff, pom);
  return g;
}

function makeWizard() {
  const g = new THREE.Group();
  const purple = mat(0x4a1a8a, { roughness: 0.7 });
  const stars = mat(0xffd966, { emissive: 0xffd966, emissiveIntensity: 0.6, roughness: 0.4 });
  // Brim
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.012, 28), purple);
  // Tall cone crown
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.42, 28, 1, true), purple);
  crown.position.y = 0.215;
  // Star ornaments
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.018, 0), stars);
    s.position.set(
      Math.cos(i * Math.PI / 2) * 0.07,
      0.10 + i * 0.07,
      Math.sin(i * Math.PI / 2) * 0.07,
    );
    g.add(s);
  }
  g.add(brim, crown);
  return g;
}

function makeCrown() {
  const g = new THREE.Group();
  const gold = mat(0xfdc94d, { metalness: 0.85, roughness: 0.25, emissive: 0x4a3300, emissiveIntensity: 0.15 });
  const ruby = mat(0xc0153a, { metalness: 0.4, roughness: 0.2, emissive: 0x600510, emissiveIntensity: 0.4 });
  // Band
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.05, 32, 1, true), gold);
  band.position.y = 0.025;
  // Spikes
  const spikeCount = 8;
  for (let i = 0; i < spikeCount; i++) {
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.10, 12), gold);
    const a = (i / spikeCount) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.115, 0.10, Math.sin(a) * 0.115);
    s.lookAt(s.position.clone().multiplyScalar(2));
    s.rotateX(Math.PI / 2);
    g.add(s);
  }
  // Front ruby
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.025, 0), ruby);
  gem.position.set(0, 0.025, 0.115);
  g.add(band, gem);
  return g;
}

function makeBucket() {
  const g = new THREE.Group();
  const camo = mat(0x4a6840, { roughness: 0.85 });
  const cuff = mat(0x33502c, { roughness: 0.9 });
  // Crown
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.118, 0.10, 28), camo);
  crown.position.y = 0.05;
  // Top
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.115, 28), camo);
  top.position.y = 0.10;
  top.rotation.x = -Math.PI / 2;
  // Brim
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.16, 0.014, 32), cuff);
  brim.position.y = 0.0;
  g.add(crown, top, brim);
  return g;
}

// --- SUNGLASSES ------------------------------------------------------------
//
// Geometry origin = midpoint between eyes. y=0, x=0, z=0 is the bridge.
// Lenses are in the XY plane, slightly inset (-Z forward = away from face).

function makeLensPair(lensGeo, lensMat, frameMat, gap = 0.07) {
  const g = new THREE.Group();
  const left = new THREE.Mesh(lensGeo, lensMat);
  left.position.set(-gap, 0, 0);
  const right = new THREE.Mesh(lensGeo, lensMat);
  right.position.set(gap, 0, 0);
  // Frame ring (slightly larger silhouette behind lens)
  const frameLeft = new THREE.Mesh(lensGeo.clone().scale(1.08, 1.08, 1.08), frameMat);
  frameLeft.position.set(-gap, 0, -0.002);
  const frameRight = new THREE.Mesh(lensGeo.clone().scale(1.08, 1.08, 1.08), frameMat);
  frameRight.position.set(gap, 0, -0.002);
  // Bridge
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(gap * 0.8, 0.012, 0.01), frameMat);
  // Temples (arms)
  const tempLeft = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frameMat);
  tempLeft.position.set(-gap - 0.05, 0, -0.05);
  const tempRight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frameMat);
  tempRight.position.set(gap + 0.05, 0, -0.05);
  g.add(frameLeft, frameRight, left, right, bridge, tempLeft, tempRight);
  return g;
}

function lensCircle(rx = 0.038, ry = 0.030) {
  // Disc-like lens (very thin cylinder)
  return new THREE.CylinderGeometry(1, 1, 1, 24)
    .scale(rx, 0.003, ry)
    .rotateX(Math.PI / 2);
}

function makeClassicBlack() {
  const lens = mat(0x0a0a0a, { roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.85 });
  const frame = mat(0x000000, { roughness: 0.3, metalness: 0.2 });
  return makeLensPair(lensCircle(0.040, 0.032), lens, frame);
}

function makeRoseGold() {
  const lens = mat(0xe4a8b0, { roughness: 0.25, metalness: 0.5, transparent: true, opacity: 0.7 });
  const frame = mat(0xd49b87, { roughness: 0.2, metalness: 0.85 });
  return makeLensPair(lensCircle(0.036, 0.036), lens, frame);
}

function makeAviator() {
  const lens = mat(0x2a4a6a, { roughness: 0.2, metalness: 0.4, transparent: true, opacity: 0.7 });
  const frame = mat(0xc4b573, { roughness: 0.3, metalness: 0.85 });
  // Teardrop lens — stretched vertical ellipse
  const lensGeo = new THREE.CylinderGeometry(1, 1, 1, 24)
    .scale(0.038, 0.003, 0.042)
    .rotateX(Math.PI / 2);
  return makeLensPair(lensGeo, lens, frame, 0.075);
}

function makeCyberpunk() {
  const lens = mat(0x00d6ff, {
    emissive: 0x00aacc, emissiveIntensity: 0.9, transparent: true, opacity: 0.8, metalness: 0.1, roughness: 0.1,
  });
  const frame = mat(0x222831, { roughness: 0.4, metalness: 0.6 });
  // Wide rectangle lens (visor-y)
  const lensGeo = new THREE.BoxGeometry(0.08, 0.022, 0.005);
  return makeLensPair(lensGeo, lens, frame, 0.06);
}

function makeHeartGlasses() {
  const lens = mat(0xff80b3, { transparent: true, opacity: 0.7, roughness: 0.2 });
  const frame = mat(0xff3380, { metalness: 0.3, roughness: 0.4 });
  // Heart approximation: two spheres + cone
  const lensGroup = new THREE.Group();
  const r = 0.022;
  const a = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), lens);
  a.position.set(-0.018, 0.012, 0);
  a.scale.z = 0.15;
  const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), lens);
  b.position.set(0.018, 0.012, 0);
  b.scale.z = 0.15;
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.040, 0.040, 16), lens);
  c.position.set(0, -0.018, 0);
  c.rotation.z = Math.PI;
  c.scale.z = 0.15;
  lensGroup.add(a, b, c);

  // Build the heart-pair manually so we get distinct meshes per side
  const out = new THREE.Group();
  const gap = 0.075;
  const left = lensGroup.clone();
  left.position.x = -gap;
  const right = lensGroup.clone();
  right.position.x = gap;
  // Bridge
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(gap * 0.6, 0.012, 0.01), frame);
  // Temples
  const tempLeft = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frame);
  tempLeft.position.set(-gap - 0.05, 0, -0.05);
  const tempRight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frame);
  tempRight.position.set(gap + 0.05, 0, -0.05);
  out.add(left, right, bridge, tempLeft, tempRight);
  return out;
}

function makeShutter() {
  const frame = mat(0xffe14a, { roughness: 0.3, metalness: 0.4 });
  // Solid yellow rectangles per eye with horizontal shutter slits cut in (approx via stacked thin bars).
  function eye(x) {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.025, 0.005), frame);
    g.add(plate);
    // Slits — 3 dark bars
    const slit = mat(0x000000, { roughness: 0.6 });
    for (let i = -1; i <= 1; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.004, 0.006), slit);
      bar.position.y = i * 0.008;
      g.add(bar);
    }
    g.position.x = x;
    return g;
  }
  const out = new THREE.Group();
  out.add(eye(-0.06), eye(0.06));
  // Bridge
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.01), frame);
  out.add(bridge);
  // Temples
  const tempLeft = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frame);
  tempLeft.position.set(-0.10, 0, -0.05);
  const tempRight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.10), frame);
  tempRight.position.set(0.10, 0, -0.05);
  out.add(tempLeft, tempRight);
  return out;
}

// --- export helpers --------------------------------------------------------

function exportGLB(scene) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(Buffer.from(result));
        else reject(new Error('GLTFExporter returned non-binary'));
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

async function buildAndWrite(name, builder, outDir) {
  const root = new THREE.Group();
  root.name = name;
  root.add(builder());
  const buf = await exportGLB(root);
  const path = join(outDir, `${name}.glb`);
  writeFileSync(path, buf);
  console.log(`  ✓ ${path}  ${(buf.length / 1024).toFixed(1)} KB`);
}

// --- run -------------------------------------------------------------------

async function main() {
  console.log('Generating hats →', OUT_HATS);
  await buildAndWrite('top-hat',  makeTopHat,  OUT_HATS);
  await buildAndWrite('cowboy',   makeCowboy,  OUT_HATS);
  await buildAndWrite('beanie',   makeBeanie,  OUT_HATS);
  await buildAndWrite('wizard',   makeWizard,  OUT_HATS);
  await buildAndWrite('crown',    makeCrown,   OUT_HATS);
  await buildAndWrite('bucket',   makeBucket,  OUT_HATS);

  console.log('\nGenerating sunglasses →', OUT_GLASSES);
  await buildAndWrite('classic-black', makeClassicBlack, OUT_GLASSES);
  await buildAndWrite('rose-gold',     makeRoseGold,     OUT_GLASSES);
  await buildAndWrite('aviator',       makeAviator,      OUT_GLASSES);
  await buildAndWrite('cyberpunk',     makeCyberpunk,    OUT_GLASSES);
  await buildAndWrite('heart',         makeHeartGlasses, OUT_GLASSES);
  await buildAndWrite('shutter',       makeShutter,      OUT_GLASSES);

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
