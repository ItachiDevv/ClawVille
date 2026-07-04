import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql, isNull, or, gt } from 'drizzle-orm';
import { db, avatars, avatarInventory, agents, openclawBots, users } from '@clawville/database';
import { getBookById, getBooksForBuilding, KNOWLEDGE_BOOKS, BUILDING_MILADY_SKILLS } from '@clawville/shared';
import { miladyGateway } from '../services/milady-gateway';
import { debitClawTokens } from '../services/claw-token-ledger';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { embedText } from '@clawville/agent-runtime';
import { logEventFromContext } from '../services/event-logger';
import { publishKnowledgeAdded } from '../services/skill-event-bus';
import { npcSimulation } from '../services/npc-simulation';
import type { AppContext } from '../types';
import { z } from 'zod';

export const itemRoutes = new Hono<AppContext>();

itemRoutes.use('*', sessionMiddleware);

// Get items available at a building
itemRoutes.get('/shop/:buildingId', requireAuthOrAgentSession, async (c) => {
  const buildingId = c.req.param('buildingId');
  const books = getBooksForBuilding(buildingId);
  return c.json({ items: books });
});

// Get player's inventory
itemRoutes.get('/inventory', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const userId = identity.userId;

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  const inventory = await db.query.avatarInventory.findMany({
    where: eq(avatarInventory.avatarId, avatar.id),
  });

  // Enrich with book metadata
  const enrichedItems = inventory.map((item) => {
    const book = getBookById(item.itemId);
    return {
      ...item,
      name: book?.name ?? item.itemId,
      description: book?.description ?? '',
      icon: book?.icon ?? '📦',
      isBook: !!book,
    };
  });

  return c.json({ inventory: enrichedItems });
});

// Buy an item
const buySchema = z.object({
  itemId: z.string().min(1).max(50),
});

itemRoutes.post('/buy', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const userId = identity.userId;
  const body = await c.req.json();
  const result = buySchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid item ID' });
  }

  const book = getBookById(result.data.itemId);
  if (!book) {
    throw new HTTPException(404, { message: 'Item not found' });
  }

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  if (avatar.clawTokens < book.price) {
    throw new HTTPException(400, { message: `Not enough ClawTokens. Need ${book.price}, have ${avatar.clawTokens}.` });
  }

  // Debit + inventory insert in a single transaction so if the insert
  // fails, the debit rolls back and the buyer doesn't lose tokens.
  const { balanceAfter } = await db.transaction(async (tx) => {
    // 1. Deduct tokens via ledger (atomic + audited)
    const { balanceAfter: bal } = await debitClawTokens({
      avatarId: avatar.id,
      amount: book.price,
      reason: 'buy_book',
      source: 'api',
      metadata: { bookId: book.id, bookName: book.name },
    }, tx);

    // 2. Check if already in inventory
    const existingItem = await tx.query.avatarInventory.findFirst({
      where: and(
        eq(avatarInventory.avatarId, avatar.id),
        eq(avatarInventory.itemId, result.data.itemId)
      ),
    });

    if (existingItem) {
      await tx
        .update(avatarInventory)
        .set({ quantity: existingItem.quantity + 1 })
        .where(eq(avatarInventory.id, existingItem.id));
    } else {
      await tx.insert(avatarInventory).values({
        avatarId: avatar.id,
        itemId: result.data.itemId,
        quantity: 1,
      });
    }

    return { balanceAfter: bal };
  });

  // Q3 plan §2.6 — emit event so the tutorial-quest `book-worm` engagement
  // validator can verify the purchase actually happened. Was a missing
  // emitter before; without it, the claim endpoint silently rejected
  // legitimate completions ("scaffolding theater" failure mode).
  void logEventFromContext(c, {
    eventType: 'item.purchased',
    userId: userId,
    avatarId: avatar.id,
    payload: {
      itemId: book.id,
      itemName: book.name,
      isBook: true,
      buildingId: book.building,
      pricePaid: book.price,
      balanceAfter,
    },
  });

  return c.json({
    success: true,
    clawTokens: balanceAfter,
    item: { id: book.id, name: book.name, isBook: true },
  });
});

// Learn from a book (consume book, add knowledge to avatar)
const learnSchema = z.object({
  bookId: z.string().min(1).max(50),
});

itemRoutes.post('/learn', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const userId = identity.userId;
  const body = await c.req.json();
  const result = learnSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid book ID' });
  }

  const book = getBookById(result.data.bookId);
  if (!book) {
    throw new HTTPException(404, { message: 'Book not found' });
  }

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  // Check inventory
  const inventoryItem = await db.query.avatarInventory.findFirst({
    where: and(
      eq(avatarInventory.avatarId, avatar.id),
      eq(avatarInventory.itemId, result.data.bookId)
    ),
  });

  if (!inventoryItem || inventoryItem.quantity < 1) {
    throw new HTTPException(400, { message: 'You do not have this book in your inventory' });
  }

  // Merge knowledge entries into characterConfig
  const currentConfig = (avatar.characterConfig as any) ?? {};
  const currentKnowledge: string[] = currentConfig.knowledge ?? [];
  const newKnowledge = book.knowledgeEntries.filter(
    (entry) => !currentKnowledge.includes(entry)
  );
  const mergedKnowledge = [...currentKnowledge, ...newKnowledge];

  const updatedConfig = {
    ...currentConfig,
    knowledge: mergedKnowledge,
  };

  // Update avatar's characterConfig in DB
  const [updatedAvatar] = await db
    .update(avatars)
    .set({
      characterConfig: updatedConfig,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, avatar.id))
    .returning();

  // Also update the platform agent's customization so restart picks up new knowledge
  if (avatar.platformAgentId) {
    await db
      .update(agents)
      .set({
        customization: updatedConfig,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, avatar.platformAgentId));

    // Phase 2 RAG: embed new knowledge entries via the ElizaOS runtime and
    // store as searchable memories. Uses runtime.createMemory() which the
    // framework guarantees handles the memory → embeddings table split.
    //
    // We get the runtime BEFORE stopping it, embed the entries, THEN stop.
    // Non-blocking on individual entry failures — JSONB fallback works.
    if (newKnowledge.length > 0) {
      try {
        const runtime = await agentOrchestrator.ensureAgentRuntime(
          avatar.platformAgentId,
          userId,
        );
        if (runtime) {
          const { v5: uuidv5 } = await import('uuid');
          // Distinct namespace from ROOM_NAMESPACE to avoid UUID collisions
          const KNOWLEDGE_NS = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
          const agentId = avatar.platformAgentId as any;

          for (const entry of newKnowledge) {
            try {
              const embedding = await embedText(entry);
              const memoryId = uuidv5(`knowledge:${avatar.id}:${entry}`, KNOWLEDGE_NS);
              const elizaRuntime = runtime.getElizaRuntime();

              if (elizaRuntime?.createMemory) {
                await elizaRuntime.createMemory(
                  {
                    id: memoryId,
                    agentId,
                    entityId: agentId,
                    roomId: agentId,
                    content: { text: entry, source: 'book' } as any,
                    embedding,
                    createdAt: Date.now(),
                    metadata: { type: 'custom', subtype: 'knowledge', source: 'book', bookId: book.id },
                  },
                  'knowledge',
                  true, // unique — idempotent on re-learn
                );
              }
            } catch (entryErr) {
              console.warn(`[items/learn] Failed to embed entry: ${(entryErr as Error).message}`);
            }
          }
          console.log(`[items/learn] Embedded ${newKnowledge.length} knowledge entries for avatar ${avatar.id}`);
        }
      } catch (err) {
        console.warn(`[items/learn] Knowledge embedding failed (non-blocking): ${(err as Error).message}`);
      }
    }

    // Stop running agent so next chat message restarts with new knowledge
    await agentOrchestrator.stopAgent(avatar.platformAgentId);
  }

  // Remove book from inventory (decrement or delete)
  if (inventoryItem.quantity > 1) {
    await db
      .update(avatarInventory)
      .set({ quantity: inventoryItem.quantity - 1 })
      .where(eq(avatarInventory.id, inventoryItem.id));
  } else {
    await db.delete(avatarInventory).where(eq(avatarInventory.id, inventoryItem.id));
  }

  // Q3 plan §2.6 — emit event so the tutorial-quest `agent-scholar`
  // engagement validator can verify knowledge was actually merged. Counts
  // only when newKnowledge.length > 0 (re-reading a book that contributed
  // nothing new doesn't credit the quest).
  if (newKnowledge.length > 0) {
    void logEventFromContext(c, {
      eventType: 'book.read',
      userId: userId,
      avatarId: avatar.id,
      payload: {
        bookId: book.id,
        bookName: book.name,
        buildingId: book.building,
        newKnowledgeCount: newKnowledge.length,
        totalKnowledge: mergedKnowledge.length,
      },
    });

    // Auto-install push (2026-05-03): notify any active agent sessions
    // belonging to this user that new knowledge has been added. The
    // agent's harness should listen for `event: knowledge_added` on its
    // SSE stream and pull the matching SKILL.md to its local skills
    // folder. The skillUrl is the session-authed mirror — fetching it
    // with the bot's Bearer sessionId proves ownership server-side.
    void (async () => {
      try {
        const activeBots = await db
          .select({ agentId: openclawBots.agentId })
          .from(openclawBots)
          .where(
            and(
              eq(openclawBots.userId, userId),
              or(
                isNull(openclawBots.sessionExpiresAt),
                gt(openclawBots.sessionExpiresAt, sql`now()`),
              ),
              isNull(openclawBots.sessionSweptAt),
            ),
          );
        // D7 slice-1: durable, agent-scoped, BEARER-FREE knowledge event so a
        // briefly-disconnected agent can REPLAY the knowledge it gained (the RAM
        // push below is live-only; the `book.read` row is human-scoped with no
        // agent_id). NO skillUrl/toolsUrl here — those embed the raw session
        // bearer and are session-specific; on replay the agent rebuilds them from
        // its CURRENT session. One row per active agent bound to this user.
        for (const b of activeBots) {
          void logEventFromContext(c, {
            eventType: 'agent.knowledge_added',
            userId,
            avatarId: avatar.id,
            agentId: b.agentId,
            buildingId: book.building,
            payload: {
              source: 'book',
              buildingId: book.building,
              skillName: `clawville-${book.building}`,
              suggestedFilename: `clawville-${book.building}.md`,
              sourceName: book.name,
              knowledgeEntries: newKnowledge.slice(0, 8),
            },
          });
        }
        const activeSessionIds = npcSimulation.findActiveSessionsByAgentIds(
          activeBots.map((b) => b.agentId),
        );
        for (const sid of activeSessionIds) {
          publishKnowledgeAdded(sid, {
            type: 'knowledge_added',
            source: 'book',
            buildingId: book.building,
            skillName: `clawville-${book.building}`,
            suggestedFilename: `clawville-${book.building}.md`,
            sourceName: book.name,
            skillUrl: `/api/agent/${sid}/skills/${book.building}/skill.md`,
            toolsUrl: `/api/agent/${sid}/skills/${book.building}/tools.json`,
            toolsFilename: `clawville-${book.building}.tools.json`,
            knowledgeEntries: newKnowledge.slice(0, 8),
            emittedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn(`[items/learn] Failed to publish knowledge_added: ${(err as Error).message}`);
      }
    })();
  }

  return c.json({
    success: true,
    learnedBook: book.name,
    newKnowledgeCount: newKnowledge.length,
    totalKnowledge: mergedKnowledge.length,
    avatar: updatedAvatar,
  });
});

// Export building knowledge as a Milady AI skill
itemRoutes.post('/export-skill/:buildingId', requireAuth, async (c) => {
  const user = c.get('user');
  const buildingId = c.req.param('buildingId');

  const skillDef = BUILDING_MILADY_SKILLS[buildingId];
  if (!skillDef) {
    throw new HTTPException(404, { message: 'No skill available for this building' });
  }

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No active avatar found' });
  }

  // Check if avatar has learned all books for this building by verifying
  // that the avatar's characterConfig.knowledge contains at least one entry
  // from each book. (Books are consumed from inventory when learned, so
  // checking inventory would fail for avatars that already read the books.)
  const buildingBooks = getBooksForBuilding(buildingId);
  const avatarKnowledge = new Set<string>(
    (avatar.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? []
  );
  const allLearned = buildingBooks.every((book) =>
    book.knowledgeEntries.some((entry) => avatarKnowledge.has(entry))
  );

  if (!allLearned) {
    const learnedCount = buildingBooks.filter((book) =>
      book.knowledgeEntries.some((entry) => avatarKnowledge.has(entry))
    ).length;
    return c.json({
      success: false,
      message: `Learn all ${buildingBooks.length} books at this building first`,
      progress: {
        learned: learnedCount,
        total: buildingBooks.length,
      },
    }, 400);
  }

  // Extract knowledge entries from avatar's characterConfig
  const characterConfig = avatar.characterConfig as { knowledge?: string[] } | null;
  const knowledge = characterConfig?.knowledge ?? [];

  const result = await miladyGateway.exportSkill(buildingId, knowledge);

  return c.json({
    success: result.success,
    skillId: result.skillId,
    skillName: skillDef.name,
    skillDescription: skillDef.description,
    miladyConnected: miladyGateway.isAvailable(),
  });
});
