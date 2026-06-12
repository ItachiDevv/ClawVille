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
  if (species) return species;
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
