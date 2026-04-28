#!/usr/bin/env bun
/**
 * test-vrm-loader.ts
 *
 * Logic test for the per-instance VRM cache (Codex Critical #1 acceptance).
 *
 * Asserts:
 *   1. Two calls with the same path but different instanceId trigger two parses
 *      and return DIFFERENT VRM objects.
 *   2. Two calls with the same path share ONE network fetch.
 *   3. disposeVRMInstance evicts the instance entry but keeps the bytes cache.
 *   4. Concurrent loads of the same (path, instanceId) dedup to one parse.
 *
 * Real VRM parsing needs a browser DOM (textures, blob URLs). This test mocks
 * fetch + GLTFLoader.parseAsync at the module boundary so we can exercise the
 * cache logic in pure Node. The browser smoke test (manual) is the second
 * half of acceptance:
 *
 *   "Pick milady_official_7 as the player while wandering NPC milady-miu
 *   (also milady-official-7) is on-screen. Both must walk independently —
 *   no scene reparenting, no animation freeze on either."
 *
 * Run: bun run scripts/test-vrm-loader.ts
 */

import { mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Module mocks — must be set BEFORE importing vrm-loader.
// ---------------------------------------------------------------------------

let fetchCalls = 0;
let parseCalls = 0;

// Simulated bytes for any VRM path
const STUB_BYTES = new ArrayBuffer(64);
(globalThis as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL) => {
  fetchCalls++;
  return new Response(STUB_BYTES, { status: 200 });
}) as typeof fetch;

// Mock three's GLTFLoader.parseAsync to return a fresh "VRM-shaped" object each call
mock.module('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() { /* noop */ }
    register() { /* noop */ }
    parseAsync(_data: ArrayBuffer, _path: string) {
      parseCalls++;
      const scene = { traverse: () => {}, position: { set: () => {} } };
      const vrm = {
        scene,
        humanoid: {},
        expressionManager: {},
        lookAt: {},
        springBoneManager: null,
      };
      return Promise.resolve({ userData: { vrm } });
    }
  },
}));

mock.module('meshoptimizer', () => ({ MeshoptDecoder: {} }));
mock.module('@pixiv/three-vrm', () => ({
  VRMLoaderPlugin: class { constructor() { /* noop */ } },
  VRMUtils: {
    removeUnnecessaryVertices: () => {},
    rotateVRM0: () => {},
    deepDispose: () => {},
  },
}));
mock.module('@pixiv/three-vrm-materials-mtoon', () => ({
  MToonMaterialLoaderPlugin: class { constructor() { /* noop */ } },
}));

// ---------------------------------------------------------------------------
// Now import the loader (after mocks are in place)
// ---------------------------------------------------------------------------

const {
  loadVRMInstance,
  disposeVRMInstance,
  preloadVRMBytes,
  _vrmInstanceCount,
  _vrmClearAllCaches,
} = await import('../apps/web/src/lib/three/vrm-loader.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let failures = 0;
function assert(cond: unknown, label: string) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

async function run() {
  // Test 1 — disjoint per (path, instanceId)
  console.log('\n[1] Two instances of the same path are disjoint');
  _vrmClearAllCaches();
  fetchCalls = 0;
  parseCalls = 0;
  const v1 = await loadVRMInstance('npc-1', '/avatars/milady-official-7.vrm');
  const v2 = await loadVRMInstance('npc-2', '/avatars/milady-official-7.vrm');
  assert(v1 !== v2, 'v1 !== v2 (different VRM objects)');
  assert(v1.scene !== v2.scene, 'v1.scene !== v2.scene (different scenes)');
  assert(v1.humanoid !== v2.humanoid, 'v1.humanoid !== v2.humanoid (different humanoids)');
  assert(parseCalls === 2, `parseCalls === 2 (got ${parseCalls})`);
  assert(fetchCalls === 1, `fetchCalls === 1 — bytes shared (got ${fetchCalls})`);

  // Test 2 — same instanceId returns the cached VRM
  console.log('\n[2] Same instanceId returns the cached VRM');
  parseCalls = 0;
  const v1b = await loadVRMInstance('npc-1', '/avatars/milady-official-7.vrm');
  assert(v1b === v1, 'v1b === v1 (same cached instance)');
  assert(parseCalls === 0, `parseCalls === 0 (no re-parse, got ${parseCalls})`);

  // Test 3 — disposal evicts instance, keeps bytes
  console.log('\n[3] dispose evicts instance, keeps bytes cache');
  const beforeCount = _vrmInstanceCount();
  disposeVRMInstance('/avatars/milady-official-7.vrm', 'npc-1');
  const afterCount = _vrmInstanceCount();
  assert(afterCount === beforeCount - 1, `instance count decreased by 1 (${beforeCount} → ${afterCount})`);

  // Re-loading 'npc-1' parses again but does NOT re-fetch
  fetchCalls = 0;
  parseCalls = 0;
  const v1c = await loadVRMInstance('npc-1', '/avatars/milady-official-7.vrm');
  assert(v1c !== v1, 'v1c !== v1 (fresh instance after dispose)');
  assert(parseCalls === 1, `parseCalls === 1 — re-parsed (got ${parseCalls})`);
  assert(fetchCalls === 0, `fetchCalls === 0 — bytes still cached (got ${fetchCalls})`);

  // Test 4 — concurrent loads dedup to one parse
  console.log('\n[4] Concurrent loads of same (path, id) dedup to one parse');
  _vrmClearAllCaches();
  fetchCalls = 0;
  parseCalls = 0;
  const [a, b, c] = await Promise.all([
    loadVRMInstance('shared-id', '/avatars/x.vrm'),
    loadVRMInstance('shared-id', '/avatars/x.vrm'),
    loadVRMInstance('shared-id', '/avatars/x.vrm'),
  ]);
  assert(a === b && b === c, 'all three resolve to the same VRM');
  assert(parseCalls === 1, `parseCalls === 1 — single parse (got ${parseCalls})`);
  assert(fetchCalls === 1, `fetchCalls === 1 — single fetch (got ${fetchCalls})`);

  // Test 5 — preloadVRMBytes warms the byte cache
  console.log('\n[5] preloadVRMBytes warms byte cache without parsing');
  _vrmClearAllCaches();
  fetchCalls = 0;
  parseCalls = 0;
  preloadVRMBytes('/avatars/y.vrm');
  await new Promise((r) => setTimeout(r, 20));
  assert(fetchCalls === 1, `fetchCalls === 1 — preload triggered fetch (got ${fetchCalls})`);
  assert(parseCalls === 0, `parseCalls === 0 — no parse during preload (got ${parseCalls})`);
  // Now load — should hit byte cache, no re-fetch
  fetchCalls = 0;
  await loadVRMInstance('y-1', '/avatars/y.vrm');
  assert(fetchCalls === 0, `fetchCalls === 0 — byte cache hit (got ${fetchCalls})`);
  assert(parseCalls === 1, `parseCalls === 1 — parsed once (got ${parseCalls})`);

  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();
