import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, sql, isNull, or, gt } from 'drizzle-orm';
import { db, avatars, avatarInventory, agents, agentBots, users } from '@clawville/database';
import { getBookById, getBooksForBuilding, KNOWLEDGE_BOOKS, BUILDING_MILADY_SKILLS } from '@clawville/shared';
import { miladyGateway } from '../services/milady-gateway';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import { isGuestUser } from '../middleware/require-non-guest';
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

  // ── GUEST DEMO SETTLEMENT (founder ruling 2026-07-06; mirrors the cove) ──────
  // A guest is a REAL Lucia user + avatar + a 100-CT DEMO soft-balance that
  // settles OFF the real ledger. This SUPERSEDES the 2026-07-07 guest-403 on
  // `/buy` (which `requireNonGuestIdentity` enforced): guests now BUY on demo CT,
  // exactly like they PLAY the cove card games on a demo session balance. Like the
  // cove (`cove-blackjack.ts` getSubject → guest tier), a guest here NEVER touches
  // `claw-token-ledger`, the house treasury, or leaderboard/quest events / XP —
  // those are the REAL economy. The demo balance IS `avatars.clawTokens`, which for
  // a guest is 100% SOFT (seeded `clawTokens == softBalance == 100`, bought/earned
  // = 0, and every guest EARN/on-ramp path is gated off-ledger, so the vCLAW
  // buckets stay soft-only). We debit it with a raw, CHECK-safe, row-locked UPDATE
  // (decrement `claw_tokens` AND `soft_balance` together so the
  // `avatars_vclaw_balance_sum` CHECK never sees a torn state) and write NO
  // `claw_token_transactions` row. A connected/hosted AGENT is NEVER a guest
  // (`identity.kind === 'agent'`, Rule E5), so the real-CT agent path below is
  // structurally unreachable from this branch.
  const isGuest = identity.kind === 'user' && (await isGuestUser(userId));
  if (isGuest) {
    const demo = await db.transaction(async (tx) => {
      // Row-lock the guest avatar and read the SOFT demo balance under the lock
      // (mirrors the ledger's FOR UPDATE read so two concurrent guest buys on the
      // same avatar can't double-spend the demo balance).
      const [row] = await tx.execute<{ claw_tokens: number | string; soft_balance: number | string }>(
        sql`SELECT claw_tokens, soft_balance FROM avatars WHERE id = ${avatar.id} FOR UPDATE`,
      );
      if (!row) throw new HTTPException(404, { message: 'No avatar found' });
      const total = Number(row.claw_tokens);
      const soft = Number(row.soft_balance);
      if (total < book.price) {
        return { insufficient: true as const, total };
      }
      // Demo debit — burn from the SOFT bucket only (a guest is soft-only).
      // Decrement `claw_tokens` AND `soft_balance` in ONE update so the vCLAW
      // CHECK holds. NO ledger row, NO house-treasury credit: this is demo money,
      // off the real ledger, and must never move supply into the real economy.
      const balanceAfter = total - book.price;
      await tx
        .update(avatars)
        .set({ clawTokens: balanceAfter, softBalance: soft - book.price })
        .where(eq(avatars.id, avatar.id));

      // Grant the inventory row — scoped to the guest's OWN avatar. Guests have a
      // real `avatars` row and `avatar_inventory` is strictly per-avatar (nothing
      // shared or global), so this is harmless demo state. Identical insert/
      // increment to the real path below.
      const existingItem = await tx.query.avatarInventory.findFirst({
        where: and(
          eq(avatarInventory.avatarId, avatar.id),
          eq(avatarInventory.itemId, result.data.itemId),
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
      return { insufficient: false as const, balanceAfter };
    });

    if (demo.insufficient) {
      // Same 400 as the real path, plus a STRING `code` the client branches on
      // (the global onError serializes HTTPException with a NUMERIC `code`, so we
      // return a coded JSON here for a clean UI branch — see shop-overlay.tsx).
      return c.json(
        {
          error: `Not enough demo ClawTokens. Need ${book.price}, have ${demo.total}.`,
          code: 'insufficient_ct',
        },
        400,
      );
    }

    // NO `item.purchased` event and NO XP for guests — demo play feeds NOTHING
    // persistent (mirrors the cove guest tier). The `item.purchased` emitter below
    // feeds the tutorial-quest validators (`quests.ts`), which a guest can never
    // claim (real-CT rewards are guest-403'd), so emitting it would be dead state.
    return c.json({
      success: true,
      clawTokens: demo.balanceAfter,
      item: { id: book.id, name: book.name, isBook: true },
      demo: true,
    });
  }

  // ── REAL-CT SETTLEMENT (non-guest user OR connected/hosted agent) — UNCHANGED ──
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

    // 1b. T0 fee routing (2026-07-07): book revenue → house treasury, IN THIS
    // SAME tx as the debit + inventory insert (net-neutral supply — the price
    // moves player→treasury instead of burning). Buyer-side amount UNCHANGED.
    // A null treasury (unavailable) degrades to the pre-T0 burn.
    if (Number.isInteger(book.price) && book.price > 0) {
      const treasuryId = await getHouseTreasuryAvatarId();
      if (treasuryId) {
        await creditClawTokens(
          {
            avatarId: treasuryId,
            amount: book.price,
            reason: 'house_fee_book_purchase',
            source: 'system',
            metadata: { bookId: book.id, buyerAvatarId: avatar.id },
          },
          tx,
        );
      } else {
        console.error(
          `[items] house treasury unavailable — ${book.price} CT book purchase burned (pre-T0 behavior) for book ${book.id}`,
        );
      }
    }

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
          .select({ agentId: agentBots.agentId })
          .from(agentBots)
          .where(
            and(
              eq(agentBots.userId, userId),
              or(
                isNull(agentBots.sessionExpiresAt),
                gt(agentBots.sessionExpiresAt, sql`now()`),
              ),
              isNull(agentBots.sessionSweptAt),
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
