# Phase 2 — agentCategory + modelKey schema persistence

**Status:** PLANNING — not implemented.
**Date:** 2026-04-16
**Depends on:** Phase 1 complete and merged. Phase 1 ships the new fields on
the sessionStorage payload; Phase 2 persists them to the DB.
**Blocks:** Phase 3 (export API reads these fields to produce the character
bundle).

---

## 1. Goal

Take the `modelKey`, `category`, and `harness` fields introduced in Phase 1's
sessionStorage payload and make them first-class DB-persisted attributes of a
pet, so that:

- A pet's visual identity (`modelKey`) survives across sessions, not just
  creation.
- A pet's agent-framework category (`category`) can drive future per-framework
  logic (Milady install flow, Hermes-specific chat routing, etc.).
- A pet's harness preference (`harness`) is queryable for the Phase 3 export.
- The legacy `species` column stays readable (backwards compat) but becomes
  derived/optional going forward.

---

## 2. Non-goals

- No UI changes in this phase beyond the minimal form-to-API wiring. The
  create-agent page already gathers the data in Phase 1; we just route it
  through.
- No removal of the `species` column. Legacy column stays, populated with a
  derived fallback on create.
- No retro-tagging of existing pets beyond the one-shot backfill described
  in §6.
- No change to `pets.characterConfig` JSONB — the archetype-resolved character
  still lives there.

---

## 3. Schema changes

### 3.1 New columns on `pets`

```sql
ALTER TABLE pets ADD COLUMN agent_category varchar(16)
  NOT NULL DEFAULT 'openclaw'
  CHECK (agent_category IN ('openclaw','hermes','milady','other'));

ALTER TABLE pets ADD COLUMN model_key varchar(64)
  NOT NULL DEFAULT 'lobster';

ALTER TABLE pets ADD COLUMN harness varchar(16)
  NOT NULL DEFAULT 'milady'
  CHECK (harness IN ('openclaw','hermes','milady','custom'));
```

Drizzle schema edit at `packages/database/src/schema/pets.ts`:

```ts
agentCategory: varchar('agent_category', { length: 16 })
  .notNull()
  .default('openclaw')
  .$type<'openclaw' | 'hermes' | 'milady' | 'other'>(),
modelKey: varchar('model_key', { length: 64 })
  .notNull()
  .default('lobster'),
harness: varchar('harness', { length: 16 })
  .notNull()
  .default('milady')
  .$type<'openclaw' | 'hermes' | 'milady' | 'custom'>(),
```

The defaults ensure **backward compatibility**: every existing pet row gets
`('openclaw', 'lobster', 'milady')` automatically on migration. Matches the
"default to lobster / default to Milady harness" product rule from Phase 1.

### 3.2 Migration execution

Per `CLAUDE.md` §Database migrations: run `bun run db:push` from repo root
after schema edits. This is an **additive** migration — no destructive flag
required. Verify via drizzle-studio or `psql`:

```sql
SELECT agent_category, model_key, harness, COUNT(*)
FROM pets
GROUP BY 1,2,3;
```

Expect all existing pets to land in `('openclaw','lobster','milady')`.

---

## 4. API changes

### 4.1 `POST /api/pets` (createPet)

Route file: `apps/api/src/routes/pets.ts`.

Zod input schema gains three fields:

```ts
modelKey: z.string().min(1).max(64),
agentCategory: z.enum(['openclaw','hermes','milady','other']),
harness: z.enum(['openclaw','hermes','milady','custom']),
```

Server-side validation: cross-check `modelKey` against the shared
`MODEL_REGISTRY` keys so we never accept a modelKey that doesn't resolve to a
real GLB. The registry will be imported from `@clawville/shared` — see §4.2.

### 4.2 Shared registry promotion

The `MODEL_REGISTRY` lives in `apps/web/src/lib/three/agent-model-registry.ts`
after Phase 1. Server needs to validate against it, so the registry must be
split: the **data** (model keys, categories, labels) moves to
`packages/shared/src/constants/agent-models.ts` with no Three.js imports;
the **path-and-scale** metadata stays web-side because the API never needs it.

New file `packages/shared/src/constants/agent-models.ts`:
```ts
export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'other';
export type AgentHarness  = 'openclaw' | 'hermes' | 'milady' | 'custom';

export interface AgentModelMeta {
  key: string;         // used as modelKey in DB + sessionStorage
  label: string;       // display name
  category: AgentCategory;
}

export const AGENT_MODELS: readonly AgentModelMeta[] = [
  { key: 'lobster',       label: 'Reef Lobster',    category: 'openclaw' },
  { key: 'crayfish',      label: 'Crayfish',        category: 'openclaw' },
  { key: 'sweet_crab',    label: 'Sweet Crab',      category: 'openclaw' },
  { key: 'lobster_plush', label: 'Lobster Plush',   category: 'openclaw' },
  { key: 'hermitcrab',    label: 'Hermit Crab',     category: 'openclaw' },
  { key: 'chihiro',       label: 'Chihiro',         category: 'hermes' },
  { key: 'priestess',     label: 'Young Priestess', category: 'milady' },
  { key: 'chibi_goku',    label: 'Chibi Goku',      category: 'milady' },
  { key: 'jellyfish',     label: 'Jellyfish',       category: 'other' },
  { key: 'octopus',       label: 'Octopus',         category: 'other' },
  { key: 'seahorse',      label: 'Sea Horse',       category: 'other' },
];

export const AGENT_MODEL_KEYS = AGENT_MODELS.map(m => m.key);
```

The web-side `agent-model-registry.ts` imports `AGENT_MODELS` from
`@clawville/shared` and augments each entry with the path/scale metadata
locally.

### 4.3 `GET /api/pets/me` response shape

Pet response gains three fields — pure passthrough from DB. No transform.
TypeScript type: regenerate from Drizzle schema.

---

## 5. Frontend changes

### 5.1 `useCreatePet` hook

File: `apps/web/src/hooks/use-pet.ts` — extend the mutation body type to
include `modelKey`, `agentCategory`, `harness`.

### 5.2 Personality page (`create-agent/personality/page.tsx`)

Pull `modelKey`, `category`, `harness` out of sessionStorage and pass to
`createPetMutation.mutateAsync(...)`.

### 5.3 Pet type + store

`usePet` hook's inferred type gets the new fields automatically via Drizzle
re-export. Any component that renders pet identity (pet-status-bar, game HUD,
etc.) gets them for free.

### 5.4 Downstream consumers

Grep for `pet.species` usages. Where the code was using `species` as a visual
identifier (sprite picking, 3D model picking for the player's own agent), it
should migrate to `pet.modelKey`. Concrete hit list to audit:

- `apps/web/src/lib/three/player-pet.tsx` — switch from species-based model
  to `pet.modelKey`-based model lookup via `AGENT_MODELS`.
- `apps/web/src/components/pixi/*` — PixiJS sprites (if they exist in this
  file list) were species-keyed. The 2D fallback keeps species for now since
  we don't have per-modelKey pixel sprites; species is the visual fallback
  there. Flag this as technical debt, not blocking.

---

## 6. Backfill

The DEFAULT clause auto-fills existing rows, so no separate backfill query
needed. BUT: some existing pets may have species values that should map to a
more specific model. Example: an existing pet with `species='wolf'` displays
as a wolf sprite in the 2D fallback but would default to `lobster` in 3D. For
Phase 2 MVP, we accept this: all existing pets become lobsters in 3D, their
species column preserves the original fantasy-species for 2D fallback.

Users can re-customize via a future "Edit Agent" flow (not this phase).

---

## 7. Acceptance criteria

- `bun run db:push` runs cleanly against Supabase with no destructive flag.
- `SELECT agent_category, model_key, harness FROM pets LIMIT 5;` returns rows
  with non-null values populated from defaults.
- `POST /api/pets` with a new payload containing the three fields succeeds
  and round-trips the values.
- `POST /api/pets` with an invalid `modelKey` (e.g. `"notarealmodel"`)
  returns 400 with a descriptive error.
- The `/create-agent/personality` flow creates a pet that, when read back via
  `GET /api/pets/me`, has the exact `modelKey`/`agentCategory`/`harness` the
  user selected.
- `bun run build` passes at the monorepo root.
- The migration is safe to rollback (the columns are additive; worst case
  we `ALTER TABLE pets DROP COLUMN ...` — no data loss on other columns).

---

## 8. Testing plan

1. Push schema change, run `bun run db:push`, verify via `psql` or Drizzle
   Studio.
2. Deploy to Hetzner.
3. Create a new pet via the game flow with a non-default model (e.g.
   `priestess` + `milady` harness). Verify via `GET /api/pets/me`.
4. Query an existing pet row, verify its defaults were applied.
5. Attempt to POST with an invalid `modelKey` — confirm 400 response.

---

## 9. Audit plan

Same pattern as Phase 1 §11: first pass after implementation, fix all bugs,
second pass on the fix commit. Focus areas:

- Zod schema correctness (enum values match DB CHECK constraints exactly).
- Drizzle column types aligned with the shared TS types.
- No `pet.species` references left in 3D rendering code paths.
- No frontend code that assumes `modelKey` is nullable (it has a NOT NULL
  DEFAULT — always populated).
- The shared `AGENT_MODELS` array is the **single source of truth** for valid
  model keys; no hardcoded lists elsewhere.

---

## 10. Docs to update at merge time

Per `CLAUDE.md` §Documentation Update Policy:

- `CLAUDE.md` — update the "Database Schema" bullet list under the pets row
  to include the three new columns.
- `ARCHITECTURE.md` — if it has a DB schema table, add the columns.
- `README.md` — if it lists env or schema highlights, check and update.
