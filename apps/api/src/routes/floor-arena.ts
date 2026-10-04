import { randomBytes, randomUUID } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_REQUEST_CODES,
  type FloorArenaWithdrawAddressProof,
  type FloorArenaWithdrawAmountMode,
  type FloorArenaWithdrawAsset,
  type FloorArenaWithdrawState,
  type FloorArenaWithdrawSubjectKind,
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_VERSION,
  applyFloorArenaParamChange,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaAddon,
  type FloorArenaParamDiff,
  type FloorArenaParams,
  FLOOR_ARENA_DESK_COUNT,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp, type RateLimiter } from '../middleware/rate-limit';
import { withKeyedMutex } from '../services/keyed-mutex';
import type { ClawPumpWalletBalance } from '../services/clawpump-writer';
// PURE helpers only (no network, no DB): the destination check and the atomic
// amount text. Every ClawPump call stays with the engine leader (I4, D8).
import { arenaDestinationProblem, formatAtomicAmount } from '../services/clawpump-writer';
import { ARENA_ADDON_MIN_INTERVAL_S, addonPaymentsEnabled, readArenaWalletBalance, utcDayStart } from '../services/floor-arena/addons';
import { readArenaContest, type ArenaContestView } from '../services/floor-arena/contest';
import {
  isArenaTextOffensive,
  maskArenaDiscoveryRow,
  maskArenaName,
  maskArenaPosition,
  maskArenaSummary,
  maskArenaTapeItem,
} from '../services/floor-arena/content-mask';
import { isFloorArenaReservedName } from '../services/floor-arena/names';
import {
  isArenaLeaderboardWindow,
  readArenaLeaderboard,
  type ArenaLeaderboardRow,
  type ArenaLeaderboardWindow,
} from '../services/floor-arena/leaderboard';
import { evaluateArenaSuggestion } from '../services/floor-arena/analysis';
import { logEventFromContext, type EventInput } from '../services/event-logger';
import {
  cancelArenaWithdrawal,
  consumeArenaWithdrawChallenge,
  isArenaClawPumpWallet,
  issueArenaWithdrawChallenge,
  readArenaLinkedWallet,
  readArenaWithdrawAddress,
  readArenaWithdrawals,
  readArenaWithdrawSummary,
  requestArenaWithdrawal,
  revokeArenaWithdrawAddress,
  setArenaWithdrawAddress,
  type ArenaWithdrawAddressRecord,
  type ArenaWithdrawalRecord,
  insertUserArenaAgent,
  readArenaAddonStats,
  readArenaAgent,
  readArenaAgentByOwner,
  readArenaAgentStats,
  readArenaDiscovery,
  readArenaEvents,
  readArenaHouseAgents,
  readArenaParamChanges,
  readArenaPositions,
  readArenaReport,
  readArenaTape,
  readAvatarName,
  readLatestArenaReport,
  ARENA_PUBLIC_USER_EVENT_TYPES,
  redactArenaEventForPublic,
  redactArenaParamChangeForPublic,
  redactArenaPositionForPublic,
  toPublicUserProfile,
  setArenaAgentAddons,
  setArenaAgentAutoApply,
  setArenaAgentSeat,
  setArenaAgentStatus,
  setArenaReportSuggestionState,
  toPublicAgent,
  updateArenaAgentParams,
  type ArenaAddonCallStat,
  type ArenaAgentAddon,
  type ArenaAgentRecord,
  type ArenaAgentStats,
  type ArenaDiscoveryRow,
  type ArenaEvent,
  type ArenaEventType,
  type ArenaParamChange,
  type ArenaPosition,
  type ArenaPublicAgent,
  type ArenaReport,
  type ArenaTapeItem,
  type InsertUserAgentInput,
  type ParamUpdateInput,
  type ParamUpdateResult,
} from '../services/floor-arena/queries';

/**
 * Trading Floor Arena API (docs/trading-floor-arena.md §5), mounted at
 * `/api/floor/arena` BEFORE the `/api/floor` router, so the public GETs never
 * run `sessionMiddleware` (it can append Set-Cookie, and these responses are
 * `Cache-Control: public`, the same load-bearing reason as trading-floor.ts).
 *
 * PARITY (E5): every `/me` route runs `requireAuthOrAgentSession`, so a human
 * (Lucia cookie) and a connected or hosted agent (`X-Clawville-Agent-Session`)
 * resolve to the SAME subject: the owning user and that user's active avatar.
 * The arena agent is keyed by the owning user, so a player and their agent
 * manage one and the same arena agent. Guests (and agents owned by a guest)
 * get 403 `guest_not_allowed`; an agent session that has not proved avatar
 * ownership gets 403 from `requireLedgerCapableIdentity`, because add-ons
 * spend real USDC from the agent's funded ClawPump wallet.
 *
 * Paper only (D11): `mode: 'live'` is refused with `live_not_available`.
 *
 * Wallet withdraw (P5, D34; contract ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md
 * §6): REAL MONEY. The `/me/withdraw-address*` and `/me/withdrawals*` routes run
 * the same chain, resolve the arena row from `identity.userId` (never from the
 * body), and WRITE DB ROWS ONLY (I4): no route here calls ClawPump or the RPC.
 * The engine leader (floor-arena/withdraw.ts) admits each row under the add-on
 * lock and sends it once. PARITY (E5): a human (login cookie) and a ledger-capable
 * agent (X-Clawville-Agent-Session, tools clawville_arena_withdraw*) use the same
 * routes; settlement binds to the user arena row of identity.userId: source =
 * that row's ClawPump wallet, destination = that row's active proved address.
 */

// ─── Response shapes (arena-web consumes these) ────────────────────────────

export interface ArenaAgentStatsByWindow {
  all: ArenaAgentStats;
  last24h: ArenaAgentStats;
  contest: ArenaAgentStats;
}

export interface ArenaHouseAgentView {
  id: string;
  name: string;
  templateId: string;
  status: ArenaPublicAgent['status'] | null;
  seated: boolean;
  paramsVersion: number | null;
  stats: ArenaAgentStatsByWindow;
}

export interface ArenaPublicAddon {
  id: string;
  vendor: string;
  name: string;
  priceUsd: number;
  minIntervalS: number;
  note: string;
}

export interface ArenaMyAddonStatus extends ArenaPublicAddon {
  enabled: boolean;
  dailyCapUsd: number;
  spentTodayUsd: number;
  lastCallAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface ArenaMeResponse {
  agent: ArenaPublicAgent | null;
  paymentAddress: string | null;
  provision: { state: ArenaPublicAgent['provisionState']; error: string | null } | null;
  wallet: { address: string; usdc: number | null; sol: number | null; updatedAt: string | null } | null;
  addons: ArenaMyAddonStatus[];
  stats: ArenaAgentStatsByWindow | null;
  latestReport: ArenaReport | null;
  /** P5: the current withdraw address and the one open withdrawal; null with no arena agent. */
  withdraw: { address: ArenaWithdrawAddressView | null; open: ArenaWithdrawalView | null } | null;
}

/** A withdraw address as the owner sees it: never the signed message, the signature or the owner id. */
export interface ArenaWithdrawAddressView {
  id: string;
  address: string;
  proof: FloorArenaWithdrawAddressProof;
  setBy: FloorArenaWithdrawSubjectKind;
  createdAt: string;
  activeAt: string;
  state: 'pending' | 'active';
}

/** A withdrawal as the owner sees it: never the idempotency key or the owner id. `amount` is a decimal string. */
export interface ArenaWithdrawalView {
  id: string;
  asset: FloorArenaWithdrawAsset;
  amountMode: FloorArenaWithdrawAmountMode;
  /** Decimal text of the sent amount, else of the requested one; null for a `max` row the leader has not fixed yet. */
  amount: string | null;
  destination: string;
  state: FloorArenaWithdrawState;
  errorCode: string | null;
  txSignature: string | null;
  subjectKind: FloorArenaWithdrawSubjectKind;
  requestedAt: string;
  dispatchedAt: string | null;
  finalizedAt: string | null;
}

// ─── Dependencies (tests inject fakes) ─────────────────────────────────────

export interface FloorArenaRouteDeps {
  now(): Date;
  newId(): string;
  readAgent(id: string): Promise<ArenaAgentRecord | null>;
  readAgentByOwner(userId: string): Promise<ArenaAgentRecord | null>;
  readHouseAgents(): Promise<ArenaAgentRecord[]>;
  readAvatarName(avatarId: string): Promise<string | null>;
  insertUserAgent(input: InsertUserAgentInput): Promise<ArenaAgentRecord | null>;
  updateParams(input: ParamUpdateInput): Promise<ParamUpdateResult>;
  setSeat(agentId: string, seated: boolean, seatIndex: number | null, summary: string): Promise<ArenaAgentRecord | null>;
  setStatus(agentId: string, status: 'active' | 'paused', summary: string): Promise<ArenaAgentRecord | null>;
  setAddons(agentId: string, addons: ArenaAgentAddon[], summary: string): Promise<ArenaAgentRecord | null>;
  setAutoApply(agentId: string, autoApply: boolean, summary: string): Promise<ArenaAgentRecord | null>;
  readReport(reportId: string): Promise<ArenaReport | null>;
  readLatestReport(agentId: string): Promise<ArenaReport | null>;
  setReportState(reportId: string, agentId: string, state: 'dismissed' | 'rejected' | 'applied'): Promise<boolean>;
  readPositions(agentId: string, status: 'open' | 'closed', limit: number): Promise<ArenaPosition[]>;
  readParamChanges(agentId: string, limit: number): Promise<ArenaParamChange[]>;
  readEvents(agentId: string, after: number | null, limit: number, types?: readonly ArenaEventType[] | null): Promise<ArenaEvent[]>;
  readDiscovery(limit: number, now: Date): Promise<ArenaDiscoveryRow[]>;
  readTape(limit: number): Promise<ArenaTapeItem[]>;
  readStats(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaAgentStatsByWindow>>;
  readLeaderboard(window: ArenaLeaderboardWindow, now: Date): Promise<ArenaLeaderboardRow[]>;
  readContest(now: Date): Promise<ArenaContestView>;
  readAddonStats(agentId: string, dayStart: Date): Promise<ArenaAddonCallStat[]>;
  readWalletBalance(clawpumpAgentId: string): Promise<ClawPumpWalletBalance | null>;
  addonCatalog(): readonly FloorArenaAddon[];
  addonPaymentsEnabled(): boolean;
  /**
   * Audit-contest B1: an anti-sybil `events` row. The default is
   * logEventFromContext, which stamps fp_hash and ip_prefix_hash from the
   * request (fingerprintMiddleware) and never throws. The event types are not
   * weighted by the leaderboard scoring (it selects named types only).
   */
  logArenaEvent(c: { get(key: string): unknown }, input: EventInput): Promise<void>;
  // P5 withdraw (contract §5). Each writes or reads DB rows only; none calls ClawPump.
  issueWithdrawChallenge: typeof issueArenaWithdrawChallenge;
  consumeWithdrawChallenge: typeof consumeArenaWithdrawChallenge;
  isArenaWallet: typeof isArenaClawPumpWallet;
  readLinkedWallet: typeof readArenaLinkedWallet;
  setWithdrawAddress: typeof setArenaWithdrawAddress;
  revokeWithdrawAddress: typeof revokeArenaWithdrawAddress;
  requestWithdrawal: typeof requestArenaWithdrawal;
  listWithdrawals: typeof readArenaWithdrawals;
  cancelWithdrawal: typeof cancelArenaWithdrawal;
  readWithdrawSummary: typeof readArenaWithdrawSummary;
  readWithdrawAddress: typeof readArenaWithdrawAddress;
}

export const defaultFloorArenaRouteDeps: FloorArenaRouteDeps = {
  now: () => new Date(),
  newId: () => randomUUID(),
  readAgent: readArenaAgent,
  readAgentByOwner: readArenaAgentByOwner,
  readHouseAgents: readArenaHouseAgents,
  readAvatarName,
  insertUserAgent: insertUserArenaAgent,
  updateParams: updateArenaAgentParams,
  setSeat: setArenaAgentSeat,
  setStatus: setArenaAgentStatus,
  setAddons: setArenaAgentAddons,
  setAutoApply: setArenaAgentAutoApply,
  readReport: readArenaReport,
  readLatestReport: readLatestArenaReport,
  setReportState: setArenaReportSuggestionState,
  readPositions: readArenaPositions,
  readParamChanges: readArenaParamChanges,
  readEvents: readArenaEvents,
  readDiscovery: readArenaDiscovery,
  readTape: readArenaTape,
  readStats: readArenaAgentStats,
  readLeaderboard: readArenaLeaderboard,
  readContest: readArenaContest,
  readAddonStats: readArenaAddonStats,
  readWalletBalance: (clawpumpAgentId) => readArenaWalletBalance(clawpumpAgentId),
  addonCatalog: () => FLOOR_ARENA_ADDONS,
  addonPaymentsEnabled: () => addonPaymentsEnabled(),
  logArenaEvent: (c, input) => logEventFromContext(c, input),
  issueWithdrawChallenge: issueArenaWithdrawChallenge,
  consumeWithdrawChallenge: consumeArenaWithdrawChallenge,
  isArenaWallet: isArenaClawPumpWallet,
  readLinkedWallet: readArenaLinkedWallet,
  setWithdrawAddress: setArenaWithdrawAddress,
  revokeWithdrawAddress: revokeArenaWithdrawAddress,
  requestWithdrawal: requestArenaWithdrawal,
  listWithdrawals: readArenaWithdrawals,
  cancelWithdrawal: cancelArenaWithdrawal,
  readWithdrawSummary: readArenaWithdrawSummary,
  readWithdrawAddress: readArenaWithdrawAddress,
};

/** Anti-sybil event types (audit-contest B1). Not in the leaderboard scoring. */
export const ARENA_LAUNCH_EVENT = 'floor_arena.launch';
export const ARENA_SEAT_EVENT = 'floor_arena.seat';

// ─── Validation ────────────────────────────────────────────────────────────

const AGENT_ID = /^(house:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NAME = /^[\p{L}\p{N} _.'-]+$/u;
/** P8: a name needs a letter, so `-4200.00` cannot sit in the board's TRADER column beside the P&L. */
const NAME_LETTER = /\p{L}/u;
const NAME_MAX = 32;
const SEAT_MAX_INDEX = FLOOR_ARENA_DESK_COUNT - 1;

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const TAPE_MAX = 24;
const TAPE_DEFAULT = 12;

const addonEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  enabled: z.boolean().optional(),
  dailyCapUsd: z.number().finite().min(0).max(FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD).optional(),
}).strict();

export const launchBodySchema = z.object({
  templateId: z.string().trim().min(1).max(40),
  params: z.unknown(),
  mode: z.string().trim().min(1).max(16),
  addons: z.array(addonEntrySchema).max(10).optional(),
  name: z.string().trim().min(1).max(NAME_MAX).regex(NAME).optional(),
}).strict();

export const paramsBodySchema = z.object({
  params: z.unknown(),
  reason: z.string().trim().min(1).max(280).optional(),
}).strict();

export const seatBodySchema = z.object({
  seated: z.boolean(),
  seatIndex: z.number().int().min(0).max(SEAT_MAX_INDEX).optional(),
}).strict();

export const statusBodySchema = z.object({ status: z.enum(['active', 'paused']) }).strict();
export const addonsBodySchema = z.object({ addons: z.array(addonEntrySchema).max(10) }).strict();
export const suggestionBodySchema = z.object({ action: z.enum(['apply', 'dismiss']) }).strict();
export const settingsBodySchema = z.object({ autoApplySuggestions: z.boolean() }).strict();

// ─── Withdraw validation (P5, contract §6) ─────────────────────────────────

const SOLANA_ADDRESS = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
export const withdrawChallengeBodySchema = z.object({ address: SOLANA_ADDRESS }).strict();
export const withdrawAddressBodySchema = z.discriminatedUnion('proof', [
  z.object({ proof: z.literal('signed'), address: SOLANA_ADDRESS, nonce: z.string().min(32).max(64), signature: z.string().min(80).max(96) }).strict(),
  z.object({ proof: z.literal('linked_wallet') }).strict(),
]);
export const withdrawRevokeBodySchema = z.object({ addressId: z.string().uuid() }).strict();
export const withdrawRequestBodySchema = z.object({
  asset: z.enum(['USDC', 'SOL']),
  amount: z.union([z.literal('max'), z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,9})?$/)]),
}).strict();
/** Cancel takes no body; an object with any key is refused. */
const withdrawCancelBodySchema = z.object({}).strict();
const withdrawListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });
/** Same as wallet-withdraw.ts and the 0074 CHECK on floor_arena_withdrawals.idempotency_key. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** bigint max (int64): the column type of every *_atomic field. */
const MAX_ATOMIC = 2n ** 63n - 1n;
const ARENA_SIGNATURE_BYTES = 64;

function assetDecimals(asset: FloorArenaWithdrawAsset): number {
  return asset === 'USDC' ? FLOOR_ARENA_WITHDRAW_LIMITS.usdcDecimals : FLOOR_ARENA_WITHDRAW_LIMITS.solDecimals;
}

/**
 * The decimal STRING in atomic units, exactly: split on `.`, pad, BigInt. Never a
 * float, never rounded. Null for more decimals than the asset has, for 0, and for
 * a value above int64 (12 integer digits x 1e9 lamports can overflow).
 */
export function parseWithdrawAmount(text: string, asset: FloorArenaWithdrawAsset): bigint | null {
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) return null;
  const decimals = assetDecimals(asset);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  const atomic = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return atomic > 0n && atomic <= MAX_ATOMIC ? atomic : null;
}

/** "0.10 USDC" / "0.001 SOL" / "500 USDC": atomic units as copy text (two decimals when there is a fraction). */
function withdrawAmountCopy(atomic: number, asset: FloorArenaWithdrawAsset): string {
  const text = formatAtomicAmount(BigInt(atomic), assetDecimals(asset));
  const dot = text.indexOf('.');
  return `${dot >= 0 && text.length - dot - 1 < 2 ? `${text}0` : text} ${asset}`;
}

function minutesCopy(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minute${min === 1 ? '' : 's'}`;
}

export function toWithdrawAddressView(row: ArenaWithdrawAddressRecord, now: Date): ArenaWithdrawAddressView {
  return {
    id: row.id,
    address: row.address,
    proof: row.proofKind,
    setBy: row.setBy,
    createdAt: row.createdAt.toISOString(),
    activeAt: row.activeAt.toISOString(),
    state: row.activeAt.getTime() > now.getTime() ? 'pending' : 'active',
  };
}

export function toWithdrawalView(row: ArenaWithdrawalRecord): ArenaWithdrawalView {
  const atomic = row.amountAtomic ?? row.requestedAtomic;
  return {
    id: row.id,
    asset: row.asset,
    amountMode: row.amountMode,
    amount: atomic === null ? null : formatAtomicAmount(atomic, assetDecimals(row.asset)),
    destination: row.destination,
    state: row.state,
    errorCode: row.errorCode,
    txSignature: row.txSignature,
    subjectKind: row.subjectKind,
    requestedAt: row.requestedAt.toISOString(),
    dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
  };
}

type WithdrawRequestCode = (typeof FLOOR_ARENA_WITHDRAW_REQUEST_CODES)[number];

/** HTTP status + copy per request refusal (no row written). Numbers render from FLOOR_ARENA_WITHDRAW_LIMITS. */
const WITHDRAW_REFUSALS: Record<WithdrawRequestCode, { status: 400 | 409 | 429; error: string }> = {
  idempotency_conflict: { status: 409, error: 'This Idempotency-Key was used with another request. Send a new key.' },
  wallet_not_ready: { status: 409, error: "Your trader's wallet is not ready yet." },
  no_withdraw_address: { status: 409, error: 'Add a withdraw address first.' },
  address_pending: { status: 409, error: 'Your new withdraw address is not active yet. It works from the activeAt time.' },
  withdrawal_open: { status: 409, error: 'One withdrawal is in progress. Wait until it ends.' },
  cooldown: { status: 429, error: `Wait ${minutesCopy(FLOOR_ARENA_WITHDRAW_LIMITS.cooldownMs)} between withdrawals.` },
  daily_count_cap: {
    status: 429,
    error: `You can withdraw ${FLOOR_ARENA_WITHDRAW_LIMITS.agentDailyRequests} times a day. Try again after 00:00 UTC.`,
  },
  agent_daily_cap: {
    status: 409,
    error: `You can withdraw at most ${withdrawAmountCopy(FLOOR_ARENA_WITHDRAW_LIMITS.agentDailyUsdcAtomic, 'USDC')} a day.`,
  },
  invalid_amount: {
    status: 400,
    error: `The amount is not valid. USDC takes at most ${FLOOR_ARENA_WITHDRAW_LIMITS.usdcDecimals} decimals and SOL at most ${FLOOR_ARENA_WITHDRAW_LIMITS.solDecimals}, and it must be more than 0.`,
  },
  below_minimum: {
    status: 400,
    error: `The minimum is ${withdrawAmountCopy(FLOOR_ARENA_WITHDRAW_LIMITS.minUsdcAtomic, 'USDC')} or ${withdrawAmountCopy(FLOOR_ARENA_WITHDRAW_LIMITS.minSolLamports, 'SOL')}.`,
  },
};

type AddonCheck = { ok: true; addons: ArenaAgentAddon[] } | { ok: false; code: string; error: string };

/** Known catalog ids only, no duplicates, caps 0..max, enabled caps summing to at most the agent max. */
export function normaliseAddons(
  entries: ReadonlyArray<z.infer<typeof addonEntrySchema>>,
  catalog: readonly FloorArenaAddon[],
): AddonCheck {
  const known = new Set(catalog.map((addon) => addon.id));
  const seen = new Set<string>();
  const addons: ArenaAgentAddon[] = [];
  for (const entry of entries) {
    if (!known.has(entry.id)) return { ok: false, code: 'unknown_addon', error: `Unknown add-on: ${entry.id}` };
    if (seen.has(entry.id)) return { ok: false, code: 'duplicate_addon', error: `Add-on listed twice: ${entry.id}` };
    seen.add(entry.id);
    addons.push({
      id: entry.id,
      enabled: entry.enabled ?? true,
      dailyCapUsd: entry.dailyCapUsd ?? FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
    });
  }
  const enabledCap = addons.filter((addon) => addon.enabled).reduce((sum, addon) => sum + addon.dailyCapUsd, 0);
  if (enabledCap > FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD + 1e-9) {
    return {
      ok: false,
      code: 'addon_cap_exceeded',
      error: `The daily caps of enabled add-ons add up to more than $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD}.`,
    };
  }
  return { ok: true, addons };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'off';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** "Changed 2 settings: filters.mcap_max 250000 -> 300000; exits.max_hold_s 900 -> 1200" (<= 280 chars later). */
export function describeChanges(changes: readonly FloorArenaParamDiff[], prefix = 'Changed'): string {
  const parts = changes.map((change) => `${change.path} ${formatValue(change.from)} -> ${formatValue(change.to)}`);
  return `${prefix} ${changes.length} setting${changes.length === 1 ? '' : 's'}: ${parts.join('; ')}`;
}

/**
 * A user agent's public event. A param_change summary is REBUILT from the diff
 * (never the stored text), so no player-typed or model-written reason can reach
 * the public stream through the summary either.
 */
function publicUserEvent(event: ArenaEvent): ArenaEvent {
  const redacted = redactArenaEventForPublic(event);
  if (redacted.type !== 'param_change') return redacted;
  const changes = (redacted.data as { changes?: unknown } | null)?.changes;
  const diff = Array.isArray(changes)
    ? changes.filter((change): change is FloorArenaParamDiff =>
      !!change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string')
    : [];
  return { ...redacted, summary: diff.length > 0 ? describeChanges(diff) : 'Changed settings' };
}

function publicAddon(addon: FloorArenaAddon): ArenaPublicAddon {
  return {
    id: addon.id,
    vendor: addon.vendor,
    name: addon.name,
    priceUsd: addon.priceUsd,
    minIntervalS: Math.max(addon.minIntervalS, ARENA_ADDON_MIN_INTERVAL_S),
    note: addon.note,
  };
}

function emptyStats(): ArenaAgentStatsByWindow {
  const zero: ArenaAgentStats = { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null };
  return { all: { ...zero }, last24h: { ...zero }, contest: { ...zero } };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function invalidBody(c: Context) {
  return c.json({ error: 'Invalid request body.', code: 'invalid_body' }, 400);
}

function nameReserved(c: Context) {
  return c.json({ error: 'That name belongs to a house agent. Choose another name.', code: 'name_reserved' }, 400);
}

function nameNeedsLetter(c: Context) {
  return c.json({ error: 'The name needs at least one letter, so it cannot look like a number.', code: 'name_needs_letter' }, 400);
}

/**
 * An offensive trader name (content-mask.ts, the same check that masks names on the public board).
 * One copy for a typed name and for the avatar-name fallback (review MINOR 2).
 */
function nameNotAllowed(c: Context) {
  return c.json({ error: 'This name is not allowed. Type another name for your trader.', code: 'name_not_allowed' }, 400);
}

// ─── Small TTL cache for public GETs ───────────────────────────────────────

function createTtlCache<T>(ttlMs: number, maxEntries = 500) {
  const entries = new Map<string, { expiresAt: number; value: T }>();
  return {
    async get(key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > nowMs) return hit.value;
      const value = await load();
      if (entries.size >= maxEntries) entries.clear();
      entries.set(key, { expiresAt: nowMs + ttlMs, value });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

// ─── Router factory ────────────────────────────────────────────────────────

/** The authed chain on every `/me` route (E5): session -> human OR agent identity -> non-guest -> ledger-capable. */
export const FLOOR_ARENA_AUTH_CHAIN: readonly MiddlewareHandler[] = [
  sessionMiddleware as unknown as MiddlewareHandler,
  requireAuthOrAgentSession as unknown as MiddlewareHandler,
  requireNonGuestIdentity as unknown as MiddlewareHandler,
  requireLedgerCapableIdentity as unknown as MiddlewareHandler,
];

export interface FloorArenaRouteOptions {
  /** The authed middleware chain. Default: session -> identity -> non-guest -> ledger-capable. */
  auth?: MiddlewareHandler[];
  /** Fresh limiters per router instance (tests). */
  limiters?: Partial<Record<'public' | 'write' | 'launch', () => RateLimiter>>;
}

export function createFloorArenaRoutes(
  deps: FloorArenaRouteDeps = defaultFloorArenaRouteDeps,
  options: FloorArenaRouteOptions = {},
) {
  const routes = new Hono<ActivityAuthContext>();
  const makePublic = options.limiters?.public ?? (() => createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 }));
  const makeWrite = options.limiters?.write ?? (() => createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 }));
  const makeLaunch = options.limiters?.launch ?? (() => createRateLimiter({ maxPerWindow: 5, windowMs: 60_000 }));
  const publicLimiters = new Map<string, RateLimiter>();
  const publicLimiter = (route: string): RateLimiter => {
    let limiter = publicLimiters.get(route);
    if (!limiter) {
      limiter = makePublic();
      publicLimiters.set(route, limiter);
    }
    return limiter;
  };
  const writeLimiter = makeWrite();
  const launchLimiter = makeLaunch();

  const templatesCache = createTtlCache<unknown>(15_000, 4);
  const leaderboardCache = createTtlCache<unknown>(10_000, 8);
  const agentCache = createTtlCache<unknown>(5_000);
  const eventsCache = createTtlCache<unknown>(3_000);
  const discoveryCache = createTtlCache<unknown>(10_000, 16);
  const contestCache = createTtlCache<unknown>(10_000, 2);
  const tapeCache = createTtlCache<unknown>(5_000, 24);

  function limited(c: Context, route: string) {
    if (publicLimiter(route).check(getClientIp(c.req.raw.headers))) return null;
    return c.json({ error: 'Too many requests.', code: 'rate_limited' }, 429);
  }

  function publicJson(c: Context, body: unknown, maxAge = 5) {
    // Set only on success, so an edge never caches an error body.
    c.header('Cache-Control', `public, max-age=${maxAge}`);
    return c.json(body);
  }

  // ── Public GETs (NO session middleware; see the file header) ─────────────

  routes.get('/templates', async (c) => {
    const blocked = limited(c, 'templates');
    if (blocked) return blocked;
    const now = deps.now();
    const body = await templatesCache.get('templates', now.getTime(), async () => {
      const rows = new Map((await deps.readHouseAgents()).map((agent) => [agent.id, agent]));
      const stats = await deps.readStats(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id), now);
      const houseAgents: ArenaHouseAgentView[] = FLOOR_ARENA_HOUSE_AGENTS.map((house) => {
        const row = rows.get(house.id);
        return {
          id: house.id,
          name: house.name,
          templateId: house.templateId,
          status: row?.status ?? null,
          seated: true,
          paramsVersion: row?.paramsVersion ?? null,
          stats: stats.get(house.id) ?? emptyStats(),
        };
      });
      return {
        version: FLOOR_ARENA_VERSION,
        templates: FLOOR_ARENA_TEMPLATES,
        hardRules: FLOOR_ARENA_HARD_RULES,
        bounds: FLOOR_ARENA_PARAM_BOUNDS,
        paperCosts: FLOOR_ARENA_PAPER_COSTS,
        addonDailyCap: { defaultUsd: FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD, maxUsd: FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD },
        houseAgents,
        generatedAt: now.toISOString(),
      };
    });
    return publicJson(c, body, 15);
  });

  routes.get('/leaderboard', async (c) => {
    const blocked = limited(c, 'leaderboard');
    if (blocked) return blocked;
    const window = c.req.query('window') ?? 'contest';
    if (!isArenaLeaderboardWindow(window)) {
      return c.json({ error: 'window must be contest, 24h or all.', code: 'invalid_window' }, 400);
    }
    const now = deps.now();
    const body = await leaderboardCache.get(window, now.getTime(), async () => ({
      window,
      contest: { id: FLOOR_ARENA_CONTEST.id, startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt },
      // Player-chosen trader names pass the content mask (content-mask.ts), as on every public payload.
      rows: (await deps.readLeaderboard(window, now)).map(maskArenaName),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body);
  });

  routes.get('/agents/:id', async (c) => {
    const blocked = limited(c, 'agent');
    if (blocked) return blocked;
    const id = c.req.param('id') ?? '';
    if (!AGENT_ID.test(id)) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    const now = deps.now();
    const body = await agentCache.get(id, now.getTime(), async () => {
      const agent = await deps.readAgent(id);
      if (!agent) return null;
      const house = agent.kind === 'house';
      const [stats, openPositions, closedPositions, latestReport, paramChanges] = await Promise.all([
        deps.readStats([agent.id], now),
        deps.readPositions(agent.id, 'open', 5),
        deps.readPositions(agent.id, 'closed', 50),
        house ? deps.readLatestReport(agent.id) : Promise.resolve(null),
        deps.readParamChanges(agent.id, 20),
      ]);
      // Codex r2 #1/#2: another player's agent shows strategy, state and
      // results only. Add-on settings, payment address, provisioning state and
      // reports stay with the owner (/me); an add-on source reads 'addon'.
      // Content mask: the trader name, each coin symbol and the report summary.
      return {
        agent: maskArenaName(house ? toPublicAgent(agent) : toPublicUserProfile(agent)),
        stats: stats.get(agent.id) ?? emptyStats(),
        openPositions: (house ? openPositions : openPositions.map(redactArenaPositionForPublic)).map(maskArenaPosition),
        closedPositions: (house ? closedPositions : closedPositions.map(redactArenaPositionForPublic)).map(maskArenaPosition),
        latestReport: latestReport ? maskArenaSummary(latestReport) : null,
        paramChanges: house ? paramChanges : paramChanges.map(redactArenaParamChangeForPublic),
        generatedAt: now.toISOString(),
      };
    });
    if (!body) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    return publicJson(c, body);
  });

  routes.get('/agents/:id/events', async (c) => {
    const blocked = limited(c, 'events');
    if (blocked) return blocked;
    const id = c.req.param('id') ?? '';
    if (!AGENT_ID.test(id)) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    const query = eventsQuerySchema.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') });
    if (!query.success) return c.json({ error: 'after must be an event id; limit 1..100.', code: 'invalid_query' }, 400);
    const after = query.data.after ?? null;
    const limit = query.data.limit ?? 50;
    const now = deps.now();
    const body = await eventsCache.get(`${id}|${after ?? ''}|${limit}`, now.getTime(), async () => {
      const agent = await deps.readAgent(id);
      if (!agent) return null;
      // Codex r2 #2: a user agent's public stream is trades, param changes and
      // status only (no scan/pass/skip/addon/report, which can name private
      // add-on mints), with add-on sources redacted. The owner reads every
      // type through GET /me/events.
      // Content mask on every summary: it names the coin by its vendor symbol.
      const events = (agent.kind === 'house'
        ? await deps.readEvents(id, after, limit)
        : (await deps.readEvents(id, after, limit, ARENA_PUBLIC_USER_EVENT_TYPES)).map(publicUserEvent)).map(maskArenaSummary);
      return {
        agentId: id,
        events,
        lastId: events.length > 0 ? events[events.length - 1]!.id : after,
        generatedAt: now.toISOString(),
      };
    });
    if (!body) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    return publicJson(c, body, 2);
  });

  routes.get('/discovery', async (c) => {
    const blocked = limited(c, 'discovery');
    if (blocked) return blocked;
    const parsed = z.coerce.number().int().min(1).max(100).optional().safeParse(c.req.query('limit'));
    if (!parsed.success) return c.json({ error: 'limit must be 1..100.', code: 'invalid_query' }, 400);
    const limit = parsed.data ?? 50;
    const now = deps.now();
    const body = await discoveryCache.get(String(limit), now.getTime(), async () => ({
      // Vendor symbols and names pass the content mask; the mint stays the identifier.
      mints: (await deps.readDiscovery(limit, now)).map(maskArenaDiscoveryRow),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body, 10);
  });

  // The TV trade tape: newest entry and exit fills across ALL arena agents.
  // Item ids are `<type>:<event id>`, stable across polls (the 3D chips key on them).
  routes.get('/tape', async (c) => {
    const blocked = limited(c, 'tape');
    if (blocked) return blocked;
    const parsed = z.coerce.number().int().min(1).max(TAPE_MAX).optional().safeParse(c.req.query('limit'));
    if (!parsed.success) return c.json({ error: `limit must be 1..${TAPE_MAX}.`, code: 'invalid_query' }, 400);
    const limit = parsed.data ?? TAPE_DEFAULT;
    const now = deps.now();
    const body = await tapeCache.get(String(limit), now.getTime(), async () => ({
      // The coin symbol and the trader name pass the content mask (the TV board, the 3D chips, the LED ticker).
      items: (await deps.readTape(limit)).map(maskArenaTapeItem),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body);
  });

  routes.get('/contest', async (c) => {
    const blocked = limited(c, 'contest');
    if (blocked) return blocked;
    const now = deps.now();
    const body = await contestCache.get('contest', now.getTime(), async () => {
      const view = await deps.readContest(now);
      // The same leaderboard rows: trader names pass the content mask.
      return { ...view, top: view.top.map(maskArenaName), house: view.house.map(maskArenaName) };
    });
    return publicJson(c, body, 10);
  });

  routes.get('/addons', (c) => {
    const blocked = limited(c, 'addons');
    if (blocked) return blocked;
    return publicJson(c, {
      addons: deps.addonCatalog().map(publicAddon),
      paymentsEnabled: deps.addonPaymentsEnabled(),
      dailyCap: { defaultUsd: FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD, maxUsd: FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD },
      minIntervalS: ARENA_ADDON_MIN_INTERVAL_S,
    }, 60);
  });

  // ── Authed /me routes ────────────────────────────────────────────────────

  const auth: readonly MiddlewareHandler[] = options.auth ?? FLOOR_ARENA_AUTH_CHAIN;
  // ONE registration covers `/me` and every `/me/...` path. Hono's `/me/*`
  // matches `/me` itself and never a public sibling such as `/meh`, so this is
  // not the `router.use('/')` prefix trap noStorePrivate warns about: no public
  // route lives under `/me`. Registered AFTER the public GETs on purpose.
  routes.use('/me/*', ...auth, noStorePrivate);

  function identityOf(c: Context<ActivityAuthContext>): ActivityIdentity {
    return c.get('identity');
  }

  function writeBlocked(c: Context<ActivityAuthContext>, limiter: RateLimiter = writeLimiter) {
    if (limiter.check(`user:${identityOf(c).userId}`)) return null;
    return c.json({ error: 'Too many arena changes. Wait a minute.', code: 'rate_limited' }, 429);
  }

  async function myAgent(c: Context<ActivityAuthContext>): Promise<ArenaAgentRecord | null> {
    return deps.readAgentByOwner(identityOf(c).userId);
  }

  function noAgent(c: Context) {
    return c.json({ error: 'You have no arena agent yet. Launch one first.', code: 'no_agent' }, 404);
  }

  function forgetPublic() {
    // The owner just changed it: do not serve them a 5 s old profile.
    agentCache.clear();
    eventsCache.clear();
  }

  async function meBody(agent: ArenaAgentRecord | null, now: Date): Promise<ArenaMeResponse> {
    if (!agent) {
      return {
        agent: null, paymentAddress: null, provision: null, wallet: null, addons: [], stats: null, latestReport: null, withdraw: null,
      };
    }
    const catalog = new Map(deps.addonCatalog().map((addon) => [addon.id, addon]));
    const [stats, addonStats, latestReport, balance, withdraw] = await Promise.all([
      deps.readStats([agent.id], now),
      deps.readAddonStats(agent.id, utcDayStart(now)),
      deps.readLatestReport(agent.id),
      agent.provisionState === 'ready' && agent.clawpumpAgentId
        ? deps.readWalletBalance(agent.clawpumpAgentId).catch(() => null)
        : Promise.resolve(null),
      deps.readWithdrawSummary(agent.id),
    ]);
    const statsById = new Map(addonStats.map((row) => [row.addonId, row]));
    const addons: ArenaMyAddonStatus[] = [];
    for (const entry of agent.addons) {
      const item = catalog.get(entry.id);
      if (!item) continue;
      const stat = statsById.get(entry.id);
      addons.push({
        ...publicAddon(item),
        enabled: entry.enabled,
        dailyCapUsd: entry.dailyCapUsd,
        spentTodayUsd: stat?.spentTodayUsd ?? 0,
        lastCallAt: stat?.lastAt ? stat.lastAt.toISOString() : null,
        lastOk: stat?.lastOk ?? null,
        lastError: stat?.lastError ?? null,
      });
    }
    const publicAgent = toPublicAgent(agent);
    return {
      agent: publicAgent,
      paymentAddress: publicAgent.paymentAddress,
      provision: { state: agent.provisionState, error: agent.provisionError },
      wallet: publicAgent.paymentAddress
        ? {
            address: publicAgent.paymentAddress,
            usdc: balance?.usdc ?? null,
            sol: balance?.sol ?? null,
            updatedAt: balance?.updatedAt ?? null,
          }
        : null,
      addons,
      stats: stats.get(agent.id) ?? emptyStats(),
      latestReport,
      withdraw: {
        address: withdraw.address ? toWithdrawAddressView(withdraw.address, now) : null,
        open: withdraw.open ? toWithdrawalView(withdraw.open) : null,
      },
    };
  }

  routes.get('/me', async (c) => {
    return c.json(await meBody(await myAgent(c), deps.now()));
  });

  // The owner's FULL decision stream (every type, nothing redacted): scans,
  // passes, skips, add-on calls, provisioning, reports. Same cursor contract as
  // the public /agents/:id/events. Never cached (noStorePrivate on /me/*).
  routes.get('/me/events', async (c) => {
    const query = eventsQuerySchema.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') });
    if (!query.success) return c.json({ error: 'after must be an event id; limit 1..100.', code: 'invalid_query' }, 400);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const after = query.data.after ?? null;
    // Private, but a summary still names coins by their vendor symbol: the same content mask.
    const events = (await deps.readEvents(agent.id, after, query.data.limit ?? 50)).map(maskArenaSummary);
    return c.json({
      agentId: agent.id,
      events,
      lastId: events.length > 0 ? events[events.length - 1]!.id : after,
      generatedAt: deps.now().toISOString(),
    });
  });

  routes.post('/me/launch', async (c) => {
    const blocked = writeBlocked(c, launchLimiter);
    if (blocked) return blocked;
    const parsed = launchBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const body = parsed.data;
    if (body.mode === 'live') {
      return c.json({ error: 'Live trading is not available yet. Launch in paper mode.', code: 'live_not_available' }, 400);
    }
    if (body.mode !== 'paper') return invalidBody(c);
    const template = floorArenaTemplateById(body.templateId);
    if (!template) return c.json({ error: 'Unknown template.', code: 'unknown_template' }, 400);
    const params = validateFloorArenaParams(body.params);
    if (!params.ok) return c.json({ error: 'The strategy settings are not valid.', code: 'invalid_params', errors: params.errors }, 400);
    const addons = normaliseAddons(body.addons ?? [], deps.addonCatalog());
    if (!addons.ok) return c.json({ error: addons.error, code: addons.code }, 400);
    if (body.name !== undefined && !NAME_LETTER.test(body.name)) return nameNeedsLetter(c);
    // A house agent's display name (and its look-alikes) is reserved; the avatar-name fallback below too.
    if (body.name !== undefined && isFloorArenaReservedName(body.name)) return nameReserved(c);
    if (body.name !== undefined && isArenaTextOffensive(body.name)) return nameNotAllowed(c);

    const identity = identityOf(c);
    const now = deps.now();
    const result = await withKeyedMutex(`floor-arena-launch:${identity.userId}`, async () => {
      const existing = await deps.readAgentByOwner(identity.userId);
      if (existing) return { conflict: existing } as const;
      const avatarName = (await deps.readAvatarName(identity.avatarId)) ?? 'Arena Agent';
      const cleaned = avatarName.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, NAME_MAX);
      // Same letter rule as a typed name: an avatar named `4200` launches as 'Arena Agent'.
      const fallback = NAME_LETTER.test(cleaned) ? cleaned : 'Arena Agent';
      if (body.name === undefined && isFloorArenaReservedName(fallback)) return { reserved: true } as const;
      if (body.name === undefined && isArenaTextOffensive(fallback)) return { notAllowed: true } as const;
      const inserted = await deps.insertUserAgent({
        id: deps.newId(),
        ownerUserId: identity.userId,
        avatarId: identity.avatarId,
        name: body.name ?? fallback,
        templateId: template.id,
        params: params.params,
        addons: addons.addons,
        // Codex r3 #6: enrol only while the contest is open (strictly before endsAt).
        contestId: now.getTime() < new Date(FLOOR_ARENA_CONTEST.endsAt).getTime() ? FLOOR_ARENA_CONTEST.id : null,
      });
      return inserted ? ({ agent: inserted } as const) : ({ conflict: null } as const);
    });
    if ('reserved' in result) return nameReserved(c);
    if ('notAllowed' in result) return nameNotAllowed(c);
    if ('conflict' in result) {
      return c.json({
        error: 'This account already has an arena agent.',
        code: 'already_have_agent',
        agentId: result.conflict?.id ?? null,
      }, 409);
    }
    // Audit-contest B1: record the device + network behind each contest entry
    // (fp_hash, ip_prefix_hash from the request) for the P3 payout review.
    await deps.logArenaEvent(c, {
      eventType: ARENA_LAUNCH_EVENT,
      userId: identity.userId,
      avatarId: identity.avatarId,
      agentId: identity.kind === 'agent' ? identity.agentId : null,
      payload: {
        arenaAgentId: result.agent.id,
        templateId: result.agent.templateId,
        identityKind: identity.kind,
        contestId: result.agent.contestId,
      },
    });
    // Codex r19 (single writer): no ClawPump call here. The row starts
    // 'pending'; the engine leader creates the execution wallet on its next
    // provisioning tick (every 30 s).
    // The profile cache may hold a 404 for this id from a poll before launch.
    forgetPublic();
    return c.json({ agent: toPublicAgent(result.agent), paymentAddress: null }, 201);
  });

  async function applyParams(
    c: Context<ActivityAuthContext>,
    agent: ArenaAgentRecord,
    next: FloorArenaParams,
    source: 'user' | 'suggestion',
    reason: string | null,
    report?: { id: string; state: 'applied' },
  ) {
    const changes = diffFloorArenaParams(agent.params, next);
    if (changes.length === 0) {
      if (report) await deps.setReportState(report.id, agent.id, 'applied');
      return c.json({ agent: toPublicAgent(agent), changes, paramsVersion: agent.paramsVersion });
    }
    const written = await deps.updateParams({
      agentId: agent.id,
      expectedVersion: agent.paramsVersion,
      params: next,
      changes,
      source,
      reason,
      summary: describeChanges(changes, source === 'suggestion' ? 'Applied the analysis suggestion, changed' : 'Changed'),
      ...(report ? { report } : {}),
    });
    if (!written.ok) {
      return written.reason === 'report_not_pending'
        ? c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409)
        : c.json({ error: 'The settings changed at the same time. Reload and try again.', code: 'params_conflict' }, 409);
    }
    forgetPublic();
    const fresh = (await deps.readAgent(agent.id)) ?? agent;
    return c.json({ agent: toPublicAgent(fresh), changes, paramsVersion: written.paramsVersion });
  }

  routes.patch('/me/params', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = paramsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const params = validateFloorArenaParams(parsed.data.params);
    if (!params.ok) return c.json({ error: 'The strategy settings are not valid.', code: 'invalid_params', errors: params.errors }, 400);
    return applyParams(c, agent, params.params, 'user', parsed.data.reason ?? null);
  });

  routes.post('/me/seat', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = seatBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const { seated } = parsed.data;
    const seatIndex = seated ? parsed.data.seatIndex ?? null : null;
    if (agent.seated === seated && agent.seatIndex === seatIndex) return c.json({ agent: toPublicAgent(agent) });
    const summary = seated
      ? seatIndex === null ? 'Sat down at a desk. New entries are on.' : `Sat down at desk ${seatIndex + 1}. New entries are on.`
      : 'Stood up. No new entries; open positions still exit on their rules.';
    const updated = await deps.setSeat(agent.id, seated, seatIndex, summary);
    if (!updated) return noAgent(c);
    if (seated) {
      // Audit-contest B1: the device + network of whoever seats the agent (it starts trading).
      const identity = identityOf(c);
      await deps.logArenaEvent(c, {
        eventType: ARENA_SEAT_EVENT,
        userId: identity.userId,
        avatarId: identity.avatarId,
        agentId: identity.kind === 'agent' ? identity.agentId : null,
        payload: { arenaAgentId: agent.id, seatIndex, identityKind: identity.kind },
      });
    }
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  routes.post('/me/status', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = statusBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (agent.status === 'stopped') return c.json({ error: 'This arena agent is stopped.', code: 'agent_stopped' }, 409);
    if (agent.status === parsed.data.status) return c.json({ agent: toPublicAgent(agent) });
    const summary = parsed.data.status === 'paused'
      ? 'Paused. No new entries; open positions still exit on their rules.'
      : 'Resumed. New entries are on while seated.';
    const updated = await deps.setStatus(agent.id, parsed.data.status, summary);
    if (!updated) return noAgent(c);
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  routes.patch('/me/addons', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = addonsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const addons = normaliseAddons(parsed.data.addons, deps.addonCatalog());
    if (!addons.ok) return c.json({ error: addons.error, code: addons.code }, 400);
    const on = addons.addons.filter((addon) => addon.enabled);
    const summary = on.length === 0
      ? 'Paid add-ons are off.'
      : `Paid add-ons on: ${on.map((addon) => `${addon.id} (cap $${addon.dailyCapUsd.toFixed(2)}/day)`).join(', ')}.`;
    const updated = await deps.setAddons(agent.id, addons.addons, summary);
    if (!updated) return noAgent(c);
    // Codex r19 (single writer): this request writes ONLY the DB row (under the
    // per-agent advisory lock). The engine leader's x402 reconcile applies the
    // change on ClawPump on its next tick (every 30 s): off also while paused,
    // on only when not paused. No ClawPump call happens here.
    forgetPublic();
    return c.json(await meBody(updated, deps.now()));
  });

  routes.post('/me/suggestions/:reportId', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const reportId = c.req.param('reportId') ?? '';
    if (!z.string().uuid().safeParse(reportId).success) {
      return c.json({ error: 'Report not found.', code: 'report_not_found' }, 404);
    }
    const parsed = suggestionBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const report = await deps.readReport(reportId);
    if (!report || report.agentId !== agent.id) return c.json({ error: 'Report not found.', code: 'report_not_found' }, 404);
    if (report.suggestionState !== 'pending' || !report.suggestion) {
      return c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409);
    }
    if (parsed.data.action === 'dismiss') {
      const done = await deps.setReportState(report.id, agent.id, 'dismissed');
      if (!done) return c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409);
      forgetPublic();
      return c.json({ report: { ...report, suggestionState: 'dismissed' }, agent: toPublicAgent(agent) });
    }
    const { path, from, to, reason } = report.suggestion;
    // Same check the analysis tick runs: known leaf, never position_usd, valid
    // params, exactly one leaf changes.
    const evaluation = evaluateArenaSuggestion({ current: agent.params, path, to });
    if (!evaluation.ok) {
      if (evaluation.reason === 'no_change') {
        // The owner already set this value: the suggestion is satisfied.
        await deps.setReportState(report.id, agent.id, 'applied');
        return c.json({ agent: toPublicAgent(agent), changes: [], paramsVersion: agent.paramsVersion });
      }
      await deps.setReportState(report.id, agent.id, 'rejected');
      return c.json({
        error: 'The suggestion is outside the allowed settings.',
        code: 'invalid_params',
        errors: evaluation.errors ?? [`${path}: ${evaluation.reason}`],
      }, 400);
    }
    // Stale: the owner changed this setting after the report. Applying the old
    // "from X to Y" would silently overwrite the newer edit, so refuse.
    if (diffFloorArenaParams(agent.params, applyFloorArenaParamChange(agent.params, path, from)).length > 0) {
      await deps.setReportState(report.id, agent.id, 'rejected');
      return c.json({
        error: 'This setting changed after the report. The suggestion no longer applies.',
        code: 'suggestion_stale',
      }, 409);
    }
    return applyParams(c, agent, evaluation.next, 'suggestion', reason || null, { id: report.id, state: 'applied' });
  });

  routes.patch('/me/settings', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = settingsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (agent.autoApplySuggestions === parsed.data.autoApplySuggestions) return c.json({ agent: toPublicAgent(agent) });
    const updated = await deps.setAutoApply(
      agent.id,
      parsed.data.autoApplySuggestions,
      parsed.data.autoApplySuggestions
        ? 'Auto-apply is on: each 30-minute suggestion is applied and logged.'
        : 'Auto-apply is off: suggestions wait for one click.',
    );
    if (!updated) return noAgent(c);
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  // ── Wallet withdraw (P5, D34; contract §6). REAL MONEY. ──────────────────
  // Every handler below writes or reads DB rows only (I4): the engine leader
  // admits and sends. The arena row is ALWAYS the caller's own (myAgent), and no
  // body carries an arena id. The route checks no balance and no SOL: admission
  // does, under the add-on lock, against a live wallet read.

  function walletNotReady(c: Context) {
    return c.json({ error: "Your trader's wallet is not ready yet. Wait until provisioning ends.", code: 'wallet_not_ready' }, 409);
  }

  function invalidAddress(c: Context) {
    return c.json({ error: 'This is not a valid Solana wallet address.', code: 'invalid_address' }, 400);
  }

  function addressNotAllowed(c: Context) {
    return c.json({ error: 'You cannot use this address.', code: 'address_not_allowed' }, 400);
  }

  /** A provisioned user row with its ClawPump agent and wallet (the withdraw source). */
  function walletReady(agent: ArenaAgentRecord): boolean {
    return agent.kind === 'user' && agent.provisionState === 'ready' && !!agent.clawpumpAgentId && !!agent.clawpumpWallet;
  }

  function subjectOf(c: Context<ActivityAuthContext>): { kind: FloorArenaWithdrawSubjectKind; agentId: string | null } {
    const identity = identityOf(c);
    return identity.kind === 'agent' ? { kind: 'agent', agentId: identity.agentId } : { kind: 'human', agentId: null };
  }

  routes.post('/me/withdraw-address/challenge', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = withdrawChallengeBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const { address } = parsed.data;
    if (arenaDestinationProblem(address) !== null) return invalidAddress(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (!walletReady(agent)) return walletNotReady(c);
    if (address === agent.clawpumpWallet || (await deps.isArenaWallet(address))) return addressNotAllowed(c);
    const issued = await deps.issueWithdrawChallenge({
      agentId: agent.id,
      ownerUserId: identityOf(c).userId,
      address,
      nonce: bs58.encode(randomBytes(32)),
      now: deps.now(),
    });
    if (!issued.ok) {
      return c.json({
        error: `Too many open sign requests. Use one of them, or wait ${minutesCopy(FLOOR_ARENA_WITHDRAW_LIMITS.challengeTtlMs)}.`,
        code: 'too_many_challenges',
      }, 429);
    }
    return c.json({ nonce: issued.nonce, messageToSign: issued.message, expiresAt: issued.expiresAt.toISOString(), address });
  });

  routes.post('/me/withdraw-address', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = withdrawAddressBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const body = parsed.data;
    if (body.proof === 'signed' && arenaDestinationProblem(body.address) !== null) return invalidAddress(c);
    const identity = identityOf(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (!walletReady(agent)) return walletNotReady(c);
    const now = deps.now();
    const subject = subjectOf(c);
    let address: string;
    let activeAt: Date;
    let proof: { message: string | null; signature: string | null; challengeNonce: string | null };
    if (body.proof === 'signed') {
      address = body.address;
      if (address === agent.clawpumpWallet || (await deps.isArenaWallet(address))) return addressNotAllowed(c);
      // Single use: the challenge is spent (committed) BEFORE the signature is checked.
      const consumed = await deps.consumeWithdrawChallenge({ nonce: body.nonce, agentId: agent.id, ownerUserId: identity.userId, address });
      if (!consumed) {
        return c.json({ error: 'The sign request expired or was already used. Ask for a new one.', code: 'invalid_challenge' }, 401);
      }
      // The DESTINATION key signs the exact challenge text (domain-separated from the wallet-link message).
      let signatureBytes: Uint8Array;
      try {
        signatureBytes = bs58.decode(body.signature);
      } catch {
        signatureBytes = new Uint8Array(0);
      }
      const valid = signatureBytes.length === ARENA_SIGNATURE_BYTES
        && nacl.sign.detached.verify(new TextEncoder().encode(consumed.message), signatureBytes, bs58.decode(address));
      if (!valid) return c.json({ error: 'The wallet signature did not match. Ask for a new sign request.', code: 'invalid_signature' }, 400);
      activeAt = new Date(now.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.addressDelayMs);
      proof = { message: consumed.message, signature: body.signature, challengeNonce: body.nonce };
    } else {
      const linked = await deps.readLinkedWallet(identity.userId);
      if (!linked) {
        return c.json({ error: 'Your account has no linked wallet. Prove an address with a signature.', code: 'no_linked_wallet' }, 404);
      }
      address = linked.address;
      if (arenaDestinationProblem(address) !== null) return invalidAddress(c);
      if (address === agent.clawpumpWallet || (await deps.isArenaWallet(address))) return addressNotAllowed(c);
      // A wallet linked more than the delay ago is active now; a newer one waits the same delay as a signed address.
      const settled = linked.linkedAt.getTime() <= now.getTime() - FLOOR_ARENA_WITHDRAW_LIMITS.addressDelayMs;
      activeAt = settled ? now : new Date(now.getTime() + FLOOR_ARENA_WITHDRAW_LIMITS.addressDelayMs);
      proof = { message: null, signature: null, challengeNonce: null };
    }
    const result = await deps.setWithdrawAddress({
      agentId: agent.id,
      ownerUserId: identity.userId,
      address,
      proofKind: body.proof,
      ...proof,
      setBy: subject.kind,
      setByAgentId: subject.agentId,
      activeAt,
    });
    if (!result.ok) {
      return result.reason === 'same_address'
        ? c.json({ error: 'This address is already set.', code: 'same_address' }, 409)
        : walletNotReady(c);
    }
    // A FRESH clock for the state: the query stores GREATEST(activeAt, the DB's now()), which is a
    // few ms after `now` above, so an "active at once" linked wallet would read pending with `now`.
    return c.json({ address: toWithdrawAddressView(result.address, deps.now()) }, 201);
  });

  routes.post('/me/withdraw-address/revoke', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = withdrawRevokeBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const result = await deps.revokeWithdrawAddress({ agentId: agent.id, addressId: parsed.data.addressId, reason: 'owner' });
    if (!result.ok) {
      return result.reason === 'already_revoked'
        ? c.json({ error: 'This address is already removed.', code: 'already_revoked' }, 409)
        : c.json({ error: 'Withdraw address not found.', code: 'address_not_found' }, 404);
    }
    return c.json({ ok: true });
  });

  routes.post('/me/withdrawals', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return c.json({ error: 'Send an Idempotency-Key header (8 to 64 letters, digits, _ or -).', code: 'idempotency_key_required' }, 400);
    }
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return c.json({ error: 'The Idempotency-Key must be 8 to 64 letters, digits, _ or -.', code: 'idempotency_key_invalid' }, 400);
    }
    const parsed = withdrawRequestBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const { asset, amount } = parsed.data;
    const amountMode: FloorArenaWithdrawAmountMode = amount === 'max' ? 'max' : 'exact';
    let requestedAtomic: bigint | null = null;
    if (amountMode === 'exact') {
      requestedAtomic = parseWithdrawAmount(amount, asset);
      if (requestedAtomic === null) {
        return c.json({ error: WITHDRAW_REFUSALS.invalid_amount.error, code: 'invalid_amount' }, 400);
      }
      const minimum = asset === 'USDC' ? FLOOR_ARENA_WITHDRAW_LIMITS.minUsdcAtomic : FLOOR_ARENA_WITHDRAW_LIMITS.minSolLamports;
      if (requestedAtomic < BigInt(minimum)) {
        return c.json({ error: WITHDRAW_REFUSALS.below_minimum.error, code: 'below_minimum' }, 400);
      }
    }
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const subject = subjectOf(c);
    const result = await deps.requestWithdrawal({
      agentId: agent.id,
      ownerUserId: identityOf(c).userId,
      subjectKind: subject.kind,
      subjectAgentId: subject.agentId,
      idempotencyKey,
      asset,
      amountMode,
      requestedAtomic,
      now: deps.now(),
    });
    if (result.kind !== 'refused') {
      return result.kind === 'created'
        ? c.json({ withdrawal: toWithdrawalView(result.withdrawal) }, 202)
        : c.json({ withdrawal: toWithdrawalView(result.withdrawal), replay: true }, 200);
    }
    const refusal = WITHDRAW_REFUSALS[result.code];
    return c.json({
      error: refusal.error,
      code: result.code,
      ...(result.activeAt ? { activeAt: result.activeAt.toISOString() } : {}),
      ...(result.retryAt ? { retryAt: result.retryAt.toISOString() } : {}),
      ...(result.withdrawalId ? { withdrawalId: result.withdrawalId } : {}),
    }, refusal.status);
  });

  routes.get('/me/withdrawals', async (c) => {
    const query = withdrawListQuerySchema.safeParse({ limit: c.req.query('limit') });
    if (!query.success) return c.json({ error: 'limit must be 1..50.', code: 'invalid_query' }, 400);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const now = deps.now();
    const identity = identityOf(c);
    const [address, linked, rows, balance] = await Promise.all([
      deps.readWithdrawAddress(agent.id),
      deps.readLinkedWallet(identity.userId),
      deps.listWithdrawals(agent.id, query.data.limit ?? 20),
      // Display only (the 60 s cached summary, the same read as GET /me); admission reads the live balance.
      agent.provisionState === 'ready' && agent.clawpumpAgentId
        ? deps.readWalletBalance(agent.clawpumpAgentId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const paymentAddress = toPublicAgent(agent).paymentAddress;
    return c.json({
      agentId: agent.id,
      address: address ? toWithdrawAddressView(address, now) : null,
      linkedWallet: linked
        ? {
            address: linked.address,
            linkedAt: linked.linkedAt.toISOString(),
            activeNow: linked.linkedAt.getTime() <= now.getTime() - FLOOR_ARENA_WITHDRAW_LIMITS.addressDelayMs,
          }
        : null,
      withdrawals: rows.map(toWithdrawalView),
      // Atomic amounts and durations as JSON numbers (all are safe integers), exactly the shared constant.
      limits: FLOOR_ARENA_WITHDRAW_LIMITS,
      wallet: paymentAddress
        ? { address: paymentAddress, usdc: balance?.usdc ?? null, sol: balance?.sol ?? null, updatedAt: balance?.updatedAt ?? null }
        : null,
    });
  });

  routes.post('/me/withdrawals/:id/cancel', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const id = c.req.param('id') ?? '';
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Withdrawal not found.', code: 'withdrawal_not_found' }, 404);
    const raw = await readJson(c);
    if (raw !== undefined && !withdrawCancelBodySchema.safeParse(raw).success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const result = await deps.cancelWithdrawal(agent.id, id);
    if (!result.ok) {
      return result.reason === 'not_cancellable'
        ? c.json({ error: 'Only a withdrawal that is still waiting to send can be cancelled.', code: 'not_cancellable' }, 409)
        : c.json({ error: 'Withdrawal not found.', code: 'withdrawal_not_found' }, 404);
    }
    return c.json({ withdrawal: toWithdrawalView(result.withdrawal) });
  });

  return routes;
}

export const floorArenaRoutes = createFloorArenaRoutes();
