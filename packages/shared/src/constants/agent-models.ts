/**
 * Agent model registry — the single source of truth for valid `modelKey`
 * and `category` values used on the `pets` row (Phase 2 schema). Consumed
 * by both the API (Zod validation) and the web (3D model lookup).
 *
 * NOTE: This file MUST NOT import Three.js — it runs server-side. The
 * path/scale metadata per model lives web-side in
 * `apps/web/src/lib/three/agent-model-registry.ts` which augments each
 * entry here with asset paths.
 *
 * Typing strategy (Phase 2 audit Fix A): every enum-like constant is
 * declared `as const` so the array type is a tuple literal (e.g.
 * `readonly ['openclaw', 'hermes', ...]`). Consumers can then write
 * plain `z.enum(AGENT_CATEGORIES)` without the
 * `as unknown as [T, ...T[]]` cast dance, and the TS types are derived
 * FROM the const arrays so adding a value in one place can't fall out
 * of sync with the type.
 */

// ── Categories ──────────────────────────────────────────────────────────────
// DB CHECK constraint `pets_agent_category_valid` mirrors this list. If
// you add a value here, update the check() call in packages/database/src/
// schema/pets.ts in the same diff and run `bun run db:push`.
export const AGENT_CATEGORIES = [
  'openclaw',
  'hermes',
  'milady',
  'other',
] as const;
export type AgentCategory = typeof AGENT_CATEGORIES[number];

// ── Harnesses ───────────────────────────────────────────────────────────────
// DB CHECK constraint `pets_harness_valid` mirrors this list. Same rule
// as AGENT_CATEGORIES — keep the DB and this list in sync.
export const AGENT_HARNESSES = [
  'openclaw',
  'hermes',
  'milady',
  'custom',
] as const;
export type AgentHarness = typeof AGENT_HARNESSES[number];

export interface AgentModelMeta {
  /** Stable key — used as `pets.model_key` in DB + sessionStorage */
  key: string;
  /** Display label shown in the category picker */
  label: string;
  /** Which agent-framework category this model belongs to */
  category: AgentCategory;
}

/**
 * Canonical registry. Order here drives the order of cards in the
 * `/create-agent` picker. Add new models to this array AND ship the
 * matching GLB at `apps/web/public/models/<key>.glb` (or override the
 * path in the web-side registry).
 *
 * `as const satisfies readonly AgentModelMeta[]` preserves the literal
 * `key` / `label` / `category` strings in the inferred type, so
 * `AgentModelKey` below can be a union of literal keys instead of
 * widening to `string`.
 */
export const AGENT_MODELS = [
  // ── OpenClaw (crustaceans) ──
  { key: 'lobster',       label: 'Reef Lobster',    category: 'openclaw' },
  { key: 'crayfish',      label: 'Crayfish',        category: 'openclaw' },
  { key: 'sweet_crab',    label: 'Sweet Crab',      category: 'openclaw' },
  { key: 'lobster_plush', label: 'Lobster Plush',   category: 'openclaw' },
  { key: 'hermitcrab',    label: 'Hermit Crab',     category: 'openclaw' },

  // ── Other (sea creatures) ──
  { key: 'jellyfish',     label: 'Jellyfish',       category: 'other' },
  { key: 'octopus',       label: 'Octopus',         category: 'other' },
  { key: 'seahorse',      label: 'Sea Horse',       category: 'other' },

  // NOTE: Hermes/Milady anime GLB entries (chihiro / priestess / chibi_goku)
  // were removed 2026-04-16 because the source meshes didn't render reliably
  // in the agent picker. The `AgentCategory` type keeps 'hermes' and 'milady'
  // because the agent-HARNESS radio and DB CHECK constraint still use them
  // — this change scopes strictly to the visual avatar picker content.
] as const satisfies readonly AgentModelMeta[];

/** Union of every valid model `key` — e.g. `'lobster' | 'crayfish' | ...` */
export type AgentModelKey = typeof AGENT_MODELS[number]['key'];

/**
 * All valid model keys as a tuple — used by Zod `.refine` and any caller
 * that needs a concrete array to iterate. Typed `readonly AgentModelKey[]`
 * so `.includes(x)` narrows correctly and no `as any` is needed at call
 * sites. The underlying runtime array is identical to before.
 */
export const AGENT_MODEL_KEYS: readonly AgentModelKey[] = AGENT_MODELS.map(
  (m) => m.key,
) as readonly AgentModelKey[];

// ── Defaults ────────────────────────────────────────────────────────────────
// Named constants mirror the DB column defaults in pets.ts so the API,
// web, and DB all pick the same values when a field is omitted. Fix H3:
// DEFAULT_AGENT_MODEL used to be `AGENT_MODELS[0]`, a silent-break
// landmine if the registry were ever reordered. Now it's derived from
// the keyed constant below and asserts at module-load that the key
// exists.
export const DEFAULT_AGENT_MODEL_KEY: AgentModelKey = 'lobster';
export const DEFAULT_AGENT_CATEGORY: AgentCategory = 'openclaw';
export const DEFAULT_AGENT_HARNESS: AgentHarness = 'milady';

const _defaultModel = AGENT_MODELS.find((m) => m.key === DEFAULT_AGENT_MODEL_KEY);
if (!_defaultModel) {
  // Unreachable in practice — TS narrows DEFAULT_AGENT_MODEL_KEY to a
  // member of AgentModelKey, which by construction is a key in
  // AGENT_MODELS. The guard catches a future registry edit that removes
  // the default without updating this constant in the same diff.
  throw new Error(
    `AGENT_MODELS must contain DEFAULT_AGENT_MODEL_KEY ('${DEFAULT_AGENT_MODEL_KEY}')`,
  );
}

/** Default model metadata for unconnected visitors — per Phase 1 rule */
export const DEFAULT_AGENT_MODEL: AgentModelMeta = _defaultModel;

// ── Lookup helpers ──────────────────────────────────────────────────────────

/** Look up a model's metadata by key; returns `undefined` for unknown keys */
export function getAgentModel(key: string): AgentModelMeta | undefined {
  return AGENT_MODELS.find((m) => m.key === key);
}

/**
 * Returns the expected category for a `modelKey`, or undefined if the key
 * is unknown. Used server-side to cross-validate client-supplied
 * `(modelKey, agentCategory)` pairs so a mismatched payload (e.g.
 * `modelKey: 'jellyfish'` in category `'openclaw'`) is rejected early
 * instead of drifting into the DB.
 */
export function getAgentCategoryForModel(modelKey: string): AgentCategory | undefined {
  return AGENT_MODELS.find((m) => m.key === modelKey)?.category;
}
