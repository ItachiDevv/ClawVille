import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, avatars, avatarInventory, agents } from '@legacyapp/database';
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

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
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

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  if (avatar.clawTokens < book.price) {
    throw new HTTPException(400, { message: `Not enough ClawTokens. Need ${book.price}, have ${avatar.clawTokens}.` });
  }

  // Deduct tokens
  const [updatedPet] = await db
    .update(avatars)
    .set({
      clawTokens: avatar.clawTokens - book.price,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, avatar.id))
    .returning();

  // Check if already in inventory
  const existingItem = await db.query.avatarInventory.findFirst({
    where: and(
      eq(avatarInventory.avatarId, avatar.id),
      eq(avatarInventory.itemId, result.data.itemId)
    ),
  });

  if (existingItem) {
    await db
      .update(avatarInventory)
      .set({ quantity: existingItem.quantity + 1 })
      .where(eq(avatarInventory.id, existingItem.id));
  } else {
    await db.insert(avatarInventory).values({
      avatarId: avatar.id,
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

// Learn from a book (consume book, add knowledge to avatar)
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

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
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
  const [updatedPet] = await db
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

  return c.json({
    success: true,
    learnedBook: book.name,
    newKnowledgeCount: newKnowledge.length,
    totalKnowledge: mergedKnowledge.length,
    avatar: updatedPet,
  });
});
