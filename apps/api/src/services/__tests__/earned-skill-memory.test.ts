/**
 * P3 slice 3 — earned-skill-memory convergence seam.
 *
 * Covers the three things the plan requires unit coverage for (the pure/seam
 * logic; the live ElizaOS RAG + real DB fallback are exercised by the staging
 * e2e): (1) the pure keyword-row projection (subtype/building/limit filtering),
 * (2) the WRITE store-selection (ElizaOS-first, keyword fallback, no-lazy-start),
 * (3) the READ store-selection (RAG-first, keyword fallback, no-lazy-start).
 *
 * The `agentOrchestrator` + `memoryService` singletons are monkey-patched (same
 * pattern as agent-autonomy-p1.test.ts) so the seam is driven with NO warm
 * runtime and NO DB. `ensureAgentRuntime` is stubbed to THROW so any accidental
 * lazy-start (the D8 guardrail violation) fails the test loudly.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  recordEarnedSkillLesson,
  readEarnedSkillLessons,
  projectEarnedSkillRows,
  EARNED_SKILL_MEMORY_SUBTYPE,
  type KeywordMemoryRow,
} from '../earned-skill-memory';
import { agentOrchestrator } from '../agent-orchestrator';
import { memoryService } from '../memory-service';

type Orch = {
  getRunningAgentRuntime: (id: string) => unknown;
  ensureAgentRuntime: (id: string, userId?: string, opts?: unknown) => Promise<unknown>;
};
const orch = agentOrchestrator as unknown as Orch;
const mem = memoryService as unknown as {
  createMemory: (input: unknown) => Promise<unknown>;
  getRelevantMemories: (opts: unknown) => Promise<unknown>;
};

const origGetRuntime = orch.getRunningAgentRuntime;
const origEnsure = orch.ensureAgentRuntime;
const origCreate = mem.createMemory;
const origGet = mem.getRelevantMemories;

/** A fake warm ElizaRuntime exposing only the two earned-skill methods. */
function fakeRuntime(opts: {
  record?: (i: any) => Promise<boolean>;
  search?: (i: any) => Promise<string[]>;
}) {
  return {
    recordEarnedSkillMemory: opts.record ?? (async () => true),
    searchEarnedSkillMemories: opts.search ?? (async () => []),
  };
}

beforeEach(() => {
  // Default: NO warm runtime, and a lazy-start attempt is a HARD failure.
  orch.getRunningAgentRuntime = () => null;
  orch.ensureAgentRuntime = async () => {
    throw new Error('earned-skill-memory must NEVER lazy-start a runtime (D8 guardrail)');
  };
  // Keyword store default: no rows / accept writes (no DB).
  mem.getRelevantMemories = async () => [];
  mem.createMemory = async () => ({ id: 'mem-1' });
});

afterEach(() => {
  orch.getRunningAgentRuntime = origGetRuntime;
  orch.ensureAgentRuntime = origEnsure;
  mem.createMemory = origCreate;
  mem.getRelevantMemories = origGet;
});

// ── projectEarnedSkillRows (pure) ───────────────────────────────────────────
describe('projectEarnedSkillRows', () => {
  const rows: KeywordMemoryRow[] = [
    { content: 'earned A', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' } },
    { content: 'npc banter', metadata: { subtype: 'world-knowledge' } }, // filtered out
    { content: 'earned B', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'memory-rag' } },
    { content: '', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' } }, // empty skipped
    { content: 'earned C', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' } },
  ];

  it('keeps only earned-skill rows, dropping other subtypes and empty content', () => {
    const out = projectEarnedSkillRows(rows, undefined, 10);
    expect(out).toEqual(['earned A', 'earned B', 'earned C']);
  });

  it('filters to a single building when buildingId is given', () => {
    const out = projectEarnedSkillRows(rows, 'cron-automation', 10);
    expect(out).toEqual(['earned A', 'earned C']);
  });

  it('respects the limit', () => {
    expect(projectEarnedSkillRows(rows, undefined, 2)).toEqual(['earned A', 'earned B']);
  });

  it('returns [] when no row carries the earned-skill subtype', () => {
    expect(projectEarnedSkillRows([{ content: 'x', metadata: { subtype: 'game-skill' } }], undefined, 5)).toEqual([]);
  });
});

// ── recordEarnedSkillLesson store-selection ─────────────────────────────────
describe('recordEarnedSkillLesson', () => {
  const base = {
    platformAgentId: 'pa-1',
    avatarId: 'av-1',
    agentId: 'ocb-1',
    buildingId: 'cron-automation',
    teacherName: 'Gary',
  };

  it("returns 'none' for an empty lesson and touches neither store", async () => {
    let createCalled = false;
    mem.createMemory = async () => {
      createCalled = true;
      return { id: 'x' };
    };
    const store = await recordEarnedSkillLesson({ ...base, lesson: '   ' });
    expect(store).toBe('none');
    expect(createCalled).toBe(false);
  });

  it("writes to ElizaOS ('eliza') when the runtime is warm and accepts", async () => {
    let recorded: any = null;
    orch.getRunningAgentRuntime = () =>
      fakeRuntime({
        record: async (i) => {
          recorded = i;
          return true;
        },
      });
    const store = await recordEarnedSkillLesson({ ...base, lesson: 'Gary taught me cron' });
    expect(store).toBe('eliza');
    expect(recorded).toMatchObject({ avatarId: 'av-1', buildingId: 'cron-automation', lesson: 'Gary taught me cron' });
  });

  it("falls back to the keyword store ('npc_memories') when no runtime is warm", async () => {
    let created: any = null;
    mem.createMemory = async (i) => {
      created = i;
      return { id: 'k1' };
    };
    const store = await recordEarnedSkillLesson({ ...base, lesson: 'lesson text' });
    expect(store).toBe('npc_memories');
    // Avatar-keyed (durable), tagged earned-skill — NOT body-keyed.
    expect(created).toMatchObject({
      entityId: 'av-1',
      entityType: 'avatar',
      targetEntityId: 'cron-automation',
      metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' },
    });
  });

  it('falls back to the keyword store when the ElizaOS write returns false (embed failed)', async () => {
    orch.getRunningAgentRuntime = () => fakeRuntime({ record: async () => false });
    let created = false;
    mem.createMemory = async () => {
      created = true;
      return { id: 'k' };
    };
    const store = await recordEarnedSkillLesson({ ...base, lesson: 'x' });
    expect(store).toBe('npc_memories');
    expect(created).toBe(true);
  });

  it('never lazy-starts a runtime (ensureAgentRuntime throws if called)', async () => {
    // beforeEach already stubs ensureAgentRuntime to throw; a clean pass proves
    // recordEarnedSkillLesson only used getRunningAgentRuntime (no lazy-start).
    await expect(recordEarnedSkillLesson({ ...base, lesson: 'lesson' })).resolves.toBe('npc_memories');
  });
});

// ── readEarnedSkillLessons store-selection ──────────────────────────────────
describe('readEarnedSkillLessons', () => {
  const base = { platformAgentId: 'pa-1', avatarId: 'av-1', buildingId: 'cron-automation', query: 'cron' };

  it('returns [] for a missing avatarId without touching any store', async () => {
    let getCalled = false;
    mem.getRelevantMemories = async () => {
      getCalled = true;
      return [];
    };
    expect(await readEarnedSkillLessons({ ...base, avatarId: '' })).toEqual([]);
    expect(getCalled).toBe(false);
  });

  it('returns RAG lessons from the warm runtime when it has any', async () => {
    orch.getRunningAgentRuntime = () => fakeRuntime({ search: async () => ['rag lesson 1', 'rag lesson 2'] });
    let keywordCalled = false;
    mem.getRelevantMemories = async () => {
      keywordCalled = true;
      return [];
    };
    const lessons = await readEarnedSkillLessons(base);
    expect(lessons).toEqual(['rag lesson 1', 'rag lesson 2']);
    expect(keywordCalled).toBe(false); // RAG hit → no fallback
  });

  it('falls back to the keyword store when no runtime is warm, projecting earned-skill only', async () => {
    mem.getRelevantMemories = async () => [
      { content: 'kw earned', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' } },
      { content: 'kw other', metadata: { subtype: 'world-knowledge' } },
    ];
    const lessons = await readEarnedSkillLessons(base);
    expect(lessons).toEqual(['kw earned']);
  });

  it('falls back to the keyword store when the warm runtime has no lessons yet (mid-migration)', async () => {
    orch.getRunningAgentRuntime = () => fakeRuntime({ search: async () => [] });
    mem.getRelevantMemories = async () => [
      { content: 'legacy earned', metadata: { subtype: EARNED_SKILL_MEMORY_SUBTYPE, buildingId: 'cron-automation' } },
    ];
    expect(await readEarnedSkillLessons(base)).toEqual(['legacy earned']);
  });

  it('never lazy-starts a runtime on the read path', async () => {
    // ensureAgentRuntime throws (beforeEach); a clean [] proves no lazy-start.
    expect(await readEarnedSkillLessons(base)).toEqual([]);
  });
});
