-- Migration: create auth_tokens table for password-reset + email-verify flows.
-- Idempotent: every statement is IF NOT EXISTS so re-running is a no-op.
-- Mirrors packages/database/src/schema/auth-tokens.ts.

CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tokens_purpose_valid
    CHECK (purpose IN ('password-reset', 'email-verify')),
  CONSTRAINT auth_tokens_ttl
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx
  ON auth_tokens (user_id, purpose);

CREATE INDEX IF NOT EXISTS auth_tokens_expires_idx
  ON auth_tokens (expires_at)
  WHERE consumed_at IS NULL;
