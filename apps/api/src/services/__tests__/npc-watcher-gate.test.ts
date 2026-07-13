/**
 * Watcher-presence gate for ambient LLM banter (2026-07-13 OpenAI-usage audit).
 * The sim only spends inference on NPC↔NPC banter while a human-facing consumer
 * is present: a live SSE listener (legacy or room), or any watcher inside the
 * 60s grace window (REST /api/npc/state pollers, tab refreshes).
 *
 * Tests use the injectable `nowMs` parameter instead of sleeping; "far future"
 * (= now + 120s) is guaranteed past the grace window regardless of what other
 * suites stamped on the shared singleton.
 */
import { describe, expect, it } from 'bun:test';
import { npcSimulation } from '../npc-simulation';

const FAR_FUTURE = () => Date.now() + 120_000;
const listener = async (_snapshotJson: string) => {};

describe('ambient-banter watcher gate', () => {
  it('is unwatched once the grace window has passed with no live listeners', () => {
    expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false);
  });

  it('a live legacy SSE listener counts as a watcher even past grace', () => {
    npcSimulation.addListener(listener);
    try {
      expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(true);
    } finally {
      npcSimulation.removeListener(listener);
    }
  });

  it('a live room SSE listener counts as a watcher even past grace', () => {
    npcSimulation.addRoomListener('watcher-gate-test-room', listener);
    try {
      expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(true);
    } finally {
      npcSimulation.removeRoomListener('watcher-gate-test-room', listener);
    }
  });

  it('grace window covers a just-disconnected listener, then expires', () => {
    npcSimulation.addListener(listener);
    npcSimulation.removeListener(listener);
    expect(npcSimulation.hasActiveWatchers()).toBe(true); // within grace
    expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false); // past it
  });

  it('noteWorldWatched (REST snapshot fallback) grants the grace window only', () => {
    npcSimulation.noteWorldWatched();
    expect(npcSimulation.hasActiveWatchers()).toBe(true);
    expect(npcSimulation.hasActiveWatchers(FAR_FUTURE())).toBe(false);
  });
});
