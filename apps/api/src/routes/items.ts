import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, pets, petInventory, agents } from '@legacyapp/database';
import { getBookById, getBooksForBuilding, KNOWLEDGE_BOOKS } from '@legacyapp/shared';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { agentOrchestrator } from '../services/agent-orchestrator';
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

  // Deduct tokens
  const [updatedPet] = await db
    .update(pets)
    .set({
      clawTokens: pet.clawTokens - book.price,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, pet.id))
    .returning();

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
    clawTokens: updatedPet.clawTokens,
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
