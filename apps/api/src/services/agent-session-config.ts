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
 * (`resolveInWorldProtocol` / `isRowRestorableFromIdentity` / `resolveAutonomyMode`
 * / `resolveAgentSpecies`, and `isSessionRestorable` via the first) cannot drift
 * on how a given identity is treated. STRICTLY BEHAVIOR-PRESERVING: every field
 * reproduces the exact prior branch — the mint↔restore drift regression test pins
 * this for every identity type.
 *
 * The NO-OUTBOUND-GATEWAY identities (`protocolKind:'fail-soft'` or
 * `'hermes-gated'`, `restorableFromRow:true`) — anonymous / milady / nanoclaw /
 * hermes — must NEVER be given an HTTP-POSTing client (openai-compat / anthropic
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
   *   - 'fail-soft'        → always 'nanoclaw' (no outbound gateway, no network).
   *   - 'declared-gateway' → the row's declared HTTP protocol (default
   *                          'openai-compat') — a REAL reachable gateway.
   */
  protocolKind: 'hatcher-proxy' | 'hermes-gated' | 'fail-soft' | 'declared-gateway';
  /**
   * Can the in-world body be rebuilt purely from the persisted openclaw_bots row
   * after an API restart? TRUE only for the no-outbound-gateway types (they
   * persist no secret auth_token, so the row is sufficient). Hatcher is FALSE
   * here — its restore is keyed on `protocol==='hatcher-proxy'` in a SEPARATE
   * branch (see `isSessionRestorable`), not on the identityType enum.
   */
  restorableFromRow: boolean;
  /**
   * This identity pull-drives itself (always self-managed) regardless of the
   * requested mode — the nanoclaw/hermes REST-poll agents. Every other identity
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
  // No-outbound-gateway one-off test agent, no brain.
  anonymous: { protocolKind: 'fail-soft',        restorableFromRow: true,  selfManaged: false, speciesFallback: 'default', hosted: 'never' },
  // Self-managed pull agent; already speaks 'nanoclaw' by design.
  nanoclaw:  { protocolKind: 'fail-soft',        restorableFromRow: true,  selfManaged: true,  speciesFallback: 'default', hosted: 'never' },
  // Self-managed pull agent; host-it-for-me gate upgrades its reactive cognition
  // to the server-hosted 'hermes-local' runtime (D7, 2026-07-02).
  hermes:    { protocolKind: 'hermes-gated',     restorableFromRow: true,  selfManaged: true,  speciesFallback: 'default', hosted: 'hermes-gated' },
  // Real-gateway harnesses: honor the declared HTTP protocol; auth_token never
  // persisted → NOT restorable from the row (restore returns null → reconnect).
  openclaw:  { protocolKind: 'declared-gateway', restorableFromRow: false, selfManaged: false, speciesFallback: 'default', hosted: 'never' },
  ironclaw:  { protocolKind: 'declared-gateway', restorableFromRow: false, selfManaged: false, speciesFallback: 'default', hosted: 'never' },
  custom:    { protocolKind: 'declared-gateway', restorableFromRow: false, selfManaged: false, speciesFallback: 'default', hosted: 'never' },
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
 * Boot-time gate for the 'hermes-local' upgrade. Read ONCE at module load (the
 * documented single env read of this module — matches how the deploy sets env
 * per-box); tests exercise both states via the explicit parameter on
 * `resolveInWorldProtocol`, never by mutating process.env.
 */
const HERMES_LOCAL_GATEWAY_ENABLED = process.env.HERMES_LOCAL_GATEWAY_ENABLED === 'true';

/**
 * The wire protocols an IN-WORLD body can actually speak — the shared
 * `AgentWireProtocol` union widened by exactly one SERVER-INTERNAL value:
 * 'hermes-local' (AgentSubstrateClient POSTs to `HERMES_LOCAL_GATEWAY_URL`).
 *
 * Why 'hermes-local' is NOT added to the shared union: `packages/shared/src/
 * types/agent-substrate.ts` is on the Hatcher partner-protected surface, and this value
 * never crosses a partner wire, is never caller-suppliable (the connect schema's
 * `protocol` field can't request it), and is never authoritative on the row (the
 * in-world protocol is RE-derived from `identityType` on both mint and restore —
 * the D1 pattern). It exists only between this module and AgentSubstrateClient, so it
 * stays a server-internal widening here.
 */
export type InWorldWireProtocol = AgentWireProtocol | 'hermes-local';

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
 *   - anonymous / milady / nanoclaw   → 'nanoclaw'       (fail-soft, no network)
 *   - openclaw / ironclaw / custom    → the agent's declared HTTP protocol
 *                                        (storedProtocol), defaulting to
 *                                        'openai-compat' — these have a REAL
 *                                        reachable gateway.
 *
 * Note: a real-gateway type whose gateway/auth can't be rebuilt from the row
 * (restore drops auth_token) is filtered out by the CALLER (restore returns null
 * for it) — this function only decides the protocol for a body that WILL spawn.
 *
 * @param hermesLocalEnabled test seam for the D7 gate — defaults to the
 *   boot-time `HERMES_LOCAL_GATEWAY_ENABLED` env read. Consulted ONLY on the
 *   'hermes' branch; every other identity type derives identically regardless
 *   (the hatcher-inertness test pins this).
 */
export function resolveInWorldProtocol(
  identityType: string,
  storedProtocol: string | null | undefined,
  hermesLocalEnabled: boolean = HERMES_LOCAL_GATEWAY_ENABLED,
): InWorldWireProtocol {
  const kind = getIdentityAdapter(identityType).protocolKind;
  if (kind === 'hatcher-proxy') return 'hatcher-proxy';
  // hermes: the host-it-for-me gate upgrades its fail-soft stub to the local
  // runtime client. (The registry keys hermes to 'hermes-gated' — never the
  // plain 'fail-soft' — so it can never fall through to the stub when enabled.)
  if (kind === 'hermes-gated') return hermesLocalEnabled ? 'hermes-local' : 'nanoclaw';
  if (kind === 'fail-soft') return 'nanoclaw';
  // 'declared-gateway' — a REAL reachable gateway: honor its declared protocol,
  // default openai-compat.
  return (storedProtocol as AgentWireProtocol) ?? 'openai-compat';
}

/**
 * Whether an agent's in-world body can be REBUILT purely from its persisted
 * openclaw_bots row after an API restart (the restore path), or must instead
 * degrade to "reconnect" (return null).
 *
 * RESTORABLE: only the NO-OUTBOUND-GATEWAY identity types (anonymous / milady /
 * nanoclaw / hermes). They speak a fail-soft protocol in-world ('nanoclaw', or
 * for hermes the equally fail-soft env-gated 'hermes-local' whose target is a
 * server-side constant — no secrets on the row either way), so the row carries
 * everything needed to rebuild them faithfully.
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
  return getIdentityAdapter(identityType).restorableFromRow;
}

/**
 * P0 D-2 — whether a surviving row's session self-heals after an API restart via
 * LAZY restore (`agent-session-restore.ts`) — i.e. its ORIGINAL bearer rebuilds
 * on the next call. The UNION of the two branches the restore module actually
 * implements, so `session-status` can't drift from restore:
 *   - hatcher (`protocol === 'hatcher-proxy'`): cognition rebuilt from the encrypted
 *     proxy token on the row (restore's hatcher branch — keyed on protocol, which is
 *     why `isRowRestorableFromIdentity('hatcher')` alone is FALSE and insufficient).
 *   - anonymous / milady / nanoclaw / hermes (`isRowRestorableFromIdentity`):
 *     rebuilt as a fail-soft body.
 * NOT restorable: the real-gateway identity types (openclaw / ironclaw / custom) —
 * the outbound `auth_token` is never persisted, so restore returns null and the
 * agent must `/reconnect`. So `session-status` reports needs-reconnect for a live-TTL
 * row with an empty RAM Map (post-restart) ONLY for these real-gateway types; every
 * self-healing type stays `connected:true` (no needless reconnect — preserves the
 * Hatcher partner's transparent post-restart recovery).
 *
 * MOSTLY TYPE-LEVEL by design (session-status ruling, 2026-07-01), with ONE cheap
 * row-level refinement (Codex P0 gate). The optional `hatcherProxyConfigPresent`
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
): boolean {
  if (protocol === 'hatcher-proxy') {
    // Self-heals via restore ONLY if the proxy config is present. Omitted param
    // (undefined) ⇒ type-level true (documented fail-safe); explicit false ⇒ the
    // row can't rebuild cognition, so tell the agent to reconnect.
    return hatcherProxyConfigPresent !== false;
  }
  return isRowRestorableFromIdentity(identityType);
}

/**
 * The autonomy mode an agent's body runs in, derived from identity + the
 * declared protocol. nanoclaw + hermes agents are always self-managed (they
 * pull-drive via our REST — for hermes that holds in BOTH gate states, since
 * 'hermes-local' only serves reactive/ambient cognition, never self-drive);
 * every other type is server-managed. Mirrors the mint-path resolution so
 * restore (and the regression test) agree.
 */
export function resolveAutonomyMode(
  identityType: string,
  storedProtocol: string | null | undefined,
  requested?: AgentAutonomyMode | null,
): AgentAutonomyMode {
  // The identity's own self-managed flag (nanoclaw/hermes) OR the orthogonal
  // row-level override (a stored 'nanoclaw' protocol on ANY identity) both force
  // self-managed — the exact prior disjunction.
  if (getIdentityAdapter(identityType).selfManaged || storedProtocol === 'nanoclaw') {
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
function pickProtocol(base: AgentConfigBase): InWorldWireProtocol {
  return base.protocolOverride ?? resolveInWorldProtocol(base.identityType, base.storedProtocol);
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
    // Narrow-cast: 'hermes-local' is the server-internal widening (see
    // InWorldWireProtocol) — the shared registration type stays on the
    // partner-protected AgentWireProtocol union; AgentSubstrateClient re-widens on read.
    protocol: protocol as AgentWireProtocol,
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
    // Narrow-cast: same server-internal widening note as the avatar builder.
    protocol: protocol as AgentWireProtocol,
    mode: 'override',
    autonomyMode: resolveAutonomyMode(
      inputs.identityType,
      inputs.storedProtocol,
      inputs.autonomyMode,
    ),
    targetNpcId: inputs.targetNpcId,
    ledgerCapable: inputs.ledgerCapable,
    boundUserId: inputs.boundUserId,
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
