import { describe, it, expect } from 'bun:test';
import { ElizaRuntime } from './eliza-runtime';

/**
 * Regression: F1 (2026-06-21) — EVERY building teacher AND Nori the Town Guide
 * answered chat as "Pearl, the teen whale".
 *
 * Root cause: the system-npc-seeder inserts every platform_agents row with
 * `config: {}`, so the orchestrator passes `agentConfig: {}` to ElizaRuntime.
 * The constructor's location/system-agent branch then did
 *   `const locationId = config.agentConfig?.locationId || 'cron-automation'`
 * → every agent loaded the cron-automation template (Pearl), and
 * `convertToElizaCharacter` rebuilt `system` / `messageExamples` / `adjectives` /
 * `knowledge` FROM that wrong template while IGNORING the correct `customization`
 * the seeder assembled. The Pearl few-shot examples dominated the prompt → every
 * agent said "I'm Pearl".
 *
 * Fix: `convertToElizaCharacter` is now customization-first, and the silent
 * 'cron-automation' default is removed.
 *
 * This test builds the character through the SAME path the orchestrator uses for
 * a seeded location/system agent — `agentType: 'location-agent'` (system agents
 * are mapped to 'location-agent' in agent-orchestrator) + `agentConfig: {}` +
 * a full `customization` — and asserts the persona is customization-driven, NOT
 * the cron-automation (Pearl) fallback. Pure character construction: no DB, no LLM.
 *
 * Before the fix, the three `expect`s in the Mr. Krabs case all fail (system has
 * no "Krusty Krab", examples have no "gateway master", and the blob contains
 * "pearl"/"teen whale"). After the fix they pass.
 */
function buildCharacter(customization: Record<string, unknown>) {
  const rt = new ElizaRuntime({
    agentId: '00000000-0000-0000-0000-000000000001',
    agentType: 'location-agent',
    agentConfig: {}, // <- the seeder's exact empty shape that triggered the bug
    customization: customization as never,
  });
  return rt.getCharacter();
}

const mrKrabs = {
  name: 'Mr. Krabs',
  bio: ['A money-loving crustacean who runs the Krusty Krab.'],
  knowledge: ['MCP lets agents call external tools through a standard protocol.'],
  topics: ['mcp', 'tools'],
  adjectives: ['greedy', 'gruff', 'entrepreneurial'],
  messageExamples: [
    [
      { user: '{{user1}}', content: { text: 'Who are you?' } },
      {
        user: 'Mr. Krabs',
        content: { text: "ARRR! I'm Mr. Krabs, the gateway master of the Krusty Krab — money an' tools, me boy!" },
      },
    ],
  ],
  style: { all: ['Talk like a money-obsessed pirate'], chat: [], post: [] },
  system:
    'You are Mr. Krabs, the resident character of Krusty Krab. Teach visiting agents about MCP tool use through your money-obsessed pirate persona.',
};

const nori = {
  name: 'Nori the Town Guide',
  bio: ['The friendly switchboard of ClawVille.'],
  // Nori's knowledge legitimately mentions Pearl ("Pearl handles cron") — that is
  // correct redirect knowledge, NOT an identity. Her identity must stay Nori.
  knowledge: ['ClawVille has 10 buildings. Pearl handles cron at the Downtown Building.'],
  topics: ['orientation', 'buildings'],
  adjectives: ['welcoming', 'helpful'],
  messageExamples: [
    [
      { user: '{{user1}}', content: { text: 'Who are you?' } },
      {
        user: 'Nori the Town Guide',
        content: { text: "Hi! I'm Nori, the Town Guide — I point you to the right building." },
      },
    ],
  ],
  style: { all: ['Be warm and concise'], chat: [], post: [] },
  system:
    'You are Nori the Town Guide, a world-wide NPC at ClawVille. Orient visitors and point them to the right building teacher.',
};

describe('location/system-agent character is customization-first (F1 regression)', () => {
  it('keeps knowledge out of bio and caps examples to the first three', () => {
    const knowledge = ['corpus one', 'corpus two', 'corpus three'];
    const messageExamples = Array.from({ length: 5 }, (_, index) => [
      { user: '{{user1}}', content: { text: `question ${index}` } },
      { user: 'assistant', content: { text: `answer ${index}` } },
    ]);
    const ch = buildCharacter({
      name: 'Diet Test Teacher',
      bio: ['Persona bio only.'],
      knowledge,
      messageExamples,
    });

    expect(ch.bio).toEqual(['Persona bio only.']);
    expect(ch.messageExamples).toHaveLength(3);
    expect(JSON.stringify(ch.bio)).not.toContain('corpus one');
    expect(ch.knowledge).toEqual([]);
  });

  it('Mr. Krabs (mcp-tool-use) keeps his own persona — never Pearl', () => {
    const ch = buildCharacter(mrKrabs);
    const blob = JSON.stringify(ch).toLowerCase();
    expect(ch.name).toBe('Mr. Krabs');
    // system comes from customization.system (not the cron template description)
    expect(ch.system).toContain('Krusty Krab');
    // messageExamples come from customization (not cron's Pearl examples)
    expect(blob).toContain('gateway master');
    // the bug signature: cron fallback bled Pearl's persona into every agent
    expect(blob).not.toContain('pearl');
    expect(blob).not.toContain('teen whale');
  });

  it('Nori the Town Guide keeps her identity — never Pearl the teen whale', () => {
    const ch = buildCharacter(nori);
    expect(ch.name).toBe('Nori the Town Guide');
    expect(ch.system).toContain('Town Guide');
    // Her examples + identity must be Nori. (Her KNOWLEDGE may mention Pearl by
    // name as a redirect, so we scope the no-Pearl check to her examples.)
    const examplesBlob = JSON.stringify(ch.messageExamples).toLowerCase();
    expect(examplesBlob).toContain('town guide');
    expect(examplesBlob).not.toContain('teen whale');
  });

  it('falls back to template fields only when customization omits them, without crashing', () => {
    const ch = buildCharacter({ name: 'Larry the Lobster', bio: ['Beach bum.'] });
    expect(ch.name).toBe('Larry the Lobster');
  });
});

/**
 * Regression: F3 (2026-06-21) — building teacher + Nori chat replies were too long
 * (multi-paragraph essays). The fix appends a global brevity directive to EVERY
 * location/system-agent system prompt in convertToElizaCharacter so it cannot drift
 * per-template, paired with a tighter conversational maxTokens backstop in
 * processMessage. These assertions lock the directive in.
 */
describe('location/system-agent system prompt carries the global brevity rule (F3 regression)', () => {
  it('appends the 2-3 sentence brevity directive when customization supplies its own system', () => {
    const ch = buildCharacter(mrKrabs);
    // persona is preserved AND the brevity rule is appended after it
    expect(ch.system).toContain('Krusty Krab');
    expect(ch.system).toContain('RESPONSE LENGTH');
    expect(ch.system?.toLowerCase()).toContain('1-3');
    expect(ch.system?.toLowerCase()).toContain('sentence');
  });

  it('appends the brevity directive even when the system is synthesized from the template', () => {
    // no customization.system → system is built from name/description, then the
    // directive is appended. Proves it cannot be dropped by a template that omits it.
    const ch = buildCharacter({ name: 'Larry the Lobster', bio: ['Beach bum.'] });
    expect(ch.system).toContain('RESPONSE LENGTH');
  });
});
