import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Partner API keys — scoped read tokens for partner integrations (Hatcher
 * partner #2, Phase C — 2026-06-01). See `.claude/plans/hatcher-integration.md`
 * §4 (TIGHT auth, layer B).
 *
 * WHY a second auth layer alongside the ed25519 `PARTNER_PUBKEYS` allowlist:
 *   - The ed25519 signed-request path (`verifyPartnerSignature`) is the right
 *     primitive for the LOW-volume write/portal/registration surfaces — every
 *     request signs its body.
 *   - The skill-manifest poll + per-building SKILL.md reads are HIGH-volume and
 *     bearer-token-shaped (Hatcher polls `manifest.json` every 6–24h, fetches
 *     changed skills). A scoped, REVOCABLE bearer key is the better fit:
 *     `requirePartnerKey(scope)` gates those GETs, and a single partner can be
 *     revoked (`revoked_at`) without touching the ed25519 allowlist that the
 *     portal/registration surfaces depend on.
 *
 * SHOW-ONCE / HASH-NOT-PLAINTEXT invariant (mirrors the Phase 5.1 wallet
 * `secretKey`-returned-exactly-once rule): the raw bearer token is generated
 * ONCE by the mint helper (`scripts/mint-partner-key.ts`), printed to the
 * operator ONCE, and then ONLY its sha256 hash is persisted. The server can
 * NEVER recover or re-emit the plaintext — there is no recovery path; a lost
 * key is re-minted + the old row revoked. `key_prefix` stores the first few
 * non-secret chars purely for human-readable display in an admin list ("which
 * key is this?") and is NOT sufficient to authenticate.
 *
 * Lookup at request time: `requirePartnerKey` reads `Authorization: Bearer`,
 * computes `sha256(token)`, and looks the row up by `key_hash` (UNIQUE). The
 * hash lookup IS the constant-time-ish compare — a presented token either
 * hashes to a stored value or it doesn't; no plaintext comparison happens.
 */
export const partnerApiKeys = pgTable('partner_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Partner identifier (e.g. 'hatcher'). Aligns with the PARTNER_PUBKEYS map. */
  partnerId: varchar('partner_id', { length: 64 }).notNull(),
  /**
   * sha256(rawBearerToken) as 64-char lowercase hex. UNIQUE — the request-time
   * lookup key. The raw token is NEVER stored.
   */
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  /**
   * First chars of the raw token (e.g. `hk_ab12cd…`) for display in an admin
   * list. Non-secret — NOT enough to authenticate. Max 16 chars.
   */
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  /**
   * Granted scopes (e.g. ['skills:read','manifest:read','stats:read']).
   * `requirePartnerKey(scope)` rejects a key that lacks the required scope.
   * jsonb-backed string array.
   */
  scopes: text('scopes').array().notNull().default([]),
  /** Human label for the operator ("Hatcher prod read key"). */
  label: varchar('label', { length: 200 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  /** Best-effort last-use stamp (updated non-blocking on each validated call). */
  lastUsedAt: timestamp('last_used_at'),
  /** Set to revoke. A revoked key fails every `requirePartnerKey` check. */
  revokedAt: timestamp('revoked_at'),
});

export type PartnerApiKey = typeof partnerApiKeys.$inferSelect;
export type NewPartnerApiKey = typeof partnerApiKeys.$inferInsert;
