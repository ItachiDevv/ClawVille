# clawville-meshy-webhook

Cloudflare Worker that receives **Meshy task-status webhooks** (text/image-to-3D, rig, animate completion), verifies a shared secret, logs the payload, and returns `200`. Isolated from the ClawVille game API on purpose — this is asset-pipeline dev tooling.

## Endpoints
- `POST /` — Meshy posts the task object here on status change.
- `GET /health` — liveness.

## Deploy
```bash
cd infra/meshy-webhook-worker
# CF auth comes from the keyring (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
set -a; source ~/.itachi-api-keys; set +a
bunx wrangler deploy
# set the shared secret (also pasted into Meshy's form) + the API key for later:
printf '%s' "$MESHY_WEBHOOK_SECRET" | bunx wrangler secret put MESHY_WEBHOOK_SECRET
printf '%s' "$MESHY_API_KEY"        | bunx wrangler secret put MESHY_API_KEY
```
Deployed URL: `https://clawville-meshy-webhook.<account-subdomain>.workers.dev`

## Register in Meshy (dashboard-only — no API for this)
Meshy → **API → Webhooks → Create Webhook**:
- **Payload URL:** the deployed worker URL (`https://clawville-meshy-webhook.<…>.workers.dev/`)
- **Secret:** the SAME value you set as `MESHY_WEBHOOK_SECRET`.

## Signature verification (learn-then-lock)
Meshy doesn't publicly document its signature header/algorithm. The worker ships in **non-strict** mode (`WEBHOOK_STRICT="false"`): it logs all non-secret headers so you can identify the real signature header from the first live delivery, then accepts. Watch a delivery:
```bash
bunx wrangler tail --format pretty
```
Once you see which header carries the signature (and confirm it's HMAC-SHA256 over the raw body with the secret), add it to `SIG_HEADER_CANDIDATES` if missing and set `WEBHOOK_STRICT="true"` in `wrangler.toml`, then redeploy to hard-reject forged deliveries.

## Scaffolded (gated OFF): downstream auto-rig — `FEATURE_GATE: meshy_downstream_rig`
`maybeTriggerDownstreamRig()` is stubbed and gated behind `ENABLE_DOWNSTREAM_RIG="true"`. When enabled later it will POST a SUCCEEDED mesh task to Meshy's rigging endpoint using `MESHY_API_KEY`. Keep it off until a live payload shape is captured (avoids firing paid rig calls blind).
