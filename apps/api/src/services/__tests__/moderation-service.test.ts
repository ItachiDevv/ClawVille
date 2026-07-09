/**
 * moderation-service unit tests.
 *
 * Covers the v1 guardrail contract:
 *  - flagged verdict  → allowed:false, decision:'block', categories surfaced
 *  - clean verdict    → allowed:true,  decision:'allow'
 *  - backend throws   → FAIL-OPEN (allowed:true, decision:'error')
 *  - kill switch      → MODERATION_ENABLED=false → allowed:true, no backend call
 *  - empty text       → allowed:true, no backend call
 *  - unknown backend  → FAIL-OPEN
 *
 * The backend is injected via the test seam (`__setModerationBackendForTests`)
 * so no network/OPENAI_API_KEY is required. Real OpenAI transport (endpoint,
 * status parsing) is exercised via the global-fetch mock in the last block.
 */

import { describe, it, expect, afterEach, mock } from 'bun:test';
import {
  moderateText,
  registerModerationBackend,
  __setModerationBackendForTests,
  type ModerationBackend,
  type BackendVerdict,
} from '../moderation-service';

function fakeBackend(name: string, impl: (text: string) => Promise<BackendVerdict>): ModerationBackend {
  return { name, moderate: impl };
}

afterEach(() => {
  __setModerationBackendForTests(null);
  delete process.env.MODERATION_ENABLED;
  delete process.env.MODERATION_BACKEND;
});

describe('moderateText — verdict handling', () => {
  it('BLOCKS on a flagged verdict and surfaces categories', async () => {
    __setModerationBackendForTests(
      fakeBackend('fake', async () => ({ flagged: true, categories: ['hate', 'violence'] })),
    );
    const r = await moderateText('bad text', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe('block');
    expect(r.flaggedCategories).toEqual(['hate', 'violence']);
    expect(r.backend).toBe('fake');
  });

  it('ALLOWS on a clean verdict', async () => {
    __setModerationBackendForTests(
      fakeBackend('fake', async () => ({ flagged: false, categories: [] })),
    );
    const r = await moderateText('hello there', { surface: 'test', direction: 'output' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('allow');
    expect(r.flaggedCategories).toEqual([]);
  });
});

describe('moderateText — fail-open', () => {
  it('FAILS OPEN when the backend throws (availability > coverage)', async () => {
    __setModerationBackendForTests(
      fakeBackend('boom', async () => {
        throw new Error('upstream 500');
      }),
    );
    const r = await moderateText('anything', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('error');
  });

  it('FAILS OPEN when MODERATION_BACKEND names an unregistered backend', async () => {
    process.env.MODERATION_BACKEND = 'granite-does-not-exist-yet';
    const r = await moderateText('anything', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('error');
  });
});

describe('moderateText — kill switch + short-circuits', () => {
  it('ALLOWS without calling the backend when MODERATION_ENABLED=false', async () => {
    process.env.MODERATION_ENABLED = 'false';
    let called = false;
    __setModerationBackendForTests(
      fakeBackend('never', async () => {
        called = true;
        return { flagged: true, categories: ['hate'] };
      }),
    );
    const r = await moderateText('would be blocked if enabled', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('disabled');
    expect(called).toBe(false);
  });

  it('ALLOWS empty/whitespace text without a backend round-trip', async () => {
    let called = false;
    __setModerationBackendForTests(
      fakeBackend('never', async () => {
        called = true;
        return { flagged: false, categories: [] };
      }),
    );
    const r = await moderateText('   ', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(called).toBe(false);
  });
});

describe('OpenAI backend — real transport shape (global fetch mocked)', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
  });

  it('maps a flagged OpenAI moderations response to a block', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MODERATION_BACKEND = 'openai';
    // Re-register to ensure the default OpenAI backend is selected (no override).
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ results: [{ flagged: true, categories: { harassment: true, hate: false } }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const r = await moderateText('slur', { surface: 'test', direction: 'input' });
    expect(r.backend).toBe('openai');
    expect(r.allowed).toBe(false);
    expect(r.flaggedCategories).toEqual(['harassment']);
  });

  it('FAILS OPEN on a non-2xx OpenAI response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MODERATION_BACKEND = 'openai';
    globalThis.fetch = mock(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    const r = await moderateText('anything', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('error');
  });

  it('FAILS OPEN (never blocks) when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.MODERATION_BACKEND = 'openai';
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await moderateText('anything', { surface: 'test', direction: 'input' });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe('error');
    expect(fetched).toBe(false);
  });

  // Keep the registry populated for any later import order.
  registerModerationBackend({ name: '__noop__', moderate: async () => ({ flagged: false, categories: [] }) });
});
