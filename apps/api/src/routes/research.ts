import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { articleScraper } from '../services/article-scraper';
import { researchService } from '../services/research-service';
import { researchEventBus } from './research-sse';
import { npcSimulation } from '../services/npc-simulation';
import { db, pets, eq, and } from '@legacyapp/database';
import type { AppContext } from '../types';

export const researchApiRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// POST /api/research/trigger — Start research for a location
// Supports both pet (auth required) and claw sessions (no auth)
// ---------------------------------------------------------------------------
const triggerSchema = z.object({
  sessionId: z.string().min(1),
  locationId: z.string().min(1),
  clawSessionId: z.string().optional(),
});

researchApiRoutes.post('/trigger', sessionMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = triggerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { sessionId, locationId, clawSessionId } = parsed.data;

  // --- Claw session path (no auth required) ---
  if (clawSessionId) {
    const claw = npcSimulation.getBrowserClaw(clawSessionId);
    if (!claw) {
      return c.json({ error: 'Claw session not found' }, 404);
    }

    const themeOverride = claw.config.researchConfig?.themes?.[locationId]
      ?? (claw.config.researchConfig?.globalFocus
        ? { label: locationId, focus: claw.config.researchConfig.globalFocus }
        : undefined);

    researchService
      .research({
        sessionId,
        petId: claw.sessionId,
        locationId,
        petName: claw.config.name,
        existingKnowledge: claw.config.knowledge ?? [],
        emit: (event) => researchEventBus.emit(event),
        themeOverride,
      })
      .then((result) => {
        // Update claw knowledge in-memory
        if (result.synthesizedKnowledge.length > 0) {
          claw.config.knowledge = [
            ...(claw.config.knowledge ?? []),
            ...result.synthesizedKnowledge,
          ];
        }
      })
      .catch((err) => {
        console.error('[Research] Claw pipeline error:', err);
      });

    return c.json({ started: true, locationId });
  }

  // --- Pet session path (auth required) ---
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required for pet research' }, 401);
  }

  const pet = await db.query.pets.findFirst({ where: and(eq(pets.userId, user.id), eq(pets.isActive, true)) });
  if (!pet) {
    return c.json({ error: 'No pet found' }, 404);
  }

  researchService
    .research({
      sessionId,
      petId: pet.id,
      locationId,
      petName: pet.name,
      existingKnowledge: (pet.characterConfig as any)?.knowledge ?? [],
      emit: (event) => researchEventBus.emit(event),
    })
    .then(async (result) => {
      if (result.synthesizedKnowledge.length > 0) {
        const currentConfig = (pet.characterConfig as any) ?? {};
        const currentKnowledge: string[] = currentConfig.knowledge ?? [];
        const newEntries = result.synthesizedKnowledge.filter(
          (k) => !currentKnowledge.includes(k),
        );
        if (newEntries.length > 0) {
          await db
            .update(pets)
            .set({
              characterConfig: {
                ...currentConfig,
                knowledge: [...currentKnowledge, ...newEntries],
              },
              updatedAt: new Date(),
            })
            .where(eq(pets.id, pet.id));
          console.log(`[Research] Added ${newEntries.length} knowledge entries to pet ${pet.name}`);
        }
      }
    })
    .catch((err) => {
      console.error('[Research] Pipeline error:', err);
    });

  return c.json({ started: true, locationId });
});

// ---------------------------------------------------------------------------
// GET /api/research/articles/:locationId — List cached articles
// ---------------------------------------------------------------------------
researchApiRoutes.get('/articles/:locationId', async (c) => {
  const locationId = c.req.param('locationId');
  const articles = await articleScraper.getArticlesForLocation(locationId);
  return c.json({
    articles: articles.map((a: any) => ({
      id: a.id,
      title: a.title,
      source: a.source,
      url: a.url,
      scrapedAt: a.scrapedAt,
      wordCount: (a.metadata as any)?.wordCount ?? 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/research/scrape — Re-scrape a location's articles
// ---------------------------------------------------------------------------
const scrapeSchema = z.object({
  locationId: z.string().min(1),
});

researchApiRoutes.post('/scrape', requireAuth, async (c) => {
  const body = await c.req.json();
  const parsed = scrapeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request' }, 400);
  }

  // Run async — don't block
  articleScraper.refreshLocation(parsed.data.locationId).catch((err) => {
    console.error('[Scraper] Refresh failed:', err);
  });

  return c.json({ started: true, locationId: parsed.data.locationId });
});

// ---------------------------------------------------------------------------
// POST /api/research/seed — Seed all articles from constants
// ---------------------------------------------------------------------------
researchApiRoutes.post('/seed', requireAuth, async (c) => {
  // Run async — this can take minutes
  articleScraper.seedAll((location, index, total) => {
    console.log(`[Scraper] Seeding ${location}: ${index}/${total}`);
  }).catch((err) => {
    console.error('[Scraper] Seed failed:', err);
  });

  return c.json({ started: true });
});
