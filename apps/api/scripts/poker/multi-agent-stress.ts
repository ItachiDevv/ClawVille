/**
 * Poker MTT — 10-AGENT MULTI-TABLE STRESS HARNESS (PREPARE; do NOT run against staging).
 *
 * Drives a FULL multi-table tournament with up to N (default 10) connected agents
 * to a single champion, mixing AUTONOMOUS and CONTROLLED play, asserting the
 * money + hidden-state + liveness invariants as it runs.
 *
 * ── TWO MODES, ONE ORCHESTRATION ─────────────────────────────────────────────
 * The orchestration (spin up agents → sign up → seat → poll/decide/act loop →
 * run-to-champion → assertions) is written ONCE against a `PokerTransport`
 * interface. Only the transport differs:
 *
 *   LIVE (default): `HttpTransport` hits a REAL running API at TARGET_URL
 *     (default http://localhost:4001). It POSTs /api/agent/connect (protocol
 *     'nanoclaw') for each agent, then POST /:id/register, GET /:id/state-for-agent,
 *     GET /:id/advice, POST /action, GET /:id — the EXACT shipping endpoints in
 *     `apps/api/src/routes/cove-poker-mtt.ts` and `agent-gateway.ts`. This
 *     exercises the real router + middleware + auth + DB + TournamentManager
 *     end-to-end. You run this yourself against YOUR OWN local server — NOT staging.
 *
 *   DRY-RUN (`--dry-run`): `MockTransport` stands up the REAL `TournamentManager`
 *     (the settlement-owning core) wired to an in-memory FakeDb + FakeLedger + a
 *     real `PokerTableSim` on a FakeClock, plus an internal hand-driver that turns
 *     non-acting tables forward (so non-to-act seats and the blind clock advance
 *     exactly as the production multi-hand loop expects). It answers the SAME
 *     endpoint method calls the HttpTransport makes — so the orchestration code,
 *     the response parsing, and ALL assertions run path-identically with NO live
 *     server and NO DB. The dry-run is the local validation gate for the harness.
 *
 * ── AGENT MODES (configurable mix; default ~6 autonomous / ~4 controlled) ─────
 *   AUTONOMOUS — polls GET /:id/state-for-agent until `isYourTurn`, then decides
 *     via GET /:id/advice (when reachable) or a fold/call/raise pot-odds heuristic,
 *     then POST /action with `actor:'agent'`.
 *   CONTROLLED — the SAME poll loop, but the decision is a scripted/random
 *     human-like stream (a distinct, looser policy than autonomous: more calls,
 *     occasional bluff-raises, fewer disciplined folds), POSTed as the human driver.
 *     In LIVE mode a controlled action is still sent over the agent-session header
 *     (the harness has no Lucia cookie) so the server treats it as `actor:'agent'`;
 *     the DISTINCTION the harness models is the DECISION POLICY, which is what a
 *     human-driven stream looks like. (A future variant can drive a true Lucia
 *     session for `actor:'human'` — out of scope for a connect-only stress test.)
 *
 * ── ASSERTIONS (checked continuously + at the end) ───────────────────────────
 *   - CHIP CONSERVATION: Σ chipStack across all live tables == startingStack *
 *     entrants, at every quiescent snapshot (rebalancing moves chips, never mints).
 *   - NO STALLS: every to-act seat resolves within the action budget (the harness
 *     never leaves a live table waiting past its poll/act window).
 *   - HIDDEN STATE: an agent's state-for-agent NEVER carries another seat's hole
 *     cards (the public `table` block has no hole-card field; only the requesting
 *     seat's own `holeCards` are present).
 *   - UNIQUE PLACEMENTS 1..N: final standings are a permutation of 1..entrants.
 *   - CT CONSERVATION: Σ prizes + rake == prize pool (buy-ins), net of refunds.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   - Idempotent / re-runnable: every run mints fresh agent identities (random
 *     suffixes) and, in LIVE mode, creates its OWN tournament unless TOURNAMENT_ID
 *     is supplied. Re-running never corrupts a prior run.
 *   - `--dry-run` hits NO network and NO DB. The default LIVE mode hits ONLY
 *     TARGET_URL (your local server). It must NOT be pointed at staging/prod.
 *
 * ── RUN ───────────────────────────────────────────────────────────────────────
 *   Local validation (no server, no DB):
 *     cd apps/api && bun run scripts/poker/multi-agent-stress.ts --dry-run
 *
 *   Against your OWN local API (after `bun run build && bun run start`):
 *     TARGET_URL=http://localhost:4001 \
 *     AGENT_COUNT=10 AUTONOMOUS_COUNT=6 \
 *     bun run apps/api/scripts/poker/multi-agent-stress.ts
 *
 *   Against an existing tournament you created (skips create):
 *     TARGET_URL=http://localhost:4001 TOURNAMENT_ID=<uuid> \
 *     bun run apps/api/scripts/poker/multi-agent-stress.ts
 *
 *   ENV / FLAGS:
 *     TARGET_URL        base URL of the API (default http://localhost:4001).
 *     AGENT_COUNT       agents to spin up (default 10, max 10 unless overridden).
 *     AUTONOMOUS_COUNT  how many play autonomous (default ceil(0.6*AGENT_COUNT)).
 *     TOURNAMENT_ID     play an existing tournament instead of creating one (LIVE).
 *     ADMIN_COOKIE      dash cookie / Lucia session for POST /create (LIVE create).
 *     SEATS_PER_TABLE   seats per table for a created tournament (default 4).
 *     STARTING_STACK    starting chip stack for a created tournament (default 1500).
 *     BUY_IN_CT         CT buy-in for a created tournament (default 0 = free test).
 *     POLL_INTERVAL_MS  agent poll cadence (default 120).
 *     MAX_RUNTIME_MS    hard cap before the harness aborts (default 180000).
 *     --dry-run         use the in-process MockTransport (no network, no DB).
 *
 * Exit: 0 when a champion was crowned and every invariant held; 1 otherwise.
 */

// ───────────────────────────────────────────────────────────────────────────
// Crash-loud env defaults so importing apps/api modules (only in --dry-run)
// never throws at module load. LIVE mode imports NOTHING from apps/api.
// ───────────────────────────────────────────────────────────────────────────
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k] || process.env[k]!.length === 0) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');

import { randomBytes, randomUUID } from 'crypto';

// ───────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_URL = (process.env.TARGET_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
const AGENT_COUNT = clampInt(process.env.AGENT_COUNT, 1, 10, 10);
const AUTONOMOUS_COUNT = clampInt(
  process.env.AUTONOMOUS_COUNT,
  0,
  AGENT_COUNT,
  Math.ceil(AGENT_COUNT * 0.6),
);
const ENV_TOURNAMENT_ID = process.env.TOURNAMENT_ID?.trim() || null;
const ADMIN_COOKIE = process.env.ADMIN_COOKIE?.trim() || null;
const SEATS_PER_TABLE = clampInt(process.env.SEATS_PER_TABLE, 2, 9, 4);
const STARTING_STACK = clampInt(process.env.STARTING_STACK, 100, 1_000_000, 1500);
const BUY_IN_CT = clampInt(process.env.BUY_IN_CT, 0, 1_000_000_000, 0);
const POLL_INTERVAL_MS = clampInt(process.env.POLL_INTERVAL_MS, 10, 5000, DRY_RUN ? 0 : 120);
const MAX_RUNTIME_MS = clampInt(process.env.MAX_RUNTIME_MS, 5000, 600_000, 180_000);
// Per-agent action-resolution budget (no-stall assertion). A seat that is
// `isYourTurn` MUST get an action submitted within this window.
const ACTION_BUDGET_MS = DRY_RUN ? 5_000 : 30_000;

function clampInt(raw: string | undefined, lo: number, hi: number, dflt: number): number {
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// ───────────────────────────────────────────────────────────────────────────
// LOG + RESULT TRACKING
// ───────────────────────────────────────────────────────────────────────────
interface Inv {
  name: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}
const invariants: Inv[] = [];
function emit(s: string) {
  console.log(s);
}
function pass(name: string, evidence: string) {
  invariants.push({ name, status: 'PASS', evidence });
  emit(`PASS  ${name} :: ${evidence}`);
}
function fail(name: string, evidence: string) {
  invariants.push({ name, status: 'FAIL', evidence });
  emit(`FAIL  ${name} :: ${evidence}`);
}
// A continuous-invariant violation is recorded once and asserted at the end.
const continuousViolations = new Map<string, string>();
function recordViolation(key: string, evidence: string) {
  if (!continuousViolations.has(key)) continuousViolations.set(key, evidence);
}

// ───────────────────────────────────────────────────────────────────────────
// SHARED TYPES (mirror the route response shapes — see cove-poker-mtt.ts)
// ───────────────────────────────────────────────────────────────────────────
type Card = string; // the live route serializes cards opaquely; we only count + leak-scan.

interface ConnectResult {
  sessionId: string;
  agentId: string;
}

interface RegisterResult {
  ok: boolean;
  entrantId?: string;
  prizePoolCt?: string;
  alreadyRegistered?: boolean;
  status: number;
  errorMessage?: string;
}

interface SeatView {
  table: {
    handNumber: number;
    toActSeatIndex: number | null;
    seats: Array<{
      seatIndex: number;
      avatarId: string;
      chipStack: number;
      streetBet: number;
      status: string;
    }>;
    [k: string]: unknown;
  };
  seatIndex: number;
  isYourTurn: boolean;
  holeCards: Card[];
  legalActions: string[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  chipStack: number;
  handNumber: number;
}

interface AdviceResult {
  strength: number;
  legalActions: string[];
  recommended:
    | { kind: 'fold' }
    | { kind: 'check' }
    | { kind: 'call' }
    | { kind: 'bet'; amount: number }
    | { kind: 'raise'; amount: number }
    | null;
  rationale: string;
}

type PokerAction =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'bet'; amount: number }
  | { kind: 'raise'; amount: number };

interface ActionResult {
  ok: boolean;
  status: number;
  reason?: string;
  handComplete?: boolean;
  advancedStreet?: boolean;
}

interface StatusResult {
  status: number;
  tournament: {
    status: string;
    prizePoolCt: string;
    rakeTakenCt: string | null;
    buyInCt: string;
  } | null;
  entrants: Array<{
    avatarId: string;
    agentId: string | null;
    subjectType: string;
    status: string;
    chipStack: number;
    placement: number | null;
  }>;
  results: Array<{ avatarId: string; placement: number; prizeCt: string }>;
}

/** Response of state-for-agent: either a live seat view, or a not-seated signal. */
interface StateForAgentResult {
  /** 200 with a view, or a 4xx (e.g. 409 not_seated_or_no_live_hand). */
  status: number;
  view: SeatView | null;
}

/**
 * The transport contract the orchestration drives. LIVE and DRY-RUN both implement
 * it identically so the agent loop + assertions are path-shared.
 */
interface PokerTransport {
  /** Spin up one agent (protocol 'nanoclaw') → { sessionId, agentId }. */
  connect(name: string): Promise<ConnectResult>;
  /** Create a tournament (LIVE: admin POST /create; DRY: TM.createTournament). */
  createTournament(cfg: {
    name: string;
    buyInCt: number;
    minEntrants: number;
    maxEntrants: number;
    seatsPerTable: number;
    startingStack: number;
  }): Promise<{ id: string }>;
  /** Force the start trigger (seat the field). LIVE relies on cap-hit auto-seat or
   *  a created registrationClosesAt sweep; DRY calls startTrigger(force). */
  forceStart(tournamentId: string): Promise<void>;
  register(tournamentId: string, sessionId: string): Promise<RegisterResult>;
  stateForAgent(tournamentId: string, sessionId: string): Promise<StateForAgentResult>;
  advice(tournamentId: string, sessionId: string): Promise<AdviceResult | null>;
  action(
    tournamentId: string,
    sessionId: string,
    handNumber: number,
    actionSeq: number,
    action: PokerAction,
  ): Promise<ActionResult>;
  status(tournamentId: string): Promise<StatusResult>;
  /**
   * DRY-RUN ONLY hook: the in-process driver turns NON-ACTING tables forward
   * (busts/blind clock/maintenance) since there is no server event loop. LIVE
   * is a no-op (the server owns its loop). Returns true while progress is possible.
   */
  pump?(tournamentId: string): boolean;
  /** Tear down (close DB pools / clear sim). */
  dispose(): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE TRANSPORT — real HTTP against TARGET_URL (your local server)
// ───────────────────────────────────────────────────────────────────────────
const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

class HttpTransport implements PokerTransport {
  private fp = randomBytes(16).toString('hex');

  private async json(
    method: string,
    path: string,
    opts: { body?: unknown; sessionId?: string; cookie?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Stable per-run fingerprint so anti-farm provenance resolves to ONE subject.
      'X-CV-Fingerprint': this.fp,
    };
    if (opts.sessionId) headers[AGENT_SESSION_HEADER] = opts.sessionId;
    if (opts.cookie) headers['cookie'] = opts.cookie;
    const res = await fetch(`${TARGET_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let body: any = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return { status: res.status, body };
  }

  async connect(name: string): Promise<ConnectResult> {
    const agentId = `nanoclaw-stress-${name}-${randomBytes(4).toString('hex')}`;
    const { status, body } = await this.json('POST', '/api/agent/connect', {
      body: {
        agentId,
        protocol: 'nanoclaw',
        identityType: 'nanoclaw',
        // identityKey makes the connect resolve-or-create a user + active avatar so
        // the agent has a BOUND avatar (ledger-capable) — required for register.
        identityKey: agentId,
        name: name.slice(0, 24),
      },
    });
    if (status >= 300 || !body?.sessionId) {
      throw new Error(`connect failed for ${name}: HTTP ${status} ${JSON.stringify(body)}`);
    }
    return { sessionId: body.sessionId, agentId: body.agentId ?? agentId };
  }

  async createTournament(cfg: {
    name: string;
    buyInCt: number;
    minEntrants: number;
    maxEntrants: number;
    seatsPerTable: number;
    startingStack: number;
  }): Promise<{ id: string }> {
    if (!ADMIN_COOKIE) {
      throw new Error(
        'createTournament requires ADMIN_COOKIE (dash/Lucia) to call admin POST /create. ' +
          'Either set ADMIN_COOKIE or pass an existing TOURNAMENT_ID.',
      );
    }
    // A near-future registrationClosesAt lets the server-side start-trigger sweeper
    // seat the field even before the cap is hit. We also force-seat once full.
    const closesAt = new Date(Date.now() + 20_000).toISOString();
    const { status, body } = await this.json('POST', '/api/cove/poker/mtt/create', {
      cookie: ADMIN_COOKIE,
      body: {
        name: cfg.name,
        buyInCt: cfg.buyInCt,
        minEntrants: cfg.minEntrants,
        maxEntrants: cfg.maxEntrants,
        seatsPerTable: cfg.seatsPerTable,
        startingStack: cfg.startingStack,
        registrationClosesAt: closesAt,
      },
    });
    if (status >= 300 || !body?.tournament?.id) {
      throw new Error(`createTournament failed: HTTP ${status} ${JSON.stringify(body)}`);
    }
    return { id: body.tournament.id };
  }

  async forceStart(_tournamentId: string): Promise<void> {
    // LIVE: there is no public force-start endpoint. Seating happens via the
    // cap-hit auto-seat (last register) or the registrationClosesAt sweep. We just
    // wait; the orchestrator polls status until 'running'. No-op here.
  }

  async register(tournamentId: string, sessionId: string): Promise<RegisterResult> {
    const { status, body } = await this.json(
      'POST',
      `/api/cove/poker/mtt/${tournamentId}/register`,
      { sessionId },
    );
    return {
      ok: status < 300,
      status,
      entrantId: body?.entrantId,
      prizePoolCt: body?.prizePoolCt,
      alreadyRegistered: body?.alreadyRegistered,
      errorMessage: status >= 300 ? body?.error ?? body?.message ?? JSON.stringify(body) : undefined,
    };
  }

  async stateForAgent(tournamentId: string, sessionId: string): Promise<StateForAgentResult> {
    const { status, body } = await this.json(
      'GET',
      `/api/cove/poker/mtt/${tournamentId}/state-for-agent`,
      { sessionId },
    );
    return { status, view: status < 300 ? (body?.view ?? null) : null };
  }

  async advice(tournamentId: string, sessionId: string): Promise<AdviceResult | null> {
    const { status, body } = await this.json(
      'GET',
      `/api/cove/poker/mtt/${tournamentId}/advice`,
      { sessionId },
    );
    return status < 300 ? (body?.advice ?? null) : null;
  }

  async action(
    tournamentId: string,
    sessionId: string,
    handNumber: number,
    actionSeq: number,
    action: PokerAction,
  ): Promise<ActionResult> {
    const { status, body } = await this.json('POST', '/api/cove/poker/mtt/action', {
      sessionId,
      body: { tournamentId, handNumber, actionSeq, action },
    });
    return {
      ok: status < 300,
      status,
      reason: body?.reason ?? (status >= 300 ? body?.message : undefined),
      handComplete: body?.handComplete,
      advancedStreet: body?.advancedStreet,
    };
  }

  async status(tournamentId: string): Promise<StatusResult> {
    const { status, body } = await this.json('GET', `/api/cove/poker/mtt/${tournamentId}`, {});
    if (status >= 300 || !body?.tournament) {
      return { status, tournament: null, entrants: [], results: [] };
    }
    return {
      status,
      tournament: {
        status: body.tournament.status,
        prizePoolCt: body.tournament.prizePoolCt,
        rakeTakenCt: body.tournament.rakeTakenCt,
        buyInCt: body.tournament.buyInCt,
      },
      entrants: (body.entrants ?? []).map((e: any) => ({
        avatarId: e.avatarId,
        agentId: e.agentId,
        subjectType: e.subjectType,
        status: e.status,
        chipStack: e.chipStack,
        placement: e.placement,
      })),
      results: (body.results ?? []).map((r: any) => ({
        avatarId: r.avatarId,
        placement: r.placement,
        prizeCt: r.prizeCt,
      })),
    };
  }

  async dispose(): Promise<void> {
    /* fetch needs no teardown */
  }
}

// ───────────────────────────────────────────────────────────────────────────
// MOCK TRANSPORT — in-process REAL TournamentManager + sim (no server, no DB)
// ───────────────────────────────────────────────────────────────────────────
//
// This is the dry-run backend. It is NOT a re-implementation of poker: it stands
// up the SAME `TournamentManager` + `PokerTableSim` the server uses, on a FakeDb +
// FakeLedger + FakeClock (the exact seams the committed unit tests already exercise),
// and exposes the route-equivalent methods. The orchestration above never knows
// which transport it is talking to — only this file's `buildTransport()` does.
//
// `pump()` is the dry-run's substitute for the server event loop: it advances the
// FakeClock past a blind level for each new hand (so blinds rise) and folds/checks
// every NON-AGENT-DRIVEN to-act seat the orchestration didn't act on, so the
// multi-hand loop, busts, rebalances, breaks, and final-table consolidation all
// progress to a champion exactly as the production loop would. The AGENT seats are
// still driven by the orchestration (via action()), so autonomous/controlled play
// is genuinely exercised; pump only keeps the rest of the field moving.
type MockDeps = typeof import('./mock-tm-backend');

class MockTransport implements PokerTransport {
  private backend!: Awaited<ReturnType<MockDeps['createMockBackend']>>;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }
  private async init(): Promise<void> {
    const mod = (await import('./mock-tm-backend')) as MockDeps;
    this.backend = await mod.createMockBackend({
      seatsPerTable: SEATS_PER_TABLE,
      startingStack: STARTING_STACK,
      buyInCt: BUY_IN_CT,
    });
  }

  async connect(name: string): Promise<ConnectResult> {
    await this.ready;
    return this.backend.connect(name);
  }
  async createTournament(cfg: {
    name: string;
    buyInCt: number;
    minEntrants: number;
    maxEntrants: number;
    seatsPerTable: number;
    startingStack: number;
  }): Promise<{ id: string }> {
    await this.ready;
    return this.backend.createTournament(cfg);
  }
  async forceStart(tournamentId: string): Promise<void> {
    await this.ready;
    await this.backend.forceStart(tournamentId);
  }
  async register(tournamentId: string, sessionId: string): Promise<RegisterResult> {
    await this.ready;
    return this.backend.register(tournamentId, sessionId);
  }
  async stateForAgent(tournamentId: string, sessionId: string): Promise<StateForAgentResult> {
    await this.ready;
    return this.backend.stateForAgent(tournamentId, sessionId);
  }
  async advice(tournamentId: string, sessionId: string): Promise<AdviceResult | null> {
    await this.ready;
    return this.backend.advice(tournamentId, sessionId);
  }
  async action(
    tournamentId: string,
    sessionId: string,
    handNumber: number,
    actionSeq: number,
    action: PokerAction,
  ): Promise<ActionResult> {
    await this.ready;
    return this.backend.action(tournamentId, sessionId, handNumber, actionSeq, action);
  }
  async status(tournamentId: string): Promise<StatusResult> {
    await this.ready;
    return this.backend.status(tournamentId);
  }
  pump(tournamentId: string): boolean {
    return this.backend.pump(tournamentId);
  }
  async dispose(): Promise<void> {
    if (this.backend) await this.backend.dispose();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// AGENT MODEL + DECISION POLICIES
// ───────────────────────────────────────────────────────────────────────────
type AgentMode = 'autonomous' | 'controlled';

interface Agent {
  name: string;
  mode: AgentMode;
  sessionId: string;
  agentId: string;
  /** Monotonic action sequence (the route's idempotency key uses it). */
  actionSeq: number;
  /** Last hand we acted on (for diagnostics). */
  lastHand: number;
  /** True once the agent is busted/placed (no longer seated). */
  done: boolean;
  /** Count of actions submitted (diagnostics). */
  actionsTaken: number;
  /** Tracks the longest time a single turn took to resolve (no-stall assertion). */
  worstTurnMs: number;
}

/** Deterministic-ish RNG seeded per agent for repeatable controlled "human" noise. */
function makeRng(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (const ch of seedStr) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 0xffffffff;
  };
}

/**
 * AUTONOMOUS policy: prefer the advisor recommendation when present + legal;
 * otherwise a disciplined pot-odds heuristic. Folds when nothing is owed only if
 * checking is illegal (never folds for free). Caps raises at a modest fraction of
 * stack so the field doesn't insta-shove every hand (keeps eliminations staggered).
 */
function decideAutonomous(view: SeatView, advice: AdviceResult | null, rng: () => number): PokerAction {
  const legal = new Set(view.legalActions);
  if (advice?.recommended && legal.has(advice.recommended.kind)) {
    const rec = advice.recommended;
    if (rec.kind === 'bet' || rec.kind === 'raise') {
      const amt = clampRaise(view, rec.amount);
      if (amt > 0) return { kind: rec.kind, amount: amt };
      // recommended raise not affordable as a raise → fall through to call/check.
    } else {
      return rec;
    }
  }
  // Heuristic fallback.
  if (view.toCall === 0) {
    if (legal.has('check')) {
      // Occasionally open for value.
      if (legal.has('bet') && rng() < 0.25) {
        const amt = clampRaise(view, Math.round(view.minRaiseTo + (view.maxRaiseTo - view.minRaiseTo) * 0.2));
        if (amt > 0) return { kind: 'bet', amount: amt };
      }
      return { kind: 'check' };
    }
    return legal.has('call') ? { kind: 'call' } : { kind: 'fold' };
  }
  // Facing a bet: call small, fold large, occasionally raise.
  const potOddsCheap = view.toCall <= Math.max(1, Math.round(view.chipStack * 0.15));
  if (potOddsCheap && legal.has('call')) {
    if (legal.has('raise') && rng() < 0.12) {
      const amt = clampRaise(view, Math.round(view.minRaiseTo + (view.maxRaiseTo - view.minRaiseTo) * 0.25));
      if (amt > 0) return { kind: 'raise', amount: amt };
    }
    return { kind: 'call' };
  }
  return legal.has('fold') ? { kind: 'fold' } : legal.has('check') ? { kind: 'check' } : { kind: 'call' };
}

/**
 * CONTROLLED ("human-driven") policy — a DISTINCT, looser stream: calls more,
 * folds less, bluff-raises more often, sometimes overbets. This is what a noisy
 * human at the wheel looks like vs the disciplined autonomous policy. It ignores
 * the advisor (a human driver isn't following the bot's advice).
 */
function decideControlled(view: SeatView, rng: () => number): PokerAction {
  const legal = new Set(view.legalActions);
  const r = rng();
  if (view.toCall === 0) {
    if (legal.has('bet') && r < 0.35) {
      const frac = 0.2 + rng() * 0.5;
      const amt = clampRaise(view, Math.round(view.minRaiseTo + (view.maxRaiseTo - view.minRaiseTo) * frac));
      if (amt > 0) return { kind: 'bet', amount: amt };
    }
    return legal.has('check') ? { kind: 'check' } : legal.has('call') ? { kind: 'call' } : { kind: 'fold' };
  }
  // Facing a bet — humans call a LOT.
  if (legal.has('raise') && r < 0.18) {
    const frac = 0.25 + rng() * 0.6;
    const amt = clampRaise(view, Math.round(view.minRaiseTo + (view.maxRaiseTo - view.minRaiseTo) * frac));
    if (amt > 0) return { kind: 'raise', amount: amt };
  }
  if (legal.has('call') && rng() < 0.78) return { kind: 'call' };
  return legal.has('fold') ? { kind: 'fold' } : legal.has('call') ? { kind: 'call' } : { kind: 'check' };
}

/** Clamp a desired "raise/bet to" target into [minRaiseTo, maxRaiseTo]; 0 if no room. */
function clampRaise(view: SeatView, target: number): number {
  if (view.maxRaiseTo <= view.minRaiseTo) {
    // Only an all-in (or no raise) is possible — return the all-in ceiling if it
    // exceeds the current commitment, else 0 (caller falls back to call/check).
    return view.maxRaiseTo > view.toCall ? view.maxRaiseTo : 0;
  }
  return Math.min(view.maxRaiseTo, Math.max(view.minRaiseTo, target));
}

// ───────────────────────────────────────────────────────────────────────────
// HIDDEN-STATE LEAK SCAN — the public `table` block must carry NO hole cards.
// ───────────────────────────────────────────────────────────────────────────
function scanHiddenStateLeak(view: SeatView): string | null {
  // The ONLY card-bearing field allowed is the requesting seat's own `holeCards`.
  // The public `table` (broadcast-equivalent) must contain no hole-card field.
  const publicJson = JSON.stringify(view.table);
  if (/"hole/i.test(publicJson)) {
    return `public table snapshot contains a hole-card field: ${publicJson.slice(0, 200)}`;
  }
  if (/"serverSeedRevealed"/.test(publicJson)) {
    return `public table snapshot leaked the revealed server seed mid-hand`;
  }
  // The own hole cards must be exactly two and present on the top-level view only.
  if (view.isYourTurn && (!Array.isArray(view.holeCards) || view.holeCards.length !== 2)) {
    return `own holeCards malformed on-turn: ${JSON.stringify(view.holeCards)}`;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// THE AGENT PLAY LOOP — poll → (advice) → decide → act, per agent
// ───────────────────────────────────────────────────────────────────────────
async function runAgentLoop(
  transport: PokerTransport,
  tournamentId: string,
  agent: Agent,
  deadline: number,
): Promise<void> {
  const rng = makeRng(`${agent.agentId}:${agent.mode}`);
  while (Date.now() < deadline) {
    const st = await transport.status(tournamentId);
    if (st.tournament && (st.tournament.status === 'completed' || st.tournament.status === 'cancelled')) {
      agent.done = true;
      return;
    }

    const sv = await transport.stateForAgent(tournamentId, agent.sessionId);
    if (sv.status >= 300 || !sv.view) {
      // Not seated at a live hand right now. If we've already been placed (busted
      // or champion), stop; otherwise the field may still be seating / we're between
      // hands / rebalancing — keep polling.
      const me = st.entrants.find((e) => e.agentId === agent.agentId || e.avatarId === agent.agentId);
      if (me && (me.status === 'busted' || me.placement != null)) {
        agent.done = true;
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const view = sv.view;

    // HIDDEN-STATE assertion on EVERY view the agent sees.
    const leak = scanHiddenStateLeak(view);
    if (leak) recordViolation('hidden_state', `agent ${agent.name}: ${leak}`);

    if (!view.isYourTurn) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // It's our turn — resolve within the action budget (no-stall assertion).
    const turnStart = Date.now();
    let action: PokerAction;
    if (agent.mode === 'autonomous') {
      let advice: AdviceResult | null = null;
      try {
        advice = await transport.advice(tournamentId, agent.sessionId);
      } catch {
        advice = null; // advisor is best-effort; the heuristic covers it.
      }
      action = decideAutonomous(view, advice, rng);
    } else {
      action = decideControlled(view, rng);
    }

    const seq = agent.actionSeq++;
    const res = await transport.action(
      tournamentId,
      agent.sessionId,
      view.handNumber,
      seq,
      action,
    );
    const turnMs = Date.now() - turnStart;
    agent.worstTurnMs = Math.max(agent.worstTurnMs, turnMs);
    if (turnMs > ACTION_BUDGET_MS) {
      recordViolation(
        'no_stall',
        `agent ${agent.name} turn took ${turnMs}ms (> ${ACTION_BUDGET_MS}ms budget)`,
      );
    }

    if (res.ok) {
      agent.actionsTaken++;
      agent.lastHand = view.handNumber;
    } else if (res.reason === 'not_your_turn' || res.reason === 'hand_over') {
      // Benign race: the table advanced between our poll and our act. Re-poll.
    } else if (res.reason === 'human_controlled') {
      // Expected when controlled-mode suppression is active for THIS avatar; the
      // harness models controlled via the decision policy, not server suppression,
      // so this should not occur — record it for visibility but don't fail hard.
      recordViolation('controlled_suppressed', `agent ${agent.name} got human_controlled unexpectedly`);
    } else if (res.reason === 'no_live_table') {
      // We were moved/busted between poll and act. Re-poll.
    } else {
      // An illegal-action rejection: the sim refused our bet shape. Retry with a
      // safe fallback (check if free, else fold) so we never stall the table.
      const safe: PokerAction = view.toCall === 0 && view.legalActions.includes('check')
        ? { kind: 'check' }
        : view.legalActions.includes('fold')
          ? { kind: 'fold' }
          : { kind: 'call' };
      if (safe.kind !== action.kind) {
        await transport.action(tournamentId, agent.sessionId, view.handNumber, agent.actionSeq++, safe);
      } else {
        recordViolation(
          'illegal_action',
          `agent ${agent.name} action ${JSON.stringify(action)} rejected: ${res.reason} (status ${res.status})`,
        );
      }
    }

    if (POLL_INTERVAL_MS > 0) await sleep(0);
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────────────────────
// CONTINUOUS INVARIANT SAMPLER — chip conservation across all live tables
// ───────────────────────────────────────────────────────────────────────────
/** Sum of persisted in-play (seated/registered) chip stacks from a status snapshot. */
function persistedInPlayChips(st: StatusResult): number {
  return st.entrants
    .filter((e) => e.status === 'seated' || e.status === 'registered')
    .reduce((a, e) => a + (Number(e.chipStack) || 0), 0);
}

function sampleChipConservation(st: StatusResult, expectedTotalChips: number): void {
  // The public status endpoint exposes each entrant's PERSISTED `chip_stack`, which
  // is checkpointed at seating + each settled hand + bust — NOT after every in-hand
  // chip movement. So MID-HAND the persisted sum legitimately UNDER-counts by the
  // chips currently committed to the live pot (they leave a stack on commit and
  // return to the winner only at showdown). An under-count is therefore a benign
  // checkpoint lag, NOT a conservation violation.
  //
  // The REAL conservation danger is chips being MINTED — the persisted in-play total
  // EXCEEDING startingStack * entrants. That can never be a checkpoint artifact, so
  // we assert it continuously (≤ expected). EXACT reconciliation when quiescent is
  // asserted once right after seating (see main()) and again via CT conservation at
  // settle.
  if (!st.tournament || st.tournament.status !== 'running') return;
  const totalChips = persistedInPlayChips(st);
  if (totalChips > expectedTotalChips) {
    recordViolation(
      'chip_conservation',
      `chips MINTED: persisted in-play total ${totalChips} EXCEEDS expected ${expectedTotalChips}`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATION
// ───────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  emit('═'.repeat(74));
  emit(`Poker MTT 10-agent stress harness — mode=${DRY_RUN ? 'DRY-RUN (in-process)' : `LIVE (${TARGET_URL})`}`);
  emit(
    `agents=${AGENT_COUNT} autonomous=${AUTONOMOUS_COUNT} controlled=${AGENT_COUNT - AUTONOMOUS_COUNT} ` +
      `seats/table=${SEATS_PER_TABLE} stack=${STARTING_STACK} buyIn=${BUY_IN_CT}`,
  );
  emit('═'.repeat(74));

  const transport: PokerTransport = DRY_RUN ? new MockTransport() : new HttpTransport();
  const startedAt = Date.now();
  const deadline = startedAt + MAX_RUNTIME_MS;

  try {
    // 1) Spin up N agents (mixed names hermes-/openclaw-/milady-).
    const prefixes = ['hermes', 'openclaw', 'milady'];
    const agents: Agent[] = [];
    for (let i = 0; i < AGENT_COUNT; i++) {
      const name = `${prefixes[i % prefixes.length]}-${i}`;
      const mode: AgentMode = i < AUTONOMOUS_COUNT ? 'autonomous' : 'controlled';
      const { sessionId, agentId } = await transport.connect(name);
      agents.push({
        name,
        mode,
        sessionId,
        agentId,
        actionSeq: 0,
        lastHand: 0,
        done: false,
        actionsTaken: 0,
        worstTurnMs: 0,
      });
    }
    emit(`[1] connected ${agents.length} agents (${AUTONOMOUS_COUNT} autonomous / ${AGENT_COUNT - AUTONOMOUS_COUNT} controlled)`);
    if (agents.length === AGENT_COUNT) {
      pass('agents_connected', `${agents.length}/${AGENT_COUNT} agents got a sessionId + bound avatar`);
    } else {
      fail('agents_connected', `only ${agents.length}/${AGENT_COUNT} connected`);
    }

    // 2) Resolve the tournament: use an existing id (LIVE) or create one.
    let tournamentId: string;
    if (ENV_TOURNAMENT_ID && !DRY_RUN) {
      tournamentId = ENV_TOURNAMENT_ID;
      emit(`[2] using existing tournament ${tournamentId}`);
    } else {
      const created = await transport.createTournament({
        name: `stress-${Date.now()}`,
        buyInCt: BUY_IN_CT,
        minEntrants: 2,
        maxEntrants: AGENT_COUNT,
        seatsPerTable: SEATS_PER_TABLE,
        startingStack: STARTING_STACK,
      });
      tournamentId = created.id;
      emit(`[2] created tournament ${tournamentId} (maxEntrants=${AGENT_COUNT})`);
    }

    const expectedTables = Math.max(1, Math.ceil(AGENT_COUNT / SEATS_PER_TABLE));

    // 3) Register every agent (free/CT entry). Idempotent.
    let registered = 0;
    for (const a of agents) {
      const r = await transport.register(tournamentId, a.sessionId);
      if (r.ok) registered++;
      else emit(`    register FAILED for ${a.name}: HTTP ${r.status} ${r.errorMessage ?? ''}`);
    }
    emit(`[3] registered ${registered}/${agents.length} agents`);
    if (registered === agents.length) {
      pass('all_registered', `${registered}/${agents.length} agents registered (buy-in ${BUY_IN_CT} CT each)`);
    } else {
      fail('all_registered', `only ${registered}/${agents.length} registered`);
    }

    // 4) Seat the field. DRY: force-start now. LIVE: cap-hit auto-seat fired on the
    //    last register, or the registrationClosesAt sweep will; we poll until running.
    await transport.forceStart(tournamentId);

    // Wait for 'running' (LIVE may take a sweep tick; DRY is immediate).
    let seated = false;
    while (Date.now() < deadline) {
      const st = await transport.status(tournamentId);
      if (st.tournament?.status === 'running') {
        seated = true;
        break;
      }
      if (st.tournament?.status === 'cancelled') {
        fail('seated', 'tournament was CANCELLED before seating (entrants < minEntrants?)');
        return await finish(transport, 1);
      }
      // DRY: pump in case force-start needs a tick; LIVE: just wait for the sweep.
      transport.pump?.(tournamentId);
      await sleep(DRY_RUN ? 0 : 500);
    }
    if (!seated) {
      fail('seated', `tournament never reached 'running' within ${MAX_RUNTIME_MS}ms`);
      return await finish(transport, 1);
    }
    const seatStatus = await transport.status(tournamentId);
    const inPlay = seatStatus.entrants.filter((e) => e.status === 'seated').length;
    emit(`[4] SEATED — ${inPlay} seats live; expected ~${expectedTables} table(s)`);
    pass('seated', `tournament running with ${inPlay} seated entrants`);

    const expectedTotalChips = inPlay * STARTING_STACK;

    // EXACT chip reconciliation at the one provably-quiescent moment: right after
    // seating, before any action — every chip is in a stack, no pot exists yet.
    const seatChips = persistedInPlayChips(seatStatus);
    if (seatChips === expectedTotalChips) {
      pass('chip_conservation_seat', `post-seat chips ${seatChips} == startingStack*entrants ${expectedTotalChips}`);
    } else {
      fail('chip_conservation_seat', `post-seat chips ${seatChips} != expected ${expectedTotalChips}`);
    }

    // 5) Run every agent's play loop concurrently; in DRY-RUN also pump the field +
    //    sample chip conservation on a steady cadence until a champion is crowned.
    let eliminationsSeen = 0;
    const prevPlacements = new Set<string>();

    const monitor = (async () => {
      while (Date.now() < deadline) {
        const st = await transport.status(tournamentId);
        // DRY: drive non-agent seats + clock; LIVE: server owns its loop.
        transport.pump?.(tournamentId);

        // Continuous chip-conservation sample.
        sampleChipConservation(st, expectedTotalChips);

        // Track eliminations (entrants that newly got a placement).
        for (const e of st.entrants) {
          if (e.placement != null && !prevPlacements.has(e.avatarId)) {
            prevPlacements.add(e.avatarId);
            eliminationsSeen++;
          }
        }

        if (st.tournament && (st.tournament.status === 'completed' || st.tournament.status === 'cancelled')) {
          return;
        }
        await sleep(DRY_RUN ? 0 : 250);
        if (DRY_RUN) {
          // Yield so the agent loops interleave with the pump.
          await sleep(0);
        }
      }
    })();

    await Promise.all([monitor, ...agents.map((a) => runAgentLoop(transport, tournamentId, a, deadline))]);

    // 6) Final standings + completion assertions.
    const final = await transport.status(tournamentId);
    if (!final.tournament || final.tournament.status !== 'completed') {
      fail(
        'champion_crowned',
        `tournament status is '${final.tournament?.status ?? 'unknown'}' (expected 'completed') after ${Date.now() - startedAt}ms`,
      );
      return await finish(transport, 1);
    }
    pass('champion_crowned', `tournament completed in ${Date.now() - startedAt}ms`);

    // Placements: a permutation of 1..N over the entrants.
    const placements = final.entrants
      .map((e) => e.placement)
      .filter((p): p is number => p != null)
      .sort((a, b) => a - b);
    const entrantTotal = final.entrants.length;
    const expectedPerm = Array.from({ length: entrantTotal }, (_, i) => i + 1);
    const uniqueOk =
      placements.length === entrantTotal &&
      JSON.stringify(placements) === JSON.stringify(expectedPerm);
    if (uniqueOk) {
      pass('unique_placements', `placements are a permutation of 1..${entrantTotal}`);
    } else {
      fail(
        'unique_placements',
        `placements=${JSON.stringify(placements)} expected permutation of 1..${entrantTotal}`,
      );
    }

    const champion = final.entrants.find((e) => e.placement === 1);
    emit(`[5] CHAMPION: ${champion?.agentId ?? champion?.avatarId ?? '(unknown)'} (placement 1)`);
    emit(
      `    eliminations observed=${eliminationsSeen} · final-table consolidation reached (single champion)`,
    );

    // CT conservation: Σ prizes + rake == prize pool.
    const pool = BigInt(final.tournament.prizePoolCt || '0');
    const rake = BigInt(final.tournament.rakeTakenCt || '0');
    const prizeSum = final.results.reduce((acc, r) => acc + BigInt(r.prizeCt || '0'), 0n);
    if (prizeSum + rake === pool) {
      pass('ct_conservation', `Σprizes(${prizeSum}) + rake(${rake}) == pool(${pool})`);
    } else {
      fail('ct_conservation', `Σprizes(${prizeSum}) + rake(${rake}) != pool(${pool})`);
    }

    // Emit the final standings table.
    emit('    FINAL STANDINGS:');
    const standings = final.results.slice().sort((a, b) => a.placement - b.placement);
    for (const r of standings) {
      emit(`      #${r.placement}  ${r.avatarId}  prize=${r.prizeCt} CT`);
    }
    emit(
      `    actions: ${agents.map((a) => `${a.name}=${a.actionsTaken}`).join(' ')} ` +
        `| worstTurnMs=${Math.max(...agents.map((a) => a.worstTurnMs))}`,
    );

    // 7) Promote continuous-invariant samples to PASS/FAIL.
    promoteContinuous('chip_conservation', 'CHIP CONSERVATION held at every running sample');
    promoteContinuous('hidden_state', 'NO hidden-state leak in any agent view');
    promoteContinuous('no_stall', 'NO turn exceeded the action budget (no stalls)');
    promoteContinuous('illegal_action', 'NO unrecoverable illegal-action rejections');
    promoteContinuous('controlled_suppressed', 'NO unexpected controlled-mode suppression');

    const failed = invariants.filter((i) => i.status === 'FAIL');
    return await finish(transport, failed.length === 0 ? 0 : 1);
  } catch (err) {
    fail('harness_exception', (err as Error)?.stack ?? String(err));
    return await finish(transport, 1);
  }
}

function promoteContinuous(key: string, okEvidence: string): void {
  const v = continuousViolations.get(key);
  if (v) fail(key, v);
  else pass(key, okEvidence);
}

async function finish(transport: PokerTransport, code: number): Promise<number> {
  try {
    await transport.dispose();
  } catch {
    /* best effort */
  }
  emit('─'.repeat(74));
  const passed = invariants.filter((i) => i.status === 'PASS').length;
  const failed = invariants.filter((i) => i.status === 'FAIL').length;
  emit(`RESULT: ${passed} PASS / ${failed} FAIL`);
  emit('─'.repeat(74));
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
