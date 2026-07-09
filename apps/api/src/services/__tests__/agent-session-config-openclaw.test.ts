/**
 * Hosted-OpenClaw host-it-for-me semantics (D-openclaw, shared-inference
 * onboarding 2026-07-08) — DB-free unit suite for the 'openclaw-local' additions
 * to the shared pure config module (`agent-session-config.ts`), plus the
 * HATCHER- and HERMES-INERTNESS pins (that module is on the partner-protected
 * surface, so every openclaw change must be provably inert for hatcher rows AND
 * must not disturb the sibling hermes gate).
 *
 * The single load-bearing precedence this suite exists to pin:
 *   a BYO openclaw agent WITH a declared gateway keeps its declared HTTP protocol
 *   byte-identically under BOTH gate states — ONLY a GATEWAY-LESS openclaw connect
 *   is captured by the hosted path.
 *
 * What is pinned here:
 *   1. Wire derivation: GATEWAY-LESS 'openclaw' → 'openai-compat' when the gate is
 *      OFF, 'openclaw-local' when ON; a BYO 'openclaw' WITH a gateway → its
 *      declared protocol in BOTH states; ironclaw/custom NEVER touched. Decided by
 *      the AUTHORITATIVE identityType + gateway signal (never the stored `protocol`
 *      column alone), gate exercised through the explicit test-seam parameter (no
 *      process.env mutation — the module reads the env ONCE at boot by design).
 *   2. The gate never leaks 'openclaw-local' to any other identity type.
 *   3. Builders: a gateway-less openclaw avatar/override config derives the gated
 *      wire; mint ≡ restore on the spawn-relevant fields.
 *   4. Autonomy: openclaw stays SERVER-managed (unlike hermes/nanoclaw) in both
 *      gate states — the hosted brain is server-driven, not a self-pull agent.
 *   5. Capabilities: 'openclaw-local' emits [ACTION:] but stays proximity-GATED
 *      (the exemption is Hatcher-only).
 *   6. Hatcher inertness: 'hatcher' derivation/restorability/species are
 *      byte-identical whichever way the openclaw gate points.
 *   7. Hermes inertness: the hermes gate is untouched by the openclaw gate.
 *   8. The host-it-for-me URL is the HARDCODED localhost:8643 constant (SSRF
 *      stance: server-side, never caller-suppliable — fails the moment someone
 *      makes it configurable).
 *
 * Pure — no DB, no sim, no network, no env mutation. Run:
 *   bun test agent-session-config-openclaw
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_HATCHER_MODEL_KEY,
} from '@clawville/shared';
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
  resolveInWorldProtocol,
  resolveAgentSpecies,
  resolveAutonomyMode,
  spawnRelevantProjection,
  isRowRestorableFromIdentity,
  isSessionRestorable,
  protocolEmitsInWorldActions,
  protocolProximityGateExempt,
  OPENCLAW_LOCAL_GATEWAY_URL,
  type AvatarConfigInputs,
  type OverrideConfigInputs,
} from '../agent-session-config';

/**
 * The module-level gate value the BUILDERS resolve with (they take no gate param —
 * they read the boot-time const). Re-derived here from the same env expression so
 * builder-level expectations stay correct whether or not the test runner's
 * environment carries OPENCLAW_LOCAL_GATEWAY_ENABLED (normally it does not).
 */
const ENV_GATE = process.env.OPENCLAW_LOCAL_GATEWAY_ENABLED === 'true';
/** Expected builder wire for a GATEWAY-LESS openclaw at the boot-time env gate. */
const ENV_EXPECTED_GATELESS_WIRE = ENV_GATE ? 'openclaw-local' : 'openai-compat';

/** A real BYO gateway url the way /connect would carry it. */
const BYO_GATEWAY = 'https://byo.example.com/gateway';
/** The dummy no-gateway default the builders fall back to. */
const DUMMY_GATEWAY = 'http://localhost:0';

// ---------------------------------------------------------------------------
// 1. Wire derivation — identity + gateway authoritative, gate-decided.
// ---------------------------------------------------------------------------
describe('resolveInWorldProtocol — openclaw host-it-for-me gate', () => {
  test('GATEWAY-LESS openclaw, gate OFF → openai-compat (legacy declared-gateway default)', () => {
    // No opts bag → legacy behaviour (byte-identical to pre-feature).
    expect(resolveInWorldProtocol('openclaw', 'openai-compat')).toBe('openai-compat');
    // Explicit opts, gate off, no declared gateway → still legacy.
    expect(
      resolveInWorldProtocol('openclaw', 'openai-compat', false, { enabled: false, hasDeclaredGateway: false }),
    ).toBe('openai-compat');
    // A missing/null stored protocol still defaults to openai-compat.
    expect(
      resolveInWorldProtocol('openclaw', null, false, { enabled: false, hasDeclaredGateway: false }),
    ).toBe('openai-compat');
  });

  test('GATEWAY-LESS openclaw, gate ON → openclaw-local (the hosted path)', () => {
    for (const stored of ['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw', null, undefined] as const) {
      expect(
        resolveInWorldProtocol('openclaw', stored, false, { enabled: true, hasDeclaredGateway: false }),
      ).toBe('openclaw-local');
    }
  });

  test('BYO openclaw WITH a declared gateway → declared protocol under BOTH gate states (the precedence pin)', () => {
    // gate OFF
    expect(
      resolveInWorldProtocol('openclaw', 'openai-compat', false, { enabled: false, hasDeclaredGateway: true }),
    ).toBe('openai-compat');
    // gate ON — the hosted path must NOT capture a real-gateway agent.
    expect(
      resolveInWorldProtocol('openclaw', 'openai-compat', false, { enabled: true, hasDeclaredGateway: true }),
    ).toBe('openai-compat');
    // BYO openclaw declaring anthropic / custom-webhook keeps them under ON too.
    expect(
      resolveInWorldProtocol('openclaw', 'anthropic', false, { enabled: true, hasDeclaredGateway: true }),
    ).toBe('anthropic');
    expect(
      resolveInWorldProtocol('openclaw', 'custom-webhook', false, { enabled: true, hasDeclaredGateway: true }),
    ).toBe('custom-webhook');
  });

  test('FAIL-SAFE: opts bag with the gate ON but NO gateway signal → declared (never hosted)', () => {
    // hasDeclaredGateway omitted defaults TRUE, so a caller that opts in but
    // forgets the signal can never mis-route a BYO agent to the hosted runtime.
    expect(
      resolveInWorldProtocol('openclaw', 'openai-compat', false, { enabled: true }),
    ).toBe('openai-compat');
  });

  test('the gate NEVER leaks openclaw-local to any other identity type', () => {
    // ironclaw/custom are declared-gateway, NOT openclaw-gated — untouched even
    // with the openclaw opts forced ON + gateway-less.
    expect(
      resolveInWorldProtocol('ironclaw', 'anthropic', false, { enabled: true, hasDeclaredGateway: false }),
    ).toBe('anthropic');
    expect(
      resolveInWorldProtocol('custom', 'custom-webhook', false, { enabled: true, hasDeclaredGateway: false }),
    ).toBe('custom-webhook');
    // No-gateway siblings stay fail-soft nanoclaw.
    for (const t of ['anonymous', 'milady', 'nanoclaw']) {
      expect(
        resolveInWorldProtocol(t, 'openai-compat', false, { enabled: true, hasDeclaredGateway: false }),
      ).toBe('nanoclaw');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Restorability — openclaw STAYS the non-restorable real-gateway class.
// ---------------------------------------------------------------------------
describe('openclaw restorability — unchanged (fail-safe reconnect)', () => {
  test('isRowRestorableFromIdentity(openclaw) → false (BYO auth_token never persisted)', () => {
    expect(isRowRestorableFromIdentity('openclaw')).toBe(false);
  });

  test('isSessionRestorable(openclaw, *) → false for any non-hatcher-proxy stored column', () => {
    expect(isSessionRestorable('openclaw', 'openai-compat')).toBe(false);
    expect(isSessionRestorable('openclaw', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Builders — the gated wire + mint ≡ restore for a gateway-less openclaw.
// ---------------------------------------------------------------------------
const STATS = { hp: 100, attack: 10, defense: 8, speed: 6 };

/** A GATEWAY-LESS openclaw AVATAR input the way the /connect MINT path assembles it. */
function gatelessOpenclawAvatar(): AvatarConfigInputs {
  return {
    mode: 'avatar',
    agentId: 'agent-openclaw',
    sessionId: 'sess-mint',
    identityType: 'openclaw',
    storedProtocol: 'openai-compat',
    gatewayUrl: undefined, // NO caller-supplied gateway → the hosted case
    authToken: undefined,
    autonomyMode: 'server-managed',
    name: 'Clawy',
    species: null,
    color: 0x33cc88,
    stats: STATS,
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'curious',
    ledgerCapable: false,
    boundUserId: null,
  };
}

describe('openclaw builders — gated wire + mint ≡ restore (gateway-less)', () => {
  test('AVATAR: gateway-less openclaw derives the boot-gate wire; dummy gateway; empty authToken', () => {
    const cfg = buildAvatarSessionConfig(gatelessOpenclawAvatar());
    const c = cfg as unknown as Record<string, unknown>;
    expect(['openai-compat', 'openclaw-local']).toContain(c.protocol as string);
    expect(c.protocol).toBe(ENV_EXPECTED_GATELESS_WIRE as never);
    expect(c.gatewayUrl).toBe(DUMMY_GATEWAY);
    expect(c.authToken).toBe('');
    // openclaw is a plain (non-hatcher) identity → default render model.
    expect(c.species).toBe(DEFAULT_AGENT_MODEL_KEY);
    // Server-managed (the hosted brain is server-driven), NOT self-managed.
    expect(c.autonomyMode).toBe('server-managed');
  });

  test('AVATAR: mint ≡ restore on spawn-relevant fields (gateway-less openclaw)', () => {
    const mintCfg = buildAvatarSessionConfig(gatelessOpenclawAvatar());
    const restoreCfg = buildAvatarSessionConfig({ ...gatelessOpenclawAvatar(), sessionId: 'sess-restore' });
    expect(spawnRelevantProjection(restoreCfg)).toEqual(spawnRelevantProjection(mintCfg));
  });

  test('AVATAR: a BYO openclaw WITH a gateway keeps its declared protocol (unchanged) + real gateway', () => {
    const byo = buildAvatarSessionConfig({ ...gatelessOpenclawAvatar(), gatewayUrl: BYO_GATEWAY, storedProtocol: 'anthropic' });
    const c = byo as unknown as Record<string, unknown>;
    // Regardless of the boot gate, a real-gateway openclaw honors its declared
    // protocol and keeps its real gateway url.
    expect(c.protocol).toBe('anthropic');
    expect(c.gatewayUrl).toBe(BYO_GATEWAY);
  });

  test('OVERRIDE: gateway-less openclaw derives the boot-gate wire + mint ≡ restore', () => {
    const base: OverrideConfigInputs = {
      mode: 'override',
      agentId: 'agent-openclaw',
      sessionId: 'sess-mint',
      identityType: 'openclaw',
      storedProtocol: 'openai-compat',
      gatewayUrl: undefined,
      autonomyMode: 'server-managed',
      targetNpcId: 'npc-aria',
      ledgerCapable: false,
      boundUserId: null,
    };
    const mintCfg = buildOverrideSessionConfig(base);
    const restoreCfg = buildOverrideSessionConfig({ ...base, sessionId: 'sess-restore' });
    expect((mintCfg as unknown as Record<string, unknown>).protocol).toBe(ENV_EXPECTED_GATELESS_WIRE as never);
    expect(spawnRelevantProjection(restoreCfg)).toEqual(spawnRelevantProjection(mintCfg));
  });
});

// ---------------------------------------------------------------------------
// 4. Autonomy — openclaw stays SERVER-managed in both gate states.
// ---------------------------------------------------------------------------
describe('resolveAutonomyMode — openclaw stays server-managed', () => {
  test('openclaw honors the requested/default mode (NOT forced self-managed like hermes)', () => {
    expect(resolveAutonomyMode('openclaw', 'openai-compat')).toBe('server-managed');
    expect(resolveAutonomyMode('openclaw', 'openai-compat', 'server-managed')).toBe('server-managed');
    // The orthogonal stored-'nanoclaw' override still forces self-managed (unchanged).
    expect(resolveAutonomyMode('openclaw', 'nanoclaw')).toBe('self-managed');
  });
});

// ---------------------------------------------------------------------------
// 5. Capabilities — openclaw-local emits [ACTION:] but stays proximity-gated.
// ---------------------------------------------------------------------------
describe('PROTOCOL_CAPABILITIES — openclaw-local', () => {
  test('emits in-world [ACTION:] (like hermes-local + hatcher-proxy)', () => {
    expect(protocolEmitsInWorldActions('openclaw-local')).toBe(true);
  });

  test('is NOT proximity-gate exempt (exemption is Hatcher-only, anti-abuse backbone)', () => {
    expect(protocolProximityGateExempt('openclaw-local')).toBe(false);
    // Contrast: hatcher-proxy IS exempt; hermes-local is NOT.
    expect(protocolProximityGateExempt('hatcher-proxy')).toBe(true);
    expect(protocolProximityGateExempt('hermes-local')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. HATCHER INERTNESS — the protected-surface pin. Every hatcher resolution is
// byte-identical whichever way the openclaw gate points.
// ---------------------------------------------------------------------------
describe('hatcher inertness — openclaw gate cannot touch hatcher derivation', () => {
  test('hatcher wire protocol is hatcher-proxy regardless of the openclaw opts', () => {
    expect(resolveInWorldProtocol('hatcher', 'hatcher-proxy', false, { enabled: false, hasDeclaredGateway: false })).toBe('hatcher-proxy');
    expect(resolveInWorldProtocol('hatcher', 'hatcher-proxy', false, { enabled: true, hasDeclaredGateway: false })).toBe('hatcher-proxy');
    expect(resolveInWorldProtocol('hatcher', 'hatcher-proxy', true, { enabled: true, hasDeclaredGateway: true })).toBe('hatcher-proxy');
    // Even with a mislabeled stored column (identity is authoritative).
    expect(resolveInWorldProtocol('hatcher', 'openai-compat', false, { enabled: true, hasDeclaredGateway: false })).toBe('hatcher-proxy');
  });

  test('hatcher restorability + species fallback unchanged', () => {
    expect(isRowRestorableFromIdentity('hatcher')).toBe(false);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy')).toBe(true);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', false)).toBe(false);
    expect(resolveAgentSpecies('hatcher', null)).toBe(DEFAULT_HATCHER_MODEL_KEY);
    // An openclaw agent requesting a reserved hatcher render model is coerced.
    expect(resolveAgentSpecies('openclaw', DEFAULT_HATCHER_MODEL_KEY)).toBe(DEFAULT_AGENT_MODEL_KEY);
  });

  test('hatcher-proxy capabilities unchanged (emits + proximity-exempt)', () => {
    expect(protocolEmitsInWorldActions('hatcher-proxy')).toBe(true);
    expect(protocolProximityGateExempt('hatcher-proxy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. HERMES INERTNESS — the sibling gate is untouched by the openclaw gate.
// ---------------------------------------------------------------------------
describe('hermes inertness — openclaw gate cannot touch hermes derivation', () => {
  test('hermes still resolves by ITS OWN gate (3rd param), never the openclaw opts', () => {
    // hermes gate OFF → nanoclaw even with the openclaw opts forced ON.
    expect(resolveInWorldProtocol('hermes', 'openai-compat', false, { enabled: true, hasDeclaredGateway: false })).toBe('nanoclaw');
    // hermes gate ON → hermes-local even with the openclaw opts forced OFF.
    expect(resolveInWorldProtocol('hermes', 'openai-compat', true, { enabled: false, hasDeclaredGateway: true })).toBe('hermes-local');
  });
});

// ---------------------------------------------------------------------------
// 8. The hardcoded host-it-for-me target — SSRF-stance tripwire.
// ---------------------------------------------------------------------------
describe('OPENCLAW_LOCAL_GATEWAY_URL — hardcoded server-side constant', () => {
  test('is exactly the documented localhost:8643 (never env/caller-derived)', () => {
    expect(OPENCLAW_LOCAL_GATEWAY_URL).toBe('http://localhost:8643');
  });
});
