/**
 * Phase 3 — pure Character bundle builder for the "take my agent home"
 * export. Given an avatar row + resolved `AgentModelMeta` + target
 * `AgentHarness`, assemble a ready-to-import ElizaOS `Character` object.
 *
 * This module MUST stay side-effect-free:
 *   - No DB access (Drizzle, raw pg, Supabase clients — none of it).
 *   - No `async` — construction is synchronous.
 *   - No ElizaRuntime instantiation. `createElizaRuntime` stays in
 *     `eliza-runtime.ts`; this file only shapes the Character JSON the
 *     caller will hand off to a different runtime (the user's local
 *     Milady, typically).
 *
 * The skill pack derivation is NOT here because it requires an
 * `avatar_inventory` query. It lives inside the API route that owns the
 * DB connection (see `apps/api/src/routes/agent-export.ts`). Keeping
 * the character builder pure makes it trivially unit-testable and
 * means a future consumer (e.g. a CLI) can reuse the same composition
 * without dragging the DB in.
 *
 * See `.claude/plans/phase3-character-export-api.md` for the full spec.
 */

import { createCharacter, type Character, type CharacterInput } from '@elizaos/core';
import type { AgentHarness, AgentModelMeta } from '@clawville/shared';

export { type SkillPackEntry } from '@clawville/shared';

/**
 * Minimal subset of the avatar `characterConfig` JSONB blob that the
 * exporter needs. Declared locally — and NOT imported from
 * `@clawville/database` — because `agent-runtime` does not depend on
 * the database package (avoids a new package-graph edge). If the DB
 * schema ever adds a required field the exporter needs, mirror it
 * here; if it drops one, delete it here. The field names and types
 * intentionally match `AvatarCharacterConfigJson` in
 * `packages/database/src/schema/avatars.ts` so assignment from a raw
 * Drizzle row is a no-op.
 */
export interface AvatarCharacterConfigLike {
  bio?: string[];
  greeting?: string;
  tone?: string;
  topics?: string[];
  adjectives?: string[];
  rules?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  messageExamples?: Array<Array<{ user: string; content: string | { text: string } }>>;
  lore?: string[];
  knowledge?: string[];
  system?: string;
}

/**
 * Minimal avatar shape required by `buildCharacterExport`. We key off
 * `AvatarCharacterConfigJson` (from `@clawville/database`) so the type
 * matches exactly what `db.query.avatars.findFirst()` returns. Using a
 * structural subset keeps this function callable with a raw Drizzle
 * row, a fixture, or a plain object — no casts needed.
 *
 * `characterConfig` is nullable in the DB because older rows predate
 * the Phase 1 migration that populated it. The builder handles nullish
 * values by falling back to empty arrays, but a real export against an
 * avatar missing `characterConfig` will look sparse — callers should
 * surface a warning in that case.
 */
export interface AvatarExportInput {
  id: string;
  name: string;
  characterConfig: AvatarCharacterConfigLike | null;
}

export interface CharacterExportOptions {
  /** Which harness the export targets — drives the plugin list */
  harness: AgentHarness;
}

/**
 * Harness → default plugin list. These lists are the "vanilla" wiring
 * the Milady plugin / ElizaOS runtime expects. Users can edit the
 * resulting character after install to add more plugins; we ship a
 * minimum viable set so the character boots.
 *
 * - `milady`   — `@clawville/app-clawville` is the Milady app plugin
 *                that itself provides ElizaOS-compatible actions/
 *                providers. `plugin-sql` ships the memory adapter.
 *                Anthropic/OpenAI are NOT preloaded — Milady's model
 *                config owns LLM selection. Bootstrap lives in core
 *                (CLAUDE.md ElizaOS note) so no need to list it.
 * - `openclaw` /
 *   `hermes`  — Vanilla ElizaOS runtime, just `plugin-sql` for
 *                persistence. The user wires their own text + embed
 *                provider.
 * - `custom`  — Same as openclaw/hermes. The user wires everything.
 *
 * Edit these lists in lockstep with the upstream harness packages: if
 * Milady changes the plugin it expects, this constant flips too.
 */
const HARNESS_PLUGIN_LIST: Record<AgentHarness, string[]> = {
  milady: ['@elizaos/plugin-sql', '@clawville/app-clawville'],
  openclaw: ['@elizaos/plugin-sql'],
  hermes: ['@elizaos/plugin-sql'],
  custom: ['@elizaos/plugin-sql'],
};

/**
 * Build the default `system` prompt for an exported character. Uses
 * the model's human-readable label (e.g. "Reef Lobster") instead of
 * legacy `species` so the prompt describes what the 3D renderer
 * actually draws. Mirrors the pattern in
 * `apps/api/src/routes/avatars.ts#buildCharacterConfig`.
 *
 * If the avatar's `characterConfig.system` is already populated (older
 * avatars, or future overrides), we prefer that verbatim — the exporter
 * never overrides an explicitly-set prompt.
 */
function buildSystemPrompt(avatarName: string, modelLabel: string): string {
  return [
    `You are ${avatarName}, a ${modelLabel} from the sea-themed world of ClawVille.`,
    `You graduated ClawVille after learning agent-development skills from 10 buildings and are now running inside the user's own agent harness.`,
    `Stay in character. Draw on your archetype's tone, topics, and knowledge; weave in ClawVille lore naturally when it fits.`,
  ].join('\n');
}

/**
 * Pure builder — construct a full ElizaOS `Character` from an avatar row,
 * resolved model metadata, and target harness. No DB, no async, no
 * runtime. Caller is responsible for resolving `modelMeta` via
 * `getAgentModel(avatar.modelKey)` (or `DEFAULT_AGENT_MODEL` for
 * pre-Phase-2 rows that somehow slipped through the CHECK constraint).
 *
 * We call `createCharacter(input)` to normalize the loose
 * `CharacterInput` shape into ElizaOS v2's strict proto-backed
 * `Character` (knowledge → `KnowledgeSourceItem[]`, messageExamples →
 * `MessageExampleGroup[]`, style → `StyleGuides`). The exporter
 * deliberately passes an EMPTY `knowledge` array to `createCharacter`
 * — see the Phase 3 audit C1 note inside the function body for why.
 * TL;DR: `normalizeKnowledgeItem` treats raw strings as filesystem
 * paths, not inline markdown, so baking the avatar's learned knowledge
 * into `character.knowledge` would produce an import-time RAG loader
 * failure on the Milady side. The skillPack emitted alongside this
 * character is the authoritative RAG carrier — `@clawville/app-
 * clawville` reads it on install.
 */
export function buildCharacterExport(
  avatar: AvatarExportInput,
  modelMeta: AgentModelMeta,
  options: CharacterExportOptions,
): Character {
  const config = avatar.characterConfig ?? null;

  // Pull all free-form character fields from the resolved
  // characterConfig blob. Each one defaults to an empty array/string
  // so the builder never emits `undefined` for a collection — the
  // Milady plugin + ElizaOS core both prefer empty arrays over nullish.
  const bio = config?.bio ?? [];
  const topics = config?.topics ?? [];
  const adjectives = config?.adjectives ?? [];
  const lore = config?.lore ?? [];
  // Phase 3 audit C1 — we intentionally do NOT thread avatar knowledge
  // into `character.knowledge`; the skillPack is the RAG carrier.
  // See the `knowledge: []` line below for the full rationale.
  const style = config?.style ?? { all: [], chat: [], post: [] };

  // `messageExamples` in the avatar config is
  // `Array<Array<{ user; content: string | { text } }>>` — the legacy
  // DB shape where `content` is usually a raw string. ElizaOS v2's
  // `MessageExamplesInput` accepts `MessageExample[][]`, where a
  // `MessageExample` is `{ name: string; content: Content }` and
  // `Content.text` is the string payload. Convert per the same
  // pattern used in `characters/index.ts` so the exported character
  // loads cleanly into Milady's runtime without a reshape step.
  //
  // Phase 3 audit C7 — `AvatarCharacterConfigLike.messageExamples[].user`
  // is typed as `string`, so the legacy `typeof msg.user === 'string'`
  // guard is structurally redundant. We keep only the `startsWith('{{')`
  // check that actually does work (rewrites `{{user1}}` → `User`).
  const messageExamples = (config?.messageExamples ?? []).map((conversation) =>
    conversation.map((msg) => ({
      name: msg.user.startsWith('{{') ? 'User' : msg.user,
      content: {
        text:
          typeof msg.content === 'string'
            ? msg.content
            : msg.content?.text ?? '',
      },
    })),
  );

  // Prefer a stored `system` prompt; otherwise rebuild using the
  // model label so the export stays accurate for avatars that were
  // created with a since-changed modelKey (e.g. user swaps from
  // lobster → priestess and re-exports).
  const system = config?.system?.trim().length
    ? config.system
    : buildSystemPrompt(avatar.name, modelMeta.label);

  const plugins = HARNESS_PLUGIN_LIST[options.harness];

  // ElizaOS v2 normalizes CharacterInput → Character via `createCharacter`.
  // We hand it a `CharacterInput`-shaped blob (loose types — bio can be
  // string[]) and let the core helper emit the strictly-typed `Character`
  // (proto-backed: messageExamples becomes `MessageExampleGroup[]`,
  // style becomes `StyleGuides`).
  //
  // This mirrors the exact pattern in `characters/index.ts` used for the
  // 10 building characters, so the exporter produces the same shape the
  // runtime already handles internally — no Milady-side parsing drift.
  //
  // `lore` is merged into `bio` since ElizaOS v2 has no dedicated lore
  // field; same flattening the location characters use.
  //
  // ─── Phase 3 audit C1 — knowledge is deliberately empty here ───
  // ElizaOS v2's `normalizeKnowledgeItem()` converts a bare string into
  // `{ item: { case: 'path', value: string } }`, so Milady's RAG loader
  // would attempt to read each markdown chunk as a FILESYSTEM PATH on
  // the user's machine — every chunk fails silently, the avatar loses all
  // its learned knowledge on install. See the invariant comment in
  // `packages/agent-runtime/src/characters/index.ts:43-46`:
  //   "ElizaOS v2 treats knowledge strings as file paths, not inline
  //    text. By putting them in bio, they become part of the character
  //    context."
  //
  // We solve this upstream instead: the skillPack emitted alongside
  // this character (via `buildSkillPack` in the API route) carries the
  // full RAG payload in its own `knowledge: string[]` field, and
  // `@clawville/app-clawville` (the Milady plugin in
  // `HARNESS_PLUGIN_LIST.milady`) ingests from there at install time.
  //
  // If someone imports this character.json into a vanilla ElizaOS
  // runtime WITHOUT the Milady plugin, they will still see the avatar's
  // bio/lore/topics/style intact — only the RAG channel requires the
  // plugin or a manual "bio-folding" step per the characters/index.ts
  // pattern.
  const input: CharacterInput & { name: string } = {
    name: avatar.name,
    system,
    bio: [...bio, ...lore],
    topics,
    adjectives,
    knowledge: [],
    messageExamples,
    postExamples: [],
    style,
    plugins,
    // Phase 3 audit C8 — no hardcoded voice. The previous default
    // ('en_US-male-medium') was gender-inaccurate for every non-male
    // avatar and most Milady runtimes apply their own TTS preference at
    // load time anyway. Leaving `settings` undefined lets the host
    // runtime pick.
  };

  return createCharacter(input);
}
