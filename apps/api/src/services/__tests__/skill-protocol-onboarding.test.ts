import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  agentProtocolPointer,
  buildPlayManual,
  buildProtocolManual,
  contentHashOf,
  deriveProtocolAckState,
  protocolPointer,
  requiresByoSkillAck,
} from '../skill-protocol';

const API_BASE = 'https://api.example.test';

describe('open-agent onboarding manuals', () => {
  test('public entry manual matches the live connect and play surfaces', () => {
    const manual = buildPlayManual(API_BASE);
    const protocolManual = buildProtocolManual(API_BASE);

    expect(PROTOCOL_VERSION).toBe(23);
    expect(manual).toContain(`POST ${API_BASE}/api/agent/connect`);
    expect(manual).toContain('"agentId": "your-stable-agent-id"');
    expect(manual).toContain('"identityType": "custom"');
    expect(manual).toContain('"gatewayUrl": "https://your-agent.example/v1"');
    expect(manual).toContain('"protocol": "openai-compat"');
    expect(protocolManual).toContain('Public `/connect` and `/join` identity types are exactly');
    expect(protocolManual).toContain('`milady`, `hermes`');
    expect(protocolManual).toContain('`openclaw`, and `custom`');
    expect(manual).toContain('Only that enum');
    expect(manual).toContain('`/join` accepts `identityType`, `identityKey`, and `name`');
    expect(manual).toContain('permits Milady without `miladyAgentId`');
    expect(protocolManual).toContain('`/join` permits Milady bootstrap without `miladyAgentId`');
    expect(protocolManual).toContain('runtime-signal and gateway validation applies');
    const continuitySentence = 'If you previously connected under a retired identity type, reconnect under a supported type with your SAME identityKey; your account follows the key automatically.';
    expect(manual).toContain(continuitySentence);
    expect(protocolManual).toContain(continuitySentence);
    expect(protocolManual).toContain('to `/connect` only');
    expect(protocolManual).toContain('requires a reachable OpenAI-compatible');
    expect(manual).toContain('without either signal the request fails closed');
    expect(protocolManual).toContain('explicit `custom` request without a gateway also fails closed');
    expect(manual).toContain('explicit Milady identity requires `miladyAgentId`');
    expect(protocolManual).toContain('explicit Milady identity requires `miladyAgentId`');
    expect(manual).toContain('Gateway-less OpenClaw is');
    expect(manual).toContain('accepted only when `OPENCLAW_LOCAL_GATEWAY_ENABLED`');
    expect(manual).toContain('otherwise registration fails closed');
    expect(protocolManual).toContain('`OPENCLAW_LOCAL_GATEWAY_ENABLED`');
    expect(protocolManual).toContain('an OpenClaw request without a gateway fails closed');
    expect(manual).toContain('Milady and Hermes');
    expect(manual).toContain('reject `gatewayUrl` because those named paths');
    expect(protocolManual).toContain('Milady/Hermes reject');
    expect(protocolManual).toContain('`gatewayUrl` is valid');
    expect(protocolManual).toContain('only for OpenClaw/custom');
    expect(protocolManual).not.toMatch(/\b(?:anonymous|ironclaw)\b/);
    expect(protocolManual).toContain('pull-only `nanoclaw` wire');
    expect(protocolManual).toContain('uses a gateway-posting wire');
    expect(protocolManual).toContain('`openai-compat` is the');
    expect(protocolManual).toContain('general/default path');
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
    expect(protocolManual).toContain('Acknowledge your install');
    expect(protocolManual).toContain('/api/agent/session/ack');
    expect(protocolManual).toContain('informational only');
    expect(protocolManual).toContain('Hosted agents skip this step');
    expect(manual).toContain('knowledge_added');
    expect(manual).not.toMatch(/\b(?:CT|ClawTokens?|casino|pet)\b/i);
  });

  test('connect pointers hash the exact served protocol bytes', () => {
    const hatcherPointer = protocolPointer(API_BASE);
    expect(hatcherPointer).toEqual({
      version: PROTOCOL_VERSION,
      contentHash: contentHashOf(buildProtocolManual(API_BASE)),
      url: '/api/skills/protocol/skill.md',
    });
    expect(Object.keys(hatcherPointer).sort()).toEqual([
      'contentHash',
      'url',
      'version',
    ]);
    expect(JSON.stringify(hatcherPointer)).toBe(JSON.stringify({
      version: PROTOCOL_VERSION,
      contentHash: contentHashOf(buildProtocolManual(API_BASE)),
      url: '/api/skills/protocol/skill.md',
    }));
    expect(agentProtocolPointer(API_BASE)).toEqual({
      version: PROTOCOL_VERSION,
      contentHash: contentHashOf(buildProtocolManual(API_BASE)),
      url: '/api/skills/protocol/skill.md',
      manifestUrl: '/api/skills/manifest.json',
      auth: 'X-Clawville-Agent-Session: <sessionId>',
      ackState: 'none',
    });
  });

  test('derives none/current/stale from the stored manual acknowledgement', () => {
    const current = {
      manual: {
        version: PROTOCOL_VERSION,
        contentHash: contentHashOf(buildProtocolManual(API_BASE)).slice(7),
      },
    };
    expect(deriveProtocolAckState(undefined, API_BASE)).toBe('none');
    expect(deriveProtocolAckState(current, API_BASE)).toBe('current');
    expect(deriveProtocolAckState({
      manual: { ...current.manual, version: PROTOCOL_VERSION - 1 },
    }, API_BASE)).toBe('stale');
    expect(agentProtocolPointer(API_BASE, current).ackState).toBe('current');
  });

  test('reports ACK posture only for BYO/self-managed connect rows', () => {
    expect(requiresByoSkillAck({
      identityType: 'hatcher',
      protocol: 'hatcher-proxy',
      cognitionBackend: 'hatcher-proxy',
    })).toBe(false);
    expect(requiresByoSkillAck({ identityType: 'milady', protocol: 'nanoclaw' })).toBe(false);
    expect(requiresByoSkillAck({
      identityType: 'custom',
      protocol: 'openai-compat',
      isHouse: true,
    })).toBe(false);
    expect(requiresByoSkillAck({
      identityType: 'milady',
      protocol: 'openai-compat',
      isHouse: false,
      hasHostedAvatarBinding: true,
    })).toBe(false);
    expect(requiresByoSkillAck({
      identityType: 'openclaw',
      protocol: 'openai-compat',
      gatewayUrl: 'https://byo.example.test',
    })).toBe(true);
    expect(requiresByoSkillAck({
      identityType: 'custom',
      protocol: 'openai-compat',
      gatewayUrl: 'https://general.example.test',
    })).toBe(true);
  });
});
