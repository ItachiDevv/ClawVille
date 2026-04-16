/**
 * POST /api/agent/export-character — Phase 3 "take my agent home" endpoint.
 *
 * Emits a complete ElizaOS-compatible character bundle for any pet owned by
 * the authenticated user, plus a Milady-install payload the Phase 4a UI can
 * POST verbatim against the user's local `/api/plugins/install`.
 *
 * Spec: `.claude/plans/phase3-character-export-api.md`.
 *
 * Security:
 *   - Auth: Lucia session cookie (same pattern as `apps/api/src/routes/pets.ts`).
 *   - Authz: 403 if pet exists but belongs to a different session user.
 *   - Rate limit: 10 requests per IP per minute (shared pattern with /connect).
 *   - No signing: we emit an unsigned snapshot. If chain-of-custody becomes a
 *     marketplace concern, add `issuedAt` + `exportHash` later (Phase 5+).
 *
 * The route is stateless — it reads the pet, delegates to the pure
 * `buildCharacterExport` function in `@clawville/agent-runtime`, and returns
 * the result. No DB writes, no agent lifecycle changes.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pets } from '@clawville/database';
import {
  AGENT_HARNESSES,
  BUILDING_MILADY_SKILLS,
  KNOWLEDGE_BOOKS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_HARNESS,
  getAgentModel,
  type AgentCategory,
  type AgentHarness,
  type AgentModelMeta,
  type SkillPackEntry,
} from '@clawville/shared';
import { buildCharacterExport } from '@clawville/agent-runtime';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AuthenticatedContext } from '../types';

// Phase 3 audit C2 — `requireAuth` is a `createMiddleware<AuthenticatedContext>`
// that validates the Lucia session AND sets `c.var.user` to a non-null `User`.
// Typing the Hono instance as `AuthenticatedContext` lets `c.get('user')`
// return `User` directly (no null guard), and we drop the redundant global
// `sessionMiddleware` — it was validating the session twice per request
// (once here, once inside `requireAuth`), burning an extra Lucia round-trip
// on every hit. Per-route `requireAuth` is the single auth gate.
export const agentExportRoutes = new Hono<AuthenticatedContext>();

// 10 exports / IP / minute — spam-ceiling high enough that a human clicking
// the "Take home" button in a loop can't trip it by accident, low enough that
// a scraping client hammering the endpoint hits a wall fast.
const exportRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

/**
 * Default base URL of the user's local Milady HTTP API. Milady's dev
 * server listens on port 2138 by default (see the CORS note in
 * `apps/api/src/index.ts`: "Milady port 2138"). ClawVille's own API
 * runs on port 4000 — emitting `curl http://localhost:4000/...` here
 * would always 404 on a fresh Milady install, which is Phase 3 audit C4.
 */
const DEFAULT_MILADY_BASE_URL = 'http://localhost:2138';

const exportSchema = z.object({
  /** Pet UUID — must be owned by the session user. */
  petId: z.string().uuid(),
  /**
   * Optional harness override — defaults to the pet's stored `harness` when
   * omitted. Validated against the shared `AGENT_HARNESSES` tuple so the
   * server stays in lockstep with the DB CHECK constraint
   * `pets_harness_valid` (Phase 2).
   */
  targetHarness: z.enum(AGENT_HARNESSES).optional(),
  /**
   * Base URL of the user's local Milady HTTP API. Defaults to the
   * standard Milady dev port (2138). Users running Milady on a non-
   * default port can override here; the value flows through to the
   * emitted `installCommand` curl one-liner.
   */
  miladyBaseUrl: z.string().url().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a shell-safe `curl` one-liner that posts the Milady install
 * payload to the user's local Milady API.
 *
 * Shell-escaping strategy: wrap the JSON body in single quotes and escape
 * any embedded single quotes with the standard POSIX sequence `'\''`
 * (close quote, literal quote, reopen). This is safe in bash, zsh, and
 * the MinGW bash that Milady users on Windows tend to have. Pet names
 * themselves are alphanumeric-only by Zod constraint, but archetype
 * bio / lore / knowledge strings often contain apostrophes ("I'm",
 * "O'Malley" — etc.) so defensive escaping is required.
 *
 * `miladyBaseUrl` is configurable via the request body (Phase 3 audit
 * C4 — the previous hardcoded `http://localhost:4000` was ClawVille's
 * own API port, not Milady's default of 2138, so the emitted curl was
 * guaranteed to 404). The Zod schema validates that the override is a
 * well-formed URL before it reaches this function.
 */
function buildInstallCommand(payload: unknown, miladyBaseUrl: string): string {
  const json = JSON.stringify(payload);
  // Replace every `'` with `'\''` so the single-quoted wrapper stays intact.
  const escaped = json.replace(/'/g, `'\\''`);
  // Trim trailing slash so concatenation stays well-formed regardless
  // of what the caller passes (`http://localhost:2138` vs `.../`).
  const base = miladyBaseUrl.replace(/\/+$/, '');
  return `curl -X POST ${base}/api/plugins/install -H 'Content-Type: application/json' -d '${escaped}'`;
}

/**
 * Pre-compute the (buildingId → KnowledgeBook[]) map from the KNOWLEDGE_BOOKS
 * registry at module load. Every building maps to exactly 2 books in the
 * current spec; the fully-learned check below uses `.every(...)` so 3+
 * books per building would still work correctly (pet would need ALL of them).
 */
const BOOKS_BY_BUILDING: Readonly<Record<string, typeof KNOWLEDGE_BOOKS>> = (() => {
  const m: Record<string, typeof KNOWLEDGE_BOOKS> = {};
  for (const book of KNOWLEDGE_BOOKS) {
    if (!m[book.building]) m[book.building] = [];
    m[book.building].push(book);
  }
  // Freeze the index so test-time mutations of `KNOWLEDGE_BOOKS` (or any
  // accidental write here) fail loudly instead of silently drifting.
  return Object.freeze(m);
})();

/**
 * Compose the SkillPack for a pet.
 *
 * "Fully learned" check — a building is learned when the pet's
 * `characterConfig.knowledge` contains at least one entry from EACH
 * book published at that building. This mirrors the existing gate in
 * `apps/api/src/routes/items.ts:303-305` (the `export-skill/:buildingId`
 * endpoint) verbatim so the Phase 3 bundle matches the in-game export
 * flow exactly.
 *
 * IMPORTANT: we intentionally DO NOT check `pet_inventory` here. Books
 * are consumed on `POST /api/items/learn` (items.ts:258-266), so any pet
 * that has actually learned books will have an empty inventory for those
 * book IDs — relying on inventory would silently emit zero skills for
 * every fully-trained pet, which is the exact opposite of correct.
 *
 * Buildings that don't have a matching entry in `BUILDING_MILADY_SKILLS`
 * are skipped silently — the Milady catalog is the source of truth for
 * which buildings produce exportable skills.
 *
 * The `knowledge` field on each entry is sourced from the book's
 * `knowledgeEntries` array (the canonical markdown-per-chunk data) in
 * stable order: book-registry order, then entry order within each book.
 * This is deterministic so re-exporting the same pet produces a
 * byte-identical payload (useful once we add hashing in Phase 5).
 */
function buildSkillPack(
  pet: { id: string; name: string },
  petKnowledge: string[],
): SkillPackEntry[] {
  const knowledgeSet = new Set(petKnowledge);

  const entries: SkillPackEntry[] = [];
  for (const [buildingId, skill] of Object.entries(BUILDING_MILADY_SKILLS)) {
    const buildingBooks = BOOKS_BY_BUILDING[buildingId] ?? [];
    if (buildingBooks.length === 0) continue;

    // Fully-learned check — every book assigned to this building must
    // have at least one of its entries in the pet's knowledge set.
    const fullyLearned = buildingBooks.every((book) =>
      book.knowledgeEntries.some((entry) => knowledgeSet.has(entry)),
    );
    if (!fullyLearned) continue;

    // Flatten all knowledge chunks from this building's books in stable
    // order (book-registry order, then entry order within each book).
    // We emit every chunk from the canonical registry rather than just
    // the ones the pet currently carries — per spec §5, the pack ships
    // the full building skill so Milady's RAG store sees the complete
    // body of knowledge. This also matches `items.ts#export-skill`'s
    // `const knowledge = characterConfig?.knowledge ?? []` approach but
    // is more defensible: it's immune to users whose characterConfig
    // somehow lost entries post-learn.
    const knowledge: string[] = buildingBooks.flatMap(
      (book) => book.knowledgeEntries,
    );

    entries.push({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      buildingId,
      knowledge,
      source: 'clawville',
      exportedFrom: { petId: pet.id, petName: pet.name },
    });
  }

  return entries;
}

// ─── Route ──────────────────────────────────────────────────────────────────

agentExportRoutes.post('/export-character', requireAuth, async (c) => {
  // --- Rate limit (before any DB work) ---
  const ip = getClientIp({
    get: (name) => c.req.header(name) ?? null,
  });
  if (!exportRateLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many export requests. Try again in 1 minute.',
    });
  }

  const user = c.get('user');

  // --- Validate input ---
  const body = await c.req.json().catch(() => null);
  if (!body) {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }
  const parsed = exportSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? 'Invalid request payload',
    });
  }

  const { petId, targetHarness } = parsed.data;

  // --- Look up pet ---
  const pet = await db.query.pets.findFirst({
    where: eq(pets.id, petId),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Pet not found' });
  }

  // Authorization: must belong to the session user. Distinct from 404 so the
  // UI can surface a clear "not yours" error vs a generic not-found.
  if (pet.userId !== user.id) {
    throw new HTTPException(403, {
      message: 'You do not own this pet',
    });
  }

  // --- Resolve model metadata + target harness ---
  // `pet.modelKey` should always be populated post-Phase-2 thanks to the
  // NOT NULL DEFAULT + CHECK constraint, but a pet row that pre-dates the
  // migration could theoretically arrive here with a stale value. Fall
  // back to `DEFAULT_AGENT_MODEL` in that case rather than 500-ing —
  // this keeps the export useful even on edge rows.
  const modelMeta: AgentModelMeta =
    (pet.modelKey ? getAgentModel(pet.modelKey) : undefined) ?? DEFAULT_AGENT_MODEL;

  const harness: AgentHarness =
    targetHarness ?? (pet.harness as AgentHarness | null) ?? DEFAULT_AGENT_HARNESS;

  // --- Build skill pack from the pet's learned knowledge ---
  // Books are consumed on `/api/items/learn`, so the only durable signal
  // of "learned" is the pet's `characterConfig.knowledge[]` array.
  const petKnowledge: string[] =
    (pet.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];

  const skillPack = buildSkillPack(
    { id: pet.id, name: pet.name },
    petKnowledge,
  );

  // --- Build the character (pure, synchronous) ---
  const character = buildCharacterExport(
    { id: pet.id, name: pet.name, characterConfig: pet.characterConfig ?? null },
    modelMeta,
    { harness },
  );

  const exportedAt = new Date().toISOString();

  // --- Compose Milady install payload + curl command ---
  const miladyInstallPayload = {
    plugin: '@clawville/app-clawville',
    config: {
      character,
      skills: skillPack,
      source: {
        url: 'https://clawville.world',
        petId: pet.id,
        exportedAt,
      },
    },
  } as const;

  const miladyBaseUrl = parsed.data.miladyBaseUrl ?? DEFAULT_MILADY_BASE_URL;
  const installCommand = buildInstallCommand(miladyInstallPayload, miladyBaseUrl);

  // --- Summary — cheap client-side stats for the Phase 4a UI ---
  // Post Fix 1 the character's `knowledge` field is deliberately empty
  // (ElizaOS v2 would normalize string[] to filesystem paths, breaking RAG).
  // The skill pack is the authoritative RAG carrier, so count knowledge
  // chunks by summing per-skill chunks — matches what the user actually
  // exports to Milady.
  const knowledgeCount = skillPack.reduce(
    (n, s) => n + s.knowledge.length,
    0,
  );

  const agentCategory: AgentCategory =
    (pet.agentCategory as AgentCategory | null) ?? modelMeta.category;

  return c.json({
    character,
    skillPack,
    miladyInstallPayload,
    installCommand,
    exportedAt,
    summary: {
      modelKey: pet.modelKey ?? modelMeta.key,
      agentCategory,
      harness,
      skillsCount: skillPack.length,
      knowledgeCount,
    },
  });
});
