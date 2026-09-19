import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HOUSE_TRADER_OBJECTIVES,
  TRADING_OBJECTIVE_BRIEFS,
  TRADING_OBJECTIVES,
} from '@clawville/shared';

import { identityFingerprint } from '../identity-service';
import { canonicalizePublicAgentIdentityType } from '../agent-session-config';
import { CLAWPUMP_OBSERVED_IDENTITY_TYPE } from '../trading-provisioning';
import {
  buildHouseTraderSlots,
  houseTraderState,
  qualifiesAsHouseTrader,
  selectHouseTraders,
  type HouseTraderCandidate,
} from '../house-traders';

const AGENT_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
const WALLET = '4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n';

/** A fully qualifying observed ClawPump pairing. */
function observed(overrides: Partial<HouseTraderCandidate> = {}): HouseTraderCandidate {
  return {
    avatarId: 'aaaaaaaa-0000-4000-8000-000000000001',
    avatarName: 'Genesis',
    objective: 'momentum-board',
    clawpumpAgentId: AGENT_ID,
    clawvilleAgentId: 'clawville-agent-genesis',
    linkWalletPubkey: WALLET,
    wallet: { pubkey: WALLET, source: 'clawpump' },
    ownerIdentityFingerprint: identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, AGENT_ID),
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
    ...overrides,
  };
}

describe('house-trader discriminator', () => {
  test('accepts an observed ClawPump pairing', () => {
    expect(qualifiesAsHouseTrader(observed())).toBe(true);
  });

  test('rejects a ClawVille-custodial fleet link', () => {
    // `provisionFleetAccount` inserts clawpump_agent_id null and binds the
    // wallet with source 'custodial'. This is the stale staging SafeRebalancer.
    expect(
      qualifiesAsHouseTrader(
        observed({
          objective: 'conservative-rebalancer',
          clawpumpAgentId: null,
          wallet: { pubkey: WALLET, source: 'custodial' },
        }),
      ),
    ).toBe(false);
    // Even with an agent id, a custodial wallet source still fails condition 3.
    expect(
      qualifiesAsHouseTrader(observed({ wallet: { pubkey: WALLET, source: 'custodial' } })),
    ).toBe(false);
  });

  test('a revoked or missing wallet reads STOPPED, not gone', () => {
    // The reader left-joins on `revoked_at IS NULL`, so a revoked wallet
    // arrives as null. It must NOT drop the slot to "not running yet": unpair
    // revokes the wallet while the `verified_trades` rows survive and keep
    // showing on the public tape, and two public surfaces disagreeing about
    // the same trades is the exact honesty failure this wave exists to avoid.
    expect(houseTraderState(observed({ wallet: null }))).toBe('stopped');
    expect(qualifiesAsHouseTrader(observed({ wallet: null }))).toBe(true);
  });

  test('rejects a wallet whose pubkey disagrees with the link', () => {
    expect(
      qualifiesAsHouseTrader(
        observed({ wallet: { pubkey: 'SomeOtherWalletPubkey11111111111111111111111', source: 'clawpump' } }),
      ),
    ).toBe(false);
  });

  test('rejects a fingerprint mismatch, the real discriminator', () => {
    // A user-owned ClawPump wallet from wave B would have source 'clawpump'
    // but never this provisioning identity.
    expect(qualifiesAsHouseTrader(observed({ ownerIdentityFingerprint: 'deadbeef' }))).toBe(false);
    expect(qualifiesAsHouseTrader(observed({ ownerIdentityFingerprint: null }))).toBe(false);
    // The fingerprint must be over THIS agent id, not merely well formed.
    expect(
      qualifiesAsHouseTrader(
        observed({
          ownerIdentityFingerprint: identityFingerprint(
            CLAWPUMP_OBSERVED_IDENTITY_TYPE,
            'a-different-clawpump-agent',
          ),
        }),
      ),
    ).toBe(false);
  });

  test('picks the newest row and reports a duplicate objective', () => {
    // `objective` is a plain varchar with a CHECK, not a unique column.
    const older = observed({ avatarId: 'older', createdAt: new Date('2026-09-01T00:00:00.000Z') });
    const newer = observed({ avatarId: 'newer', createdAt: new Date('2026-09-19T00:00:00.000Z') });
    const seen: Array<[string, number]> = [];
    const chosen = selectHouseTraders([older, newer], (objective, count) =>
      seen.push([objective, count]),
    );
    expect(chosen.get('momentum-board')?.avatarId).toBe('newer');
    // Silent selection would be fail-invisible, so a duplicate must report.
    expect(seen).toEqual([['momentum-board', 2]]);
  });

  test('does not report when each objective has one qualifying row', () => {
    const seen: string[] = [];
    selectHouseTraders([observed()], (objective) => seen.push(objective));
    expect(seen).toEqual([]);
  });
});

describe('the provisioning identity types are unreachable from any public path', () => {
  // A2 makes condition 4 the load-bearing discriminator on a PUBLIC route, so
  // the thing that must never happen is a caller landing on a house trader's
  // user row by presenting its identity type. `identityFingerprint` is an
  // UNSALTED sha256 of `${type}:${key}` (identity-service.ts:30-34) and
  // `users.identity_fingerprint` is unique, so the only thing standing in the
  // way is that no public path can put these two type strings into the hash.
  // Nothing pinned that before; it was an emergent property. Now it is pinned.
  //
  // WHY THESE TWO LABELS ARE NOT IN `RESERVED_PARTNER_IDENTITY_TYPES`
  // (founder-team ruling 2026-09-19, and the recorded reason is corrected here
  // because the first version of it was wrong). The real guard is
  // `isReservedPartnerIdentityType`, which DOES have production callers:
  // agent-gateway.ts:388, :767 and :4066, openclaw.ts:232, and
  // agent-reconnect-session.ts:196. An earlier note claimed the guard had no
  // callers; that grep used a function name that does not exist, so ignore it.
  // The actual reasons to decline are: at :388 listing the labels only turns
  // today's harmless collapse-to-`custom` into a 400 on a public route for a
  // label nobody sends, and at :767 and openclaw.ts:232 the guard keys on a
  // BOT row's identity_type, which `trading-provisioning.ts` never sets, so it
  // would not fire for house accounts at all. It would also edit a protected
  // partner-surface file for no gain. The protection that actually holds is
  // asserted below.
  const PROVISIONING_TYPES = ['clawpump-observed', 'clawville-fleet'] as const;

  test('the public connect and join path collapses them to custom', () => {
    for (const type of PROVISIONING_TYPES) {
      expect(canonicalizePublicAgentIdentityType(type)).toBe('custom');
      // Which means the hash a public caller can reach is a different hash.
      expect(identityFingerprint(canonicalizePublicAgentIdentityType(type), 'any-key'))
        .not.toBe(identityFingerprint(type, 'any-key'));
    }
    // The canonical set really is closed: anything outside it becomes custom.
    for (const type of ['milady', 'hermes', 'openclaw', 'custom'] as const) {
      expect(canonicalizePublicAgentIdentityType(type)).toBe(type);
    }
  });

  test('the control-link route pins a closed enum at its schema', () => {
    // The one production caller that passes a caller-supplied type straight to
    // `resolveOrCreateUserByIdentity`. Asserted at SOURCE rather than by
    // importing the route: the CI services lane runs with no environment at
    // all (gates.yml "DATABASE_URL intentionally UNSET", no FINGERPRINT_SECRET),
    // and importing agent-gateway.ts pulls the fingerprint middleware, which
    // throws at module load without that secret.
    const gateway = readFileSync(
      resolve(import.meta.dir, '../../routes/agent-gateway.ts'),
      'utf8',
    );
    expect(gateway).toContain(
      "identityType: z.enum(['milady', 'hermes', 'openclaw', 'custom']).optional()",
    );
    for (const type of PROVISIONING_TYPES) expect(gateway).not.toContain(`'${type}'`);
  });

  test('the observed type the discriminator trusts is the one provisioning writes', () => {
    expect(CLAWPUMP_OBSERVED_IDENTITY_TYPE).toBe('clawpump-observed');
  });
});

describe('house-trader slots', () => {
  test('returns exactly the lineup, in lineup order, whatever the data', () => {
    const slots = buildHouseTraderSlots({
      chosen: new Map(),
      counts: new Map(),
      recentByAvatar: new Map(),
    });
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.objective)).toEqual([...HOUSE_TRADER_OBJECTIVES]);
    expect(slots.map((slot) => slot.slotName)).toEqual(['Genesis', 'Dip Hunter']);
    // The other three objectives are trader TEMPLATES a player copies, not
    // house traders; publishing them would claim the house runs them.
    const shown = new Set(slots.map((slot) => slot.objective));
    for (const objective of TRADING_OBJECTIVES) {
      if (HOUSE_TRADER_OBJECTIVES.includes(objective)) expect(shown.has(objective)).toBe(true);
      else expect(shown.has(objective)).toBe(false);
    }
    for (const slot of slots) {
      expect(slot.status).toBe('not-yet-running');
      expect(slot.subject).toBeNull();
      expect(slot.counts).toEqual({ verified: 0, scored: 0, lastTradeAt: null });
      expect(slot.recentTrades).toEqual([]);
    }
  });

  test('publishes the lineup strategy note, never the profile brief', () => {
    // Genesis holds `momentum-board` but trades small-cap memecoins on any
    // venue, i.e. outside that profile's allowed outputs, so serving the
    // profile brief or its mint list would be a false claim about a live
    // trader. `strategyNote` carries no numbers either, because the rule loops
    // live outside the repo and change without a deploy.
    const slots = buildHouseTraderSlots({
      chosen: new Map(), counts: new Map(), recentByAvatar: new Map(),
    });
    const serialised = JSON.stringify(slots);
    expect(slots[0]!.strategyNote).toBe('Momentum on small-cap memecoins, any venue.');
    expect(slots[1]!.strategyNote).toBe('Buys sharp dips in strong mid-cap coins.');
    for (const objective of TRADING_OBJECTIVES) {
      expect(serialised).not.toContain(TRADING_OBJECTIVE_BRIEFS[objective]);
    }
    expect(serialised).not.toContain('brief');
    // No thresholds in a note: the rule loops live outside the repo and change
    // without a deploy, so a number written here would drift into a lie.
    for (const slot of slots) expect(slot.strategyNote).not.toMatch(/\d/);
  });

  test('marks an occupied slot live and leaves the other one empty', () => {
    const candidate = observed();
    const slots = buildHouseTraderSlots({
      chosen: new Map([['momentum-board', candidate]]),
      counts: new Map([
        [candidate.avatarId, { verified: 7, scored: 4, lastTradeAt: '2026-09-19T10:00:00.000Z' }],
      ]),
      recentByAvatar: new Map(),
    });
    const momentum = slots.find((slot) => slot.objective === 'momentum-board')!;
    expect(momentum.status).toBe('live-observed');
    expect(momentum.counts).toEqual({ verified: 7, scored: 4, lastTradeAt: '2026-09-19T10:00:00.000Z' });
    expect(slots.filter((slot) => slot.status === 'not-yet-running')).toHaveLength(1);
  });

  test('publishes the SAME subject shape and id the public tape uses', () => {
    // `listPublicVerifiedTrades` emits `subject: { type, id, avatarName }` with
    // id = agentId ?? avatarId (trade-observer.ts). A second identifier for the
    // same trader on a second public surface would need its own hiding policy.
    const candidate = observed();
    const [momentum] = buildHouseTraderSlots({
      chosen: new Map([['momentum-board', candidate]]),
      counts: new Map(),
      recentByAvatar: new Map(),
    });
    expect(momentum!.subject).toEqual({
      type: 'agent',
      id: 'clawville-agent-genesis',
      avatarName: 'Genesis',
    });
    // The avatar UUID must NOT be the published id.
    expect(momentum!.subject!.id).not.toBe(candidate.avatarId);
  });

  test('keeps a stopped slot agreeing with the public tape', () => {
    const candidate = observed({ wallet: null });
    const [momentum] = buildHouseTraderSlots({
      chosen: new Map([['momentum-board', candidate]]),
      counts: new Map([
        [candidate.avatarId, { verified: 9, scored: 5, lastTradeAt: '2026-09-19T10:00:00.000Z' }],
      ]),
      recentByAvatar: new Map(),
    });
    expect(momentum!.status).toBe('stopped');
    expect(momentum!.subject?.avatarName).toBe('Genesis');
    // Counts still come from verified_trades, so the card cannot claim zero
    // while those same trades sit on the tape above it.
    expect(momentum!.counts.verified).toBe(9);
  });

  test('never exposes a wallet, a user id or an identity fingerprint', () => {
    // The served manual publishes "The public tape never includes wallet
    // addresses", and the fingerprint is the discriminator this PUBLIC surface
    // is gated on, so leaking it would hand over the gate itself.
    const candidate = observed();
    const slots = buildHouseTraderSlots({
      chosen: new Map([['momentum-board', candidate]]),
      counts: new Map(),
      recentByAvatar: new Map(),
    });
    const serialised = JSON.stringify(slots);
    for (const secret of [WALLET, candidate.ownerIdentityFingerprint!, candidate.avatarId, AGENT_ID]) {
      expect(serialised).not.toContain(secret);
    }
    for (const key of ['pubkey', 'wallet', 'fingerprint', 'identity', 'userId', 'user_id', 'avatarId', 'email']) {
      expect(serialised).not.toContain(key);
    }
  });
});
