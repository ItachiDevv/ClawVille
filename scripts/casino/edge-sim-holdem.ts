/**
 * Phase 6 economy-fix sizing — Texas Hold'em FAUCET Monte Carlo (sims only).
 *
 * Drives the AS-BUILT `playHand` from `apps/api/src/services/holdem-engine.ts`
 * (6-max: human seat 0 + 5 deterministic house bots) and measures the HUMAN's
 * net chips per 100 hands at a few disclosed player policies.
 *
 * ── Why this is "the faucet" ─────────────────────────────────────────────────
 * Today the bots' chips are MINTED each hand (every seat is reset to its buy-in
 * — bots start fresh at BOT_STACK=100, the human at the buy-in), so any chips the
 * human nets OUT of the table are newly created CT entering the economy. There is
 * no rake and no treasury bank counterparty: the human's expected net per hand is
 * a pure faucet rate. This sim quantifies that faucet for weak vs decent play so
 * the economy-fix step can size the rake / bot strength / treasury-bank decision.
 *
 * ── Three disclosed policies bracket the faucet ──────────────────────────────
 *   (a) always-fold      — folds every decision → loses only the blinds it is
 *                          forced to post (the FLOOR of the faucet; most negative).
 *   (b) tight-aggressive — a simple TAG heuristic on the player-facing view
 *                          (hole strength + pot odds): value-bet/raise strong,
 *                          call decent with odds, fold trash. Approximates a
 *                          competent-but-not-solver human.
 *   (c) call-station     — never folds when it can call/check; never raises.
 *                          Sees every hand to showdown (a common weak human).
 *
 * Net per 100 hands at each policy = faucet rate. always-fold is the worst the
 * faucet ever gets; a winning policy (positive net) is the worst case for the
 * treasury (chips minted into the economy).
 *
 * ── Driving the human (engine takes a recorded script) ───────────────────────
 * The engine consumes a recorded `humanActions[]`. We build it turn-by-turn with
 * the route's OWN exported `peekState` (the exact player-facing in-progress view:
 * human hole + street-truncated board + toCall + currentBet + stack) and an
 * `isHandTerminal` probe (append a sentinel; "ran out of human actions" ⇒ the
 * human still has a turn). At each turn the policy decides from the SAME info a
 * real player sees — never from bot hole cards or undealt board. The button
 * rotates each hand (buttonSeat = handIndex % SEATS) to mirror a real session.
 *
 * ── Seeding (per CLAUDE.md sims rule) ────────────────────────────────────────
 * A FRESH 32-byte serverSeed (crypto.randomBytes via createServerSeed) per HAND
 * (hold'em uses a fresh per-hand deck — nonce isolates hands, cursor starts at 0),
 * so each hand samples an independent deck. The engine's shuffle + bot rolls come
 * ONLY from the HMAC stream; the random seed is the commit, never the draw.
 *
 * Does NOT modify any engine or route. Sims only.
 *
 * CLI:
 *   bun scripts/casino/edge-sim-holdem.ts [--hands 50000] [--buyin 100] [--client-seed deadbeef]
 *     [--policy fold,tag,station]
 */

import { performance } from 'node:perf_hooks';

import {
  playHand,
  evaluateBest5,
  HandCategory,
  SEATS,
  BIG_BLIND,
  type Card,
  type Rank,
  type HoldemActionRecord,
} from '../../apps/api/src/services/holdem-engine';
import { createServerSeed } from '../../apps/api/src/services/provable-rng';
import { peekState, runEngine } from '../../apps/api/src/routes/cove-holdem';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type PolicyName = 'fold' | 'tag' | 'station';

interface Cli {
  hands: number;
  buyin: bigint;
  clientSeed: string;
  policies: PolicyName[];
}

function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = { hands: 50_000, buyin: 100n, clientSeed: 'deadbeef', policies: ['fold', 'tag', 'station'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--hands') {
      const v = argv[++i];
      if (!v) throw new Error('--hands requires a value');
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--hands must be a positive integer, got ${v}`);
      cli.hands = n;
    } else if (a === '--buyin') {
      const v = argv[++i];
      if (!v) throw new Error('--buyin requires a value');
      const n = BigInt(v);
      if (n <= 0n) throw new Error(`--buyin must be > 0, got ${v}`);
      cli.buyin = n;
    } else if (a === '--client-seed') {
      const v = argv[++i];
      if (!v) throw new Error('--client-seed requires a value');
      cli.clientSeed = v;
    } else if (a === '--policy') {
      const v = argv[++i];
      if (!v) throw new Error('--policy requires a comma list of fold,tag,station');
      const parts = v.split(',').map((s) => s.trim()) as PolicyName[];
      for (const p of parts) {
        if (p !== 'fold' && p !== 'tag' && p !== 'station') throw new Error(`unknown policy '${p}'`);
      }
      cli.policies = parts;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: bun scripts/casino/edge-sim-holdem.ts [--hands 50000] [--buyin 100] [--client-seed deadbeef] [--policy fold,tag,station]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cli;
}

// ---------------------------------------------------------------------------
// Player-facing view + decision
// ---------------------------------------------------------------------------

interface PlayerView {
  hole: Card[];
  board: Card[];
  toCall: bigint;
  currentBet: bigint;
  stack: bigint;      // chips behind
  committed: bigint;  // chips already in this hand
  street: 'preflop' | 'flop' | 'turn' | 'river';
}

/** Chen-like preflop strength normalized to [0,1] — independent of the engine's
 * internal estimator (the human only sees their own two cards). */
function preflopStrength(hole: Card[]): number {
  if (hole.length !== 2) return 0;
  const rv = (r: Rank) =>
    ({ '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 }[r]);
  const a = rv(hole[0]!.rank)!;
  const b = rv(hole[1]!.rank)!;
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const suited = hole[0]!.suit === hole[1]!.suit;
  const pair = a === b;
  const gap = high - low;
  const highPts = high === 14 ? 10 : high === 13 ? 8 : high === 12 ? 7 : high === 11 ? 6 : high / 2;
  let pts: number;
  if (pair) {
    pts = Math.max(5, highPts * 2);
  } else {
    pts = highPts;
    if (suited) pts += 2;
    const gapPenalty = gap === 1 ? 0 : gap === 2 ? 1 : gap === 3 ? 2 : gap === 4 ? 4 : 5;
    pts -= gapPenalty;
    if (gap <= 1 && high < 12) pts += 1;
  }
  return Math.max(0, Math.min(0.99, (pts + 1) / 21));
}

/** Postflop made-hand strength in [0,1] from hole+board (5..7 cards). */
function postflopStrength(hole: Card[], board: Card[]): number {
  const known = [...hole, ...board];
  if (known.length < 5) return preflopStrength(hole);
  const rank = evaluateBest5(known);
  const base = rank.category / 9; // HighCard 0 … StraightFlush 0.889
  const topKicker = (rank.tiebreakers[0] ?? 2) / 14;
  // A made pair+ is meaningfully stronger; bump pairs that use a hole card.
  return Math.min(0.999, base + topKicker * (1 / 9) * 0.9);
}

function viewStrength(view: PlayerView): number {
  return view.street === 'preflop' ? preflopStrength(view.hole) : postflopStrength(view.hole, view.board);
}

/**
 * Decide a TAG action from the player-facing view. Heuristic (not a solver):
 *   - facing nothing owed (toCall===0): value-bet/raise strong hands (~2/3 pot),
 *     else check.
 *   - facing a bet: raise monsters; call when strength clears a pot-odds-adjusted
 *     threshold; else fold.
 * Returns a legal HoldemActionRecord (amount = TOTAL street commitment target).
 */
function decideTag(view: PlayerView): HoldemActionRecord {
  const strength = viewStrength(view);
  const pot = view.committed + view.toCall + estimateOpponentsPot(view); // rough pot for sizing
  const maxTotal = view.committed + view.stack; // shove ceiling (street total)

  if (view.toCall === 0n) {
    // Open bet or BB-option raise on a strong hand.
    const betThreshold = view.street === 'preflop' ? 0.62 : 0.55;
    if (strength >= betThreshold && view.stack > 0n) {
      const target = clampAggression(view, pot, maxTotal);
      if (target !== null && target > view.currentBet) {
        return view.currentBet === 0n
          ? { type: 'bet', amount: target.toString() }
          : { type: 'raise', amount: target.toString() };
      }
    }
    return { type: 'check' };
  }

  // Facing a bet.
  const callCost = view.toCall < view.stack ? view.toCall : view.stack;
  const potOdds = Number(callCost) / Number(pot + callCost);
  const raiseThreshold = view.street === 'preflop' ? 0.80 : 0.78;
  if (strength >= raiseThreshold && view.stack > callCost) {
    const target = clampAggression(view, pot, maxTotal);
    if (target !== null && target > view.currentBet) {
      return { type: 'raise', amount: target.toString() };
    }
    return { type: 'call' };
  }
  // Call threshold drops with better pot odds (cheap calls are fine).
  const callThreshold = 0.40 + potOdds * 0.5 - (view.street === 'preflop' ? 0.05 : 0);
  if (strength >= callThreshold) return { type: 'call' };
  return { type: 'fold' };
}

/** Roughly estimate the chips opponents have put in this hand for pot sizing.
 * The view only exposes the human's numbers + currentBet; assume the current
 * street bet is matched by ~1 active opponent as a conservative pot proxy. */
function estimateOpponentsPot(view: PlayerView): bigint {
  // currentBet × a small factor captures the live action without leaking bot info.
  return view.currentBet * 2n + BIG_BLIND * 2n;
}

/** A ~2/3-pot total-commitment target, clamped to a legal min and the stack. */
function clampAggression(view: PlayerView, pot: bigint, maxTotal: bigint): bigint | null {
  // Min legal raise-to ≈ currentBet + BB (engine seeds min-raise to BB / last
  // raise size). For an opening bet, min is BB. We size to ~2/3 pot above call.
  const callCost = view.currentBet > view.committed ? view.currentBet - view.committed : 0n;
  const raiseIncrement = ((pot + callCost) * 2n) / 3n;
  let target = view.currentBet + (raiseIncrement < BIG_BLIND ? BIG_BLIND : raiseIncrement);
  if (view.currentBet === 0n) {
    // Opening bet: target is a pure street total ≥ BB.
    target = raiseIncrement < BIG_BLIND ? BIG_BLIND : raiseIncrement;
  }
  if (target > maxTotal) target = maxTotal; // shove ceiling
  if (target <= view.currentBet && maxTotal > view.currentBet) target = maxTotal; // all-in for less is legal
  return target > view.committed ? target : null;
}

/** Call-station: check when free, call when facing a bet, never raise/fold. */
function decideStation(view: PlayerView): HoldemActionRecord {
  if (view.toCall === 0n) return { type: 'check' };
  return { type: 'call' };
}

function decide(policy: PolicyName, view: PlayerView): HoldemActionRecord {
  switch (policy) {
    case 'fold':
      // Fold whenever possible; if nothing is owed a fold is still legal (engine
      // accepts a fold with toCall===0 → seat folds). This is the floor policy.
      return { type: 'fold' };
    case 'tag':
      return decideTag(view);
    case 'station':
      return decideStation(view);
  }
}

// ---------------------------------------------------------------------------
// Drive ONE hand for a given policy, returning the human's net.
// ---------------------------------------------------------------------------

const SERVER_TABLE_CACHE = { clientSeed: 'deadbeef' };

interface HandMeta {
  handIndex: number;
  buttonSeat: number;
  startingStack: string;
}

/** True iff the engine needs another human action (human still to act). */
function needsHumanAction(
  table: { serverSeed: string; clientSeed: string },
  meta: HandMeta,
  actions: HoldemActionRecord[],
): boolean {
  try {
    runEngine(table, meta, actions);
    return false; // completed without needing more human input
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('ran out of human actions')) return true;
    throw err; // genuine illegal-script / engine error — surface it
  }
}

/** Derive the human's current street from the fold-peek action log. */
function deriveStreet(
  table: { serverSeed: string; clientSeed: string },
  meta: HandMeta,
  actions: HoldemActionRecord[],
): 'preflop' | 'flop' | 'turn' | 'river' {
  const full = runEngine(table, meta, [...actions, { type: 'fold' }]);
  for (let i = full.actionLog.length - 1; i >= 0; i--) {
    if (full.actionLog[i]!.isHuman) return full.actionLog[i]!.street;
  }
  return 'preflop';
}

function playPolicyHand(
  serverSeed: string,
  clientSeed: string,
  handIndex: number,
  buttonSeat: number,
  buyin: bigint,
  policy: PolicyName,
): bigint {
  const table = { serverSeed, clientSeed };
  const meta: HandMeta = { handIndex, buttonSeat, startingStack: buyin.toString() };
  const actions: HoldemActionRecord[] = [];

  for (let guard = 0; guard < 64; guard++) {
    if (!needsHumanAction(table, meta, actions)) break;

    const peek = peekState(table, meta, actions);
    const street = deriveStreet(table, meta, actions);
    const view: PlayerView = {
      hole: peek.humanHole as Card[],
      board: peek.board as Card[],
      toCall: BigInt(peek.toCall),
      currentBet: BigInt(peek.currentBet),
      stack: BigInt(peek.humanStack),
      committed: BigInt(peek.humanCommitted),
      street,
    };

    let action = decide(policy, view);
    // Defensive legality demotion: if a bet/raise target is illegal for the
    // engine, fall back to call (TAG/station never need this, but a clamp edge
    // could). We probe by attempting the engine and demoting on a throw.
    action = legalizeAction(table, meta, actions, action, view);
    actions.push(action);
  }

  const result = runEngine(table, meta, actions);
  return result.humanNet;
}

/**
 * Ensure `action` is accepted by the engine; if a bet/raise is illegal (e.g.
 * below min, above stack after clamp drift) demote it: raise→call, bet→check/call.
 * We test by appending the action + a fold sentinel for the NEXT human turn (so
 * "ran out" means accepted-so-far) and catching engine legality errors only.
 */
function legalizeAction(
  table: { serverSeed: string; clientSeed: string },
  meta: HandMeta,
  actions: HoldemActionRecord[],
  action: HoldemActionRecord,
  view: PlayerView,
): HoldemActionRecord {
  const candidate = [...actions, action];
  try {
    // If the engine runs OR asks for the next human action, the action was legal.
    runEngine(table, meta, candidate);
    return action;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('ran out of human actions')) return action; // legal; needs more turns
    // Illegal bet/raise → demote.
    if (action.type === 'raise') return view.toCall > 0n ? { type: 'call' } : { type: 'check' };
    if (action.type === 'bet') return { type: 'check' };
    if (action.type === 'check' && view.toCall > 0n) return { type: 'call' };
    // Unknown — fold to stay legal.
    return { type: 'fold' };
  }
}

// ---------------------------------------------------------------------------
// Simulation per policy
// ---------------------------------------------------------------------------

interface PolicyResult {
  policy: PolicyName;
  hands: number;
  netTotal: bigint;
  netSumSq: number; // for stdev / CI (in CT^2)
  wonHands: number;
  lostHands: number;
  evenHands: number;
  wallMs: number;
}

function runPolicy(cli: Cli, policy: PolicyName): PolicyResult {
  const res: PolicyResult = {
    policy,
    hands: 0,
    netTotal: 0n,
    netSumSq: 0,
    wonHands: 0,
    lostHands: 0,
    evenHands: 0,
    wallMs: 0,
  };
  const t0 = performance.now();
  const stride = cli.hands >= 10_000 ? Math.floor(cli.hands / 10) : 0;

  for (let i = 0; i < cli.hands; i++) {
    const serverSeed = createServerSeed().serverSeed; // fresh deck per hand
    const buttonSeat = i % SEATS; // rotate the button like a real table
    const net = playPolicyHand(serverSeed, cli.clientSeed, i, buttonSeat, cli.buyin, policy);

    res.hands++;
    res.netTotal += net;
    const nf = Number(net);
    res.netSumSq += nf * nf;
    if (net > 0n) res.wonHands++;
    else if (net < 0n) res.lostHands++;
    else res.evenHands++;

    if (stride > 0 && i > 0 && i % stride === 0) {
      const per100 = (Number(res.netTotal) / res.hands) * 100;
      process.stderr.write(`  [${policy}] ${((i / cli.hands) * 100).toFixed(0)}% (net/100 so far ${per100.toFixed(2)} CT)\n`);
    }
  }

  res.wallMs = performance.now() - t0;
  return res;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatReport(cli: Cli, results: PolicyResult[]): string {
  const lines: string[] = [];
  lines.push('═'.repeat(96));
  lines.push("Texas Hold'em FAUCET Monte Carlo — AS-BUILT engine (human seat 0 vs 5 deterministic bots)");
  lines.push('═'.repeat(96));
  lines.push('');
  lines.push(`Hands/policy:    ${cli.hands.toLocaleString()}`);
  lines.push(`Buy-in (reset/hand): ${cli.buyin}  ·  bots start at 100  ·  SB/BB = 1/2  ·  button rotates each hand`);
  lines.push(`Client seed:     ${cli.clientSeed}`);
  lines.push(`Fresh serverSeed per HAND (crypto.randomBytes; per-hand deck, nonce isolates hands)`);
  lines.push('');
  lines.push('FAUCET = human net CT / 100 hands. Bots are minted → human net is new CT entering the economy.');
  lines.push('Positive = chips minted to the player (worst for treasury). always-fold = the floor.');
  lines.push('');
  lines.push(
    [
      'policy'.padEnd(10),
      'hands'.padStart(9),
      'net total CT'.padStart(14),
      'net / 100 hands'.padStart(16),
      'CT / hand'.padStart(10),
      'won%'.padStart(7),
      'lost%'.padStart(7),
    ].join('  '),
  );
  lines.push('-'.repeat(96));
  for (const r of results) {
    const per100 = (Number(r.netTotal) / r.hands) * 100;
    const perHand = Number(r.netTotal) / r.hands;
    // CI on net/100: stdev of per-hand net × 100 / sqrt(hands) × 1.96, ×100-scale.
    const mean = perHand;
    const variance = Math.max(0, r.netSumSq / r.hands - mean * mean);
    const stdev = Math.sqrt(variance);
    const ci100 = (1.96 * stdev * 100) / Math.sqrt(r.hands);
    lines.push(
      [
        r.policy.padEnd(10),
        r.hands.toLocaleString().padStart(9),
        r.netTotal.toString().padStart(14),
        `${per100.toFixed(2)} ±${ci100.toFixed(2)}`.padStart(16),
        perHand.toFixed(4).padStart(10),
        ((r.wonHands / r.hands) * 100).toFixed(1).padStart(7),
        ((r.lostHands / r.hands) * 100).toFixed(1).padStart(7),
      ].join('  '),
    );
  }
  lines.push('-'.repeat(96));
  lines.push('');
  const fold = results.find((r) => r.policy === 'fold');
  if (fold) {
    const per100 = (Number(fold.netTotal) / fold.hands) * 100;
    lines.push(`FAUCET FLOOR (always-fold): ${per100.toFixed(2)} CT / 100 hands  (= forced blinds bled, ~the minimum loss).`);
  }
  lines.push('Interpretation: a policy with POSITIVE net/100 mints CT into the economy at that rate per 100 hands —');
  lines.push('that is the faucet size the rake / bot-strength / treasury-bank fix must close.');
  lines.push('═'.repeat(96));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  void SERVER_TABLE_CACHE; // documented seam; unused beyond clarity
  const cli = parseCli(process.argv.slice(2));
  process.stderr.write(
    `Holdem faucet sim: ${cli.hands.toLocaleString()} hands × ${cli.policies.length} policies (${cli.policies.join(', ')})\n\n`,
  );
  const results: PolicyResult[] = [];
  for (const p of cli.policies) {
    process.stderr.write(`  running policy '${p}' …\n`);
    results.push(runPolicy(cli, p));
  }
  process.stdout.write(formatReport(cli, results) + '\n');
}

main();
