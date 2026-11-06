/**
 * Studios sign-in routes, no DB needed:
 *  - the request logger never prints the callback's `code`, `state` or `iss`
 *    (the same redaction index.ts applies to every log line);
 *  - the 1 KB body limit runs BEFORE jsonBodyGuard reads anything (the router
 *    is mounted ahead of the guard, as in index.ts);
 *  - index.ts keeps that order and that log redaction.
 */
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = '0'.repeat(64);
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { jsonBodyGuard } from '../../middleware/json-body-guard';
import { redactBearerTokens } from '../../services/log-redact';
import { redactStudiosOAuthCallbackQuery, vendorStudiosOAuthRoutes } from '../vendor-studios-oauth';

const CODE = 'secret-auth-code-7f3a9c';
const STATE = 'secret-state-b81d22e0';

/** The same composition as `redactLogLine` in index.ts. */
const redactLogLine = (line: string): string => redactBearerTokens(redactStudiosOAuthCallbackQuery(line));

function appLikeIndex(lines: string[] | null = null): Hono {
  const app = new Hono();
  if (lines) app.use('*', logger((message: string, ...rest: string[]) => {
    lines.push([message, ...rest].map((part) => (typeof part === 'string' ? redactLogLine(part) : String(part))).join(' '));
  }));
  app.route('/api/vendors/studios/oauth', vendorStudiosOAuthRoutes);
  app.use('*', jsonBodyGuard);
  return app;
}

describe('studios sign-in: request log redaction', () => {
  it('the callback request and response log lines carry neither the code nor the state', async () => {
    const lines: string[] = [];
    const res = await appLikeIndex(lines).request(
      `/api/vendors/studios/oauth/callback?code=${CODE}&state=${STATE}&iss=https%3A%2F%2Fmystudios.fun`,
    );
    expect(res.status).toBe(302);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain('/api/vendors/studios/oauth/callback?<redacted>');
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(STATE);
      expect(line).not.toContain('mystudios');
    }
    expect(res.headers.get('location') ?? '').not.toContain(CODE);
  });

  it('leaves other routes and their queries unchanged', () => {
    expect(redactStudiosOAuthCallbackQuery('<-- GET /api/leaderboard/agents?window=7d'))
      .toBe('<-- GET /api/leaderboard/agents?window=7d');
    expect(redactStudiosOAuthCallbackQuery('--> GET /api/vendors/studios/oauth/callback?code=a&state=b 302 3ms'))
      .toBe('--> GET /api/vendors/studios/oauth/callback?<redacted> 302 3ms');
    expect(redactStudiosOAuthCallbackQuery('--> GET /api/vendors/studios/oauth/callback 302 3ms'))
      .toBe('--> GET /api/vendors/studios/oauth/callback 302 3ms');
  });
});

describe('studios sign-in: body limit before jsonBodyGuard', () => {
  // With a declared Content-Length the limit refuses at once, before auth.
  // A body without Content-Length is refused when the handler reads it
  // (authenticated cases: routes/__tests__/studios-oauth-db.test.ts).
  for (const [method, path] of [['POST', '/start'], ['POST', '/challenge'], ['DELETE', '']] as const) {
    it(`${method} ${path || '/'} refuses a declared body over 1 KB with 413 before any auth or JSON read`, async () => {
      const body = JSON.stringify({ proof: { nonce: 'n', signature: 's' }, pad: 'x'.repeat(3000) });
      const res = await appLikeIndex().request(`/api/vendors/studios/oauth${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(body).byteLength) },
        body,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'payload_too_large', code: 'payload_too_large' });
    });
  }
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'index.ts'), 'utf8');

  it('mounts the sign-in routes before jsonBodyGuard and before the parent Studios prefix', () => {
    const mount = source.indexOf("app.route('/api/vendors/studios/oauth', vendorStudiosOAuthRoutes);");
    const guard = source.indexOf("app.use('*', jsonBodyGuard);");
    const parent = source.indexOf("app.route('/api/vendors/studios', vendorStudiosRoutes);");
    expect(mount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(mount);
    expect(parent).toBeGreaterThan(mount);
    expect(source.split("vendorStudiosOAuthRoutes);").length - 1).toBe(1);
  });

  it('passes every request log line through the callback query redaction', () => {
    expect(source).toContain('const redactLogLine = (line: string): string => redactBearerTokens(redactStudiosOAuthCallbackQuery(line));');
    expect(source).toContain('redactLogLine(message),');
    expect(source).toContain("(typeof r === 'string' ? redactLogLine(r) : r)");
  });
});
