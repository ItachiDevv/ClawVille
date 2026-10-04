/**
 * Integration: the REAL path a world GLB takes — useGLTFWithKTX2 /
 * useOptionalGLTFWithKTX2 -> drei useGLTF -> R3F useLoader (suspend-react
 * global cache) -> R3F's shared three-stdlib GLTFLoader -> three r185
 * FileLoader -> fetch. Only `fetch` is replaced. The reads run outside React:
 * useGLTF / useLoader call no React hooks, and suspend-react throws the
 * pending promise exactly as it does for Suspense.
 *
 * suspend-react's cache is global and permanent for the process, so every
 * test uses its own URL. Absolute URLs: bun's Request has no document base.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const testWindow = new Window({ url: 'http://localhost/game' });
const originalFetch = globalThis.fetch;
const hadProgressEvent = 'ProgressEvent' in globalThis;

// Valid glTF 2.0 (JSON form; GLTFLoader.parse accepts it from an ArrayBuffer).
const VALID_GLTF = JSON.stringify({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'deco-root' }],
});

type Reply = 'network-error' | number | 'valid' | 'garbage';
const plans = new Map<string, Reply[]>();
const requests = new Map<string, number>();

function plan(url: string, replies: Reply[]): string {
  plans.set(url, [...replies]);
  requests.set(url, 0);
  return url;
}

function mockFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.set(url, (requests.get(url) ?? 0) + 1);
  const reply = plans.get(url)?.shift() ?? 'valid';
  if (reply === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
  if (typeof reply === 'number') {
    return Promise.resolve(new Response('upstream error', { status: reply, statusText: `status ${reply}` }));
  }
  const body = reply === 'valid' ? VALID_GLTF : 'this is not a GLB {';
  return Promise.resolve(new Response(new TextEncoder().encode(body), { status: 200 }));
}

let useGLTFWithKTX2: typeof import('./use-gltf-ktx2').useGLTFWithKTX2;
let useOptionalGLTFWithKTX2: typeof import('./use-gltf-ktx2').useOptionalGLTFWithKTX2;

beforeAll(async () => {
  // FileLoader streams the body and emits ProgressEvent (absent in bun).
  if (!hadProgressEvent) {
    (globalThis as Record<string, unknown>).ProgressEvent = testWindow.ProgressEvent;
  }
  globalThis.fetch = mockFetch as typeof fetch;
  ({ useGLTFWithKTX2, useOptionalGLTFWithKTX2 } = await import('./use-gltf-ktx2'));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (!hadProgressEvent) delete (globalThis as Record<string, unknown>).ProgressEvent;
  await testWindow.happyDOM.close();
});

/** Calls `read` like React would: on a thrown promise, wait and read again. */
async function readUntilSettled<T>(read: () => T): Promise<T> {
  for (let i = 0; i < 20; i += 1) {
    try {
      return read();
    } catch (thrown) {
      if (!(thrown instanceof Promise)) throw thrown;
      await thrown;
    }
  }
  throw new Error('read never settled');
}

function captureConsoleError() {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  return { logged, restore: () => (console.error = original) };
}

describe('real useGLTF -> R3F useLoader -> GLTFLoader -> FileLoader path', () => {
  test('one failed fetch, then success: the model loads (one retry, ~500 ms)', async () => {
    const url = plan('http://localhost/models/it-once.glb?v=2', ['network-error', 'valid']);
    const gltf = await readUntilSettled(() => useGLTFWithKTX2(url));
    expect(gltf.scene.getObjectByName('deco-root')).toBeTruthy();
    expect(requests.get(url)).toBe(2);
  });

  test('HTTP 503 once, then success: the model loads', async () => {
    const url = plan('http://localhost/models/it-503.glb?v=5', [503, 'valid']);
    const gltf = await readUntilSettled(() => useGLTFWithKTX2(url));
    expect(gltf.scene.getObjectByName('deco-root')).toBeTruthy();
    expect(requests.get(url)).toBe(2);
  });

  test('invalid GLB bytes: no retry; optional read skips with one console.error; required read still throws the cached rejection', async () => {
    const url = plan('http://localhost/models/it-corrupt.glb?v=3', ['garbage', 'valid']);
    const cap = captureConsoleError();
    let optional: unknown;
    try {
      optional = await readUntilSettled(() => useOptionalGLTFWithKTX2(url));
      // A re-render reads the cached rejection again: still null, no new log.
      expect(useOptionalGLTFWithKTX2(url)).toBeNull();
    } finally {
      cap.restore();
    }
    expect(optional).toBeNull();
    expect(requests.get(url)).toBe(1);
    const skipped = cap.logged.filter((args) => String(args[0]).includes('[GLB] optional model skipped'));
    expect(skipped.length).toBe(1);
    expect(String(skipped[0][0])).toContain(url);
    expect(String(skipped[0][0])).toContain('(parse/decode error) SyntaxError');

    // Cached rejection: the non-optional read throws without a new request.
    expect(() => useGLTFWithKTX2(url)).toThrow(`Could not load ${url}: `);
    expect(requests.get(url)).toBe(1);
  });

  test('a ?v=N path only matches its own rejection; a 404 is not retried and logs as a fetch error', async () => {
    const failing = plan('http://localhost/models/it-ver.glb?v=7', [404]);
    const cap = captureConsoleError();
    try {
      expect(await readUntilSettled(() => useOptionalGLTFWithKTX2(failing))).toBeNull();
      expect(useOptionalGLTFWithKTX2(failing)).toBeNull();
    } finally {
      cap.restore();
    }
    expect(requests.get(failing)).toBe(1);
    const skipped = cap.logged.filter((args) => String(args[0]).includes('[GLB] optional model skipped'));
    expect(skipped.length).toBe(1);
    expect(String(skipped[0][0])).toContain(`${failing} (fetch error after 1 request(s)) HttpError: `);

    // Same file, different version: its own load, untouched by the ?v=7 failure.
    const other = plan('http://localhost/models/it-ver.glb?v=8', ['valid']);
    const gltf = await readUntilSettled(() => useOptionalGLTFWithKTX2(other));
    expect(gltf?.scene.getObjectByName('deco-root')).toBeTruthy();
  });
});
