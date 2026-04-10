/**
 * Memory service for NPC/avatar conversation memory.
 * Stores conversation summaries with importance scoring.
 * Uses keyword-based relevance (no vector DB dependency).
 */

import { db, npcMemories } from '@clawville/database';
import { eq, and, desc, sql } from 'drizzle-orm';

export interface CreateMemoryInput {
  entityId: string;
  entityType: 'npc' | 'avatar';
  targetEntityId?: string;
  content: string;
  importance: number;
  kind: 'conversation' | 'observation' | 'reflection';
  metadata?: Record<string, any>;
}

export class MemoryService {
  async createMemory(input: CreateMemoryInput) {
    const [memory] = await db.insert(npcMemories).values({
      entityId: input.entityId,
      entityType: input.entityType,
      targetEntityId: input.targetEntityId,
      content: input.content,
      importance: Math.max(0, Math.min(9, input.importance)),
      kind: input.kind,
      metadata: input.metadata,
    }).returning();
    return memory;
  }

  /**
   * Get relevant memories for an entity, optionally filtered by target.
   * Ranked by recency * importance.
   */
  async getRelevantMemories(opts: {
    entityId: string;
    targetEntityId?: string;
    limit?: number;
  }) {
    const limit = opts.limit ?? 5;

    const conditions = [eq(npcMemories.entityId, opts.entityId)];
    if (opts.targetEntityId) {
      conditions.push(eq(npcMemories.targetEntityId, opts.targetEntityId));
    }

    const memories = await db.query.npcMemories.findMany({
      where: and(...conditions),
      orderBy: [desc(npcMemories.importance), desc(npcMemories.createdAt)],
      limit,
    });

    return memories;
  }

  /**
   * Summarize a conversation into a first-person memory summary.
   * Uses a simple fallback (no LLM dependency required).
   */
  async summarizeConversation(
    entityName: string,
    messages: Array<{ npcId: string; npcName: string; text: string }>
  ): Promise<string> {
    const otherNames = [...new Set(messages.filter(m => m.npcName !== entityName).map(m => m.npcName))];
    return `I had a conversation with ${otherNames.join(' and ')}.`;
  }

  /**
   * Score importance using keyword heuristics.
   */
  scoreImportance(content: string): number {
    const lower = content.toLowerCase();
    const keywords: [string, number][] = [
      ['first time', 7],
      ['first meeting', 7],
      ['battle', 8],
      ['fight', 7],
      ['gift', 6],
      ['secret', 8],
      ['treasure', 7],
      ['friend', 6],
      ['enemy', 7],
      ['promise', 7],
      ['remember', 6],
      ['important', 6],
      ['danger', 7],
      ['help', 5],
      ['funny', 4],
      ['boring', 3],
    ];

    let maxScore = 5; // default
    for (const [keyword, score] of keywords) {
      if (lower.includes(keyword) && score > maxScore) {
        maxScore = score;
      }
    }
    return maxScore;
  }

  /**
   * Cleanup old memories (keep last 14 days).
   */
  async cleanup(maxAgeDays = 14) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    await db.delete(npcMemories)
      .where(sql`${npcMemories.createdAt} < ${cutoff}`);
  }
}

export const memoryService = new MemoryService();
