/**
 * Pins the join invariant the P3 slice-1 replay depends on (adversary A3):
 * `events.agent_id` must equal `getAgentBotConfig(sessionId).agentId` for the
 * agent-scoped replay query to return an agent's own settle/visit/chat rows.
 *
 * That holds because `event-logger.redactBearer` (the central write-side
 * chokepoint) DIGESTS a value only when it EXACTLY matches the raw-bearer shape
 * (`^(ag|oc|hat|claw)-[A-Za-z0-9_-]{32}$`) — so every canonical agentId HANDLE
 * passes through byte-identical (the leaderboard `GROUP BY agent_id` and this
 * replay join both stay intact), while a caller-injected raw bearer is redacted.
 */
import { describe, it, expect } from 'bun:test';
import { redactBearer } from '../event-logger';
import { sessionDigest } from '../session-digest';

describe('redactBearer — canonical agentId handles pass through UNCHANGED', () => {
  const canonical = [
    'hatcher:my-cool-agent', // namespaced partner handle
    'milady:miu', // namespaced milady handle
    'oc-mybot', // short openclaw handle (not 32 chars)
    'agent-1720000000000-ab12cd', // legacy timestamped handle
    '550e8400-e29b-41d4-a716-446655440000', // a plain UUID
    'a1b2c3d4e5f60718', // an already-digested 16-hex value (idempotent)
  ];

  for (const id of canonical) {
    it(`leaves ${id} untouched`, () => {
      expect(redactBearer(id)).toBe(id);
    });
  }

  it('leaves a non-string untouched', () => {
    expect(redactBearer(null)).toBeNull();
    expect(redactBearer(42)).toBe(42);
  });
});

describe('redactBearer — a RAW bearer IS digested (never lands as agent_id)', () => {
  // Exact raw-bearer shape: `<prefix>-` + 32 url-safe chars.
  const bearers = [
    'ag-' + 'A'.repeat(32),
    'oc-' + '0123456789abcdefghijABCDEFGHIJ-_',
    'hat-' + 'z'.repeat(32),
    'claw-' + 'B'.repeat(32),
  ];

  for (const bearer of bearers) {
    it(`digests ${bearer.slice(0, 6)}… to a 16-hex correlation id`, () => {
      const out = redactBearer(bearer);
      expect(out).not.toBe(bearer); // NOT passed through
      expect(out).toBe(sessionDigest(bearer)); // == the one-way digest
      expect(out as string).toMatch(/^[0-9a-f]{16}$/); // 16-hex, not a spendable bearer
    });
  }

  it('a near-miss (wrong length) is NOT digested — it is a handle, not a bearer', () => {
    const short = 'ag-' + 'A'.repeat(31); // 31 chars — one short of the bearer shape
    const long = 'ag-' + 'A'.repeat(33); // 33 chars — one over
    expect(redactBearer(short)).toBe(short);
    expect(redactBearer(long)).toBe(long);
  });
});
