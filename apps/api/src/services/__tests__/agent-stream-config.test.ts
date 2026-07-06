/**
 * Unit tests for the agent event-stream curation + replay-cursor primitives
 * (P3 slice 1, D7). These are the PURE core of the replay endpoint: whitelist
 * membership, query-param validation, the SAFE-column projection, cursor
 * computation, and Last-Event-ID parsing. The DB round-trip itself is exercised
 * by the live staging e2e gate (per the P3 plan §4 slice-1 row).
 */
import { describe, it, expect } from 'bun:test';
import {
  AGENT_STREAM_EVENT_TYPES,
  isReplayableEventType,
  parseReplayQuery,
  projectDurableEvent,
  computeNextCursor,
  parseCursorValue,
  REPLAY_LIMIT_DEFAULT,
  REPLAY_LIMIT_MAX,
  type DurableEventRow,
  type ReplayEvent,
} from '../agent-stream-config';

describe('AGENT_STREAM_EVENT_TYPES whitelist', () => {
  it('includes the four cove settle types + the agent-scoped knowledge event', () => {
    expect(isReplayableEventType('cove.blackjack.hand.settled')).toBe(true);
    expect(isReplayableEventType('cove.baccarat.coup.settled')).toBe(true);
    expect(isReplayableEventType('cove.holdem.hand.settled')).toBe(true);
    expect(isReplayableEventType('cove.slots.spin.executed')).toBe(true);
    expect(isReplayableEventType('agent.knowledge_added')).toBe(true);
  });

  it('includes agent-scoped world/teaching types + the reserved directive type', () => {
    expect(isReplayableEventType('building.visited')).toBe(true);
    expect(isReplayableEventType('agent.chat.turn')).toBe(true);
    expect(isReplayableEventType('agent.directive.set')).toBe(true); // slice 2 reserved
  });

  it('EXCLUDES ephemeral + non-agent-scoped types', () => {
    expect(isReplayableEventType('perception')).toBe(false);
    expect(isReplayableEventType('ping')).toBe(false);
    // human-scoped analytics row (no agent_id) — NOT replayable by agent_id:
    expect(isReplayableEventType('book.read')).toBe(false);
    expect(isReplayableEventType('agent.connected')).toBe(false);
    expect(isReplayableEventType('agent.session.disconnected')).toBe(false);
    expect(isReplayableEventType('')).toBe(false);
  });

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_STREAM_EVENT_TYPES).size).toBe(AGENT_STREAM_EVENT_TYPES.length);
  });
});

describe('parseReplayQuery — validation + clamping', () => {
  it('applies defaults when both params omitted', () => {
    expect(parseReplayQuery({})).toEqual({ afterId: 0n, limit: REPLAY_LIMIT_DEFAULT });
  });

  it('parses a valid after + limit', () => {
    expect(parseReplayQuery({ after: '42', limit: '10' })).toEqual({ afterId: 42n, limit: 10 });
  });

  it('accepts a large but in-range limit at the max', () => {
    expect(parseReplayQuery({ limit: String(REPLAY_LIMIT_MAX) })).toEqual({
      afterId: 0n,
      limit: REPLAY_LIMIT_MAX,
    });
  });

  it('preserves bigint precision beyond 2^53', () => {
    const big = '9007199254740993'; // 2^53 + 1
    expect(parseReplayQuery({ after: big })?.afterId).toBe(BigInt(big));
  });

  it('rejects out-of-range / malformed input with null (→ handler 400)', () => {
    expect(parseReplayQuery({ limit: '9999' })).toBeNull(); // over max
    expect(parseReplayQuery({ limit: '0' })).toBeNull(); // under min
    expect(parseReplayQuery({ limit: '-5' })).toBeNull();
    expect(parseReplayQuery({ limit: '1.5' })).toBeNull(); // non-int
    expect(parseReplayQuery({ after: '-1' })).toBeNull();
    expect(parseReplayQuery({ after: 'abc' })).toBeNull();
    expect(parseReplayQuery({ after: '4e2' })).toBeNull(); // not a plain integer
  });
});

describe('projectDurableEvent — SAFE columns only', () => {
  it('projects exactly id/eventType/ts/payload and drops every other column', () => {
    // A hostile row carrying columns that must NEVER cross the wire.
    const row = {
      id: 123n,
      eventType: 'cove.blackjack.hand.settled',
      ts: new Date('2026-07-04T00:00:00.000Z'),
      payload: { bet: '10', net: '5' },
      fpHash: 'FP_SECRET',
      ipPrefixHash: 'IP_SECRET',
      sessionId: 'ag-SECRETSECRETSECRETSECRETSECRET1',
      agentId: 'oc-mybot',
      userId: 'u-1',
    } as unknown as DurableEventRow;

    const p = projectDurableEvent(row);
    expect(p).toEqual({
      id: '123',
      eventType: 'cove.blackjack.hand.settled',
      ts: '2026-07-04T00:00:00.000Z',
      payload: { bet: '10', net: '5' },
    });
    expect(Object.keys(p).sort()).toEqual(['eventType', 'id', 'payload', 'ts']);
    // Belt-and-suspenders: no secret column leaks into the serialized frame.
    const json = JSON.stringify(p);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('fpHash');
    expect(json).not.toContain('ipPrefixHash');
    expect(json).not.toContain('sessionId');
  });

  it('bigint id -> string; null payload preserved', () => {
    const row: DurableEventRow = {
      id: 9007199254740993n,
      eventType: 'building.visited',
      ts: new Date('2026-01-01T12:00:00.000Z'),
      payload: null,
    };
    const p = projectDurableEvent(row);
    expect(p.id).toBe('9007199254740993');
    expect(p.payload).toBeNull();
  });
});

describe('computeNextCursor', () => {
  it('returns null for an empty page (caught up)', () => {
    expect(computeNextCursor([])).toBeNull();
  });

  it('returns the last (highest, ascending) id of the page', () => {
    const evs: ReplayEvent[] = [
      { id: '1', eventType: 'x', ts: 't', payload: null },
      { id: '9', eventType: 'x', ts: 't', payload: null },
    ];
    expect(computeNextCursor(evs)).toBe('9');
  });
});

describe('parseCursorValue — Last-Event-ID / ?after', () => {
  it('parses a numeric string to bigint', () => {
    expect(parseCursorValue('50')).toBe(50n);
    expect(parseCursorValue(' 50 ')).toBe(50n); // trims
  });

  it('returns null for absent / non-numeric / negative (→ no replay, go live)', () => {
    expect(parseCursorValue(undefined)).toBeNull();
    expect(parseCursorValue(null)).toBeNull();
    expect(parseCursorValue('')).toBeNull();
    expect(parseCursorValue('abc')).toBeNull();
    expect(parseCursorValue('-3')).toBeNull();
    expect(parseCursorValue('1.5')).toBeNull();
  });
});
