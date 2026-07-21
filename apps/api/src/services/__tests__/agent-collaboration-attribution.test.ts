import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { EventInput } from '../event-logger';

const emitted: EventInput[] = [];

const broker = {
  collaborate: mock(async () => ({
    consulted: ['api-integrations', 'memory-rag'],
    insights: [
      {
        buildingId: 'api-integrations',
        buildingName: 'API Integrations',
        response: 'Use a bounded API route.',
      },
      {
        buildingId: 'memory-rag',
        buildingName: 'Memory & RAG',
        response: '',
      },
    ],
  })),
};

mock.module('@clawville/agent-runtime', () => ({
  getCollaborationBroker: () => broker,
}));

mock.module('../event-logger', () => ({
  logEvent: async (event: EventInput) => {
    emitted.push(event);
  },
}));

const { collaborateOnQuery } = await import('../agent-collaboration');

beforeEach(() => {
  emitted.length = 0;
  broker.collaborate.mockClear();
});

async function collaborate(
  initiator?:
    | { kind: 'agent'; agentId: string }
    | { kind: 'human'; userId: string; avatarId: string },
): Promise<void> {
  await collaborateOnQuery({
    message: 'How should an API use memory and RAG?',
    sourceBuildingId: 'cron-automation',
    maxExperts: 2,
    ...(initiator ? { initiator } : {}),
  });
  // The production emitter is intentionally fire-soft (`void logEvent`). Let
  // the mocked promises drain before asserting the captured calls.
  await Promise.resolve();
}

function expectScoringKeyXor(event: EventInput): void {
  expect(Boolean(event.agentId) !== Boolean(event.avatarId)).toBe(true);
}

describe('agent collaboration event attribution', () => {
  it('attributes every returned insight to an agent initiator using agent_id only', async () => {
    await collaborate({ kind: 'agent', agentId: 'agent-alice' });

    expect(emitted).toHaveLength(2);
    for (const event of emitted) {
      expect(event.eventType).toBe('agent.collaboration.turn');
      expect(event.agentId).toBe('agent-alice');
      expect(event.avatarId).toBeNull();
      expect(event.userId).toBeNull();
      expect(event.payload?.unattributed).toBeUndefined();
      expectScoringKeyXor(event);
    }
  });

  it('attributes every returned insight to a human initiator using avatar_id and user_id', async () => {
    await collaborate({ kind: 'human', userId: 'user-bob', avatarId: 'avatar-bob' });

    expect(emitted).toHaveLength(2);
    for (const event of emitted) {
      expect(event.agentId).toBeNull();
      expect(event.avatarId).toBe('avatar-bob');
      expect(event.userId).toBe('user-bob');
      expect(event.payload?.unattributed).toBeUndefined();
      expectScoringKeyXor(event);
    }
  });

  it('keeps an unauthenticated consultation subjectless and marks it unattributed', async () => {
    await collaborate();

    expect(emitted).toHaveLength(2);
    for (const event of emitted) {
      expect(event.agentId).toBeNull();
      expect(event.avatarId).toBeNull();
      expect(event.userId).toBeNull();
      expect(event.payload?.unattributed).toBe(true);
    }
  });

  it('emits exactly one event per returned insight even when a response is empty', async () => {
    await collaborate({ kind: 'agent', agentId: 'agent-carol' });

    expect(emitted.map((event) => event.payload?.targetBuildingId)).toEqual([
      'api-integrations',
      'memory-rag',
    ]);
    expect(emitted.map((event) => event.payload?.answered)).toEqual([true, false]);
  });
});
