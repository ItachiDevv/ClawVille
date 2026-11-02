import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { maskArenaDiscoveryRow } from './floor-arena/content-mask';
import { rowsOf, sanitizeArenaSymbol, sanitizeArenaTokenName } from './floor-arena/queries';

/**
 * Hydra's coin chatter (free-roaming NPC `hydra-analyst`).
 *
 * Hydra is an in-world character who "analyzes" random coins out loud and says whether she bought or
 * skipped each one, with a made-up reason. Her coins come from the keyless discovery feed table
 * `floor_discovery_mints` (DexScreener / GeckoTerminal / ClawPump / PumpPortal rows): one DB read, no
 * RPC, no Helius, no vendor call. `chain_verdict` is optional flavor (staging often has none).
 *
 * The picks are jokes. Nothing here trades, and the prompt text forbids buy advice or gain promises.
 */

export const HYDRA_NPC_ID = 'hydra-analyst';

export interface HydraCoin {
  mint: string;
  symbol: string;
  name: string | null;
  /** 'pass' | 'fail' from the stored chain check; null when there is none or it errored. */
  verdict: string | null;
}

const POOL_TTL_MS = 60_000;
const POOL_LIMIT = 64;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Per-caller wait for the pool load. A caller that waits longer gets null (Hydra riffs on "the tape").
 * The same value is the server-side `SET LOCAL statement_timeout`, so an abandoned query also stops.
 */
export const HYDRA_COIN_DEADLINE_MS = 1_500;

let pool: { dayStartMs: number; loadedAtMs: number; coins: HydraCoin[] } | null = null;
let inflight: Promise<HydraCoin[]> | null = null;
let deadlineMs = HYDRA_COIN_DEADLINE_MS;
let timeoutWarnedFor: Promise<HydraCoin[]> | null = null;

/** Test seam: drop the cached pool and the in-flight load, and restore the default deadline. */
export function __resetHydraCoinCacheForTests(): void {
  pool = null;
  inflight = null;
  timeoutWarnedFor = null;
  deadlineMs = HYDRA_COIN_DEADLINE_MS;
}

/** Test seam: shorten the per-caller deadline. */
export function __setHydraCoinDeadlineForTests(ms: number): void {
  deadlineMs = ms;
}

const TIMED_OUT = Symbol('hydra-coin-timeout');

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function verdictOf(value: unknown): string | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { pass?: unknown; error?: unknown };
  if (record.error !== undefined && record.error !== null) return null;
  if (record.pass === true) return 'pass';
  if (record.pass === false) return 'fail';
  return null;
}

function toCoin(row: Record<string, unknown>): HydraCoin | null {
  const mint = typeof row.mint === 'string' ? row.mint : '';
  if (!MINT_RE.test(mint)) return null;
  const rawSymbol = sanitizeArenaSymbol(row.symbol);
  const symbol = rawSymbol?.replace(/^\$+/, '') ?? '';
  if (symbol.length === 0) return null;
  const masked = maskArenaDiscoveryRow({ symbol, name: sanitizeArenaTokenName(row.name) });
  if (masked.masked) return null;
  return { mint, symbol, name: masked.name, verdict: verdictOf(row.chain_verdict) };
}

async function loadPool(now: Date): Promise<HydraCoin[]> {
  // The transaction exists only for SET LOCAL: the server cancels a stalled read after the deadline, so
  // an abandoned query does not hold a pooled connection. The caller-side race in pickHydraCoin also
  // covers a stall before SET LOCAL runs (pool checkout).
  const result = await db.transaction(async (tx) => {
    // Fixed numeric constant (never user input), safe under sql.raw.
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${HYDRA_COIN_DEADLINE_MS}`));
    // last_seen_at >= first_seen_at, so "last seen today" covers "first seen today" too.
    return tx.execute(sql`
      SELECT mint, symbol, name, chain_verdict
      FROM floor_discovery_mints
      WHERE last_seen_at >= ${utcDayStart(now).toISOString()}::timestamptz
        AND symbol IS NOT NULL
      ORDER BY random()
      LIMIT ${POOL_LIMIT}
    `);
  });
  const coins: HydraCoin[] = [];
  for (const row of rowsOf<Record<string, unknown>>(result)) {
    const coin = toCoin(row);
    if (coin) coins.push(coin);
  }
  return coins;
}

/** Postgres query_canceled (57014, raised by statement_timeout), also when wrapped as an error cause. */
function isStatementTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === '57014') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Random coin first/last seen in the current UTC day from floor_discovery_mints; masked/offensive rows
 * skipped; small in-memory pool cached ~60s (one DB query per minute max); returns null when none, on DB
 * error, or when the load takes longer than the deadline (never throws, never waits past the deadline).
 * A timed-out load is not cached: later callers share the same in-flight query (each with its own
 * deadline), and when it settles its result is cached as usual.
 */
export async function pickHydraCoin(): Promise<HydraCoin | null> {
  const now = new Date();
  const dayStartMs = utcDayStart(now).getTime();
  const fresh = pool !== null && pool.dayStartMs === dayStartMs && now.getTime() - pool.loadedAtMs < POOL_TTL_MS;
  if (!fresh) {
    if (!inflight) {
      inflight = loadPool(now)
        .catch((err: unknown): HydraCoin[] | null => {
          console.warn('[hydra-coin-chatter] discovery read failed:', err instanceof Error ? err.message : String(err));
          // A statement timeout is not "no coins today": do not cache it (Codex re-review 2026-10-31).
          return isStatementTimeout(err) ? null : [];
        })
        .then((coins) => {
          if (coins === null) {
            pool = null; // drop the expired pool too: never answer with yesterday's coins
            return [];
          }
          // Any other failed or empty read is cached, so a DB outage still costs one query per minute.
          pool = { dayStartMs, loadedAtMs: Date.now(), coins };
          return coins;
        })
        .finally(() => {
          inflight = null;
        });
    }
    const load = inflight;
    if ((await withDeadline(load, deadlineMs)) === TIMED_OUT) {
      if (timeoutWarnedFor !== load) {
        timeoutWarnedFor = load;
        console.warn(`[hydra-coin-chatter] discovery read exceeded ${deadlineMs} ms; answering without a coin`);
      }
      return null;
    }
  }
  // A shared query that started before UTC midnight can settle with yesterday's pool: never pick from it.
  const coins = pool !== null && pool.dayStartMs === dayStartMs ? pool.coins : [];
  if (coins.length === 0) return null;
  return coins[Math.floor(Math.random() * coins.length)] ?? null;
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** System-prompt addendum for the LLM chat path: names the coin ($SYMBOL, short mint like ABCD…WXYZ), tells the model to invent a quick, slightly gibberish analysis and say whether she bought or skipped it and why; when coin is null, tell her to riff on "the tape" generically. */
export function hydraCoinPromptContext(coin: HydraCoin | null): string {
  const rules =
    'Never tell the visitor to buy anything, never promise gains, never give price targets, and call it ' +
    '"not advice, just my circuits".';
  if (!coin) {
    return (
      'Your discovery feed is quiet right now. Riff on "the tape" in general: mutter about liquidity, holders, ' +
      'dev wallets, curve shapes and vibes in a quick, confident, slightly gibberish way, and say you are ' +
      `skipping everything until the tape wakes up. ${rules}`
    );
  }
  // Only the sanitized symbol (letters, digits, `$ . _ -`) and the base58 mint reach the prompt; the
  // vendor's free-text name stays out of it.
  const flavor =
    coin.verdict === 'pass'
      ? ' Its chain check came back clean, which you treat as a mild compliment.'
      : coin.verdict === 'fail'
        ? ' Its chain check came back flagged, which you treat as a red light on your visor.'
        : '';
  return (
    `You are mid-analysis on $${coin.symbol} (mint ${shortMint(coin.mint)}), a coin from today's ClawVille ` +
    `discovery feed.${flavor} Work it into your reply: a quick, confident, slightly gibberish analysis ` +
    '(liquidity, holders, dev wallet, curve shape, vibes), then say whether YOU bought it or skipped it and a ' +
    'made-up reason. Any numbers you mention are invented; never present them as real data. ' +
    rules
  );
}

type Line = (ticker: string, why: string) => string;

const SKIP_REASONS: readonly string[] = [
  'liquidity curve looks like a sneeze',
  'dev wallet keeps blinking at me',
  'top holders hold hands too tight',
  'chart has the posture of a wet noodle',
  'volume smells like three bots in a coat',
  'the ticker rhymes with nothing',
  'curve went vertical then forgot why',
  'holder count is doing interpretive dance',
];

const BUY_REASONS: readonly string[] = [
  'the candles hum in B minor',
  'holder spread looks like a healthy fern',
  'liquidity sat still for four whole blocks',
  'dev wallet went quiet, which I respect',
  'the curve has main character energy',
  'my left circuit tingled',
];

const SKIP_LINES: readonly Line[] = [
  (t, w) => `${t}... ${w}, skipped. next.`,
  (t, w) => `scanning ${t}. ${w}. skip. not advice, just my circuits.`,
  (t, w) => `${t}? ${w}. passed on it.`,
  (t, w) => `ran ${t} through the hex grid: ${w}. skipped.`,
  (t, w) => `${t} holders, liq, dev wallet... ${w}. nope. next ticker.`,
  (t, w) => `no on ${t}. ${w}.`,
  (t, w) => `${t}: ${w}. hard skip, filed under maybe never.`,
];

const BUY_LINES: readonly Line[] = [
  (t, w) => `${t}... ${w}. bought a tiny bag. not advice.`,
  (t, w) => `bought a crumb of ${t}. ${w}.`,
  (t, w) => `${t} pinged my sensors: ${w}. small buy.`,
  (t, w) => `ok ${t}. ${w}. in, tiny size, circuits only.`,
  (t, w) => `${t} curve check... ${w}. bought. probably wrong.`,
  (t, w) => `took a nibble of ${t}, ${w}. next.`,
  (t, w) => `${t}. ${w}. bought it, then argued with myself.`,
];

const ALL_LINES: readonly Line[] = [...SKIP_LINES, ...BUY_LINES];

const TAPE_LINES: readonly string[] = [
  'tape is quiet... every liquidity curve looks like a sneeze. skipping everything. next.',
  'scanning the tape. holders, curves, dev wallets... all static. not advice, just my circuits.',
  'feed is dry. my circuits are analyzing the concept of a coin.',
  'no new tickers on my grid. skipped the void. next.',
  'tape check: flat, flat, sneeze, flat. no buys.',
];

function pick<T>(list: readonly T[], rand: () => number): T {
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(rand() * list.length)));
  return list[index]!;
}

/** Template (NO LLM) one-liner for ambient bubbles, e.g. "$BONKZ... liquidity curve looks like a sneeze, skipped. next." — pick from ≥12 varied templates with buy/skip outcomes and made-up reasons; deterministic given rand; ≤140 chars; null coin → generic tape-muttering line. */
export function hydraAmbientLine(coin: HydraCoin | null, rand: () => number = Math.random): string {
  if (!coin) return pick(TAPE_LINES, rand);
  const line = pick(ALL_LINES, rand);
  const why = pick(SKIP_LINES.includes(line) ? SKIP_REASONS : BUY_REASONS, rand);
  return line(`$${coin.symbol}`, why);
}
