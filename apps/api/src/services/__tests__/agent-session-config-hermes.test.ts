/**
 * Hermes identity semantics (D7, magic-link onboarding 2026-07-02) — DB-free
 * unit suite for the 'hermes' additions to the shared pure config module
 * (`agent-session-config.ts`), plus the HATCHER-INERTNESS pins (that module is
 * on the partner-protected surface, so every hermes change must be provably
 * inert for hatcher rows).
 *
 * What is pinned here:
 *   1. Wire derivation: 'hermes' → 'nanoclaw' when the host-it-for-me gate is
 *      OFF, 'hermes-local' when ON — decided by the AUTHORITATIVE identityType
 *      (never the stored `protocol` column, the D1-fix pattern), with the gate
 *      exercised through the explicit test-seam parameter (no process.env
 *      mutation — the module reads the env ONCE at boot by design).
 *   2. Restorability: hermes ∈ NO_GATEWAY → restorable from the row alone
 *      (`isRowRestorableFromFacts` / `isSessionRestorable`), because the row
 *      carries no caller gateway and no secrets for it.
 *   3. Restore re-derivation: a hermes row whose stored column mislabels the
 *      protocol as a gateway-POSTing one still rebuilds fail-soft (the 502
 *      guard), and mint ≡ restore on the spawn-relevant fields.
 *   4. Autonomy: hermes is ALWAYS self-managed (it pull-drives via our REST),
 *      in both gate states, even against an explicit server-managed request.
 *   5. Hatcher inertness: 'hatcher' derivation, restorability, and species
 *      fallback are byte-identical regardless of the hermes gate.
 *   6. The host-it-for-me URL is the HARDCODED localhost constant (SSRF stance:
 *      server-side constant, never caller-suppliable — this test fails the
 *      moment someone makes it configurable).
 *
 * Pure — no DB, no sim, no network, no env mutation. Run:
 *   bun test agent-session-config-hermes
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
  isRowRestorableFromFacts,
  isSessionRestorable,
  HERMES_LOCAL_GATEWAY_URL,
  type AvatarConfigInputs,
  type OverrideConfigInputs,
} from '../agent-session-config';

/**
 * The module-level gate value the BUILDERS resolve with (they take no param —
 * they read the boot-time const). Re-derived here from the same env expression
 * so builder-level expectations stay correct whether or not the test runner's
 * environment carries HERMES_LOCAL_GATEWAY_ENABLED (normally it does not).
 */
const ENV_GATE = process.env.HERMES_LOCAL_GATEWAY_ENABLED === 'true';
const ENV_EXPECTED_WIRE = ENV_GATE ? 'hermes-local' : 'nanoclaw';

/** Every stored-protocol mislabel a legacy/foreign row could carry. */
const MISLABELED_STORED = ['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw', null, undefined] as const;

// ---------------------------------------------------------------------------
// 1. Wire derivation — identity-authoritative, gate-decided.
// ---------------------------------------------------------------------------
describe('resolveInWorldProtocol — hermes host-it-for-me gate', () => {
  test('gate OFF → nanoclaw (fail-soft pull), for EVERY stored-protocol mislabel', () => {
    for (const stored of MISLABELED_STORED) {
      expect(resolveInWorldProtocol('hermes', stored, false)).toBe('nanoclaw');
    }
  });

  test('gate ON → hermes-local, for EVERY stored-protocol mislabel', () => {
    for (const stored of MISLABELED_STORED.filter((value) => value !== 'nanoclaw')) {
      expect(resolveInWorldProtocol('hermes', stored, true)).toBe('hermes-local');
    }
    expect(resolveInWorldProtocol('hermes', 'nanoclaw', true)).toBe('nanoclaw');
  });

  test('omitted gate param falls back to the boot-time env const', () => {
    expect(resolveInWorldProtocol('hermes', 'openai-compat')).toBe(ENV_EXPECTED_WIRE as never);
  });

  test('the gate NEVER leaks hermes-local to any other identity type', () => {
    // Milady stays on the fail-soft internal wire with the Hermes gate forced ON.
    expect(resolveInWorldProtocol('milady', 'openai-compat', true)).toBe('nanoclaw');
    // …and real-gateway types keep honoring their declared protocol.
    expect(resolveInWorldProtocol('openclaw', 'openai-compat', true)).toBe('openai-compat');
    expect(resolveInWorldProtocol('custom', 'custom-webhook', true)).toBe('custom-webhook');
  });
});

// ---------------------------------------------------------------------------
// 2. Restorability — Hermes is a supported restorable no-gateway class.
// ---------------------------------------------------------------------------
describe('hermes restorability — NO_GATEWAY membership', () => {
  test('isRowRestorableFromFacts(hermes) → true (no secrets on the row)', () => {
    expect(isRowRestorableFromFacts('hermes', null)).toBe(true);
    expect(isRowRestorableFromFacts(
      'hermes',
      'https://stale-ignored.example/gateway',
      undefined,
      'openai-compat',
    )).toBe(true);
  });

  test('isSessionRestorable(hermes, *) → true for any non-hatcher-proxy stored column', () => {
    expect(isSessionRestorable('hermes', 'nanoclaw')).toBe(true);
    expect(isSessionRestorable('hermes', 'openai-compat')).toBe(true);
    expect(isSessionRestorable('hermes', null)).toBe(true);
  });

  test('the hatcher-proxy presence flag is IGNORED for hermes rows', () => {
    expect(isSessionRestorable('hermes', 'nanoclaw', false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Restore re-derivation + the 502 guard + mint ≡ restore.
// ---------------------------------------------------------------------------
const STATS = { hp: 100, attack: 10, defense: 8, speed: 6 };

/** A hermes AVATAR input the way the /connect MINT path assembles it. */
function hermesMintAvatar(): AvatarConfigInputs {
  return {
    mode: 'avatar',
    agentId: 'agent-hermes',
    sessionId: 'sess-mint',
    identityType: 'hermes',
    // The row's stored column is a meaningless legacy default for hermes —
    // derivation must ignore it (the D1 pattern).
    storedProtocol: 'openai-compat',
    gatewayUrl: undefined, // NO caller-supplied gateway, ever
    authToken: undefined,
    autonomyMode: 'self-managed',
    name: 'Hermey',
    species: null,
    color: 0x4488ff,
    stats: STATS,
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'curious',
    ledgerCapable: false,
    boundUserId: null,
  };
}

/** The same row rebuilt by RESTORE (different bearer; no authToken — not on the row). */
function hermesRestoreAvatar(): AvatarConfigInputs {
  return { ...hermesMintAvatar(), sessionId: 'sess-restore', authToken: undefined };
}

describe('hermes builders — 502 guard + mint ≡ restore', () => {
  test('AVATAR: never a gateway-POSTing protocol; dummy gateway; empty authToken', () => {
    const cfg = buildAvatarSessionConfig(hermesMintAvatar());
    const c = cfg as unknown as Record<string, unknown>;
    // Gate-state-agnostic invariant: BOTH derivations are fail-soft non-gateway.
    expect(['nanoclaw', 'hermes-local']).toContain(c.protocol as string);
    // Gate-state-exact: matches the boot-time env const the builder resolves with.
    expect(c.protocol).toBe(ENV_EXPECTED_WIRE as never);
    expect(c.gatewayUrl).toBe('http://localhost:0');
    expect(c.authToken).toBe('');
    // Species fallback: hermes is a plain (non-hatcher) identity.
    expect(c.species).toBe(DEFAULT_AGENT_MODEL_KEY);
    expect(c.autonomyMode).toBe('self-managed');
  });

  test('AVATAR: mint ≡ restore on the spawn-relevant fields', () => {
    const mintCfg = buildAvatarSessionConfig(hermesMintAvatar());
    const restoreCfg = buildAvatarSessionConfig(hermesRestoreAvatar());
    expect(spawnRelevantProjection(restoreCfg)).toEqual(spawnRelevantProjection(mintCfg));
  });

  test('OVERRIDE: same derivation + mint ≡ restore', () => {
    const base: OverrideConfigInputs = {
      mode: 'override',
      agentId: 'agent-hermes',
      sessionId: 'sess-mint',
      identityType: 'hermes',
      storedProtocol: 'openai-compat',
      autonomyMode: 'self-managed',
      targetNpcId: 'npc-aria',
      ledgerCapable: false,
      boundUserId: null,
    };
    const mintCfg = buildOverrideSessionConfig(base);
    const restoreCfg = buildOverrideSessionConfig({ ...base, sessionId: 'sess-restore' });
    expect((mintCfg as unknown as Record<string, unknown>).protocol).toBe(ENV_EXPECTED_WIRE as never);
    expect(spawnRelevantProjection(restoreCfg)).toEqual(spawnRelevantProjection(mintCfg));
  });
});

// ---------------------------------------------------------------------------
// 4. Autonomy — hermes always self-managed (pull-drive), both gate states.
// ---------------------------------------------------------------------------
describe('resolveAutonomyMode — hermes is always self-managed', () => {
  test('forced self-managed even against an explicit server-managed request', () => {
    expect(resolveAutonomyMode('hermes', 'openai-compat')).toBe('self-managed');
    expect(resolveAutonomyMode('hermes', 'nanoclaw')).toBe('self-managed');
    expect(resolveAutonomyMode('hermes', 'openai-compat', 'server-managed')).toBe('self-managed');
  });
});

// ---------------------------------------------------------------------------
// 5. HATCHER INERTNESS — the protected-surface pin. Every hatcher resolution is
// byte-identical whichever way the hermes gate points.
// ---------------------------------------------------------------------------
describe('hatcher inertness — hermes gate cannot touch hatcher derivation', () => {
  test('hatcher wire protocol is hatcher-proxy under BOTH gate states', () => {
    expect(resolveInWorldProtocol('hatcher', 'hatcher-proxy', false)).toBe('hatcher-proxy');
    expect(resolveInWorldProtocol('hatcher', 'hatcher-proxy', true)).toBe('hatcher-proxy');
    // Even with a mislabeled stored column (identity is authoritative).
    expect(resolveInWorldProtocol('hatcher', 'openai-compat', true)).toBe('hatcher-proxy');
  });

  test('hatcher restorability rules unchanged (protocol-keyed, presence-refined)', () => {
    expect(isRowRestorableFromFacts('hatcher', null)).toBe(false); // separate restore branch
    expect(isSessionRestorable('hatcher', 'hatcher-proxy')).toBe(true);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', false)).toBe(false);
  });

  test('hatcher species fallback + reserved-model guard unchanged (hermes cannot claim hatcher VRMs)', () => {
    expect(resolveAgentSpecies('hatcher', null)).toBe(DEFAULT_HATCHER_MODEL_KEY);
    // A hermes agent requesting a reserved hatcher render model is coerced to
    // the default — the same single-chokepoint guard every non-hatcher identity
    // goes through.
    expect(resolveAgentSpecies('hermes', DEFAULT_HATCHER_MODEL_KEY)).toBe(DEFAULT_AGENT_MODEL_KEY);
    expect(resolveAgentSpecies('hermes', null)).toBe(DEFAULT_AGENT_MODEL_KEY);
  });
});

// ---------------------------------------------------------------------------
// 6. The hardcoded host-it-for-me target — SSRF-stance tripwire.
// ---------------------------------------------------------------------------
describe('HERMES_LOCAL_GATEWAY_URL — hardcoded server-side constant', () => {
  test('is exactly the documented localhost:8642 (never env/caller-derived)', () => {
    expect(HERMES_LOCAL_GATEWAY_URL).toBe('http://localhost:8642');
  });
});
