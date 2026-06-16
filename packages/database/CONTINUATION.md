# Land Economy + Staging-DB-Isolation — CONTINUATION (post-compaction handoff)

> Written 2026-06-16 before a context compaction. Captures everything needed to resume the
> **CI-applied blocking migration** work (#2) and ship the **pending bundle** without losing
> the hard-won infra details. Read this first on resume.

---

## ✅ DONE + VERIFIED

**Phase 0 land economy — shipped + verified live on staging.**
- World re-centered 360→576 tiles (center tile 288 / px 9216 / world 18432). Full client+server+shared coordinate migration. Additive `land` schema + frozen contracts (`land-tiers.ts`/`land-parcels.ts`/`land-economy.ts`).
- On `staging` as commit `aff9d6c1` (+ the re-based path; `1484f689` was the Phase 0 commit, `aff9d6c1` the poker-leak fix).
- Verified on `staging.clawville.world/game`: SONAR readout `9216` (new center), `cameraFar:14000`, fog 6500–13500, NPCs aligned to re-centered Town Center, no grow-related console errors.

**Staging DB isolated from prod — done + verified.**
- New Supabase project **`ClawVille-staging`** (ref **`mtpixvtclsjqjguouxes`**, us-east-1, org `znldqhesvhlvhrknhqnt`, Pro plan). Pooler host `aws-1-us-east-1.pooler.supabase.com` (txn :6543, session :5432).
- Full schema applied (**103 tables** = 83 ours incl. all `land_*`/`service_*`/`ct_topups`/`partner_storefronts` + 20 ElizaOS auto-created on api boot). Seeded: 12 map locations + 8 quests.
- Coolify staging api(app **3**)+web(app **4**) `DATABASE_URL` repointed prod→staging + redeployed + verified (api boots against it, leaderboard endpoint returns data, `/game` 200).
- **Prod DB = `wheuidgiyyccqyoppxoa` — never touched.**

**`.env.local` fixed (#1) — done.**
- Staging-only: `DATABASE_URL` = staging **session** pooler (:5432, DDL-safe default), `STAGING_DATABASE_URL` (:6543), `STAGING_DB_SESSION_URL` (:5432). **NO prod URL** (founder rule: prod tokens → real money; a stray prod URL in env is a disaster vector).
- **Pushed to the itachi-env sync** (repo `ClawVille`, 7 keys) → other sessions/machines get staging access on their SessionStart sync.

**Creds locations:** `STAGING_DB_REF/PASS/STAGING_DATABASE_URL/STAGING_DB_SESSION_URL` in `scripts/deploy/.env.deploy` (gitignored). `SUPABASE_ACCESS_TOKEN` in env (management API). Prod URL: NOT in any env file by design — recover from prod Coolify container or build from ref `wheuidgiyyccqyoppxoa` (password leftover in `scripts/deploy/railway-env-backup.json` — **TODO: rotate + gitignore that file**).

---

## ⚠️ CRITICAL GOTCHAS (drizzle-kit / migrations) — load-bearing for #2

1. **`wager.ts` BigInt bug (FIXED, uncommitted).** `wagerAmountLamports: bigint(...,{mode:'bigint'}).default(0n)` — the `0n` BigInt literal made drizzle-kit 0.24.2 crash (`Do not know how to serialize a BigInt`) on **both `db:push` and `generate`, repo-wide.** Fixed to `.default(sql\`0\`)` (identical `DEFAULT 0` DDL, serializable). **The fix is in the MAIN repo working tree, NOT committed.** Must land on staging→prod.
2. **`wager_lobby_id_seq` catch-22.** It's a MANUAL sequence (`drizzle/wager-lobbies.sql` / `apply-wager-migration.ts`), used by `wager_lobbies.lobby_id DEFAULT nextval(...)`. **`db:push --force` CANNOT handle it**: if the seq is absent → CREATE TABLE fails; if present → drizzle marks the unmanaged seq for DROP → `reportDependentObjects` error. So `db:push` is **unusable for the full schema**. ⇒ Use **`drizzle-kit generate`** (now that BigInt is fixed) to emit additive CREATE SQL, **pre-create the sequence** (`CREATE SEQUENCE IF NOT EXISTS "wager_lobby_id_seq"`), then apply the SQL. This is exactly how staging was built.
3. **Pooler split:** session (:5432) for DDL/migrations; txn (:6543) for app runtime.
4. **ElizaOS tables** (~20) are `tablesFilter`-excluded in `drizzle.config.ts` (negation patterns) and auto-created by plugin-sql on api boot. NEVER let push/migrate drop them (the 2× historical disaster).

---

## 📦 PENDING BUNDLE — one staging commit (do via the worktree, see below)

1. **`wager.ts` BigInt fix** (move from main repo → staging).
2. **`paths-ignore`** on `.github/workflows/deploy-staging.yml` + `deploy.yml` push triggers: `['**.md','docs/**','.claude/**','**.itachi-bak']`. Verified safe — NO `.md` is read at runtime (the `skill.md` refs are generated route endpoints, not static reads). Skips docs-only deploys.
3. **`deploy-status.md`** (NEW, **tracked**, repo root) + its **`CLAUDE.md` rule**. Founder-approved design:
   - Two sections: **CURRENT STAGING STATE** (last-writer-wins, owned by last pusher) + **DEPLOY LOG** (reverse-chron, capped ~15 honest entries: date · session · commit · what changed · what broke + root cause + fix · for-whom).
   - Authority = last pusher to `staging` (tiebreak: `git log -1 origin/staging`).
   - Add a **`SCHEMA:`** field (`synced` | `prod-migration-pending: <ddl>`) tying to #2.
   - **Seed the first entry** with this incident (the handoff for the poker session): land Phase 0 → leaked `./poker` export broke staging build for ALL sessions 11:57–20:46 → fixed `aff9d6c1`; `wager.ts` `0n` broke db:push repo-wide → fixed; staging DB split off from prod (`mtpixvtclsjqjguouxes`).
   - Rule wording (CLAUDE.md, staging-deploy section): "After any push to `staging`, update `deploy-status.md` same-diff: set CURRENT STATE (only if you pushed last) + add a LOG entry, honest about what broke + why; set `SCHEMA:` if the schema changed."
4. **Staging-DB-isolation doc updates:** drop "staging shares prod Supabase DB" from `CLAUDE.md`, `TODO.md`, `docs/DEPLOY-HETZNER.md`, `.github/workflows/deploy-staging.yml` header comment; document the separate staging DB + the `STAGING_DATABASE_URL` env.

The bundle commit is **code (CI yaml) + docs**, so it deploys once (correct — the CI change must land).

---

## 🎯 #2 — CI-APPLIED BLOCKING MIGRATION (the delicate task, post-compaction)

**Goal (founder, verbatim):** "go straight to the CI-applied migration, **blocking deployments if the migration fails**. This is important and delicate and requires care."

**The gap it closes:** staging + prod now have SEPARATE DBs. Coolify never runs migrations. So a schema change applied to staging does NOT reach prod on merge → prod app crashes querying a missing table. Need automatic, gated application.

**Design sketch (build carefully, full team + adversarial review):**
- A **migration runner** script (idempotent): `CREATE SEQUENCE IF NOT EXISTS "wager_lobby_id_seq"` first, then apply pending migrations (committed `drizzle/*.sql` via `drizzle-kit generate` history, or a forward-only apply). Must fail loudly on any error. Respect the Eliza `tablesFilter` (never drop Eliza tables). Additive-only by default; destructive gated by `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS`.
- **Where:** a NEW job in `deploy-staging.yml` (target = staging DB) and `deploy.yml` (target = **prod** DB) that runs **before** the Coolify-deploy step. Structure: `job migrate` → `job deploy` with `needs: migrate`. If `migrate` fails, `deploy` never runs ⇒ **blocked**.
- **Secrets:** GH runners need the target DB URL as repo secrets: `STAGING_DATABASE_URL` (session pooler) + `PROD_DATABASE_URL` (session pooler). Add via `gh secret set`. Prod URL must be obtained carefully (NOT placed in any committed file).
- **Migration source of truth:** decide — committed versioned `drizzle/` SQL (forward-only) vs generate-and-diff. Forward-only versioned migrations are safest for a prod gate. The current `drizzle/` history is STALE (missing cove/holdem/baccarat/poker/land) — may need a baseline reset (a `0000_baseline.sql` = current prod schema dump) before forward migrations are trustworthy.
- **Risks:** this gates ALL prod deploys on the runner — a bug blocks every prod deploy or mis-applies schema. Hence: build with a collaborative agent team + Codex adversarial pass, test against the STAGING DB first, dry-run mode, and a manual-override escape hatch.
- **Tie-in:** `deploy-status.md`'s `SCHEMA:` field + the migration job's output keep the cross-session record honest.

---

## 🔧 WORKTREE + git state
- Worktree **`C:/Users/newma/Documents/Crypto/cv-land-phase0`** on branch `land-phase0-staging` (tracks `origin/staging`). All staging commits went through here. Commit the pending bundle here + `git push origin HEAD:staging`. **`git worktree remove`** it when fully done.
- Main repo on `feat/openai-text-swap` (founder's WIP-heavy branch). My Phase 0 local commit `6308b478` is there (preserved); the `wager.ts` fix is uncommitted in main — move it to staging via the worktree, then `git checkout -- packages/database/src/schema/wager.ts` in main to keep the founder's branch clean.
- **Staging is currently 🟢** (commit `aff9d6c1`, both apps on staging DB). Last good deploy verified ~04:28 UTC 2026-06-16.

## OPEN ITEMS (priority order)
1. (post-compact) Build #2 CI-applied blocking migration — careful, full team.
2. Commit the pending bundle to staging (incl. `deploy-status.md` seeded with the incident).
3. Promote `staging → master` (PR) so Phase 0 + bundle reach prod; the #2 runner applies the schema to PROD.
4. Rotate prod DB password in `scripts/deploy/railway-env-backup.json` + gitignore it.
5. `git worktree remove` cv-land-phase0 when done.
