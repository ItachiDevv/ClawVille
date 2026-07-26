import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import type { WireRecord } from '../types';

interface HookWindow {
  location: { href: string };
  fetch: typeof fetch;
  __CV_WIRE_GET?: (suffix: string, seq?: number) => WireRecord | null;
  __CV_WIRE_SINCE?: (suffix: string, after: number) => WireRecord[];
  __CV_WIRE_ALL?: () => WireRecord[];
  __CV_TEST_FIXTURE_HEADER?: string;
  __CV_RELEASE_FIXTURE_GATE?: (header?: string) => void;
}

describe('pre-navigation fetch capture hook', () => {
  test('separates bodies, canonicalizes queryless suffix, bounds, and redacts secrets', async () => {
    const source = await readFile('scripts/parity/capture-hook.js', 'utf8');
    let calls = 0;
    const fakeWindow: HookWindow = {
      location: { href: 'http://127.0.0.1:3003/cove/baccarat' },
      fetch: async () => {
        calls += 1;
        return Response.json({
          coupId: `coup-${calls}`,
          token: 'must-not-be-captured',
        });
      },
      __CV_TEST_FIXTURE_HEADER: 'run.secret-token',
    };
    new Function('window', source)(fakeWindow);
    fakeWindow.__CV_RELEASE_FIXTURE_GATE?.('run.secret-token');
    for (let index = 0; index < 260; index += 1) {
      await fakeWindow.fetch(
        `http://127.0.0.1:4002/api/cove/baccarat/coup?attempt=${index}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stake: index,
            bet: 'player',
            joinCode: 'must-not-be-captured',
          }),
        },
      );
    }
    const records = fakeWindow.__CV_WIRE_SINCE?.('baccarat/coup', 0) ?? [];
    expect(records).toHaveLength(256);
    expect(records[0]!.seq).toBe(5);
    expect(records[0]!.capturedAt).toBeNumber();
    expect(records.at(-1)?.requestBody).toEqual({
      stake: 259,
      bet: 'player',
      joinCode: '[REDACTED]',
    });
    expect(records.at(-1)?.responseBody).toEqual({
      coupId: 'coup-260',
      token: '[REDACTED]',
    });
    expect(fakeWindow.__CV_WIRE_GET?.('baccarat/coup')?.seq).toBe(260);
  });

  test('injects fixture header only on exact mutating fixture arms', async () => {
    const source = await readFile('scripts/parity/capture-hook.js', 'utf8');
    const seen = new Map<string, string | null>();
    const fakeWindow: HookWindow = {
      location: { href: 'http://127.0.0.1:3003/cove' },
      fetch: async (input, init) => {
        seen.set(String(input), new Headers(init?.headers).get('X-CV-Test-Fixture'));
        return Response.json({ ok: true });
      },
      __CV_TEST_FIXTURE_HEADER: 'run.secret-token',
    };
    new Function('window', source)(fakeWindow);
    fakeWindow.__CV_RELEASE_FIXTURE_GATE?.('run.secret-token');
    const armed = [
      '/api/cove/blackjack/session/open',
      '/api/cove/blackjack/hand/deal',
      '/api/cove/blackjack/action',
      '/api/cove/baccarat/session/open',
      '/api/cove/baccarat/coup',
      '/api/cove/holdem/hand/deal',
      '/api/cove/poker/cash/tables/t1/action',
    ];
    for (const path of armed) {
      await fakeWindow.fetch(`http://127.0.0.1:4002${path}`, { method: 'POST' });
    }
    await fakeWindow.fetch(
      'http://127.0.0.1:4002/api/cove/baccarat/session/current',
      { method: 'GET' },
    );
    for (const path of armed) {
      expect(seen.get(`http://127.0.0.1:4002${path}`)).toBe('run.secret-token');
    }
    expect(seen.get(
      'http://127.0.0.1:4002/api/cove/baccarat/session/current',
    )).toBeNull();
  });

  test('new-document seed arm waits for in-memory header without persistence', async () => {
    const source = await readFile('scripts/parity/capture-hook.js', 'utf8');
    const seen: string[] = [];
    const pageAfterNavigation: HookWindow = {
      location: { href: 'http://127.0.0.1:3003/cove/blackjack' },
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('X-CV-Test-Fixture') ?? '');
        return Response.json({ handId: 'fixture-first-arm' });
      },
    };
    new Function('window', source)(pageAfterNavigation);
    let settled = false;
    const firstArm = pageAfterNavigation.fetch(
      'http://127.0.0.1:4002/api/cove/blackjack/session/open',
      { method: 'POST' },
    ).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    pageAfterNavigation.__CV_SET_FIXTURE_HEADER?.('stale-run.stale-token');
    await Promise.resolve();
    expect(settled).toBe(false);
    pageAfterNavigation.__CV_SET_FIXTURE_HEADER?.('run-id.raw-token');
    pageAfterNavigation.__CV_RELEASE_FIXTURE_GATE?.();
    await firstArm;
    expect(seen).toEqual(['run-id.raw-token']);
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(JSON.stringify(
      pageAfterNavigation.__CV_WIRE_ALL?.() ?? [],
    )).not.toContain('raw-token');
  });
});
