---
name: project-deploy-infrastructure
description: ClawVille production + staging VPS IPs. Real values for the <PROD_VPS_IP>/<STAGING_VPS_IP> placeholders in the public CLAUDE.md/AGENTS.md. Never commit these to the repo.
metadata: 
  node_type: memory
  type: project
  originSessionId: 660f876a-b012-459e-8ed1-977182c0844d
---

## ClawVille deploy infrastructure — real IPs

The public `CLAUDE.md`, `AGENTS.md`, and `docs/DEPLOY-HETZNER.md` are committed to the open-source repo `github.com/ItachiDevv/ClawVille`. They use `<PROD_VPS_IP>` / `<STAGING_VPS_IP>` placeholders. **Real values live in two private places:**

1. **`scripts/deploy/.env.deploy`** — gitignored, in-repo. Canonical source. Contains `PROD_VPS_IP`, `STAGING_VPS_IP`, plus Hetzner/Cloudflare/Namecheap API tokens. Load with `set -a; source scripts/deploy/.env.deploy; set +a` before any deploy command.
2. **This file** — Claude per-project memory. Quick reference and audit trail.

### Quick reference (current as of 2026-05-23 migration)

| Role | IP | Datacenter | Coolify | SSH key | Hostnames |
|---|---|---|---|---|---|
| **Prod** | `5.78.129.176` | Hetzner Hillsboro (us-west) | 4.1.0 | `~/.ssh/clawville_hillsboro` (passphrase — `ssh-add` once into Windows ssh-agent) | `clawville.world`, `api.clawville.world`, `new.clawville.world`, `api-new.clawville.world`, `coolify-new.clawville.world` |
| **Staging** | `87.99.142.34` | Hetzner Ashburn | 4.0.0-beta.472 | `~/.ssh/clawville_deploy` | `staging.clawville.world`, `api-staging.clawville.world`, `coolify-staging.clawville.world` |

### Coolify app IDs

| Env | App | ID | UUID |
|---|---|---|---|
| prod    | api | 2 | `ebnatuxblgp4q0antoca9swk` |
| prod    | web | 3 | `ds7hoho685ire522lz3hie2j` |
| staging | api | 3 | `yvtwz7snaghxifkjhyxknffu` |
| staging | web | 4 | `ju0n3sddhll3cuhbrspt4muy` |

**Both environments share the SAME Supabase DB.** Wallets/encryption keys (`VANITY_ENCRYPTION_KEY`, `FINGERPRINT_SECRET`, `CLAWVILLE_SERVICE_ISSUER_SK`) are byte-identical between prod and staging by design. This makes staging a hot rollback target (DNS flip = 30s rollback) but means any staging write touches prod data.

### GitHub deploy key

Single Ed25519 key registered as a deploy key on `ItachiDevv/ClawVille`. Stored in both Coolify instances as `PrivateKey` row name=`github-clawville-deploy`. Exported from old box during migration and imported via `\App\Models\PrivateKey::create(['private_key' => '...'])`. No need to add a second GitHub deploy key.

### Prefer the deploy script over hand-rolled tinker

ClawVille already has `scripts/deploy/clawville-deploy.sh` — a 1-line wrapper that calls `docker exec coolify php artisan tinker` against both apps. Updated to app IDs 2 (api) + 3 (web) for the new prod box. Designed to run **inside the prod VPS** (no SSH in the script itself).

| Goal | Canonical path |
|---|---|
| Normal code deploy | `git push origin master` (Coolify deploy-key auto-build on PROD, ~3–5 min) |
| Force-redeploy prod / poke missed webhook | `ssh root@5.78.129.176 'bash /path/to/scripts/deploy/clawville-deploy.sh'` |
| Deploy to staging only | `ssh -i ~/.ssh/clawville_deploy root@87.99.142.34` + tinker against app IDs 3 (api) / 4 (web) |
| Env-var add/update | SSH in + targeted `php artisan tinker` — see CLAUDE.md "Manual redeploy via SSH tinker" |

### Hard rule

Any `ssh root@<IP> …` or `queue_application_deployment` MUST target the IPs in this file. **NEVER guess, infer, or transpose** these IPs.

**Why:** On 2026-05-20 a Claude session hallucinated `5.78.99.224` (a stranger's Hetzner Hillsboro box with a prefix similar to the migration target). It spent ~1 hour issuing `ssh -i ~/.ssh/clawville_deploy root@5.78.99.224 'docker exec coolify php artisan tinker ... queue_application_deployment(...)'` against that foreign server. SSH key auth was rejected each time, `git-askpass.exe` dialogs piled up, no deploy ever reached the real Coolify. ~1 hour of failed-root-login attempts hit a third-party server.

### How to apply

- Before any deploy/SSH command targeting ClawVille, source `scripts/deploy/.env.deploy` for the IPs.
- If the prod IP changes (next migration), update this table first, then audit any in-flight scripts.
- If you see `5.78.99.224` referenced anywhere — that's the stale hallucination from the 2026-05-20 incident. Remove it.

### Coolify env-var encryption gotcha (2026-05-23 migration lesson)

NEVER write to `environment_variables.value` via raw `DB::update()` with `\Crypt::encryptString(...)`. Coolify's `EnvironmentVariable` model has a value mutator/accessor that re-encrypts on save and decrypts on read. Raw-SQL writes produce values the model's accessor cannot decrypt, which kills `queue_application_deployment` at the build step with a `decrypt() / unserialize()` exception. **ALWAYS** write via the Eloquent model: `$row->value = '<plaintext>'; $row->save();`. Verified pattern lives in `.migration-out/fix-envs-via-model.php`.

### Related

- Public deploy procedure: `CLAUDE.md` → "Deployment — Hetzner + Coolify" section (uses `<PROD_VPS_IP>` / `<STAGING_VPS_IP>` placeholders).
- See [[feedback_coolify_envvar_encryption]] for the mutator gotcha.
- See [[feedback_always_push_yourself]] for SSH agent setup pattern on Windows.
