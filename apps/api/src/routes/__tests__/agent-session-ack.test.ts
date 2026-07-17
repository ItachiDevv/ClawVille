import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ActivityIdentity } from '../../middleware/require-auth-or-agent';
import {
  agentSessionAckRoutes,
  AgentSkillAckRevalidationError,
  executeAgentSkillAck,
  mergeAgentBotAck,
  resetAgentSkillAckRateLimit,
  type AgentSkillAckMutation,
} from '../agent-session-ack';
import {
  PROTOCOL_VERSION,
  protocolContentHash,
} from '../../services/skill-protocol';

const API_BASE = 'https://api.example.test';
const MANUAL_HASH = protocolContentHash(API_BASE);
const SKILL_HEX = 'a'.repeat(64);

const AGENT: ActivityIdentity = {
  kind: 'agent',
  userId: 'user-1',
  avatarId: 'avatar-1',
  agentId: 'agent-1',
  sessionId: 'session-redacted',
  ledgerCapable: false,
};

const USER: ActivityIdentity = {
  kind: 'user',
  userId: 'user-1',
  avatarId: 'avatar-1',
  agentId: null,
};

afterEach(() => {
  resetAgentSkillAckRateLimit();
});

describe('POST /api/agent/session/ack', () => {
  it('returns 401 when no Lucia or agent session is present', async () => {
    const response = await agentSessionAckRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'protocol-manual',
        contentHash: MANUAL_HASH,
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('X-Clawville-Agent-Session');
  });

  it('rejects a resolved Lucia human with 403', async () => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      USER,
      { kind: 'protocol-manual', contentHash: MANUAL_HASH },
      { apiBase: API_BASE, persist },
    );

    expect(result).toEqual({
      status: 403,
      body: { error: 'agent_session_required' },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('accepts the exact current manual hash and optional matching version', async () => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'protocol-manual',
        version: PROTOCOL_VERSION,
        contentHash: MANUAL_HASH,
      },
      { apiBase: API_BASE, persist, now: () => new Date('2026-07-17T12:00:00.000Z') },
    );

    expect(result).toEqual({
      status: 200,
      body: {
        current: true,
        latest: { version: PROTOCOL_VERSION, contentHash: MANUAL_HASH },
      },
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('rejects stale manual version/hash without storing', async () => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'protocol-manual',
        version: PROTOCOL_VERSION - 1,
        contentHash: 'b'.repeat(64),
      },
      { apiBase: API_BASE, persist },
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'stale_or_unknown_hash',
      latest: { version: PROTOCOL_VERSION, contentHash: MANUAL_HASH },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    [`sha256:${SKILL_HEX}`, SKILL_HEX],
    [SKILL_HEX, `sha256:${SKILL_HEX}`],
  ])('normalizes skill wire/DB hash formats (%s vs %s)', async (inputHash, dbHash) => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'building-skill',
        buildingId: 'memory-rag',
        contentHash: inputHash,
      },
      {
        loadBuildingSkill: async () => ({
          generatorVersion: 7,
          contentHash: dbHash,
        }),
        persist,
      },
    );

    expect(result).toEqual({
      status: 200,
      body: {
        current: true,
        latest: { version: 7, contentHash: `sha256:${SKILL_HEX}` },
      },
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'not-a-hash'])('treats a %s DB content_hash as unknown and stores nothing', async (dbHash) => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'building-skill',
        buildingId: 'memory-rag',
        contentHash: `sha256:${SKILL_HEX}`,
      },
      {
        loadBuildingSkill: async () => ({
          generatorVersion: 7,
          contentHash: dbHash,
        }),
        persist,
      },
    );

    expect(result).toEqual({
      status: 400,
      body: { error: 'stale_or_unknown_hash', latest: null },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns canonical latest for an unknown skill hash and stores nothing', async () => {
    const persist = mock(async () => {});
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'building-skill',
        buildingId: 'memory-rag',
        contentHash: `sha256:${'c'.repeat(64)}`,
      },
      {
        loadBuildingSkill: async () => ({
          generatorVersion: 7,
          contentHash: SKILL_HEX,
        }),
        persist,
      },
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: 'stale_or_unknown_hash',
        latest: { version: 7, contentHash: `sha256:${SKILL_HEX}` },
      },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns the transaction-observed latest when a concurrent regeneration wins', async () => {
    const changedHash = `sha256:${'d'.repeat(64)}`;
    const result = await executeAgentSkillAck(
      AGENT,
      {
        kind: 'building-skill',
        buildingId: 'memory-rag',
        contentHash: `sha256:${SKILL_HEX}`,
      },
      {
        loadBuildingSkill: async () => ({
          generatorVersion: 7,
          contentHash: SKILL_HEX,
        }),
        persist: async () => {
          throw new AgentSkillAckRevalidationError({
            version: 8,
            contentHash: changedHash,
          });
        },
      },
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: 'stale_or_unknown_hash',
        latest: { version: 8, contentHash: changedHash },
      },
    });
  });

  it('limits a stable agent subject to 30 acknowledgements per minute', async () => {
    const persist = mock(async () => {});
    for (let i = 0; i < 30; i += 1) {
      const result = await executeAgentSkillAck(
        AGENT,
        { kind: 'protocol-manual', contentHash: MANUAL_HASH },
        { apiBase: API_BASE, persist },
      );
      expect(result.status).toBe(200);
    }

    const limited = await executeAgentSkillAck(
      AGENT,
      { kind: 'protocol-manual', contentHash: MANUAL_HASH },
      { apiBase: API_BASE, persist },
    );
    expect(limited).toEqual({ status: 429, body: { error: 'rate_limited' } });
    expect(persist).toHaveBeenCalledTimes(30);
  });
});

describe('mergeAgentBotAck', () => {
  it('preserves manual and sibling skills across repeat ACKs while dropping unknown ids', () => {
    const skillMutation: AgentSkillAckMutation = {
      kind: 'building-skill',
      buildingId: 'memory-rag',
      latest: { version: 8, contentHash: `sha256:${SKILL_HEX}` },
      at: '2026-07-17T13:00:00.000Z',
    };
    const merged = mergeAgentBotAck({
      manual: {
        version: 21,
        contentHash: `sha256:${'d'.repeat(64)}`,
        at: '2026-07-17T11:00:00.000Z',
      },
      skills: {
        'agent-security': {
          contentHash: `sha256:${'e'.repeat(64)}`,
          at: '2026-07-17T12:00:00.000Z',
        },
        'unknown-building': {
          contentHash: `sha256:${'f'.repeat(64)}`,
          at: '2026-07-17T12:00:00.000Z',
        },
      },
    }, skillMutation);

    expect(merged.manual?.version).toBe(21);
    expect(merged.skills?.['agent-security']).toBeDefined();
    expect(merged.skills?.['memory-rag']).toEqual({
      contentHash: `sha256:${SKILL_HEX}`,
      at: '2026-07-17T13:00:00.000Z',
    });
    expect(merged.skills).not.toHaveProperty('unknown-building');
    expect(Object.keys(merged.skills ?? {}).length).toBeLessThanOrEqual(10);
  });
});
