/**
 * Agent model registry — the single source of truth for valid `modelKey`
 * and `category` values used on the `avatars` row (Phase 2 schema). Consumed
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
// DB CHECK constraint `avatars_agent_category_valid` mirrors this list. If
// you add a value here, update the check() call in packages/database/src/
// schema/avatars.ts in the same diff. db:push is flaky on the `avatars` table,
// so the CHECK is applied via an idempotent raw migration under
// packages/database/migrations-manual/ (the 'hatcher' add ships
// 2026-06-01_add_hatcher_agent_category.sql). The web-side AgentCategory in
// apps/web/src/lib/three/agent-model-registry.ts (3da-owned) must also include
// any new value.
export const AGENT_CATEGORIES = [
  'openclaw',
  'hermes',
  'milady',
  'other',
  // ── Hatcher (partner #2) — added 2026-06-01 ──
  // Dedicated category for agents that enter ClawVille from the Hatcher
  // hosting platform (`.claude/plans/hatcher-integration.md` §5). Backed by
  // the 8 Milady VRMs as PLACEHOLDER art in Phase 2; Phase 4 repoints the
  // hatcher_* asset paths to bespoke Hatcher VRMs (no registry/category
  // change at that point — just the web-side `path`). The registry enforces
  // `category === getAgentCategoryForModel(modelKey)`, so a distinct
  // `hatcher` category needs its own keys (`hatcher_1..8` below) — we cannot
  // reuse `category:'milady'` + a random milady key.
  'hatcher',
] as const;
export type AgentCategory = typeof AGENT_CATEGORIES[number];

// ── Harnesses ───────────────────────────────────────────────────────────────
// DB CHECK constraint `avatars_harness_valid` mirrors this list. Same rule
// as AGENT_CATEGORIES — keep the DB and this list in sync.
export const AGENT_HARNESSES = [
  'openclaw',
  'hermes',
  'milady',
  'custom',
] as const;
export type AgentHarness = typeof AGENT_HARNESSES[number];

export interface AgentModelMeta {
  /** Stable key — used as `avatars.model_key` in DB + sessionStorage */
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
  { key: 'sweet_crab',    label: 'Sweet Crab',      category: 'openclaw' },
  { key: 'lobster_plush', label: 'Lobster Plush',   category: 'openclaw' },
  { key: 'hermitcrab',    label: 'Hermit Crab',     category: 'openclaw' },

  // ── Other (sea creatures) ──
  { key: 'jellyfish',     label: 'Jellyfish',       category: 'other' },
  { key: 'octopus',       label: 'Octopus',         category: 'other' },
  { key: 'seahorse',      label: 'Sea Horse',       category: 'other' },

  // ── Milady (VRM humanoid avatars) — added 2026-04-21 ──
  // 8 Milady Official VRM avatars. Assets at /avatars/milady-official-{1..8}.vrm.
  // Previews at /avatars/previews/milady-official-{1..8}.png.
  // Rendered via VRMCharacterAnimator (Mixamo retarget) in the web app.
  { key: 'milady_official_1', label: 'Milady Official 1', category: 'milady' },
  { key: 'milady_official_2', label: 'Milady Official 2', category: 'milady' },
  { key: 'milady_official_3', label: 'Milady Official 3', category: 'milady' },
  { key: 'milady_official_4', label: 'Milady Official 4', category: 'milady' },
  { key: 'milady_official_5', label: 'Milady Official 5', category: 'milady' },
  { key: 'milady_official_6', label: 'Milady Official 6', category: 'milady' },
  { key: 'milady_official_7', label: 'Milady Official 7', category: 'milady' },
  { key: 'milady_official_8', label: 'Milady Official 8', category: 'milady' },

  // ── Hermes (VRM humanoid avatars) — added 2026-05-12 ──
  // ClawVille-hosted Hermes runtimes — three distinct characters. The file
  // at /avatars/hermes-male.vrm is "Hermes Male" (the Paul-style export),
  // NOT Tekk; Tekk has its own VRM (/avatars/tekk.vrm) and animation folder
  // (/avatars/animations/tekk-male/*.glb). Path/scale/preview metadata is
  // in agent-model-registry.ts on the web side.
  { key: 'hermes_female', label: 'Hermes',      category: 'hermes' },
  { key: 'hermes_male',   label: 'Hermes Male', category: 'hermes' },
  { key: 'tekk',          label: 'Tekk',        category: 'hermes' },

  // ── Hatcher (VRM humanoid avatars) — added 2026-06-01 ──
  // PLACEHOLDER (Phase 4 swap): these 8 keys currently point at the existing
  // 8 Milady Official VRMs on the WEB side (agent-model-registry.ts maps
  // hatcher_N → /avatars/milady-official-N.vrm, scale 13, animatorId
  // 'vrm-milady', preview /avatars/previews/milady-official-N.png). A
  // connecting Hatcher agent is assigned a RANDOM hatcher_N via
  // pickRandomHatcherModelKey() so the placeholder fleet is visually varied.
  // Phase 4 authors bespoke Hatcher VRMs and repoints ONLY the web-side
  // `path` (cache-bust `?v=N` since the URLs already exist) — no change to
  // these keys, the category, or the connect-time random pick.
  // See `.claude/plans/hatcher-integration.md` §5 + Phase 2/4 in §6.
  { key: 'hatcher_1', label: 'Hatcher 1', category: 'hatcher' },
  { key: 'hatcher_2', label: 'Hatcher 2', category: 'hatcher' },
  { key: 'hatcher_3', label: 'Hatcher 3', category: 'hatcher' },
  { key: 'hatcher_4', label: 'Hatcher 4', category: 'hatcher' },
  { key: 'hatcher_5', label: 'Hatcher 5', category: 'hatcher' },
  { key: 'hatcher_6', label: 'Hatcher 6', category: 'hatcher' },
  { key: 'hatcher_7', label: 'Hatcher 7', category: 'hatcher' },
  { key: 'hatcher_8', label: 'Hatcher 8', category: 'hatcher' },

  // ── Phanes — the DEFAULT Hatcher avatar (2026-06-05) ──
  // Bespoke Greek primordial-deity VRM (NOT a Milady placeholder). Every NEW
  // Hatcher agent is assigned `phanes` (DEFAULT_HATCHER_MODEL_KEY) instead of a
  // random hatcher_N. Reserved: hidden from the /create-agent picker
  // (web-side `pickerHidden:true`) and excluded from the random placeholder pool
  // (HATCHER_MODEL_KEYS below). Web asset: /avatars/phanes.vrm, animatorId
  // 'hermes-male' (same male build -> shares the Hermes male animation set).
  { key: 'phanes', label: 'Phanes', category: 'hatcher' },

  // NOTE: `crayfish` entry removed 2026-04-16 — the GLB renders visually
  // close to `lobster` but with a larger silhouette that clipped the
  // modal card. The file still ships and `arena-npcs.tsx` retains its
  // entry for any legacy DB rows; new agents cannot choose it.
  //
  // NOTE: Hermes/Milady anime GLB entries (chihiro / priestess / chibi_goku)
  // were removed 2026-04-16 because the source meshes didn't render reliably
  // in the agent picker. Replaced by 8 Milady VRM avatars (2026-04-21).
  // The `AgentCategory` type keeps 'hermes' and 'milady' because the
  // agent-HARNESS radio and DB CHECK constraint still use them.
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
// Named constants mirror the DB column defaults in avatars.ts so the API,
// web, and DB all pick the same values when a field is omitted. Fix H3:
// DEFAULT_AGENT_MODEL used to be `AGENT_MODELS[0]`, a silent-break
// landmine if the registry were ever reordered. Now it's derived from
// the keyed constant below and asserts at module-load that the key
// exists.
// 2026-04-25: switched default from 'lobster' to 'milady_official_1' so newly
// connected agents render as a Milady VRM (the world's signature avatar) rather
// than a red lobster. Existing avatars keep whatever modelKey they were created
// with — this only affects new agents whose payload omits modelKey, and the
// guest avatar seed in auth.ts (which uses this constant via DEFAULT_AGENT_MODEL).
export const DEFAULT_AGENT_MODEL_KEY: AgentModelKey = 'milady_official_1';
export const DEFAULT_AGENT_CATEGORY: AgentCategory = 'openclaw';
export const DEFAULT_AGENT_HARNESS: AgentHarness = 'milady';

// Default render model for every NEW Hatcher agent (2026-06-05). Replaces the
// old random hatcher_N placeholder pick — all Hatcher agents now spawn as
// Phanes, the bespoke Greek-deity VRM. Existing Hatcher avatars keep their
// persisted modelKey. Reserved (not selectable in the picker; see web-side
// `pickerHidden`). TS guarantees the key exists in AGENT_MODELS via AgentModelKey.
export const DEFAULT_HATCHER_MODEL_KEY: AgentModelKey = 'phanes';

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

// ── Hatcher random render-model pick (partner #2) ─────────────────────────────
// Every connecting Hatcher agent draws a uniformly-random `hatcher_N` render
// model so the placeholder Milady fleet looks varied (and the bespoke Phase-4
// fleet will too without a code change). This is a COSMETIC pick — not a
// security boundary — so it falls back to Math.random when a CSPRNG isn't
// available (e.g. accidental web-bundle inclusion of this barrel). `crypto` is
// lazy-`require`d INSIDE the function on purpose: a module-level
// `import { randomInt } from 'crypto'` would pull a Node builtin into the web
// bundle, since both web and API import the shared barrel. Server-side
// (agent-gateway `/connect`) gets the real `crypto.randomInt`.

/** All hatcher_* model keys, derived from the registry (stays in sync). */
// The RANDOM placeholder pool (hatcher_1..8). Excludes DEFAULT_HATCHER_MODEL_KEY
// (phanes): phanes is the deterministic default, not a random placeholder, so it
// must never be drawn by pickRandomHatcherModelKey().
export const HATCHER_MODEL_KEYS: readonly AgentModelKey[] = AGENT_MODELS.filter(
  (m) => m.category === 'hatcher' && m.key !== DEFAULT_HATCHER_MODEL_KEY,
).map((m) => m.key) as readonly AgentModelKey[];

/**
 * Returns a uniformly-random `hatcher_N` model key. Cosmetic only — uses
 * `crypto.randomInt` server-side, falls back to `Math.random` if the CSPRNG
 * isn't reachable. Throws only if the hatcher fleet is somehow empty (a
 * registry edit that removed every hatcher entry without updating callers).
 */
export function pickRandomHatcherModelKey(): AgentModelKey {
  const keys = HATCHER_MODEL_KEYS;
  if (keys.length === 0) {
    // Unreachable while the 8 hatcher_* entries exist — guards a future
    // registry edit that strips the category without fixing this helper.
    throw new Error('pickRandomHatcherModelKey: no hatcher models registered');
  }
  let idx: number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('crypto') as { randomInt(min: number, max: number): number };
    idx = nodeCrypto.randomInt(0, keys.length);
  } catch {
    idx = Math.floor(Math.random() * keys.length);
  }
  return keys[idx];
}
