# Supabase exit — audit record

Last Audited: 2026-09-28. Owner: Supabase-exit session (Claude Code, itachi222), from the handoff `docs/handoffs/2026-09-27-supabase-exit-handoff.md`.

This file records measured facts only. Each fact names its evidence. Nothing here is "done" until the founder signs off (AGENTS.md rule E4). Secrets are never written here.

---

## Phase 0 — read-only audit of the `sqlFix` work (2026-09-27 23:25 – 2026-09-28 00:10 UTC)

### 0.1 Result table

| # | Handoff item | Result | Evidence (section) |
|---|---|---|---|
| 1 | Staging app runs on the self-hosted DB | PASS | 0.2 |
| 2 | Staging data parity (old Supabase vs `clawville-db`, rows older than the cutover) | PASS (8 tables identical; `memories` explained) | 0.3 |
| 3 | `scripts/deploy/db/*.sh` line-by-line review | FAIL — 10 defects. Fixed before the window; Codex r8 PASS (§3.4). Box tests pending. | 0.4 |
| 4 | Every database consumer is covered | PASS for the app. Local files and ops tools listed. | 0.5 |
| 5 | Only `public`, `migrations`, `drizzle` hold app data | PASS | 0.6 |
| 6 | Role `clawville` owns every restored object | PASS (staging and the prod trial copy) | 0.7 |
| 7 | CI tunnel for prod | PASS (not used until the cutover) | 0.8 |
| 8 | Ops tools with Supabase-ref guards | 1 tool failed open after the prod cutover; 6 tools were unusable on the new staging DB. Fixed (catalog marker), Codex r9 APPROVE (§3.4). | 0.9 |
| 9 | Onboarding smoke on staging | PASS 14/14 | 0.10 |
| 10 | Fleet patch on idex | PASS | 0.11 |
| 11 | Prod egress now | 0.104 MB/s ≈ 269 GB / 30 d (above the 250 GB quota) | 0.12 |
| 12 | NEW: prod Supabase REST API is open to the anon key | Was open. Closed 2026-09-28 01:24:24 UTC with the founder's approval (anon/authenticated revoked). | 0.13 |

### 0.2 Staging app on the self-hosted DB

- Containers (2026-09-27 23:29 UTC): api `yvtwz7snaghxifkjhyxknffu-233253744110` and web `ju0n3sddhll3cuhbrspt4muy-233253770332`. Both: `DATABASE_URL` host `clawville-db:5432`, `SOURCE_COMMIT=5de4030d4f446b026a6edc865c20e31493ba8dc6`, `ELIZA_DATABASE_URL` unset. The api has `CLAWVILLE_ENV=staging`.
- `origin/staging` is `e876947a`. `git diff --stat 5de4030d origin/staging` shows 2 doc files only (`deploy-status.md`, the handoff). So the running commit is the code head.
- Coolify env rows (tinker, read-only): app 3 (api) and app 4 (web), normal and preview `DATABASE_URL` rows, all host `clawville-db:5432`.
- `https://api-staging.clawville.world/health` → `{"status":"ok","commit":"5de4030d…"}`. `https://staging.clawville.world/` → 200.
- DB marker: `current_setting('clawville.env')` = `staging`. PostgreSQL 17.11. Size 673 MB. DB settings: `search_path="$user", public, extensions;clawville.env=staging`, ICU `en-US`.
- Live connections to `clawville-db`: 5 `postgres.js` + 2 unnamed (Eliza `pg`) from the api container address only.
- No `.env*` file with a database key is baked into any app image (staging and prod). The only file is `apps/web/.env.example` with no DB keys.
- Nightly backups: `backup.log` has `2026-09-26T04:17:25Z backup ok … 167146033 bytes` and `2026-09-27T04:17:25Z backup ok … 167189689 bytes`.

### 0.3 Staging data parity

Method: for each table, rows with `created_at < 2026-09-25 23:16:00+00`, count plus an order-independent row hash (`sum` of a 60-bit `md5` prefix of `t::text`). For `users`, `avatars`, `wallets` the hash covers `id` and `created_at` only, because the app updates these rows. Both sides read with `timezone=UTC`. Script: session scratch `parity2.sh`, run on the staging box in a `pgvector/pgvector:pg17` container.

| Table | Old staging Supabase | `clawville-db` | Result |
|---|---|---|---|
| claw_token_transactions | 3,511 | 3,511 | MATCH (hash equal) |
| logs | 83,492 | 83,492 | MATCH |
| covenant_action_records | 61,501 | 61,501 | MATCH |
| poker_cash_hands | 46,282 | 46,282 | MATCH |
| clv_price_snapshots | 180,905 | 180,905 | MATCH |
| users (id, created_at) | 368 | 368 | MATCH |
| avatars (id, created_at) | 344 | 344 | MATCH |
| wallets (id, created_at) | 407 | 407 | MATCH |
| memories | 6,231 | 6,227 | DIFF — explained below |

`memories`: the 4 absent rows are `type='messages'` rows from 2026-09-19 06:30–06:35 UTC. At the cutover both sides had 6,231 rows (`/opt/clawville-db/backups/count.src` and `count.dst`). `pg_stat_user_tables` on `clawville-db` shows `n_tup_ins=6231`, `n_tup_del=4`. `pg_stat_statements` shows the delete: 4 calls, 4 rows of `DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE type = $2 AND created_at < now() - make_interval(days => $1) LIMIT $3)`. That is the daily 7-day message sweeper (`apps/api/src/services/message-memory-sweeper.ts:73`). The copy was complete. The app deleted the rows later, as designed.

The old staging Supabase is frozen: its newest rows are `clv_price_snapshots` 2026-09-25 23:15:32 UTC and `claw_token_transactions` 22:56:24 UTC. Versions: Supabase 17.6, `clawville-db` 17.11.

**Incident during this audit.** My first parity script used `md5(string_agg(row))`. On the `logs` table this made the old staging Supabase server restart at 2026-09-27 23:32:19 UTC (`pg_postmaster_start_time`). No app uses that project, so no user saw an effect. I stopped the script and used the streaming hash above. I did not run that query form on prod.

### 0.4 `scripts/deploy/db/*.sh` review

The copies on both boxes (`/opt/clawville-db/bin/`) are byte-identical to git (sha256 prefixes: backup `d15e6c92491915fe`, cutover `9f77471cc7eb836c`, migrate `2353a873e17d0fab`, setup `4bd75e36bab6c5bb`).

Independent review: Codex CLI 0.156.0 (ChatGPT login), scripts inlined in the prompt, `VERDICT: FAIL`. Codex and this review agree on every item below.

| ID | File:line | Defect | Failure scenario | Fix plan |
|---|---|---|---|---|
| S1 | `db-cutover.sh:15-16` | Writes `.old_database_url` before it checks the URL. | A second run after a cutover overwrites the only Supabase rollback URL with the new URL, then exits. | Check a temp copy first. Never overwrite an existing rollback file. |
| S2 | `db-migrate.sh:21-24` | Live-data guard fails open: a failed marker query gives an empty marker. | A connection error on the marker query lets the script reach `DROP DATABASE clawville` on a live DB. | Check that the DB exists; make a failed marker query fatal. |
| S3 | `db-migrate.sh:17,57,63` | `run()` uses `bash -c` without `-euo pipefail`. | If both `psql` count queries fail, both files are empty and the script prints `ROWCOUNTS: IDENTICAL` with 0 tables. | Strict mode inside `run`. Refuse 0 tables. |
| S4 | `db-migrate.sh:59-61` | Object counts are printed, never compared. | A restore with a missing index or constraint passes the cutover gate. | Compare `obj.src` and `obj.dst`; the cutover requires `OBJECTS: IDENTICAL`. |
| S5 | `db-cutover.sh:35-47` | Coolify update counts are not checked. | `updated=0` (wrong `APP_IDS`) still redeploys; a partial update splits api and web across two DBs. | Require one updated + read-back row per app id; on a mismatch, write the old URL back and restart the old containers. |
| S6 | `db-backup.sh:12` | `pg_restore -l` reads only the archive table of contents. | A damaged data block passes the nightly check. | Restore each nightly dump into a throwaway container and check the table count. |
| S7 | `db-migrate.sh:17,46-63`; `db-cutover.sh:35`; `db-setup.sh:74` | Passwords go on process command lines (`docker run -e SRC=…`, `psql "$URL"`, `-v app_pw=…`, `docker exec -e NEWURL=…`). | Any local process listing on the box shows the DB passwords during the run. | Pass values by environment name only (`-e VAR`), `PGPASSWORD`, and `\getenv`. |
| S8 | `db-setup.sh:10`; `db-backup.sh:9` | Default umask for `backups/` and dumps. | Prod `backups/` is mode 755, dumps 644. The parent `/opt/clawville-db` is 700, so there is no exposure now; a moved file keeps loose modes. | `umask 077`; `chmod 700 backups`. |
| S9 | `db-cutover.sh:31` | `ENV_NAME` goes into SQL without a check. | A typo marks the DB with a wrong value; the probe guard then allows prod. | Accept only `staging` or `production`. |
| S10 | `db-cutover.sh:19-20` | Only two containers stop. | A CI deploy during the window starts containers on Supabase. The row-count gate then aborts, but the window is lost. | Runbook: disable `deploy.yml` during the window (`gh workflow disable`), enable it after. |

Also found (not a defect in these scripts): the prod Coolify has only apps 2 (api) and 3 (web). App 1 (`x145t96frquiebr6xs7bano2`) no longer exists and no container runs for it. Prod has 0 Coolify scheduled tasks. The prod box cron runs only `/root/cv-inference-watchdog.sh` (no DB access). `openclaw-local` and `hermes-local` on the prod box have no DB variables.

### 0.5 Database consumers

App code:
- No `@supabase/*` package in any `package.json`. No `process.env.*SUPABASE*` read in app code. The app uses Supabase only as Postgres.
- DB access goes through `DATABASE_URL`: `packages/database/src/index.ts` (postgres.js, `prepare: false`), the Eliza adapter (`packages/agent-runtime/src/eliza-runtime.ts:516-520`), `agent-orchestrator.ts`, `avatar-simulation-bridge.ts`, `collaboration-broker.ts`, `db-canary.ts`, `eliza-migrator.ts`.
- `toSupabaseSessionModeUrl` (`eliza-runtime.ts:127-133`) changes only `pooler.supabase.com:6543` URLs. A `clawville-db:5432` URL passes unchanged. `ELIZA_DATABASE_URL` is unset in all 4 app containers (staging and prod).
- `prepare: false` is not required on a direct connection. It stays correct (small cost only).

Connections to prod Supabase (`pg_stat_activity`, 2026-09-27 23:35 UTC): 21 `postgres` via Supavisor (the app), plus Supabase internal roles and 1 PostgREST (`authenticator`). No other client.

Other hosts:
- idex: the fleet uses the HTTP API only. No ClawVille DB URL on idex. `~/.itachi-brain-env` holds `SOLMAFIA_DATABASE_URL` (sol-mafia, billed org) and `SOLTARD_SUPABASE_*` (other account). See Phase 4.
- Prod box: `/root/envs.json` (2026-05-24 env export, mode 644 in `/root`) holds the prod Supabase `DATABASE_URL` for api, web, and web build. `/etc/update-motd.d/00-clawville-env:6` prints "Supabase project: wheuidgiyyccqyoppxoa (LIVE USER DATA)". Both change at the cutover (Phase 3).
- itachi222 (all git-ignored): `ClawVille/.env.local` (`DATABASE_URL`, `STAGING_DATABASE_URL` → old staging Supabase), `ClawVille/.env.deploy` (`STAGING_DATABASE_URL` → old staging), `ClawVille/packages/database/.env.local` (`DATABASE_URL` → old staging), `ClawVille/scripts/deploy/railway-env-backup.json`, `ClawVille/.migration-out/envs.json`, `ClawVille/.migration-out/coolify-apps-3-4-export.txt` (prod URL), `cv-dd-audit/.local-evidence/dd-natural-chat-20260923/*.mjs` (staging URL), `~/.clawville-brain/plans/land-economy/CONTINUATION.md` (prod ref). Local dev processes that use these files write to the stale staging Supabase copy. See Phase 4.
- CI: `STAGING_DATABASE_URL` (set 2026-09-25 23:24:55 UTC, tunnel form), `PROD_DATABASE_URL` (set 2026-06-16, Supabase).

### 0.6 Schemas that are copied, and schemas that are not

Prod Supabase `wheuidgiyyccqyoppxoa` (PostgreSQL 17.6, 2,880 MB), read-only queries through the Management API as `supabase_read_only_user`:
- Copied: `public` 160 tables, `migrations` 3, `drizzle` 1 (`__drizzle_migrations`, 0 rows) = 164 tables.
- Not copied: `auth` 27 tables (`auth.users` = 0 rows), `storage` 8 tables (0 buckets, 0 objects), `realtime` 3 tables (publication `supabase_realtime` has 0 tables), `vault` (0 secrets), `extensions` and `graphql` (0 tables), `cron` (0 jobs).
- The 6 app functions and 7 triggers are all in `public`. Their bodies call only `public.` functions: `capture_building_chat_reward_claim`, `clawville_claim_cosmetic_supply`, `covenant_action_records_guard`, `covenant_no_truncate`, `covenant_seal_batches_guard`, `guard_atomic_xp_update`.
- No column type, column default, foreign key, or view in the 3 copied schemas refers to `auth`, `storage`, `realtime`, `vault`, `extensions`, `graphql`, `net`, or `cron`.
- Extensions: `vector` 0.8.0 and `fuzzystrmatch` in `public`; `pgcrypto`, `uuid-ossp`, `pg_stat_statements` in `extensions`. `clawville-db` has the same placement (`vector` 0.8.6).
- Old staging Supabase has no `drizzle` schema, so 163 tables there is correct.

### 0.7 Ownership and privileges

Staging `clawville-db` and the prod trial copy: role `clawville` owns 630 `public` relations, 9 `migrations` relations, 3 `drizzle` relations (prod), 6 functions, 57 enum types, and the schemas `public`, `migrations`, `drizzle`, `extensions`. `clawville` is not a superuser. `pg_hba`: `host all all all scram-sha-256`; the port is published only on `127.0.0.1:5432` (`ss -ltnp`) and the `coolify` network.

Prod trial copy (2026-09-25 23:43, apps running): object counts equal (164 tables, 471 indexes, 648 constraints, 6 functions, 7 triggers, 7 sequences, 57 enums). Row counts differ only on hot tables, and the source count was taken after the dump, as expected with live writes. `npc_memories` is higher in the copy because the npc-memory prune ran on the source between dump and count. The prod box: 4 vCPU, 15 GB RAM (11 GB available), 111 GB free disk.

### 0.8 CI

- `deploy.yml` (on `staging`, in PR #303; not yet on `master` `2a6c4031`): the tunnel uses `COOLIFY_SSH_KEY` + `PROD_VPS_IP`, the same pair the working "Trigger Coolify deploys" step uses. Prod `sshd -T`: `allowtcpforwarding yes`, `permitopen any`. Until the cutover the tunnel opens and is not used.
- `deploy-staging.yml` uses `STAGING_COOLIFY_SSH_KEY` + `STAGING_VPS_IP`; run `36201243324` passed through it.
- `PROD_DATABASE_URL` must change to `postgresql://clawville:<APP_PASSWORD>@127.0.0.1:15432/clawville` at the cutover, not before. The comment at `deploy.yml:34` still says "Supabase SESSION-pooler URL" — update at the cutover.
- PR #303: OPEN, MERGEABLE, 10 commits (bounty limits + self-hosted DB + docs).

### 0.9 Ops tools that use Supabase refs as safety guards

| Tool | Guard now | After Supabase | Plan |
|---|---|---|---|
| `apps/api/scripts/repair-provisioning-pending.ts:14,36` | Needs `--allow-prod` if the URL contains the prod ref. | **Fails open**: the tunnel URL `127.0.0.1:15432` has no ref, so prod runs without `--allow-prod`. | Read `clawville.env`; require `--allow-prod` for `production`. Before the prod cutover. |
| `apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts:18-19,209-229,1150-1155` | Refuses the prod ref and `clawville.env=production`. | Codex round 5 found: an unmarked restored copy was accepted, and the on-box staging run (host `clawville-db`) was refused. | Fixed 2026-09-28 (§3.4): `staging` only; unmarked needs `--allow-unmarked-db` + a local URL; `clawville-db` needs the `staging` marker. |
| `packages/database/scripts/grant-test-tokens.ts:14-40` | Accepts only the staging Supabase URL. | Fails closed: cannot run on the new staging DB. | Accept a loopback URL when `clawville.env=staging`. |
| `apps/api/scripts/seed-test-accounts.ts:40` | URL must contain the staging ref. | Fails closed. | Same marker pattern. |
| `scripts/parity/pack-preflight.ts:127,190,273`, `reset-guest-shoes.ts:24`, `teardown.ts:174` | URL must contain the staging ref. | Fail closed. | Same marker pattern. |
| `apps/api/scripts/backfill-avatar-agents.ts:80-88` | URL must contain the `--ref` value. | Weak: any substring passes. | Same marker pattern. |
| `apps/api/scripts/cove/*.ts` | Rewrite `:6543` → `:5432`. | No effect on non-Supabase URLs. | None. |

### 0.10 Onboarding smoke

`bun apps/api/scripts/agent-onboarding-smoke.ts --api https://api-staging.clawville.world` (2026-09-27 ~23:37 UTC): 14/14 PASS. The new avatar is in `clawville-db` (1 row in the last 15 minutes). The old staging Supabase got 0 new avatars.

### 0.11 Fleet on idex

`clawville-econ@{2cold,fathom,grimble,harborlight,kestrel,okuda,sundeck,verdant,wrenlow}` all `active running`. `economy-loop.mjs` sha256 prefix `c158d1e9ca2390b1` (the egress patch). Backup `economy-loop.pre-egressfix.mjs` `42d318b3e81920dd`. `MY_BOUNTIES_TTL_MIN` default 15 (line 157).

### 0.12 Prod egress now

`python scripts/deploy/db/supabase-egress-probe.py 300 wheuidgiyyccqyoppxoa` (2026-09-27 ~23:45 UTC, 306 s window): transmit 0.104 MB/s → 269.0 GB / 30 d; receive 0.024 MB/s. Largest result sets: the `bounty_attempts` "my attempts" list (5.6k–6.5k rows per call, the fleet's 15-minute refetch), an `agent_trade_daily` analytics query, and the `bounties` list. The rate is above the 250 GB quota, so each day on Supabase still adds egress cost.

### 0.13 NEW — prod Supabase REST API is open to the anon key

- `anon` and `authenticated` have SELECT, INSERT, DELETE on all 160 `public` tables in prod (`has_table_privilege`). RLS is on for 0 tables; 0 policies.
- PostgREST config (Management API `/postgrest`): `db_schema = public,graphql_public`.
- Proof with no row data: `HEAD /rest/v1/clv_price_snapshots?select=id` with the prod anon key and `Prefer: count=exact` → HTTP 206, `Content-Range: 0-999/116969`. The same request on old staging → HTTP 401 (staging `anon` has 0 table grants).
- Effect: a person with the prod anon key or the new publishable key can read and change every table, which includes `users` (password hashes), `wallets`, and sessions.
- Exposure of the key: the anon key, the publishable key, and `wheuidgiyyccqyoppxoa.supabase.co` appear in 0 commits of the repo history (`git log --all -S`). The app has no Supabase SDK, so the web bundle does not carry the key.
- Use: `pg_stat_statements` (since 2026-03-05) has no statement from `anon` or `authenticated`. This is not complete proof, because the view keeps at most 5,000 statements.
- Fix options (prod change — needs the founder's go): revoke `anon`/`authenticated` privileges on `public`, or remove `public` from the exposed schemas. The app connects as `postgres` through Supavisor, so neither option affects the app. The cutover plus a project pause also closes it.
- **Done 2026-09-28 01:24:24 UTC (founder chose "Revoke anon now"):** `revoke all on all tables / sequences in schema public from anon, authenticated` + the same for `postgres`'s default privileges, in one transaction. Before-state saved (session scratch `sec/prod-public-acl-before-20260928.txt`, `sec/prod-default-acl-before-20260928.txt`); rollback = `grant all … to anon, authenticated`. Verified: `anon`/`authenticated` have 0 privileges on 160/160 tables; REST with the anon key and with the publishable key → HTTP 401 (`42501 permission denied`) on `clv_price_snapshots`, `users`, `wallets`; `/health` ok; prod api logs 01:24–02:23 UTC: 17,559 lines, 0 `permission denied`, 0 `42501`.

### 0.14 Tooling notes

- Codex: the old 401 did not occur. `codex login status` = ChatGPT. The `codex` wrapper fails because `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` is a junction that Windows blocks ("untrusted mount point"). The binary `~/.codex/packages/standalone/releases/0.156.0-x86_64-pc-windows-msvc/bin/codex.exe` works. Its read-only sandbox cannot start a shell (`CryptUnprotectData failed: 2148073483`), so a review must carry the file text in the prompt.
- Prod box SSH from Git Bash works with the Windows agent: `/c/WINDOWS/System32/OpenSSH/ssh.exe -n -i C:/Users/itachi/.ssh/clawville_hillsboro root@5.78.129.176`. Use `-n` when no script goes on stdin.

---

## Phase 1 — backups on the laptop drive (2026-09-28 01:33 – 02:45 UTC)

Target: laptop hoodie-prometh, `D:\` "Elements" (WD Elements 2 TB, USB, exFAT, 861 GB free before the copy). Index file: `D:\supabase-exit-2026-09\README.md`.

### 1.1 Method

- Dumps ran on the staging box in a `pgvector/pgvector:pg17` container (pg_dump 17.11; every source is PostgreSQL 17.6). Scripts: session scratch `sb-dump-inner.sh`, `sb-dump.sh`, `sb-restore-test.sh`, `restore-plain.sh`, `storage-fetch.sh`.
- Each dump is a full `pg_dump -Fc` of all schemas plus `globals.sql` (`pg_dumpall --globals-only --no-role-passwords`). A psql session exports one snapshot; `pg_dump --snapshot` and the exact per-table `count(*)` both use it. So `rowcounts.src` describes exactly the data in the dump.
- Credentials: ClawVille prod = the prod api container's `DATABASE_URL` (piped to a mode-600 file on the staging box, never printed, shredded after use). ClawVille staging = `/opt/clawville-db/.src`. RevealAI and sol-mafia = a temporary Supabase CLI login role (`POST /v1/projects/<ref>/cli/login-role`, 300 s TTL, deleted after the dump by `DELETE …/cli/login-role`), direct host `db.<ref>.supabase.co:5432` over IPv6, `--role=postgres`.
- `SOLMAFIA_DATABASE_URL` on itachi222 is stale: Supabase rejects its password (`password authentication failed`). See Phase 4.
- Restore test: each dump restored into an empty throwaway container; source roles created from `globals.sql` (except the local superuser `postgres`); exact `count(*)` per table compared with `rowcounts.src`.

### 1.2 Results

| Backup | Tables | Rows | Dump bytes | Restore test |
|---|---|---|---|---|
| ClawVille prod Supabase (`20260928T013735Z`, dump 111 s) | 203 | 1,767,343 | 540,591,326 | 202 tables, 1,767,343 rows, all equal. Absent: `vault.secrets` (0 rows). 7 errors, all `supabase_vault` objects. |
| Old ClawVille staging Supabase (`20260928T013457Z`) | 202 | 469,128 | 167,417,610 | all rows equal; only `vault.secrets` (0 rows) absent; 8 vault errors |
| RevealAI (`20260928T013616Z`) | 53 | 116,995 | 76,961,007 | all rows equal; only `vault.secrets` (0 rows) absent; 7 vault errors |
| sol-mafia (`20260928T013352Z`) | 48 | 540 | 268,046 | all rows equal; only `vault.secrets` (0 rows) absent; 8 vault errors |
| Self-hosted staging `clawville-db` (`20260928T015237Z`) | 163 | 471,987 | 167,231,978 | 0 errors, 163/163 tables equal |
| Self-hosted staging nightly dumps 09-25 23:26, 09-26 04:17, 09-27 04:17 | 163 each | 468,940 / 469,233 / 470,671 | ~167 MB each | 0 errors each (no snapshot counts exist for cron dumps) |
| Cutover source `src.dump` (old staging Supabase at 2026-09-25 23:16) | 163 | 468,910 | 167,131,730 | with the target prepared like `db-migrate.sh`: counts equal `count.src` for all 163 tables |

`vault.secrets` belongs to the Supabase-only `supabase_vault` extension; plain PostgreSQL cannot load it. It has 0 rows in all 4 projects (checked in Phase 0 for prod). No data is lost.

RevealAI Storage: `storage.objects` lists 46,321 objects, all in bucket `repo-code` (594,417,746 bytes; bucket `wall-of-shame` has 0). Downloaded from the public object URLs (16 parallel, 2,818 s). 3 objects failed in the first pass and succeeded on retry. Final check on the box: 46,321 files, 594,417,746 bytes, the MD5 of every file equals its Supabase eTag (`STORAGE: IDENTICAL`). Packed as `revealai-storage-repo-code.tar` (46,321 entries) with `manifest.tsv` and `compare.tsv`.

### 1.3 Copy to the laptop and checks there

- The laptop pulled every folder from the staging box with its own key (about 25 MB/s). `D:\supabase-exit-2026-09\` holds `clawville-prod-supabase`, `clawville-staging-supabase`, `revealai`, `solmafia`, `clawville-staging-selfhosted`, `clawville-staging-selfhosted-nightly`, `revealai-storage-pack`.
- SHA-256 check on the laptop of every file in every `SHA256SUMS`: **40 ok, 0 bad**.
- The Storage tar is unpacked on the laptop (`extracted\`, `tar.exe` exit 0, 797 s). The laptop MD5-checked every unpacked file against `manifest.tsv`: **ok=46,321, bad=0, missing=0, 594,417,746 bytes** (1,580 s).

### 1.4 Recurring copies

- Laptop task "ClawVille DB backup pull" (Task Scheduler, user `itachisan`, daily 09:30 local, runs late if the laptop was off). Script `C:\Users\newma\clawville-backup-pull.ps1`: copies each new `clawville-*.dump` from the staging box `/opt/clawville-db/backups` (and `/opt/clawville-db/offsite/prod` after the prod cutover) to `D:\clawville-db-backups\{staging,prod}`, checks SHA-256, keeps the newest 60 per environment. Test run 2026-09-28 02:36 UTC: 3 staging dumps copied, SHA-256 ok. Log: `C:\Users\newma\clawville-backup-pull.log`.
- Prod → staging box offsite copy: prepared, installed in the cutover window (Phase 3), because the prod `clawville-db` is not live yet.

---

## Phase 2 — the bill jump

### 2.1 Data that exists

| Source | What it shows |
|---|---|
| Invoice `LSXVGX-00014` PDF (laptop Downloads) | Aug 25 – Sep 24: egress prod 2,034.349 GB ($183.09), old staging 51.62 GB ($4.65), RevealAI 0.07 GB; quota discount −$22.50; compute 4 × Micro $40 − $10; Pro plan $25 (for Sep 25 – Oct 24); tax $13.21; total $233.45, OUTSTANDING. |
| Invoice list screenshot (laptop, 2026-09-25 17:25) | #14 Sep 24 $233.45 outstanding · #13 Aug 24 $58.95 paid · #12 Aug 14 $17.95 paid · #11 Aug 14 $0.00 paid · #10 Jul 24 $96.44 paid · "14 invoices". |
| Prod DB server network counter (`node_network_transmit_bytes_total`, ens5; scrapes 2026-09-27 18:46 and 18:49 UTC) | 3,613.4 GB sent since the server start (Postgres up since 2026-03-05 07:21 UTC). |
| Fleet logs (idex, copied 2026-09-25 18:34 UTC) | Per-day ticks and actions for all 9 agents from 2026-07-20. Loop restarts: Jul 28–29, Aug 6, 8, 10, Sep 11, Sep 25 (fix). Same code from Aug 10 to Sep 11. |
| Prod DB (read-only aggregates) | Per agent, per day: number and text size of its bounties and of the attempts on them (the exact rows `/my-bounties` returned). |

### 2.2 Model of the fleet egress (no fitted factor)

Each fleet tick called `GET /api/bounties/my-bounties` once (`gatherState`), and again for a post or review action. On prod (`7377a949`) the route returns every bounty of the agent plus every attempt on them (`apps/api/src/routes/bounties.ts:367-388` on `master`). Model per day = Σ agents (calls that day × size of that agent's history that day, text bytes + Postgres row headers). Script: session scratch `p2/egress_model.py`, output `p2/egress-model.out`.

| Billing cycle | Model (fleet only) | Billed egress | Egress charge |
|---|---|---|---|
| Aug 25 – Sep 24 | 1,980 GB | 2,034 GB (all prod egress) | $183.09 − $22.50 quota = $160.59 + tax |
| Jul 25 – Aug 24 | ≥ 1,215 GB (Jul 25 not in the logs) | not on invoice #13 | invoice #13 total $58.95 |

- The model matches invoice #14 to 97% with no tuning. So the model is sound.
- Cross-check: 3,613 GB (counter) − 2,034 GB (cycle #14) − about 84 GB (Sep 25 – Sep 27) ≈ 1,495 GB sent before Aug 25. The model gives about 1,215 GB for Jul 26 – Aug 24; the other ~280 GB is normal app traffic over ~5.5 months. The two sources agree.
- Traffic grew 1.63× between the two cycles, because each agent's history grew. It did not jump at the cycle boundary: the same fleet code ran from Aug 10 to Sep 11.

### 2.3 What the invoices show

- Fixed part of each month: Pro $25 + compute $40 − $10 credit = $55.00 + 6% tax = $58.30.
- Invoice #13 (Jul 25 – Aug 24) = $58.95 = the fixed part + $0.61 before tax. About 965 GB above the 250 GB quota (≈ $87 before tax at $0.09/GB) was **not charged**.
- Invoice #14 (Aug 25 – Sep 24) charged the full egress.
- So the bill went from ~$60 to $233 because Supabase started to charge the egress, and the egress also grew 1.63×. The traffic was already large in the month before.

### 2.4 Most likely cause of the billing change — NOT VERIFIED

The org **spend cap**. With the spend cap on, Supabase does not charge usage above the quota for egress. The two extra invoices on **Aug 14** (#11 $0.00 and #12 $17.95, mid-cycle) show that a billing or subscription change happened that day. What that change was is not known.

### 2.5 Data that is missing (exact list)

1. Invoices #10, #11, #12, #13 as PDF (line items). Dashboard → Organization → Billing → Invoices → download.
2. The spend cap: its state now, and when it changed (Organization → Billing → "Cost control / Spend cap"; Organization → Audit logs, if the plan shows them).
3. Organization → Usage → Egress, per day, for Jun 25 – Sep 27 (screenshots are enough).
The Management API token cannot read billing (`/platform/*` rejects it). Gmail needs a new sign-in (`/mcp`), and the Supabase bills go to `pumpcaster@proton.me`, which Gmail cannot read. No session transcript before 2026-07-21 (itachi222) or 2026-08-02 (laptop) exists.

### 2.6 Why prod was still on Supabase

- Commit `53f7336d` (2026-04-10) wrote the Hetzner plan in `docs/DEPLOY-HETZNER.md`: "DB | Supabase (unchanged) | Already working, no migration risk" and "Not included: Postgres on the box. Keeping it on Supabase frees ~1 GB of RAM and eliminates the biggest migration risk." The May 2026 move followed that plan. The line stayed until `5de4030d` (2026-09-25).
- An itachi memory lesson from 2026-04-13 says the opposite ("consolidate Next.js, Bun API, and Postgres on a single flat-rate instance"). The plan and the lesson disagreed, and the plan won.
- The memory file `clawville-supabase-egress-my-bounties` records that before 2026-09-25 the founder believed prod already used Postgres on Hetzner. No surviving transcript holds the founder's earlier request text.

### 2.7 The current cycle (Sep 25 – Oct 24)

Estimate (not measured per day): about 72 GB on Sep 25 before the fleet fix, then 0.04–0.10 MB/s. Now 0.104 MB/s ≈ 9 GB/day. The 250 GB quota lasts until about Oct 15. A prod cutover before then keeps this cycle's egress charge near $0, if Supabase bills it like #14. Compute ($10 per project per month, hourly) continues while the 4 projects exist.

---

## Phase 3 — the final prod cutover plan (prepared; NOT run)

Nothing in this section runs without the founder's "go" and a named time. Hatcher runs live on prod.

### 3.1 Before the window (no prod change)

1. Script fixes S1–S9 and the ops-tool guards (Phase 0 §0.4, §0.9) and the PR #303 Codex round-5 findings: implemented by the team, audited by Codex, pushed to `staging`, deployed, verified on staging (§3.4 records the results).
2. PR #303 gates: Codex APPROVE on the final range; mock-Hatcher harness on staging (`apps/api/scripts/hatcher/run-mock-e2e.md`; `ALLOW_TEST_PARTNER_PUBKEY` set on staging only for the run, then removed); browser check of the bounty board modal on staging.
3. New scripts installed in `/opt/clawville-db/bin/` on both boxes. On prod, `PREFLIGHT_ONLY=1 … db-cutover.sh` must print `PREFLIGHT: PASS` (read-only).
4. A fresh trial copy on the prod box with the fixed `db-migrate.sh` while the apps run (writes only to the unmarked trial DB).

### 3.2 The window (founder names the time)

| Step | Action | Expected time |
|---|---|---|
| W0 | Founder tells Hatcher: prod API down for about 10 minutes. `gh workflow disable deploy.yml`. | — |
| W1 | Merge PR #303 (prod deploy of the bounty limits + CI tunnel). Verify `SOURCE_COMMIT` on both prod containers, `/health`, browser check. | ~6 min |
| W2 | Write barrier: `POST /v1/projects/wheuidgiyyccqyoppxoa/network-restrictions/apply` with `dbAllowedCidrs ["5.78.129.176/32"]`, `dbAllowedCidrsV6 ["2a01:4ff:1f0:3d61::1/128"]` (the prod box only). Verify from the staging box that a pooler connection is refused. It stays applied after the cutover; an abort still works because the old containers run on the prod box. Then `PREFLIGHT_ONLY=1` cutover script → `PREFLIGHT: PASS`. | 3 min |
| W3 | `SOURCE_BARRIER=network-restricted ENV_NAME=production APP_IDS="2 3" API_C=<api> WEB_C=<web> DEPLOY_SCRIPT=/root/clawville-deploy.sh SHA=<running 40-hex sha> bash /opt/clawville-db/bin/db-cutover.sh`. Under one lock it: stops the apps one at a time; waits 15 s and fingerprints the source (DML counter, relfilenodes, sequences, catalog definitions); copies; requires ROWCOUNTS (count + row hash per table), OBJECTS and SEQUENCES IDENTICAL and QUIESCENT: YES (second fingerprint equal); marks the DB `production` and reads the marker back from the catalog; switches `DATABASE_URL` for apps 2 and 3 (every row checked; on failure it reverts, proves the revert, and only then restarts the old containers); redeploys; waits for the new containers; re-checks the source (`SOURCE AFTER SWITCH: UNCHANGED`). Any failure before the switch restarts the old containers on Supabase. | copy ~5 min (2 × 15 s settles + hashing) + redeploy; outage ~7–12 min |
| W4 | Set `PROD_DATABASE_URL` to the tunnel form (command in `docs/DEPLOY-HETZNER.md`, value never printed). | 1 min |
| W5 | Verify: both containers' `DATABASE_URL` host `clawville-db`; `SOURCE_COMMIT`; `/health`; browser check of `https://clawville.world/game`; Hatcher partner requests return 2xx; new rows land in `clawville-db`; prod Supabase gets no new rows in hot tables. | 10 min |
| W6 | Install `/etc/cron.d/clawville-db-backup` on the prod box with the restore-verified backup and the offsite copy to the staging box (rrsync-restricted key); run it once. The laptop task then pulls prod dumps too. | 5 min |
| W7 | `gh workflow enable deploy.yml`. Update `deploy-status.md`, `docs/DEPLOY-HETZNER.md`, `ARCHITECTURE.md`, `AGENTS.md`, the orientation text ("the DB is Supabase Postgres"), `/etc/update-motd.d/00-clawville-env`. | — |

### 3.3 Rollback

- Before the switch: automatic (old containers restart on Supabase).
- After the switch: put `.old_database_url` back into `DATABASE_URL` for apps 2 and 3 through the Eloquent model, redeploy. Writes made after the cutover exist only in `clawville-db`: copy them back first, or accept their loss.
- Keep prod Supabase unchanged for at least 7 days after the cutover as a rollback source. It is not deleted without the founder's instruction.


### 3.4 Fixes before the window — team, reviews, local verification (2026-09-28 02:50 – 05:45 UTC)

Team "supabase-exit" (ClawVille AGENTS.md: DB work runs as a team): orchestrator (this session: decomposition, box checks, commit, push, verification), impl-1 (`scripts/deploy/db/*`, ops-script guards, runbook), impl-2 (PR #303 Codex findings, CI host keys, bounty modal tap targets, the shared marker reader), independent auditor = Codex CLI 0.156.0 (ChatGPT login; files inlined in the prompt because its Windows sandbox cannot start a shell).

**Codex rounds — database scripts:** r1 FAIL (6: writers during copy, counts not contents, no lock, revert order, marker lost in backups, name clash) → r2 FAIL (ON_ERROR_STOP, half stop, late write, `.unverified` growth, empty marker, `.meta` order) → r3 FAIL (no write barrier; counter misses TRUNCATE/sequence/DDL) → r4 FAIL (catalog definitions not hashed; re-check before redeploy end) → r5 FAIL (trigger enable state, RLS/policies; pre-existing container) → r6 FAIL (new container's `DATABASE_URL` unchecked) → r7 FAIL (other running containers on the old URL) → **r8 PASS** (files: backup `7f1db1b858b5374e`, cutover `0908d216b112ff77`, marker `1f374075ab9eb832`, migrate `2826af9241d964c6`, setup `6b7b63f0203d7d4c`, sha256 prefixes).

**Codex rounds — PR #303 + TypeScript guards:** r5 REJECT (probe accepts unmarked DB; CI `accept-new`; impossible cursor date → 500) → r6 REJECT (marker read from the session value; checkbox CSS) → r7 REJECT (owner can set the marker → documented scope; unmarked repair target; check on a different connection; ref matched anywhere in the URL) → r8 REJECT (pooler user on any host; seed/backfill not re-checked in the write transaction; no-hook test) → **r9 APPROVE**. Round 8 confirmed no behavior change on the live path of `avatar-agent-provisioning.ts`.

What the fixed scripts now do (details: `docs/DEPLOY-HETZNER.md` "Self-hosted database"):
- One lock (`/opt/clawville-db/.lock`) for cutover, migrate and backup. Every `psql` has `ON_ERROR_STOP`; answers are parsed strictly.
- The marker is read from the catalog (`pg_catalog.pg_db_role_setting`, schema-qualified) by `db-marker.sh` and `apps/api/scripts/db-env-marker.ts` (same SQL). A session or role value that differs is refused. The marker prevents accidents; it is not a security boundary against the database owner.
- Copy gates: ROWCOUNTS (count + order-independent row hash per table), OBJECTS, SEQUENCES, QUIESCENT (source fingerprint = DML counter, relfilenodes, sequences, catalog definitions incl. defaults, functions, triggers + enable state, RLS + policies; read after a 15 s settle before the dump and after verification).
- Write barrier (window step W2): Supabase network restriction to the prod box; the real run requires `SOURCE_BARRIER=network-restricted`.
- Cutover: `PREFLIGHT_ONLY=1` dry run; the rollback file is never overwritten; apps stop one at a time; the Coolify change is verified per row and reverted (revert proven before any restart); the new marker is read back; after the redeploy it waits until every running container of each app has the new URL and one new container runs the SHA, then re-checks the source (`SOURCE AFTER SWITCH`).
- Backup: dump with `--create`, restore-verified with `pg_restore -C` in a throwaway container, marker must survive, `.meta` sidecar, retention by pairs, `.unverified` capped at 3, rsync offsite to an rrsync-restricted key.
- Ops scripts: marker on the write connection inside the write transaction; exact legacy Supabase identity.
- PR #303: probe accepts only `staging` (unmarked needs `--allow-unmarked-db` + a local URL); CI pins each box's ed25519 host key (plain OpenSSH replaces `appleboy/ssh-action`); strict cursor dates (400, not 500); 44 px touch targets in the bounty modal on touch devices.

Local verification by the implementers: impl-1 harnesses migrate 30/30 (bash 5.3 + 5.2), backup 24/24, cutover 64/64 (real Coolify tinker PHP on php 8.3 with a stand-in model), real PostgreSQL 17.11 suite 52/52 (incl. writes/TRUNCATE/nextval/DDL/definition changes during the copy → QUIESCENT: NO; write after the switch → WARNING; role/session/search_path marker spoofs refused). impl-2: probe 13, grant guard 10, parity 4+, hook 4, provisioning 25, bounties 17; real PostgreSQL spoof matrix; real sshd pin tests. Orchestrator re-run on itachi222: 201 tests across the touched suites pass; `apps/api` tsc exit 0; `apps/web` typecheck exit 0. Cross-version check on real staging data: the row hash of all 6,213 `embeddings` rows (vector columns) is equal between pgvector 0.8.0 (Supabase) and 0.8.6 (`clawville-db`).

Verified on the boxes and in CI (2026-09-28 05:40–06:15 UTC; evidence in `deploy-status.md` CURRENT STATE): workflow `36383016329` ran the pinned-key tunnel and deploy (4 gates, migrate, deploy passed); staging runs `243da4a5`; onboarding smoke 14/14; probe on-box ALL PASS (16) with marker `staging`; mock-Hatcher harness 14/14 (test key removed afterwards); cursor 400s; tap targets ≥ 44 px at 8 touch sizes, desktop unchanged. Scripts on real docker/Coolify: staging migrate guard refuses (exit 1); staging `PREFLIGHT_ONLY` FAIL (4) for the expected reasons; staging real backup restore-verified (163 tables, marker kept); prod `PREFLIGHT_ONLY` PASS; prod trial copy (apps running) 272 s, OBJECTS IDENTICAL, 156/164 tables identical by count + hash, hot tables differ and QUIESCENT: NO as expected. `flock`, `rsync`, `rrsync` exist on both boxes. Still unverified until the window: a real cutover on prod (by design), the Supabase network-restriction call, the offsite rsync key.

### 3.5 The window, executed 2026-09-28 (founder answered "Go now")

| Step | Time (UTC) | Result |
|---|---|---|
| W1 merge PR #303 | ~08:30 | merge `b19d872c` (parents `2a6c4031`, `3c618b00`); workflow `36397666558` all gates, migrate through the pinned-key tunnel (85/85, none pending), deploy; both prod containers on `b19d872c`, healthy; browser check OK |
| W2 barrier + pre-flight | 08:39–08:41 | `deploy.yml` disabled; network restriction applied (before: `0.0.0.0/0`, `::/0`, saved); staging box refused `EADDRNOTALLOWED`; prod API kept working (a few queries failed while Supabase closed the pooled connections); Postgres not restarted; `PREFLIGHT: PASS` |
| W3 cutover | 08:41:07–08:52:17 | stop 08:41:08; dump + restore; ROWCOUNTS IDENTICAL (count + hash) 164/164; OBJECTS IDENTICAL; SEQUENCES IDENTICAL (7); QUIESCENT YES (173); marker `production` read back; Coolify app 2 (1 row), app 3 (2 rows) switched and verified; redeploy finished 08:52:01; SOURCE AFTER SWITCH UNCHANGED; exit 0 |
| W4 CI secret | 08:52:35 | `PROD_DATABASE_URL` = tunnel form; the same URL logs in as `clawville`, marker `production` |
| W5 verify | 08:53–09:00 | containers on `clawville-db`; events +32 / logs +14 in `clawville-db` within a minute while Supabase stays at events 445,707; Supabase has only 1 idle pooler connection; fleet ticks; 0 DB errors; browser check OK |
| W6 backups | 08:54–08:59 | prod cron 04:17 UTC; first run 158 s, restore-verified 164 tables, marker `production`, offsite to staging (SHA-256 equal), laptop pull OK; rrsync key: push works, pull and shell refused |
| W7 | 09:00– | `deploy.yml` re-enabled; motd updated; docs in this commit; orientation text updated on staging (reaches prod with the next promotion) |

Outage: API ≈ 9 min (08:41–08:50), web ≈ 11 min (08:41–08:52). Rollback file: `/opt/clawville-db/.old_database_url` (not used).

---

## Phase 4 — what else stops when the Supabase account stops

Inventory 2026-09-28 ~03:30 UTC (Management API `/organizations`, `/projects`; file searches on itachi222, idex, the laptop, and both boxes).

### 4.1 Projects on this login

| Org (plan) | Project | State | Used by | Backup |
|---|---|---|---|---|
| `znldqhesvhlvhrknhqnt` pumpcaster (Pro, billed) | ClawVille `wheuidgiyyccqyoppxoa` | ACTIVE | **prod app (live), Hatcher** | Phase 1 |
| same | ClawVille-staging `mtpixvtclsjqjguouxes` | ACTIVE | nothing live (frozen 2026-09-25); local dev `.env.local` files | Phase 1 |
| same | RevealAI `ltkwykzsnvtmfttiaccg` | ACTIVE | Vercel project `gudtek` → `https://gudtek.club` (HTTP 200): `SUPABASE_URL` + `SUPABASE_ANON_KEY`, cache tables + Storage bucket `repo-code`. Last code commit 2026-05-27. | Phase 1 (DB + all 46,321 files) |
| same | sol-mafia `fiiwmhyxhyuzszgkqjfz` | ACTIVE | `SOLMAFIA_DATABASE_URL` in `~/.itachi-api-keys` (itachi222) and `~/.itachi-brain-env` (idex) — its password is **already rejected** by Supabase | Phase 1 |
| `isseowarbfelehzfhohv` LotItachi (Free) | LotItachi `ptcdomfwegkfttxypwek`, LotiScan `ersenhkthyqoptpqyzam` | INACTIVE (paused) | unknown | none (paused projects cannot be dumped without a restore) |
| `tynscmsukdfzcgzwznzy` PolyPocket (Free) | vantage `khaxenqgapsgoixuxwqu` | INACTIVE | unknown | none |
| `mvfauruejhqslhefnkck` StrategyNet (Free) | `lqpzhhbzkvtahgcekvhi` | INACTIVE | unknown | none |
| `fazhvvoixhojbldzoyqm` Itachi.Dev (Free) | — | — | — | — |

Not on this login (other account; not affected): `SUPABASE_URL` → `zhbchbslvwrgjbzakeap`, `SOLTARD_SUPABASE_URL` → `jfgolkmphrsylthfjrpv`.

A Pro org cannot pause a project (`POST /v1/projects/{ref}/pause` → 400 "Project is not free-tier", memory `supabase-cost-cull-workflow`, 2026-07-01). Compute is billed hourly for every existing project ($10/project/month). The ways to stop the charges: delete projects (only on the founder's explicit order), or downgrade/transfer to a Free org and pause (Free: 2 active projects, 500 MB DB cap — ClawVille prod at 2.9 GB does not fit). Invoice #14 ($233.45) is OUTSTANDING.

### 4.2 Security findings on the other projects (read-only checks; no change made)

- sol-mafia: RLS off on 12/12 `public` tables; `anon` can read and write all 12 (same exposure prod had until 2026-09-28 01:24 UTC).
- RevealAI: `anon` can read 14/14 tables; 5 of them have no RLS (30 policies exist on the other 9). The app uses the anon key server-side on purpose.
- Old ClawVille staging: `anon` has 0 table privileges (no exposure).

### 4.3 Other things that hold Supabase references

| Where | What | Action (after the prod cutover unless noted) |
|---|---|---|
| GitHub secret `PROD_DATABASE_URL` | prod Supabase session URL | set to the tunnel form in window step W4 |
| `.github/workflows/deploy.yml:34` comment | says Supabase | update in the W7 docs commit |
| itachi222 `ClawVille/.env.local`, `ClawVille/packages/database/.env.local`, `ClawVille/.env.deploy` | `DATABASE_URL` / `STAGING_DATABASE_URL` → old staging Supabase | switch to the staging tunnel (`ssh -N -L 15432:127.0.0.1:5432 root@87.99.142.34`) or mark stale; local dev writes today go to the frozen copy |
| itachi222 `ClawVille/scripts/deploy/railway-env-backup.json`, `ClawVille/.migration-out/envs.json`, `.migration-out/coolify-apps-3-4-export.txt`, `~/.clawville-brain/plans/land-economy/CONTINUATION.md`, `cv-dd-audit/.local-evidence/…/*.mjs` | old env exports / notes holding Supabase URLs with passwords | delete or scrub once Supabase is gone (founder decides) |
| itachi222 `~/.itachi-sync/objects/*` (9 objects) | synced copies of env files with Supabase URLs | same |
| prod box `/root/envs.json` (2026-05-24) | prod Supabase `DATABASE_URL` in clear text | delete after the cutover (founder decides) |
| prod box `/etc/update-motd.d/00-clawville-env` | "Supabase project … (LIVE USER DATA)" | update in W7 |
| `packages/shared/src/constants/orientation-skill.ts:272` | agent-facing text "the DB is Supabase Postgres" | update in W7 (content hash refresh) |
| ClawVille `AGENTS.md` (local, untracked), `ARCHITECTURE.md`, `docs/DEPLOY-HETZNER.md` | "separate Supabase each", "DB: PostgreSQL + Drizzle (Supabase)", `ELIZA_DATABASE_URL` note | update in W7 |
| `SUPABASE_ACCESS_TOKEN` on itachi222 and idex | Management API token | revoke after the account is closed |
| memory files (`clawville-supabase-egress-my-bounties`, `supabase-cost-cull-workflow`) | describe the Supabase setup | update after the cutover |
