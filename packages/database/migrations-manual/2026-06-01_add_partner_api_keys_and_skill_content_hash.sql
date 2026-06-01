-- Partner API keys + building-skill content hash (Hatcher partner #2, Phase C
-- — 2026-06-01). See `.claude/plans/hatcher-integration.md` §4.
--
-- TWO additive, idempotent changes:
--
--   1. NEW TABLE `partner_api_keys` — scoped, revocable read tokens for partner
--      integrations. The raw bearer token is NEVER stored: only `key_hash`
--      (sha256 of the token, UNIQUE — the request-time lookup key) + a
--      non-secret `key_prefix` for display. `requirePartnerKey(scope)` gates
--      the high-volume skill-manifest + per-building SKILL.md GETs; a partner
--      can be revoked via `revoked_at` without touching the ed25519
--      PARTNER_PUBKEYS allowlist that the portal/registration surfaces use.
--      Show-once mint: `scripts/mint-partner-key.ts` prints the token once,
--      stores only the hash — no recovery path (mirror of the wallet
--      secretKey-returned-exactly-once invariant).
--
--   2. NEW COLUMN `building_skills.content_hash varchar(64)` — sha256 of the
--      served markdown, so a partner can diff the manifest's per-skill hash and
--      only re-fetch a body that actually changed. Nullable so existing rows
--      don't need a backfill before the manifest works — the manifest endpoint
--      computes the hash LIVE from the served content (cached) when the column
--      is null. Backfilled by `scripts/generate-building-skills.ts`.
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` — safe
-- to run multiple times. Drizzle's db:push would emit these from the schema
-- (packages/database/src/schema/{partner-api-keys,building-skills}.ts), but the
-- manual SQL is the deterministic fallback. Apply via the api container against
-- the shared Supabase DB; runs once for both Coolify boxes since they share one
-- Supabase Postgres.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the shared DB.

CREATE TABLE IF NOT EXISTS partner_api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  varchar(64) NOT NULL,
  key_hash    varchar(64) NOT NULL UNIQUE,
  key_prefix  varchar(16) NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{}',
  label       varchar(200),
  created_at  timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp,
  revoked_at  timestamp
);

-- Fast "all live keys for a partner" admin lookup; partial on un-revoked rows.
CREATE INDEX IF NOT EXISTS partner_api_keys_partner_live_idx
  ON partner_api_keys (partner_id)
  WHERE revoked_at IS NULL;

ALTER TABLE IF EXISTS building_skills
  ADD COLUMN IF NOT EXISTS content_hash varchar(64);
