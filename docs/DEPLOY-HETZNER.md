# ClawVille → Hetzner Deploy Playbook

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
> rollback). **Each box has its OWN Supabase DB since 2026-06-16** (staging
> `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`) — staging writes no longer
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
| DB | **Supabase** (unchanged) | Already working, no migration risk |

**Not included:** Postgres on the box. Keeping it on Supabase frees ~1 GB of RAM and eliminates the biggest migration risk.

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

Both Traefik + Let's Encrypt, Cloudflare-proxied DNS, **separate Supabase Postgres per box (isolated 2026-06-16; staging `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`)** — staging writes no longer touch prod; schema converges to prod via the CI migration gate (`migrate`→`deploy`) on the `staging → master` promotion (see `deploy-status.md`). Both pull from `github.com/ItachiDevv/ClawVille` via the same shared deploy key, auto-deploy on push. Web ~3–5 min, api ~2–3 min.

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

### Backups
Hetzner auto-backups: Console → server → Backups → Enable (20% surcharge, ~$3/mo for CCX13). Keeps 7 daily snapshots. Worth it.

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
| Supabase (unchanged) | — |
| **Total added cost** | **$14–17** |
| Railway Pro (eliminated) | −$55 |
| **Net monthly savings** | **~$38–41** |
