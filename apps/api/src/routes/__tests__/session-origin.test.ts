/**
 * Every Lucia session creator records how the session was made
 * (`sessions.created_via`, migration 0089). Human-only routes trust this
 * origin, so the agent-to-cookie exchange must stay labelled 'agent_exchange'
 * and no creator may omit the label. Source-level pin: the creators live in
 * large route files whose full flows need a live database.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROUTES = join(import.meta.dir, '..');

function createSessionCalls(file: string): string[] {
  const text = readFileSync(resolve(ROUTES, file), 'utf8');
  return [...text.matchAll(/lucia\.createSession\(([^)]*)\)/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
}

describe('session origin labels', () => {
  it('labels each auth.ts session creator', () => {
    expect(createSessionCalls('auth.ts')).toEqual([
      "userId, { createdVia: 'password' }",
      "user.id, { createdVia: 'password' }",
      "consumed.userId, { createdVia: 'magic_link' }",
      "user.id, { createdVia: 'agent_exchange' }",
      "userId, { createdVia: 'guest' }",
    ]);
  });

  it('labels the agent-to-cookie exchange as agent_exchange', () => {
    const text = readFileSync(join(ROUTES, 'auth.ts'), 'utf8');
    const start = text.indexOf("authRoutes.post('/milady-session-exchange'");
    expect(start).toBeGreaterThan(-1);
    const next = text.indexOf('authRoutes.', start + 10);
    const body = text.slice(start, next === -1 ? undefined : next);
    expect(body).toContain("lucia.createSession(user.id, { createdVia: 'agent_exchange' })");
  });

  it('labels the avatar-create session', () => {
    expect(createSessionCalls('avatars.ts')).toEqual(["ownerId, { createdVia: 'avatar_create' }"]);
  });

  it('labels the Next.js login and signup session creators', () => {
    const webAuth = join(import.meta.dir, '../../../../web/src/app/api/auth');
    expect(createSessionCalls(join(webAuth, 'login/route.ts'))).toEqual(["user.id, { createdVia: 'password' }"]);
    expect(createSessionCalls(join(webAuth, 'signup/route.ts'))).toEqual(["userId, { createdVia: 'password' }"]);
  });
});
