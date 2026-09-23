import { expect, test } from 'bun:test';
import { checkBoundAppearance } from './agent-onboarding-smoke';

test('appearance probe distinguishes discovery and PATCH failures without response payloads', async () => {
  let discoveryFails = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith('/tools.json') && !discoveryFails) {
      return Response.json([{ name: 'clawville_update_appearance', description: 'PATCH /api/avatars/me/appearance' }]);
    }
    return new Response('private response must not enter diagnostics', { status: 403 });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await expect(checkBoundAppearance(base, 'test-bearer', 'owned-avatar', 'owned-user')).rejects.toThrow('appearance tools discovery HTTP 403');
    discoveryFails = false;
    await expect(checkBoundAppearance(base, 'test-bearer', 'owned-avatar', 'owned-user')).rejects.toThrow('appearance PATCH HTTP 403');
  } finally { server.stop(true); }
});

test('onboarding appearance check uses only the bound bearer and rejects another avatar', async () => {
  let wrongOwner = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/tools.json')) {
      return Response.json([{ name: 'clawville_update_appearance', description: 'PATCH /api/avatars/me/appearance' }]);
    }
    expect(request.method).toBe('PATCH');
    expect(request.headers.get('X-Clawville-Agent-Session')).toBe('test-bearer');
    expect(request.headers.get('Cookie')).toBeNull();
    expect(await request.json()).toEqual({ color: 'red' });
    return Response.json({ avatar: { id: wrongOwner ? 'other-avatar' : 'owned-avatar', userId: 'owned-user', color: 'red' } });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await checkBoundAppearance(base, 'test-bearer', 'owned-avatar', 'owned-user');
    wrongOwner = true;
    await expect(checkBoundAppearance(base, 'test-bearer', 'owned-avatar', 'owned-user')).rejects.toThrow('wrong bound avatar');
  } finally { server.stop(true); }
});
