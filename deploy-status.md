# Deploy Status — cross-session staging/prod deploy ledger

> **Single source of truth for "what is on staging/prod right now, and what broke last time."**
> Updated SAME-DIFF on every push to `staging` (and on every `staging → master` promotion).
> See the `deploy-status.md` rule in `CLAUDE.md` (Documentation Update Policy + PUSH FLOW).
>
> **Authority to set CURRENT STATE = whoever pushed last** (tiebreak: `git log -1 origin/staging`).
> A session that did NOT push last may ADD a DEPLOY LOG entry but must not overwrite CURRENT STATE.
>
> Be HONEST about what broke and why — the whole point is that the *next* session (which may be a
> different person/agent working a different branch) inherits real context, not a happy-path summary.

---

## CURRENT STAGING / PROD STATE

- **Branch / commit:** PROD = `master` @ `802c5f2a` (PR #116 merge — S3 spawn fix PROMOTED + verified live). `staging` = `e53c5a63` (same content; doc-only deltas after this push).
- **Updated:** 2026-06-16 — S3 spawn-recenter session (PROD PROMOTION).
- **Health:** 🟢 prod verified live — both prod containers on `802c5f2a`; prod CI `migrate` applied `0002` (BLOCKING step green vs `PROD_DATABASE_URL`) → deploy; in-browser fresh-guest NPC-mode "You" spawns in front of Town Center, SONAR `9216,9756` (was `5760,6300` diagonal); world centered, no regression. Staging 🟢 (same code).
- **SCHEMA:** `0002_avatar_spawn_recenter.sql` — **APPLIED ON BOTH** staging (2026-06-16 staging push) and prod (2026-06-16 PR #116 promotion; CI prod `migrate` job). Re-centers all `avatars` rows to spawn `9216,9756` + new column defaults; fixed prod's existing off-center stale-row bug (prod ran the 18432 client from PR #114 but its `avatars` table still defaulted to the old `2560` center). `0001` remains applied on both. No pending migrations.
- **DB isolation:** staging = Supabase `mtpixvtclsjqjguouxes`; prod = `wheuidgiyyccqyoppxoa`. **Separate DBs since 2026-06-16** — staging writes no longer touch prod.
- **Both GH secrets set:** `STAGING_DATABASE_URL` + `PROD_DATABASE_URL` (session pooler :5432).
- **Security follow-up (non-urgent, founder-acked):** prod DB password leaked into agent transcripts during this session (see log) + was in `packages/database/.env.local`. Rotate when convenient (Supabase + prod Coolify env + `PROD_DATABASE_URL` secret together).

---

## DEPLOY LOG (newest first — keep ~15 entries, trim the tail)

### 2026-06-16 — S3 spawn-recenter session — PROD PROMOTION (PR #116) + verified live
- **Changed:** Promoted the S3 spawn fix `staging → master` (PR #116, merge `802c5f2a`). Prod CI ran: `migrate` job applied `0002_avatar_spawn_recenter.sql` to the **prod** DB (BLOCKING step, 37s, vs `PROD_DATABASE_URL` GH secret) → `deploy` queued Coolify. This fixed prod's *existing* S3 bug: prod already ran the 18432 client (from PR #114) but its `avatars` table still defaulted to the old `2560` center, so logged-in players on stale rows seated off-center.
- **Verified live on prod (Rule E4 — founder signed off the staging playtest first):** polled both prod containers until both flipped from `95b9f1e7` → `802c5f2a` (Coolify async ~4 min after the CI `deploy` queue); `curl https://api.clawville.world/health` = ok, web `/game` = 200; chrome-devtools fresh isolated guest on `clawville.world/game` → explore-mode camera centered on X=9216 (world `0,600,1300`), world renders correct (Town Center dead-center, NPC ring, no clipping/atmosphere occlusion); switched to **NPC Mode** → "You" body spawned in front of Town Center, SONAR read **`9216,9756`** (the `SPAWN_PX`, not the old `5760,6300` diagonal). Guest avatar `Guest6961` Lv1 created at spawn. (Verification screenshots captured in-session, not committed.)
- **Prod SSH note:** the prod box key (`~/.ssh/clawville_hillsboro`) is passphrased and git-bash's ssh-agent wasn't connected — use **PowerShell's native `ssh`** (talks to the Windows ssh-agent service, which had the key loaded) for prod container `SOURCE_COMMIT` reads. Prod Coolify container UUIDs: api=`ebnatuxblgp4q0antoca9swk`, web=`ds7hoho685ire522lz3hie2j`.
- **For:** next session — S3 is DONE on prod. No pending migrations. Resume the staging backlog (S1 loading bar next) on a fresh branch off latest `origin/staging` in worktree `cv-staging-s3`.

### 2026-06-16 — S3 spawn-recenter session — avatar spawn re-center single-source-of-truth (staging push; schema `0002`)
- **Changed:** Fixed staging-issue **S3** (player/NPC spawn at a corner-ward diagonal). Land Phase 0 grew the CLIENT world 5120→18432 (center 2560→9216) but never migrated the SERVER/DB: `avatars.position_x/y` defaulted `2560`, the live Hono validators (`avatars.ts` `updatePositionSchema` PATCH `/me` + `heartbeatSchema` `/me/heartbeat`) capped at `max(5120)` (rejecting the correct `9216` spawn), `world.ts` `TOWN_CENTER` was `2560`, and `npc.ts` `spawnPlayerNpc` hardcoded the **11520-era** center `(5760,6300)` (the user-visible NPC-mode diagonal). FIX: one shared SSOT `packages/shared/src/constants/world-dimensions.ts` (`WORLD_PX_WIDTH/HEIGHT=18432`, `WORLD_CENTER_PX={9216,9216}`, `SPAWN_PX={9216,9756}`) read by client (game.ts dev-assert + npc.ts spawn), API (world.ts TOWN_CENTER + PATCH/heartbeat bounds + `resolveAvatarMeta` out-of-bounds clamp), DB defaults (`9216,9756`). Migration **`0002_avatar_spawn_recenter.sql`** resets all avatars + column defaults.
- **Drift audit (S3 part 2):** the prior session's "lost direct-to-master changes" = a PayAI press release (6 `(direct to master)` commits) — already reconciled onto staging (press-release.tsx/page.tsx/press images byte-identical staging==master). No actionable prod-only code drift remains.
- **Verified before push:** `0002` dry-run = recognized as the single pending migration; execute-and-rollback against the live staging DB = all **4 staging avatars were at `2560,2560`** (bug confirmed), reset cleanly to `9216,9756`, rolled back (no premature mutation). Gates: `bunx tsc --noEmit` shared/database/api exit 0; web `bunx next build` ✓ compiled (per-package web `tsc` = the known 372-error dual-`@types/three` baseline, 0 new). (`avatars.test.ts` is an env-gated integration test — fails at signup without `DATABASE_URL`, unrelated.)
- **Watch on push:** CI `migrate` job applies `0002` to the staging DB (resets staging avatars to spawn) BEFORE the Coolify deploy. If `migrate` fails it blocks the deploy — but `0002` is pre-validated. Workflow team `staging-s3-spawn-2026-06-16` (impl + 3 auditors; regression auditor caught that the implementer had fixed only the DEAD BFF route, not the live Hono validators — fixed). Adversary caught that the original "land Phase 0 unpromoted" premise was FALSE (it's on prod via PR #114) — docs corrected.
- **For:** the promotion session — `0002` must reach prod to fix prod's existing S3 bug; it ships at the next `staging → master` PR (the CI prod `migrate` job applies it, realigning prod rows to the 18432 client already live there). Needs founder sign-off on the staging playtest first (Rule E4).

### 2026-06-16 — migration-gate session — PROD PROMOTION (PR #114) + agent-stray-write incident + fix
- **Changed:** Promoted `staging → master` (PR #114, merge `95b9f1e7`) — shipped the migration gate + land Phase 0 (world re-grow 360→576 + schema) + perf-round3 + cove agent-parity + hatcher docs to prod. Prod `migrate` job ran, prod deploy succeeded.
- **Broke / root cause (caught in post-deploy verification):** prod's land tables came up with the WRONG schema — unnamed `*_fkey`/`*_key` constraints + 2 stray CHECK constraints (the drift the gate exists to prevent). Root cause: during the build workflow, a sub-agent ran a migration test against the **prod** DB because `packages/database/.env.local` carried the **prod** `DATABASE_URL` (+ `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`), which Bun auto-loads for scripts run from that dir. It applied the *pre-fix* (unnamed-constraint) `0001` to prod, so the real gate's `CREATE TABLE IF NOT EXISTS` then skipped. (This is exactly the "prod URL in an env file is a disaster vector" hazard.)
- **Fix:** (1) repointed `packages/database/.env.local` `DATABASE_URL` → staging. (2) Dropped the 8 EMPTY prod land tables + cleared the `0001` tracking row, re-ran `migrate-ci.ts` against prod with the FINAL `0001` → recreated with correct drizzle-named constraints. Verified: 20 named FK/unique, 0 unnamed, 0 stray checks, 8 tables. Prod now == staging == drizzle.
- **Security:** the prod DB password is now in agent transcripts — rotation is the open follow-up (see CURRENT STATE).
- **For:** every session — NEVER put a prod URL in any `.env*`. Bun auto-loads `<cwd>/.env.local`; a script that targets `DATABASE_URL` from `packages/database/` would hit whatever's there. Keep all local env files staging-only.


- **Changed:** Added a CI migration gate — `packages/database/scripts/migrate-ci.ts` (forward-only, idempotent, `_clawville_migrations` tracking table; NOT drizzle-kit push/migrate) + `packages/database/migrations/0001_land_economy.sql` (8 land tables + 9 enums) + a `migrate` job gating `deploy` (`needs: migrate`) in BOTH workflows. Also: `wager.ts` `default(0n)`→`default(sql\`0\`)` (unblocks `db:push`/`generate` repo-wide — drizzle-kit 0.24 can't serialize a BigInt literal), `paths-ignore` docs-skip on both workflows, this `deploy-status.md` + rule, and staging-DB-isolation doc updates.
- **Why it exists:** staging + prod are now SEPARATE Supabase DBs (split 2026-06-16) and Coolify never runs migrations — so a schema change on staging would NOT reach prod on merge, and prod would crash querying a missing table. The gate applies pending migrations and BLOCKS the deploy if they fail.
- **Verified:** `0001` reproduces drizzle's staging schema EXACTLY (isolated scratch-schema diff on the live staging DB — all 8 tables / 9 enums / columns / named FK+unique constraints / indexes match). Runner proven end-to-end against the real Supabase session pooler (dry-run → apply → idempotent re-skip) + ephemeral-Docker (8 scenarios incl. per-file atomic rollback + immutability guard).
- **Gotchas found (for the next author):**
  - drizzle names EVERY constraint — `<table>_<col>_unique`, `<table>_<col>_<reftable>_id_fk`. Unnamed inline `UNIQUE`/`REFERENCES` auto-name `*_key`/`*_fkey` → `drizzle-kit` churns DROP/ADD forever. The empirical scratch-diff caught 17 FK + 3 unique mis-namings the adversarial review missed.
  - drizzle-kit 0.24.x does NOT emit CHECK constraints — staging lacks `land_structure_level_range` + `service_listings_price_non_negative` that `land.ts` declares. `0001` omits them too (pure parity; both bounds are app-enforced). A future `0002` can add them to BOTH dbs if we want DB-level guards.
  - Migrations are IMMUTABLE once applied (checksum-locked). To change one, add a NEW file. `ALTER TYPE … ADD VALUE` must live ALONE in its own file (can't run inside the per-file implicit txn).
- **For:** the next deploy session — the gate now guards every staging + prod deploy. If a deploy is "stuck pending", first check the `migrate` job in the GitHub Actions run, not just Coolify.

### 2026-06-16 — land Phase 0 + staging-DB isolation — world re-grow + DB split (incident)
- **Changed:** Land economy Phase 0 (world re-centered 360→576 tiles; `land` schema). Split staging onto its OWN Supabase project (`mtpixvtclsjqjguouxes`); repointed Coolify staging api/web; prod DB untouched.
- **Broke / root cause:** the Phase 0 schema-index commit captured an uncommitted `export * from './poker'` (poker.ts not committed) → `TS2307` broke EVERY staging build (mine + other sessions') from ~11:57 until fixed at `aff9d6c1`. Separately, `wager.ts` `.default(0n)` crashed `db:push`/`generate` repo-wide (BigInt serialize).
- **Fix:** removed the leaked `./poker` export (`aff9d6c1`); `wager.ts` BigInt fix folded into the 2026-06-16 migration-gate bundle above.
- **For:** the poker session — your `poker.ts` / `central_messages` tables exist on the staging DB as drift but are NOT in the committed staging schema, so they will NOT be pushed to prod until you commit `poker.ts` + add a `0002`-style migration. The migration gate is additive-only and will never drop them.
