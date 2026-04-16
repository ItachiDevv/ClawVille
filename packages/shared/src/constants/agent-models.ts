/**
 * Agent model registry — the single source of truth for valid `modelKey`
 * and `category` values used on the `pets` row (Phase 2 schema). Consumed
 * by both the API (Zod validation) and the web (3D model lookup).
 *
 * NOTE: This file MUST NOT import Three.js — it runs server-side. The
 * path/scale metadata per model lives web-side in
 * `apps/web/src/lib/three/agent-model-registry.ts` which augments each
 * entry here with asset paths.
 */

export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'other';
export type AgentHarness = 'openclaw' | 'hermes' | 'milady' | 'custom';

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
 */
export const AGENT_MODELS: readonly AgentModelMeta[] = [
  // ── OpenClaw (crustaceans) ──
  { key: 'lobster', label: 'Reef Lobster', category: 'openclaw' },
  { key: 'crayfish', label: 'Crayfish', category: 'openclaw' },
  { key: 'sweet_crab', label: 'Sweet Crab', category: 'openclaw' },
  { key: 'lobster_plush', label: 'Lobster Plush', category: 'openclaw' },
  { key: 'hermitcrab', label: 'Hermit Crab', category: 'openclaw' },

  // ── Hermes (anime humanoids) ──
  { key: 'chihiro', label: 'Chihiro', category: 'hermes' },
  { key: 'chibi_goku', label: 'Chibi Goku', category: 'hermes' },

  // ── Milady (Milady-aligned characters) ──
  { key: 'priestess', label: 'Young Priestess', category: 'milady' },

  // ── Other (sea creatures) ──
  { key: 'jellyfish', label: 'Jellyfish', category: 'other' },
  { key: 'octopus', label: 'Octopus', category: 'other' },
  { key: 'seahorse', label: 'Sea Horse', category: 'other' },
] as const;

/** All valid model keys — used by Zod to validate API input */
export const AGENT_MODEL_KEYS: readonly string[] = AGENT_MODELS.map((m) => m.key);

/** All valid category strings — matches DB CHECK constraint */
export const AGENT_CATEGORIES: readonly AgentCategory[] = [
  'openclaw',
  'hermes',
  'milady',
  'other',
];

/** All valid harness strings — matches DB CHECK constraint */
export const AGENT_HARNESSES: readonly AgentHarness[] = [
  'openclaw',
  'hermes',
  'milady',
  'custom',
];

/** Look up a model's metadata by key; returns `undefined` for unknown keys */
export function getAgentModel(key: string): AgentModelMeta | undefined {
  return AGENT_MODELS.find((m) => m.key === key);
}

/** Default model for unconnected visitors — per Phase 1 rule */
export const DEFAULT_AGENT_MODEL: AgentModelMeta = AGENT_MODELS[0]; // lobster
