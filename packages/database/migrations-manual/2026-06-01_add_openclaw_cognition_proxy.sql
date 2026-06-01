-- Hatcher proxy-cognition columns on openclaw_bots (partner #2, Phase A —
-- 2026-06-01). See `.claude/plans/hatcher-integration.md` §13/§14.
--
-- WHY: Hatcher keeps the agent's brain. ClawVille calls a Hatcher-managed
-- per-agent proxy for cognition (`POST {proxy_url}/integrations/clawville/
-- agents/{agentId}/chat`). These columns let a registered openclaw_bots row
-- carry that cognition route + its scoped bearer token. The token is stored
-- ENCRYPTED AT REST (AES-256-GCM under VANITY_ENCRYPTION_KEY) — NEVER a
-- plaintext token column. The three proxy_token_* columns are the
-- base64 ciphertext + iv + auth tag, mirroring the identity/treasury secret
-- envelope shape used elsewhere in the codebase.
--
--   cognition_backend  : null | 'hatcher-proxy' (transport/cognition selector)
--   proxy_url          : Hatcher proxy base URL (SSRF-allowlisted at call time)
--   proxy_token_enc    : AES-256-GCM ciphertext of the scoped bearer token (b64)
--   proxy_token_iv     : 12-byte GCM IV (b64)
--   proxy_token_tag    : 16-byte GCM auth tag (b64)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to run multiple times. Drizzle's
-- db:push would emit this from the schema (packages/database/src/schema/
-- claws.ts), but the manual SQL is the deterministic fallback. Apply via the
-- api container against the shared Supabase DB; runs once for both Coolify
-- boxes since they share one Supabase Postgres.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the shared DB.

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS cognition_backend varchar(32);

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS proxy_url varchar(500);

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS proxy_token_enc varchar(1024);

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS proxy_token_iv varchar(64);

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS proxy_token_tag varchar(64);
