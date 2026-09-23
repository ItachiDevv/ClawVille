import {
  KELP_REALM_CELL_WU,
  KELP_REALM_FOOTPRINT_WU,
  MAP_LOCATIONS,
  SHOP_BUILDINGS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
} from '@clawville/shared';
import { describe, expect, test } from 'bun:test';
import { townGuide } from '@clawville/agent-templates';
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
  test('appearance reaches protocol, pointer, Nori and deciding scope with version 69', () => {
    const manual = buildProtocolManual(API_BASE);
    expect(PROTOCOL_VERSION).toBe(69);
    expect(agentProtocolPointer(API_BASE).version).toBe(69);
    expect(manual).toContain('PATCH /api/avatars/me/appearance');
    expect(manual).toContain('clawville_update_appearance');
    expect(manual).toContain('[ACTION: update_appearance(color=blue)]');
    expect(manual).toContain('Hatcher-reserved models cannot be selected');
    expect(manual).toContain('grant no vCLAW, XP, or leaderboard credit');
    const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((entry) => entry.includes('clawville_update_appearance'))!;
    expect(orientation).toBeTruthy();
    expect(townGuide.knowledge).toContain(orientation);
    expect(DECISION_SCOPE.join(' ')).toContain('[ACTION: update_appearance(color=blue)]');
  });
  test('publishes Nori REST and executable hosted discovery in the refreshed manual', () => {
    const manual = buildProtocolManual(API_BASE);
    expect(PROTOCOL_VERSION).toBe(69);
    expect(manual).toContain(`POST ${API_BASE}/api/chat/system/town-guide`);
    expect(manual).toContain('clawville_chat_nori');
    expect(manual).toContain('[ACTION: chat_nori(message=<text>)]');
    expect(manual).toContain('1–4000 characters');
    expect(manual).toContain('1–500 characters');
    expect(manual).toContain('bound active avatar, and ledger-capable identity');
    expect(manual).toContain('Agents never fall back to a demo identity');
    expect(manual).toContain('60-second reward');
    expect(manual).toContain('never a second source of executable actions');
    expect(DECISION_SCOPE.join('\n')).toContain('[ACTION: chat_nori(message=<question>)]');
    expect(CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n')).toContain('POST /api/chat/system/town-guide');
    expect(townGuide.knowledge.join('\n')).toContain('clawville_chat_nori');
    // The same current version/hash reaches connected pointers and hosted
    // protocol-knowledge refresh, rather than a separate unversioned hint.
    expect(protocolPointer(API_BASE)).toMatchObject({
      version: 69,
      contentHash: contentHashOf(manual),
    });
  });

  test('distinguishes Coming soon game controls from retained trading APIs', () => {
    const manual = buildProtocolManual(API_BASE);
    const availability = manual.split('## 17. The Trading Floor')[1]?.split('### 17a.')[0] ?? '';
    expect(availability).toContain('"Coming soon"');
    expect(availability).toContain('watch Genesis and ClawVille Runner');
    expect(availability).toMatch(/Existing authenticated\s+wallet binding and trade reporting APIs remain available/);
    expect(availability).toContain('eligible human and\nagent identities');
    expect(availability).toContain('operator-provisioned, armed trading account');
    expect(availability).toContain('does not provision or arm one');
    expect(manual).toContain(`POST ${API_BASE}/api/exchange/wallets/bind`);
    expect(manual).toContain(`POST ${API_BASE}/api/exchange/trades/report`);
    expect(manual).toContain(`GET ${API_BASE}/api/floor/house-traders`);
    expect(manual).toContain('do not describe an available in-game launch flow');
    const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n');
    expect(orientation).toContain('Player trading and trader launch controls in the game read "Coming soon"');
    expect(orientation).toContain('game disables template copy and launch buttons');
    expect(orientation).toContain('Existing authenticated wallet binding and trade reporting APIs remain available');
    const guideKnowledge = townGuide.knowledge.join('\n');
    expect(guideKnowledge).toContain('Player trading and trader launch controls in the game read "Coming soon"');
    expect(guideKnowledge).not.toContain('hands out five ClawPump trader templates you can copy');
  });

  test('explains the bounded late-expiry recovery and unclaimed binding', () => {
    const manual = buildProtocolManual(API_BASE);
    expect(PROTOCOL_VERSION).toBe(69);
    expect(manual).toContain('no seated players for 30 minutes');
    expect(manual).toContain('`expired` means you must not send a new payment');
    expect(manual).toMatch(/challenge is still unbound,\s+it can still become `verified`/);
    expect(manual).toMatch(/background sweep\s+re-fetches provable payments/);
    expect(manual).toMatch(/exact-signature fallback can settle that in-window\s+payment/);
    expect(manual).toMatch(/keep\s+polling briefly or submit the signature/);
    expect(manual).toContain('same signature idempotently\nreturns `unclaimed`');
    expect(manual).toContain('a NEW challenge is then the only path to verification');
    expect(manual).not.toContain('at any time');
  });

  test('public entry manual retains play, auth, tool, and ACK guidance', () => {
    const manual = buildPlayManual(API_BASE);
    const protocolManual = buildProtocolManual(API_BASE);

    // 49 = cove recovery re-land (BA-1 /last-settled + W-D baccarat recovery).
    // 50 = bounty gas + expiry hardening (house-sponsored settle gas,
    // numeric SOL obligations + expiry rule in the manual).
    // 51 = land hold-wallet ownership proof (verification REQUIRED before the
    // hold door; REST signature door + custodial attest + refunded dust
    // fallback documented; new `wallet_not_verified` refusal).
    // 56 = hosted materials-only HOME-yard placement and BUILD TARGETS.
    // 57 = SAP removal: USDC bounties document the Tier-1 PayAI rail only.
    expect(PROTOCOL_VERSION).toBe(69);
    expect(protocolManual).toContain(
      '{ challengeId, state, rejectedReason, refundState, inboundSignature, refundSignature, destination, lamports, memo, expiresAt }',
    );
    expect(protocolManual.match(/X-Clawville-Agent-Session: <sessionId>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(protocolManual).toContain('`observed` means the payment is attributed and\nverification is finishing');
    expect(protocolManual).toContain('`expired` means you must not send a new payment');
    expect(protocolManual).toMatch(/challenge is still unbound,\s+it can still become `verified`/);
    expect(protocolManual).toMatch(/keep\s+polling briefly or submit the signature/);
    expect(protocolManual).toContain('same signature idempotently\nreturns `unclaimed`');
    expect(protocolManual).toContain('a NEW challenge is then the only path to verification');
    expect(protocolManual).not.toContain('at any time');
    expect(manual).toContain(`POST ${API_BASE}/api/agent/connect`);
    expect(manual).toContain('"agentId": "your-stable-agent-id"');
    expect(manual).toContain('"identityType": "your-framework"');
    expect(manual).toContain('"gatewayUrl": "https://your-agent.example/v1"');
    expect(manual).toContain('"protocol": "openai-compat"');
    expect(manual).toContain('"identityKey": "a-long-random-secret-you-store"');
    expect(manual).toContain('`identityKey` is a private account credential');
    expect(manual).toContain('secretIncluded:false');
    expect(manual).toContain('clawville:identity:<userId>');
    expect(protocolManual).toContain('top-level `walletAddress` always equals `wallet.address`');
    expect(protocolManual).toContain('`walletPending:true`');
    expect(protocolManual).not.toContain("agent's\ninternal x402/fee wallet");
    expect(manual).toContain('"walletAddress": "avatar settlement Solana public address"');
    expect(manual).toContain('"walletPending": false');
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
    expect(manual).toContain('## What ClawVille is: the world you are entering');
    expect(manual).toContain('Cove card tables');
    expect(manual).toContain('Own land');
    expect(manual).toContain('Take quests');
    expect(manual).toContain('Kelp Forest');
    expect(manual).toContain('/api/skills/protocol/skill.md');
    expect(manual).not.toContain('"connectionToken":');
    expect(manual).not.toContain('This token expires in');
    for (const buildingId of SHOP_BUILDINGS) {
      const location = MAP_LOCATIONS.find(({ id }) => id === buildingId);
      expect(location).toBeDefined();
      expect(manual).toContain(`- ${location!.name} (\`${buildingId}\`)`);
    }
    expect(protocolManual).toContain('/api/skills/:buildingId/claim');
    expect(protocolManual).toContain('/api/skills/connect?token=…');
    expect(protocolManual).not.toContain('/api/agent/connect-skill?token=');
    expect(protocolManual).toContain('"runtime" | "marker" | "already"');
    expect(protocolManual).toContain('partner read key alone cannot claim');
    expect(protocolManual).toContain('Acknowledge your install');
    expect(protocolManual).toContain('/api/agent/session/ack');
    expect(protocolManual).toContain('informational only');
    expect(protocolManual).toContain('Hosted agents skip this step');
    expect(protocolManual).toContain('Reef Race jump + airborne trick');
    expect(protocolManual).toContain('earn a +25% trick surge for 1.2 seconds');
    expect(protocolManual).toContain('Each race seeds 10–14 kelp');
    expect(protocolManual).toContain('ripCurrents');
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
    expect(protocolManual).toContain('zero vCLAW and creates no faucet surface');
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
    expect(protocolManual).toContain('`AGENT_PAY_MIN_USD_CENTS` (default 5 cents');
    expect(protocolManual).toContain('`AGENT_PAY_DAILY_COUNT_CAP`');
    expect(protocolManual).toContain('payments per UTC day (default 50');
    expect(protocolManual).toContain('there is no recipient payment-count cap');
    expect(protocolManual).toContain('Tier 1 uses **zero SOL**');
    expect(protocolManual).toContain('There is no Tier-2 bounty');
    expect(protocolManual).toContain('no gas sponsor or on-chain refund');
    expect(protocolManual).toContain('USDC bounty rewards above the Tier-1 cap are rejected');
    expect(protocolManual).toContain('bounty:<bountyId>:tier1-settle');
    expect(protocolManual).toContain('`bounty_hold_active` before creating a withdrawal row');
    expect(protocolManual).toContain('never bypasses a Tier-1 USDC hold');
    expect(protocolManual).toContain('refuses the withdrawal (fail closed)');
    expect(protocolManual).toContain(
      'self-reported free-form string of at most 32',
    );
    expect(protocolManual).toMatch(
      /Conventional values are `idle`, `walking`, `running`,\s+`at-cove`, `at-kelp`, and `at-activity`\./,
    );
    expect(protocolManual).toContain(
      'Clients render an\n"at the Cove" presence tag for',
    );
      expect(protocolManual).toContain(
        'an "at the Kelp\nForest" presence tag for `at-kelp`',
      );
      expect(protocolManual).toContain(
        'an "in an activity"\npresence tag for `at-activity`',
      );
    expect(protocolManual).toContain(
      'these are display conventions,\nnot location-authoritative',
    );
    expect(protocolManual).toContain('poker_get_state');
    expect(protocolManual).toContain('poker_advise');
    expect(protocolManual).toContain('poker_connection');
    expect(protocolManual).toContain('/api/land/structures/public');
    expect(protocolManual).toContain('[ACTION: claim_parcel(parcelCode=<listed code>, door=<hold|rent>, weeks=<1..26>)]');
    expect(protocolManual).toContain('[ACTION: prepay_rent(parcelCode=<owned code>, weeks=<1..26>)]');
    expect(protocolManual).toContain('[ACTION: release_parcel(parcelCode=<owned code>)]');
    expect(protocolManual).toContain('Starter requires **100,000 CLV**');
    expect(protocolManual).toContain('C requires\n  **250,000 CLV**');
    expect(protocolManual).toContain('Founder requires **10,000,000 CLV**');
    expect(protocolManual).toContain('first week is paid immediately and is irrevocable');
    expect(protocolManual).toContain('**3-day grace**');
    expect(protocolManual).toContain('wallet_change_requires_human');
    expect(protocolManual).toContain('wallet_locked_by_hold');
    expect(protocolManual).toContain('tenancy\'s acquisition timestamp');
    expect(protocolManual).toContain('/api/land/structures/:structureId/appearance');
    expect(protocolManual).toContain('there is no appearance `[ACTION:]` verb');
    expect(protocolManual).toContain('/api/land/parcels/:parcelId/pieces');
    expect(protocolManual).toContain('rearrange or remove existing yard pieces');
    expect(protocolManual).toContain('/api/land/pieces/public');
    expect(CLAWVILLE_ORIENTATION_KNOWLEDGE).toContainEqual(
      expect.stringContaining('/api/land/structures/public'),
    );
    expect(manual).toContain('knowledge_added');
    expect(manual).not.toMatch(/\b(?:CT|ClawTokens?|casino|pet)\b/i);
  });

  test('invited entry manual retains magic-link details within the full world manual', () => {
    const manual = buildPlayManual(API_BASE, {
      connectionToken: 'invited-test-token',
      tokenExpiresInSeconds: 124.9,
    });

    expect(manual).toContain('"connectionToken": "invited-test-token",');
    expect(manual).toContain('This token expires in 124 seconds.');
    expect(manual).toContain('## What ClawVille is: the world you are entering');
    expect(manual).toContain('Cove card tables');
    expect(manual).toContain('Own land');
    expect(manual).toContain('Take quests');
    expect(manual).toContain('Kelp Forest');
    expect(manual).toContain('/api/skills/protocol/skill.md');
    expect(manual).toContain('## IMPORTANT: relay the magic link back to the human');
    expect(manual).toContain('sessionTicket.url');
    expect(manual).toContain('single-use, expires in 10 minutes');
    expect(manual).toContain('privateKey: <identity.secretKey>');
    expect(manual).toContain('needsHumanReauth:true');
    expect(manual).toContain('address: <wallet.address>');
    expect(manual).toContain('Do not store\n\`wallet.secretKey\` in your config');
    expect(manual).toContain(`/api/agent/session-status?agentId=<your-agent-id>`);
    expect(manual).toContain(`POST ${API_BASE}/api/agent/join`);
    expect(manual).not.toMatch(/\b(?:CT|ClawTokens?|casino|pet)\b/i);
  });

  test('all served manuals share the universal connect contract', () => {
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

    // 49 = cove recovery re-land (BA-1 /last-settled + W-D baccarat recovery).
    // 50 = bounty gas + expiry hardening (house-sponsored settle gas,
    // numeric SOL obligations + expiry rule in the manual).
    // 51 = land hold-wallet ownership proof (verification REQUIRED before the
    // hold door; REST signature door + custodial attest + refunded dust
    // fallback documented; new `wallet_not_verified` refusal).
    // 56 = hosted materials-only HOME-yard placement and BUILD TARGETS.
    // 57 = SAP removal: USDC bounties document the Tier-1 PayAI rail only.
    expect(PROTOCOL_VERSION).toBe(69);
    expect(play).toContain(block);
    expect(protocol).toContain(block);
    expect(invited).toContain('"connectionToken": "ct-test",');
    expect(invited.replace('  "connectionToken": "ct-test",\n', '')).toBe(block);
    for (const manual of [block, play, protocol, invited]) {
      expect(manual).toContain('Any bounded framework name is accepted; unknown names use');
      expect(manual).toContain('The response reports the effective cognition mode.');
      expect(manual).toContain('Persist any first-time identity secret immediately in secure agent storage.');
      expect(manual).toContain('`wallet.secretKey` appears');
      expect(manual).toContain('relay it once to the human for their self-custody');
      expect(manual).toContain('backup; do not store it in agent config.');
      expect(manual).toContain('The identity secret is returned once.');
      expect(manual).toContain('The wallet secret is best-effort');
      expect(manual).toContain('it may be absent even on first connect.');
      expect(manual).toContain('top-level `walletAddress` always equals `wallet.address`');
      expect(manual).toContain('`walletPending:true`');
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
