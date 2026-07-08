/**
 * Cold-start pre-warm — DB-free / network-free unit suite for the trigger
 * predicate + the fire-and-forget orchestration (gate-doc §B.7, 2026-07-08).
 *
 * What is pinned here:
 *   1. Trigger predicate (`isPrewarmableProtocol`): the two server-hosted LOCAL
 *      wire protocols YES; BYO gateways / fail-soft / partner / gate-off protocols
 *      NO; fail-closed on unknown/undefined/''.
 *   2. The predicate composed with `resolveInWorldProtocol` — proving "gate off ⇒
 *      not pre-warmed" and "BYO openclaw with a gateway ⇒ not pre-warmed" fall out
 *      of the real wire derivation (no separate gate read in the prewarm module).
 *   3. Idempotency: an agentId warms AT MOST ONCE per process; a non-prewarmable
 *      protocol never warms.
 *   4. A pre-warm FAILURE never propagates into the caller and never wedges the
 *      concurrency slot.
 *   5. Concurrency bound: at most MAX_CONCURRENT_PREWARMS (2) warm-ups run at once.
 *
 * Pure — no DB, no sim, no network, no env mutation. Run:
 *   bun test hosted-gateway-prewarm
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import {
  isPrewarmableProtocol,
  maybePrewarmHostedGateway,
  __resetPrewarmStateForTests,
} from '../hosted-gateway-prewarm';
import { resolveInWorldProtocol } from '../agent-session-config';

const flush = () => new Promise((r) => setTimeout(r, 10));

/**
 * Minimal fake substrate client — only the two members maybePrewarm touches
 * (`getProtocol` + `prewarmLocalGateway`). `warm` counts invocations; `deferred`
 * (when set) lets a test HOLD a warm-up in flight to probe the concurrency bound;
 * `reject` makes the warm-up throw (to prove failures never propagate).
 */
function fakeClient(
  protocol: string,
  opts: { deferred?: boolean; reject?: boolean } = {},
): AgentSubstrateClient & { warm: number; release: () => void } {
  let resolveHeld: (() => void) | null = null;
  const stub = {
    warm: 0,
    getProtocol() {
      return protocol;
    },
    prewarmLocalGateway() {
      stub.warm += 1;
      if (opts.reject) return Promise.reject(new Error('warm boom'));
      if (opts.deferred) {
        return new Promise<void>((res) => {
          resolveHeld = res;
        });
      }
      return Promise.resolve();
    },
    release() {
      resolveHeld?.();
    },
  };
  return stub as unknown as AgentSubstrateClient & { warm: number; release: () => void };
}

beforeEach(() => {
  __resetPrewarmStateForTests();
});

describe('isPrewarmableProtocol — trigger predicate', () => {
  test('the two server-hosted LOCAL runtimes are prewarmable', () => {
    expect(isPrewarmableProtocol('hermes-local')).toBe(true);
    expect(isPrewarmableProtocol('openclaw-local')).toBe(true);
  });

  test('BYO gateways / fail-soft / partner protocols are NOT prewarmable', () => {
    for (const p of ['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw', 'hatcher-proxy']) {
      expect(isPrewarmableProtocol(p)).toBe(false);
    }
  });

  test('fail-closed on unknown / undefined / empty', () => {
    expect(isPrewarmableProtocol(undefined)).toBe(false);
    expect(isPrewarmableProtocol(null)).toBe(false);
    expect(isPrewarmableProtocol('')).toBe(false);
    expect(isPrewarmableProtocol('totally-made-up')).toBe(false);
  });
});

describe('predicate composed with resolveInWorldProtocol — gate-off & BYO fall out of the real wire', () => {
  test('hermes: gate ON ⇒ prewarmable, gate OFF ⇒ not', () => {
    expect(isPrewarmableProtocol(resolveInWorldProtocol('hermes', null, true))).toBe(true);
    expect(isPrewarmableProtocol(resolveInWorldProtocol('hermes', null, false))).toBe(false);
  });

  test('openclaw: gateway-LESS + gate ON ⇒ prewarmable; gate OFF ⇒ not', () => {
    const on = resolveInWorldProtocol('openclaw', null, false, {
      enabled: true,
      hasDeclaredGateway: false,
    });
    const off = resolveInWorldProtocol('openclaw', null, false, {
      enabled: false,
      hasDeclaredGateway: false,
    });
    expect(isPrewarmableProtocol(on)).toBe(true);
    expect(isPrewarmableProtocol(off)).toBe(false);
  });

  test('openclaw: BYO (declared gateway) is NEVER prewarmable, even with the gate ON', () => {
    const byo = resolveInWorldProtocol('openclaw', 'openai-compat', false, {
      enabled: true,
      hasDeclaredGateway: true,
    });
    expect(isPrewarmableProtocol(byo)).toBe(false);
  });

  test('non-hosted identities never resolve to a prewarmable protocol', () => {
    for (const id of ['anonymous', 'milady', 'nanoclaw', 'ironclaw', 'custom', 'hatcher']) {
      expect(isPrewarmableProtocol(resolveInWorldProtocol(id, null, true))).toBe(false);
    }
  });
});

describe('maybePrewarmHostedGateway — orchestration', () => {
  test('a non-prewarmable protocol never warms', async () => {
    const c = fakeClient('openai-compat');
    maybePrewarmHostedGateway('byo-1', c);
    await flush();
    expect(c.warm).toBe(0);
  });

  test('a prewarmable agent warms exactly once, and re-connect is idempotent', async () => {
    const c = fakeClient('openclaw-local');
    maybePrewarmHostedGateway('agent-A', c);
    maybePrewarmHostedGateway('agent-A', c); // duplicate connect / reconnect race
    await flush();
    expect(c.warm).toBe(1);

    // A later reconnect for the SAME agent still does not re-warm.
    maybePrewarmHostedGateway('agent-A', c);
    await flush();
    expect(c.warm).toBe(1);
  });

  test('a pre-warm failure never propagates AND releases the slot', async () => {
    const boom = fakeClient('hermes-local', { reject: true });
    // Must not throw synchronously.
    expect(() => maybePrewarmHostedGateway('agent-boom', boom)).not.toThrow();
    await flush();
    expect(boom.warm).toBe(1);

    // The slot was released despite the rejection: a fresh agent still warms.
    const ok = fakeClient('hermes-local');
    maybePrewarmHostedGateway('agent-after-boom', ok);
    await flush();
    expect(ok.warm).toBe(1);
  });

  test('concurrency is bounded to 2 in flight; the rest drain as slots free', async () => {
    // Five distinct prewarmable agents, each holding its warm-up open.
    const clients = Array.from({ length: 5 }, () => fakeClient('openclaw-local', { deferred: true }));
    clients.forEach((c, i) => maybePrewarmHostedGateway(`burst-${i}`, c));
    await flush();

    // Only 2 may be in flight at once.
    expect(clients.filter((c) => c.warm === 1).length).toBe(2);

    // Release the two in-flight → the next two start.
    clients.forEach((c) => c.release());
    await flush();
    expect(clients.filter((c) => c.warm === 1).length).toBe(4);

    clients.forEach((c) => c.release());
    await flush();
    expect(clients.filter((c) => c.warm === 1).length).toBe(5);
  });

  test('a saturated queue drops the excess instead of growing unbounded', async () => {
    // Enqueue far more held-open prewarms than (MAX_CONCURRENT + MAX_QUEUE = 2+64).
    // The 2 in-flight + 64 queued get accepted; everything past that is dropped.
    const clients = Array.from({ length: 200 }, () => fakeClient('openclaw-local', { deferred: true }));
    clients.forEach((c, i) => maybePrewarmHostedGateway(`sat-${i}`, c));
    await flush();

    // Exactly 2 are in flight (warm===1); the rest are either queued or dropped.
    expect(clients.filter((c) => c.warm === 1).length).toBe(2);

    // Drain everything: only the accepted 2 + 64 queued ever run — the excess was
    // dropped, so the total that EVER warm is bounded well below 200.
    for (let i = 0; i < 40; i++) {
      clients.forEach((c) => c.release());
      await flush();
    }
    const everWarmed = clients.filter((c) => c.warm === 1).length;
    expect(everWarmed).toBe(2 + 64);
    expect(everWarmed).toBeLessThan(200);
  });
});
