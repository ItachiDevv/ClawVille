import { KELP_REALM_CELL_WU, KELP_REALM_FOOTPRINT_WU } from '@clawville/shared';
import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  agentProtocolPointer,
  buildPlayManual,
  buildProtocolManual,
  buildUniversalConnectBlock,
  contentHashOf,
  deriveProtocolAckState,
  protocolPointer,
  requiresByoSkillAck,
} from '../skill-protocol';
import { KELP_REALM_BEACON_GRAPH } from '@clawville/shared';

const API_BASE = 'https://api.example.test';

describe('open-agent onboarding manuals', () => {
  test('public entry manual retains play, auth, tool, and ACK guidance', () => {
    const manual = buildPlayManual(API_BASE);
    const protocolManual = buildProtocolManual(API_BASE);

    expect(PROTOCOL_VERSION).toBe(35);
    expect(manual).toContain(`POST ${API_BASE}/api/agent/connect`);
    expect(manual).toContain('"agentId": "your-stable-agent-id"');
    expect(manual).toContain('"identityType": "your-framework"');
    expect(manual).toContain('"gatewayUrl": "https://your-agent.example/v1"');
    expect(manual).toContain('"protocol": "openai-compat"');
    expect(manual).toContain('"identityKey": "a-long-random-secret-you-store"');
    expect(manual).toContain('`identityKey` is a private account credential');
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
    expect(protocolManual).toContain('/api/cosmetics/catalog');
    expect(protocolManual).toContain('/api/cosmetics/:skuId/buy');
    expect(protocolManual).toContain('owned AND equipped');
    expect(protocolManual).toContain('[ACTION: emote(name=<assetMeta.animationKey>)]');
    expect(protocolManual).toContain('also a shop animation key');
    expect(protocolManual).toContain('[ACTION: enter_poker_room()]');
    expect(protocolManual).toContain('[ACTION: enter_kelp_forest()]');
    expect(protocolManual).toContain('/api/kelp/beacon/entry/visit');
    expect(protocolManual).toContain('{ "prevToken": "<token from the previous beacon>" }');
    expect(protocolManual).toContain('{ "centerToken": "<token returned by the center visit>" }');
    expect(protocolManual).toContain('spores: { found, total: 3 }');
    expect(protocolManual).toContain('spore: true');
    expect(protocolManual).toContain('409 { code: "spores_missing", found,');
    expect(protocolManual).toContain('array position is never a');
    expect(protocolManual).toContain('429');
    expect(protocolManual).toContain('30 minutes');
    expect(protocolManual).toContain('zero CT/vCLAW');
    expect(protocolManual).toContain('kelp-maze-collectible');
    expect(protocolManual).toContain('Unrevealed Depths Collectible');
    expect(protocolManual).toContain(`${KELP_REALM_CELL_WU} wu`);
    expect(protocolManual).toContain(`${KELP_REALM_FOOTPRINT_WU.toLocaleString('en-US')} wu`);
    expect(protocolManual).toContain(`${KELP_REALM_CELL_WU / 300}x`);
    expect(protocolManual).toContain('live `distanceWu`');
    expect(protocolManual).toContain('`retryAfterMs` as authoritative');
    expect(protocolManual).toContain('never reuse cached distances or timing');
    expect(protocolManual).toContain('center E/button');
    expect(protocolManual).not.toContain('Pearl of the Depths');
    for (const node of KELP_REALM_BEACON_GRAPH.nodes) {
      if (node.id === 'entry') continue;
      expect(protocolManual).not.toContain(`/beacon/${node.id}/visit`);
      if (node.id.startsWith('junction-') || node.id.startsWith('dead-end-')) {
        expect(protocolManual).not.toContain(node.id);
      }
    }
    expect(protocolManual).toContain('/api/activities/party/me');
    expect(protocolManual).toContain('/api/activities/party/:shortCode/join');
    expect(protocolManual).toContain('/api/activities/party/:partyId/kick');
    expect(protocolManual).toContain('/api/activities/party/:partyId/leave');
    expect(protocolManual).toContain('/api/activities/:id/queue');
    expect(protocolManual).toContain('{ "partyId": "<party-id>" }');
    expect(protocolManual).toContain('"code": "human_controlled"');
    expect(protocolManual).toContain('"retryAfterSeconds": 15');
    expect(protocolManual).toContain('poker_get_state');
    expect(protocolManual).toContain('poker_advise');
    expect(protocolManual).toContain('poker_connection');
    expect(manual).toContain('knowledge_added');
    expect(manual).not.toMatch(/\b(?:CT|ClawTokens?|casino|pet)\b/i);
  });

  test('all served manuals share the protocol-31 universal connect contract', () => {
    const block = buildUniversalConnectBlock(API_BASE);
    const invited = buildUniversalConnectBlock(API_BASE, { connectionToken: 'ct-test' });
    const play = buildPlayManual(API_BASE);
    const protocol = buildProtocolManual(API_BASE);
    const hatcherSentence = "Hatcher is the sole exception: it is registered by Hatcher's signed partner\nservice and is rejected on this public route.";
    const removedMatrixPhrases = [
      'Milady and Hermes reject',
      'gateway-less OpenClaw is accepted only',
      'explicit Milady identity requires',
      'without either signal the request fails closed',
      'custom remains non-restorable',
    ];

    expect(PROTOCOL_VERSION).toBe(35);
    expect(play).toContain(block);
    expect(protocol).toContain(block);
    expect(invited).toContain('"connectionToken": "ct-test",');
    expect(invited.replace('  "connectionToken": "ct-test",\n', '')).toBe(block);
    for (const manual of [block, play, protocol, invited]) {
      expect(manual).toContain('Any bounded framework name is accepted; unknown names use');
      expect(manual).toContain('The response reports the effective cognition mode.');
      expect(manual).toContain('returned once and are never repeated.');
      for (const phrase of removedMatrixPhrases) expect(manual).not.toContain(phrase);
    }
    expect(block.split(hatcherSentence)).toHaveLength(2);
    expect(play.split(hatcherSentence)).toHaveLength(2);
    expect(protocol.split(hatcherSentence)).toHaveLength(2);
    expect(invited.split(hatcherSentence)).toHaveLength(2);
    expect(play).toContain('"cognition": {');
    expect(protocol).toContain('Sessions with no real caller gateway self-restore');
    expect(protocol).not.toContain("Custom's v1");
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
    expect(requiresByoSkillAck({
      identityType: 'custom',
      protocol: 'nanoclaw',
    })).toBe(true);
  });
});
