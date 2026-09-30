# ClawVille → Hetzner Deploy Playbook

**Last Audited: 2026-09-28 (RevealAI on the staging box).** Drift note: the staging box also hosts the self-hosted RevealAI backend (`/opt/revealai`, own nightly backup); see "Other tenant on the staging box" below.

**Last Audited: 2026-09-28 (prod database cutover).** Drift note: prod moved to the self-hosted `clawville-db` on the prod box on 2026-09-28 (outage 08:41–08:52 UTC; every copy gate IDENTICAL/YES); prod nightly backups are restore-verified and copied offsite to the staging box, then to the laptop drive. Supabase prod is frozen behind a network restriction.

**Last Audited: 2026-09-27 (self-hosted database hardening).** Drift note: `scripts/deploy/db/*.sh` fix the 10 defects in `docs/audits/2026-09-27-supabase-exit-audit.md` §0.4: the rollback file is never overwritten, the copy gate adds `OBJECTS: IDENTICAL`, the Coolify switch is verified per app with automatic revert, `PREFLIGHT_ONLY=1` runs the pre-flight alone, the copy gate also needs a count+hash match per table and `QUIESCENT: YES` (source fingerprint of DML counter, relfilenodes, sequences and catalog unchanged during the copy), the real run requires `SOURCE_BARRIER=network-restricted` (Supabase restricted to the prod box in the window) and re-checks the source after the switch, one `flock` serializes the three scripts, a failed revert keeps the apps stopped, nightly dumps carry and verify the `clawville.env` marker (`--create`, `pg_restore -C`, `.meta` sidecar), nightly dumps are restore-verified in a throwaway container, offsite copies use rsync to an rrsync-restricted key, and no password goes on a command line. The cutover window now disables the deploy workflow. The ops scripts read the `clawville.env` marker instead of trusting a Supabase ref. Runbook: "Self-hosted database" below.

**Last Audited: 2026-09-25 (self-hosted database).** Drift note: the app database moves off Supabase onto each box (`clawville-db`, Postgres 17 + pgvector, loopback + Coolify network only). Staging cut over 2026-09-25 with identical row counts on all 163 tables; prod still runs on Supabase until its cutover window. CI reaches the database through an SSH tunnel. Runbook: "Self-hosted database" below. Reason: Supabase billed 2,034 GB of prod egress ($183) for 2026-08-25 to 2026-09-24.

**Last Audited: 2026-09-22 (coupling gate).** The fourth stable required job is `coupling documentation contracts`, alongside the existing web and two API jobs. Deploy callers evaluate the complete push event.before/event.after range before migration. PRs evaluate their immutable event base/head merge-base. Manual dispatch now requires an explicit full base SHA: `gh workflow run gates.yml --ref staging -f coupling-base-sha=<full-base-sha>`. Select the start of the complete change, not merely its final commit. Zero/missing bases and unavailable history fail closed. The registry and narrow Nori-only escape are documented in `.claude/gates/schema.md`. Activate the four required contexts only after remote check evidence; this local diff does not change GitHub protection.

**Last Audited: 2026-09-22.** Drift note: both deploy workflows invoke the local reusable Gates workflow at the caller commit. The order is `gates -> migrate -> deploy`. Failed or cancelled tests stop live migrations and deployment. The emergency `[skip migration]` subject only skips the migration step; it cannot skip Gates. PR and manual Gates runs remain available. The reusable workflow uses a separate concurrency group per caller workflow, so a PR or manual run cannot cancel a deploy's Gates run.

Gates now includes the previous identity, salvage, agent-label, activity queue, room lifecycle, and runtime regression tests. Runtime files run in separate processes. Route and service tests automatically isolate every file containing `mock.module`. A new mock does not require a workflow filename-list edit. Every PR runs Gates, including documentation-only changes. No PR path filter can leave required status checks permanently pending. The stable job names are `web Trading Floor tests`, `api money/cove/poker invariant tests`, and `api route tests (Postgres-backed)`.

This workflow dependency does not enable GitHub branch protection. The September 22 API audit finds both branches unprotected. The constraint-parity inventory and branch-protection tasks remain separate audit items. Manual SSH/Coolify deployment remains an operator bypass; use the normal workflow and confirm the same commit passed Gates before any manual recovery deploy.

Both deployment helpers require one full 40-character commit SHA. Workflows pass `${{ github.sha }}` to Coolify's `commit` parameter. They first require the `CLAWVILLE_PINNED_DEPLOY_V1` marker in the VPS helper. Copy the reviewed helper to its matching VPS before the first workflow deployment. An old helper fails this check instead of ignoring the SHA. Manual recovery uses `/root/clawville-deploy.sh <tested-full-commit-sha>` on production or `/root/clawville-staging-deploy.sh <tested-full-commit-sha>` on staging. No argument, a branch name, and an abbreviated SHA all fail before Docker starts. The September 22 read-only probe confirms both live Coolify versions accept the named `commit` argument.

**PARITY:** deployment controls apply to the shared human and agent application. No identity, action, or settlement contract changes.

The API invariant job also runs `tsc --noEmit` after dependency builds. Bun bundling alone does not check API TypeScript contracts.


> **Status (2026-05-24): TWO-BOX SETUP.** Production migrated from the original
> Ashburn box (now `<STAGING_VPS_IP>`, Coolify 4.0) to a new Hillsboro box
> (`<PROD_VPS_IP>`, Coolify 4.1) on 2026-05-23. The old box now serves `staging.clawville.world`
> + `api-staging.clawville.world` as a hot rollback target (DNS swap = 30s
> rollback). **Each box has its OWN database since 2026-06-16** (Supabase staging
> `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`; **2026-09-25: staging moved to the
> self-hosted `clawville-db` on its box; prod since 2026-09-28 — see "Self-hosted database"**) — staging writes no longer
> touch prod; schema converges to prod via the CI migration gate
> (`migrate`→`deploy`) on `staging → master`. Authoritative IPs/keys/app-IDs live in `scripts/deploy/.env.deploy`
> (gitignored). See `CLAUDE.md` / `AGENTS.md` "Deployment — Hetzner + Coolify"
> for the live two-env table.
>
> **This playbook below is the one-time Railway→Hetzner migration history,
> kept as reference for the NEXT migration or rebuild.** When provisioning a
> third box (e.g. EU region), the same scripts (`provision-hetzner.sh`,
> `bootstrap-server.sh`, `setup-cloudflare-dns.sh`) apply — but NOTE (2026-06-16)
> those provisioning scripts and `scripts/deploy/.env.deploy` are NOT currently
> committed to the repo (the boxes are already provisioned); restore them from
> git history or re-author from the steps below if you re-provision. The only
> committed deploy scripts are `clawville-deploy.sh` / `clawville-staging-deploy.sh`
> / `apply-rename-migration.sh`. Lessons learned
> 2026-05-23 (CRLF on bootstrap, Coolify 4.0→4.1 schema drift on
> `environment_variables`, Crypt::encryptString-via-raw-SQL breakage, stale
> `custom_labels` requiring `null + re-save`) live in:
> - `~/.claude/projects/.../memory/feedback_coolify_envvar_encryption.md`
> - `~/.claude/projects/.../memory/project_deploy_infrastructure.md`
>
> **Migration scripts used 2026-05-23** are saved to `.migration-out/`
> (gitignored). Reuse them as templates for the next migration: `create-apps.php`,
> `cutover-prod-fix.php` (must use Eloquent model for env writes), `reconfig-staging.php`,
> `init-new-coolify.php` (admin user + instance fqdn + deploy key import in one tinker call).

**Last edit:** 2026-06-16 — D3 drift fix: flagged that the one-time provisioning scripts (`provision-hetzner.sh`, `setup-cloudflare-dns.sh`, `bootstrap-server.sh`, `add-zone-to-cloudflare.sh`) + `.env.deploy[.example]` are NOT committed; the live deploy path is `scripts/deploy/clawville-deploy.sh` (+ staging variant). Steps 0–4 are historical reference, not a runnable path today.

Migrate ClawVille from Railway Pro (~$55/mo) to a single Hetzner CCX13 VPS
running Coolify, with Cloudflare in front. Actual cost: **~$19.99/mo gross**
(Hetzner CCX13 base €12.49/mo + VAT + billed monthly in arrears, not upfront).

## Stack

| Layer | Tool | Why |
|---|---|---|
| VPS | Hetzner **CCX13** (2 dedicated AMD vCPU / 8 GB / 80 GB NVMe) | Dedicated CPU kills Eliza's p99 tail |
| Orchestrator | **Coolify** (self-hosted PaaS) | Railway-style deploys on your own box — auto TLS, logs, env vars, git push deploys |
| Proxy | **Traefik** (bundled with Coolify) | Let's Encrypt certs, zero-config |
| CDN / DNS | **Cloudflare** (already using student plan) | Free edge caching of GLB assets + DDoS protection |
| DB | **Postgres 17 + pgvector on each box** (`clawville-db`; staging since 2026-09-25, prod pending its cutover) | Supabase billed egress per GB; the app DB now sits next to the app (no egress bill, no cross-country round trip) |

**History:** the 2026-05 move kept Postgres on Supabase to save ~1 GB of RAM and avoid migration risk. That changed on 2026-09-25 after a $183 Supabase egress line item — see "Self-hosted database".

## Prerequisites (one-time)

1. **Hetzner Cloud account**  → https://console.hetzner.cloud
   - Project: create one called `clawville`
   - API token: Project → Security → API Tokens → "Generate API token" (Read & Write)

2. **Cloudflare API token**  → https://dash.cloudflare.com/profile/api-tokens
   - Use **"Create Custom Token"** (not a preset template)
   - Permissions:
     - Zone → Zone → **Edit**  (needed to create the zone)
     - Zone → DNS  → **Edit**  (needed to upsert A records)
   - Zone Resources: `Include → All zones from an account → <your account>`
   - One token handles both the initial zone creation AND later DNS upserts.

3. **Namecheap API access** (only for the one-time NS swap, skip if the domain is already on Cloudflare)
   - https://ap.www.namecheap.com/settings/tools/apiaccess/
   - Toggle "API Access" ON (needs min balance or 20+ domains on the account)
   - Copy your API Key
   - Add your current public IP to the "Whitelisted IPs" box — find it with:
     ```bash
     curl -s https://api.ipify.org
     ```

4. **Tools on your local machine**
   ```bash
   # hcloud CLI
   scoop install hcloud            # Windows
   brew install hcloud             # macOS
   # or download from https://github.com/hetznercloud/cli/releases

   # jq + curl (probably already installed)
   scoop install jq
   ```

5. **SSH keypair** (if you don't already have one)
   ```bash
   ssh-keygen -t ed25519 -C "clawville-deploy"
   # Accept the default path ~/.ssh/id_ed25519
   ```

> **Historical provisioning reference:** Steps 0–4 describe the original server setup. The provisioning scripts and private `.env.deploy` are not committed. Both VPS hosts already exist. Use the staging-first Actions workflow for normal releases. For manual recovery, use the target VPS helper with the tested full commit SHA, as specified under "Deploy paths". Do not run the historical setup steps on either existing VPS.

## Step 0 — Add clawville.world to Cloudflare (automated)

**Skip this step if the zone is already on Cloudflare.** Otherwise:

```bash
bash scripts/deploy/add-zone-to-cloudflare.sh
```

This single script does:
1. Creates the zone on your Cloudflare account via API (auto-imports existing DNS)
2. Prints every auto-imported record and pauses for your review
3. On confirm: calls the Namecheap API to swap nameservers to Cloudflare
4. Polls Cloudflare until the zone flips to "active" (usually 5–30 min)

The pause in step 2 is deliberate — if Cloudflare's auto-import missed any DNS records, abort (n), add them manually in the CF dashboard, then re-run the script. The NS swap is the only irreversible action, and it only happens after you confirm.

## Step 1 — Fill in deploy credentials

```bash
cp scripts/deploy/.env.deploy.example scripts/deploy/.env.deploy
# Edit scripts/deploy/.env.deploy and paste in:
#   - HCLOUD_TOKEN
#   - CF_API_TOKEN
# Everything else has sensible defaults.
```

Make sure `.env.deploy` is gitignored (see the "Safety" section at the bottom).

## Step 2 — Provision the server

```bash
bash scripts/deploy/provision-hetzner.sh
```

This creates:
- A firewall `clawville-fw` allowing 22, 80, 443, 8000
- Your SSH key in Hetzner
- A `clawville-prod` CCX13 server in Ashburn

> **⚠️ NAME THE SERVER FOR THE ENV YOU ARE ACTUALLY BUILDING (added 2026-09-17 after a real incident).**
> This walkthrough hardcodes the name `clawville-prod`, and **Ashburn is where STAGING lives** (prod is
> Hillsboro). The staging box was provisioned this way on 2026-04-10 and therefore carried the hostname
> `clawville-prod` for 160 days: Hetzner's metadata service serves the console name, and cloud-init shipped
> with `preserve_hostname: false`, so every boot re-stamped it. Anyone who SSH'd in and trusted `hostname`
> would have believed they were on production.
>
> It was cosmetic — the two boxes always had separate Supabase projects and correct `CLAWVILLE_ENV` values —
> but it was a catastrophic-class trap sitting on a box with custodial wallets one IP away. When provisioning,
> pass the real name (`clawville-staging` for Ashburn), and on first boot set `preserve_hostname: true` in
> `/etc/cloud/cloud.cfg` before `hostnamectl set-hostname <name>`, or cloud-init reverts it.
>
> **`hostname` is NEVER the environment discriminator.** Use, in order: `CLAWVILLE_ENV` inside the container ·
> the Supabase project ref in `DATABASE_URL` (staging `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`) ·
> the container prefixes (staging web `ju0n…` api `yvtwz…`). Both boxes now print a `/etc/update-motd.d/00-clawville-env`
> banner on login stating which env they are.

The script prints the server's IPv4 when it's done. Write it down — you'll use it in the next two steps. (You can also fetch it later with `hcloud server ip clawville-prod`.)

## Step 3 — Create Cloudflare DNS records

```bash
bash scripts/deploy/setup-cloudflare-dns.sh
```

This adds three **additive, DNS-only** records:
- `new.clawville.world`          → Hetzner IP  (staging web)
- `api-new.clawville.world`      → Hetzner IP  (staging api)
- `<CF_COOLIFY_SUBDOMAIN>.<CF_ZONE_NAME>` → Hetzner IP  (admin UI — values in `scripts/deploy/.env.deploy`)

It **does not touch** the existing `clawville.world` / `api.clawville.world` records that point at Railway. That's deliberate — you'll swap those over in Step 7 after you've confirmed the new stack works.

> DNS records are created in "DNS-only" mode (grey cloud) so Let's Encrypt's HTTP-01 challenge works. After certs are issued you can flip them to "Proxied" (orange cloud) in the Cloudflare UI to get edge caching.

## Step 4 — Bootstrap the server + install Coolify

```bash
# Replace <IPV4> with the IP from Step 2
ssh root@<IPV4> 'bash -s' < scripts/deploy/bootstrap-server.sh
```

This takes ~5 minutes. It:
- Updates the OS, enables unattended security upgrades
- Creates a `clawops` sudo user
- Hardens SSH (key-only, no root password auth)
- Installs UFW + fail2ban
- Installs Coolify (pulls Docker + Traefik)

When it finishes, Coolify is running at `http://<IPV4>:8000`.

## Step 5 — First-run Coolify setup

1. Open `http://<IPV4>:8000` in your browser
2. Create the first admin user (email + password — this is local to the box)
3. You'll land on the dashboard

### Set the Coolify instance domain
- Settings → Instance Domain: `https://<CF_COOLIFY_SUBDOMAIN>.<CF_ZONE_NAME>` (resolve from `scripts/deploy/.env.deploy`)
- Save. Coolify will request a Let's Encrypt cert via Traefik. Wait ~30 seconds, then browse to that URL to confirm.
- Once confirmed, **close port 8000** from the internet:
  ```bash
  ssh clawops@<IPV4> 'sudo ufw delete allow 8000/tcp && sudo ufw reload'
  ```

## Step 6 — Deploy `api` and `web` as Coolify applications

Coolify will pull from your GitHub repo and build each service from its existing Dockerfile. Do this twice — once per service.

### 6a. Connect GitHub (one-time)
- Coolify → Sources → Add new → GitHub App (follow the OAuth flow)
- Grant it access to the `ClawVille` repo

### 6b. Create a Project + Environment
- Projects → New → Name: `clawville` → Environment: `production`

### 6c. Add the `api` application
- New Resource → Public/Private Repository → pick `ClawVille`
- Build pack: **Dockerfile**
- Base directory: `/`
- Dockerfile location: `apps/api/Dockerfile`
- Ports exposed: `4000`
- Domains: `https://api-new.clawville.world`
- Environment variables (click "Developer view" for bulk paste):
  ```
  ANTHROPIC_API_KEY=<copy from Railway>
  OPENAI_API_KEY=<copy from Railway>
  DATABASE_URL=<copy from Railway — the Supabase pooler URL>
  CORS_ORIGIN=https://new.clawville.world
  PORT=4000
  ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true
  ```
- Click **Deploy**. First build takes ~5–8 min (subsequent builds ~2 min).

### 6d. Add the `web` application
- Same project → New Resource → same repo
- Dockerfile location: `apps/web/Dockerfile`
- Ports exposed: `3000`
- Domains: `https://new.clawville.world`
- Build-time args (Coolify calls these "Build Variables"):
  ```
  NEXT_PUBLIC_API_URL=https://api-new.clawville.world
  ```
- Runtime environment variables: none required (the Next build already baked in the API URL)
- Click **Deploy**.

### 6e. Smoke test
- Open https://new.clawville.world — you should see the game
- Open the browser devtools → Network tab, confirm requests go to `https://api-new.clawville.world`
- Chat with an avatar → confirm Eliza responses come back
- Walk into a building → confirm NPCs appear and chat works
- Check Coolify → Logs for either service if anything errors

## Step 7 — Cutover (production DNS swap)

Once you're confident the new stack works:

1. In Cloudflare dashboard → DNS → Records:
   - Edit `clawville.world` A record → change content to the Hetzner IP (leave orange-cloud if you want caching)
   - Edit `api.clawville.world` A record → change content to the Hetzner IP
2. In Coolify → `web` application → Domains: add `https://clawville.world`
3. In Coolify → `api` application → Domains: add `https://api.clawville.world`
4. Update the `web` app's `NEXT_PUBLIC_API_URL` build var to `https://api.clawville.world` and redeploy
5. Update the `api` app's `CORS_ORIGIN` to `https://clawville.world,https://new.clawville.world` and redeploy

Traefik will provision fresh Let's Encrypt certs for the production hostnames automatically (~30s).

## Step 8 — Decommission Railway

After 24 hours of the new stack running cleanly:

1. Railway dashboard → `clawville` project → `web` service → Settings → Danger Zone → Delete service
2. Same for `api` service
3. Don't delete the Railway project itself if you want to keep the env var history as a backup

Expected savings: **~$41/mo** vs your current Pro bill.

## Ongoing operations

### Deploying a new version — day-to-day runbook (moved verbatim from CLAUDE.md 2026-09-07)

**Two Hetzner VPS hosts (since 2026-05-23 migration):**
- **Production:** `$PROD_VPS_IP` (in gitignored `scripts/deploy/.env.deploy`), Hillsboro, Coolify 4.1, key `~/.ssh/clawville_hillsboro` (passphrase — `ssh-add` once into Windows ssh-agent). Serves `clawville.world` + `api.clawville.world`. Admin UI `https://coolify-new.clawville.world`.
- **Staging:** `$STAGING_VPS_IP`, Ashburn, Coolify 4.0, key `~/.ssh/clawville_deploy`. Serves `staging.clawville.world` + `api-staging.clawville.world`. Admin UI `https://coolify-staging.clawville.world`.

Both Traefik + Let's Encrypt, Cloudflare-proxied DNS, **separate Postgres per box (isolated 2026-06-16; self-hosted `clawville-db` on each box: staging since 2026-09-25, prod since 2026-09-28 — see "Self-hosted database")** — staging writes no longer touch prod; schema converges to prod via the CI migration gate (`migrate`→`deploy`) on the `staging → master` promotion (see `deploy-status.md`). Both pull from `github.com/ItachiDevv/ClawVille` via the same shared deploy key, auto-deploy on push. Web ~3–5 min, api ~2–3 min.

**Coolify app IDs:** prod api=2, prod web=3, staging api=3, staging web=4. UUIDs in `.env.deploy` as `API_APP_UUID`, `WEB_APP_UUID`, `STAGING_API_APP_UUID`, `STAGING_WEB_APP_UUID`.

### Deploy paths

- **Normal:** push to `staging`, verify staging, then merge the staging promotion PR into `master`. Actions runs the test gate, migration gate, and deployment in that order.
- **Force-redeploy / missed workflow:** SSH into the target VPS. Run `/root/clawville-deploy.sh <tested-full-commit-sha>` on production or `/root/clawville-staging-deploy.sh <tested-full-commit-sha>` on staging.
- **Env-var add/update:** SSH in → tinker. **Encryption gotcha (2026-05-23):** NEVER write `environment_variables.value` via raw `DB::update()` + `\Crypt::encryptString()` — Coolify's model mutator re-encrypts on save; raw writes break `decrypt()` and crash builds with `unserialize()` exception. ALWAYS `$row->value = $plain; $row->save();`.
- **Skip-ahead-to-latest:** Coolify queue is FIFO — when you push B while A still building for the same app, kill A's PID and mark its `ApplicationDeploymentQueue` row `cancelled-by-user`. Never cancel the latest. Recipe in `docs/DEPLOY-HETZNER.md`. This Coolify beta has NO auto-cancel-superseded-builds feature — don't assume it; superseded builds run to completion (wasted server cost) unless killed manually.
- **Double-queued builds — ROOT-CAUSED + FIXED 2026-08-20 (supersedes the 2026-06-10 "internal Coolify poller" theory, which was WRONG).** The second trigger was never internal to Coolify: it was OUR OWN GitHub Actions deploy workflow. Staging had TWO deploy triggers — (1) a GitHub→Coolify webhook (`coolify.clawville.world`, a relic of the pre-migration single-box era; fired instantly, WEB app only, `is_webhook=t`, and BYPASSED the CI migration gate) and (2) `deploy-staging.yml` (runs `migrate`, then SSHes in ~90–120s later and tinker-queues BOTH apps, `is_api=t`). Every non-docs push therefore ran the webhook web build concurrently with the Actions api+web pair, which repeatedly starved the box mid-`next build` (three 2026-08-20 failures: 3657, 3661, 3665-adjacent). FIX: the GitHub webhook (id 621104046) was DELETED — `gh api repos/ItachiDevv/ClawVille/hooks` now returns ZERO hooks; Actions is the SINGLE deploy trigger for both envs (prod never had a webhook post-migration). CONSEQUENCES: docs-only pushes (`paths-ignore`) now deploy NOTHING, which is the declared intent; if Actions is ever broken (secrets/runner), staging deploys fall back to the manual tinker script. If duplicate same-commit rows ever reappear, re-check `gh api .../hooks` FIRST — do not resurrect the poller theory.
- **"Finished" ≠ live (RULE):** verify deploys by reading the CONTAINER, not the queue: `docker exec <app-container> env | grep SOURCE_COMMIT` must equal the pushed sha (+ bundle grep for a new string literal when in doubt). Queue rows can read `finished` while the container flip silently failed (no container, site 503) — recover by re-triggering via tinker (`Application::find(<id>)` + `queue_application_deployment`). Watchers must tolerate the flip gap (old container gone, new not yet up) — probe after a settle delay, not the instant the queue drains.
- **DB migrations:** commit an additive migration under `packages/database/migrations/` with each schema change. The Actions migration gate applies it before deployment. Coolify does not run migrations. Do not run local `db:push` against production as a release substitute. Destructive changes require explicit approval and a compatibility plan.
- **Seeded `building_skills` content (RULE, 2026-09-19):** a change to `scripts/fixtures/building-skills.json` does NOT reach the served `GET /api/skills/:buildingId/skill.md`, because that endpoint reads the `building_skills` DB ROW, not the fixture. After the api flip, run `bun scripts/seed-building-skills-fixture.ts --update-content` once per box with `DATABASE_URL` pointing at that box's Supabase session-mode (`:5432`) URL — without `--update-content` the script only inserts missing rows and leaves existing content untouched. It is idempotent: it updates only rows whose `content_hash` differs from the fixture, and `bun scripts/validate-building-curricula.ts` must pass first. Skipping it ships agents the OLD curriculum silently, with no error anywhere.
- **`@clawville/database` local rebuild:** `cd packages/database && bun run build` for scripts importing the package (Coolify builds from source on deploy).

### Provisioning + emergency

The committed deployment helpers are `scripts/deploy/clawville-deploy.sh` and `scripts/deploy/clawville-staging-deploy.sh`. Install each reviewed helper on its corresponding VPS. Manual recovery requires the tested full commit SHA. The private `.env.deploy` and historical provisioning scripts are not committed. See "Deploy paths" for the release procedure.

Emergency SSH: PROD `ssh root@$PROD_VPS_IP` (key in ssh-agent), STAGING `ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP`. Container restart `docker restart <name>` · logs `docker logs --tail 200 <name>` · Coolify DB `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"` (NOT the ClawVille app DB — that's Supabase) · full playbook `docs/DEPLOY-HETZNER.md`.

**Rollback (prod → staging):** staging box still has the prod containers/DB. Flip Cloudflare A records back to `$STAGING_VPS_IP` (~30s), then add prod FQDNs to staging Coolify apps (`Application::find(3|4)->fqdn = '…,https://clawville.world'` + redeploy).

### Local + Windows gotchas (moved verbatim from CLAUDE.md 2026-09-07)

**Test locally FIRST:** `bun run build && bun run start` (prod bundle on :3000, Iris-Xe-safe) is the default test path for in-progress work — iterate on `localhost`, NOT staging (staging pushes clog the Coolify build cache; reserve them for sign-off-ready features). NEVER run `bun run dev` — Iris Xe crashes the WebGPU scene → PC restart (HMR only; the prod `start` bundle is fine).
Curl on Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

### Reading logs
- Coolify → application → Logs tab (live tail)
- Or from the box: `docker logs <container_id> -f`

### Scaling up
If you outgrow CCX13:
```bash
hcloud server shutdown clawville-prod
hcloud server change-type clawville-prod ccx23 --upgrade-disk=false
hcloud server poweron clawville-prod
```
Takes ~2 minutes, no data loss. CCX23 = 4 dedicated cores, 16 GB, ~$28/mo.

### Self-hosted database (2026-09-25)

**Status:** staging = self-hosted (cut over 2026-09-25 23:17 UTC). Prod = self-hosted (cut over 2026-09-28: apps stopped 08:41:08, copy verified 08:46:53, `DATABASE_URL` switched 08:46:54, both apps healthy on `b19d872c` at 08:52:01, `SOURCE AFTER SWITCH: UNCHANGED`). The prod Supabase project `wheuidgiyyccqyoppxoa` stays frozen behind a network restriction to the prod box (`5.78.129.176/32`, `2a01:4ff:1f0:3d61::1/128`); it is the rollback source and is not deleted without the founder's order. Prod nightly backup: `/etc/cron.d/clawville-db-backup` 04:17 UTC with `OFFSITE=root@87.99.142.34:.` and `OFFSITE_KEY=/opt/clawville-db/offsite_ed25519` (staging `authorized_keys`: `command="/usr/bin/rrsync -wo /opt/clawville-db/offsite/prod",restrict,from="5.78.129.176,2a01:4ff:1f0:3d61::1"`); the laptop task "ClawVille DB backup pull" copies both environments' dumps to `D:\clawville-db-backups\`.

**Layout (same on both boxes):**
- `/opt/clawville-db/` (mode 700): `docker-compose.yml`, `.env` (mode 600: `POSTGRES_PASSWORD` superuser, `APP_PASSWORD` for role `clawville`), `bin/` (all `scripts/deploy/db/*.sh`, including the sourced `db-marker.sh`; the scripts load it from their own directory), `backups/`.
- Container `clawville-db`, image `pgvector/pgvector:pg17`, named volume `clawville-db_pgdata`. Published ONLY on `127.0.0.1:5432`; on the `coolify` Docker network as `clawville-db`. Never public.
- Database `clawville` (owner `clawville`), UTF8, ICU `en-US` (matches Supabase, so text sort + text indexes behave the same). Extensions: `vector`, `fuzzystrmatch` in `public`; `pgcrypto`, `uuid-ossp`, `pg_stat_statements` in `extensions`; `search_path = "$user", public, extensions`.
- Environment marker: `ALTER DATABASE clawville SET clawville.env = 'staging' | 'production'`. The `scripts/deploy/db` scripts read it through `db-marker.sh` (sourced; same SQL and rule as `apps/api/scripts/db-env-marker.ts`, keep them in sync): the database-level value from the catalog (`pg_catalog.pg_db_role_setting`, `setrole = 0`, every catalog name schema-qualified so a `search_path` cannot shadow it), plus the session value. No marker = unmarked (`''` counts as none); more than one marker, or a session value that differs from the database value (a role setting or connection option), is refused. `db-migrate.sh` refuses to drop a marked (live) database, and it stops when it cannot read the marker. `hosted-skill-runtime-probe.ts` accepts only `staging`; an unmarked database needs `--allow-unmarked-db` and a local URL (loopback, `postgres`, `*.local`); inside an api container it accepts `clawville-db` only with the `staging` marker. The tunnel URL names no project, so the ops scripts read this marker before they write, and again as the first statement of each write transaction: `repair-provisioning-pending.ts` runs on `staging`, needs `--allow-prod` for `production` and `--allow-unmarked-db` for an unmarked database; `grant-test-tokens.ts`, `seed-test-accounts.ts` and the parity harness (`scripts/parity/staging-db.ts`) accept only `staging`, or the legacy staging Supabase identity when no marker is set; `backfill-avatar-agents.ts --env staging|production` must equal the marker, and its legacy `--ref` form needs an unmarked database. The legacy Supabase identity means the exact pooler user `postgres.<ref>` on a `*.pooler.supabase.com` host, or the host `db.<ref>.supabase.co`. The marker prevents ACCIDENTAL targeting (wrong URL or tunnel port, stale env file, session or role override); it is not a security boundary against a role that owns the database, because such a role can run `ALTER DATABASE … SET clawville.env` itself.
- App env (Coolify, api + web): `DATABASE_URL=postgresql://clawville:<APP_PASSWORD>@clawville-db:5432/clawville`. `ELIZA_DATABASE_URL` stays unset: the Eliza adapter only rewrites Supabase pooler URLs, so it uses this URL as is.

**CI migrations:** `deploy-staging.yml` / `deploy.yml` open an SSH tunnel (runner `127.0.0.1:15432` → box `127.0.0.1:5432`) with the existing deploy key, then run `migrate-ci.ts`. Secret format: `STAGING_DATABASE_URL` / `PROD_DATABASE_URL` = `postgresql://clawville:<APP_PASSWORD>@127.0.0.1:15432/clawville`. Set it from the box without printing it:
`ssh <box> "grep '^APP_PASSWORD=' /opt/clawville-db/.env | cut -d= -f2-" | tr -d '\r\n' | sed 's#.*#postgresql://clawville:&@127.0.0.1:15432/clawville#' | gh secret set <NAME> -R ItachiDevv/ClawVille`

**CI SSH host keys (2026-09-28):** both workflows pin the box's ed25519 host key (`PROD_SSH_HOST_KEY` / `STAGING_SSH_HOST_KEY` in the workflow `env`). The tunnel step and the deploy trigger write it to `~/.ssh/known_hosts` under `umask 077` and run OpenSSH with `StrictHostKeyChecking=yes`, `HostKeyAlgorithms=ssh-ed25519` and `BatchMode=yes`. The deploy trigger is plain `ssh … bash -s -- <sha>`, not `appleboy/ssh-action` (its Go client negotiates ECDSA before ed25519, so an ed25519 pin fails, and it downloads an unchecked binary). After a host-key rotation: run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the box over a trusted session, compare it with `ssh-keyscan -t ed25519 <ip> | ssh-keygen -lf -`, then replace the key line and the fingerprint comment in the workflow. Otherwise every deploy stops with `Host key verification failed.`

**Operator access (scripts, psql):** `ssh -N -L 15432:127.0.0.1:5432 <box>`, then use `127.0.0.1:15432`. On the box: `docker exec -it clawville-db psql -U postgres -d clawville`.

**Backups:** `/etc/cron.d/clawville-db-backup` runs `bin/db-backup.sh` daily at 04:17 UTC. Log: `backups/backup.log`.
- Lock: `db-backup.sh`, `db-migrate.sh` and `db-cutover.sh` share one `flock` on `/opt/clawville-db/.lock`. The backup waits up to 30 min (`LOCK_WAIT` seconds, default 1800), then logs `backup SKIPPED: lock busy` and exits 1.
- The live database must carry a nonempty `clawville.env` marker; otherwise the run stops with `FATAL` before any dump (a backup without the marker would restore as an unprotected database). On the prod box this is true only after its cutover.
- `pg_dump -Fc --create` writes `backups/<name>.part` (name `clawville-<UTC ts>-<pid>.dump`, unique per run; mode 600; all four scripts run with `umask 077`, `db-setup.sh` sets `backups/` to mode 700). The archive carries `CREATE DATABASE` and the database-level settings, including the `clawville.env` marker.
- Restore check: the dump is restored into a throwaway container `clawville-db-verify-<pid>` (no network, random superuser password, `backups/` mounted read-only) exactly like a real restore: role `clawville`, then `pg_restore -C --exit-on-error` (recreates the database with its encoding, ICU locale and settings). It requires more than 0 tables in `public`/`migrations`/`drizzle`, and the restored `clawville.env` must equal the live one. An exit trap removes the container with its volume (`docker rm -f -v`). The old `pg_restore -l` check read only the table of contents: a locally truncated pipe-format dump passed it and failed a real restore.
- Only a restored dump is published: first its sidecar `<name>.meta` (written as `.meta.part`, mode 600: `dump`, `marker`, `server_version`, `tables`, `bytes`), then the dump itself, so a published dump always has its `.meta`. A complete dump that fails the check stays as `<name>.unverified` (never offsite); only the newest 3 `.unverified` files are kept, and each removal is logged. A partial dump is deleted. On failure the log gets `backup FAILED: <name> (exit N)`, and retention does not run.
- Retention: pairs of `clawville-*.dump` + `.meta` older than `KEEP_DAYS` (default 7), only after the new dump restored; each removal is logged. A dump without `.meta` (made before 2026-09-28) is never removed automatically; delete those by hand once newer verified dumps exist.
- Success line: `<UTC ts> backup ok: <name> <bytes> bytes restore-verified tables=N[ (offsite copied)]`.
- Offsite (optional): `OFFSITE=<user>@<host>:<dir> OFFSITE_KEY=<key path>` copies each verified dump and its `.meta` with `rsync -e "ssh -i $OFFSITE_KEY -o BatchMode=yes"`. Restrict the key on the receiver with rrsync, e.g. `command="rrsync -wo /srv/backups",restrict ssh-ed25519 AAAA…` in its `authorized_keys`; `<dir>` is then relative to `/srv/backups`. Put the receiver's host key in `/root/.ssh/known_hosts` first (`BatchMode` refuses an unknown host). `OFFSITE` without `OFFSITE_KEY` stops before the dump.

Restore (the marker must be in place before any app points at the database):
1. Stop the apps, or keep their `DATABASE_URL` away from `clawville-db`. Take the lock: `exec 9>>/opt/clawville-db/.lock; flock -n 9`.
2. Rename or drop the damaged `clawville` database (`-C` creates it and fails if it exists). Role `clawville` must exist (it does on a set-up box).
3. `docker exec -i clawville-db pg_restore -U postgres -C -d postgres --exit-on-error < /opt/clawville-db/backups/<name>`. `-C` recreates the database with its settings, so `clawville.env` comes back with the data.
4. Compare the database-level marker, `docker exec clawville-db psql -U postgres -d clawville -v ON_ERROR_STOP=1 -tAc "select u.v from pg_catalog.pg_db_role_setting s cross join lateral pg_catalog.unnest(s.setconfig) as u(v) where s.setdatabase = (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()) and s.setrole = 0 and pg_catalog.starts_with(u.v, 'clawville.env=')"`, with `marker=` in `<name>.meta`. If it differs or is empty on a live box, `ALTER DATABASE clawville SET clawville.env TO '<env>'` now.
5. Only then point the apps at `clawville-db` and start them.

**Cutover procedure (what staging ran; prod uses the same scripts):**
1. `SHARED_BUFFERS=… CACHE=… MAXCONN=… bin/db-setup.sh` (staging: 256MB / 1GB / 100).
2. Trial copy while the apps run: `APP=<api container> bin/db-migrate.sh` (staging: dump 47 s, restore 25 s, 167 MB). With the apps running, `ROWCOUNTS` and `QUIESCENT` report differences as information only.
3. Open the window: stop CI deploys, so no deploy starts containers on Supabase mid-window: `gh workflow disable deploy.yml -R ItachiDevv/ClawVille` (staging: `deploy-staging.yml`).
4. Write barrier: restrict the prod Supabase database to the prod box, so no other client can write to the source during or after the copy. `POST https://api.supabase.com/v1/projects/<ref>/network-restrictions/apply` (Management API, bearer token from the environment, never printed) with `{"dbAllowedCidrs": ["5.78.129.176/32"], "dbAllowedCidrsV6": ["2a01:4ff:1f0:3d61::1/128"]}`. Verify from another host (e.g. the staging box) that a connection to the pooler is refused. Keep it applied after the cutover: an abort still works, because the old containers run on the prod box.
5. `ENV_NAME=… APP_IDS="<api id> <web id>" API_C=… WEB_C=… DEPLOY_SCRIPT=/root/clawville-…-deploy.sh SHA=<running sha> SOURCE_BARRIER=network-restricted bin/db-cutover.sh`. `SOURCE_BARRIER=network-restricted` attests step 4; the real run refuses without it. In order:
   - Pre-flight before any change, one `PASS`/`FAIL` line per check, then `PREFLIGHT: PASS` or `PREFLIGHT: FAIL (n)` (exit 1, nothing changed). Inputs first (no box access until they pass): `ENV_NAME` is exactly `staging` or `production`; `SHA` is 40 hex; `APP_IDS` is space-separated ids; `DEPLOY_SCRIPT` is an executable file; `SOURCE_BARRIER` is exactly `network-restricted` (an `INFO` line under `PREFLIGHT_ONLY`, so the dry run works before the barrier exists). Then, read-only on the box: no other db script holds `/opt/clawville-db/.lock` (the cutover keeps the lock through the redeploy; `db-migrate.sh` reuses it); `API_C` and `WEB_C` are running; `.old_database_url` does not exist yet; the api container's live `DATABASE_URL` is the Supabase txn pooler (read into a mode-600 temp file, never printed, deleted afterwards); the web container runs on the same URL; `clawville-db` is healthy; its `clawville` database is not live (same fail-closed marker read as `db-migrate.sh`; `I_KNOW_THIS_DROPS_LIVE_DATA=<marker>` accepts it); tinker: every app id has at least one Coolify `DATABASE_URL` row, and every such row equals the live URL.
   - Dry check: `PREFLIGHT_ONLY=1` with the same variables runs only the pre-flight and exits (0 on pass). Run it before the window. Any non-empty `PREFLIGHT_ONLY` value means pre-flight only.
   - Saves the old URL to `.old_database_url` (mode 600). The script never overwrites this file.
   - Stops the app containers one at a time (write freeze); if a stop fails, it restarts the ones already stopped and exits 1 before any copy. Then it copies with `REQUIRE_QUIESCENT=1` (every `psql` call runs with `ON_ERROR_STOP=1`; the marker and `pg_database` answers must have exactly the expected shape, anything else counts as live). It aborts + restarts the old containers unless the log has all four gates:
     - `ROWCOUNTS: IDENTICAL (count+hash)`: per table, `count(*)` and an order-independent streaming row hash (`sum` of 60-bit `md5` prefixes of the row text, O(1) memory, never `string_agg`), both sides with `timezone=UTC`, `extra_float_digits=1` and the same date/interval/bytea output settings.
     - `OBJECTS: IDENTICAL` (tables, indexes, constraints, functions, triggers, sequences, enums).
     - `SEQUENCES: IDENTICAL`.
     - `QUIESCENT: YES`: the source fingerprint of the copied schemas is identical before the dump (W1) and after verification (W2), each read after a 15 s settle, so idle stopped backends and late writes flush their statistics first. Components (schema-qualified catalog reads; `string_agg` only over catalog rows): the `n_tup_ins+n_tup_upd+n_tup_del` sum; each table's `relfilenode` (TRUNCATE and rewrites change it); each sequence's `last_value` (null = never called); an md5 over the DEFINITIONS in the three schemas: relations (oid, name, kind, relfilenode, row security enabled/forced), columns (name, type/typmod, not null, identity/generated, default), index/constraint/trigger/function definitions (`pg_get_*def`, non-extension functions; triggers with their enabled state), row-security policies (name, command, permissive, sorted role names, `USING` and `WITH CHECK` expressions), enum labels and view definitions. ACLs are not copied (`--no-privileges`), so they are not hashed. Any change gives `QUIESCENT: NO (<components>)`, e.g. `dml +3`, `relfilenode public.t`, `sequence public.s`, `catalog`.
     The copy refuses 0 tables and stops on any failed query.
   - Sets the marker, then rewrites every `DATABASE_URL` row of the listed apps through the Eloquent model and reads each back. Every app must report all rows changed and equal to the new URL. Otherwise the script writes the old URL back to the changed rows and verifies every row (all equal the old URL, none the new one) BEFORE it restarts the old containers, then exits 1 before any redeploy. If that verification fails, the containers stay stopped (downtime beats a split brain), and the script prints the exact manual recovery steps.
   - Redeploys `SHA`.
   - Waits for the redeploy (up to `DEPLOY_WAIT` seconds, default 900): each app needs a container created after the deploy started (same Coolify name prefix; its ID is not among the IDs recorded before the deploy script ran, so an older same-prefix container never counts) whose `SOURCE_COMMIT` equals `SHA` and that is healthy (or running without a healthcheck); in addition EVERY running container of that name prefix must have `DATABASE_URL` equal to the new `clawville-db` URL (a leftover container on the old URL would still write to Supabase); values are compared, never printed. On timeout it prints a `WARNING` (plus `WARNING: a container still uses the old DATABASE_URL` when that was the reason), still runs the check below, and exits non-zero.
   - After the switch, reads the source fingerprint once more (W3, after a 15 s settle) and compares it with W2: `SOURCE AFTER SWITCH: UNCHANGED`, or `SOURCE AFTER SWITCH: CHANGED (<components>)` plus a loud `WARNING` and exit 1. Nothing is rolled back in that case: the apps stay on `clawville-db`; do NOT retire Supabase, and carry the listed writes over by hand.
   Passwords stay off process command lines: URLs reach containers and tinker by variable name only (`-e NAME`), `psql`/`pg_dump`/`pg_restore` get a password-less URI plus `PGPASSWORD`, and `db-setup.sh` passes `APP_PASSWORD` through `\getenv`. Tinker output is echoed with URLs and Laravel ciphertexts masked.
6. Set the CI secret (above). Verify: `/health`, both containers' `DATABASE_URL` host = `clawville-db`, new rows land in `clawville-db`, onboarding smoke passes.
7. Close the window: `gh workflow enable deploy.yml -R ItachiDevv/ClawVille` (staging: `deploy-staging.yml`). Keep the step-4 network restriction in place.

**Retry after an abort:** `.old_database_url` blocks every new run. Confirm that the Coolify rows and the running containers are back on Supabase, then move the file away deliberately. After an abort in the Coolify step, the marker is already set, so the next `db-migrate.sh` also needs `I_KNOW_THIS_DROPS_LIVE_DATA=<env>`. No app used `clawville-db` in that case.

**Rollback:** put the saved `.old_database_url` value back into `DATABASE_URL` for both apps (Eloquent model, as in `db-cutover.sh`) and redeploy. Writes made after the cutover exist only in `clawville-db`, so copy them back before a rollback, or accept their loss. The Supabase projects stay in place until the founder retires them.

### Hosted agent runtimes (D1 sandbox, 2026-09-30)

The host-it-for-me runtimes `hermes-local` (image `hermes-agent`, gateway :8642) and `openclaw-local` (image `openclaw:local`, gateway :8643) serve ambient cognition for gateway-less hermes/openclaw agents when `HERMES_LOCAL_GATEWAY_ENABLED` / `OPENCLAW_LOCAL_GATEWAY_ENABLED` are `true`. Their tools are real (terminal, files, web), so they run sandboxed:

- `scripts/deploy/agent-sandbox/cv-agent-sandbox.sh` (installed as `/usr/local/bin/cv-agent-sandbox.sh`) creates the networks `cv-sbx-hermes` (10.201.86.0/29) and `cv-sbx-openclaw` (10.201.87.0/29), starts each runtime at `.2` as UID 10000 (hermes, direct entrypoint `hermes gateway run --no-supervise`, no s6) or UID 1000 (openclaw) with `--cap-drop ALL --security-opt no-new-privileges --restart no --pids-limit 512 --memory 2g`, and writes the firewall: raw `CV-SBX-RAW` (first rule of raw PREROUTING; lets the coolify bridge reach the gateway port past Docker's direct-routing DROP), mangle `CV-SBX-EGRESS` (jumped from mangle PREROUTING for `-i cv-sbx-+`; drops every host-local address, RFC1918, 100.64/10, link-local, multicast; allows the model endpoint `CV_SBX_LLM_HOST:CV_SBX_LLM_PORT`, default `100.75.223.14:11434`, override in `/etc/cv-agent-sandbox.env`), and filter `DOCKER-USER` accepts for coolify subnet → runtime port and the replies. Tailscale's `ts-forward` accepts anything bound for `tailscale0` before `DOCKER-USER`, which is why the egress policy lives in mangle.
- `scripts/deploy/agent-sandbox/{hermes,openclaw}-attach.sh` replace `/usr/local/bin/{hermes,openclaw}-attach.sh` (the pre-D1 scripts stay as `*-attach.legacy.sh`). The existing `*-attach.timer` units (OnBootSec 90–100 s, every 120 s) run them; the script is idempotent and re-checks rule order each run. The containers have no restart policy, so after a reboot only this script starts them, after it has written the rules.
- The API must run with `LOCAL_RUNTIME_TOPOLOGY=sandbox` (Coolify env, then redeploy) so it calls `10.201.86.2:8642` / `10.201.87.2:8643` instead of loopback. The gateway keys stay `HERMES_LOCAL_GATEWAY_KEY` / `OPENCLAW_LOCAL_GATEWAY_KEY` and must equal `/opt/hermes-data/.api-server-key` and `gateway.auth.token` in `/opt/openclaw-data/openclaw.json` (0600). The API sends nothing when a key is unset (D3).
- The runtime data dirs hold only the runtimes' own config (model key for the key-less tailnet ollama endpoint, gateway key); no ClawVille server secret is mounted.

Switch a box: copy the three scripts to `/usr/local/bin/`, `systemctl stop hermes-attach.timer openclaw-attach.timer`, keep the legacy copies, run `cv-agent-sandbox.sh ensure all`, set `LOCAL_RUNTIME_TOPOLOGY=sandbox` on the api app (tinker, model setter), redeploy the api, `systemctl start hermes-attach.timer openclaw-attach.timer`. Verify: `cv-agent-sandbox.sh status` (user 10000:10000 / 1000:1000, capdrop `[ALL]`, `raw first rule: -A PREROUTING -j CV-SBX-RAW`); from inside the api container a POST to each gateway returns 401 without the key and 200 with it; from inside each runtime TCP connects to clawville-db:5432, coolify-db, coolify-redis, the api :4000, every host address (bridge gateway, public IP 22/443/8000, tailnet IP) and other tailnet nodes time out, while the model endpoint and `1.1.1.1:443` connect.

Rollback (restores the pre-D1 shared-netns layout): unset `LOCAL_RUNTIME_TOPOLOGY` on the api app and redeploy it; `cp /usr/local/bin/hermes-attach.legacy.sh /usr/local/bin/hermes-attach.sh` (same for openclaw); `docker rm -f hermes-local openclaw-local`; `systemctl start hermes-attach.service openclaw-attach.service`. The sandbox networks and firewall chains are inert without the containers; remove them with `iptables -t raw -D PREROUTING -j CV-SBX-RAW; iptables -t mangle -D PREROUTING -i cv-sbx-+ -j CV-SBX-EGRESS; docker network rm cv-sbx-hermes cv-sbx-openclaw` if wanted.

### Backups
Hetzner auto-backups: Console → server → Backups → Enable (20% surcharge, ~$3/mo for CCX13). Keeps 7 daily snapshots. Worth it. The database has its own nightly dumps — see "Self-hosted database".

### Other tenant on the staging box: RevealAI (2026-09-28)
The staging box (87.99.142.34) also runs the RevealAI backend that replaced its Supabase project: Docker Compose project `revealai` in `/opt/revealai` (containers `revealai-db`, `revealai-rest`, `revealai-storage`; volumes `revealai_pgdata`, `revealai_storage`; about 500 MB RAM). Traefik routes only `data.revealai.fun` to it. It is not a Coolify app, and it is not part of any ClawVille deploy. Its nightly backup (`/etc/cron.d/revealai-backup`, 04:47 UTC) freezes `revealai-storage` for 10–20 s (one recovery point for database and files), restore-tests each dump, and publishes a set marker only when every check passes; restore with `/opt/revealai/restore-set.sh <marker>` (dry run) and `--yes`. The laptop pull copies `/opt/revealai/backups` to `D:\revealai-backups` and fails its task on any error. Runbook: `/opt/revealai/README.md` on the box; record: `docs/audits/2026-09-27-supabase-exit-audit.md` §4.4. Do not prune its volumes. When you rebuild or replace the staging box, move this stack too.

### Cloudflare optimizations (after cutover)
- Speed → Optimization → Brotli: on
- Caching → Configuration → Browser cache TTL: 4 hours
- Rules → Cache Rules → add rule: `(http.request.uri.path matches "\\.(glb|ktx2|webp|png|jpg|hdr|woff2)$")` → Eligible for cache, Edge TTL 1 month
  - This is the single biggest game-feel improvement — every GLB asset serves from the CF edge nearest the player instead of Helsinki/Ashburn

## Safety checklist

- [ ] `scripts/deploy/.env.deploy` is in `.gitignore` (it is — see `scripts/deploy/.gitignore`)
- [ ] Hetzner and Cloudflare API tokens are scoped to minimum permissions
- [ ] SSH key passphrase is set (recommended)
- [ ] Coolify first-run admin password is in a password manager
- [ ] Hetzner backups enabled after Step 7

## Rollback plan

If anything goes wrong after Step 7, reverting to Railway is a 2-minute DNS change:
1. Cloudflare → DNS → edit `clawville.world` A record → change content back to the old Railway IP
2. Same for `api.clawville.world`

Railway services stay up and running until Step 8, so a rollback doesn't require redeploying anything — it's just a DNS swap.

## Cost summary

| Line item | Monthly |
|---|---|
| Hetzner CCX13 | $14 |
| Hetzner backups (optional) | $3 |
| Cloudflare (student plan, existing) | $0 |
| Supabase (being retired: staging moved 2026-09-25, prod pending) | was $55–60 + egress overage |
| **Total added cost** | **$14–17** |
| Railway Pro (eliminated) | −$55 |
| **Net monthly savings** | **~$38–41** |
