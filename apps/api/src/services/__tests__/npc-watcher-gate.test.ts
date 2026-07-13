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
  it('caps consumption within a window and rolls over hourly', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '2';
    // Fresh window far past anything earlier tests consumed.
    const w1 = Date.now() + 10 * 60 * 60 * 1000;
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1)).toBe(true);
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1 + 1_000)).toBe(true);
    // Cap reached — third consume in the same window is refused.
    expect(npcSimulation.tryConsumeBanterLlmBudget(w1 + 2_000)).toBe(false);
    // Next hourly window — budget replenishes.
    const w2 = w1 + 61 * 60 * 1000;
    expect(npcSimulation.tryConsumeBanterLlmBudget(w2)).toBe(true);
  });

  it('cap of 0 disables LLM banter entirely', () => {
    process.env.NPC_BANTER_HOURLY_LLM_CAP = '0';
    const w = Date.now() + 20 * 60 * 60 * 1000;
    expect(npcSimulation.tryConsumeBanterLlmBudget(w)).toBe(false);
  });
});
