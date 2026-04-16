# Phase 3 — Character export API

**Status:** PLANNING — not implemented.
**Date:** 2026-04-16
**Depends on:** Phase 2 complete and merged. Needs `modelKey`, `agentCategory`,
`harness` columns on the `pets` table.
**Blocks:** Phase 4a (UI wraps the payload this endpoint produces).

---

## 1. Goal

Add a single new API route that emits a complete "take my agent home" bundle
for any pet owned by the authenticated user. The bundle is:

- A valid ElizaOS `Character` JSON the user can import into their own Milady
  (or any other Eliza-based runtime).
- A `SkillPack` array, one entry per building whose 2 knowledge books the pet
  has learned, in the Milady-skill-install shape defined at
  `packages/shared/src/constants/milady-skills.ts`.
- A pre-built `miladyInstallPayload` — the exact JSON body the user's local
  Milady accepts at `POST /api/plugins/install`, so Phase 4a can POST it
  verbatim.
- An `installCommand` string — a copy-paste `curl` one-liner that hits the
  user's local Milady directly for CLI-inclined users.

The endpoint is **API-only** in this phase. No UI wires to it until Phase 4a.

---

## 2. Non-goals

- No hosted runtime. See `AgentHosting.md` §1.3 for why Phase 4b is deferred.
- No delivery to Milady from our server. The payload is emitted here; the
  client posts it from the user's browser in Phase 4a.
- No agent lifecycle tracking. Exporting is a stateless snapshot. The pet in
  ClawVille remains unchanged; the exported character is a copy.
- No chain-of-custody / signature. If this becomes a marketplace concern
  later, add a signed `issuedAt` + `exportHash` field — not in Phase 3.
- No versioning negotiation. The export targets a fixed ElizaOS core version
  (the one we ship today). Phase 3 ships v1 of the bundle shape; Phase 5+
  handles schema drift if Milady upgrades faster than we do.

---

## 3. Route

### 3.1 Endpoint

```
POST /api/agent/export-character
```

Authed — same `lucia` session cookie used by the rest of `apps/api`.

### 3.2 Input

```ts
{
  petId: string;             // UUID — must be owned by the session user
  targetHarness?: AgentHarness;  // defaults to pet.harness
}
```

Zod schema validates and looks up the pet, rejects if the session user does
not own it (403).

### 3.3 Output

```ts
{
  character: ElizaCharacter;
  skillPack: SkillPackEntry[];
  miladyInstallPayload: { plugin: string; config: object };
  installCommand: string;       // curl one-liner
  exportedAt: string;           // ISO timestamp
  summary: {
    modelKey: string;
    agentCategory: AgentCategory;
    harness: AgentHarness;
    skillsCount: number;
    knowledgeCount: number;
  };
}
```

`ElizaCharacter` type: pull from `@elizaos/core`'s exported `Character` type
via the `@clawville/agent-runtime` re-export.

---

## 4. Shape of `character`

Assembled from existing data:

- **Name / bio / lore / topics / adjectives / knowledge / messageExamples /
  style** — all already present in the resolved `pets.characterConfig` JSONB
  (populated at create time from `PET_ARCHETYPES`, with `learnBook` appends
  from the 10 knowledge books).
- **Plugins** — `['@elizaos/plugin-sql', '@elizaos/plugin-anthropic',
  '@elizaos/plugin-openai']` or the Milady equivalent (Milady ships its own
  plugin set). Harness-specific branch lives in
  `apps/api/src/services/character-exporter.ts`:
  - `harness === 'milady'` → emit Milady-compatible plugin list (to be
    confirmed against `@clawville/app-clawville` plugin spec).
  - `harness === 'openclaw' | 'hermes'` → emit ElizaOS vanilla list.
  - `harness === 'custom'` → emit vanilla + note that the user wires their
    own providers.
- **Settings.voice / model** — inherit defaults; let user override after
  install.

This builder already exists partially in `character-loader.ts` of
`agent-runtime`. Refactor the useful bits into a pure function:

```ts
// packages/agent-runtime/src/character-exporter.ts (new)
export function buildCharacterExport(pet: Pet, options: {
  harness: AgentHarness;
  includeSkills?: boolean;
}): ElizaCharacter
```

No runtime is started; pure object construction.

---

## 5. Shape of `skillPack`

One entry per building whose knowledge books this pet has fully learned.
"Fully learned" = the pet's `characterConfig.knowledge[]` array contains both
book entries for that building.

```ts
interface SkillPackEntry {
  skillId: string;      // from BUILDING_MILADY_SKILLS
  name: string;
  description: string;
  category: string;
  buildingId: string;
  knowledge: string[];  // markdown-per-chunk
  source: 'clawville';
  exportedFrom: {
    petId: string;
    petName: string;
  };
}
```

Query: join `pet_inventory` + `knowledge-books.ts` mappings to determine what
the pet has. Reuse logic from the existing
`api.exportKnowledge(petId)` endpoint — DO NOT duplicate.

---

## 6. `miladyInstallPayload`

The format that the user's local Milady `/api/plugins/install` endpoint
accepts. Target schema (confirm by reading `@clawville/app-clawville` plugin
docs before coding):

```ts
{
  plugin: '@clawville/app-clawville',
  config: {
    character,
    skills: skillPack,
    source: {
      url: 'https://clawville.world',
      petId: pet.id,
      exportedAt: iso,
    }
  }
}
```

Milady treats this as a one-shot install — user runs it against their local
Milady and the character appears in their agent list.

---

## 7. `installCommand`

One-liner a CLI user can paste into a terminal. Assumes user's Milady is on
`localhost:4000`:

```
curl -X POST http://localhost:4000/api/plugins/install -H 'Content-Type: application/json' -d '<miladyInstallPayload-as-json>'
```

JSON-safe: escape any single quotes in the payload, or emit `-d @-` with a
here-doc variant. Pick shell-safe encoding — the UI will let users copy it
verbatim. Default port `4000` is Milady convention; we let the UI override
it in Phase 4a.

---

## 8. Security + rate limit

- **Auth.** Only the session owner of the pet can export it. 403 on
  mismatch.
- **Rate limit.** Reuse the `/api/agent/connect` rate limiter pattern (10
  per-IP per minute) for this route too — no reason to allow spam exports.
- **PII.** The export contains no user email / session token. It contains
  pet name, archetype, knowledge — all of which the user created. No leak
  surface beyond what they already gave us.
- **Abuse.** A malicious user could export, then modify, then re-submit to
  somewhere. Since we emit a snapshot and don't claim cryptographic
  integrity, this is "their agent, they can do what they want." Document the
  lack of signing as explicit policy in the route doc string.

---

## 9. Acceptance criteria

- `POST /api/agent/export-character` returns the full bundle for a pet the
  caller owns.
- Returns 403 if the pet is owned by a different user.
- Returns 404 if the pet doesn't exist.
- Returns 400 with a Zod error if the payload is malformed.
- The returned `character.knowledge.length` equals the pet's
  `characterConfig.knowledge.length`.
- The returned `skillPack.length` matches the count of fully-learned
  buildings.
- The returned `installCommand` is a single shell-safe line.
- `bun run build` passes.

---

## 10. Testing plan

1. Push route, deploy to Hetzner.
2. `curl -X POST https://api.clawville.world/api/agent/export-character
   --cookie "$(…session cookie…)" -d '{"petId":"..."}'` — verify 200 +
   payload shape.
3. Attempt cross-user export — verify 403.
4. Verify the returned `miladyInstallPayload` is JSON-valid
   (`jq .` round-trip).
5. Manually decode the `installCommand` and verify it matches the payload
   body byte-for-byte.
6. Feed the output `character` into a local ElizaOS Character schema
   validator (Zod schema lives in `@elizaos/core`) — confirm it parses.

---

## 11. Audit plan

First + second pass per `CLAUDE.md` §Audit Guidelines. Focus areas specific
to this phase:

- Zod `parse` → 400 error shape matches existing routes.
- The export function is pure — no DB writes, no side effects.
- Plugin list for each harness matches what the harness actually ships
  (cross-check with `@clawville/app-clawville` if Milady harness).
- No hardcoded pet data leaks into the export — all fields come from the
  pet row or `characterConfig`.
- The `exportKnowledge` reuse is correct (same code path, no drift).
- No silent truncation: if a pet has 40 knowledge chunks, all 40 are
  included, not the first N.

---

## 12. Docs to update at merge time

- `CLAUDE.md` §API Routes — add the new route.
- `ARCHITECTURE.md` — add to the route table + agent-export sequence
  diagram.
- `README.md` — if it mentions export flows, update.
