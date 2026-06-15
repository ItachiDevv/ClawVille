/**
 * Reserved partner agent-id namespaces (Codex round-2 finding R2-1, 2026-06-12).
 *
 * `openclaw_bots.agent_id` is a SHARED, globally-unique namespace across every
 * framework. The PUBLIC registration entry points — `POST /api/agent/connect`
 * (agent-gateway.ts) and the legacy `POST /api/openclaw/register` (openclaw.ts)
 * — let ANY unsigned caller pick an arbitrary `agentId`. Some prefixes are
 * RESERVED for partner-signed routers (today only Hatcher's `hatcher:` space,
 * minted exclusively through the ed25519-signed `partner-hatcher.ts`).
 *
 * THE BUG (R2-1): the public enums excluded `identityType:'hatcher'`, but they
 * did NOT reserve the `hatcher:` agentId NAMESPACE. An unsigned caller could
 * POST `agentId:"hatcher:<id>"`; the existing-row upsert path then matched and
 * MUTATED the partner's row (identityType/mode/protocol/session-hash/userId),
 * breaking partner stats/patch/delete/launch, corrupting restore, and letting
 * the caller rebind the row with a token they control.
 *
 * THE FIX: every PUBLIC writer to `openclaw_bots` that takes a caller-supplied
 * `agentId` rejects a reserved prefix up front (`isReservedPartnerAgentId`),
 * and the existing-row update path additionally refuses to mutate a row whose
 * `identity_type` is a reserved partner type unless the write came through the
 * signed partner router (`assertNotReservedPartnerRow`). This is the single
 * source of truth for the reserved list so a future partner namespace is
 * covered everywhere by adding ONE entry here.
 *
 * The partner-signed routers (`partner-hatcher.ts`) namespace their own ids
 * INTO this space deliberately and own the rows, so they do NOT call these
 * guards — the guards are exclusively for the public, unsigned surfaces.
 */

/** Hatcher partner namespace — mirrors `partner-hatcher.ts` HATCHER_AGENT_PREFIX. */
export const HATCHER_AGENT_PREFIX = 'hatcher:';

/**
 * Reserved partner `agent_id` prefixes. A public/unsigned registration path must
 * NEVER let a caller create or mutate a row whose `agent_id` starts with one of
 * these — only the matching partner-signed router may write that namespace.
 *
 * Add a new entry here when onboarding a future signed partner namespace; the
 * public guards below then cover it automatically.
 */
export const RESERVED_PARTNER_AGENT_PREFIXES: readonly string[] = [
  HATCHER_AGENT_PREFIX,
];

/**
 * Reserved partner `identity_type` values. The existing-row mutation guard keys
 * on the AUTHORITATIVE `identity_type` column (not just the agentId prefix) so a
 * legacy/manually-edited row that carries a reserved identity type is still
 * protected even if its agentId somehow lacks the prefix.
 */
export const RESERVED_PARTNER_IDENTITY_TYPES: readonly string[] = ['hatcher'];

/**
 * True if a caller-supplied `agentId` falls in a reserved partner namespace.
 * Case-sensitive: the stored prefixes are lower-case literals and the partner
 * routers namespace with the exact same literal, so an exact prefix match is the
 * correct (and tightest) check — we are guarding equality with the partner's own
 * key derivation, not doing fuzzy hostname matching.
 */
export function isReservedPartnerAgentId(agentId: string): boolean {
  return RESERVED_PARTNER_AGENT_PREFIXES.some((prefix) => agentId.startsWith(prefix));
}

/**
 * True if a stored row's `identity_type` is a reserved partner type. Used by the
 * public existing-row update guard so a public caller can never mutate a
 * partner-owned row even if it managed to address it.
 */
export function isReservedPartnerIdentityType(identityType: string | null | undefined): boolean {
  return identityType != null && RESERVED_PARTNER_IDENTITY_TYPES.includes(identityType);
}
