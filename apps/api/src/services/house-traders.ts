/**
 * House-trader watch surface (wave A2). READ ONLY: it creates no pairing, arms
 * nothing, and touches no money path.
 *
 * There is no `is_house` column and this file deliberately does not add one.
 * An occupied slot is proved from data that only the operator pairing path can
 * produce. Four conditions, ALL required:
 *
 *   1. a `clawpump_agent_links` row carries the objective;
 *   2. its `clawpump_agent_id` is set (a ClawVille-custodial FLEET link inserts
 *      `null` there, an observed ClawPump pairing inserts the real id);
 *   3. a live `trading_wallets` row for the same avatar has
 *      `source = 'clawpump'` and the same pubkey as the link;
 *   4. the owning user's `identity_fingerprint` equals
 *      `identityFingerprint('clawpump-observed', clawpumpAgentId)`.
 *
 * Condition 4 is the real discriminator: it is the one an operator cannot
 * reproduce by accident, and it is the same check `resolveObservedSubject`
 * runs before it pairs. Conditions 1 to 3 are cheap pre-filters. Together they
 * exclude the stale staging SafeRebalancer custodial link (fails 2 and 3) and
 * any future user-owned ClawPump wallet from wave B (fails 1 and 4).
 */

import {
  and, avatars, clawpumpAgentLinks, db, desc, eq, inArray, isNull, sql, tradingWallets,
  users, verifiedTrades,
} from '@clawville/database';
import { identityFingerprint } from './identity-service';
import { CLAWPUMP_OBSERVED_IDENTITY_TYPE } from './trading-provisioning';
import { listPublicVerifiedTradesForAvatars, type PublicTradeDTO } from './trade-observer';
import { alertError } from './alert-error';
import { shouldAlertTradingLoop } from './trading-rpc';
import { HOUSE_TRADER_LINEUP, type TradingObjective } from '@clawville/shared';

/** One `clawpump_agent_links` row joined to its wallet and its owner. */
export interface HouseTraderCandidate {
  avatarId: string;
  avatarName: string | null;
  objective: string;
  clawpumpAgentId: string | null;
  /** The ClawVille agent id. This, never the avatar UUID, is what the public
   *  tape publishes as `subject.id` for an observed pairing. */
  clawvilleAgentId: string | null;
  /** The pubkey recorded on the LINK. */
  linkWalletPubkey: string;
  /** The live (non-revoked) `trading_wallets` row for this avatar, if any. */
  wallet: { pubkey: string; source: string } | null;
  ownerIdentityFingerprint: string | null;
  createdAt: Date;
}

export type HouseTraderStatus = 'live-observed' | 'stopped' | 'not-yet-running';

export interface HouseTraderCounts {
  verified: number;
  scored: number;
  lastTradeAt: string | null;
}

export interface HouseTraderSlot {
  objective: TradingObjective;
  /** The lineup LABEL, not a profile name. */
  slotName: string;
  /** Plain-words strategy from the lineup. Deliberately NOT
   *  `TRADING_OBJECTIVE_BRIEFS`: a house trader runs the operator's own rule
   *  loop on ClawPump, so the profile brief and its allowed mints do not
   *  describe it, and printing them would be a false claim about a live
   *  trader. Genesis holds `momentum-board` but trades small-cap memecoins on
   *  any venue. */
  strategyNote: string;
  status: HouseTraderStatus;
  /** The SAME shape and the SAME identifier the public tape already publishes
   *  (`trade-observer.ts` `PublicTradeDTO.subject`). Deliberately not a second
   *  identifier: exposing the avatar UUID here would put a different public id
   *  on the same trader, and one identifier policy must govern both surfaces. */
  subject: { type: 'avatar' | 'agent'; id: string; avatarName: string | null } | null;
  counts: HouseTraderCounts;
  recentTrades: PublicTradeDTO[];
}

const EMPTY_COUNTS: HouseTraderCounts = { verified: 0, scored: 0, lastTradeAt: null };

/**
 * All four conditions. Pure, so the discriminator is testable without a
 * database and cannot drift from the route that depends on it.
 */
export function houseTraderState(
  candidate: HouseTraderCandidate,
): 'live-observed' | 'stopped' | null {
  // 2. A fleet link leaves this null; only an observed pairing sets it.
  if (!candidate.clawpumpAgentId) return null;
  // 4. The provisioning identity. The real discriminator, and the one an
  //    operator cannot reproduce by accident. Checked before the wallet so a
  //    non-house row can never reach the `stopped` branch below.
  if (!candidate.ownerIdentityFingerprint) return null;
  if (
    candidate.ownerIdentityFingerprint
    !== identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, candidate.clawpumpAgentId)
  ) {
    return null;
  }
  // 3. A live ClawPump-sourced wallet whose pubkey matches the link.
  //
  // A revoked or missing wallet is `stopped`, NOT invisible. Unpair revokes the
  // wallet while its `verified_trades` rows survive and keep showing on the
  // public tape, so dropping the slot to "not running yet" with a zero count
  // would have two public surfaces disagreeing about the same trades.
  if (candidate.wallet === null) return 'stopped';
  // A live wallet that is not the link's ClawPump wallet is not an observed
  // pairing at all (this is the custodial fleet shape), so it is not a house
  // trader rather than a stopped one.
  if (candidate.wallet.source !== 'clawpump') return null;
  if (candidate.wallet.pubkey !== candidate.linkWalletPubkey) return null;
  return 'live-observed';
}

/** True when the row is a house trader at all, live or stopped. */
export function qualifiesAsHouseTrader(candidate: HouseTraderCandidate): boolean {
  return houseTraderState(candidate) !== null;
}

/**
 * Pick at most one qualifying candidate per objective. `objective` is a plain
 * varchar with a CHECK, NOT a unique column, so two rows can claim one slot.
 * The newest `created_at` wins and the duplicate is reported: choosing silently
 * would be a fail-invisible outcome.
 */
export function selectHouseTraders(
  candidates: readonly HouseTraderCandidate[],
  onDuplicate: (objective: string, count: number) => void = () => {},
): Map<string, HouseTraderCandidate> {
  const byObjective = new Map<string, HouseTraderCandidate[]>();
  for (const candidate of candidates) {
    if (!qualifiesAsHouseTrader(candidate)) continue;
    const bucket = byObjective.get(candidate.objective);
    if (bucket) bucket.push(candidate);
    else byObjective.set(candidate.objective, [candidate]);
  }
  const chosen = new Map<string, HouseTraderCandidate>();
  for (const [objective, rows] of byObjective) {
    if (rows.length > 1) onDuplicate(objective, rows.length);
    chosen.set(
      objective,
      [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!,
    );
  }
  return chosen;
}

/**
 * One slot per HOUSE_TRADER_LINEUP entry, in lineup order, so the response
 * shape never depends on the data. Only the lineup appears: the other three
 * profiles are trader TEMPLATES a player can copy, not house traders, and
 * listing them here would claim the house runs traders it does not.
 * An unpaired slot reads `not-yet-running` with zero counts and no rows: no
 * placeholder numbers, no sample trades.
 */
export function buildHouseTraderSlots(input: {
  chosen: Map<string, HouseTraderCandidate>;
  counts: Map<string, HouseTraderCounts>;
  recentByAvatar: Map<string, PublicTradeDTO[]>;
}): HouseTraderSlot[] {
  return HOUSE_TRADER_LINEUP.map((entry) => {
    const objective = entry.objective;
    const candidate = input.chosen.get(objective);
    const base = {
      objective,
      slotName: entry.label,
      strategyNote: entry.strategyNote,
    };
    const state = candidate ? houseTraderState(candidate) : null;
    if (!candidate || state === null) {
      return { ...base, status: 'not-yet-running' as const, subject: null,
        counts: { ...EMPTY_COUNTS }, recentTrades: [] };
    }
    return {
      ...base,
      status: state,
      // NEVER the wallet pubkey, the user id or the identity fingerprint. The
      // served manual publishes "The public tape never includes wallet
      // addresses", and the fingerprint is the discriminator this surface is
      // gated on. The id below is the ClawVille agent id, exactly what the
      // public tape emits for the same trader.
      subject: {
        type: candidate.clawvilleAgentId ? ('agent' as const) : ('avatar' as const),
        id: candidate.clawvilleAgentId ?? candidate.avatarId,
        avatarName: candidate.avatarName,
      },
      // Counts and rows come from `verified_trades` either way, so a stopped
      // slot still agrees with the public tape above it.
      counts: input.counts.get(candidate.avatarId) ?? { ...EMPTY_COUNTS },
      recentTrades: input.recentByAvatar.get(candidate.avatarId) ?? [],
    };
  });
}

/** Seam so the route can be exercised with no database. */
export interface HouseTraderDeps {
  loadCandidates(): Promise<HouseTraderCandidate[]>;
  loadCounts(avatarIds: readonly string[]): Promise<Map<string, HouseTraderCounts>>;
  loadRecent(avatarIds: readonly string[], perAvatar: number): Promise<Map<string, PublicTradeDTO[]>>;
  onDuplicate(objective: string, count: number): void;
}

/**
 * Every `clawpump_agent_links` row joined LEFT to its live wallet and its
 * owner's fingerprint. The join is LEFT on purpose: a link whose wallet is
 * revoked or missing still arrives and is refused by the predicate, so the
 * whole rule lives in one readable place instead of half in SQL.
 */
async function loadCandidatesFromDb(): Promise<HouseTraderCandidate[]> {
  const rows = await db
    .select({
      avatarId: clawpumpAgentLinks.avatarId,
      avatarName: avatars.name,
      objective: clawpumpAgentLinks.objective,
      clawpumpAgentId: clawpumpAgentLinks.clawpumpAgentId,
      clawvilleAgentId: clawpumpAgentLinks.clawvilleAgentId,
      linkWalletPubkey: clawpumpAgentLinks.walletPubkey,
      walletPubkey: tradingWallets.pubkey,
      walletSource: tradingWallets.source,
      ownerIdentityFingerprint: users.identityFingerprint,
      createdAt: clawpumpAgentLinks.createdAt,
    })
    .from(clawpumpAgentLinks)
    .innerJoin(avatars, eq(avatars.id, clawpumpAgentLinks.avatarId))
    .innerJoin(users, eq(users.id, clawpumpAgentLinks.userId))
    .leftJoin(
      tradingWallets,
      and(
        eq(tradingWallets.avatarId, clawpumpAgentLinks.avatarId),
        eq(tradingWallets.pubkey, clawpumpAgentLinks.walletPubkey),
        isNull(tradingWallets.revokedAt),
      ),
    );
  return rows.map((row) => ({
    avatarId: row.avatarId,
    avatarName: row.avatarName,
    objective: row.objective,
    clawpumpAgentId: row.clawpumpAgentId,
    clawvilleAgentId: row.clawvilleAgentId,
    linkWalletPubkey: row.linkWalletPubkey,
    wallet: row.walletPubkey && row.walletSource
      ? { pubkey: row.walletPubkey, source: row.walletSource }
      : null,
    ownerIdentityFingerprint: row.ownerIdentityFingerprint,
    createdAt: row.createdAt,
  }));
}

/** One grouped read: total, scored total and the newest verification time.
 *  Covered by `verified_trades_avatar_time_idx` on (avatar_id, verified_at). */
async function loadCountsFromDb(
  avatarIds: readonly string[],
): Promise<Map<string, HouseTraderCounts>> {
  const counts = new Map<string, HouseTraderCounts>();
  if (avatarIds.length === 0) return counts;
  const rows = await db
    .select({
      avatarId: verifiedTrades.avatarId,
      verified: sql<string>`count(*)`,
      scored: sql<string>`count(*) filter (where ${verifiedTrades.scored})`,
      // Typed as Date, not string: postgres-js maps timestamptz to a Date, and
      // parsing the Postgres string form (a space, not a T) is engine
      // dependent rather than spec guaranteed.
      lastTradeAt: sql<Date | null>`max(${verifiedTrades.verifiedAt})`,
    })
    .from(verifiedTrades)
    .where(inArray(verifiedTrades.avatarId, [...avatarIds]))
    .groupBy(verifiedTrades.avatarId);
  for (const row of rows) {
    if (!row.avatarId) continue;
    counts.set(row.avatarId, {
      verified: Number(row.verified) || 0,
      scored: Number(row.scored) || 0,
      lastTradeAt: row.lastTradeAt ? row.lastTradeAt.toISOString() : null,
    });
  }
  return counts;
}

export function createHouseTraderDeps(overrides: Partial<HouseTraderDeps> = {}): HouseTraderDeps {
  return {
    loadCandidates: loadCandidatesFromDb,
    loadCounts: loadCountsFromDb,
    loadRecent: listPublicVerifiedTradesForAvatars,
    onDuplicate: (objective, count) => {
      // One page per objective per hour. A duplicate is a real operator fault
      // and it repeats on every request until someone fixes it, so an
      // unthrottled alert here would be a pager storm.
      if (!shouldAlertTradingLoop(`house-traders:duplicate:${objective}`)) return;
      void alertError({
        severity: 'warning',
        source: 'house-traders',
        message: `Two or more qualifying house-trader links share objective ${objective} (${count} rows). Showing the newest.`,
        context: { objective, count },
      });
    },
    ...overrides,
  };
}

/** Read the lineup slots. Always returns every `HOUSE_TRADER_LINEUP` entry (two today), in lineup order, whatever the data says. */
export async function readHouseTraderSlots(
  deps: HouseTraderDeps = createHouseTraderDeps(),
  recentPerSlot = 5,
): Promise<HouseTraderSlot[]> {
  const lineup = new Set<string>(HOUSE_TRADER_LINEUP.map((entry) => entry.objective));
  // Narrowed to the lineup BEFORE selection, so a duplicate on an objective the
  // surface does not publish cannot page anyone about a slot nobody can see.
  const candidates = (await deps.loadCandidates()).filter((row) => lineup.has(row.objective));
  const chosen = selectHouseTraders(candidates, deps.onDuplicate);
  const avatarIds = [...chosen.values()].map((candidate) => candidate.avatarId);
  const [counts, recentByAvatar] = await Promise.all([
    deps.loadCounts(avatarIds),
    deps.loadRecent(avatarIds, recentPerSlot),
  ]);
  return buildHouseTraderSlots({ chosen, counts, recentByAvatar });
}
