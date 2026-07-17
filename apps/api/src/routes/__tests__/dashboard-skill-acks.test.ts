import { describe, expect, it } from 'bun:test';
import {
  buildAgentSkillAckDashboard,
  type AgentSkillAckDashboardRow,
} from '../dashboard';
import {
  PROTOCOL_VERSION,
  protocolContentHash,
} from '../../services/skill-protocol';

const API_BASE = 'https://api.example.test';
const NOW = new Date('2026-07-17T12:00:00.000Z');

function bot(
  agentId: string,
  overrides: Partial<AgentSkillAckDashboardRow> = {},
): AgentSkillAckDashboardRow {
  return {
    agentId,
    name: agentId,
    identityType: 'custom',
    protocol: 'nanoclaw',
    gatewayUrl: null,
    cognitionBackend: null,
    isHouse: false,
    hasHostedAvatarBinding: false,
    ack: {},
    lastSeenAt: new Date('2026-07-17T12:00:00.000Z'),
    sessionExpiresAt: new Date('2026-07-18T12:00:00.000Z'),
    ...overrides,
  };
}

describe('dashboard agent skill ACK posture', () => {
  it('counts BYO posture from the canonical hash and excludes hosted cohorts', () => {
    const currentHash = protocolContentHash(API_BASE);
    const posture = buildAgentSkillAckDashboard([
      bot('current', {
        ack: {
          manual: {
            version: PROTOCOL_VERSION,
            contentHash: currentHash,
            at: '2026-07-17T12:00:00.000Z',
          },
        },
      }),
      bot('stale', {
        ack: {
          manual: {
            version: PROTOCOL_VERSION - 1,
            contentHash: currentHash,
            at: '2026-07-16T12:00:00.000Z',
          },
        },
      }),
      bot('none'),
      bot('hatcher', { identityType: 'hatcher', cognitionBackend: 'hatcher-proxy' }),
      bot('milady-hosted', { identityType: 'milady' }),
      bot('house-hosted', { isHouse: true }),
      bot('hosted-avatar-session', {
        identityType: 'nanoclaw',
        protocol: 'nanoclaw',
        isHouse: false,
        hasHostedAvatarBinding: true,
      }),
      bot('anonymous', { identityType: 'anonymous' }),
      bot('expired', { sessionExpiresAt: new Date('2026-07-17T11:59:59.000Z') }),
      bot('legacy-null-ttl', { sessionExpiresAt: null }),
    ], API_BASE, NOW);

    expect(posture.counts).toEqual({ none: 1, current: 1, stale: 1 });
    expect(posture.agents.stale).toEqual([{
      agentId: 'stale',
      name: 'stale',
      lastAckedVersion: PROTOCOL_VERSION - 1,
      lastSeenAt: '2026-07-17T12:00:00.000Z',
    }]);
    expect(posture.agents.none).toEqual([{
      agentId: 'none',
      name: 'none',
      lastAckedVersion: null,
      lastSeenAt: '2026-07-17T12:00:00.000Z',
    }]);
  });

  it('returns at most 20 stale/none agents, newest first across both groups', () => {
    const rows = Array.from({ length: 25 }, (_, index) => bot(`agent-${index}`, {
      lastSeenAt: new Date(Date.UTC(2026, 6, 17, 0, index)),
    }));

    const posture = buildAgentSkillAckDashboard(rows, API_BASE, NOW);
    const attention = [...posture.agents.stale, ...posture.agents.none];

    expect(posture.counts).toEqual({ none: 25, current: 0, stale: 0 });
    expect(attention).toHaveLength(20);
    expect(posture.agents.none[0]?.agentId).toBe('agent-24');
    expect(posture.agents.none.at(-1)?.agentId).toBe('agent-5');
  });
});
