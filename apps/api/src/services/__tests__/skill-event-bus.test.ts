/**
 * Unit tests for the generalized agent event bus (P3 slice 1, D7).
 *
 * Covers the two coexisting surfaces on ONE per-session queue: the wire-identical
 * knowledge surface (`publishKnowledgeAdded` / `drainKnowledgeEvents`) and the new
 * stream surface (`publishAgentStreamEvent` / `drainAgentStreamEvents`), plus the
 * type-scoped drains, disconnect clear, and the per-session cap.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  publishKnowledgeAdded,
  publishAgentStreamEvent,
  drainKnowledgeEvents,
  drainAgentStreamEvents,
  clearSessionQueue,
  totalQueueDepth,
  type KnowledgeAddedEvent,
  type AgentStreamEvent,
} from '../skill-event-bus';

const S1 = 'sess-bus-test-1';
const S2 = 'sess-bus-test-2';

function knowledge(building: string): KnowledgeAddedEvent {
  return {
    type: 'knowledge_added',
    source: 'book',
    buildingId: building,
    skillName: `clawville-${building}`,
    suggestedFilename: `clawville-${building}.md`,
    sourceName: 'Test Book',
    skillUrl: `/api/agent/S/skills/${building}/skill.md`,
    toolsUrl: `/api/agent/S/skills/${building}/tools.json`,
    toolsFilename: `clawville-${building}.tools.json`,
    knowledgeEntries: ['entry-1'],
    emittedAt: new Date().toISOString(),
  };
}

function settlement(eventId: string): AgentStreamEvent {
  return {
    type: 'stream',
    channel: 'settlement',
    eventId,
    data: { game: 'blackjack', handId: `h-${eventId}`, net: '5' },
    emittedAt: new Date().toISOString(),
  };
}

describe('skill-event-bus — type-scoped drains on one queue', () => {
  beforeEach(() => {
    clearSessionQueue(S1);
    clearSessionQueue(S2);
  });

  it('drainKnowledgeEvents returns only knowledge and LEAVES stream events queued', () => {
    publishKnowledgeAdded(S1, knowledge('cron-automation'));
    publishAgentStreamEvent(S1, settlement('100'));
    publishKnowledgeAdded(S1, knowledge('app-publishing'));

    const k = drainKnowledgeEvents(S1);
    expect(k.length).toBe(2);
    expect(k.every((e) => e.type === 'knowledge_added')).toBe(true);

    // Stream event survives the knowledge drain.
    const s = drainAgentStreamEvents(S1);
    expect(s.length).toBe(1);
    expect(s[0]!.eventId).toBe('100');
  });

  it('drainAgentStreamEvents returns only stream events and LEAVES knowledge queued', () => {
    publishAgentStreamEvent(S1, settlement('7'));
    publishKnowledgeAdded(S1, knowledge('rag-systems'));
    publishAgentStreamEvent(S1, settlement('8'));

    const s = drainAgentStreamEvents(S1);
    expect(s.map((e) => e.eventId)).toEqual(['7', '8']);

    const k = drainKnowledgeEvents(S1);
    expect(k.length).toBe(1);
    expect(k[0]!.buildingId).toBe('rag-systems');
  });

  it('second drain of the same type returns empty (drain removes what it matched)', () => {
    publishKnowledgeAdded(S1, knowledge('x'));
    expect(drainKnowledgeEvents(S1).length).toBe(1);
    expect(drainKnowledgeEvents(S1)).toEqual([]);

    publishAgentStreamEvent(S1, settlement('1'));
    expect(drainAgentStreamEvents(S1).length).toBe(1);
    expect(drainAgentStreamEvents(S1)).toEqual([]);
  });

  it('queues are isolated per session', () => {
    publishAgentStreamEvent(S1, settlement('11'));
    publishAgentStreamEvent(S2, settlement('22'));
    expect(drainAgentStreamEvents(S1).map((e) => e.eventId)).toEqual(['11']);
    expect(drainAgentStreamEvents(S2).map((e) => e.eventId)).toEqual(['22']);
  });

  it('clearSessionQueue drops BOTH types', () => {
    publishKnowledgeAdded(S1, knowledge('x'));
    publishAgentStreamEvent(S1, settlement('1'));
    clearSessionQueue(S1);
    expect(drainKnowledgeEvents(S1)).toEqual([]);
    expect(drainAgentStreamEvents(S1)).toEqual([]);
  });

  it('empty drains never throw', () => {
    expect(drainKnowledgeEvents('never-seen')).toEqual([]);
    expect(drainAgentStreamEvents('never-seen')).toEqual([]);
  });
});

describe('skill-event-bus — per-session cap bounds RAM (durable tier is authoritative)', () => {
  beforeEach(() => clearSessionQueue(S1));

  it('drops OLDEST past the 512 cap; newest survive', () => {
    // Push 600 stream events; the cap keeps the newest 512.
    for (let i = 1; i <= 600; i++) publishAgentStreamEvent(S1, settlement(String(i)));
    const s = drainAgentStreamEvents(S1);
    expect(s.length).toBe(512);
    // Oldest (1..88) dropped; the last one is always retained.
    expect(s[0]!.eventId).toBe('89');
    expect(s[s.length - 1]!.eventId).toBe('600');
  });

  it('totalQueueDepth reflects queued events and returns to 0 after drains', () => {
    clearSessionQueue(S2);
    const before = totalQueueDepth();
    publishKnowledgeAdded(S1, knowledge('x'));
    publishAgentStreamEvent(S1, settlement('1'));
    expect(totalQueueDepth()).toBe(before + 2);
    drainKnowledgeEvents(S1);
    drainAgentStreamEvents(S1);
    expect(totalQueueDepth()).toBe(before);
  });
});
