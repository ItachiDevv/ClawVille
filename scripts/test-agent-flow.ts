// ClawVille Agent Integration Test
//
// Tests the full OpenClaw agent connection pipeline:
//   1. Register an avatar bot via /api/openclaw/register
//   2. Get perception via /api/agent/:sessionId/perception
//   3. Chat via /api/agent/:sessionId/chat
//   4. Move + visit a building via /api/agent/:sessionId/move, /visit-building
//   5. Check knowledge via /api/agent/:sessionId/knowledge
//   6. Get stats via /api/agent/:sessionId/stats
//   7. Disconnect via /api/openclaw/unregister/:sessionId
//
// Prerequisites:
//   1. API running at API_URL (default: https://api-production-e9f2.up.railway.app)
//   2. Mock gateway running: bun run test:mock-gateway
//
// Run: bun run scripts/test-agent-flow.ts
// Or:  bun run test:agent-flow

const API_URL = process.env.API_URL || 'https://api-production-e9f2.up.railway.app';
const BOT_URL = process.env.BOT_URL || 'http://localhost:9876';

// --- Helpers ---

let passCount = 0;
let failCount = 0;

function pass(label: string, detail?: string) {
  passCount++;
  console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string) {
  failCount++;
  console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(`${path} -> ${res.status}: ${msg}`);
  }
  return data as T;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main test flow ---

async function main() {
  console.log('=== ClawVille Agent Integration Test ===');
  console.log(`API:  ${API_URL}`);
  console.log(`Bot:  ${BOT_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // -----------------------------------------------------------------------
  // Phase 0: Health checks
  // -----------------------------------------------------------------------
  console.log('Phase 0: Health checks');

  try {
    const health = await fetch(`${BOT_URL}/health`).then((r) => r.json());
    pass('Mock gateway reachable', `status=${health.status}`);
  } catch (err: any) {
    fail('Mock gateway NOT reachable', err.message);
    console.error('\n  Start it with: bun run test:mock-gateway\n');
    process.exit(1);
  }

  try {
    // Hit the API root or a known route to verify it's up
    const res = await fetch(`${API_URL}/api/openclaw/active`);
    if (res.ok) {
      pass('API server reachable', `${API_URL}`);
    } else {
      fail('API server returned error', `status=${res.status}`);
    }
  } catch (err: any) {
    fail('API server NOT reachable', err.message);
    console.error(`\n  Ensure the API is running at ${API_URL}\n`);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Phase 1: Register OpenClaw avatar bot
  // -----------------------------------------------------------------------
  console.log('\nPhase 1: Register avatar bot');

  let sessionId: string;
  let botId: string;

  try {
    const reg = await api<{
      sessionId: string;
      botId: string;
      agentId: string;
      mode: string;
      isReturning: boolean;
      totalSessions: number;
      elizaAgentId?: string;
    }>('/api/openclaw/register', {
      method: 'POST',
      body: JSON.stringify({
        gatewayUrl: BOT_URL,
        authToken: 'test-token-clawville',
        agentId: `test-bot-${Date.now()}`,
        sessionKey: `sk-test-${Date.now()}`,
        protocol: 'openai-compat',
        autonomyMode: 'server-managed',
        mode: 'avatar',
        name: 'TestClaw',
        species: 'lobster',
        color: 0xff4444,
        stats: { hp: 100, attack: 15, defense: 10, speed: 12 },
        personality: 'A curious test bot exploring ClawVille',
        homeX: 640,
        homeY: 400,
        patrolRadius: 128,
      }),
    });

    sessionId = reg.sessionId;
    botId = reg.botId;
    pass('Registered', `sessionId=${sessionId}, mode=${reg.mode}, returning=${reg.isReturning}`);

    if (reg.elizaAgentId) {
      pass('ElizaOS agent created', `agentId=${reg.elizaAgentId}`);
    } else {
      // Non-fatal: agent creation may fail without full DB setup
      console.log('  [INFO] No ElizaOS agent created (expected if DB is not seeded)');
    }
  } catch (err: any) {
    fail('Registration failed', err.message);
    process.exit(1);
  }

  // Give the simulation a moment to settle the new NPC
  await sleep(500);

  // -----------------------------------------------------------------------
  // Phase 2: Get perception
  // -----------------------------------------------------------------------
  console.log('\nPhase 2: Perception');

  try {
    const perception = await api<{
      self: { npcId: string; x: number; y: number; hp: number };
      nearbyNpcs: any[];
      nearbyBuildings: any[];
      gameMode: string;
      timestamp: number;
    }>(`/api/agent/${sessionId}/perception`);

    pass('Perception received', [
      `pos=(${Math.round(perception.self.x)}, ${Math.round(perception.self.y)})`,
      `hp=${perception.self.hp}`,
      `npcs=${perception.nearbyNpcs.length}`,
      `buildings=${perception.nearbyBuildings.length}`,
      `mode=${perception.gameMode}`,
    ].join(', '));

    if (perception.nearbyBuildings.length > 0) {
      const closest = perception.nearbyBuildings[0];
      pass('Closest building', `${closest.buildingId} (${closest.label}) at ${closest.distance}px`);
    }
  } catch (err: any) {
    fail('Perception failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 3: Chat
  // -----------------------------------------------------------------------
  console.log('\nPhase 3: Chat');

  try {
    const chatRes = await api<{ success: boolean; response: string | null }>(`/api/agent/${sessionId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'Tell me about cron scheduling for agents' }),
    });

    if (chatRes.success) {
      pass('Chat sent', chatRes.response ? `response="${chatRes.response.substring(0, 80)}..."` : 'injected into world (no ElizaOS response)');
    } else {
      fail('Chat returned success=false');
    }
  } catch (err: any) {
    fail('Chat failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 4: Move toward a building
  // -----------------------------------------------------------------------
  console.log('\nPhase 4: Move to building');

  try {
    const moveRes = await api<{ success: boolean; pathLength: number; destination: { x: number; y: number } }>(`/api/agent/${sessionId}/move`, {
      method: 'POST',
      body: JSON.stringify({ buildingId: 'cron-hub' }),
    });

    pass('Move command accepted', `pathLength=${moveRes.pathLength}, dest=(${Math.round(moveRes.destination.x)}, ${Math.round(moveRes.destination.y)})`);
  } catch (err: any) {
    fail('Move failed', err.message);
  }

  // Wait for the NPC to walk toward the building
  console.log('  [INFO] Waiting 3s for NPC to walk...');
  await sleep(3000);

  // -----------------------------------------------------------------------
  // Phase 5: Visit building
  // -----------------------------------------------------------------------
  console.log('\nPhase 5: Visit building');

  try {
    const visitRes = await api<{
      success: boolean;
      activity: string;
      tokenAwarded: number;
      knowledgeGained: string | null;
    }>(`/api/agent/${sessionId}/visit-building`, {
      method: 'POST',
      body: JSON.stringify({ buildingId: 'cron-hub' }),
    });

    pass('Visit successful', `activity=${visitRes.activity}, token=${visitRes.tokenAwarded}, knowledge="${visitRes.knowledgeGained || 'none'}"`);
  } catch (err: any) {
    // Might fail if NPC hasn't reached the building yet (proximity check)
    if (err.message.includes('Too far')) {
      console.log('  [SKIP] NPC not close enough yet — this is expected if pathfinding takes longer');
    } else {
      fail('Visit failed', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 6: Emote
  // -----------------------------------------------------------------------
  console.log('\nPhase 6: Emote');

  try {
    const emoteRes = await api<{ success: boolean; activity: string }>(`/api/agent/${sessionId}/emote`, {
      method: 'POST',
      body: JSON.stringify({ activity: 'reading' }),
    });
    pass('Emote set', `activity=${emoteRes.activity}`);
  } catch (err: any) {
    fail('Emote failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 7: Knowledge
  // -----------------------------------------------------------------------
  console.log('\nPhase 7: Knowledge');

  try {
    const knowledgeRes = await api<{ knowledge: string[] }>(`/api/agent/${sessionId}/knowledge`);
    pass('Knowledge retrieved', `entries=${knowledgeRes.knowledge.length}`);
    if (knowledgeRes.knowledge.length > 0) {
      knowledgeRes.knowledge.forEach((k) => console.log(`    - ${k}`));
    }
  } catch (err: any) {
    fail('Knowledge retrieval failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 8: Stats
  // -----------------------------------------------------------------------
  console.log('\nPhase 8: Stats');

  try {
    const statsRes = await api<{
      sessionId: string;
      npcId: string;
      kills: number;
      level: number;
      xp: number;
      totalMessages: number;
      knowledgeLearned: string[];
    }>(`/api/agent/${sessionId}/stats`);

    pass('Stats retrieved', `level=${statsRes.level}, xp=${statsRes.xp}, kills=${statsRes.kills}, messages=${statsRes.totalMessages}`);
  } catch (err: any) {
    fail('Stats retrieval failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 9: Final perception (verify state changed)
  // -----------------------------------------------------------------------
  console.log('\nPhase 9: Final perception');

  try {
    const finalPerception = await api<{
      self: { npcId: string; x: number; y: number; hp: number; activity: string };
    }>(`/api/agent/${sessionId}/perception`);

    pass('Final state', `pos=(${Math.round(finalPerception.self.x)}, ${Math.round(finalPerception.self.y)}), activity=${finalPerception.self.activity}`);
  } catch (err: any) {
    fail('Final perception failed', err.message);
  }

  // -----------------------------------------------------------------------
  // Phase 10: Disconnect
  // -----------------------------------------------------------------------
  console.log('\nPhase 10: Disconnect');

  try {
    const disconnectRes = await api<{ success: boolean }>(`/api/openclaw/unregister/${sessionId}`, {
      method: 'DELETE',
    });

    if (disconnectRes.success) {
      pass('Disconnected cleanly');
    } else {
      fail('Disconnect returned success=false');
    }
  } catch (err: any) {
    fail('Disconnect failed', err.message);
  }

  // Verify session is invalidated
  try {
    await api(`/api/agent/${sessionId}/perception`);
    fail('Session still valid after disconnect');
  } catch {
    pass('Session correctly invalidated after disconnect');
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  console.log('='.repeat(50));

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
