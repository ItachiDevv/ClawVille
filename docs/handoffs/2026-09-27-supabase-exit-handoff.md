# Supabase exit — handoff for a fresh session

**Written:** 2026-09-27 by session `sqlFix` (Claude Code, itachi222). **State verified:** 2026-09-27 22:46 UTC.
**Read this whole file before you run anything.** Every fact below was measured in the `sqlFix` session unless it says "NOT VERIFIED".

---

## 1. Founder instruction (2026-09-27)

The founder cannot pay the Supabase bill. The Supabase account will be shut down soon. The founder requires:

1. **Audit all work** done so far to move ClawVille off Supabase. Prove that everything moves to the VPS and nothing breaks.
2. **Backups on the external hard drive** plugged into the laptop. Everything goes there.
3. **Audit the backups** (prove they restore).
4. **One final plan.** No more partial moves.
5. **Explain the bill.** The bill went from a regular bill (~$60 total last month, founder's figure) to +$183 of egress in one month. "Staging is on the VPS" does NOT explain that. The founder asked for this move "a long time ago" and wants to know why prod was still on Supabase.

The founder is very frustrated. Report only measured facts. Do not claim "done" or "fixed" without the founder's sign-off (ClawVille `AGENTS.md` rule E4). Write to the founder in ASD-STE100 Simplified Technical English (global rule).

---

## 2. Current state (verified 2026-09-27 22:46 UTC)

| Item | State |
|---|---|
| Prod app (`api.clawville.world`) | commit `7377a949`, `DATABASE_URL` host `aws-1-us-east-1.pooler.supabase.com:6543` → **still on Supabase** project `wheuidgiyyccqyoppxoa` |
| Prod box `clawville-db` | running since 2026-09-25 23:40 UTC, healthy. Holds a **stale TRIAL copy** (not live, no `clawville.env` marker). The cutover script resets it. |
| Staging app (`api-staging.clawville.world`) | commit `5de4030d`, `DATABASE_URL` host `clawville-db:5432` → **self-hosted on the staging box** since 2026-09-25 23:17 UTC |
| Staging nightly backups | `2026-09-26T04:17Z` 167,146,033 B and `2026-09-27T04:17Z` 167,189,689 B, both `backup ok` (archive read-back passed) |
| Old staging Supabase `mtpixvtclsjqjguouxes` | still exists; data frozen at the 2026-09-25 23:16 UTC copy |
| Fleet on idex (9 × `clawville-econ@<handle>`) | running; `economy-loop.mjs` sha256 prefix `c158d1e9ca2390b1` (the egress patch) |
| Prod DB egress rate | 0.098 MB/s on 2026-09-27 (≈254 GB / 30 d). Was 0.776 MB/s (≈2,012 GB / 30 d) before the fleet patch. |
| `origin/staging` | `40c208e1` (docs only on top of `5de4030d`) |
| `origin/master` | `2a6c4031` (unchanged since 2026-09-23) |
| PR #303 (staging → master) | OPEN, not merged. It now carries every staging commit (bounty limits + self-hosted DB + docs). |

---

## 3. What session `sqlFix` did (2026-09-25) — audit every item

### 3.1 Root cause of the egress (measured)
- Invoice `LSXVGX-00014` (2026-09-25, $233.45 due): Egress for 2026-08-25 → 2026-09-24 = ClawVille prod `wheuidgiyyccqyoppxoa` 2,034.349 GB ($183.09), ClawVille staging 51.62 GB ($4.65), RevealAI 0.07 GB; 250 GB quota discount (−$22.50). Compute 4 × Micro $40 − $10 credit. Pro plan $25. Tax $13.21. PDF: laptop `C:\Users\newma\Downloads\Invoice-LSXVGX-00014.pdf`.
- Live measurement 2026-09-25 21:3x UTC: prod DB `node_network_transmit_bytes_total{device="ens5"}` = 0.776 MB/s ≈ 2,012 GB / 30 d (matches the invoice).
- Cause: the 9 fleet agents on **idex** (`~/clawville-fleet/economy-loop.mjs`, systemd `clawville-econ@{2cold,fathom,grimble,harborlight,kestrel,okuda,sundeck,verdant,wrenlow}`) called `GET /api/bounties/my-bounties` 1–2× per tick (every 20–72 s). The route (`apps/api/src/routes/bounties.ts`) had no limit: each of the 6 posting agents got its whole history (~2.5k bounties + ~6k attempts ≈ 6 MB of DB egress per call).

### 3.2 Fleet patch on idex (live since 2026-09-25 21:45 UTC)
- `myBounties()` helper: one fetch per 15 min (`MY_BOUNTIES_TTL_MIN`), requests `?status=open,in_progress&limit=50`, filters client-side, mirrors POST/REVIEW results locally. Board calls fixed from `limit=` to `pageSize=`.
- Backup of the old file: `~/clawville-fleet/economy-loop.pre-egressfix.mjs` (sha256 `42d318b3…`).
- Effect: 0.776 → 0.037 MB/s (5-min window, 2026-09-25) → 0.098 MB/s (3-min window, 2026-09-27; includes the 15-min refetches).
- Separate finding: the fleet's OpenClaw `--profile fleet` Grok account returns HTTP 402 "run out of credits" on every call (since before 2026-09-21). The fleet runs on random fallback actions. Founder must add credits; not fixed.

### 3.3 PR #303 — bounded `/my-bounties` + `/my-attempts` (on staging, NOT on prod)
- Commits `985e15ac` … `d027a011` (+ docs `7cdbdc2c`). `status` + `limit` params (default 200, max 500), `before` cursor, additive fields `attemptCount`, `statusCounts`, `nextBefore`; web modal changes; PROTOCOL_VERSION 71 → 72.
- Verified on staging: human + agent paths 200, bad input 400, onboarding smoke 14/14.
- Gaps: Codex round 5 did not run (Codex CLI: `401 Unauthorized: Incorrect API key provided: sk-svcac…` while `codex login status` says ChatGPT login — NOT VERIFIED why; check for an `OPENAI_API_KEY` env var overriding the login). Hatcher mock signed-request harness not run (`ALLOW_TEST_PARTNER_PUBKEY` not set on staging). No browser check of the bounty modal.
- With Supabase gone, egress no longer costs money, but PR #303 still stops each fleet call from reading ~6 MB from the local DB.

### 3.4 Staging moved to a self-hosted Postgres (commit `5de4030d`, docs `40c208e1`)
- Box `87.99.142.34`: `/opt/clawville-db/` (mode 700): `docker-compose.yml`, `.env` (mode 600: `POSTGRES_PASSWORD`, `APP_PASSWORD`), `bin/` (scripts), `backups/`. Container `clawville-db`, image `pgvector/pgvector:pg17` (PostgreSQL 17.11, pgvector 0.8.6), volume `clawville-db_pgdata`, published only on `127.0.0.1:5432`, alias `clawville-db` on the `coolify` network. Database `clawville`, owner `clawville`, UTF8, ICU `en-US` (Supabase uses ICU `en-US`, collversion 153.120). `search_path "$user", public, extensions`. Marker `clawville.env=staging`.
- Cutover 2026-09-25 23:16–23:17 UTC: apps stopped, `pg_dump` of `public`, `migrations`, `drizzle` (167 MB, 29 s), restore (22 s). Verified 163/163 tables IDENTICAL exact row counts, sequences IDENTICAL, indexes 470, constraints 605, functions 6, triggers 7, enums 57. Coolify `DATABASE_URL` rows (staging api id 3, web id 4, incl. preview rows) rewritten via the Eloquent model. Redeployed; healthy 23:23 UTC.
- After cutover: onboarding smoke 14/14; the smoke's new avatar exists in `clawville-db`, 0 new avatars in old staging Supabase; browser check of staging `/game`: DB-backed calls 200, only guest 401s.
- CI: `deploy-staging.yml` and `deploy.yml` now open an SSH tunnel (runner `127.0.0.1:15432` → box `127.0.0.1:5432`) before `migrate-ci.ts`. GitHub secret `STAGING_DATABASE_URL` = tunnel URL (set 2026-09-25 23:24:55 UTC). Workflow run `36201243324`: all 4 gates passed, migrate read 85/85 applied migrations through the tunnel, deploy succeeded.
- `apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts`: refuses a DB marked `clawville.env=production`.
- Nightly backup cron `/etc/cron.d/clawville-db-backup` (04:17 UTC, 7-day retention, archive read-back). No offsite copy yet.
- Old URL for rollback: `/opt/clawville-db/.old_database_url` (mode 600).

### 3.5 Prod preparation (NOT cut over)
- Box `5.78.129.176`: same layout; `db-setup.sh` run with `SHARED_BUFFERS=1GB CACHE=4GB MAXCONN=200`. Box: 4 vCPU, 15 GB RAM (12 GB available), 115 GB free disk, load ~0.2.
- Trial copy 2026-09-25 ~23:41–23:43 UTC (apps kept running): dump 537 MB compressed (DB 2.7 GB) in ~1.5 min, restore ~1 min. Object counts all matched (164 tables, 471 indexes, 648 constraints, 6 functions, 7 triggers, 7 sequences, 57 enums). Row counts differed only on hot tables because prod kept writing (expected; the real cutover stops writes first).
- Coolify prod app ids: api = 2 (`ebnatuxblgp4q0antoca9swk`), web = 3 (`ds7hoho685ire522lz3hie2j`). App id 1 (`x145t96frquiebr6xs7bano2`) is an old api — confirm it is not running before cutover.

### 3.6 Files
- Scripts: `scripts/deploy/db/db-setup.sh`, `db-migrate.sh` (copy + verify; refuses a DB that carries the `clawville.env` marker), `db-cutover.sh` (freeze → copy → verify → marker → Coolify env → redeploy; aborts and restarts the old containers on any mismatch), `db-backup.sh`. `supabase-egress-probe.py` (live egress measurement) is committed on the local branch `chore/self-hosted-db` in the worktree but NOT pushed (a `scripts/` change triggers a full staging redeploy); push it with the next real staging change.
- Runbook: `docs/DEPLOY-HETZNER.md` → "Self-hosted database (2026-09-25)". `ARCHITECTURE.md` `DATABASE_URL`. `deploy-status.md` (log entries 2026-09-25).
- Memory: `C:\Users\itachi\.claude\projects\C--Users-itachi-Documents-Crypto\memory\clawville-supabase-egress-my-bounties.md`.

---

## 4. The bill question — what is known and what is NOT

**Measured facts:**
- Fleet tick rate (DECIDE lines, 6 posters): ~7,000/day on every day from 2026-07-27 to 2026-09-25. No jump near 2026-08-25.
- The `/my-bounties` route has returned full history since commit `2ba3e210` (2026-04-09). No API change in the billing cycle.
- History for the 6 posters (cumulative bounties): 2,277 (07-24) → 7,182 (08-08) → 11,483 (08-23) → 14,682 (09-25). Per-call payload roughly doubled between the two cycles.
- `pg_stat_statements` (since 2026-03-05): 1.04 M calls of the creator query; live rate ~17k calls/day.
- Conclusion so far: the fleet should have produced on the order of ~1,000 GB in the 2026-07-25 → 08-24 cycle too, yet the founder reports a ~$60 total bill for that month. **The traffic model alone does not explain the jump. The session's first explanation ("history growth made it look sudden") was wrong and was retracted.**

**NOT VERIFIED hypotheses (do not present as fact):**
1. The org **spend cap** was ON before (Supabase does not charge overage with the cap on) and was turned OFF during the last cycle.
2. Supabase changed how it meters or bills Shared Pooler / database egress.
3. The earlier cycle's egress was actually lower for a reason not yet found.

**Data needed (only the Supabase dashboard has it — the PAT gets `401 JWT could not be decoded` on `/platform/*`):**
- Organization → Usage: per-day egress by service (Database / Shared Pooler / Storage …) for the last 3 billing cycles.
- Organization → Billing: spend cap state + invoices #12 and #13 (PDFs).
- Organization → Audit logs (if the plan shows them): who changed the spend cap or plan, and when.
- Gmail connector needs re-auth (`/mcp`): Supabase invoice/receipt emails may hold the earlier amounts.
- Ways in: the founder downloads the PDFs/screenshots into the laptop `Downloads`, or logs in inside a CDP Chrome the session drives (skill `browser-live`).

**Why prod was still on Supabase:** `docs/DEPLOY-HETZNER.md` (2026-05 Hetzner migration) recorded: "Not included: Postgres on the box. Keeping it on Supabase frees ~1 GB of RAM and eliminates the biggest migration risk." Both prod containers pointed at the Supabase pooler the whole time. Search session logs / memory for the founder's earlier request to move the DB, and report what happened to it.

---

## 5. Everything on the Supabase account (inventory 2026-09-27)

Billed org **`znldqhesvhlvhrknhqnt` "pumpcaster@proton.me's Org" — Pro**:

| Project | Ref | Region | Contents | Depends on it |
|---|---|---|---|---|
| ClawVille (prod) | `wheuidgiyyccqyoppxoa` | us-east-1 | 2.7–2.9 GB; app data in `public` (160 tables), `migrations`, `drizzle`; 0 Auth users; 0 Storage objects | prod api + web, CI `PROD_DATABASE_URL`, `scripts/deploy/.env.deploy`, ops scripts |
| ClawVille-staging | `mtpixvtclsjqjguouxes` | us-east-1 | 730 MB; stale since 2026-09-25 23:16 UTC | local dev `.env.local` files in ClawVille worktrees (now a stale copy) |
| RevealAI | `ltkwykzsnvtmfttiaccg` | us-west-2 | 259 MB DB, 14 public tables, 0 Auth users, **46,321 Storage objects in 2 buckets** | RevealAI app — find its repo and hosts |
| sol-mafia | `fiiwmhyxhyuzszgkqjfz` | eu-central-1 | 12 MB DB, 12 public tables | Sol Mafia app (`SOLMAFIA_DATABASE_URL` on itachi222 points at the eu-central-1 pooler) |

Other orgs visible to the same token (free plan): `isseowarbfelehzfhohv` LotItachi (project `ptcdomfwegkfttxypwek` ACTIVE — a query timed out on 2026-09-27; LotiScan inactive), `tynscmsukdfzcgzwznzy` PolyPocket (vantage, inactive), `mvfauruejhqslhefnkck` StrategyNet (inactive). **Ask the founder whether "the account" means only the billed org or the whole login.** The local `SUPABASE_URL` (`zhbchbslvwrgjbzakeap`) and `SOLTARD_SUPABASE_URL` (`jfgolkmphrsylthfjrpv`) are NOT in this token's project list (another account) — confirm they are unaffected.

---

## 6. Scope for the fresh session (in this order)

### Phase 0 — Read-only audit of the `sqlFix` work (no changes)
Verify each item in §3 on the live systems and in git. Minimum checklist:
- [ ] Staging: both containers `DATABASE_URL` host `clawville-db`, `SOURCE_COMMIT` = `origin/staging` code head, `/health` ok, `clawville.env=staging`.
- [ ] Staging data parity spot-check: pick 5 tables with writes before 2026-09-25 23:16 UTC; old staging Supabase and `clawville-db` agree for rows older than the cutover.
- [ ] Re-read `scripts/deploy/db/*.sh` line by line for bugs (quoting, `set -euo pipefail` + pipes, the live-data guard, secrets never echoed, `.env` modes).
- [ ] Every consumer of the database is covered: `git grep -n -E "DATABASE_URL|pooler\.supabase|supabase\.co|wheuidgiyyccqyoppxoa|mtpixvtclsjqjguouxes"` across `apps/`, `packages/`, `scripts/`, `.github/`, docs. Confirm `ELIZA_DATABASE_URL` is unset on both boxes and the Eliza adapter uses non-Supabase URLs as is (`packages/agent-runtime/src/eliza-runtime.ts` `toSupabaseSessionModeUrl`).
- [ ] Schemas copied: `public`, `migrations`, `drizzle` only. Prove nothing the app reads lives in `auth`, `storage`, `realtime`, `vault`, `extensions` (0 Auth users, 0 Storage objects measured 2026-09-25). Check functions/triggers bodies for `auth.` / `extensions.` references.
- [ ] Roles/privileges: app role `clawville` owns everything restored (`--role=clawville`); no object owned by `postgres` that the app must write.
- [ ] CI: `deploy.yml` tunnel step correct for prod (`COOLIFY_SSH_KEY`, `PROD_VPS_IP`), and `PROD_DATABASE_URL` must change to the tunnel form AT cutover, not before.
- [ ] Other ops tools that hardcode Supabase refs as safety guards (e.g. `packages/database/scripts/grant-test-tokens.ts`, `apps/api/scripts/backfill-avatar-agents.ts`, `apps/api/scripts/ddl/*`, `hosted-skill-runtime-probe.ts` `validateDatabaseUrl`): list each, and decide how its guard works after Supabase is gone (the `clawville.env` marker is the replacement pattern).
- [ ] Run `bun apps/api/scripts/agent-onboarding-smoke.ts --api https://api-staging.clawville.world` again.
- [ ] Write the audit result to `docs/audits/2026-09-XX-supabase-exit-audit.md` with evidence.

### Phase 1 — Backups to the laptop external drive (before any prod change)
- Target: laptop **hoodie-prometh**, drive **`D:\` "Elements"** (WD Elements 2 TB, USB, **exFAT**, 861 GB free on 2026-09-27). Reach: `ssh -n laptop` from itachi222 (profile `C:\Users\newma`). Verify the drive is still mounted first.
- Suggested layout: `D:\supabase-exit-2026-09\<project>\<YYYYMMDDTHHMMSSZ>\` with the dump, `SHA256SUMS`, a `pg_restore -l` TOC, row-count file, and a README (source ref, time, command, tool versions).
- Back up, from Supabase, **every project in the billed org**: ClawVille prod (full `pg_dump -Fc`, all schemas, plus a `pg_dumpall --globals-only` equivalent if allowed), ClawVille-staging, RevealAI (DB **and all 46,321 Storage objects** from both buckets — `pg_dump` does not include Storage files; use the Storage API with the service key), sol-mafia. Also any free-org project the founder wants kept.
- Also copy the self-hosted staging nightly dumps and, after cutover, a prod `clawville-db` dump.
- **Audit the backups:** restore each dump into a throwaway `pgvector/pgvector:pg17` container (on a box or itachi222 Docker if available) and compare exact row counts per table with the source. Compare Storage object count + total bytes + a sample of checksums. Record results in the audit doc.
- Transfer path: dumps are produced where `pg_dump` runs (a box or itachi222) → `scp` to itachi222 → `scp` to `laptop:D:/...`. Never print secrets. exFAT has no practical file-size limit.
- Set up a recurring copy of prod `clawville-db` backups off the prod box (staging box and/or the laptop drive when online) — the prod box currently has no offsite copy.

### Phase 2 — Explain the bill (needs the dashboard data in §4)
Get the per-day egress by service for the last 3 cycles and the spend cap history. Correlate with the fleet logs on idex (`~/clawville-fleet/secrets/<handle>/loop.log`, per-day counts) and the history sizes (§4). Give the founder one clear, evidenced answer. If the data cannot be obtained, say exactly that and why.

### Phase 3 — Final prod cutover (only after Phase 0 + Phase 1 pass and the founder names the window)
1. Pre-flight: Phase 1 prod Supabase backup on `D:\` verified; `clawville-db` healthy on the prod box; confirm Coolify app 1 is not running; decide PR #303 (merge first or after); warn Hatcher (live partner) of the ~10-min outage; note the fleet will see 5xx.
2. Run on the prod box (PowerShell tool; key `~/.ssh/clawville_hillsboro` via the Windows ssh-agent):
   `ENV_NAME=production APP_IDS="2 3" API_C=<ebnatux… container> WEB_C=<ds7hoho… container> DEPLOY_SCRIPT=/root/clawville-deploy.sh SHA=<running prod sha, now 7377a949e9b00f51e9f4925c6e30c30c6e77c547> bash /opt/clawville-db/bin/db-cutover.sh`
   (Check `/root/clawville-deploy.sh` exists and takes a full 40-hex SHA first.)
3. Set `PROD_DATABASE_URL` to the tunnel form from the box (command in `docs/DEPLOY-HETZNER.md`).
4. Verify: both prod containers' `DATABASE_URL` host `clawville-db`, `SOURCE_COMMIT`, `/health`, onboarding smoke against prod, browser check of `https://clawville.world/game`, new rows land in `clawville-db` and not in Supabase, Supabase prod shows no app connections, a prod nightly backup runs.
5. Install the backup cron on the prod box and the offsite copy.
6. Update `deploy-status.md`, `docs/DEPLOY-HETZNER.md`, `ARCHITECTURE.md`, ClawVille `AGENTS.md` (local file, untracked: "Staging has its OWN Supabase DB", "separate Supabase each", "`ELIZA_DATABASE_URL` … derived :5432", "DB: PostgreSQL + Drizzle (Supabase)").
7. Rollback: `.old_database_url` back into Coolify via the Eloquent model + redeploy. Writes after cutover exist only in `clawville-db` — copy them back first or accept their loss.

### Phase 4 — The rest of the account before shutdown
- RevealAI and sol-mafia: find their code and hosts; ask the founder: move to a VPS Postgres (and where), or archive only.
- Local dev: every ClawVille worktree `.env.local` that points at `mtpixvtclsjqjguouxes` → switch to the staging tunnel (`ssh -N -L 15432:127.0.0.1:5432 root@87.99.142.34`) or mark stale. Do not break other sessions' running processes.
- GitHub secrets / `.env.deploy` / memory files that still hold Supabase URLs: update or retire.
- Only after the founder confirms backups on `D:\` are good: pause the Supabase projects. **Never delete a Supabase project without the founder's explicit instruction.**

---

## 7. Hard rules
- No prod change without the founder's explicit "go" for a named window. Hatcher runs live on prod.
- Never print secrets: `/opt/clawville-db/.env`, any `DATABASE_URL`, the service_role key, `.old_database_url`, `.src`.
- Coolify env writes only through the Eloquent model (`feedback_coolify_envvar_encryption` memory). Never raw SQL on `environment_variables.value`.
- `db-migrate.sh` refuses a marked (live) DB — never bypass `I_KNOW_THIS_DROPS_LIVE_DATA` without the founder.
- Git Bash `git show origin/x:path` needs `MSYS_NO_PATHCONV=1`. PowerShell mangles nested quotes over ssh — send scripts as base64 or via Bash heredoc on hosts whose key has no passphrase.
- `codex exec` needs `< /dev/null` (global rule). Codex currently fails with 401 (see §3.3).
- ClawVille rules: staging-first push flow, `deploy-status.md` same diff, docs same diff, E4 (no "done" without founder sign-off).

## 8. Access
| Target | How |
|---|---|
| Staging box `87.99.142.34` | `ssh -i ~/.ssh/clawville_deploy root@87.99.142.34` (no passphrase; Git Bash OK) |
| Prod box `5.78.129.176` | `ssh -i ~/.ssh/clawville_hillsboro root@5.78.129.176` — passphrase key; use the **PowerShell** tool (Windows ssh-agent) |
| idex (fleet) | `ssh -n idex` (PowerShell tool) |
| Laptop hoodie-prometh | `ssh -n laptop` (Git Bash OK); external drive `D:\` |
| Supabase Management API | `SUPABASE_ACCESS_TOKEN` env on itachi222; `POST /v1/projects/<ref>/database/query` for read-only SQL; logs endpoint `/analytics/endpoints/logs` is ClickHouse SQL, ≤24 h window, rate-limits fast |
| Live egress | `python scripts/deploy/db/supabase-egress-probe.py 300 <ref>` |
| Worktree | `C:\Users\itachi\Documents\Crypto\ClawVille\.worktrees\bounty-egress` (branch `chore/self-hosted-db`, tracks `origin/staging`) |
