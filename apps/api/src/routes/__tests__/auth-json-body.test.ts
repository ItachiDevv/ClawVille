import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AppContext } from '../../types';
import { authRoutes } from '../auth';

const app = new Hono<AppContext>();
app.route('/', authRoutes);

describe('public auth JSON body parsing', () => {
  it('returns 400 for an empty login body without touching the database', async () => {
    const response = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a malformed login body without touching the database', async () => {
    const response = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });

    expect(response.status).toBe(400);
  });

  it('keeps the anti-enumeration generic 200 for empty and malformed forgot-password bodies', async () => {
    // Pre-fix behavior: `.catch(() => ({}))` coerced parse failures to {} and
    // schema-invalid bodies get the generic success. Preserved byte-identical —
    // a 400 here would give probes a distinguishable response.
    const emptyResponse = await app.request('/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const malformedResponse = await app.request('/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });

    expect(emptyResponse.status).toBe(200);
    expect(malformedResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual(await malformedResponse.json());
  });

  it('does not 400 a bodyless guest signup (coerces to {} — the pre-fix contract)', async () => {
    // Without DATABASE_URL the handler proceeds past validation and fails
    // later at the DB layer — anything but 400 proves the parse guard did
    // not reject the missing body.
    const response = await app.request('/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).not.toBe(400);
  });
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('public auth JSON body parsing (requires DATABASE_URL)', () => {
  it('keeps valid-shape unknown credentials on the existing 401 path', async () => {
    const response = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `missing-${crypto.randomUUID()}@example.com`,
        password: 'unknown-password',
      }),
    });

    expect(response.status).toBe(401);
  });
});
