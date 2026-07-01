/**
 * Regression test for the mint↔restore config-drift bug (diagnostic-2026-06-12
 * D1). This is the structural prevention the audits missed: it proves that for
 * EVERY identity type, the in-world `{config}` an agent is RESTORED with after an
 * API restart is byte-identical (on the spawn-relevant fields) to the `{config}`
 * it was originally MINTED with — built through the SAME shared pure builder
 * (`agent-session-config.ts`) the production mint paths and restore path both
 * call.
 *
 * The original bug: a restored `anonymous`/`milady` agent came back wired as an
 * OpenAI-compat gateway client (because restore read the row's stored
 * `'openai-compat'` protocol column verbatim) and 502'd on every autonomous NPC
 * conversation tick. The fix derives the in-world protocol from the
 * AUTHORITATIVE identity type, so no-gateway types always get the fail-soft
 * 'nanoclaw' client. These tests would have caught the regression: the
 * deep-equality + per-type protocol/species assertions fail the moment mint and
 * restore disagree.
 *
 * Pure — no DB, no sim, no network. Run: `bun test agent-session-config`.
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
  type AvatarConfigInputs,
  type OverrideConfigInputs,
} from '../agent-session-config';

// ---------------------------------------------------------------------------
// Identity-type matrix: how each type is PERSISTED on the openclaw_bots row and
// what the in-world body must speak. `protocolOverride` mirrors what the live
// mint/restore code passes (the hatcher path forces 'hatcher-proxy' because the
// public connect enum excludes 'hatcher').
// ---------------------------------------------------------------------------
interface MatrixRow {
  identityType: string;
  /** What gets PERSISTED in openclaw_bots.protocol on mint. */
  storedProtocol: string;
  /** What protocolOverride the live code passes (undefined for /connect types). */
  protocolOverride?: 'hatcher-proxy';
  /** The wire protocol the in-world body MUST end up speaking. */
  expectInWorldProtocol: string;
  /** A real outbound gateway URL — only the real-gateway types carry one. */
  gatewayUrl?: string;
  /** Expected species fallback when the row carries NO explicit species. */
  expectSpeciesFallback: string;
  /** Expected autonomy mode. */
  expectAutonomy: 'server-managed' | 'self-managed';
}

const MATRIX: MatrixRow[] = [
  // No-outbound-gateway types: MUST resolve to 'nanoclaw' (fail-soft, no POST).
  {
    identityType: 'anonymous',
    storedProtocol: 'openai-compat', // the meaningless default the row carries
    expectInWorldProtocol: 'nanoclaw',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
  {
    identityType: 'milady',
    storedProtocol: 'openai-compat',
    expectInWorldProtocol: 'nanoclaw',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
  {
    identityType: 'nanoclaw',
    storedProtocol: 'nanoclaw',
    expectInWorldProtocol: 'nanoclaw',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'self-managed',
  },
  // Real-gateway types: honor their declared HTTP protocol.
  {
    identityType: 'openclaw',
    storedProtocol: 'openai-compat',
    gatewayUrl: 'https://gw.example.com',
    expectInWorldProtocol: 'openai-compat',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
  {
    identityType: 'ironclaw',
    storedProtocol: 'anthropic',
    gatewayUrl: 'https://gw.example.com',
    expectInWorldProtocol: 'anthropic',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
  {
    identityType: 'custom',
    storedProtocol: 'custom-webhook',
    gatewayUrl: 'https://gw.example.com',
    expectInWorldProtocol: 'custom-webhook',
    expectSpeciesFallback: DEFAULT_AGENT_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
  // Hatcher: forced 'hatcher-proxy', hatcher species fallback.
  {
    identityType: 'hatcher',
    storedProtocol: 'hatcher-proxy',
    protocolOverride: 'hatcher-proxy',
    expectInWorldProtocol: 'hatcher-proxy',
    expectSpeciesFallback: DEFAULT_HATCHER_MODEL_KEY,
    expectAutonomy: 'server-managed',
  },
];

// ---------------------------------------------------------------------------
// Unit-level invariants: the three pure resolvers behave per the matrix.
// ---------------------------------------------------------------------------
describe('resolveInWorldProtocol — derives from identity, not stored column', () => {
  for (const row of MATRIX) {
    test(`${row.identityType} → ${row.expectInWorldProtocol}`, () => {
      // With no override (the /connect + restore inference path).
      if (!row.protocolOverride) {
        expect(resolveInWorldProtocol(row.identityType, row.storedProtocol)).toBe(
          row.expectInWorldProtocol as never,
        );
      }
    });
  }

  test('a no-gateway type NEVER yields a gateway-POSTing protocol', () => {
    for (const t of ['anonymous', 'milady', 'nanoclaw']) {
      // Even if the row mislabels the protocol as a POSTing one, identity wins.
      for (const stored of ['openai-compat', 'anthropic', 'custom-webhook']) {
        expect(resolveInWorldProtocol(t, stored)).toBe('nanoclaw');
      }
    }
  });
});

describe('isRowRestorableFromIdentity — #6 restore gate (identity, not gatewayUrl shape)', () => {
  test('no-gateway types ARE restorable from the row alone', () => {
    for (const t of ['anonymous', 'milady', 'nanoclaw']) {
      expect(isRowRestorableFromIdentity(t)).toBe(true);
    }
  });

  test('every real-gateway type is NOT restorable (auth_token never persisted)', () => {
    for (const t of ['openclaw', 'ironclaw', 'custom']) {
      expect(isRowRestorableFromIdentity(t)).toBe(false);
    }
  });

  test('THE #6 regression: a malformed legacy real-gateway row (null/dummy gatewayUrl) is still REFUSED', () => {
    // The bug: a legacy `openclaw`/`custom` row with protocol='openai-compat' and
    // a NULL/dummy gateway_url fell through the old `!!gatewayUrl && gatewayUrl !==
    // dummy` guard and restore built a mute body POSTing to http://localhost:0.
    // The predicate gates on IDENTITY TYPE, so the gatewayUrl shape is irrelevant:
    // these are refused regardless of what gateway_url holds.
    expect(isRowRestorableFromIdentity('openclaw')).toBe(false);
    expect(isRowRestorableFromIdentity('custom')).toBe(false);
    // An unknown/future identity type also fails closed (not in the no-gateway set).
    expect(isRowRestorableFromIdentity('some-future-framework')).toBe(false);
  });

  test('hatcher is NOT covered by this predicate (handled by a separate restore branch)', () => {
    // restore.ts keys the hatcher rebuild on protocol==='hatcher-proxy', not the
    // identityType enum (which excludes 'hatcher'); this predicate is consulted
    // only for the non-hatcher path, so it intentionally returns false here.
    expect(isRowRestorableFromIdentity('hatcher')).toBe(false);
  });
});

describe('resolveAgentSpecies — hatcher fallback is the hatcher default', () => {
  test('hatcher with null species → DEFAULT_HATCHER_MODEL_KEY', () => {
    expect(resolveAgentSpecies('hatcher', null)).toBe(DEFAULT_HATCHER_MODEL_KEY);
    expect(resolveAgentSpecies('hatcher', undefined)).toBe(DEFAULT_HATCHER_MODEL_KEY);
  });
  test('non-hatcher with null species → DEFAULT_AGENT_MODEL_KEY', () => {
    for (const t of ['anonymous', 'milady', 'nanoclaw', 'openclaw', 'custom']) {
      expect(resolveAgentSpecies(t, null)).toBe(DEFAULT_AGENT_MODEL_KEY);
    }
  });
  test('explicit species is passed through verbatim for every type', () => {
    for (const t of ['hatcher', 'anonymous', 'milady', 'openclaw']) {
      expect(resolveAgentSpecies(t, 'turtle')).toBe('turtle');
    }
  });
});

describe('resolveAutonomyMode', () => {
  test('nanoclaw is always self-managed', () => {
    expect(resolveAutonomyMode('nanoclaw', 'nanoclaw')).toBe('self-managed');
    expect(resolveAutonomyMode('nanoclaw', 'nanoclaw', 'server-managed')).toBe(
      'self-managed',
    );
  });
  test('everything else defaults server-managed, honors explicit request', () => {
    expect(resolveAutonomyMode('milady', 'openai-compat')).toBe('server-managed');
    expect(resolveAutonomyMode('openclaw', 'openai-compat', 'self-managed')).toBe(
      'self-managed',
    );
  });
});

// ---------------------------------------------------------------------------
// THE structural-prevention test: mint config ≡ restore config (spawn-relevant
// fields) for EVERY identity type, AVATAR + OVERRIDE mode.
// ---------------------------------------------------------------------------
const STATS = { hp: 100, attack: 10, defense: 8, speed: 6 };

/** Build the AVATAR config the way the live MINT path does. */
function mintAvatar(row: MatrixRow, species: string | null): AvatarConfigInputs {
  return {
    mode: 'avatar',
    agentId: `agent-${row.identityType}`,
    sessionId: 'sess-mint',
    identityType: row.identityType,
    storedProtocol: row.storedProtocol,
    gatewayUrl: row.gatewayUrl, // undefined for no-gateway types → dummy default
    authToken: row.gatewayUrl ? 'mint-token' : undefined,
    autonomyMode: row.expectAutonomy,
    name: 'Bodey',
    species,
    color: 0x4488ff,
    stats: STATS,
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'curious',
    ledgerCapable: false,
    boundUserId: null,
    protocolOverride: row.protocolOverride,
  };
}

/**
 * Build the AVATAR config the way RESTORE does — from the persisted ROW. The
 * restore path does NOT persist authToken (dropped), so a real-gateway type is
 * filtered out BEFORE this builder by the restore caller; for the no-gateway +
 * hatcher types (the ones that actually rebuild) the inputs come from the row.
 */
function restoreAvatarFromRow(
  row: MatrixRow,
  species: string | null,
): AvatarConfigInputs {
  return {
    mode: 'avatar',
    agentId: `agent-${row.identityType}`,
    sessionId: 'sess-restore', // DIFFERENT bearer by design — excluded from projection
    identityType: row.identityType,
    storedProtocol: row.storedProtocol,
    gatewayUrl: row.gatewayUrl,
    // authToken is NOT on the row → restore passes none (becomes '').
    autonomyMode: row.expectAutonomy,
    name: 'Bodey',
    species,
    color: 0x4488ff,
    stats: STATS,
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'curious',
    ledgerCapable: false,
    boundUserId: null,
    protocolOverride: row.protocolOverride,
  };
}

function mintOverride(row: MatrixRow): OverrideConfigInputs {
  return {
    mode: 'override',
    agentId: `agent-${row.identityType}`,
    sessionId: 'sess-mint',
    identityType: row.identityType,
    storedProtocol: row.storedProtocol,
    gatewayUrl: row.gatewayUrl,
    authToken: row.gatewayUrl ? 'mint-token' : undefined,
    autonomyMode: row.expectAutonomy,
    targetNpcId: 'npc-aria',
    ledgerCapable: false,
    boundUserId: null,
    protocolOverride: row.protocolOverride,
  };
}

function restoreOverrideFromRow(row: MatrixRow): OverrideConfigInputs {
  return {
    mode: 'override',
    agentId: `agent-${row.identityType}`,
    sessionId: 'sess-restore',
    identityType: row.identityType,
    storedProtocol: row.storedProtocol,
    gatewayUrl: row.gatewayUrl,
    autonomyMode: row.expectAutonomy,
    targetNpcId: 'npc-aria',
    ledgerCapable: false,
    boundUserId: null,
    protocolOverride: row.protocolOverride,
  };
}

describe('mint ≡ restore — spawn-relevant config is byte-identical per type', () => {
  for (const row of MATRIX) {
    // Real-gateway types are NOT rebuilt from the row alone (auth_token is never
    // persisted), so restore returns null for them — there is no "restore
    // config" to compare. They are exercised by the resolver tests above. Here
    // we assert drift-freedom for the types restore ACTUALLY rebuilds.
    const restoreRebuilds = row.expectInWorldProtocol !== 'openai-compat' ||
      row.identityType === 'anonymous' || row.identityType === 'milady';
    const isRealGateway = !!row.gatewayUrl;

    test(`AVATAR ${row.identityType}: protocol=${row.expectInWorldProtocol}, species fallback, mint≡restore`, () => {
      // Case A — no explicit species (the fallback path the D1 bug hit).
      const mintCfg = buildAvatarSessionConfig(mintAvatar(row, null));
      // Protocol + species correctness on the MINT side.
      expect((mintCfg as unknown as Record<string, unknown>).protocol).toBe(
        row.expectInWorldProtocol as never,
      );
      expect((mintCfg as unknown as Record<string, unknown>).species).toBe(
        row.expectSpeciesFallback as never,
      );

      if (isRealGateway) {
        // Restore intentionally degrades real-gateway types to reconnect; assert
        // the mint protocol honored its declared HTTP backend and move on.
        expect((mintCfg as unknown as Record<string, unknown>).gatewayUrl).toBe(row.gatewayUrl);
        return;
      }

      const restoreCfg = buildAvatarSessionConfig(restoreAvatarFromRow(row, null));
      // THE assertion — spawn-relevant fields deep-equal (sessionId excluded).
      expect(spawnRelevantProjection(restoreCfg)).toEqual(
        spawnRelevantProjection(mintCfg),
      );

      // Case B — explicit species: still identical and passed through verbatim.
      const mintCfg2 = buildAvatarSessionConfig(mintAvatar(row, 'turtle'));
      const restoreCfg2 = buildAvatarSessionConfig(restoreAvatarFromRow(row, 'turtle'));
      expect((mintCfg2 as unknown as Record<string, unknown>).species).toBe('turtle');
      expect(spawnRelevantProjection(restoreCfg2)).toEqual(
        spawnRelevantProjection(mintCfg2),
      );
    });

    test(`OVERRIDE ${row.identityType}: protocol=${row.expectInWorldProtocol}, mint≡restore`, () => {
      const mintCfg = buildOverrideSessionConfig(mintOverride(row));
      expect((mintCfg as unknown as Record<string, unknown>).protocol).toBe(
        row.expectInWorldProtocol as never,
      );
      if (isRealGateway) return;
      const restoreCfg = buildOverrideSessionConfig(restoreOverrideFromRow(row));
      expect(spawnRelevantProjection(restoreCfg)).toEqual(
        spawnRelevantProjection(mintCfg),
      );
    });

    void restoreRebuilds; // documented above; kept for readability of intent
  }
});

// ---------------------------------------------------------------------------
// Guard the exact 502 regression: a no-gateway avatar body's gatewayUrl is the
// dummy AND its protocol is the fail-soft one, so OpenClawClient.chat() never
// POSTs. (OpenClawClient routes 'nanoclaw' to a '' no-op; 'openai-compat' would
// POST to gatewayUrl — the bug.)
// ---------------------------------------------------------------------------
describe('no-gateway avatar bodies cannot POST to a gateway (the 502 guard)', () => {
  for (const t of ['anonymous', 'milady', 'nanoclaw']) {
    test(`${t}: protocol nanoclaw + dummy gateway`, () => {
      const cfg = buildAvatarSessionConfig({
        mode: 'avatar',
        agentId: `a-${t}`,
        sessionId: 's',
        identityType: t,
        storedProtocol: 'openai-compat',
        gatewayUrl: undefined,
        name: 'N',
        species: null,
        color: undefined,
        stats: STATS,
        homeX: 2560,
        homeY: 2560,
        patrolRadius: 100,
        personality: '',
        ledgerCapable: false,
        boundUserId: null,
      });
      const c = cfg as unknown as Record<string, unknown>;
      expect(c.protocol).toBe('nanoclaw');
      expect(c.gatewayUrl).toBe('http://localhost:0');
      expect(c.authToken).toBe('');
    });
  }
});

describe('isSessionRestorable — restore-aware session-status (D-2) + hatcher-proxy presence refinement', () => {
  test('MIRRORS the restore module: hatcher-proxy + no-gateway types restorable, real-gateway NOT', () => {
    // hatcher self-heals via the encrypted proxy token (restore keys on protocol).
    expect(isSessionRestorable('hatcher', 'hatcher-proxy')).toBe(true);
    // no-gateway identity types rebuild as fail-soft bodies.
    for (const t of ['anonymous', 'milady', 'nanoclaw']) {
      expect(isSessionRestorable(t, 'nanoclaw')).toBe(true);
      expect(isSessionRestorable(t, null)).toBe(true);
    }
    // real-gateway types can't self-heal (no persisted auth_token) → must reconnect.
    for (const t of ['openclaw', 'ironclaw', 'custom']) {
      expect(isSessionRestorable(t, 'openai-compat')).toBe(false);
    }
  });

  test('hatcher-proxy presence refinement: false ⇒ NOT restorable; true/omitted ⇒ restorable', () => {
    // present (or param omitted → backward-compatible type-level true)
    expect(isSessionRestorable('hatcher', 'hatcher-proxy')).toBe(true);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', true)).toBe(true);
    // structurally-degraded hatcher row (dropped proxy config) → tell it to reconnect
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', false)).toBe(false);
  });

  test('presence flag is IGNORED for non-hatcher-proxy protocols', () => {
    // a no-gateway type stays restorable even if a stray false is passed…
    expect(isSessionRestorable('nanoclaw', 'nanoclaw', false)).toBe(true);
    // …and a real-gateway type stays non-restorable even if a stray true is passed.
    expect(isSessionRestorable('openclaw', 'openai-compat', true)).toBe(false);
  });
});
