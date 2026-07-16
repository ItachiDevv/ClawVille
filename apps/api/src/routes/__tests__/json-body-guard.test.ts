import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { jsonBodyGuard } from '../../middleware/json-body-guard';
import type { AppContext } from '../../types';
import { authRoutes } from '../auth';

function buildGuardApp() {
  const app = new Hono();
  app.use('*', jsonBodyGuard);
  app.post('/echo', async (c) => c.json(await c.req.json()));
  app.post('/route-decides', (c) => c.json({ reached: true }));
  app.post('/raw', async (c) => {
    c.header('x-observed-content-type', c.req.header('content-type') ?? 'missing');
    return c.text(await c.req.text());
  });
  app.post('/api/partner/probe', async (c) => c.text(await c.req.text()));
  return app;
}

describe('jsonBodyGuard', () => {
  it('returns invalid_json for a truncated JSON body', async () => {
    const response = await buildGuardApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns invalid_json for a non-JSON body', async () => {
    const response = await buildGuardApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('keeps valid JSON available to downstream c.req.json()', async () => {
    const body = { hello: 'world', count: 2 };
    const response = await buildGuardApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  it('passes an empty JSON request through so the route decides', async () => {
    const response = await buildGuardApp().request('/route-decides', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: true });
  });

  it('leaves garbage without a JSON content-type untouched', async () => {
    const rawBody = 'not json';
    const response = await buildGuardApp().request('/raw', {
      method: 'POST',
      body: new TextEncoder().encode(rawBody),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-observed-content-type')).toBe('missing');
    expect(await response.text()).toBe(rawBody);
  });

  it('passes exempt raw-body prefixes through byte-for-byte', async () => {
    const rawBody = '{  "signed": true,\n definitely-not-json';
    const response = await buildGuardApp().request('/api/partner/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(rawBody);
  });
});

describe('jsonBodyGuard with authRoutes', () => {
  it('returns 400 for malformed JSON on the real login route', async () => {
    // Deliberately uses no DATABASE_URL and no module mocks: invalid JSON must
    // short-circuit before auth reaches the database in the shared Bun process.
    const app = new Hono<AppContext>();
    app.use('*', jsonBodyGuard);
    app.route('/api/auth', authRoutes);

    const response = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
  });
});
