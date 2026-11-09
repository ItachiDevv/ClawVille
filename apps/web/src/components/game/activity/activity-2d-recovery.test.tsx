import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
let pathname = '/game';
mock.module('next/navigation', () => ({ usePathname: () => pathname }));
mock.module('@/lib/world-renderer-mode', () => ({ useWorldRendererMode: () => '2d', reloadWorldRenderer: () => {} }));
mock.module('@/hooks/use-auth-me', () => ({ useAuthMe: () => useQuery({ queryKey: ['auth-me'], queryFn: async () => null, enabled: false }) }));
mock.module('@/hooks/use-avatar', () => ({ useAvatar: () => useQuery({ queryKey: ['avatar'], queryFn: async () => null, enabled: false, select: (data: any) => data?.avatar }) }));
mock.module('@/hooks/use-avatar-heartbeat', () => ({ useAvatarHeartbeat: () => {} }));
mock.module('@/hooks/use-world-stream', () => ({ useWorldStream: () => {} }));
const notices: string[] = [];
mock.module('@/stores/game', () => ({ useGameStore: { getState: () => ({ addToast: (_: string, message: string) => notices.push(message) }) } }));
const { WorldPresence } = await import('@/components/three/world-stage/WorldPresence');
const { matchedActivity3DUrl } = await import('./activity-2d-recovery');
const { activityRequest } = await import('./activity-request');
let dom: JSDOM, root: Root, client: QueryClient;
let clock = 100000, timerId = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
const destinations: string[] = [], requests: string[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalNow = Date.now;
let handler: (url: string, init?: RequestInit) => Promise<Response>;
function setGlobal(key: string, value: unknown) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
beforeAll(() => {
 dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost/game?view=2d' });
 const browser = new Proxy(dom.window, { get(target, key) { if (key === 'location') return { assign: (url: string) => destinations.push(url) }; return Reflect.get(target, key, target); } });
 setGlobal('window', browser); setGlobal('document', dom.window.document); setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
 setGlobal('fetch', async (url: unknown, init?: RequestInit) => { requests.push(String(url)); return handler(String(url), init); });
 setGlobal('setTimeout', (fn: () => void, delay = 0) => { const id = ++timerId; timers.set(id, { at: clock + delay, fn }); return id; });
 setGlobal('clearTimeout', (id: number) => timers.delete(id));
 Date.now = () => clock;
});
afterEach(async () => { if (root) await act(async () => root.unmount()); client?.clear(); timers.clear(); requests.length = 0; destinations.length = 0; notices.length = 0; pathname = '/game'; });
afterAll(() => { Date.now = originalNow; dom.window.close(); for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
async function advance(ms: number) { clock += ms; await act(async () => { for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
async function mount(guest = false) {
 client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
 client.setQueryData(['auth-me'], { user: { id: 'user-1', isGuest: guest } }); client.setQueryData(['avatar'], { avatar: { id: 'avatar-1' } });
 root = createRoot(document.getElementById('test')!);
 await render(); await flush();
}
async function render() { await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(WorldPresence)))); }
const party = { id: 'party-1', members: [], shortCode: 'ABC123' };
const assignment = { matchedActivityId: 'reef-race', matchedRoomId: 'assigned-room', matchedRoomShortCode: 'ABC123' };
function ok(body: unknown = {}) { return Response.json(body); }

test('mounted recovery survives Office navigation while party leave waits and follows the exact assigned room', async () => {
 let release!: (value: Response) => void, assign!: (value: Response) => void;
 handler = async url => url.endsWith('/party/me') ? ok({ party }) : url.endsWith('/party/party-1/leave') ? new Promise(resolve => { release = resolve; }) : url.endsWith('/queue-status') ? new Promise(resolve => { assign = resolve; }) : ok();
 await mount(); expect(requests.filter(url => url.endsWith('/party/party-1/leave')).length).toBe(1);
 pathname = '/brainchain'; await render();
 await act(async () => { assign(ok(assignment)); }); await flush();
 expect(destinations).toEqual(['/activity/reef-race/assigned-room?shortCode=ABC123&view=3d']);
 expect(requests.filter(url => url.endsWith('/party/party-1/leave')).length).toBe(1);
 await act(async () => { release(ok({ party: null })); });
});
test('mounted guest polls assignment and never requests party operations', async () => {
 handler = async url => url.endsWith('/queue-status') ? ok(assignment) : ok();
 await mount(true); expect(destinations.length).toBe(1); expect(requests.some(url => url.includes('/party'))).toBe(false);
});
test('failed departures stay visible, retry after the throttle, and clear only after confirmed departure', async () => {
 let attempts = 0, exists = true;
 handler = async url => {
  if (url.endsWith('/party/me')) return ok({ party: exists ? party : null });
  if (url.endsWith('/party/party-1/leave')) { attempts++; if (attempts === 1) return Response.json({ message: 'DB unavailable' }, { status: 503 }); exists = false; return ok({ party: null }); }
  return ok({ matchedRoomId: null });
 };
 await mount(); expect(attempts).toBe(1); expect(document.body.textContent).toContain('DB unavailable');
 await advance(4999); expect(attempts).toBe(1); await advance(1); await flush();
 expect(attempts).toBe(2); expect(document.body.textContent).not.toContain('DB unavailable'); expect(notices.length).toBe(0);
});
test('logout, avatar change, and session reset discard late assignment responses', async () => {
 for (const change of ['logout', 'avatar', 'session']) {
  let release!: (value: Response) => void;
  handler = async url => url.endsWith('/queue-status') ? new Promise(resolve => { release = resolve; }) : ok({ party: null });
  await mount();
  await act(async () => {
   if (change === 'logout') client.setQueryData(['auth-me'], null);
   else if (change === 'avatar') client.setQueryData(['avatar'], { avatar: { id: 'avatar-2' } });
   else { void client.resetQueries({ queryKey: ['auth-me'] }); client.setQueryData(['auth-me'], { user: { id: 'user-1', isGuest: false } }); }
   release(ok(assignment));
  }); await flush(); expect(destinations.length).toBe(0);
  await act(async () => root.unmount()); client.clear(); timers.clear();
 }
});
test('unrelated world routes stop all recovery requests', async () => {
 handler = async () => ok({ party: null }); pathname = '/cove'; await mount(); expect(requests.length).toBe(0);
});
test('compatible timer aborts a stalled request and forwards caller abort without static AbortSignal helpers', async () => {
 handler = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
 const result = activityRequest('/test').catch(error => error); await advance(8000); expect((await result as Error).message).toContain('timed out');
 const controller = new AbortController(); const aborted = activityRequest('/test', {}, controller.signal).catch(error => error); controller.abort(); expect((await aborted as Error).name).toBe('AbortError');
});
test('malformed assignments never supply a destination', () => {
 expect(matchedActivity3DUrl({ ...assignment, matchedRoomId: '../elsewhere' })).toBeNull();
 expect(matchedActivity3DUrl({ ...assignment, matchedActivityId: 'unknown' })).toBeNull();
});

test('a failed queue cleanup without a party still recovers an authoritative match', async () => {
 handler = async url => url.endsWith('/leave-queue') ? Response.json({ message: 'cleanup unavailable' }, { status: 503 }) : url.endsWith('/queue-status') ? ok(assignment) : ok({ party: null });
 await mount(true); expect(destinations).toEqual(['/activity/reef-race/assigned-room?shortCode=ABC123&view=3d']);
});
