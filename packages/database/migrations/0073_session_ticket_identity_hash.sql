-- 0073_session_ticket_identity_hash.sql: security F4 (2026-10-01), session connect hardening.
-- agent_session_tickets.identity_key stored the RAW identityKey a caller sent to /api/agent/connect or
-- /api/agent/:sessionId/control-link. An explicit identityKey is the account credential (sha256(type:key)
-- finds the user, and an identityKey connect is ledger-capable), so DB read access was enough to connect
-- as that agent. The app now writes only 'sha256:' || hex(sha256(identity_type || ':' || identity_key))
-- (services/session-ticket-service.ts ticketIdentityKeyDigest, the users.identity_fingerprint form).
-- This rewrites older rows to the same shape. Nothing reads the column back (audit only).
-- Additive and idempotent: rows already in the 'sha256:<64 hex>' shape are skipped, so a re-run matches
-- no rows. The prefix (not a bare 64-hex test) keeps raw keys that happen to be 64 hex characters in
-- scope. identity_type is NOT NULL. Built-in sha256() (PostgreSQL 11+), no pgcrypto.
UPDATE "agent_session_tickets"
SET "identity_key" = 'sha256:' || encode(sha256(convert_to("identity_type" || ':' || "identity_key", 'UTF8')), 'hex')
WHERE "identity_key" IS NOT NULL
  AND "identity_key" !~ '^sha256:[0-9a-f]{64}$';
