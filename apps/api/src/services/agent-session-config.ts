/**
 * Shared, PURE config-builder for an agent's in-world `{config}` (2026-06-12).
 *
 * THE DRIFT BUG THIS PREVENTS (diagnostic-2026-06-12 D1):
 * Three independent code paths assemble the `AgentSubstrateRegistration` that decides
 * what wire protocol an agent's in-world body speaks and which render model it
 * uses:
 *   1. mint:    POST /api/agent/connect          (agent-gateway.ts)
 *   2. mint:    POST /api/partner/hatcher/agents  (partner-hatcher.ts)
 *   3. restore: restoreAgentSessionFromRow        (agent-session-restore.ts)
 * When (3) diverged from (1)/(2) — restore read the row's stored `protocol`
 * (`'openai-compat'` for a no-gateway Milady agent) and built an
 * OpenAI-compat client that POSTs to the dummy `http://localhost:0` gateway,
 * 502ing on every autonomous NPC conversation tick — a real partner agent came
 * back mute after an API restart. The mint path had the SAME latent flaw: an
 * Milady avatar bot is given an `'openai-compat'` client too, so the
 * first autonomous conversation it is pulled into throws "Chat failed".
 *
 * THE FIX (structural, not spot): the IN-WORLD wire protocol is derived from the
 * AUTHORITATIVE `identityType`, not the stored `protocol` column — so a
 * no-outbound-gateway Milady identity ALWAYS gets the
 * fail-soft `'nanoclaw'` client (its `.chat()` returns '' with NO network call),
 * a hatcher agent ALWAYS gets `'hatcher-proxy'`, and a real-gateway OpenClaw or
 * custom identity speaks its declared HTTP protocol. Gateway-less custom joins
 * the fail-soft pull path. Both the mint
 * paths and the restore path call THESE builders, so they cannot drift again —
 * the regression test asserts deep-equality of the spawn-relevant fields built
 * from a row vs. built fresh, for every identity type.
 *
 * PURE: no DB, no sim, no crypto. Just identity → config mapping — with ONE
 * deliberate, documented env read: the boot-time `HERMES_LOCAL_GATEWAY_ENABLED`
 * gate below (D7 host-it-for-me Hermes cognition, 2026-07-02). Every resolver
 * that consults the gate also takes it as an optional parameter so tests stay
 * DB-free AND env-free.
 * The hatcher cognition secrets (proxyBaseUrl / scopedToken / proxyAgentId) are
 * client-construction inputs, NOT part of the `AgentSubstrateRegistration`, so they
 * are layered on by `buildHatcherClient` after this builder — keeping this module
 * free of decryption/SSRF concerns and trivially testable.
 */

import {
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_HATCHER_MODEL_KEY,
  getAgentModel,
  type AgentWireProtocol,
  type AgentIdentityType,
  type AgentAutonomyMode,
  type AgentSubstrateRegistration,
  type AgentAvatarConfig,
} from '@clawville/shared';

/**
 * Combat-stat block carried on an avatar body. Matches the inline `stats` shape
 * on `AgentAvatarConfig` (NOT the perception `AgentStats` type — that one is
 * a per-turn telemetry struct). Derived from the config type so the two can't
 * drift.
 */
type BodyStats = AgentAvatarConfig['stats'];

/**
 * Per-identity-type ADAPTER — the single explicit table the identity→config
 * resolvers read from (P3 slice 6, 2026-07-06). Promotes what used to be
 * scattered `if (identityType === …)` branches PLUS the old
 * `NO_GATEWAY_IDENTITY_TYPES` set into ONE record per harness, so the resolvers
 * (`resolveInWorldProtocol` / `isRowRestorableFromFacts` / `resolveAutonomyMode`
 * / `resolveAgentSpecies`, and `isSessionRestorable` via the first) cannot drift
 * on framework-specific wire defaults. Restore is deliberately NOT decided by
 * this table in protocol 25: `isRowRestorableFromFacts` uses the actual persisted
 * caller-gateway fact, and the mint↔restore regression tests pin that distinction.
 *
 * The NO-OUTBOUND-GATEWAY identities (`protocolKind:'fail-soft'` or
 * `'hermes-gated'`, `restorableFromRow:true`) — milady / hermes — must NEVER
 * be given an HTTP-POSTing client (openai-compat / anthropic
 * / custom-webhook); it would POST to the dummy `http://localhost:0` gateway and
 * 502. They speak the fail-soft `'nanoclaw'` in-world (`.chat()` → '' with no
 * network) — except hermes, which the host-it-for-me gate can upgrade to the
 * equally fail-soft `'hermes-local'` (POST to the HARDCODED server-side runtime).
 * Either way the row carries NO caller-supplied gateway and NO secrets, so every
 * no-gateway restore guarantee holds.
 */
interface IdentityAdapter {
  /**
   * How the IN-WORLD wire protocol is resolved for a body of this identity:
   *   - 'hatcher-proxy'    → always 'hatcher-proxy' (cognition via the partner).
   *   - 'hermes-gated'     → 'hermes-local' when the host-it-for-me gate is on,
   *                          else the fail-soft 'nanoclaw' stub.
   *   - 'openclaw-gated'   → 'openclaw-local' ONLY for a GATEWAY-LESS openclaw
   *                          connect when the host-it-for-me gate is on, otherwise
   *                          the internal fail-soft wire; a BYO
   *                          openclaw that declared its own gateway keeps the
   *                          declared HTTP protocol under BOTH gate states (the
   *                          hosted path never captures a real-gateway agent).
   *                          openclaw ONLY; custom uses its separate optional-
   *                          gateway decision.
   *   - 'fail-soft'        → always 'nanoclaw' (no outbound gateway, no network).
   *   - 'optional-gateway' → declared HTTP protocol when a REAL gateway is
   *                          present, otherwise the fail-soft 'nanoclaw' stub.
   *   - 'declared-gateway' → the row's declared HTTP protocol (default
   *                          'openai-compat') — a REAL reachable gateway.
   */
  protocolKind: 'hatcher-proxy' | 'hermes-gated' | 'openclaw-gated' | 'fail-soft' | 'optional-gateway' | 'declared-gateway';
  /**
   * Legacy adapter metadata retained for consumers that describe the framework's
   * native default. It is NOT the restore decision. Protocol 25 restore uses
   * `isRowRestorableFromFacts(identityType, gatewayUrl)`: every public row with
   * no real caller gateway restores, while real-gateway credentials remain
   * intentionally unpersisted. Hatcher uses its separate encrypted-proxy branch.
   */
  restorableFromRow: boolean;
  /**
   * This identity pull-drives itself (always self-managed) regardless of the
   * requested mode — the Hermes REST-poll agent. Every other identity
   * honors the requested mode, defaulting to server-managed. (An orthogonal
   * `storedProtocol==='nanoclaw'` override still forces self-managed for ANY
   * identity — preserved in `resolveAutonomyMode`, deliberately NOT encoded here.)
   */
  selfManaged: boolean;
  /**
   * Render-model fallback category when the row carries no explicit species.
   * 'hatcher' → the reserved Greek-avatar default; 'default' → the Milady
   * default. ALSO the reserved-avatar coercion key: only the 'hatcher'-category
   * identity may keep a hatcher-category species (every other identity is coerced
   * to the default), which is exactly the prior `identityType !== 'hatcher'` test
   * since hatcher is the ONLY 'hatcher'-category entry.
   */
  speciesFallback: 'hatcher' | 'default';
  /**
   * Does ClawVille server-host this identity's NATIVE cognition runtime (the
   * real framework the name implies), read by `isHostedHarness`:
   *   - 'always'       → milady (server-side Eliza, always reachable).
   *   - 'hermes-gated' → hermes: a REAL Hermes runtime is reachable ONLY when
   *                      HERMES_LOCAL_GATEWAY_ENABLED (the hermes-local wire);
   *                      otherwise a CONNECT-namespace hermes identity is a
   *                      self-managed BYO pull agent.
   *   - 'never'        → self-managed / external / partner-hosted identities.
   *
   * ⚠️ SCOPE — connect-namespace (openclaw_bots identityType) ONLY. This field
   * does NOT drive the `/me/agent-session` "hosted" advertisement and MUST NOT
   * be wired there: an AVATAR-agent's hosting is a property of its
   * platform_agents row (harness-agnostic ElizaOS runtime via the orchestrator),
   * so a signup-provisioned hermes-HARNESS avatar is genuinely hosted even with
   * the gate off. Wiring this into auth.ts was DELIBERATELY EXCLUDED in commit
   * e1b78a49 (P3 slice 6) for exactly that reason — see auth.ts HOSTED_HARNESSES.
   */
  hosted: 'always' | 'hermes-gated' | 'never';
}

const IDENTITY_ADAPTERS: Readonly<Record<string, IdentityAdapter>> = {
  // Hatcher partner: forced hatcher-proxy cognition + reserved Greek avatars.
  hatcher:   { protocolKind: 'hatcher-proxy',    restorableFromRow: false, selfManaged: false, speciesFallback: 'hatcher', hosted: 'never' },
  // No-outbound-gateway, ClawVille-hosted Eliza runtime: milady is genuinely hosted.
  milady:    { protocolKind: 'fail-soft',        restorableFromRow: true,  selfManaged: false, speciesFallback: 'default', hosted: 'always' },
  // Self-managed pull agent; host-it-for-me gate upgrades its reactive cognition
  // to the server-hosted 'hermes-local' runtime (D7, 2026-07-02).
  hermes:    { protocolKind: 'hermes-gated',     restorableFromRow: true,  selfManaged: true,  speciesFallback: 'default', hosted: 'hermes-gated' },
  // OpenClaw with a real gateway honors the declared HTTP protocol and cannot
  // restore because authToken is unpersisted. Gateway-less OpenClaw selects the
  // local runtime when enabled and pull otherwise; both are secret-free and
  // restorable. The coarse adapter cannot see that row fact, so its legacy flag
  // remains false and `isRowRestorableFromFacts` is authoritative.
  // `hosted` STAYS 'never': isHostedHarness sees only the identity, not the gateway
  // state, so it cannot answer "hosted?" for openclaw without falsely claiming a BYO
  // openclaw is hosted — the gated WIRE resolution (gateway-aware) is the real
  // hosting mechanism, not this coarse per-identity flag.
  openclaw:  { protocolKind: 'openclaw-gated',   restorableFromRow: false, selfManaged: false, speciesFallback: 'default', hosted: 'never' },
  // General catch-all. A declared gateway preserves outbound cognition and is
  // non-restorable because authToken is unpersisted. Without a real gateway the
  // agent pull-drives over REST/SSE and is restorable from non-secret row facts.
  custom:    { protocolKind: 'optional-gateway', restorableFromRow: false, selfManaged: false, speciesFallback: 'default', hosted: 'never' },
};

/**
 * The FAIL-CLOSED adapter for an UNKNOWN / future identity type: treated as a
 * real-gateway harness with NO self-heal, NO reserved avatars, NOT server-hosted.
 * Exactly reproduces the prior fall-through (unknown type → declared protocol,
 * not restorable, server-managed default, default species, never hosted).
 */
const DEFAULT_IDENTITY_ADAPTER: IdentityAdapter = {
  protocolKind: 'declared-gateway',
  restorableFromRow: false,
  selfManaged: false,
  speciesFallback: 'default',
  hosted: 'never',
};

/**
 * Resolve the adapter for an identity type, fail-closed for unknown types.
 * `Object.hasOwn` (not `in`) so an identity named after a prototype key —
 * `'toString'`, `'constructor'` — can never bypass into an inherited value.
 */
function getIdentityAdapter(identityType: string): IdentityAdapter {
  return Object.hasOwn(IDENTITY_ADAPTERS, identityType)
    ? IDENTITY_ADAPTERS[identityType]
    : DEFAULT_IDENTITY_ADAPTER;
}

const CANONICAL_PUBLIC_IDENTITY_TYPES = new Set<AgentIdentityType>([
  'milady',
  'hermes',
  'openclaw',
  'custom',
]);

/**
 * Canonicalize a PRESENT, schema-validated, non-reserved public framework name.
 * Public routes MUST reject reserved partner values (currently `hatcher`)
 * before calling this function. That ordering prevents a partner namespace from
 * ever being softened into general `custom` while keeping every other novel
 * framework on the catch-all identity/fingerprint/config path.
 */
export function canonicalizePublicAgentIdentityType(
  presentedIdentityType: string,
): AgentIdentityType {
  return CANONICAL_PUBLIC_IDENTITY_TYPES.has(presentedIdentityType as AgentIdentityType)
    ? presentedIdentityType as AgentIdentityType
    : 'custom';
}

/**
 * Resolve the protocol-25 public identity label. A valid explicit framework is
 * authoritative; the legacy Milady plugin signal infers Milady only when the
 * label is omitted; every other omitted label uses the general custom adapter.
 * Gateway presence is a cognition fact, never an identity requirement.
 */
export function resolveDirectAgentIdentityType(input: {
  explicitIdentityType?: AgentIdentityType;
  hasMiladyRuntimeSignal: boolean;
  hasDeclaredGateway: boolean;
}): AgentIdentityType {
  if (input.explicitIdentityType) return input.explicitIdentityType;
  if (input.hasMiladyRuntimeSignal) return 'milady';
  return 'custom';
}

/** Deterministic `/connect` validation paired with the resolver above. */
export function directAgentIdentityValidationError(input: {
  identityType: AgentIdentityType | null;
  hasMiladyRuntimeSignal: boolean;
  hasDeclaredGateway: boolean;
  declaredProtocol?: AgentWireProtocol;
  openclawLocalGatewayEnabled?: boolean;
}): string | null {
  void input;
  return null;
}

/**
 * Resolve the stable identity used by the direct-connect ticket/fingerprint
 * path. The normalized identity is authoritative regardless of gateway facts;
 * routing and ownership must never independently infer different labels from
 * the same request.
 */
export function resolveIdentityForTicket(
  data: {
    identityKey?: string;
    miladyAgentId?: string;
    gatewayUrl?: string;
    authToken?: string;
  },
  resolvedIdentityType: AgentIdentityType,
): { identityType: AgentIdentityType; identityKey: string } | null {
  if (data.identityKey) {
    return { identityType: resolvedIdentityType, identityKey: data.identityKey };
  }
  if (data.miladyAgentId) {
    return { identityType: resolvedIdentityType, identityKey: data.miladyAgentId };
  }
  if (hasRealDeclaredGateway(data.gatewayUrl) && data.authToken) {
    return {
      identityType: resolvedIdentityType,
      identityKey: `${data.gatewayUrl}#${data.authToken.slice(0, 8)}`,
    };
  }
  return null;
}

/**
 * Normalize the row's routing fact for `/connect`. Once validation succeeds,
 * the current request is authoritative: a real declared URL is persisted and
 * its absence persists NULL. This clears stale BYO URLs when a returning row is
 * intentionally relabeled Milady/Hermes or enters hosted OpenClaw mode.
 */
export function resolveConnectGatewayForPersistence(input: {
  identityType: AgentIdentityType;
  requestGatewayUrl?: string | null;
  /** Prior row fact is accepted only so its deliberate replacement is explicit. */
  existingGatewayUrl?: string | null;
}): string | null {
  return hasRealDeclaredGateway(input.requestGatewayUrl)
    ? input.requestGatewayUrl!
    : null;
}

/**
 * D7 host-it-for-me Hermes cognition (magic-link onboarding, 2026-07-02).
 *
 * A 'hermes' agent is fundamentally a SELF-MANAGED pull agent (it drives itself
 * via our REST, like nanoclaw). Optionally — for hermes owners who want ClawVille
 * to host the brain — the box can run a local `hermes run`-compatible runtime and
 * flip `HERMES_LOCAL_GATEWAY_ENABLED=true`, upgrading hermes bodies' REACTIVE/
 * ambient cognition (autonomous NPC conversations) from the silent 'nanoclaw'
 * stub to a 'hermes-local' client that POSTs OpenAI-compat chat to the runtime.
 *
 * SSRF STANCE — READ BEFORE "FIXING" THIS: the URL is a HARDCODED server-side
 * constant, deliberately NOT env-overridable and NEVER read from caller input or
 * the bot row. `validateOutboundUrlResolved` (hatcher-config.ts) keeps rejecting
 * localhost/RFC1918 for every CALLER-SUPPLIED URL — this constant is not a
 * loosening of that guard, it is the one server-owned exception that never mixes
 * with caller data. Making it configurable would reopen the exact
 * POST-a-bearer-to-an-internal-address class the general guard closes.
 */
export const HERMES_LOCAL_GATEWAY_URL = 'http://localhost:8642';

/**
 * Optional bearer for the local Hermes runtime (2026-07-08, real-runtime
 * deploy). Hermes ≥0.12 REFUSES to start its OpenAI-compat API server without
 * an API_SERVER_KEY, even on loopback — so the real hosted runtime demands a
 * key the D7 "bare POST" contract didn't carry. Read ONCE at module load like
 * the gate above. Unset ⇒ no Authorization header is sent (the mock-hermes
 * harness contract is unchanged). This is a same-box shared secret, not a
 * user credential: it never leaves localhost and is never logged.
 */
export const HERMES_LOCAL_GATEWAY_KEY = process.env.HERMES_LOCAL_GATEWAY_KEY ?? '';

/**
 * Leash for a hermes-local cognition POST (ms). The 10s AgentSubstrateClient
 * default was sized for thin BYO gateways; the REAL hosted Hermes agent loop
 * measured 7.3s on an idle qwen3.6:27b for a trivial turn (2026-07-08), so a
 * busier prompt or GPU contention overruns 10s and the body goes fail-soft
 * silent. Env-tunable, clamped [1s, 30s]; default keeps the design 10s. The
 * fail-soft contract is unchanged — this only sizes the leash.
 */
export const HERMES_LOCAL_TIMEOUT_MS = (() => {
  const raw = process.env.HERMES_LOCAL_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : 10_000;
  if (!Number.isFinite(n)) return 10_000;
  return Math.min(30_000, Math.max(1_000, n));
})();

/**
 * Boot-time gate for the 'hermes-local' upgrade. Read ONCE at module load (the
 * documented single env read of this module — matches how the deploy sets env
 * per-box); tests exercise both states via the explicit parameter on
 * `resolveInWorldProtocol`, never by mutating process.env.
 */
const HERMES_LOCAL_GATEWAY_ENABLED = process.env.HERMES_LOCAL_GATEWAY_ENABLED === 'true';

/**
 * D-openclaw host-it-for-me OpenClaw cognition (shared-inference onboarding,
 * 2026-07-08) — the exact mirror of the Hermes host-it-for-me gate above.
 *
 * A connect-namespace 'openclaw' agent is a BYO harness by default (it declares
 * its own `gatewayUrl` at /connect and we POST cognition there). But an openclaw
 * agent that connects WITHOUT a gateway of its own is the ClawVille-HOSTED case:
 * when the box runs a local OpenClaw-compatible runtime and flips
 * `OPENCLAW_LOCAL_GATEWAY_ENABLED=true`, that gateway-less body's REACTIVE/ambient
 * cognition (autonomous NPC conversations) is upgraded from the silent 'nanoclaw'
 * stub to an 'openclaw-local' client that POSTs OpenAI-compat chat to the runtime.
 *
 * PRECEDENCE (pinned by tests): a BYO openclaw WITH a declared gateway is NEVER
 * captured — it keeps its declared HTTP protocol byte-identically whether or not
 * this gate is on. Only the gateway-LESS openclaw connect is hosted.
 *
 * SSRF STANCE — READ BEFORE "FIXING" THIS: identical to the Hermes constant. The
 * URL is a HARDCODED server-side constant, deliberately NOT env-overridable and
 * NEVER read from caller input or the bot row. `validateOutboundUrlResolved`
 * (hatcher-config.ts) keeps rejecting localhost/RFC1918 for every CALLER-SUPPLIED
 * URL — this constant is not a loosening of that guard, it is the one server-owned
 * exception that never mixes with caller data.
 */
export const OPENCLAW_LOCAL_GATEWAY_URL = 'http://localhost:8643';

/**
 * Optional bearer for the local OpenClaw gateway — the exact mirror of
 * `HERMES_LOCAL_GATEWAY_KEY` (2026-07-08). The real-Hermes deploy proved a hosted
 * OpenAI-compat runtime can REFUSE to serve without an API key even on loopback;
 * the real OpenClaw gateway (github.com/openclaw/openclaw) is assumed no
 * friendlier, so carry a same-box shared secret as `Authorization: Bearer` when
 * set. Read ONCE at module load like the gate. Unset ⇒ no Authorization header
 * (the mock-openclaw harness contract is unchanged). Same-box shared secret, not
 * a user credential: it never leaves localhost and is never logged.
 */
export const OPENCLAW_LOCAL_GATEWAY_KEY = process.env.OPENCLAW_LOCAL_GATEWAY_KEY ?? '';

/**
 * Leash for an openclaw-local cognition POST (ms) — the exact mirror of
 * `HERMES_LOCAL_TIMEOUT_MS`. The 10s AgentSubstrateClient default was sized for
 * thin BYO gateways; the real hosted Hermes loop measured 7.3s idle on
 * qwen3.6:27b, and a hosted OpenClaw loop on a local model is no faster, so a
 * busier prompt or GPU contention overruns 10s and the body goes fail-soft
 * silent. Env-tunable, clamped [1s, 30s]; default keeps the design 10s. The
 * fail-soft contract is unchanged — this only sizes the leash.
 */
export const OPENCLAW_LOCAL_TIMEOUT_MS = (() => {
  const raw = process.env.OPENCLAW_LOCAL_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : 10_000;
  if (!Number.isFinite(n)) return 10_000;
  return Math.min(30_000, Math.max(1_000, n));
})();

/**
 * Boot-time gate for the 'openclaw-local' upgrade. Read ONCE at module load (the
 * SECOND documented env read of this module — matches how the deploy sets env
 * per-box); tests exercise both states via the explicit parameter on
 * `resolveInWorldProtocol`, never by mutating process.env.
 */
const OPENCLAW_LOCAL_GATEWAY_ENABLED = process.env.OPENCLAW_LOCAL_GATEWAY_ENABLED === 'true';

/**
 * The wire protocols an IN-WORLD body can actually speak — the shared
 * `AgentWireProtocol` union widened by exactly TWO SERVER-INTERNAL values:
 * 'hermes-local' and 'openclaw-local' (AgentSubstrateClient POSTs to the
 * respective HARDCODED `*_LOCAL_GATEWAY_URL`).
 *
 * Why these are NOT added to the shared union: `packages/shared/src/
 * types/agent-substrate.ts` is on the Hatcher partner-protected surface, and these
 * values never cross a partner wire, are never caller-suppliable (the connect
 * schema's `protocol` field can't request them), and are never authoritative on
 * the row (the in-world protocol is RE-derived from `identityType`+gateway on both
 * mint and restore — the D1 pattern). They exist only between this module and
 * AgentSubstrateClient, so they stay server-internal widenings here.
 */
export type InWorldWireProtocol = AgentWireProtocol | 'hermes-local' | 'openclaw-local';

export type ConnectCognitionMode = 'hosted' | 'pull' | 'gateway' | 'partner-proxy';

export interface ConnectCognitionDecision {
  mode: ConnectCognitionMode;
  protocol: InWorldWireProtocol;
  ignoredFields: string[];
}

export interface NormalizedDirectAgentConnectRequest {
  /** Stable public handle after agentId-first legacy-alias normalization. */
  agentId: string | null;
  identityType: AgentIdentityType;
  /** Only a caller gateway actually selected for outbound cognition survives. */
  gatewayUrl?: string;
  /** Request-scoped only; callers MUST NOT persist this field. */
  authToken?: string;
  /** Row protocol input. Internal local wires remain re-derived at runtime. */
  storedProtocol: AgentWireProtocol;
  /** Legacy Milady key is ownership proof only on a Milady identity path. */
  ticketMiladyAgentId?: string;
  cognition: ConnectCognitionDecision;
  restorableFromRow: boolean;
}

/**
 * Universal public `/connect` normalizer (protocol 25).
 *
 * This is the single decision point before validation, persistence, ticket
 * resolution, and session construction. It accepts harmless platform-shaped
 * fields, selects one effective transport, and reports field NAMES that were
 * not consumed. Secret values are never reflected.
 */
export function normalizeDirectAgentConnectRequest(input: {
  agentId?: string;
  miladyAgentId?: string;
  explicitIdentityType?: AgentIdentityType;
  gatewayUrl?: string;
  authToken?: string;
  protocol?: AgentWireProtocol;
}, gates: {
  hermesLocalGatewayEnabled?: boolean;
  openclawLocalGatewayEnabled?: boolean;
} = {}): NormalizedDirectAgentConnectRequest {
  const identityType = resolveDirectAgentIdentityType({
    explicitIdentityType: input.explicitIdentityType,
    hasMiladyRuntimeSignal: !!input.miladyAgentId,
    hasDeclaredGateway: hasRealDeclaredGateway(input.gatewayUrl),
  });
  const agentId = input.agentId ?? (
    input.miladyAgentId ? `milady:${input.miladyAgentId}` : null
  );
  const ignoredFields: string[] = [];
  if (
    input.miladyAgentId &&
    input.explicitIdentityType &&
    input.explicitIdentityType !== 'milady'
  ) {
    // The legacy field may still provide the fallback HANDLE when agentId is
    // absent, but it never overrides the explicit identity or proves ownership.
    ignoredFields.push('miladyAgentId');
  }

  const explicitPull = input.protocol === 'nanoclaw';
  const requestedGateway = hasRealDeclaredGateway(input.gatewayUrl);
  const nativeNoCallerGateway = identityType === 'milady' || identityType === 'hermes';
  const usesGateway = !explicitPull && !nativeNoCallerGateway && requestedGateway;
  const gatewayUrl = usesGateway ? input.gatewayUrl : undefined;
  const authToken = usesGateway ? input.authToken : undefined;

  if (input.gatewayUrl !== undefined && !usesGateway) ignoredFields.push('gatewayUrl');
  if (input.authToken !== undefined && !usesGateway) ignoredFields.push('authToken');

  let mode: ConnectCognitionMode;
  let protocol: InWorldWireProtocol;
  let storedProtocol: AgentWireProtocol;
  if (explicitPull) {
    mode = 'pull';
    protocol = 'nanoclaw';
    storedProtocol = 'nanoclaw';
  } else if (usesGateway) {
    mode = 'gateway';
    protocol = input.protocol ?? 'openai-compat';
    storedProtocol = input.protocol ?? 'openai-compat';
  } else if (identityType === 'milady') {
    mode = 'hosted';
    protocol = 'nanoclaw';
    storedProtocol = 'openai-compat';
  } else if (identityType === 'hermes') {
    const hosted = gates.hermesLocalGatewayEnabled ?? HERMES_LOCAL_GATEWAY_ENABLED;
    mode = hosted ? 'hosted' : 'pull';
    protocol = hosted ? 'hermes-local' : 'nanoclaw';
    storedProtocol = 'openai-compat';
  } else if (identityType === 'openclaw') {
    const hosted = gates.openclawLocalGatewayEnabled ?? OPENCLAW_LOCAL_GATEWAY_ENABLED;
    mode = hosted ? 'hosted' : 'pull';
    protocol = hosted ? 'openclaw-local' : 'nanoclaw';
    storedProtocol = 'openai-compat';
  } else {
    mode = 'pull';
    protocol = 'nanoclaw';
    storedProtocol = 'openai-compat';
  }

  if (input.protocol !== undefined && !explicitPull && !usesGateway) {
    ignoredFields.push('protocol');
  }

  return {
    agentId,
    identityType,
    gatewayUrl,
    authToken,
    storedProtocol,
    ...(input.miladyAgentId && identityType === 'milady'
      ? { ticketMiladyAgentId: input.miladyAgentId }
      : {}),
    cognition: { mode, protocol, ignoredFields },
    restorableFromRow: isRowRestorableFromFacts(
      identityType,
      gatewayUrl,
      undefined,
      storedProtocol,
    ),
  };
}

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
  const isHatcherCategory = getIdentityAdapter(identityType).speciesFallback === 'hatcher';
  if (species) {
    // Hatcher-category render models (phanes + the bespoke Greek avatars) are
    // RESERVED for the Hatcher partner identity. /api/agent/connect and the legacy
    // /api/openclaw/register accept `species` as a free string, so without this a
    // generic agent could claim a reserved Hatcher VRM by passing species:'cronus'
    // etc. Coerce any non-hatcher identity's reserved request to the default model
    // — reserved avatars stay "selectable only through Hatcher" (the partner mint
    // path sets identityType 'hatcher', the ONLY 'hatcher'-category adapter, which
    // is exempt). Closes the leak Codex flagged across connect/register/mint/restore
    // at the single chokepoint.
    if (!isHatcherCategory && getAgentModel(species)?.category === 'hatcher') {
      return DEFAULT_AGENT_MODEL_KEY;
    }
    return species;
  }
  return isHatcherCategory ? DEFAULT_HATCHER_MODEL_KEY : DEFAULT_AGENT_MODEL_KEY;
}

/**
 * The wire protocol an agent's IN-WORLD client must speak, derived from the
 * AUTHORITATIVE identity type (NOT the stored `protocol` column, which for a
 * no-gateway type is the meaningless `'openai-compat'` default).
 *
 *   - hatcher                         → 'hatcher-proxy'  (cognition via partner)
 *   - hermes                          → 'hermes-local' when the host-it-for-me
 *                                        gate is on, else 'nanoclaw' (BOTH are
 *                                        fail-soft; the gate decides whether
 *                                        reactive cognition POSTs to the
 *                                        hardcoded local runtime or stays a
 *                                        silent stub). Derived from identity on
 *                                        mint AND restore — never from the
 *                                        stored column.
 *   - milady                          → 'nanoclaw'       (fail-soft tool-surface body;
 *                                        cognition stays in-process)
 *   - openclaw                        → the agent's declared HTTP protocol, or
 *                                        its gated local/fail-soft no-gateway wire
 *   - custom                          → declared HTTP protocol with a gateway;
 *                                        otherwise fail-soft 'nanoclaw'
 *
 * Note: a real-gateway type whose gateway/auth can't be rebuilt from the row
 * (restore drops auth_token) is filtered out by the CALLER (restore returns null
 * for it) — this function only decides the protocol for a body that WILL spawn.
 *
 * @param hermesLocalEnabled test seam for the D7 gate — defaults to the
 *   boot-time `HERMES_LOCAL_GATEWAY_ENABLED` env read. Consulted ONLY on the
 *   'hermes' branch; every other identity type derives identically regardless
 *   (the hatcher-inertness test pins this).
 * @param routingFacts gateway-aware routing facts. `{ enabled }` is consulted
 *   ONLY on the 'openclaw' branch and defaults to the boot-time
 *   `OPENCLAW_LOCAL_GATEWAY_ENABLED` env read; `{ hasDeclaredGateway }` is the
 *   load-bearing precedence signal — a BYO openclaw with its own gateway is
 *   NEVER captured by the hosted path. FAIL-SAFE: when the bag is passed without
 *   `hasDeclaredGateway`, it is treated as `true` (declared-gateway → the legacy
 *   BYO behaviour), so only an EXPLICIT gateway-less signal routes to the hosted
 *   runtime; when the gate is off, that same explicit no-gateway fact resolves
 *   fail-soft instead of POSTing to a dummy URL. When the whole bag is omitted
 *   (legacy callers / the hermes+hatcher
 *   tests), the openclaw branch is byte-identical to a declared-gateway harness.
 */
export function resolveInWorldProtocol(
  identityType: string,
  storedProtocol: string | null | undefined,
  hermesLocalEnabled: boolean = HERMES_LOCAL_GATEWAY_ENABLED,
  routingFacts?: { enabled?: boolean; hasDeclaredGateway?: boolean },
): InWorldWireProtocol {
  const kind = getIdentityAdapter(identityType).protocolKind;
  if (kind === 'hatcher-proxy') return 'hatcher-proxy';
  // Public protocol 25 precedence: an explicit pull request is authoritative.
  // The normalizer removes any harmless caller gateway before builders reach
  // this resolver, so no outbound client can capture an explicit nanoclaw row.
  if (storedProtocol === 'nanoclaw') return 'nanoclaw';
  // hermes: the host-it-for-me gate upgrades its fail-soft stub to the local
  // runtime client. (The registry keys hermes to 'hermes-gated' — never the
  // plain 'fail-soft' — so it can never fall through to the stub when enabled.)
  if (kind === 'hermes-gated') return hermesLocalEnabled ? 'hermes-local' : 'nanoclaw';
  // openclaw: the host-it-for-me gate upgrades ONLY a GATEWAY-LESS openclaw
  // connect to the fail-soft local runtime. A BYO openclaw that declared its own
  // gateway keeps its declared protocol under BOTH gate states (the precedence
  // the directive pins) — the hosted path never captures a real-gateway agent.
  // Custom is optional-gateway, never openclaw-gated, so the host gate cannot
  // affect it; only the shared declared-gateway fact below does.
  if (kind === 'openclaw-gated') {
    if (routingFacts) {
      const enabled = routingFacts.enabled ?? OPENCLAW_LOCAL_GATEWAY_ENABLED;
      // FAIL-SAFE default: an absent gateway signal means "assume a declared
      // gateway" (legacy BYO behaviour), so a caller that opts into the openclaw
      // path but omits the signal can never mis-route a BYO agent to hosted.
      const hasDeclaredGateway = routingFacts.hasDeclaredGateway ?? true;
      if (enabled && !hasDeclaredGateway) return 'openclaw-local';
      if (!hasDeclaredGateway) return 'nanoclaw';
    }
    return (storedProtocol as AgentWireProtocol) ?? 'openai-compat';
  }
  if (kind === 'fail-soft') return 'nanoclaw';
  if (kind === 'optional-gateway') {
    // FAIL-SAFE for legacy callers that do not provide the row/request fact:
    // assume the historical declared-gateway path. Builders always supply the
    // explicit fact, so a real gateway-less custom connect resolves nanoclaw.
    const hasDeclaredGateway = routingFacts?.hasDeclaredGateway ?? true;
    if (!hasDeclaredGateway) return 'nanoclaw';
  }
  // 'declared-gateway' — a REAL reachable gateway: honor its declared protocol,
  // default openai-compat.
  return (storedProtocol as AgentWireProtocol) ?? 'openai-compat';
}

/**
 * Whether an agent's in-world body can be REBUILT purely from its persisted
 * openclaw_bots row after an API restart (the restore path), or must instead
 * degrade to "reconnect" (return null).
 *
 * RESTORABLE: every non-Hatcher row whose real caller gateway is absent/dummy.
 * It speaks a hosted, local, or fail-soft
 * protocol in-world ('nanoclaw', or
 * for hermes the equally fail-soft env-gated 'hermes-local' whose target is a
 * server-side constant — no secrets on the row either way), so the row carries
 * everything needed to rebuild them faithfully.
 *
 * NOT RESTORABLE: any row with a real caller gateway. The row
 * never persists `auth_token` (the outbound bearer to the
 * agent's own gateway), so a rebuilt body would silently 401 (a real gateway is
 * configured). Gateway-less custom is a secret-free pull row and restores.
 *
 * NOTE: `hatcher` is handled by a SEPARATE branch in restore (keyed on the
 * `protocol === 'hatcher-proxy'` column + the namespaced `hatcher:` agentId, not
 * the identityType enum), because its cognition IS restorable from the encrypted
 * proxy token on the row. This predicate is consulted only for the NON-hatcher
 * identity types, so it deliberately does not special-case 'hatcher'.
 *
 * 2026-07-20 EFFECTIVE-TRANSPORT COLLAPSE: restore depends on what cognition
 * actually selected, not raw stale fields. Native Milady/Hermes always ignore a
 * caller gateway; an explicit persisted `nanoclaw` wire always selects pull;
 * otherwise a real selected caller gateway requires reconnect. The optional
 * protocol argument is appended after the legacy gate seam so existing callers
 * retain their positional semantics.
 */
export function isRowRestorableFromFacts(
  identityType: string,
  gatewayUrl?: string | null,
  _openclawLocalGatewayEnabled = OPENCLAW_LOCAL_GATEWAY_ENABLED,
  storedProtocol?: string | null,
): boolean {
  // Hatcher remains a separate, protocol-keyed encrypted-proxy restore branch.
  if (identityType === 'hatcher') return false;
  // Native hosted/local adapters never consume caller gateway fields, including
  // stale values left by an older row shape. Their persisted non-secret facts
  // are sufficient under either local-runtime gate state.
  if (identityType === 'milady' || identityType === 'hermes') return true;
  // Protocol 25 explicit-pull precedence is authoritative even when a stale
  // gateway URL survives on a legacy row: no outbound credential is selected.
  if (storedProtocol === 'nanoclaw') return true;
  // Canonical general/OpenClaw rows rebuild hosted/local/pull cognition when no
  // real gateway is selected. A REAL selected gateway is not restorable because
  // authToken is intentionally request-scoped and never persisted.
  if (identityType === 'openclaw' || identityType === 'custom') {
    return !hasRealDeclaredGateway(gatewayUrl);
  }
  // Raw legacy unknown/prototype-key rows never passed protocol-25 public
  // canonicalization. Their fail-closed adapter defaults to a declared HTTP wire,
  // so restore would otherwise build a mute localhost client. Only the explicit
  // nanoclaw branch above proves such a row selected safe pull cognition.
  return false;
}

/**
 * P0 D-2 — whether a surviving row's session self-heals after an API restart via
 * LAZY restore (`agent-session-restore.ts`) — i.e. its ORIGINAL bearer rebuilds
 * on the next call. The UNION of the two branches the restore module actually
 * implements, so `session-status` can't drift from restore:
 *   - hatcher (`protocol === 'hatcher-proxy'`): cognition rebuilt from the encrypted
 *     proxy token on the row (restore's hatcher branch — keyed on protocol, which is
 *     why `isRowRestorableFromFacts('hatcher')` alone is FALSE and insufficient).
 *   - every public row whose effective transport does not consume a real caller
 *     gateway (`isRowRestorableFromFacts`), including native Milady/Hermes and
 *     explicit persisted `nanoclaw` rows with an ignored stale gateway value.
 * NOT restorable: every effectively selected real caller-gateway row —
 * the outbound `auth_token` is never persisted, so restore returns null and the
 * agent must `/reconnect`. So `session-status` reports needs-reconnect for a live-TTL
 * row with an empty RAM Map (post-restart) ONLY for these real-gateway types; every
 * self-healing type stays `connected:true` (no needless reconnect — preserves the
 * Hatcher partner's transparent post-restart recovery).
 *
 * EFFECTIVE TRANSPORT + ROW FACTS by design. Protocol precedence and identity
 * determine whether a gateway value is selected or ignored; the optional
 * `hatcherProxyConfigPresent`
 * lets a caller that already has the row (session-status) reject a hatcher-proxy
 * row whose proxy config is STRUCTURALLY ABSENT (`proxyUrl`/`proxyTokenEnc`/`Iv`/
 * `Tag` null) — restore fail-closes on exactly that (`restoreAgentSessionFromRow`),
 * so without the check a row that permanently dropped its proxy config would report
 * `connected:true` to a polling partner FOREVER. It costs only null checks (no
 * decrypt, no DNS). When the param is omitted (`undefined`) the behaviour is the
 * original type-level union (backward-compatible for callers without the row).
 *
 * The OTHER degraded cases stay type-level + documented fail-SAFE: a rotated VANITY
 * key → undecryptable token, an SSRF re-validation failure, or an override target
 * already taken all still return true here and optimistically report
 * `connected:true`; the agent recovers when its first bearer call fails lazy-restore
 * → 401/needsReconnect. Detecting those needs a decrypt / DNS resolve, not worth the
 * hot-path cost, and it is safe: session-status grants NO access (the bearer gate
 * `validateLiveAgentSession` is authoritative), so a false-optimistic "connected"
 * costs one extra request cycle, never a security hole.
 *
 * @param hatcherProxyConfigPresent when the caller has the row: `false` marks a
 *   hatcher-proxy row with missing proxy config (→ NOT restorable); `true`/omitted
 *   keep the type-level result.
 */
export function isSessionRestorable(
  identityType: string,
  protocol: string | null | undefined,
  hatcherProxyConfigPresent?: boolean,
  gatewayUrl?: string | null,
  openclawLocalGatewayEnabled = OPENCLAW_LOCAL_GATEWAY_ENABLED,
): boolean {
  if (protocol === 'hatcher-proxy') {
    // Self-heals via restore ONLY if the proxy config is present. Omitted param
    // (undefined) ⇒ type-level true (documented fail-safe); explicit false ⇒ the
    // row can't rebuild cognition, so tell the agent to reconnect.
    return hatcherProxyConfigPresent !== false;
  }
  return isRowRestorableFromFacts(
    identityType,
    gatewayUrl,
    openclawLocalGatewayEnabled,
    protocol,
  );
}

/**
 * The autonomy mode an agent's body runs in, derived from identity + the
 * declared protocol. Hermes agents are always self-managed (they pull-drive via
 * our REST — that holds in BOTH gate states, since
 * 'hermes-local' only serves reactive/ambient cognition, never self-drive);
 * every other type is server-managed. Mirrors the mint-path resolution so
 * restore (and the regression test) agree.
 */
export function resolveAutonomyMode(
  identityType: string,
  storedProtocol: string | null | undefined,
  requested?: AgentAutonomyMode | null,
  hasDeclaredGateway?: boolean,
): AgentAutonomyMode {
  // The identity's own self-managed flag (hermes) OR the orthogonal
  // row-level override (a stored 'nanoclaw' protocol on ANY identity) both force
  // self-managed — the exact prior disjunction.
  if (
    getIdentityAdapter(identityType).selfManaged ||
    storedProtocol === 'nanoclaw' ||
    (identityType === 'custom' && hasDeclaredGateway === false)
  ) {
    return 'self-managed';
  }
  return requested ?? 'server-managed';
}

/**
 * IN-WORLD PROTOCOL capability table (P3 slice 6, 2026-07-06). Keyed by the
 * in-world WIRE PROTOCOL (what `AgentSubstrateClient.getProtocol()` returns), NOT
 * the identityType — because the two npc-simulation predicates that consume this
 * read the live client's protocol, not the row's identity. It is the single
 * source generalizing the two previously-hardcoded `=== 'hatcher-proxy'` checks
 * from Hatcher-only to "every server-hosted-cognition protocol".
 *
 * EXHAUSTIVE by construction: typed `Record<InWorldWireProtocol, …>`, so adding a
 * member to `InWorldWireProtocol` fails compilation until its capabilities are
 * declared here — no protocol can silently inherit a default. FAIL-CLOSED at the
 * read boundary: an unknown/undefined protocol string grants NEITHER capability
 * (the exported predicates below).
 *
 * Two capabilities, deliberately DISTINCT (do not collapse them):
 *   - `emitsInWorldActions` — the body's reply is parsed for `[ACTION:]` tags and
 *     dispatched (`dispatchHatcherActions`). TRUE only for the SERVER-HOSTED-
 *     cognition protocols {hatcher-proxy, hermes-local}: their replies are trusted
 *     to carry structured in-world action tags. This is the `[ACTION:]` parity the
 *     slice grants beyond Hatcher.
 *   - `proximityGateExempt` — exempt from the "must physically walk NEAR the
 *     target to talk" anti-abuse gate. TRUE only for {hatcher-proxy}: Hatcher's
 *     `talk` is contract-locked (§3a manual + PROTOCOL_VERSION + harness), so it
 *     is trusted to converse without a proximity walk. Every hosted harness
 *     (hermes-local, any future hosted protocol) STAYS GATED — it must walk to
 *     talk, preserving the anti-abuse backbone. Widening this to a hosted protocol
 *     would be an anti-abuse regression, so it is intentionally hatcher-only.
 *
 * BYO gateways (openai-compat / anthropic / custom-webhook) get NEITHER — they are
 * not server-hosted; this slice does not change their in-world behavior.
 *
 * HOSTED-OPENCLAW follow-up: once the deferred local-inference flip stands up a
 * server-hosted OpenClaw in-world cognition protocol, it routes through that
 * hosted protocol and gets `[ACTION:]` parity by adding ONE entry here with
 * `emitsInWorldActions:true` (and staying `proximityGateExempt:false` unless
 * contract-locked). No predicate rewrite — the generalization already reads this
 * table. There is intentionally NO fake 'openclaw-local' protocol today.
 */
interface ProtocolCapabilities {
  /** Reply is parsed for in-world `[ACTION:]` tags and dispatched. */
  emitsInWorldActions: boolean;
  /** Exempt from the walk-near-to-talk anti-abuse proximity gate. */
  proximityGateExempt: boolean;
}

const PROTOCOL_CAPABILITIES: Readonly<Record<InWorldWireProtocol, ProtocolCapabilities>> = {
  // Server-hosted cognition — emits [ACTION:]; Hatcher additionally proximity-exempt
  // (contract-locked talk).
  'hatcher-proxy':  { emitsInWorldActions: true,  proximityGateExempt: true },
  // Server-hosted local runtime (D7) — emits [ACTION:] but STAYS proximity-gated.
  'hermes-local':   { emitsInWorldActions: true,  proximityGateExempt: false },
  // Server-hosted local runtime (D-openclaw, 2026-07-08) — the hosted-OpenClaw
  // mirror of hermes-local: emits [ACTION:] but STAYS proximity-gated. The
  // proximity-gate exemption stays Hatcher-ONLY (contract-locked talk); widening
  // it to any hosted harness would be an anti-abuse regression.
  'openclaw-local': { emitsInWorldActions: true,  proximityGateExempt: false },
  // Fail-soft stub — no reply, no action, no exemption.
  'nanoclaw':       { emitsInWorldActions: false, proximityGateExempt: false },
  // BYO gateways — not server-hosted; unchanged in-world behavior.
  'openai-compat':  { emitsInWorldActions: false, proximityGateExempt: false },
  'anthropic':      { emitsInWorldActions: false, proximityGateExempt: false },
  'custom-webhook': { emitsInWorldActions: false, proximityGateExempt: false },
};

/**
 * TRUE iff a body speaking `protocol` should have its reply parsed for in-world
 * `[ACTION:]` tags. Server-hosted-cognition protocols only ({hatcher-proxy,
 * hermes-local}). FAIL-CLOSED: unknown / undefined / '' → false (never grant
 * `[ACTION:]` parsing to an unrecognized protocol). `Object.hasOwn` (not `in`) so
 * a prototype-key protocol string cannot bypass into an inherited value.
 */
export function protocolEmitsInWorldActions(protocol?: string | null): boolean {
  return protocol != null && Object.hasOwn(PROTOCOL_CAPABILITIES, protocol)
    ? PROTOCOL_CAPABILITIES[protocol as InWorldWireProtocol].emitsInWorldActions
    : false;
}

/**
 * TRUE iff a body speaking `protocol` is EXEMPT from the walk-near-to-talk
 * anti-abuse proximity gate. Hatcher-only ({hatcher-proxy}) — its talk is
 * contract-locked. FAIL-CLOSED: unknown / undefined / '' → false → the gate
 * APPLIES (the exact prior fail-closed behavior: an unresolvable body has no
 * hatcher-proxy client → gated).
 */
export function protocolProximityGateExempt(protocol?: string | null): boolean {
  return protocol != null && Object.hasOwn(PROTOCOL_CAPABILITIES, protocol)
    ? PROTOCOL_CAPABILITIES[protocol as InWorldWireProtocol].proximityGateExempt
    : false;
}

/**
 * "Does ClawVille server-host this identity's NATIVE cognition runtime?" —
 * connect-namespace (openclaw_bots identityType) semantics ONLY:
 *   - milady → always (server-side Eliza runs end-to-end).
 *   - hermes → ONLY when the host-it-for-me local runtime is enabled
 *     (HERMES_LOCAL_GATEWAY_ENABLED → the hermes-local wire); otherwise a
 *     connect-namespace hermes identity is a self-managed BYO pull agent whose
 *     true liveness comes from the openclaw_bots lastSeenAt path.
 *   - everything else (incl. unknown harness / '' ) → false (fail-closed).
 *
 * ⚠️ NOT WIRED to `/me/agent-session`, and deliberately so (commit e1b78a49,
 * P3 slice 6): that route's "hosted" branch describes AVATAR-agents, whose
 * hosting is a property of the platform_agents row (harness-agnostic ElizaOS
 * runtime via agent-orchestrator) — gating it on this helper would falsely
 * demote working hosted hermes-HARNESS avatars behind a disabled env flag.
 * auth.ts `HOSTED_HARNESSES` is the authoritative avatar-namespace predicate.
 * This helper currently has NO production call site (tests pin its contract);
 * it exists as the gate for future host-it-for-me UI in the connect namespace.
 * If you are about to wire it somewhere, first decide which namespace your
 * caller is in — avatar (platform_agents) or connect (openclaw_bots).
 *
 * @param hermesLocalEnabled test seam for the D7 gate — defaults to the boot-time
 *   `HERMES_LOCAL_GATEWAY_ENABLED` env read (matches how the deploy sets env
 *   per-box). Consulted ONLY on the hermes branch.
 */
export function isHostedHarness(
  harness: string,
  hermesLocalEnabled: boolean = HERMES_LOCAL_GATEWAY_ENABLED,
): boolean {
  const hosted = getIdentityAdapter(harness).hosted;
  if (hosted === 'always') return true;
  if (hosted === 'hermes-gated') return hermesLocalEnabled;
  return false; // 'never' + the fail-closed default adapter
}

/** Inputs common to avatar + override config assembly. */
export interface AgentConfigBase {
  agentId: string;
  sessionId: string;
  identityType: string;
  /** The protocol persisted on the row (or the request's wireProtocol on mint). */
  storedProtocol?: string | null;
  /** Real outbound gateway URL (openclaw/custom). Dummy for the rest. */
  gatewayUrl?: string | null;
  /** Outbound auth token — only the real-gateway mint path has it; '' elsewhere. */
  authToken?: string | null;
  autonomyMode?: AgentAutonomyMode | null;
  ledgerCapable: boolean;
  boundUserId: string | null;
  /** Bound avatar for internal covenant attribution; never part of agent wire. */
  avatarId?: string;
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

/**
 * TRUE iff `gatewayUrl` is a REAL declared outbound gateway (not absent, empty,
 * or the `http://localhost:0` dummy the no-gateway/hosted paths default to). The
 * load-bearing precedence signal for the hosted-OpenClaw gate: a gateway-less
 * openclaw connect is the ClawVille-hosted case; a BYO openclaw that declared its
 * own gateway must stay byte-identical under both gate states.
 */
export function hasRealDeclaredGateway(gatewayUrl?: string | null): boolean {
  return gatewayUrl != null && gatewayUrl !== '' && gatewayUrl !== 'http://localhost:0';
}

/** The wire-protocol decision, shared by avatar + override assembly. Threads the
 *  gateway signal so the hosted-OpenClaw gate captures ONLY gateway-less openclaw
 *  connects (mint and restore both flow through the builders → this). */
function pickProtocol(base: AgentConfigBase): InWorldWireProtocol {
  if (base.protocolOverride) return base.protocolOverride;
  return resolveInWorldProtocol(base.identityType, base.storedProtocol, HERMES_LOCAL_GATEWAY_ENABLED, {
    enabled: OPENCLAW_LOCAL_GATEWAY_ENABLED,
    hasDeclaredGateway: hasRealDeclaredGateway(base.gatewayUrl),
  });
}

/**
 * Assemble the in-world `AgentSubstrateRegistration` for an AVATAR-mode agent. The
 * SINGLE place protocol + species + autonomy + dummy-gateway defaults are
 * decided, so mint and restore produce byte-identical spawn-relevant config.
 */
export function buildAvatarSessionConfig(
  inputs: AvatarConfigInputs,
): AgentSubstrateRegistration {
  const protocol = pickProtocol(inputs);
  return {
    agentId: inputs.agentId,
    sessionId: inputs.sessionId,
    sessionKey: inputs.sessionId,
    // No-gateway / hatcher bodies never POST to this; real-gateway bodies use
    // the row's gatewayUrl. Dummy default matches the mint paths verbatim.
    gatewayUrl: inputs.gatewayUrl ?? 'http://localhost:0',
    authToken: inputs.authToken ?? '',
    // Narrow-cast: 'hermes-local' / 'openclaw-local' are the server-internal
    // widenings (see InWorldWireProtocol) — the shared registration type stays on
    // the partner-protected AgentWireProtocol union; AgentSubstrateClient re-widens
    // on read.
    protocol: protocol as AgentWireProtocol,
    mode: 'avatar',
    autonomyMode: resolveAutonomyMode(
      inputs.identityType,
      inputs.storedProtocol,
      inputs.autonomyMode,
      hasRealDeclaredGateway(inputs.gatewayUrl),
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
    avatarId: inputs.avatarId,
  } as AgentSubstrateRegistration;
}

/**
 * Assemble the in-world `AgentSubstrateRegistration` for an OVERRIDE-mode agent (an
 * agent possessing an existing roaming NPC). Same protocol/autonomy resolution
 * as the avatar path; no render fields (the possessed NPC keeps its own body).
 */
export function buildOverrideSessionConfig(
  inputs: OverrideConfigInputs,
): AgentSubstrateRegistration {
  const protocol = pickProtocol(inputs);
  return {
    agentId: inputs.agentId,
    sessionId: inputs.sessionId,
    sessionKey: inputs.sessionId,
    gatewayUrl: inputs.gatewayUrl ?? 'http://localhost:0',
    authToken: inputs.authToken ?? '',
    // Narrow-cast: same server-internal widening note as the avatar builder
    // ('hermes-local' / 'openclaw-local').
    protocol: protocol as AgentWireProtocol,
    mode: 'override',
    autonomyMode: resolveAutonomyMode(
      inputs.identityType,
      inputs.storedProtocol,
      inputs.autonomyMode,
      hasRealDeclaredGateway(inputs.gatewayUrl),
    ),
    targetNpcId: inputs.targetNpcId,
    ledgerCapable: inputs.ledgerCapable,
    boundUserId: inputs.boundUserId,
    avatarId: inputs.avatarId,
  } as AgentSubstrateRegistration;
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
 * (partner-hatcher.ts) and the RESTORE path (agent-session-restore.ts) can
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
 * Project an `AgentSubstrateRegistration` down to the spawn-relevant fields for the
 * drift assertion. Missing fields (e.g. `name` on an override config) come out
 * `undefined` on both sides, so deep-equality still holds.
 */
export function spawnRelevantProjection(
  config: AgentSubstrateRegistration,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SPAWN_RELEVANT_FIELDS) {
    out[k] = (config as unknown as Record<string, unknown>)[k];
  }
  return out;
}
