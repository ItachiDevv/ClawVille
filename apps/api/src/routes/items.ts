import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, pets, petInventory, agents } from '@clawville/database';
import { getBookById, getBooksForBuilding, KNOWLEDGE_BOOKS, BUILDING_MILADY_SKILLS } from '@clawville/shared';
import { miladyGateway } from '../services/milady-gateway';
import { debitNeoTokens } from '../services/neo-token-ledger';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { embedText } from '@clawville/agent-runtime';
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

  if (pet.neoTokens < book.price) {
    throw new HTTPException(400, { message: `Not enough NeoTokens. Need ${book.price}, have ${pet.neoTokens}.` });
  }

  // Deduct tokens via ledger (atomic + audited)
  const { balanceAfter } = await debitNeoTokens({
    petId: pet.id,
    amount: book.price,
    reason: 'buy_book',
    source: 'api',
    metadata: { bookId: book.id, bookName: book.name },
  });

  // Check if already in inventory
  const existingItem = await db.query.petInventory.findFirst({
    where: and(
      eq(petInventory.petId, pet.id),
      eq(petInventory.itemId, result.data.itemId)
    ),
  });

  if (existingItem) {
    await db
      .update(petInventory)
      .set({ quantity: existingItem.quantity + 1 })
      .where(eq(petInventory.id, existingItem.id));
  } else {
    await db.insert(petInventory).values({
      petId: pet.id,
      itemId: result.data.itemId,
      quantity: 1,
    });
  }

  return c.json({
    success: true,
    neoTokens: balanceAfter,
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

    // Stop running agent so next chat message restarts with new knowledge
    await agentOrchestrator.stopAgent(pet.platformAgentId);
  }

  // Phase 2 RAG: embed each new knowledge entry and store in the memories
  // table for vector similarity retrieval. This runs in parallel for speed
  // and is non-blocking — if embedding fails, the JSONB knowledge still
  // works (the KnowledgeProvider falls back to characterConfig).
  if (newKnowledge.length > 0) {
    (async () => {
      try {
        const { v5: uuidv5 } = await import('uuid');
        const KNOWLEDGE_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

        for (const entry of newKnowledge) {
          try {
            const embedding = await embedText(entry);
            const memoryId = uuidv5(`${pet.id}-${entry}`, KNOWLEDGE_NS) as any;
            const agentId = (pet.platformAgentId ?? pet.id) as any;

            // Use raw SQL via drizzle to insert into the memories table
            // since we don't have the ElizaOS runtime available in the route
            await db.execute({
              sql: `INSERT INTO memories (id, type, content, embedding, "agentId", "roomId", "entityId", "createdAt", unique)
                    VALUES ($1, 'knowledge', $2, $3, $4, $5, $6, $7, true)
                    ON CONFLICT (id) DO NOTHING`,
              params: [
                memoryId,
                JSON.stringify({ text: entry, source: 'book', bookId: book.id, bookName: book.name }),
                JSON.stringify(embedding),
                agentId,
                agentId, // roomId = agentId for pet-scoped knowledge
                agentId, // entityId = agentId
                Date.now(),
              ],
            } as any);
          } catch (entryErr) {
            console.warn(`[items/learn] Failed to embed knowledge entry: ${(entryErr as Error).message}`);
          }
        }
        console.log(`[items/learn] Embedded ${newKnowledge.length} knowledge entries for pet ${pet.id}`);
      } catch (err) {
        console.warn(`[items/learn] Knowledge embedding failed (non-blocking): ${(err as Error).message}`);
      }
    })();
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

  // Check if pet has learned all books for this building
  const buildingBooks = getBooksForBuilding(buildingId);
  const inventory = await db.query.petInventory.findMany({
    where: eq(petInventory.petId, pet.id),
  });

  const ownedItemIds = new Set(inventory.map((i) => i.itemId));
  const buildingBookIds = buildingBooks.map((b) => b.id);
  const allLearned = buildingBookIds.every((id) => ownedItemIds.has(id));

  if (!allLearned) {
    return c.json({
      success: false,
      message: `Learn all ${buildingBooks.length} books at this building first`,
      progress: {
        learned: buildingBookIds.filter((id) => ownedItemIds.has(id)).length,
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
