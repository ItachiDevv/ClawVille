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

- **Branch / commit:** `master` ← `staging` promoted via PR #114 (merge `95b9f1e7`); migration gate live on BOTH boxes.
- **Updated:** 2026-06-16 — land-economy / migration-gate session.
- **Health:** 🟢 green — staging + prod api `/health` ok, `/game` 200; CI migration gate live + verified on both.
- **SCHEMA:** `synced` — `0001_land_economy.sql` applied to staging AND prod; prod land schema verified to match drizzle exactly (20 named FK/unique constraints, 0 unnamed, 0 stray checks). `_clawville_migrations` records `0001` on both.
- **DB isolation:** staging = Supabase `mtpixvtclsjqjguouxes`; prod = `wheuidgiyyccqyoppxoa`. **Separate DBs since 2026-06-16** — staging writes no longer touch prod.
- **Both GH secrets set:** `STAGING_DATABASE_URL` + `PROD_DATABASE_URL` (session pooler :5432).
- **Security follow-up (non-urgent, founder-acked):** prod DB password leaked into agent transcripts during this session (see log) + was in `packages/database/.env.local`. Rotate when convenient (Supabase + prod Coolify env + `PROD_DATABASE_URL` secret together).

---

## DEPLOY LOG (newest first — keep ~15 entries, trim the tail)

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
