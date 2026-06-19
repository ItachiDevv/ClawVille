import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, desc, inArray, isNull } from 'drizzle-orm';
import { db, avatars, avatarInventory, publishedSkills, skillUpvotes, agents } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  resolveAgentSession,
  AGENT_SESSION_HEADER,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { npcSimulation } from '../services/npc-simulation';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { embedText } from '@clawville/agent-runtime';
import { z } from 'zod';

export const marketplaceRoutes = new Hono<ActivityAuthContext>();

// Run `sessionMiddleware` group-wide so `c.get('user')` is populated for the
// human-cookie path BEFORE `requireAuthOrAgentSession` (on buy/install) and before
// `resolveAuthedAvatarId` (on publish/upvote) read it — `requireAuthOrAgentSession`
// does NOT validate the cookie itself, it relies on this upstream pass (matches the
// exchange/bounties group middleware). Reads that branch on an OPTIONAL `user` also
// get it. Idempotent with any per-handler `sessionMiddleware`.
marketplaceRoutes.use('*', sessionMiddleware);

// FEATURE_GATE: skill_marketplace — GRADUATED / UN-PAUSED 2026-06-19.
// The founder explicitly un-paused peer skill commerce (Bazaar / Marketplace /
// Auctions) — an OVERRIDE of the 2026-04-21 pause. The 503 write-gate is REMOVED.
// The Marketplace is the FREE tier (price 0): publish + upvote + buy + install do
// not move CT, so there is no settlement here — but the writes still gain agent
// parity so a connected/hosted agent publishes/installs AS ITS OWN avatar (Rule
// E5). Anonymous-claw publish/upvote (the `clawSessionId` path) is PRESERVED
// unchanged. See PLAN.md §2 Phase C + GameFeatures.md. Retained as an audit marker.

// Helper: get the acting avatar (full row) from the dual-identity middleware
// (`requireAuthOrAgentSession` → `identity.avatarId`). Re-loads by THAT id, never
// a body-supplied one — works for a Lucia human OR a connected/hosted agent.
async function getActingAvatar(c: { get: (k: 'identity') => ActivityAuthContext['Variables']['identity'] }) {
  const identity = c.get('identity');
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, identity.avatarId),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No avatar found' });
  return avatar;
}

/**
 * Resolve the acting AVATAR for the publish/upvote path, which must keep three
 * mutually-exclusive identities working: (1) a Lucia human, (2) a connected/hosted
 * AGENT via `X-Clawville-Agent-Session` (Phase C agent parity), and (3) an
 * anonymous browser CLAW via `clawSessionId` (preserved). Returns the resolved
 * `avatars.id` for (1)/(2), or `null` when neither a human cookie nor a live agent
 * session is present (the caller then falls back to the anon-claw branch). Never
 * trusts a body-supplied avatarId; the agent path re-validates the session through
 * the SAME fail-closed `resolveAgentSession` gate the rest of the surface uses, so
 * an expired/unbound agent resolves to null (→ anon-claw branch or 401), never a
 * spoofed avatar.
 */
async function resolveAuthedAvatarId(c: {
  get: (k: 'user') => { id: string } | null | undefined;
  req: { header: (name: string) => string | undefined };
}): Promise<string | null> {
  const user = c.get('user');
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    return avatar?.id ?? null;
  }
  const sessionId = c.req.header(AGENT_SESSION_HEADER);
  if (sessionId) {
    const resolved = await resolveAgentSession(sessionId);
    // Only a session bound to an active avatar counts — an unbound/expired agent
    // (resolved null avatarId) is NOT silently demoted to an anon claw.
    if (resolved && resolved.avatarId) return resolved.avatarId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /publish — publish a skill to the marketplace
// Supports both authenticated avatars and anonymous claws
// ---------------------------------------------------------------------------
const publishSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(200),
  skillMd: z.string().min(1),
  locationId: z.string().max(50).optional(),
  clawSessionId: z.string().optional(),
});

marketplaceRoutes.post('/publish', sessionMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = publishSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request: ' + parsed.error.issues.map((i) => i.message).join(', ') });
  }

  const { name, description, skillMd, locationId, clawSessionId } = parsed.data;

  // Anonymous claw publishing — PRESERVED unchanged (Phase C). A browser claw
  // explicitly passes its `clawSessionId`; it has no persistent avatar, so it
  // publishes under its claw name/species with `authorAvatarId = null`.
  if (clawSessionId) {
    const claw = npcSimulation.getBrowserClaw(clawSessionId);
    if (!claw) {
      throw new HTTPException(404, { message: 'Claw session not found' });
    }

    const [skill] = await db
      .insert(publishedSkills)
      .values({
        authorClawName: claw.config.name,
        authorClawSpecies: claw.config.species,
        locationId: locationId ?? null,
        name,
        description,
        skillMd,
        price: 0,
      })
      .returning();

    return c.json({
      skill: {
        id: skill.id,
        authorAvatarId: null,
        authorAvatarName: claw.config.name,
        authorSpecies: claw.config.species,
        authorClawName: claw.config.name,
        authorClawSpecies: claw.config.species,
        locationId: skill.locationId,
        name: skill.name,
        description: skill.description,
        upvoteCount: skill.upvoteCount,
        downloadCount: skill.downloadCount,
        hasUpvoted: false,
        createdAt: skill.createdAt.toISOString(),
      },
    });
  }

  // Authenticated-avatar publishing — Lucia human OR connected/hosted agent
  // (Phase C agent parity). The avatar binds to `identity.avatarId` via the dual
  // resolver; an unbound/expired agent (and a no-cookie request) gets a clean 401,
  // never a guest/anon demotion.
  const authedAvatarId = await resolveAuthedAvatarId(c);
  if (!authedAvatarId) {
    throw new HTTPException(401, { message: 'Authentication or claw session required' });
  }
  const avatar = await db.query.avatars.findFirst({ where: eq(avatars.id, authedAvatarId) });
  if (!avatar) {
    throw new HTTPException(404, { message: 'No avatar found' });
  }

  const [skill] = await db
    .insert(publishedSkills)
    .values({
      authorAvatarId: avatar.id,
      locationId: locationId ?? null,
      name,
      description,
      skillMd,
      price: 0,
    })
    .returning();

  return c.json({
    skill: {
      id: skill.id,
      authorAvatarId: skill.authorAvatarId,
      authorAvatarName: avatar.name,
      authorSpecies: avatar.species,
      locationId: skill.locationId,
      name: skill.name,
      description: skill.description,
      upvoteCount: skill.upvoteCount,
      downloadCount: skill.downloadCount,
      hasUpvoted: false,
      createdAt: skill.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /skills — browse published skills with optional location filter
// Works for both authenticated and anonymous users
// ---------------------------------------------------------------------------
marketplaceRoutes.get('/skills', sessionMiddleware, async (c) => {
  const user = c.get('user');
  const sort = c.req.query('sort') || 'newest';
  const locationId = c.req.query('locationId');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
  const offset = (page - 1) * limit;

  let orderBy;
  switch (sort) {
    case 'upvotes':
      orderBy = desc(publishedSkills.upvoteCount);
      break;
    case 'downloads':
      orderBy = desc(publishedSkills.downloadCount);
      break;
    default:
      orderBy = desc(publishedSkills.createdAt);
  }

  // Build where condition
  const conditions = locationId
    ? eq(publishedSkills.locationId, locationId)
    : undefined;

  // Skills with avatar authors (left join so we get claw-authored skills too)
  const allSkills = await db
    .select({
      id: publishedSkills.id,
      authorAvatarId: publishedSkills.authorAvatarId,
      authorClawName: publishedSkills.authorClawName,
      authorClawSpecies: publishedSkills.authorClawSpecies,
      locationId: publishedSkills.locationId,
      name: publishedSkills.name,
      description: publishedSkills.description,
      upvoteCount: publishedSkills.upvoteCount,
      downloadCount: publishedSkills.downloadCount,
      createdAt: publishedSkills.createdAt,
      authorAvatarName: avatars.name,
      authorSpecies: avatars.species,
    })
    .from(publishedSkills)
    .leftJoin(avatars, eq(publishedSkills.authorAvatarId, avatars.id))
    .where(conditions)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  // Check upvotes for current user's avatar (if authenticated)
  let upvotedSet = new Set<string>();
  if (user) {
    const avatar = await db.query.avatars.findFirst({ where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)) });
    if (avatar) {
      const skillIds = allSkills.map((s: any) => s.id);
      if (skillIds.length > 0) {
        const upvotes = await db
          .select({ skillId: skillUpvotes.skillId })
          .from(skillUpvotes)
          .where(
            and(
              eq(skillUpvotes.avatarId, avatar.id),
              inArray(skillUpvotes.skillId, skillIds)
            )
          );
        upvotedSet = new Set(upvotes.map((u: { skillId: string }) => u.skillId));
      }
    }
  }

  const skills = allSkills.map((s: any) => ({
    id: s.id,
    authorAvatarName: s.authorAvatarName ?? s.authorClawName ?? 'Unknown',
    authorSpecies: s.authorSpecies ?? s.authorClawSpecies ?? 'cat',
    authorClawName: s.authorClawName,
    authorClawSpecies: s.authorClawSpecies,
    locationId: s.locationId,
    name: s.name,
    description: s.description,
    upvoteCount: s.upvoteCount,
    downloadCount: s.downloadCount,
    hasUpvoted: upvotedSet.has(s.id),
    createdAt: s.createdAt.toISOString(),
  }));

  return c.json({ skills, page, limit });
});

// ---------------------------------------------------------------------------
// GET /skills/:id — single skill detail
// ---------------------------------------------------------------------------
marketplaceRoutes.get('/skills/:id', sessionMiddleware, async (c) => {
  const user = c.get('user');
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const rows = await db
    .select({
      id: publishedSkills.id,
      authorAvatarId: publishedSkills.authorAvatarId,
      authorClawName: publishedSkills.authorClawName,
      authorClawSpecies: publishedSkills.authorClawSpecies,
      locationId: publishedSkills.locationId,
      name: publishedSkills.name,
      description: publishedSkills.description,
      skillMd: publishedSkills.skillMd,
      upvoteCount: publishedSkills.upvoteCount,
      downloadCount: publishedSkills.downloadCount,
      createdAt: publishedSkills.createdAt,
      authorAvatarName: avatars.name,
      authorSpecies: avatars.species,
    })
    .from(publishedSkills)
    .leftJoin(avatars, eq(publishedSkills.authorAvatarId, avatars.id))
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const s = rows[0];
  let hasUpvoted = false;

  if (user) {
    const avatar = await db.query.avatars.findFirst({ where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)) });
    if (avatar) {
      const [upvote] = await db
        .select({ id: skillUpvotes.id })
        .from(skillUpvotes)
        .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.avatarId, avatar.id)))
        .limit(1);
      hasUpvoted = !!upvote;
    }
  }

  return c.json({
    skill: {
      id: s.id,
      authorAvatarId: s.authorAvatarId,
      authorAvatarName: s.authorAvatarName ?? s.authorClawName ?? 'Unknown',
      authorSpecies: s.authorSpecies ?? s.authorClawSpecies ?? 'cat',
      authorClawName: s.authorClawName,
      authorClawSpecies: s.authorClawSpecies,
      locationId: s.locationId,
      name: s.name,
      description: s.description,
      skillMd: s.skillMd,
      upvoteCount: s.upvoteCount,
      downloadCount: s.downloadCount,
      hasUpvoted,
      createdAt: s.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /skills/:id/upvote — toggle upvote (supports avatars and anonymous claws)
// ---------------------------------------------------------------------------
marketplaceRoutes.post('/skills/:id/upvote', sessionMiddleware, async (c) => {
  const skillId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  // Determine voter identity — Lucia human OR connected/hosted agent (Phase C
  // parity), else anonymous claw (preserved). The dual resolver binds to the
  // real `avatars.id`; a body-supplied `clawSessionId` only counts when no
  // authed avatar resolves (so an agent can't masquerade as a claw and vice
  // versa). One vote per (skill, avatarId) OR (skill, clawSessionId) still holds.
  const avatarId: string | null = await resolveAuthedAvatarId(c);
  const clawSessionId: string | undefined = body.clawSessionId;

  if (!avatarId && !clawSessionId) {
    throw new HTTPException(401, { message: 'Authentication or claw session required to vote' });
  }

  // Check existing upvote
  let existingId: string | null = null;
  if (avatarId) {
    const [existing] = await db
      .select({ id: skillUpvotes.id })
      .from(skillUpvotes)
      .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.avatarId, avatarId)))
      .limit(1);
    if (existing) existingId = existing.id;
  } else if (clawSessionId) {
    const [existing] = await db
      .select({ id: skillUpvotes.id })
      .from(skillUpvotes)
      .where(and(eq(skillUpvotes.skillId, skillId), eq(skillUpvotes.clawSessionId, clawSessionId)))
      .limit(1);
    if (existing) existingId = existing.id;
  }

  let upvoted: boolean;
  let newCount: number;

  if (existingId) {
    await db.delete(skillUpvotes).where(eq(skillUpvotes.id, existingId));
    newCount = Math.max(0, skill.upvoteCount - 1);
    upvoted = false;
  } else {
    await db.insert(skillUpvotes).values({
      skillId,
      avatarId: avatarId ?? undefined,
      clawSessionId: clawSessionId ?? undefined,
    });
    newCount = skill.upvoteCount + 1;
    upvoted = true;
  }

  await db
    .update(publishedSkills)
    .set({ upvoteCount: newCount, updatedAt: new Date() })
    .where(eq(publishedSkills.id, skillId));

  return c.json({ upvoted, upvoteCount: newCount });
});

// ---------------------------------------------------------------------------
// Auth-required routes below
// ---------------------------------------------------------------------------

// POST /skills/:id/buy — purchase a skill (auth required)
marketplaceRoutes.post('/skills/:id/buy', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  if (skill.authorAvatarId === avatar.id) {
    throw new HTTPException(400, { message: 'Cannot buy your own skill' });
  }

  const existing = await db.query.avatarInventory.findFirst({
    where: and(
      eq(avatarInventory.avatarId, avatar.id),
      eq(avatarInventory.itemId, `skill-${skillId}`)
    ),
  });
  if (existing) {
    throw new HTTPException(400, { message: 'Already purchased this skill' });
  }

  await db.insert(avatarInventory).values({
    avatarId: avatar.id,
    itemId: `skill-${skillId}`,
    quantity: 1,
  });

  await db
    .update(publishedSkills)
    .set({
      downloadCount: skill.downloadCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(publishedSkills.id, skillId));

  return c.json({
    success: true,
    clawTokens: avatar.clawTokens,
    skill: { id: skill.id, name: skill.name },
  });
});

// POST /skills/:id/install — install a purchased skill (auth required)
marketplaceRoutes.post('/skills/:id/install', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);
  const skillId = c.req.param('id');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(skillId)) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const inventoryItem = await db.query.avatarInventory.findFirst({
    where: and(
      eq(avatarInventory.avatarId, avatar.id),
      eq(avatarInventory.itemId, `skill-${skillId}`)
    ),
  });

  if (!inventoryItem || inventoryItem.quantity < 1) {
    throw new HTTPException(400, { message: 'Skill not in inventory. Purchase it first.' });
  }

  const [skill] = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new HTTPException(404, { message: 'Skill not found' });
  }

  const isElizaOs = skill.skillMd.includes('format: elizaos-character');
  const currentConfig = (avatar.characterConfig as any) ?? {};

  let knowledgeEntries: string[] = [];
  let extraTopics: string[] = [];
  let extraLore: string[] = [];

  if (isElizaOs) {
    const jsonMatch = skill.skillMd.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const charData = JSON.parse(jsonMatch[1]);
        knowledgeEntries = charData.knowledge ?? [];
        extraTopics = charData.topics ?? [];
        extraLore = charData.lore ?? [];
      } catch { /* fallback to bullet parsing */ }
    }
  }

  if (knowledgeEntries.length === 0) {
    const lines = skill.skillMd.split('\n');
    let inKnowledge = false;
    for (const line of lines) {
      if (line.startsWith('## Core Knowledge')) { inKnowledge = true; continue; }
      if (inKnowledge && line.startsWith('## ')) break;
      if (inKnowledge && line.startsWith('- ')) {
        knowledgeEntries.push(line.slice(2).trim());
      }
    }
  }

  const currentKnowledge: string[] = currentConfig.knowledge ?? [];
  const newKnowledge = knowledgeEntries.filter((e) => !currentKnowledge.includes(e));
  const mergedKnowledge = [...currentKnowledge, ...newKnowledge];

  const currentTopics: string[] = currentConfig.topics ?? [];
  const mergedTopics = [...new Set([...currentTopics, ...extraTopics])];
  const currentLore: string[] = currentConfig.lore ?? [];
  const mergedLore = [...new Set([...currentLore, ...extraLore])];

  const updatedConfig = {
    ...currentConfig,
    knowledge: mergedKnowledge,
    ...(extraTopics.length > 0 ? { topics: mergedTopics } : {}),
    ...(extraLore.length > 0 ? { lore: mergedLore } : {}),
  };

  await db
    .update(avatars)
    .set({ characterConfig: updatedConfig, updatedAt: new Date() })
    .where(eq(avatars.id, avatar.id));

  if (avatar.platformAgentId) {
    await db
      .update(agents)
      .set({ customization: updatedConfig, updatedAt: new Date() })
      .where(eq(agents.id, avatar.platformAgentId));

    // Phase 2 RAG: embed new knowledge entries via the ElizaOS runtime
    if (newKnowledge.length > 0) {
      try {
        const runtime = await agentOrchestrator.ensureAgentRuntime(
          avatar.platformAgentId,
          avatar.userId,
        );
        if (runtime) {
          const { v5: uuidv5 } = await import('uuid');
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
                    content: { text: entry, source: 'marketplace-skill' } as any,
                    embedding,
                    createdAt: Date.now(),
                    metadata: { type: 'custom', subtype: 'knowledge', source: 'marketplace', skillId },
                  },
                  'knowledge',
                  true,
                );
              }
            } catch (entryErr) {
              console.warn(`[marketplace/install] Failed to embed entry: ${(entryErr as Error).message}`);
            }
          }
          console.log(`[marketplace/install] Embedded ${newKnowledge.length} knowledge entries for avatar ${avatar.id}`);
        }
      } catch (err) {
        console.warn(`[marketplace/install] Knowledge embedding failed (non-blocking): ${(err as Error).message}`);
      }
    }

    await agentOrchestrator.stopAgent(avatar.platformAgentId);
  }

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
    skillName: skill.name,
    newKnowledgeCount: newKnowledge.length,
    totalKnowledge: mergedKnowledge.length,
  });
});

// GET /my-skills — skills published by current user's avatar (auth required)
marketplaceRoutes.get('/my-skills', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);

  const skills = await db
    .select()
    .from(publishedSkills)
    .where(eq(publishedSkills.authorAvatarId, avatar.id))
    .orderBy(desc(publishedSkills.createdAt));

  return c.json({
    skills: skills.map((s: any) => ({
      id: s.id,
      authorAvatarName: avatar.name,
      authorSpecies: avatar.species,
      locationId: s.locationId,
      name: s.name,
      description: s.description,
      upvoteCount: s.upvoteCount,
      downloadCount: s.downloadCount,
      hasUpvoted: false,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});
