/**
 * Watcher-presence gate + LLM budget for ambient banter (2026-07-13
 * OpenAI-usage audit + Codex adversarial round). The sim spends inference on
 * NPC↔NPC banter ONLY while:
 *   (a) a visibility heartbeat (`noteWorldWatched()`, wired to POST
 *       /api/npc/watch) landed within the 90s grace window — SSE listeners and
 *       REST snapshot fetches deliberately do NOT arm the gate; AND
 *   (b) the hourly LLM banter budget has headroom (hard cost backstop that
 *       holds even if the latch is spoofed).
 *
 * Tests use the injectable `nowMs` parameters instead of sleeping; "far
 * future" (= now + 180s) is guaranteed past the grace window regardless of
 * what other suites stamped on the shared singleton.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { npcSimulation } from '../npc-simulation';
import {
  FALLBACK_GREETINGS,
  FALLBACK_RESPONSES,
  generateOpenClawConversation,
} from '../npc-conversation-engine';
import type { NpcDefinition } from '@clawville/shared';

const FAR_FUTURE = () => Date.now() + 180_000;
const listener = async (_snapshotJson: string) => {};

afterEach(() => {
  delete process.env.NPC_BANTER_HOURLY_LLM_CAP;
});

describe('ambient-banter watcher gate', () => {
  it('is unwatched once the grace window has passed', () => {
    expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false);
  });

  it('a visibility heartbeat arms the gate for the grace window only', () => {
    npcSimulation.noteWorldWatched();
    expect(npcSimulation.hasActiveWatchers()).toBe(true);
    expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false);
  });

  it('SSE listeners do NOT arm the gate (hidden tabs hold streams open)', () => {
    npcSimulation.addListener(listener);
    npcSimulation.addRoomListener('watcher-gate-test-room', listener);
    try {
      // Live listeners on both paths, yet past-grace the world is unwatched.
      expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false);
    } finally {
      npcSimulation.removeListener(listener);
      npcSimulation.removeRoomListener('watcher-gate-test-room', listener);
    }
  });
});

describe('ambient-banter hourly LLM budget', () => {
  // Each test uses its own far-future window base so the shared singleton's
  // window state always rolls fresh.
  let windowHours = 10;
  const freshWindow = () => Date.now() + windowHours++ * 60 * 60 * 1000;

  it('caps consumption within a window and rolls over hourly', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '2';
    const w1 = freshWindow();
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1)).toBe(true);
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1 + 1_000)).toBe(true);
    // Cap reached — third consume in the same window is refused.
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1 + 2_000)).toBe(false);
    // Next hourly window — budget replenishes.
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1 + 61 * 60 * 1000)).toBe(true);
    windowHours += 2; // the +61min consume advanced the window past this base
  });

  it('cap of 0 disables LLM banter entirely', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '0';
    expect(npcSimulation.tryConsumeBanterLlmBudget(freshWindow())).toBe(false);
  });

  // Codex round 2 HIGH #1 regression: Number('') === 0, so unset/blank/invalid
  // values silently disabled LLM banter instead of applying the 120 default.
  it('unset cap applies the 120 default (not 0)', () => {
    delete process.env.NPC_BANTER_HOURLY_LLM_CAP;
    const w = freshWindow();
    for (let i = 0; i < 120; i++) {
      expect(npcSimulation.tryConsumeBanterLlmBudget(w + i)).toBe(true);
    }
    expect(npcSimulation.tryConsumeBanterLlmBudget(w + 200)).toBe(false); // 121st
  });

  it('blank and whitespace-only caps apply the default', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '';
    expect(npcSimulation.tryConsumeBanterLlmBudget(freshWindow())).toBe(true);
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '   ';
    expect(npcSimulation.tryConsumeBanterLlmBudget(freshWindow())).toBe(true);
  });

  it('invalid and negative caps apply the default', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = 'abc';
    expect(npcSimulation.tryConsumeBanterLlmBudget(freshWindow())).toBe(true);
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '-5';
    expect(npcSimulation.tryConsumeBanterLlmBudget(freshWindow())).toBe(true);
  });

  it('explicit positive cap is honored', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '1';
    const w = freshWindow();
    expect(npcSimulation.tryConsumeBanterLlmBudget(w)).toBe(true);
    expect(npcSimulation.tryConsumeBanterLlmBudget(w + 1_000)).toBe(false);
  });
});

describe('gated agent conversations keep partner cognition alive (Codex round 2 HIGH #2)', () => {
  const CANNED = new Set<string>([...FALLBACK_GREETINGS, ...FALLBACK_RESPONSES]);
  const defA = {
    id: 'wgate-agent', name: 'Wardenclaw', species: 'crab', color: 0,
    buildingId: '', patrolRadius: 0, homeX: 0, homeY: 0,
    personality: 'A test agent body.',
  } as unknown as NpcDefinition;
  const defB = {
    id: 'wgate-npc', name: 'Bubbles', species: 'fish', color: 0,
    buildingId: '', patrolRadius: 0, homeX: 0, homeY: 0,
    personality: 'A plain resident.',
  } as unknown as NpcDefinition;

  it('allowNpcLlm:false still runs client.chat + action dispatch; npc legs are canned', async () => {
    let chatCalls = 0;
    let dispatches = 0;
    const fakeClient = {
      chat: async () => {
        chatCalls++;
        return 'Scanning the reef for anomalies. [ACTION: move(x=10,y=20)]';
      },
      getProtocol: () => 'hatcher-proxy',
    } as never;

    const messages = await generateOpenClawConversation(
      defA,
      defB,
      fakeClient,
      null,
      false,
      undefined,
      (_npcId, _client, raw) => {
        dispatches++;
        return raw.replace(/\[ACTION:[^\]]*\]/g, '').trim();
      },
      { allowNpcLlm: false },
    );

    // Agent cognition + the [ACTION:] hook MUST have run despite the gate.
    expect(chatCalls).toBeGreaterThan(0);
    expect(dispatches).toBeGreaterThan(0);
    const agentLines = messages.filter((m) => m.npcId === defA.id);
    expect(agentLines.length).toBeGreaterThan(0);
    expect(agentLines[0].text).toContain('Scanning the reef');
    // The non-agent side spoke only canned-pool lines (zero paid inference).
    const npcLines = messages.filter((m) => m.npcId === defB.id);
    expect(npcLines.length).toBeGreaterThan(0);
    for (const line of npcLines) {
      expect(CANNED.has(line.text)).toBe(true);
    }
  });
});
