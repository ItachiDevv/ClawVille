/**
 * System NPC Seeder
 * ─────────────────
 * On API boot, ensure every building has a pre-configured ElizaOS character
 * ready to chat — no per-user `location_agents` row required.
 *
 * Each of the 10 SpongeBob characters from `@clawville/agent-templates` gets:
 *   1. A `platform_agents` row owned by the system user, with its template
 *      merged against the compiled SKILL.md from `building_skills.content`
 *      (chunked into `customization.knowledge[]` so ElizaOS RAG can retrieve
 *      targeted passages when an agent asks a question).
 *   2. A `location_agents` row under the system user + buildingId, pointing
 *      at the platform agent. Chat fallback in `chat.ts` finds this row when
 *      the caller has no personal override.
 *
 * Idempotent — safe to run on every boot. Updates existing rows in place
 * when templates or SKILL.md content change.
 *
 * System agents (world-wide NPCs that aren't tied to a building, e.g. the
 * Town Guide) use a separate upsert path: `ensureSystemAgents()` below, with
 * rows identified by `type='system-agent'` + `customization.slug=<slug>`.
 */

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  users,
  platformAgents,
  locationAgents,
  buildingSkills,
  mapLocations,
} from '@clawville/database';
import {
  LOCATION_TEMPLATES,
  SYSTEM_AGENT_TEMPLATES,
  type LocationTemplate,
} from '@clawville/agent-templates';

const SYSTEM_USER_EMAIL = 'openclaw-system@clawville.internal';
const SYSTEM_USER_NAME = 'ClawVille System';

/** Cached after first lookup. */
let _systemUserId: string | null = null;

async function getOrCreateSystemUser(): Promise<string> {
  if (_systemUserId) return _systemUserId;
  const existing = await db.query.users.findFirst({
    where: eq(users.email, SYSTEM_USER_EMAIL),
  });
  if (existing) {
    _systemUserId = existing.id;
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
      emailVerified: true,
    })
    .returning();
  _systemUserId = created.id;
  return created.id;
}

/**
 * Split a compiled SKILL.md body into knowledge-sized chunks. Preserves
 * section headings so each chunk remains self-contained when the RAG layer
 * retrieves it in isolation.
 */
function chunkSkillMarkdown(md: string, maxChars = 1500): string[] {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/m, '').trim();
  if (!body) return [];

  const sections = body
    .split(/\n(?=## )/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= maxChars) {
      chunks.push(section);
      continue;
    }
    const paragraphs = section.split(/\n\n+/).filter(Boolean);
    let buffer = '';
    for (const p of paragraphs) {
      if (buffer.length + p.length + 2 <= maxChars) {
        buffer = buffer ? `${buffer}\n\n${p}` : p;
      } else {
        if (buffer) chunks.push(buffer);
        buffer = p;
      }
    }
    if (buffer) chunks.push(buffer);
  }
  return chunks;
}

/** Build the full customization payload stored in `platform_agents.customization`. */
function buildCustomization(
  template: LocationTemplate,
  skillChunks: string[],
  buildingName: string,
) {
  const mergedKnowledge = [...template.knowledge, ...skillChunks];
  return {
    name: template.name,
    bio: template.bio,
    lore: template.lore,
    knowledge: mergedKnowledge,
    topics: template.topics,
    adjectives: template.adjectives,
    messageExamples: template.messageExamples,
    style: template.style,
    system: `You are ${template.name}, the resident character of ${buildingName}. Teach visiting agents about your domain using your knowledge base. Stay in character — use your voice and mannerisms. When an agent asks a technical question, retrieve the most relevant knowledge and explain it through your persona.`,
    greeting: template.description,
  };
}

/** Minimal CharacterConfigJson shape required by the `location_agents` table. */
function buildLocationCharacterConfig(template: LocationTemplate) {
  return {
    name: template.name,
    personality: template.adjectives.join(', '),
    bio: template.bio.join(' '),
    greeting: `${template.name}: ${template.description}`,
    tone: 'friendly' as const,
    topics: template.topics,
    rules: template.style.all,
    style: template.style.all,
  };
}

interface SeedResult {
  buildingId: string;
  platformAgentId: string;
  locationAgentId: string;
  knowledgeChunks: number;
  skillLoaded: boolean;
  created: boolean;
}

export async function ensureSystemNpcs(): Promise<SeedResult[]> {
  const systemUserId = await getOrCreateSystemUser();
  const results: SeedResult[] = [];

  // Verify each building exists in map_locations before inserting a location_agents row
  const locationRows = await db.select({ id: mapLocations.id, name: mapLocations.name }).from(mapLocations);
  const locationMap = new Map(locationRows.map((r) => [r.id, r.name]));

  for (const [buildingId, template] of Object.entries(LOCATION_TEMPLATES)) {
    if (!locationMap.has(buildingId)) {
      console.warn(`[SystemNPC] Skipping ${buildingId} — no map_locations row. Run db:seed first.`);
      continue;
    }

    const buildingName = locationMap.get(buildingId) ?? buildingId;

    // Load compiled SKILL.md content when available
    const [skillRow] = await db
      .select({ content: buildingSkills.content })
      .from(buildingSkills)
      .where(eq(buildingSkills.buildingId, buildingId))
      .limit(1);

    const skillChunks = skillRow ? chunkSkillMarkdown(skillRow.content) : [];
    const customization = buildCustomization(template, skillChunks, buildingName);
    const characterConfig = buildLocationCharacterConfig(template);

    // Upsert platform_agent: look up by (userId, name, type)
    // name is stable because it's derived from template.name
    let platformAgentId: string;
    let created = false;

    const existingPlatformAgent = await db.query.platformAgents.findFirst({
      where: and(
        eq(platformAgents.userId, systemUserId),
        eq(platformAgents.name, template.name),
        eq(platformAgents.type, 'location-agent'),
      ),
    });

    if (existingPlatformAgent) {
      platformAgentId = existingPlatformAgent.id;
      await db
        .update(platformAgents)
        .set({
          customization,
          // Defense-in-depth (2026-06-21): persist the buildingId so the runtime's
          // template fallback resolves the RIGHT building even if it ever runs
          // ahead of customization. The persona itself is customization-driven
          // (see eliza-runtime convertToElizaCharacter customization-first fix),
          // but a stamped locationId stops a future empty-config row from bleeding
          // the 'cron-automation' (Pearl) fallback into this teacher.
          config: { locationId: buildingId },
          updatedAt: new Date(),
        })
        .where(eq(platformAgents.id, existingPlatformAgent.id));
    } else {
      const [inserted] = await db
        .insert(platformAgents)
        .values({
          userId: systemUserId,
          name: template.name,
          type: 'location-agent',
          status: 'stopped',
          customization,
          config: { locationId: buildingId },
        })
        .returning({ id: platformAgents.id });
      platformAgentId = inserted.id;
      created = true;
    }

    // Upsert location_agent: look up by (userId, locationId)
    const existingLocationAgent = await db.query.locationAgents.findFirst({
      where: and(
        eq(locationAgents.userId, systemUserId),
        eq(locationAgents.locationId, buildingId),
      ),
    });

    let locationAgentId: string;
    if (existingLocationAgent) {
      locationAgentId = existingLocationAgent.id;
      await db
        .update(locationAgents)
        .set({
          agentName: template.name,
          characterConfig,
          platformAgentId,
          updatedAt: new Date(),
        })
        .where(eq(locationAgents.id, existingLocationAgent.id));
    } else {
      const [inserted] = await db
        .insert(locationAgents)
        .values({
          userId: systemUserId,
          locationId: buildingId,
          agentName: template.name,
          characterConfig,
          platformAgentId,
        })
        .returning({ id: locationAgents.id });
      locationAgentId = inserted.id;
      created = true;
    }

    results.push({
      buildingId,
      platformAgentId,
      locationAgentId,
      knowledgeChunks: skillChunks.length,
      skillLoaded: !!skillRow,
      created,
    });
  }

  return results;
}

/**
 * Find the system NPC agent for a given building. Returns null if no system
 * agent is seeded (which means `ensureSystemNpcs()` hasn't run or the
 * building is unknown).
 */
export async function getSystemNpcAgent(
  locationId: string,
): Promise<{ locationAgent: typeof locationAgents.$inferSelect; systemUserId: string } | null> {
  const systemUserId = await getOrCreateSystemUser();
  const row = await db.query.locationAgents.findFirst({
    where: and(
      eq(locationAgents.userId, systemUserId),
      eq(locationAgents.locationId, locationId),
    ),
  });
  if (!row || !row.platformAgentId) return null;
  return { locationAgent: row, systemUserId };
}

/** Expose system user lookup for other seeders / bot registrations. */
export async function getSystemUserId(): Promise<string> {
  return getOrCreateSystemUser();
}

// ───────────────────────────────────────────────────────────────────────────
// System agents — world-wide NPCs that aren't tied to a building
// ───────────────────────────────────────────────────────────────────────────
// These use `platform_agents.type = 'system-agent'` with
// `customization.slug = <slug>` as the identifier. They have NO
// `location_agents` row (they don't live in a building). Chat goes through
// `POST /api/chat/system/:slug`.
//
// Adding a new system agent (e.g. an arena host, quest giver):
//   1. Write a template under `packages/agent-templates/src/locations/`
//   2. Register it under a slug in `SYSTEM_AGENT_TEMPLATES`
//   3. Ship — the seeder loop below upserts it on next boot
// ───────────────────────────────────────────────────────────────────────────

export interface SystemAgentSeedResult {
  slug: string;
  platformAgentId: string;
  knowledgeChunks: number;
  created: boolean;
}

/**
 * Build the customization payload for a system agent. Unlike building
 * residents, there is no compiled SKILL.md to merge — the template's
 * `knowledge[]` is the authoritative RAG carrier on its own.
 */
function buildSystemAgentCustomization(template: LocationTemplate, slug: string) {
  return {
    // `slug` is load-bearing — the partial unique index and every lookup
    // key on `customization->>'slug'`. Keep it at top level.
    slug,
    name: template.name,
    bio: template.bio,
    lore: template.lore,
    knowledge: template.knowledge,
    topics: template.topics,
    adjectives: template.adjectives,
    messageExamples: template.messageExamples,
    style: template.style,
    system: `You are ${template.name}, a world-wide NPC at ClawVille. Your role is defined by your template: teach, orient, or host as your bio and knowledge prescribe. Stay in character. When a visitor asks about a specific building skill, redirect them to the relevant building teacher by name.`,
    greeting: template.description,
  };
}

/**
 * Seed or update every system agent registered in `SYSTEM_AGENT_TEMPLATES`.
 * Idempotent — safe to run on every boot. Call from the same boot hook as
 * `ensureSystemNpcs()`.
 */
export async function ensureSystemAgents(): Promise<SystemAgentSeedResult[]> {
  const systemUserId = await getOrCreateSystemUser();
  const results: SystemAgentSeedResult[] = [];

  for (const [slug, template] of Object.entries(SYSTEM_AGENT_TEMPLATES)) {
    const customization = buildSystemAgentCustomization(template, slug);

    // JSONB path comparison — drizzle's `eq` doesn't support operators like
    // `->>`, so we drop to a `sql\`\`` fragment. Scoped to the
    // (userId, type) pair so the partial unique index covers us on writes.
    const existing = await db.query.platformAgents.findFirst({
      where: and(
        eq(platformAgents.userId, systemUserId),
        eq(platformAgents.type, 'system-agent'),
        sql`${platformAgents.customization}->>'slug' = ${slug}`,
      ),
    });

    let platformAgentId: string;
    let created = false;

    if (existing) {
      platformAgentId = existing.id;
      await db
        .update(platformAgents)
        .set({
          name: template.name,
          customization,
          updatedAt: new Date(),
        })
        .where(eq(platformAgents.id, existing.id));
    } else {
      const [inserted] = await db
        .insert(platformAgents)
        .values({
          userId: systemUserId,
          name: template.name,
          type: 'system-agent',
          status: 'stopped',
          customization,
          config: {},
        })
        .returning({ id: platformAgents.id });
      platformAgentId = inserted.id;
      created = true;
    }

    results.push({
      slug,
      platformAgentId,
      knowledgeChunks: template.knowledge.length,
      created,
    });
  }

  return results;
}

/**
 * Look up a system agent by slug. NEVER look up by name — names are free-form
 * and duplicate-prone; the slug + (type='system-agent') tuple is the
 * authoritative identity. Returns null if no row is seeded.
 */
export async function getSystemAgent(
  slug: string,
): Promise<{ platformAgent: typeof platformAgents.$inferSelect; systemUserId: string } | null> {
  const systemUserId = await getOrCreateSystemUser();
  const row = await db.query.platformAgents.findFirst({
    where: and(
      eq(platformAgents.userId, systemUserId),
      eq(platformAgents.type, 'system-agent'),
      sql`${platformAgents.customization}->>'slug' = ${slug}`,
    ),
  });
  if (!row) return null;
  return { platformAgent: row, systemUserId };
}
