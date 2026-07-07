# Mock-Hatcher pre-ship E2E — run book (MANDATORY gate)

**Set 2026-06-12** after the Hatcher partner regressions
(`docs/diagnostic-2026-06-12-hatcher-regressions.md`) shipped because no test ever
drove the live `/api/partner/hatcher/*` binary through register → spawn → stats
with a real partner-signed request.

> **This is now a MANDATORY pre-ship gate.** Before ANY change that touches
> agent/session/partner code is promoted `staging → master`, run the mock-Hatcher
> client against staging with `ALLOW_TEST_PARTNER_PUBKEY` set, and confirm all
> assertions pass. Pair it with the two-presence browser render check (D3 repro).

---

## What it proves

| Half | Tool | Proves |
|---|---|---|
| Inbound register/stats/delete | `mock-hatcher-client.ts` | Partner write/get signatures verify on the LIVE binary; register spawns a body + provisions an avatar (with `--identity-key`); stats reads back; tokens never leak; the write-signature gate 401s a bad sig. |
| Outbound cognition | `mock-hatcher-proxy.ts` | The API signs its cognition callback with the issuer key and POSTs the OpenAI-style body to the partner proxy; the proxy verifies our Bearer + ed25519 signature and replies an `[ACTION: emote(wave)]` the sim dispatches. |

The client half passes **regardless** of whether the proxy is reachable — register
does not require the proxy to answer (the SSRF guard validates URL + DNS only).

---

## One-time: generate the test keypair + set the staging env

The client generates an ed25519 keypair on first run and writes it to `--keyfile`.
The API accepts it ONLY when `ALLOW_TEST_PARTNER_PUBKEY` on the **staging** box
equals that pubkey. **NEVER set this var on prod** — when active it adds an extra
accepted signer that inherits the FULL `hatcher` partner power set (register
agents, post stats, real-CT-capable avatars). There is no per-power scoping
because the routes hardcode `partnerId='hatcher'` (residual risk, documented in
ARCHITECTURE.md).

**Code-enforced prod kill-switch (defense-in-depth):** the test signer is
honored ONLY when the box carries the IMMUTABLE `CLAWVILLE_ENV === 'staging'`
deploy signal (`partner-signature.ts` `isStagingEnv()`), and
`partner-signature.ts` THROWS AT MODULE LOAD (crash-loud, like `FINGERPRINT_SECRET`)
if `ALLOW_TEST_PARTNER_PUBKEY` is set while `CLAWVILLE_ENV !== 'staging'` — so a
prod box that mistakenly carries the test signer REFUSES TO BOOT. `NODE_ENV`
cannot discriminate (it is `'production'` on BOTH Coolify boxes); the old
`CORS_ORIGIN` inference was RETIRED for this immutable per-box signal (2026-06-12,
Codex review #1). On staging the API logs a one-line `⚠️
ALLOW_TEST_PARTNER_PUBKEY is SET` warning (expected during a harness run). The
kill-switch is a backstop, NOT a license to leave the var set — still UNSET it
after every run (cleanup below).

> **PREREQUISITE:** the staging api box MUST also carry `CLAWVILLE_ENV=staging`
> (set per-box in Coolify) alongside `ALLOW_TEST_PARTNER_PUBKEY`, or staging boot
> fails the module-load throw. Confirm both are present before the run
> (`docker exec <api-container> env | grep -E 'CLAWVILLE_ENV|ALLOW_TEST_PARTNER_PUBKEY'`).

1. Generate the keypair locally (prints the pubkey, writes the keyfile):

   ```bash
   bun run apps/api/scripts/hatcher/mock-hatcher-client.ts \
     --api-base https://api-staging.clawville.world \
     --agent-id mock-hatcher-001 \
     --keyfile /tmp/mock-hatcher.key.json \
     --no-delete
   ```

   The first run will FAIL register with 401 (`unauthorized`) until the env is set
   — that's expected. Copy the printed `pubkey`.

2. Set `ALLOW_TEST_PARTNER_PUBKEY` on the **staging** API via Coolify tinker
   (staging api app id = 3). Use the model setter, never raw SQL (Coolify
   re-encrypts on save — see CLAUDE.md Coolify env-var gotcha):

   ```bash
   ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP \
     "docker exec coolify php artisan tinker --execute='
       use App\\Models\\Application;
       \$app = Application::find(3);
       \$app->environment_variables()->updateOrCreate(
         [\"key\" => \"ALLOW_TEST_PARTNER_PUBKEY\"],
         [\"value\" => \"<PASTE_PUBKEY_HERE>\"]
       );
       echo \"set\" . PHP_EOL;
     '"
   ```

   Then redeploy staging api (tinker `queue_application_deployment` for app 3, or
   `bash scripts/deploy/clawville-deploy.sh`). Wait for the container to flip
   (`docker exec <api-container> env | grep ALLOW_TEST_PARTNER_PUBKEY`).

3. (Optional, for the cognition half) If you can expose a PUBLIC host for the
   proxy, add its hostname to `HATCHER_PROXY_ALLOWED_HOSTS` on staging the same
   way (comma-separated; keep `hatcher.host,api.hatcher.host` and append yours).
   The host must resolve to a PUBLIC IP — the register-time guard rejects
   RFC1918/loopback/link-local.

---

## Run the client (register → stats → negative → delete)

```bash
# Full happy path, identity-bound (exercises Rule E5 avatar provisioning):
bun run apps/api/scripts/hatcher/mock-hatcher-client.ts \
  --api-base https://api-staging.clawville.world \
  --agent-id mock-hatcher-001 \
  --keyfile /tmp/mock-hatcher.key.json \
  --identity-key mock-identity-001
```

Expected output (every line `[PASS]`, exit 0):

```
[PASS] REGISTER returns 200
[PASS] REGISTER body has ok:true + sessionId
[PASS] REGISTER agent record echoes RAW agentId (hatcher: prefix stripped)
[PASS] REGISTER agent record carries protocol pointer (version + contentHash + url)
[PASS] REGISTER agent record carries sessionExpiresAt
[PASS] REGISTER agent record reports identityType=hatcher + cognitionBackend=hatcher-proxy
[PASS] REGISTER bound an identity (userId present) + avatarProvisioned=true (Rule E5 real-CT parity)
[PASS] REGISTER response leaks NO token fields
[PASS] STATS returns 200
[PASS] STATS has registration/leaderboard/learning/recentInteractions blocks
[PASS] STATS registration echoes RAW agentId + cognitionBackend + sessionExpiresAt
[PASS] STATS response leaks NO token fields
[PASS] NEGATIVE: a wrong-path signature is rejected with 401
[PASS] DELETE (cleanup) returns 200 ok:true
=== ALL ASSERTIONS PASSED ===
```

Flags: `--no-delete` leaves the agent in place (e.g. to drive the cognition half
or a browser render check next); `--delete-only` just tombstones it; omit
`--identity-key` for the anonymous (no-avatar) path.

---

## Run the cognition proxy (optional, public host required)

On the public/allowlisted host, start the proxy with the SAME scoped token you
register with (register the agent with `--no-delete` first, note the
`mock-scoped-token-…` from its register body, or hard-code one and pass it to both):

```bash
bun run apps/api/scripts/hatcher/mock-hatcher-proxy.ts \
  --api-base https://api-staging.clawville.world \
  --scoped-token <the-cognition.scopedToken-you-registered-with> \
  --port 8799
```

Then trigger cognition: in the live game, walk a player near the mock agent's
body so the sim asks it to speak (or send it a `talk_to_npc`). Watch the proxy
log for:

```
[proxy] <ts> chat agent=mock-hatcher-001 → 200 VERIFIED (bearer ok, sig ok) model=hatcher:mock-hatcher-001 playerMessage="…"
```

and confirm the agent's body plays the wave emote in-world (the reply carries
`[ACTION: emote(name=wave)]`).

---

## Cleanup (ALWAYS, before declaring the gate passed)

```bash
# Tombstone the test agent:
bun run apps/api/scripts/hatcher/mock-hatcher-client.ts \
  --api-base https://api-staging.clawville.world \
  --agent-id mock-hatcher-001 \
  --keyfile /tmp/mock-hatcher.key.json \
  --delete-only
```

Then **UNSET `ALLOW_TEST_PARTNER_PUBKEY`** on staging (and never set it on prod):

```bash
ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    Application::find(3)->environment_variables()
      ->where(\"key\", \"ALLOW_TEST_PARTNER_PUBKEY\")->delete();
    echo \"unset\" . PHP_EOL;
  '"
```

Delete the keyfile (`rm /tmp/mock-hatcher.key.json`). It is `chmod 600` and must
never be committed.

---

## Gate checklist (copy into the PR)

- [ ] `ALLOW_TEST_PARTNER_PUBKEY` set on staging (boot warning observed in logs)
- [ ] `mock-hatcher-client.ts --identity-key …` → all `[PASS]`, exit 0
- [ ] (if proxy host available) proxy log shows `→ 200 VERIFIED` + in-world wave
- [ ] two-presence browser render check passed (D3 repro — separate)
- [ ] test agent DELETEd, `ALLOW_TEST_PARTNER_PUBKEY` UNSET on staging, keyfile removed
