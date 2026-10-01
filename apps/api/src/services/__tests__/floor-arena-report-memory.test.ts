/**
 * D29: every player arena report is stored as an earned-skill lesson of the
 * owner's avatar (warm runtime first, avatar-keyed keyword store otherwise),
 * and the owner's avatar chat folds those Trading Floor lessons in.
 *
 * Same seam pattern as earned-skill-memory.test.ts: the `agentOrchestrator` and
 * `memoryService` singletons are monkey-patched, `ensureAgentRuntime` THROWS so
 * any lazy-start fails the test, and the avatar lookup is injected, so the
 * tests need no database and no runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tradingFloorLessonContext, writeArenaReportMemory } from '../floor-arena/analysis-store';
import { agentOrchestrator } from '../agent-orchestrator';
import { memoryService } from '../memory-service';
import { EARNED_SKILL_MEMORY_SUBTYPE } from '../earned-skill-memory';

type Orch = {
  getRunningAgentRuntime: (id: string) => unknown;
  ensureAgentRuntime: (id: string, userId?: string, opts?: unknown) => Promise<unknown>;
};
const orch = agentOrchestrator as unknown as Orch;
const mem = memoryService as unknown as { createMemory: (input: unknown) => Promise<unknown> };
const origGetRuntime = orch.getRunningAgentRuntime;
const origEnsure = orch.ensureAgentRuntime;
const origCreate = mem.createMemory;

const REPORT = {
  agentId: 'arena-agent-1',
  agentName: 'My Trader',
  avatarId: 'avatar-1',
  text: 'Trading Arena report for my paper trader My Trader (2026-10-01T11:30Z to 2026-10-01T12:00Z): Two deaths.',
};

let recorded: any[];
let keyword: any[];

beforeEach(() => {
  recorded = [];
  keyword = [];
  orch.getRunningAgentRuntime = () => null;
  orch.ensureAgentRuntime = async () => {
    throw new Error('the arena report memory must NEVER lazy-start a runtime');
  };
  mem.createMemory = async (input) => {
    keyword.push(input);
    return { id: 'mem-1' };
  };
});

afterEach(() => {
  orch.getRunningAgentRuntime = origGetRuntime;
  orch.ensureAgentRuntime = origEnsure;
  mem.createMemory = origCreate;
});

function warmRuntime(ok: boolean | Error = true) {
  return {
    recordEarnedSkillMemory: async (input: unknown) => {
      recorded.push(input);
      if (ok instanceof Error) throw ok;
      return ok;
    },
    searchEarnedSkillMemories: async () => [],
  };
}

describe('writeArenaReportMemory (D29)', () => {
  it('stores in the warm ElizaOS runtime under the Trading Floor building', async () => {
    orch.getRunningAgentRuntime = (id) => (id === 'pa-1' ? warmRuntime() : null);
    const store = await writeArenaReportMemory(REPORT, async () => 'pa-1');
    expect(store).toBe('eliza');
    expect(recorded).toEqual([
      { avatarId: 'avatar-1', buildingId: 'cron-automation', teacherName: 'Trading Arena analyst', lesson: REPORT.text },
    ]);
    expect(keyword).toHaveLength(0);
  });

  it('falls back to the avatar-keyed keyword store when the avatar has no hosted agent', async () => {
    const store = await writeArenaReportMemory(REPORT, async () => null);
    expect(store).toBe('npc_memories');
    expect(keyword).toHaveLength(1);
    expect(keyword[0]).toMatchObject({
      entityId: 'avatar-1',
      entityType: 'avatar',
      targetEntityId: 'cron-automation',
      content: REPORT.text,
      metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation', teacher: 'Trading Arena analyst', agentId: 'arena-agent-1' },
    });
  });

  it('falls back to the keyword store when the hosted runtime is asleep, without starting it', async () => {
    const store = await writeArenaReportMemory(REPORT, async () => 'pa-1');
    expect(store).toBe('npc_memories');
    expect(keyword).toHaveLength(1);
  });

  it('falls back when the runtime refuses, and still when the avatar lookup fails', async () => {
    orch.getRunningAgentRuntime = () => warmRuntime(false);
    expect(await writeArenaReportMemory(REPORT, async () => 'pa-1')).toBe('npc_memories');
    expect(await writeArenaReportMemory(REPORT, async () => { throw new Error('db down'); })).toBe('npc_memories');
    expect(keyword).toHaveLength(2);
  });

  it('returns none and never throws when both stores fail', async () => {
    orch.getRunningAgentRuntime = () => warmRuntime(new Error('embed down'));
    mem.createMemory = async () => { throw new Error('keyword store down'); };
    await expect(writeArenaReportMemory(REPORT, async () => 'pa-1')).resolves.toBe('none');
  });
});

describe('tradingFloorLessonContext (D29 owner-chat recall)', () => {
  const input = { userId: 'user-1', platformAgentId: 'pa-1', avatarId: 'avatar-1', query: 'how is my trader doing?' };

  it('folds the Trading Floor lessons for an owner with an arena agent', async () => {
    const reads: any[] = [];
    const context = await tradingFloorLessonContext(input, {
      hasArenaAgent: async (userId) => userId === 'user-1',
      read: async (i) => { reads.push(i); return ['Report A', 'Report B']; },
    });
    expect(reads).toEqual([{ ...input, buildingId: 'cron-automation', limit: 3 }]);
    expect(context).toContain('What you have learned at the Trading Floor');
    expect(context).toContain('- Report A\n- Report B');
  });

  it('adds nothing, and reads nothing, for an owner without an arena agent', async () => {
    let read = false;
    const context = await tradingFloorLessonContext(input, {
      hasArenaAgent: async () => false,
      read: async () => { read = true; return ['x']; },
    });
    expect(context).toBeNull();
    expect(read).toBe(false);
  });

  it('Codex r14: a hanging arena LOOKUP is bounded by the same 1.5 s, so the chat proceeds', async () => {
    let read = false;
    const started = Date.now();
    const context = await tradingFloorLessonContext(input, {
      hasArenaAgent: () => new Promise<boolean>(() => {}),
      read: async () => { read = true; return ['x']; },
    });
    const elapsed = Date.now() - started;
    expect(context).toBeNull();
    expect(read).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('one budget covers lookup + read: a slow lookup followed by a slow read still ends at the bound', async () => {
    // Lookup 40 ms + read 40 ms against ONE 50 ms box. The box is due at 50 ms
    // and the read at 80 ms; timers fire in due order, so null is
    // deterministic under jitter. With separate budgets (the r14 bug) the read
    // would win its own 50 ms race and return 'late'.
    const started = Date.now();
    const context = await tradingFloorLessonContext(input, {
      hasArenaAgent: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
      read: () => new Promise<string[]>((resolve) => setTimeout(() => resolve(['late']), 40)),
      timeoutMs: 50,
    });
    expect(context).toBeNull();
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('a lookup that rejects AFTER the timeout is handled, never an unhandled rejection', async () => {
    const context = await tradingFloorLessonContext(input, {
      hasArenaAgent: () => new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('late db error')), 30)),
      timeoutMs: 10,
    });
    expect(context).toBeNull();
    // Let the late rejection land inside this test: an unhandled one fails the run.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('is fail-soft: no lessons, a failing read, a slow read or a failing lookup all give null', async () => {
    const yes = async () => true;
    expect(await tradingFloorLessonContext(input, { hasArenaAgent: yes, read: async () => [] })).toBeNull();
    expect(await tradingFloorLessonContext(input, { hasArenaAgent: yes, read: async () => { throw new Error('rag down'); } })).toBeNull();
    expect(await tradingFloorLessonContext(input, { hasArenaAgent: yes, read: () => new Promise(() => {}), timeoutMs: 20 })).toBeNull();
    expect(await tradingFloorLessonContext(input, { hasArenaAgent: async () => { throw new Error('db down'); } })).toBeNull();
  });
});
