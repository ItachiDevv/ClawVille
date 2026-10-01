/**
 * earned-skill-memory — the P3 slice-3 memory CONVERGENCE seam.
 *
 * ONE store for an autonomous/connected agent's EARNED-SKILL lessons (teacher
 * turns), converged ONTO the agent's own ElizaOS runtime (embedded, semantic
 * RAG) — killing the pre-slice-3 divergence where the autonomy loop wrote
 * lessons to the parallel `npc_memories` keyword store keyed to the TRANSIENT
 * in-world body (so they died on idle-despawn), while hosted CHAT persisted to
 * ElizaOS.
 *
 * WRITE (`recordEarnedSkillLesson`): persist to the acting agent's OWN warmed
 * ElizaOS runtime (avatar-keyed, embedded — survives despawn). The `npc_memories`
 * keyword store is the FALLBACK, used ONLY when the runtime isn't warm or the
 * embedding fails — and even then it is keyed to the durable AVATAR (not the
 * transient body), so behavior never degrades below today. We NEVER lazy-start a
 * runtime just to write (the D8 cost guardrail — only the driver/chat paths that
 * already hold a warm runtime hit the ElizaOS path).
 *
 * READ (`readEarnedSkillLessons`): semantic RAG from the agent's OWN warmed
 * ElizaOS runtime first, then the keyword store (avatar-keyed, filtered to
 * earned-skill) fills up to the limit, so lessons written while the runtime was
 * cold stay visible once it is warm; with no warm runtime the keyword store
 * alone answers. NEVER lazy-starts.
 *
 * `npc_memories` otherwise stays for the NPC town-liveliness sim ONLY — no old
 * rows are migrated; the fallback simply reuses the same audited store keyed to
 * the avatar, tagged `subtype:'earned-skill'` so reads never blend in NPC banter.
 *
 * FAIL-SOFT EVERYWHERE: a memory failure must NEVER break a teacher turn, a chat
 * turn, or a driver tick — every path returns a degraded result, never throws.
 */

import { agentOrchestrator } from './agent-orchestrator';
import { memoryService } from './memory-service';

/** Metadata namespace — distinct from game-skill ('game-skill'), world
 * ('world-knowledge') and protocol ('protocol-knowledge') knowledge. */
export const EARNED_SKILL_MEMORY_SUBTYPE = 'earned-skill';

/** Which store a write actually landed in (or 'none' on total failure). */
export type EarnedSkillStore = 'eliza' | 'npc_memories' | 'none';

export interface RecordEarnedSkillInput {
  /** platform_agents.id whose warmed ElizaOS runtime backs the write. */
  platformAgentId: string;
  /** The agent's BOUND avatar id — the durable key the lesson hangs off. */
  avatarId: string;
  /** Stable agent id (provenance only — the lesson is avatar-bound). */
  agentId: string;
  buildingId: string;
  teacherName?: string;
  /** The first-person lesson line to persist. */
  lesson: string;
}

export interface ReadEarnedSkillInput {
  platformAgentId: string;
  avatarId: string;
  /** Scope to ONE building's lessons; omit to read across all buildings. */
  buildingId?: string;
  /** Semantic-search query text (embedded for the ElizaOS RAG read). */
  query: string;
  limit?: number;
}

/** A keyword-store row shape (the subset `projectEarnedSkillRows` needs). */
export interface KeywordMemoryRow {
  content: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * PURE — project raw keyword-store rows down to earned-skill lesson strings,
 * filtered to the earned-skill subtype (+ an optional building) and capped at
 * `limit`. Exported for direct unit testing (the store selection around it needs
 * a runtime/DB; this projection does not).
 */
export function projectEarnedSkillRows(
  rows: KeywordMemoryRow[],
  buildingId: string | undefined,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (meta.subtype !== EARNED_SKILL_MEMORY_SUBTYPE) continue;
    if (buildingId && meta.buildingId !== buildingId) continue;
    if (typeof r.content === 'string' && r.content.length > 0) out.push(r.content);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Persist ONE earned-skill lesson. Returns the store it landed in. ElizaOS first
 * (converged, embedded, avatar-keyed); the avatar-keyed keyword store is the
 * fallback (runtime cold OR embed failed). Never lazy-starts; never throws.
 */
export async function recordEarnedSkillLesson(
  input: RecordEarnedSkillInput,
): Promise<EarnedSkillStore> {
  const lesson = input.lesson.trim();
  if (!lesson || !input.avatarId) return 'none';

  // 1. Converge onto the agent's OWN ElizaOS runtime — ONLY if already warm
  //    (getRunningAgentRuntime does NOT lazy-start; the D8 guardrail).
  try {
    if (input.platformAgentId) {
      const rt = agentOrchestrator.getRunningAgentRuntime(input.platformAgentId);
      if (rt) {
        const ok = await rt.recordEarnedSkillMemory({
          avatarId: input.avatarId,
          buildingId: input.buildingId,
          teacherName: input.teacherName,
          lesson,
        });
        if (ok) return 'eliza';
      }
    }
  } catch (err) {
    console.warn(
      '[earned-skill-memory] ElizaOS write failed — falling back to keyword store:',
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Fallback — the audited keyword store, keyed to the durable AVATAR (NOT the
  //    transient body), tagged earned-skill. Strictly better than the pre-slice-3
  //    body-keyed write it replaces (survives idle-despawn).
  try {
    await memoryService.createMemory({
      entityId: input.avatarId,
      entityType: 'avatar',
      targetEntityId: input.buildingId,
      content: lesson,
      importance: 5,
      kind: 'observation',
      metadata: {
        subtype: EARNED_SKILL_MEMORY_SUBTYPE,
        buildingId: input.buildingId,
        teacher: input.teacherName,
        agentId: input.agentId,
      },
    });
    return 'npc_memories';
  } catch (err) {
    console.warn(
      '[earned-skill-memory] keyword fallback write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return 'none';
  }
}

/**
 * PURE — RAG lessons first, then keyword-store lessons, exact-duplicate texts
 * dropped, capped at `limit`.
 */
export function mergeEarnedSkillLessons(
  rag: readonly string[],
  keyword: readonly string[],
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const lesson of [...rag, ...keyword]) {
    if (out.length >= limit) break;
    if (seen.has(lesson)) continue;
    seen.add(lesson);
    out.push(lesson);
  }
  return out;
}

/** Semantic RAG from the warm runtime only (no lazy-start); [] when cold or on failure. */
async function readRuntimeLessons(input: ReadEarnedSkillInput, limit: number): Promise<string[]> {
  try {
    if (!input.platformAgentId) return [];
    const rt = agentOrchestrator.getRunningAgentRuntime(input.platformAgentId);
    if (!rt) return [];
    return await rt.searchEarnedSkillMemories({
      avatarId: input.avatarId,
      query: input.query,
      buildingId: input.buildingId,
      limit,
    });
  } catch (err) {
    console.warn(
      '[earned-skill-memory] ElizaOS read failed — using the keyword store only:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** The avatar-keyed keyword-store rows (unfiltered); [] on failure. */
async function readKeywordRows(input: ReadEarnedSkillInput, limit: number): Promise<KeywordMemoryRow[]> {
  try {
    const rows = await memoryService.getRelevantMemories({
      entityId: input.avatarId,
      targetEntityId: input.buildingId,
      limit: Math.max(limit * 3, 15),
    });
    return rows.map((r) => ({ content: r.content, metadata: r.metadata as Record<string, unknown> | null }));
  } catch (err) {
    console.warn(
      '[earned-skill-memory] keyword read failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Read the agent's recent earned-skill lessons. Semantic RAG from the agent's
 * OWN warmed ElizaOS runtime comes first, and the avatar-keyed keyword store
 * (filtered to earned-skill) fills the rest up to `limit`: a lesson written
 * while the runtime was cold lives ONLY in the keyword store, so a warm read
 * must not hide it (D29, verifier A). Exact-duplicate texts collapse. With no
 * warm runtime, or no RAG hit, the keyword store alone answers, as before. The
 * two stores are read in parallel, so the warm path adds no wait inside the
 * callers' time boxes. Never lazy-starts; never throws (a failed store adds
 * nothing). Returns lesson strings, most relevant first.
 */
export async function readEarnedSkillLessons(
  input: ReadEarnedSkillInput,
): Promise<string[]> {
  const limit = input.limit ?? 5;
  if (!input.avatarId) return [];

  const [rag, rows] = await Promise.all([readRuntimeLessons(input, limit), readKeywordRows(input, limit)]);
  if (rag.length === 0) return projectEarnedSkillRows(rows, input.buildingId, limit);
  // Up to `limit` keyword lessons can repeat a RAG lesson, so project twice the limit.
  return mergeEarnedSkillLessons(rag, projectEarnedSkillRows(rows, input.buildingId, limit * 2), limit);
}
