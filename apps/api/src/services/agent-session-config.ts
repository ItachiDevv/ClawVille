/**
 * Shared, PURE config-builder for an agent's in-world `{config}` (2026-06-12).
 *
 * THE DRIFT BUG THIS PREVENTS (diagnostic-2026-06-12 D1):
 * Three independent code paths assemble the `OpenClawRegistration` that decides
 * what wire protocol an agent's in-world body speaks and which render model it
 * uses:
 *   1. mint:    POST /api/agent/connect          (agent-gateway.ts)
 *   2. mint:    POST /api/partner/hatcher/agents  (partner-hatcher.ts)
 *   3. restore: restoreAgentSessionFromRow        (openclaw-session-restore.ts)
 * When (3) diverged from (1)/(2) — restore read the row's stored `protocol`
 * (`'openai-compat'` for a no-gateway anonymous/milady agent) and built an
 * OpenAI-compat client that POSTs to the dummy `http://localhost:0` gateway,
 * 502ing on every autonomous NPC conversation tick — a real partner agent came
 * back mute after an API restart. The mint path had the SAME latent flaw: an
 * anonymous/milady avatar bot is given an `'openai-compat'` client too, so the
 * first autonomous conversation it is pulled into throws "Chat failed".
 *
 * THE FIX (structural, not spot): the IN-WORLD wire protocol is derived from the
 * AUTHORITATIVE `identityType`, not the stored `protocol` column — so a
 * no-outbound-gateway identity (anonymous / milady / nanoclaw) ALWAYS gets the
 * fail-soft `'nanoclaw'` client (its `.chat()` returns '' with NO network call),
 * a hatcher agent ALWAYS gets `'hatcher-proxy'`, and only a real-gateway identity
 * (openclaw / ironclaw / custom) speaks its declared HTTP protocol. Both the mint
 * paths and the restore path call THESE builders, so they cannot drift again —
 * the regression test asserts deep-equality of the spawn-relevant fields built
 * from a row vs. built fresh, for every identity type.
 *
 * PURE: no DB, no sim, no crypto, no env reads. Just identity → config mapping.
 * The hatcher cognition secrets (proxyBaseUrl / scopedToken / proxyAgentId) are
 * client-construction inputs, NOT part of the `OpenClawRegistration`, so they
 * are layered on by `buildHatcherClient` after this builder — keeping this module
 * free of decryption/SSRF concerns and trivially testable.
 */

import {
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_HATCHER_MODEL_KEY,
  getAgentModel,
  type AgentWireProtocol,
  type AgentAutonomyMode,
  type OpenClawRegistration,
  type OpenClawAvatarConfig,
} from '@clawville/shared';

/**
 * Combat-stat block carried on an avatar body. Matches the inline `stats` shape
 * on `OpenClawAvatarConfig` (NOT the perception `AgentStats` type — that one is
 * a per-turn telemetry struct). Derived from the config type so the two can't
 * drift.
 */
type BodyStats = OpenClawAvatarConfig['stats'];

/**
 * Identity types that have NO outbound cognition gateway of their own. Their
 * in-world body must NEVER be given an HTTP-POSTing client (openai-compat /
 * anthropic / custom-webhook) — it would POST to the dummy `http://localhost:0`
 * gateway and 502. They speak `'nanoclaw'` in-world, whose `.chat()` returns ''
 * with no network call (fail-soft):
 *   - anonymous — one-off test agent, no brain.
 *   - milady    — chat is served by the SERVER-SIDE Eliza runtime in the REST
 *                 chat routes (tried before the client); the in-world autonomous
 *                 conversation has no Eliza, so a '' reply degrades to a canned
 *                 greeting rather than a 502.
 *   - nanoclaw  — self-managed pull agent; already speaks 'nanoclaw' by design.
 */
const NO_GATEWAY_IDENTITY_TYPES: ReadonlySet<string> = new Set([
  'anonymous',
  'milady',
  'nanoclaw',
]);

/**
 * The render-model fallback for an agent whose row/request carries no explicit
 * `species`. Per category: a `hatcher` agent falls back to the hatcher default
 * (`phanes`), every other identity type to the Milady default. Returns the
 * caller's explicit species verbatim when present.
 *
 * This is the single source of the species fallback — the mint paths and restore
 * all call it, so a hatcher row with null species can never silently render as a
 * Milady (the D1 ":168/:251 used DEFAULT_AGENT_MODEL_KEY for ALL types" bug).
 */
export function resolveAgentSpecies(
  identityType: string,
  species: string | null | undefined,
): string {
  if (species) {
    // Hatcher-category render models (phanes + the bespoke Greek avatars) are
    // RESERVED for the Hatcher partner identity. /api/agent/connect and the legacy
    // /api/openclaw/register accept `species` as a free string, so without this a
    // generic agent could claim a reserved Hatcher VRM by passing species:'cronus'
    // etc. Coerce any non-hatcher identity's reserved request to the default model
    // — reserved avatars stay "selectable only through Hatcher" (the partner mint
    // path sets identityType 'hatcher', which is exempt). Closes the leak Codex
    // flagged across connect/register/mint/restore at the single chokepoint.
    if (identityType !== 'hatcher' && getAgentModel(species)?.category === 'hatcher') {
      return DEFAULT_AGENT_MODEL_KEY;
    }
    return species;
  }
  return identityType === 'hatcher'
    ? DEFAULT_HATCHER_MODEL_KEY
    : DEFAULT_AGENT_MODEL_KEY;
}

/**
 * The wire protocol an agent's IN-WORLD client must speak, derived from the
 * AUTHORITATIVE identity type (NOT the stored `protocol` column, which for a
 * no-gateway type is the meaningless `'openai-compat'` default).
 *
 *   - hatcher                         → 'hatcher-proxy'  (cognition via partner)
 *   - anonymous / milady / nanoclaw   → 'nanoclaw'       (fail-soft, no network)
 *   - openclaw / ironclaw / custom    → the agent's declared HTTP protocol
 *                                        (storedProtocol), defaulting to
 *                                        'openai-compat' — these have a REAL
 *                                        reachable gateway.
 *
 * Note: a real-gateway type whose gateway/auth can't be rebuilt from the row
 * (restore drops auth_token) is filtered out by the CALLER (restore returns null
 * for it) — this function only decides the protocol for a body that WILL spawn.
 */
export function resolveInWorldProtocol(
  identityType: string,
  storedProtocol: string | null | undefined,
): AgentWireProtocol {
  if (identityType === 'hatcher') return 'hatcher-proxy';
  if (NO_GATEWAY_IDENTITY_TYPES.has(identityType)) return 'nanoclaw';
  // Real-gateway identity: honor its declared protocol, default openai-compat.
  return (storedProtocol as AgentWireProtocol) ?? 'openai-compat';
}

/**
 * Whether an agent's in-world body can be REBUILT purely from its persisted
 * openclaw_bots row after an API restart (the restore path), or must instead
 * degrade to "reconnect" (return null).
 *
 * RESTORABLE: only the NO-OUTBOUND-GATEWAY identity types (anonymous / milady /
 * nanoclaw). They speak the fail-soft 'nanoclaw' protocol in-world (no network
 * call), so the row carries everything needed to rebuild them faithfully.
 *
 * NOT RESTORABLE: every REAL-GATEWAY identity type (openclaw / ironclaw /
 * custom). The row never persists `auth_token` (the outbound bearer to the
 * agent's own gateway), so a rebuilt body would silently 401 (a real gateway is
 * configured) or 502 against the dummy `http://localhost:0` (a legacy/malformed
 * row whose `gateway_url` is null/dummy). EITHER way the body is mute, so restore
 * returns null and the agent reconnects.
 *
 * NOTE: `hatcher` is handled by a SEPARATE branch in restore (keyed on the
 * `protocol === 'hatcher-proxy'` column + the namespaced `hatcher:` agentId, not
 * the identityType enum), because its cognition IS restorable from the encrypted
 * proxy token on the row. This predicate is consulted only for the NON-hatcher
 * identity types, so it deliberately does not special-case 'hatcher'.
 *
 * AUDITOR FIX (#6, 2026-06-12): the decision gates on the IDENTITY TYPE, not on
 * the `gateway_url` column shape. The prior restore guard refused real-gateway
 * rows ONLY when `gateway_url` was present + non-dummy, so a malformed legacy
 * `openclaw`/`custom` row with a null/dummy `gateway_url` fell through and built
 * a mute body (the restored-mute-body class). Keying on identity type closes
 * that fall-through.
 */
export function isRowRestorableFromIdentity(identityType: string): boolean {
  return NO_GATEWAY_IDENTITY_TYPES.has(identityType);
}

/**
 * P0 D-2 — whether a surviving row's session self-heals after an API restart via
 * LAZY restore (`openclaw-session-restore.ts`) — i.e. its ORIGINAL bearer rebuilds
 * on the next call. The UNION of the two branches the restore module actually
 * implements, so `session-status` can't drift from restore:
 *   - hatcher (`protocol === 'hatcher-proxy'`): cognition rebuilt from the encrypted
 *     proxy token on the row (restore's hatcher branch — keyed on protocol, which is
 *     why `isRowRestorableFromIdentity('hatcher')` alone is FALSE and insufficient).
 *   - anonymous / milady / nanoclaw (`isRowRestorableFromIdentity`): rebuilt as a
 *     fail-soft body.
 * NOT restorable: the real-gateway identity types (openclaw / ironclaw / custom) —
 * the outbound `auth_token` is never persisted, so restore returns null and the
 * agent must `/reconnect`. So `session-status` reports needs-reconnect for a live-TTL
 * row with an empty RAM Map (post-restart) ONLY for these real-gateway types; every
 * self-healing type stays `connected:true` (no needless reconnect — preserves the
 * Hatcher partner's transparent post-restart recovery).
 *
 * TYPE-LEVEL by design (session-status ruling, 2026-07-01): a DEGRADED restorable-
 * type row (hatcher missing proxyUrl/token, rotated VANITY key → undecryptable, SSRF
 * re-validation fail, override target already taken) still returns true here and
 * optimistically reports `connected:true`; the agent then recovers when its first
 * bearer call fails lazy-restore → 401/needsReconnect. This is fail-SAFE:
 * session-status grants NO access (the bearer gate `validateLiveAgentSession` is
 * authoritative), so a false-optimistic "connected" costs one extra request cycle,
 * never a security hole. A per-poll decrypt-probe (row-level restorability) is
 * deliberately NOT done — not worth the hot-path cost for a rare degraded case.
 */
export function isSessionRestorable(
  identityType: string,
  protocol: string | null | undefined,
): boolean {
  return protocol === 'hatcher-proxy' || isRowRestorableFromIdentity(identityType);
}

/**
 * The autonomy mode an agent's body runs in, derived from identity + the
 * declared protocol. nanoclaw agents are always self-managed (they pull); every
 * other type is server-managed. Mirrors the mint-path resolution so restore (and
 * the regression test) agree.
 */
export function resolveAutonomyMode(
  identityType: string,
  storedProtocol: string | null | undefined,
  requested?: AgentAutonomyMode | null,
): AgentAutonomyMode {
  if (identityType === 'nanoclaw' || storedProtocol === 'nanoclaw') {
    return 'self-managed';
  }
  return requested ?? 'server-managed';
}

/** Inputs common to avatar + override config assembly. */
export interface AgentConfigBase {
  agentId: string;
  sessionId: string;
  identityType: string;
  /** The protocol persisted on the row (or the request's wireProtocol on mint). */
  storedProtocol?: string | null;
  /** Real outbound gateway URL (openclaw/ironclaw/custom). Dummy for the rest. */
  gatewayUrl?: string | null;
  /** Outbound auth token — only the real-gateway mint path has it; '' elsewhere. */
  authToken?: string | null;
  autonomyMode?: AgentAutonomyMode | null;
  ledgerCapable: boolean;
  boundUserId: string | null;
  /**
   * Force the in-world wire protocol regardless of identity inference. Used by
   * the hatcher mint path which knows it is hatcher-proxy before the row's
   * identityType column is consulted. When omitted, derived from identity.
   */
  protocolOverride?: AgentWireProtocol;
}

export interface AvatarConfigInputs extends AgentConfigBase {
  mode: 'avatar';
  name: string;
  species: string | null | undefined;
  color: number | null | undefined;
  stats: BodyStats;
  homeX: number;
  homeY: number;
  patrolRadius: number;
  personality: string;
}

export interface OverrideConfigInputs extends AgentConfigBase {
  mode: 'override';
  targetNpcId: string;
}

/** The wire-protocol decision, shared by avatar + override assembly. */
function pickProtocol(base: AgentConfigBase): AgentWireProtocol {
  return base.protocolOverride ?? resolveInWorldProtocol(base.identityType, base.storedProtocol);
}

/**
 * Assemble the in-world `OpenClawRegistration` for an AVATAR-mode agent. The
 * SINGLE place protocol + species + autonomy + dummy-gateway defaults are
 * decided, so mint and restore produce byte-identical spawn-relevant config.
 */
export function buildAvatarSessionConfig(
  inputs: AvatarConfigInputs,
): OpenClawRegistration {
  const protocol = pickProtocol(inputs);
  return {
    agentId: inputs.agentId,
    sessionId: inputs.sessionId,
    sessionKey: inputs.sessionId,
    // No-gateway / hatcher bodies never POST to this; real-gateway bodies use
    // the row's gatewayUrl. Dummy default matches the mint paths verbatim.
    gatewayUrl: inputs.gatewayUrl ?? 'http://localhost:0',
    authToken: inputs.authToken ?? '',
    protocol,
    mode: 'avatar',
    autonomyMode: resolveAutonomyMode(
      inputs.identityType,
      inputs.storedProtocol,
      inputs.autonomyMode,
    ),
    name: inputs.name,
    species: resolveAgentSpecies(inputs.identityType, inputs.species),
    color: inputs.color ?? 0x888888,
    stats: inputs.stats,
    homeX: inputs.homeX,
    homeY: inputs.homeY,
    patrolRadius: inputs.patrolRadius,
    personality: inputs.personality,
    ledgerCapable: inputs.ledgerCapable,
    boundUserId: inputs.boundUserId,
  } as OpenClawRegistration;
}

/**
 * Assemble the in-world `OpenClawRegistration` for an OVERRIDE-mode agent (an
 * agent possessing an existing roaming NPC). Same protocol/autonomy resolution
 * as the avatar path; no render fields (the possessed NPC keeps its own body).
 */
export function buildOverrideSessionConfig(
  inputs: OverrideConfigInputs,
): OpenClawRegistration {
  const protocol = pickProtocol(inputs);
  return {
    agentId: inputs.agentId,
    sessionId: inputs.sessionId,
    sessionKey: inputs.sessionId,
    gatewayUrl: inputs.gatewayUrl ?? 'http://localhost:0',
    authToken: inputs.authToken ?? '',
    protocol,
    mode: 'override',
    autonomyMode: resolveAutonomyMode(
      inputs.identityType,
      inputs.storedProtocol,
      inputs.autonomyMode,
    ),
    targetNpcId: inputs.targetNpcId,
    ledgerCapable: inputs.ledgerCapable,
    boundUserId: inputs.boundUserId,
  } as OpenClawRegistration;
}

/**
 * The set of config fields whose drift between mint and restore is a USER-VISIBLE
 * defect (wrong backend → 502, wrong render model, wrong autonomy). The
 * regression test asserts deep-equality of exactly these between the original
 * mint config and the restored config. EXCLUDED on purpose: `sessionId` /
 * `sessionKey` (a NEW bearer per connect by design — restore re-binds the
 * incoming one), and `ledgerCapable` / `boundUserId` (the restore path
 * deliberately restores no-gateway types NON-ledger; that's the resurrection
 * contract, audited separately).
 */
/**
 * Hatcher avatar home default — the TRUE center of the 22528-px sim
 * (TOWN_CENTER 11264,11264; npc-simulation.ts MAP_WIDTH/2 after the 704-grow).
 * Lives HERE, in the shared mint/restore config module, so the MINT path
 * (partner-hatcher.ts) and the RESTORE path (openclaw-session-restore.ts) can
 * never drift to different coordinate spaces (the FIX-13 regression: mint
 * defaulted to one center while restore defaulted to a legacy center,
 * teleporting pre-fix agents on an API restart). Updated 2026-06-24 for the
 * 576->704 world grow: this default had drifted TWO world grows behind the live
 * sim, so a default-home agent spawned far off-center; it now tracks the live
 * 22528-px sim center. Hatcher's space + bounds + center is documented for the
 * partner via relay R5. NON-hatcher openclaw/gateway agents use a separate legacy
 * space (a smaller-world center) and intentionally do NOT use this constant.
 */
export const DEFAULT_HATCHER_HOME_X = 11264;
export const DEFAULT_HATCHER_HOME_Y = 11264;

export const SPAWN_RELEVANT_FIELDS = [
  'agentId',
  'gatewayUrl',
  'authToken',
  'protocol',
  'mode',
  'autonomyMode',
  'name',
  'species',
  'color',
  'targetNpcId',
] as const;

/**
 * Project an `OpenClawRegistration` down to the spawn-relevant fields for the
 * drift assertion. Missing fields (e.g. `name` on an override config) come out
 * `undefined` on both sides, so deep-equality still holds.
 */
export function spawnRelevantProjection(
  config: OpenClawRegistration,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SPAWN_RELEVANT_FIELDS) {
    out[k] = (config as unknown as Record<string, unknown>)[k];
  }
  return out;
}
