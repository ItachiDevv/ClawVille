import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, pets, petInventory, agents } from '@clawville/database';
import { getBookById, getBooksForBuilding, KNOWLEDGE_BOOKS, BUILDING_MILADY_SKILLS } from '@clawville/shared';
import { miladyGateway } from '../services/milady-gateway';
import { debitClawTokens } from '../services/claw-token-ledger';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { embedText } from '@clawville/agent-runtime';
import { logEventFromContext } from '../services/event-logger';
import type { AppContext } from '../types';
import { z } from 'zod';

export const itemRoutes = new Hono<AppContext>();

itemRoutes.use('*', sessionMiddleware);

// Get items available at a building
itemRoutes.get('/shop/:buildingId', requireAuth, async (c) => {
  const buildingId = c.req.param('buildingId');
  const books = getBooksForBuilding(buildingId);
  return c.json({ items: books });
});

// Get player's inventory
itemRoutes.get('/inventory', requireAuth, async (c) => {
  const user = c.get('user');

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'No pet found' });
  }

  const inventory = await db.query.petInventory.findMany({
    where: eq(petInventory.petId, pet.id),
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

itemRoutes.post('/buy', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = buySchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid item ID' });
  }

  const book = getBookById(result.data.itemId);
  if (!book) {
    throw new HTTPException(404, { message: 'Item not found' });
  }

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'No pet found' });
  }

  if (pet.clawTokens < book.price) {
    throw new HTTPException(400, { message: `Not enough ClawTokens. Need ${book.price}, have ${pet.clawTokens}.` });
  }

  // Debit + inventory insert in a single transaction so if the insert
  // fails, the debit rolls back and the buyer doesn't lose tokens.
  const { balanceAfter } = await db.transaction(async (tx) => {
    // 1. Deduct tokens via ledger (atomic + audited)
    const { balanceAfter: bal } = await debitClawTokens({
      petId: pet.id,
      amount: book.price,
      reason: 'buy_book',
      source: 'api',
      metadata: { bookId: book.id, bookName: book.name },
    }, tx);

    // 2. Check if already in inventory
    const existingItem = await tx.query.petInventory.findFirst({
      where: and(
        eq(petInventory.petId, pet.id),
        eq(petInventory.itemId, result.data.itemId)
      ),
    });

    if (existingItem) {
      await tx
        .update(petInventory)
        .set({ quantity: existingItem.quantity + 1 })
        .where(eq(petInventory.id, existingItem.id));
    } else {
      await tx.insert(petInventory).values({
        petId: pet.id,
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
    userId: user.id,
    petId: pet.id,
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
    item: { id: book.id, name: book.name },
  });
});

// Learn from a book (consume book, add knowledge to pet)
const learnSchema = z.object({
  bookId: z.string().min(1).max(50),
});

itemRoutes.post('/learn', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const result = learnSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid book ID' });
  }

  const book = getBookById(result.data.bookId);
  if (!book) {
    throw new HTTPException(404, { message: 'Book not found' });
  }

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'No pet found' });
  }

  // Check inventory
  const inventoryItem = await db.query.petInventory.findFirst({
    where: and(
      eq(petInventory.petId, pet.id),
      eq(petInventory.itemId, result.data.bookId)
    ),
  });

  if (!inventoryItem || inventoryItem.quantity < 1) {
    throw new HTTPException(400, { message: 'You do not have this book in your inventory' });
  }

  // Merge knowledge entries into characterConfig
  const currentConfig = (pet.characterConfig as any) ?? {};
  const currentKnowledge: string[] = currentConfig.knowledge ?? [];
  const newKnowledge = book.knowledgeEntries.filter(
    (entry) => !currentKnowledge.includes(entry)
  );
  const mergedKnowledge = [...currentKnowledge, ...newKnowledge];

  const updatedConfig = {
    ...currentConfig,
    knowledge: mergedKnowledge,
  };

  // Update pet's characterConfig in DB
  const [updatedPet] = await db
    .update(pets)
    .set({
      characterConfig: updatedConfig,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, pet.id))
    .returning();

  // Also update the platform agent's customization so restart picks up new knowledge
  if (pet.platformAgentId) {
    await db
      .update(agents)
      .set({
        customization: updatedConfig,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, pet.platformAgentId));

    // Phase 2 RAG: embed new knowledge entries via the ElizaOS runtime and
    // store as searchable memories. Uses runtime.createMemory() which the
    // framework guarantees handles the memory → embeddings table split.
    //
    // We get the runtime BEFORE stopping it, embed the entries, THEN stop.
    // Non-blocking on individual entry failures — JSONB fallback works.
    if (newKnowledge.length > 0) {
      try {
        const runtime = await agentOrchestrator.ensureAgentRuntime(
          pet.platformAgentId,
          user.id,
        );
        if (runtime) {
          const { v5: uuidv5 } = await import('uuid');
          // Distinct namespace from ROOM_NAMESPACE to avoid UUID collisions
          const KNOWLEDGE_NS = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
          const agentId = pet.platformAgentId as any;

          for (const entry of newKnowledge) {
            try {
              const embedding = await embedText(entry);
              const memoryId = uuidv5(`knowledge:${pet.id}:${entry}`, KNOWLEDGE_NS);
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
          console.log(`[items/learn] Embedded ${newKnowledge.length} knowledge entries for pet ${pet.id}`);
        }
      } catch (err) {
        console.warn(`[items/learn] Knowledge embedding failed (non-blocking): ${(err as Error).message}`);
      }
    }

    // Stop running agent so next chat message restarts with new knowledge
    await agentOrchestrator.stopAgent(pet.platformAgentId);
  }

  // Remove book from inventory (decrement or delete)
  if (inventoryItem.quantity > 1) {
    await db
      .update(petInventory)
      .set({ quantity: inventoryItem.quantity - 1 })
      .where(eq(petInventory.id, inventoryItem.id));
  } else {
    await db.delete(petInventory).where(eq(petInventory.id, inventoryItem.id));
  }

  // Q3 plan §2.6 — emit event so the tutorial-quest `agent-scholar`
  // engagement validator can verify knowledge was actually merged. Counts
  // only when newKnowledge.length > 0 (re-reading a book that contributed
  // nothing new doesn't credit the quest).
  if (newKnowledge.length > 0) {
    void logEventFromContext(c, {
      eventType: 'book.read',
      userId: user.id,
      petId: pet.id,
      payload: {
        bookId: book.id,
        bookName: book.name,
        buildingId: book.building,
        newKnowledgeCount: newKnowledge.length,
        totalKnowledge: mergedKnowledge.length,
      },
    });
  }

  return c.json({
    success: true,
    learnedBook: book.name,
    newKnowledgeCount: newKnowledge.length,
    totalKnowledge: mergedKnowledge.length,
    pet: updatedPet,
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

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'No active pet found' });
  }

  // Check if pet has learned all books for this building by verifying
  // that the pet's characterConfig.knowledge contains at least one entry
  // from each book. (Books are consumed from inventory when learned, so
  // checking inventory would fail for pets that already read the books.)
  const buildingBooks = getBooksForBuilding(buildingId);
  const petKnowledge = new Set<string>(
    (pet.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? []
  );
  const allLearned = buildingBooks.every((book) =>
    book.knowledgeEntries.some((entry) => petKnowledge.has(entry))
  );

  if (!allLearned) {
    const learnedCount = buildingBooks.filter((book) =>
      book.knowledgeEntries.some((entry) => petKnowledge.has(entry))
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

  // Extract knowledge entries from pet's characterConfig
  const characterConfig = pet.characterConfig as { knowledge?: string[] } | null;
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
