/**
 * warmSuspenseRead contract + the drei/R3F guard it depends on (web-load T7).
 *
 * The guard pins two facts of drei 10.7 useGLTF / R3F 9.5 useLoader that the
 * boot-critical warm relies on. If a dependency upgrade breaks either, these
 * tests fail instead of the buildings silently falling back to a starvable
 * Suspense retry:
 *   1. Calling useGLTF OUTSIDE render throws the cache entry's thenable (it
 *      calls no React hook, so no "Invalid hook call" Error).
 *   2. The cache key is [GLTFLoader, url] only: an entry warmed with one
 *      loader extender is a synchronous hit for a read with another.
 * Runs in its own process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { useGLTF } from '@react-three/drei';
import { SUSPENSE_WARM_MAX_RETRIES, warmSuspenseRead } from './suspense-cache-warm';

describe('warmSuspenseRead', () => {
  test('a resolved read returns after one read', async () => {
    let reads = 0;
    await warmSuspenseRead(() => {
      reads += 1;
      return 'value';
    });
    expect(reads).toBe(1);
  });

  test('awaits a thrown thenable, then re-reads the resolved entry', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    let loaded = false;
    let reads = 0;
    const warm = warmSuspenseRead(() => {
      reads += 1;
      if (!loaded) throw pending;
      return 'value';
    });
    expect(reads).toBe(1);
    loaded = true;
    resolve();
    await warm;
    expect(reads).toBe(2);
  });

  test('gives up after the retry cap when every read throws a NEW thenable (key mismatch)', async () => {
    let reads = 0;
    await warmSuspenseRead(() => {
      reads += 1;
      throw Promise.resolve();
    });
    expect(SUSPENSE_WARM_MAX_RETRIES).toBe(2);
    expect(reads).toBe(1 + SUSPENSE_WARM_MAX_RETRIES);
  });

  test('a thrown Error resolves at once (the render rethrows it into the boundary)', async () => {
    let reads = 0;
    await expect(
      warmSuspenseRead(() => {
        reads += 1;
        throw new Error('Could not load /x.glb: 404');
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(1);
  });

  test('a rejecting thenable never rejects the warm; the re-read sees the cached Error', async () => {
    let failed = false;
    let reads = 0;
    const rejected = Promise.reject(new Error('network'));
    rejected.catch(() => undefined);
    await expect(
      warmSuspenseRead(() => {
        reads += 1;
        if (!failed) {
          failed = true;
          throw rejected;
        }
        throw new Error('Could not load /x.glb: network');
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });
});

// Minimal valid glTF 2.0 (JSON). GLTFLoader parses non-binary input as JSON.
const MINIMAL_GLTF = JSON.stringify({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'guard-node' }],
});

describe('drei useGLTF guard (outside render)', () => {
  const originalFetch = globalThis.fetch;
  const progressDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ProgressEvent');
  let fetches = 0;
  beforeAll(() => {
    // three's FileLoader emits ProgressEvent while streaming; Bun has none.
    if (typeof (globalThis as { ProgressEvent?: unknown }).ProgressEvent === 'undefined') {
      Object.defineProperty(globalThis, 'ProgressEvent', {
        value: class ProgressEvent extends Event {
          lengthComputable: boolean;
          loaded: number;
          total: number;
          constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
            super(type);
            this.lengthComputable = init.lengthComputable ?? false;
            this.loaded = init.loaded ?? 0;
            this.total = init.total ?? 0;
          }
        },
        configurable: true,
        writable: true,
      });
    }
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(MINIMAL_GLTF, {
        status: 200,
        headers: { 'Content-Type': 'model/gltf+json' },
      });
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (progressDescriptor) Object.defineProperty(globalThis, 'ProgressEvent', progressDescriptor);
    else delete (globalThis as { ProgressEvent?: unknown }).ProgressEvent;
  });

  test('throws a thenable (not "Invalid hook call"), and the key ignores the extender', async () => {
    const url = 'http://guard.test/models/guard.gltf';
    const extenderA = () => undefined;
    const extenderB = () => undefined;

    let thrown: unknown;
    try {
      useGLTF(url, false, false, extenderA);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof Error).toBe(false);
    expect(typeof (thrown as { then?: unknown }).then).toBe('function');

    await warmSuspenseRead(() => useGLTF(url, false, false, extenderA));

    // Same [GLTFLoader, url] key, different extender: a synchronous hit.
    const gltf = useGLTF(url, false, false, extenderB) as unknown as {
      scene: { getObjectByName: (name: string) => unknown };
    };
    expect(gltf.scene.getObjectByName('guard-node')).toBeDefined();
    expect(fetches).toBe(1);
  });
});
