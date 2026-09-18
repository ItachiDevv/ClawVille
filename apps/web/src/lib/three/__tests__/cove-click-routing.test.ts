import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  COVE_SIGN_HEIGHT,
  COVE_SIGN_WIDTH,
  coveSignContainsUv,
  coveSignHalfWidthAt,
  filterCoveSignHits,
  shouldYieldToFartherHotspot,
} from '../cove-click-routing';

describe('sign capsule outline', () => {
  test('full width at mid-height, straight-edge width at top and bottom', () => {
    expect(coveSignHalfWidthAt(0)).toBe(COVE_SIGN_WIDTH / 2);
    expect(coveSignHalfWidthAt(COVE_SIGN_HEIGHT / 2)).toBeCloseTo(COVE_SIGN_WIDTH / 2 - COVE_SIGN_HEIGHT / 2, 9);
    expect(coveSignHalfWidthAt(COVE_SIGN_HEIGHT / 2 + 1)).toBe(-1);
  });
  test('a transparent corner is outside, the rounded cap at mid-height is inside', () => {
    // Local points, converted to UV.
    const uv = (x: number, y: number): [number, number] => [x / COVE_SIGN_WIDTH + 0.5, y / COVE_SIGN_HEIGHT + 0.5];
    expect(coveSignContainsUv(...uv(-118.4, 29))).toBe(false); // Codex round-2 corner
    expect(coveSignContainsUv(...uv(-110.4, 0))).toBe(true); // Codex round-1 cap point
    expect(coveSignContainsUv(...uv(0, 0))).toBe(true);
    expect(coveSignContainsUv(...uv(119, 29))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing replay. World positions measured in the live cove (2026-09-18 probe):
// BLACKJACK table box centre (412, 170, 469), sign (412, 280, 469); BACCARAT
// box (399, 170, 818), sign moved to (299, 460, 818). Boxes 200x340x150.
// Delivery follows R3F: every hit with a handler, nearest first; a box calls
// the yield rule and passes the click on when it yields; a sign never yields.
// No room geometry here (in the live room the first room hit on these rays is
// behind both signs, per the review's replay).
// ---------------------------------------------------------------------------
type Target = { name: string; kind: 'box' | 'sign' };
function buildScene(outlineFilter = true) {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial();
  const box = (name: string, p: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(200, 340, 150), mat);
    m.position.set(...p);
    m.userData = { coveHotspot: true, target: { name, kind: 'box' } as Target };
    scene.add(m);
  };
  const signGeo = new THREE.PlaneGeometry(COVE_SIGN_WIDTH, COVE_SIGN_HEIGHT);
  const sign = (name: string, p: [number, number, number]) => {
    const g = new THREE.Group();
    g.position.set(...p);
    for (const rotY of [0, Math.PI]) {
      const m = new THREE.Mesh(signGeo, mat);
      m.rotation.y = rotY;
      m.userData = { coveHotspot: true, target: { name, kind: 'sign' } as Target };
      if (outlineFilter) m.raycast = function (raycaster, intersects) {
        const start = intersects.length;
        THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
        filterCoveSignHits(intersects, start);
      };
      g.add(m);
    }
    scene.add(g);
  };
  box('blackjack', [412, 170, 469]);
  sign('blackjack', [412, 280, 469]);
  box('baccarat', [399, 170, 818]);
  sign('baccarat', [299, 460, 818]);
  scene.updateMatrixWorld(true);
  return scene;
}

function route(from: [number, number, number], to: [number, number, number], outlineFilter = true): Target | null {
  const scene = buildScene(outlineFilter);
  const origin = new THREE.Vector3(...from);
  const dir = new THREE.Vector3(...to).sub(origin).normalize();
  const hits = new THREE.Raycaster(origin, dir).intersectObjects(scene.children, true);
  // One hit per object, nearest first (as R3F delivers).
  const seen = new Set<THREE.Object3D>();
  const unique = hits.filter((h) => (seen.has(h.object) ? false : (seen.add(h.object), true)));
  for (const h of unique) {
    const t = h.object.userData.target as Target;
    if (t.kind === 'sign') return t;
    const yieldIt = shouldYieldToFartherHotspot(unique, h.object, h.distance, null, (o) =>
      (o as THREE.Object3D).userData?.coveHotspot === true,
    );
    if (!yieldIt) return t;
  }
  return null;
}

describe('cove click routing replay', () => {
  test('Codex round 2: a ray through a transparent BLACKJACK corner reaches the BACCARAT sign', () => {
    expect(route([289.34437, 190, 194.2755], [299, 460, 817.6])?.name).toBe('baccarat');
  });
  test('guard: without the outline filter the same ray goes to BLACKJACK (the bug)', () => {
    expect(route([289.34437, 190, 194.2755], [299, 460, 817.6], false)?.name).toBe('blackjack');
  });
  test('Codex round 1: rear aisle aiming at the BLACKJACK sign cap opens blackjack', () => {
    expect(route([0, 190, 1200], [301.6, 280, 469])?.name).toBe('blackjack');
  });
  test('spawn: the BLACKJACK sign cap at mid-height opens blackjack', () => {
    expect(route([-17, 190, -1025], [301.6, 280, 469])?.name).toBe('blackjack');
  });
  test('spawn: sign centres open their own tables', () => {
    expect(route([-17, 190, -1025], [412, 280, 469])?.name).toBe('blackjack');
    expect(route([-17, 190, -1025], [299, 460, 818])?.name).toBe('baccarat');
  });
});
