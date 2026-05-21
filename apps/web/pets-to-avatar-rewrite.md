# pets → avatar full rename + history rewrite

**Status:** spec, awaiting approval
**Branch:** master
**Author:** initial spec 2026-05-08

## Goal

Rename every meaningful occurrence of `pet/pets/Pet/Pets/PET/PETS` to `avatar/avatars/Avatar/Avatars/AVATAR/AVATARS` across this monorepo: code, types, files, API routes, DB schema/columns/FKs, UI copy, docs. Then rewrite git history so `pet` does not appear in any commit on master.

User decisions captured up-front (do not re-ask):

| Decision | Choice |
|---|---|
| Prod data | **In-place ALTER** — preserve existing rows |
| Backwards-compat aliases | **None** — hard cutover, no `/api/pets/*` survives |
| UI copy | **Full rename** — labels, prompts, archetype copy |
| Backup branch | **Preserve as-is** (`master-pre-rewrite-backup-20260501` left untouched) |
| Word boundaries | **Required** — must not mangle `puppet`, `competitor`, `centripetal`, `interpret`, `perpetual`, `petition`, `appetite` |
| Plugin coordination | **Not needed** — `@clawville/app-clawville` doesn't call `/api/pets/*` |

## Scope (from discovery)

- `\bpets?\b` lowercase: **3,346** occurrences across **335 files**
- `\bPets?\b` capitalized: **174** occurrences across **90 files**
- `petId` / `pet_id` patterns: **~1,900** lines
- File paths with `pet` in name: **81**
- DB schema files referencing `pet_id` FK: **17+** of 36 schema files (`activity-replays`, `activity-queue-entries`, `activity-room-participants`, `activity-results`, `activity-parties`, `agent-configs`, `agent-session-tickets`, `auctions`, `bounties`, `cosmetics`, `events`, `marketplace`, `inventory`, `bazaar`, `quests`, `token-launch`, `pets`, plus `index.ts` relations)
- Internal callers of `/api/pets/*`: web client (`apps/web/src/lib/api.ts`), Hermes (`integrations/hermes/scripts/clawville.py`), tests (`apps/api/src/tests/pets.test.ts`)

## Replacement table (case-aware)

| From | To |
|---|---|
| `pet` | `avatar` |
| `pets` | `avatars` |
| `Pet` | `Avatar` |
| `Pets` | `Avatars` |
| `PET` | `AVATAR` |
| `PETS` | `AVATARS` |
| `petId` | `avatarId` |
| `PetId` | `AvatarId` |
| `pet_id` | `avatar_id` |
| `PET_ID` | `AVATAR_ID` |
| `petInventory` | `avatarInventory` |
| `pet_inventory` | `avatar_inventory` |
| `petArchetype` | `avatarArchetype` |
| `pet-archetype` | `avatar-archetype` |
| `pet_archetype` | `avatar_archetype` |
| `petSkin` / `pet_skin` | `avatarSkin` / `avatar_skin` |
| `petWallet` / `pet_wallet` | `avatarWallet` / `avatar_wallet` |
| `playerPet` / `player-pet` | `playerAvatar` / `player-avatar` |
| `pet-simulation` / `petSimulation` | `avatar-simulation` / `avatarSimulation` |
| `myPet` / `getMyPet` | `myAvatar` / `getMyAvatar` |
| `subject_type='pet'` (string literal in `wallets`) | `subject_type='avatar'` |

**Word-boundary safe (do not change):** `puppet`, `puppeteer`, `competitor`, `competition`, `interpret`, `interpretation`, `perpetual`, `perpetuate`, `petition`, `petite`, `petty`, `petrol`, `parapet`, `repetition`, `centripetal`, `appetite`. The grep already showed 63 lines containing these — word-boundary regex `\bpets?\b` skips them naturally.

**Phrases to leave alone (manual review needed before regex run):** `pet store` if it appears in copy, brand/legal text, third-party API field names if any.

## Phase 1 — Forward rename (one PR, multiple commits)

Per CLAUDE.md "MANDATORY collaborative ULTRATHINK teams" rule — each concern below uses Implementer → Auditor sequence with ultrathink reasoning. Concerns are sequenced (DB before code, code before docs) where state shares; parallel where independent.

### 1a. Shared types + constants (`packages/shared`)
- Rename type aliases: `Pet` → `Avatar`, `PetArchetype` → `AvatarArchetype`, `PetArchetypeId` → `AvatarArchetypeId`
- Rename file: `pet-archetypes.ts` → `avatar-archetypes.ts`
- Rename exports: `PET_ARCHETYPES` → `AVATAR_ARCHETYPES`, `ARCHETYPE_IDS` (no rename needed)
- Update barrel exports
- **Audit:** type-check `bun --cwd packages/shared run build`

### 1b. Database — schema + Drizzle migration

This is the highest-risk concern. **Hand-author the SQL** — Drizzle's auto-generator emits DROP/CREATE which would wipe rows. Below is the verified ALTER list from full schema discovery:

#### 1b.1 Tables to RENAME (preserves all rows + indexes + constraints):
- `pets` → `avatars`
- `pet_inventory` → `avatar_inventory`
- (no `pet_skins` table — confirmed; cosmetics carry pet_id refs but no top-level pet_skins table)

#### 1b.2 Columns to RENAME (17 tables touched):
| Table | Column | New name |
|---|---|---|
| `avatar_inventory` | `pet_id` | `avatar_id` |
| `activity_log` | `pet_id` | `avatar_id` |
| `published_skills` | `author_pet_id` | `author_avatar_id` |
| `skill_upvotes` | `pet_id` | `avatar_id` |
| `token_launches` | `pet_id` | `avatar_id` |
| `bounty_reputation` | `pet_id` | `avatar_id` |
| `auction_agent_configs` | `pet_id` | `avatar_id` |
| `quest_submissions` | `pet_id` | `avatar_id` |
| `quest_rewards` | `pet_id` | `avatar_id` |
| `agent_configs` | `pet_id` | `avatar_id` |
| `claw_token_transactions` | `pet_id` | `avatar_id` |
| `activity_queue_entries` | `pet_id` | `avatar_id` |
| `activity_room_participants` | `pet_id` | `avatar_id` |
| `activity_results` | `pet_id` | `avatar_id` |
| `activity_parties` | `leader_pet_id` | `leader_avatar_id` |
| `activity_party_members` | `pet_id` | `avatar_id` |
| `auctions` | `pet_id` | `avatar_id` |
| `bounties` | `pet_id` | `avatar_id` |
| `events` | `pet_id` | `avatar_id` |
| `agent_session_tickets` | `pet_id` | `avatar_id` |
| `reef_race_personal_bests` | `pet_id` | `avatar_id` |
| `pet_skins` (cosmetics) | `pet_id` | `avatar_id` (table also renamed below) |
| `bazaar_listings` | (verify FK) | `avatar_id` |
| `marketplace.author_pet_id` | (already covered under published_skills) | |

#### 1b.3 pgEnum NAMES to RENAME (4 — values stay):
- `pet_species` → `avatar_species` (8 species values stay: lobster_plush, etc.)
- `pet_color` → `avatar_color`
- `pet_gender` → `avatar_gender`
- `pet_avatar_type` → `avatar_render_type` (avoiding `avatar_avatar_type` redundancy)

#### 1b.4 pgEnum VALUE migration (1 — `wallet_subject_type`):

This is the only enum where a *value* changes ('pet' → 'avatar'). PostgreSQL doesn't support DROP VALUE on an enum. Multi-step:

```sql
-- Step A: Add 'avatar' to existing enum
ALTER TYPE wallet_subject_type ADD VALUE IF NOT EXISTS 'avatar';

-- Step B: Move data
UPDATE wallets SET subject_type = 'avatar' WHERE subject_type = 'pet';

-- Step C: Drop 'pet' value via type-swap
CREATE TYPE wallet_subject_type_new AS ENUM ('avatar', 'agent', 'treasury');
ALTER TABLE wallets
  ALTER COLUMN subject_type TYPE wallet_subject_type_new
  USING subject_type::text::wallet_subject_type_new;
DROP TYPE wallet_subject_type;
ALTER TYPE wallet_subject_type_new RENAME TO wallet_subject_type;
```

#### 1b.5 String-literal data migrations (NEW — not in original spec):

Three persisted columns/JSON paths contain `'pet'` as a literal value, separate from the enum:

```sql
-- (a) npc_memories.entity_type — varchar column
UPDATE npc_memories SET entity_type = 'avatar' WHERE entity_type = 'pet';

-- (b) events.payload->>'chatType' — JSONB
-- Used by quest matchers in quests.ts:1024 and :1040; DB has many rows.
UPDATE events
  SET payload = jsonb_set(payload, '{chatType}', '"avatar"')
  WHERE payload->>'chatType' = 'pet';
```

#### 1b.6 Code-side string literals to flip in lockstep with the data migration:

These call sites hand `'pet'` to functions or write it as JSON values; ALL must flip to `'avatar'` simultaneously with the DB migration:

| File | Line | Change |
|---|---|---|
| `apps/api/src/services/wallet-service.ts` | 11, 62, 167, 225, 334 | `subjectType === 'pet'` checks → `'avatar'` (function signature also flips) |
| `apps/api/src/services/memory-service.ts` | 12 | `entityType: 'npc' \| 'pet'` → `'npc' \| 'avatar'` |
| `apps/api/src/routes/agent-gateway.ts` | 555, 1401 | `ensureWalletWithFirstTimeSecret('pet', ...)` → `'avatar'` |
| `apps/api/src/routes/pets.ts` (→ avatars.ts) | 441, 483 | `ensureWalletWithFirstTimeSecret('pet', ...)` → `'avatar'` |
| `apps/api/src/routes/pets.ts` (→ avatars.ts) | 893 | `chatType: 'pet'` → `'avatar'` |
| `apps/api/src/routes/quests.ts` | 1024, 1040 | SQL `payload->>'chatType' = 'pet'` → `'avatar'` |
| `apps/api/src/routes/openclaw.ts` | 826 | `eq(npcMemories.entityType, 'pet')` → `'avatar'` |
| `apps/api/src/routes/leaderboard.ts` | 344, 481, 648, 698, 829, 901 | `subjectType: 'agent' \| 'pet'` and SQL `'pet'::text AS subject_type` and filter `r.subject_type === 'pet'` |
| `apps/web/src/components/game/activity-results-modal.tsx` | 46 | `subjectType: 'pet' \| 'agent' \| string` → `'avatar' \| 'agent' \| string` |
| `apps/web/src/app/leaderboard/page.tsx` | 51, 53, 114 | `subjectType?: 'agent' \| 'pet'` |
| `scripts/backfill-wallets.ts` | 82 | `ensureWallet('pet', p.id)` → `'avatar'` |

#### 1b.7 Drizzle schema source changes:
- `packages/database/src/schema/pets.ts` → `avatars.ts`; `pgTable('pets', ...)` → `pgTable('avatars', ...)`
- `packages/database/src/schema/inventory.ts`: `petInventory = pgTable('pet_inventory', ...)` → `avatarInventory = pgTable('avatar_inventory', ...)`
- `packages/database/src/schema/wallets.ts`: enum values `['pet', 'agent', 'treasury']` → `['avatar', 'agent', 'treasury']`
- `packages/database/src/schema/index.ts`: update 10+ relation FKs (`petId:` references)
- All other schema files referenced in 1b.2: rename column references in TS

#### 1b.8 Indexes/constraints — auto-renamed by Postgres:
PostgreSQL auto-renames indexes/constraints that follow the convention `<table>_<col>_<refTable>_<refCol>_fk`. After ALTER TABLE/COLUMN renames, the FK constraints carry the *new* table/column in their generated names. Drizzle's introspection will see them clean. **Verify after migration:** `\d+ avatars` should show clean constraint names; manually rename any that don't (`ALTER INDEX foo RENAME TO bar`).

Indexes likely needing manual rename (Drizzle hardcoded names):
- `idx_arp_pet_joined` → `idx_arp_avatar_joined` (activity_room_participants)
- `idx_pet_skin_pet_sku` → `uniq_avatar_skin_avatar_sku` (cosmetics)
- `idx_pet_skin_pet_equipped` → `idx_avatar_skin_avatar_equipped` (cosmetics)
- `idx_events_pet_ts` → `idx_events_avatar_ts` (events)
- `wallets_subject_type_idx` — name unchanged (column unchanged)

#### 1b.9 Migration ordering (locked):
```
1. ADD 'avatar' to wallet_subject_type enum
2. UPDATE wallets SET subject_type='avatar' WHERE subject_type='pet'
3. UPDATE npc_memories SET entity_type='avatar' WHERE entity_type='pet'
4. UPDATE events SET payload=jsonb_set(...) WHERE chatType='pet'
5. ALTER TABLE pets RENAME TO avatars
6. ALTER TABLE pet_inventory RENAME TO avatar_inventory
7. ALTER TABLE … RENAME COLUMN pet_id TO avatar_id (×17 tables)
8. ALTER INDEX … (manual renames listed in 1b.8)
9. ALTER TYPE pet_species/pet_color/pet_gender/pet_avatar_type RENAME (×4)
10. Type-swap wallet_subject_type to drop 'pet' value (4-statement block in 1b.4)
```

- **Audit:** every FK constraint preserves `ON DELETE CASCADE`; every UNIQUE constraint name still matches code references; row counts match before/after for every renamed table. Run `SELECT count(*) FROM avatars` and compare to pre-migration `SELECT count(*) FROM pets` snapshot.

### 1c. API routes
- Move file: `apps/api/src/routes/pets.ts` → `apps/api/src/routes/avatars.ts`
- Rename export: `petRoutes` → `avatarRoutes`
- Move test: `apps/api/src/tests/pets.test.ts` → `avatars.test.ts`; update imports + URL strings
- Mount: in `apps/api/src/index.ts`, `app.route('/api/pets', petRoutes)` → `app.route('/api/avatars', avatarRoutes)`. Activity routes: `app.route('/api/pets', activityRoutes)` → `app.route('/api/avatars', activityRoutes)`
- Update internal route comments referencing `/api/pets`
- Update `agent-gateway.ts` SKILL.md generators if they emit literal `/api/pets/*` strings in agent-facing instructions
- **Audit:** ensure no `/api/pets` literal remains anywhere in `apps/api/src/`

### 1d. Web client
- `apps/web/src/lib/api.ts`: 8 call sites updated to `/api/avatars/*`; rename `getMyPet()` → `getMyAvatar()`; rename type imports
- React components: file renames
  - `player-pet.tsx` → `player-avatar.tsx`
  - `pet-card.tsx`, `pet-settings-modal.tsx`, etc. → `avatar-*`
  - 81 file path renames total
- Component / hook renames: `usePet*` → `useAvatar*`
- Zustand store keys: `pet`, `myPet`, `setPet` → `avatar`, `myAvatar`, `setAvatar`
- Asset paths: `apps/web/public/sprites/pets/` → `avatars/`; update all `<img src=…>` references
- **Audit:** `bun --cwd apps/web run build`

### 1e. UI copy
- Component labels, button text, dialog copy, toasts: "Your pet" → "Your avatar", "Create a pet" → "Create your avatar", "Your pet earned X tokens" → "Your avatar earned X tokens"
- Archetype descriptions in `avatar-archetypes.ts`: review every `description`, `bio[]`, `lore[]` for "pet" usage
- Town Guide knowledge in `packages/agent-templates/src/locations/town-guide.ts` — references "pet" in onboarding text
- 10 building character templates: each one likely references "pet" once
- Landing page copy
- **Audit:** grep for `\bpets?\b` in `apps/web/src/**/*.tsx` and `packages/agent-templates/src/**/*.ts` — should be zero hits

### 1f. External integrations + scripts
- `integrations/hermes/scripts/clawville.py`: `/api/pets/me` → `/api/avatars/me`; `petId` keys → `avatarId`; `pet_row` variable name → `avatar_row`; comments
- `scripts/flip-guest-pets-to-milady.ts` → `flip-guest-avatars-to-milady.ts`; rename internals
- Any other one-off scripts referencing pets
- **Audit:** dry-run hermes script against staging if available; otherwise review by reading

### 1g. Docs (same-diff per CLAUDE.md three-doc rule)
- `CLAUDE.md` (14 occurrences) — full rewrite of all `pet`-related sections
- `ARCHITECTURE.md` (31 occurrences) — schema diagram, route catalog, DB tables list, agent identity types
- `GameFeatures.md` — pet system section, daily login, archetypes
- `3dStructure.md` — `player-pet` references
- `README.md` (3 occurrences)
- `.claude/plans/*.md` — 4 plans reference pets in design specs (phase4c-in-game-edit, phase2-agent-category-schema, phase4a-milady-install-ui, phase1-create-agent-3d, milady-integration-plan)
- `docs/steam-research/*.md` — 2 files reference pets in audit context
- `docs/milady-integration-plan.md`
- `TODO.md`
- Bump "Last Audited" on each canonical doc
- **Audit:** every doc reference to API routes uses `/api/avatars/*`; every "Pet/pet" replaced with "Avatar/avatar"

### 1h. Memory + agent templates
- `.claude/memory/threejs/gotchas/pet-scale-vs-glb-native-height.md` → `avatar-scale-vs-glb-native-height.md`
- `packages/agent-templates/**` — 10 building characters + town-guide system agent
- `MEMORY.md` index entries

## Phase 1 deploy + verification

1. Generate the rename migration locally; review SQL by hand
2. Push branch; let Coolify build (~3-5 min web, ~2-3 min api)
3. **Apply 0007 migration BEFORE code deploys.** Run `bash scripts/deploy/apply-rename-migration.sh --migration 0007 --vps-ip <PROD_VPS_IP>` from local machine. The script SSHes to prod, copies the migration into the coolify-db container, and runs it via psql. After success, the rename is in place. THEN trigger the code deploy via Coolify (Coolify only builds — it does NOT run migrations; per CLAUDE.md "Drizzle push is manual"). With the schema already renamed, any subsequent manual `bun run db:push` is a no-op because live DB matches the new TS schema. Without the prior manual migration step, a `db:push` would DROP TABLE pets + CREATE TABLE avatars and lose all rows.
   - **Why:** drizzle-kit push --force diffs TS schema against live DB and emits DROP/CREATE for tables it can't reconcile. The hand-authored 0007.sql is not in its execution path.
   - The script has a pre-flight check (`SELECT to_regclass('public.avatars')`) — if `avatars` already exists the migration is treated as applied and the script exits 0. Re-runnable safely.
   - Critical timing: code container restarts in Coolify after build, so for ~30-60s the API container is on new code talking to in-flight DB. Two acceptable orderings:
     - **(a)** Apply DB migration first while API still on old code → API fails for ~30s until Coolify finishes new build → new API works against renamed DB. Brief 502s.
     - **(b)** Push code first, wait for Coolify to start the build, then race to apply DB migration before container becomes healthy. Risky.
     - **Pick (a).** Plan the deploy for low-traffic window.
4. Smoke tests against prod:
   - `curl -sS --ssl-no-revoke https://api.clawville.world/health` — health
   - `curl -sS --ssl-no-revoke https://api.clawville.world/api/avatars/me` (with auth cookie) — verify new route
   - `curl -sS --ssl-no-revoke https://api.clawville.world/api/pets/me` — should 404
   - Browser visit `https://clawville.world/game` — pet/avatar loads, daily-login works, heartbeat works, name displays correctly, sprites load from new path
   - Run smoke fixture: `cd ../clawville-milady-plugin && npm run smoke`
   - Verify connected agents still work via `/api/agent/connect` (untouched)
5. Update `MEMORY.md` smoke-test fixture entry if path changed

## Phase 2 — History rewrite

After Phase 1 is shipped, deployed, and verified for at least 24h.

1. Stash any dirty working tree
2. Run `git filter-repo` with regex `--replace-text` (word-boundary aware) and `--path-rename` for the 81 file paths
3. Replacement file format (one per line):
   ```
   regex:\bpet\b==>avatar
   regex:\bpets\b==>avatars
   regex:\bPet\b==>Avatar
   regex:\bPets\b==>Avatars
   regex:\bPET\b==>AVATAR
   regex:\bPETS\b==>AVATARS
   regex:\bpetId\b==>avatarId
   regex:\bpet_id\b==>avatar_id
   regex:\bPetId\b==>AvatarId
   …(plus the rest of the case table above)
   ```
4. Path-rename file (one per line):
   ```
   apps/api/src/routes/pets.ts==>apps/api/src/routes/avatars.ts
   apps/api/src/tests/pets.test.ts==>apps/api/src/tests/avatars.test.ts
   …(81 entries)
   ```
5. Scope to master only — preserve `master-pre-rewrite-backup-20260501`
6. Force-push master with `--force-with-lease`
7. Re-add origin remote if filter-repo strips it
8. Verify post-rewrite:
   - `git grep -i pets? master` returns 0 lines (excluding word-boundary collisions like `puppet`)
   - `git log master --oneline | grep -i pet` returns 0 lines
   - `git log master --name-only --pretty=format: | sort -u | grep -i pet` returns 0 lines

## Phase 3 — GitHub PR refs cleanup

Same as Option A from earlier discussion: open a GitHub Support ticket asking them to purge `refs/pull/1..78/head` so the pre-rewrite content is no longer publicly fetchable. Reference both the elizapets rewrite (already done) and this pets rewrite. Likely to succeed (~95%) within 1–3 business days.

If they decline or only partially purge, fall back to **Option C** — push current sanitized master to a new repo, take old repo private. We discussed pros/cons earlier; user is willing.

## Risk register

| Risk | Mitigation |
|---|---|
| Drizzle auto-generated migration uses DROP/CREATE → wipes prod data | Hand-author the rename SQL; review every line before push |
| Code deploys before DB migration applied → 500 errors against `pets` table that no longer exists | Apply DB migration first; brief deploy window where old API hits renamed DB and 500s for ~30s |
| Word-boundary regex misses an edge case (e.g., a JSON literal `"pet"` inside config) | Audit grep after each phase; explicit string-literal scan over `*.json`, `*.yaml`, `*.env*` |
| ~~ElizaOS room IDs of form `pet:<id>`~~ | **RESOLVED 2026-05-08 investigation.** Room IDs in this repo are pure UUIDs validated by `UUID_RE.test(context.roomId)` in `packages/agent-runtime/src/eliza-runtime.ts:676`. Memory entry confirms: "legacy string roomIds still ignored by `processMessage`." Phase 6 isolation uses `characterRoomId(buildingSlug, petId)` which deterministically derives a UUID. **No room-id data migration needed.** |
| `wallet_subject_type` enum value 'pet' → 'avatar' is a multi-step PG operation | 4-statement block in 1b.4: ADD 'avatar', UPDATE rows, type-swap to drop 'pet'. Test on staging snapshot before prod. |
| Quest matchers filter `payload->>'chatType' = 'pet'` and existing event rows have that chatType | Migration step 4 in 1b.5 rewrites JSONB; quests.ts:1024/1040 code flips simultaneously. |
| Connected agents have cached `/api/pets/*` URLs in their persisted config | They re-fetch SKILL.md on session start; old cached URLs 404, agents pick up new endpoints on next reconnect |
| Bun/Vite build cache holds stale module IDs | Clear `apps/web/.next/`, `node_modules/.vite/` before deploy; Coolify Docker build is fresh anyway |
| TanStack Query cache keys `['pet']` (~30 references in web app) | Pure client-side, no server impact. Rename to `['avatar']` in same diff; old browser tabs will refetch under new key after hot-reload. |
| Activity replay JSONB has TS index signature `[petId: string]: …` — but actual JSON keys are UUIDs (verified) | No JSON data migration. TS type docstring rename only. |
| Smoke fixture pet `clawville-plugin-smoketest-v1` has stale ID under new schema | Fixture row migrates with the rest (pets table → avatars table). Run smoke test against new endpoint to verify. |
| History rewrite fails on 875th commit due to unexpected pattern | git-filter-repo is robust; if it fails we restore from `master-pre-rewrite-backup-20260501` and retry with refined regex |
| Coolify webhook re-deploys mid-rewrite | We force-push only after rewrite + local verification |

## Rollback plan

1. **Phase 1 fails on prod:** Drizzle migration is reversible — author the down-migration ALTER TABLE renaming back. Coolify redeploy of previous master commit. ~10 min recovery.
2. **History rewrite produces broken state:** `git reset --hard master-pre-rewrite-backup-20260501` would lose the elizapets+pets+all-recent-work — instead, `git reflog` to recover the pre-filter-repo commit SHA. Local backup branch is the *original* archive; doesn't include recent fixes.
3. **GitHub Support declines PR ref purge:** Fall back to new repo (Option C) — current rewritten master pushed to fresh `ItachiDevv/ClawVille-2`, current repo made private, README updated, deploys re-pointed.

## Estimated effort

| Phase | Time |
|---|---|
| 1a shared types | 30 min |
| 1b DB schema + migration | 3.5 h (hand-authored SQL incl. enum value swap + 3 data migrations + 17 column renames + 4 enum-name renames) |
| 1c API routes | 45 min |
| 1d web client | 2 h (file renames + import paths + 8 call sites + assets) |
| 1e UI copy | 1 h |
| 1f scripts + Hermes | 30 min |
| 1g docs | 1 h |
| 1h memory + agent templates | 30 min |
| Phase 1 deploy + verify | 30 min + 24h soak |
| Phase 2 history rewrite | 45 min |
| Phase 3 ticket | 15 min |
| **Total active work** | **~9-10 hours** + 24h verification soak |

## Out of scope

- Renaming the npm plugin `@clawville/app-clawville` itself (keeps existing name)
- Renaming the repo `ItachiDevv/ClawVille` (decided in earlier discussion; only triggered if Phase 3 ticket fails)
- Renaming Solana wallet labels in custodial keypair tags (internal, no user-visible impact)
- Renaming the smoke-test fixture display name `clawville-plugin-smoketest-v1` (it's a string identifier, not a concept; leave it)
