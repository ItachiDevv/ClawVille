-- 0099_agent_ai_settings.sql
-- Own AI for hosted agents (MCP hub step 4 part A, 2026-11-09). A human picks
-- the AI that powers their hosted agent: ClawVille AI (default), their own key
-- (OpenAI, Anthropic, OpenRouter) or a UsePod token. The key is encrypted at
-- rest (keypair-vault encryptToken, AES-256-GCM); only the last 4 characters are
-- ever returned. A UsePod token that ClawVille registered has its OWN columns
-- (usepod_token_*): clearing own AI, a provider switch or a new own key never
-- touch them (the token holds the user's funded UsePod balance). Source
-- 'usepod' uses the registered token when usepod_registered, else the key slot
-- (a UsePod token the user pasted). agent_ai_usage counts the own-AI calls of one avatar on one UTC
-- day with an ESTIMATED cost in integer micro-USD (atomic upsert add).
-- reserved_micro_usd: the budget held by own-AI calls in flight. Before each call
-- ONE conditional upsert adds the call's worst-case estimate only when
-- estimated + reserved + estimate <= the daily limit, so parallel calls near the
-- limit cannot all pass. Settlement subtracts the reservation and adds the real
-- cost in one statement; a failed call releases it. Only the current UTC day row
-- counts, so a crashed process holds at most its in-flight reservations until
-- midnight UTC.
-- Written only by apps/api/src/services/own-ai.ts.
-- Additive and idempotent. Old code does not read these tables.

CREATE TABLE IF NOT EXISTS "agent_ai_settings" (
  "avatar_id" uuid NOT NULL,
  "source" text DEFAULT 'clawville' NOT NULL,
  "provider" text,
  "model" text,
  "speed_seconds" integer DEFAULT 25 NOT NULL,
  "daily_limit_cents" integer,
  "key_enc" text,
  "key_iv" text,
  "key_tag" text,
  "key_last4" text,
  "usepod_registered" boolean DEFAULT false NOT NULL,
  "usepod_token_enc" text,
  "usepod_token_iv" text,
  "usepod_token_tag" text,
  "usepod_token_last4" text,
  "fallback_reason" text,
  "fallback_at" timestamp with time zone,
  "updated_by_user_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_ai_settings_pkey" PRIMARY KEY ("avatar_id"),
  CONSTRAINT "agent_ai_settings_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "agent_ai_settings_updated_by_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "agent_ai_settings_source_check"
    CHECK ("source" IN ('clawville', 'own_key', 'usepod')),
  CONSTRAINT "agent_ai_settings_provider_check"
    CHECK ("provider" IS NULL OR "provider" IN ('openai', 'anthropic', 'openrouter', 'usepod')),
  CONSTRAINT "agent_ai_settings_model_check"
    CHECK ("model" IS NULL OR char_length("model") BETWEEN 1 AND 128),
  CONSTRAINT "agent_ai_settings_speed_check"
    CHECK ("speed_seconds" BETWEEN 10 AND 25),
  CONSTRAINT "agent_ai_settings_daily_limit_check"
    CHECK ("daily_limit_cents" IS NULL OR "daily_limit_cents" BETWEEN 10 AND 50000),
  CONSTRAINT "agent_ai_settings_fallback_reason_check"
    CHECK ("fallback_reason" IS NULL OR "fallback_reason" IN
      ('daily_limit', 'key_rejected', 'balance_empty', 'provider_error', 'model_unavailable')),
  CONSTRAINT "agent_ai_settings_usepod_registered_check"
    CHECK ("usepod_registered" = ("usepod_token_enc" IS NOT NULL)),
  CONSTRAINT "agent_ai_settings_own_complete_check"
    CHECK ("source" = 'clawville' OR ("provider" IS NOT NULL AND "model" IS NOT NULL
      AND "daily_limit_cents" IS NOT NULL
      AND ("key_enc" IS NOT NULL OR ("source" = 'usepod' AND "usepod_token_enc" IS NOT NULL))))
);

CREATE TABLE IF NOT EXISTS "agent_ai_usage" (
  "avatar_id" uuid NOT NULL,
  "day" date NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "estimated_micro_usd" bigint DEFAULT 0 NOT NULL,
  "reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_ai_usage_pkey" PRIMARY KEY ("avatar_id", "day"),
  CONSTRAINT "agent_ai_usage_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade
);
