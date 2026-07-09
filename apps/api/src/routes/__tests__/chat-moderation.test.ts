/**
 * Chat-moderation route-level guard tests.
 *
 * Two layers:
 *  1. BEHAVIOR — a minimal Hono handler replicating the exact call-site pattern
 *     (moderate input → 400 content_blocked → else reach the "LLM") proves a
 *     blocked input returns 400 `content_blocked` and NEVER reaches the LLM,
 *     while a clean input passes through. Uses the moderation service's test
 *     seam; does NOT import the real routers (they run module-load side effects
 *     like the fingerprint-secret throw + DB init — mirrors the readFileSync
 *     approach the other route tests use for the same reason).
 *  2. STRUCTURE — reads each covered route's SOURCE and asserts the moderation
 *     call is present at the right chokepoint, so removing the guard fails CI.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Hono } from 'hono';
import {
  moderateText,
  __setModerationBackendForTests,
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
  type ModerationBackend,
} from '../../services/moderation-service';

afterEach(() => __setModerationBackendForTests(null));

function backend(flagged: boolean): ModerationBackend {
  return { name: 'test', moderate: async () => ({ flagged, categories: flagged ? ['hate'] : [] }) };
}

// Minimal handler that mirrors the production call-site pattern exactly.
function buildApp(llmSpy: () => void) {
  const app = new Hono();
  app.post('/chat', async (c) => {
    const { content } = await c.req.json();
    const inMod = await moderateText(content, { surface: 'test-chat', direction: 'input' });
    if (!inMod.allowed) {
      return c.json({ error: CONTENT_BLOCKED_MESSAGE, code: CONTENT_BLOCKED_CODE }, 400);
    }
    llmSpy(); // stands in for runtime.processMessage — must NOT run on a block
    return c.json({ ok: true });
  });
  return app;
}

describe('chat moderation — behavior', () => {
  it('blocked input → 400 content_blocked and the LLM is never called', async () => {
    __setModerationBackendForTests(backend(true));
    let llmCalled = false;
    const app = buildApp(() => {
      llmCalled = true;
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'flagged text' }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe(CONTENT_BLOCKED_CODE);
    expect(llmCalled).toBe(false);
  });

  it('clean input → reaches the LLM and returns ok', async () => {
    __setModerationBackendForTests(backend(false));
    let llmCalled = false;
    const app = buildApp(() => {
      llmCalled = true;
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(llmCalled).toBe(true);
  });
});

describe('chat moderation — structural regression lock', () => {
  const ROUTES = join(import.meta.dir, '..');
  const read = (f: string) => readFileSync(join(ROUTES, f), 'utf8');

  const INPUT_SURFACES: Array<{ file: string; surface: string }> = [
    { file: 'chat.ts', surface: 'system-chat' },
    { file: 'chat.ts', surface: 'location-chat' },
    { file: 'chat-transient.ts', surface: 'transient-chat' },
    { file: 'avatars.ts', surface: 'avatar-chat' },
    { file: 'avatars.ts', surface: 'avatar-directive' },
  ];

  for (const { file, surface } of INPUT_SURFACES) {
    it(`${file} moderates input at surface '${surface}' and blocks with content_blocked`, () => {
      const src = read(file);
      expect(src).toContain("from '../services/moderation-service'");
      expect(src).toContain(`surface: '${surface}', direction: 'input'`);
      expect(src).toContain('code: CONTENT_BLOCKED_CODE');
    });
  }

  it('chat.ts moderates OUTPUT for both public personas (system + location)', () => {
    const src = read('chat.ts');
    expect(src).toContain("surface: 'system-chat', direction: 'output'");
    expect(src).toContain("surface: 'location-chat', direction: 'output'");
    expect(src).toContain('OUTPUT_REFUSAL_MESSAGE');
  });
});
