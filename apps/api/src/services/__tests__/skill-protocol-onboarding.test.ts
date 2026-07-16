import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  agentProtocolPointer,
  buildPlayManual,
  buildProtocolManual,
  contentHashOf,
  protocolPointer,
} from '../skill-protocol';

const API_BASE = 'https://api.example.test';

describe('open-agent onboarding manuals', () => {
  test('public entry manual matches the live connect and play surfaces', () => {
    const manual = buildPlayManual(API_BASE);
    const protocolManual = buildProtocolManual(API_BASE);

    expect(PROTOCOL_VERSION).toBe(20);
    expect(manual).toContain(`POST ${API_BASE}/api/agent/connect`);
    expect(manual).toContain('"agentId": "your-stable-agent-id"');
    expect(manual).toContain('"identityType": "nanoclaw"');
    expect(manual).toContain('"identityKey": "a-long-random-secret-you-store"');
    expect(manual).toContain('Treat identityKey as a secret credential');
    expect(manual).toContain('secretIncluded:false');
    expect(manual).toContain('clawville:identity:<userId>');
    expect(manual).toContain('X-Clawville-Agent-Session');
    expect(manual).toContain('not** an Authorization');
    expect(manual).toContain('/api/agent/:sessionId/events');
    expect(manual).toContain('/api/agent/:sessionId/visit-building');
    expect(manual).toContain('{ "buildingId": "cron-automation" }');
    expect(manual).toContain('/api/items/buy');
    expect(manual).toContain('{ "itemId": "cron-automation-basics" }');
    expect(manual).toContain('/api/items/learn');
    expect(manual).toContain('{ "bookId": "cron-automation-basics" }');
    expect(manual).toContain('/api/agent/:sessionId/pending-installs');
    expect(manual).toContain('/api/agent/:sessionId/owned-skills');
    expect(manual).toContain('/api/skills/:buildingId/claim');
    expect(protocolManual).toContain('/api/skills/:buildingId/claim');
    expect(protocolManual).toContain('"runtime" | "marker" | "already"');
    expect(protocolManual).toContain('partner read key alone cannot claim');
    expect(manual).toContain('knowledge_added');
    expect(manual).not.toMatch(/\b(?:CT|ClawTokens?|casino|pet)\b/i);
  });

  test('connect pointers hash the exact served protocol bytes', () => {
    expect(protocolPointer(API_BASE)).toEqual({
      version: PROTOCOL_VERSION,
      contentHash: contentHashOf(buildProtocolManual(API_BASE)),
      url: '/api/skills/protocol/skill.md',
    });
    expect(agentProtocolPointer(API_BASE)).toEqual({
      version: PROTOCOL_VERSION,
      contentHash: contentHashOf(buildProtocolManual(API_BASE)),
      url: '/api/skills/protocol/skill.md',
      manifestUrl: '/api/skills/manifest.json',
      auth: 'X-Clawville-Agent-Session: <sessionId>',
    });
  });
});
