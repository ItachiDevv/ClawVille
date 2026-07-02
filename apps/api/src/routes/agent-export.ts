/**
 * POST /api/agent/export-character — Phase 3 "take my agent home" endpoint.
 *
 * Emits a complete ElizaOS-compatible character bundle for any avatar owned by
 * the authenticated user, plus a Milady-install payload the Phase 4a UI can
 * POST verbatim against the user's local `/api/plugins/install`.
 *
 * Spec: `.claude/plans/phase3-character-export-api.md`.
 *
 * Security:
 *   - Auth: Lucia session cookie (same pattern as `apps/api/src/routes/avatars.ts`).
 *   - Authz: 403 if avatar exists but belongs to a different session user.
 *   - Rate limit: 10 requests per IP per minute (shared pattern with /connect).
 *   - No signing: we emit an unsigned snapshot. If chain-of-custody becomes a
 *     concern, add `issuedAt` + `exportHash` later (Phase 5+).
 *
 * The route is stateless — it reads the avatar, delegates to the pure
 * `buildCharacterExport` function in `@clawville/agent-runtime`, and returns
 * the result. No DB writes, no agent lifecycle changes.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, avatars } from '@clawville/database';
import {
  AGENT_HARNESSES,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_HARNESS,
  getAgentModel,
  type AgentCategory,
  type AgentHarness,
  type AgentModelMeta,
} from '@clawville/shared';
import { buildCharacterExport } from '@clawville/agent-runtime';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
// SkillPack derivation lives in a shared service (2026-06-19) so this route
// and the signed avatar-manifest export (`avatar-manifest-service.ts`) emit an
// identical pack — see `services/skill-pack-builder.ts`.
import { buildSkillPack } from '../services/skill-pack-builder';
import type { AuthenticatedContext } from '../types';

// Per-route `requireAuth` is the single auth gate; we deliberately do NOT
// add a global `sessionMiddleware` because that would double-validate the
// Lucia session on every request for no benefit. `requireAuth` is typed as
// `createMiddleware<AuthenticatedContext>` so `c.get('user')` returns a
// non-null `User` when typing the Hono instance with the same context.
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
  /** Avatar UUID — must be owned by the session user. */
  avatarId: z.string().uuid(),
  /**
   * Optional harness override — defaults to the avatar's stored `harness` when
   * omitted. Validated against the shared `AGENT_HARNESSES` tuple so the
   * server stays in lockstep with the DB CHECK constraint
   * `avatars_harness_valid` (Phase 2).
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
 * the MinGW bash that Milady users on Windows tend to have. Avatar names
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
  // of what the caller passes (`http://localhost:2138` vs `.../`), then
  // shell-single-quote-escape. `z.string().url()` accepts shell meta-
  // chars like `$(cmd)` and backticks — since Phase 4a will display
  // this command in a copy-to-clipboard UI, an attacker-controlled
  // `miladyBaseUrl` could otherwise smuggle a command substitution
  // into the user's terminal. Wrap in single quotes + escape embedded
  // apostrophes the same way we do for the JSON payload.
  const trimmed = miladyBaseUrl.replace(/\/+$/, '');
  const fullUrl = `${trimmed}/api/plugins/install`;
  const urlQuoted = `'${fullUrl.replace(/'/g, `'\\''`)}'`;
  return `curl -X POST ${urlQuoted} -H 'Content-Type: application/json' -d '${escaped}'`;
}

// `buildSkillPack` moved to `services/skill-pack-builder.ts` (2026-06-19) so the
// signed avatar-manifest export reuses the exact same derivation. Imported above.

// ─── Route ──────────────────────────────────────────────────────────────────

agentExportRoutes.post(
  '/export-character',
  // Rate-limit MUST run before `requireAuth` so unauthenticated spam
  // never reaches Lucia. Otherwise a scraper hammering this endpoint with
  // junk cookies would burn one `lucia.validateSession()` DB round-trip
  // per request before being 401'd, defeating the purpose of the limiter.
  async (c, next) => {
    const ip = getClientIp({
      get: (name) => c.req.header(name) ?? null,
    });
    if (!exportRateLimiter.check(ip)) {
      throw new HTTPException(429, {
        message: 'Too many export requests. Try again in 1 minute.',
      });
    }
    return next();
  },
  requireAuth,
  async (c) => {
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

  const { avatarId, targetHarness } = parsed.data;

  // --- Look up avatar ---
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  // Authorization: must belong to the session user. Distinct from 404 so the
  // UI can surface a clear "not yours" error vs a generic not-found.
  if (avatar.userId !== user.id) {
    throw new HTTPException(403, {
      message: 'You do not own this avatar',
    });
  }

  // --- Resolve model metadata + target harness ---
  // `avatar.modelKey` should always be populated post-Phase-2 thanks to the
  // NOT NULL DEFAULT + CHECK constraint, but an avatar row that pre-dates the
  // migration could theoretically arrive here with a stale value. Fall
  // back to `DEFAULT_AGENT_MODEL` in that case rather than 500-ing —
  // this keeps the export useful even on edge rows.
  const modelMeta: AgentModelMeta =
    (avatar.modelKey ? getAgentModel(avatar.modelKey) : undefined) ?? DEFAULT_AGENT_MODEL;

  const harness: AgentHarness =
    targetHarness ?? (avatar.harness as AgentHarness | null) ?? DEFAULT_AGENT_HARNESS;

  // --- Build skill pack from the avatar's learned knowledge ---
  // Books are consumed on `/api/items/learn`, so the only durable signal
  // of "learned" is the avatar's `characterConfig.knowledge[]` array.
  const avatarKnowledge: string[] =
    (avatar.characterConfig as { knowledge?: string[] } | null)?.knowledge ?? [];

  const skillPack = buildSkillPack(
    { id: avatar.id, name: avatar.name },
    avatarKnowledge,
  );

  // --- Build the character (pure, synchronous) ---
  const character = buildCharacterExport(
    { id: avatar.id, name: avatar.name, characterConfig: avatar.characterConfig ?? null },
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
        avatarId: avatar.id,
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
    (avatar.agentCategory as AgentCategory | null) ?? modelMeta.category;

  return c.json({
    character,
    skillPack,
    miladyInstallPayload,
    installCommand,
    exportedAt,
    summary: {
      modelKey: avatar.modelKey ?? modelMeta.key,
      agentCategory,
      harness,
      skillsCount: skillPack.length,
      knowledgeCount,
    },
  });
  },
);
