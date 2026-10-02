/**
 * Special Event Manager — unit tests (mocked DB + ledger + RPC + TournamentManager).
 *
 * `special_events` is the GENERIC PARENT; the poker tournament is a DEPENDENT
 * subtable (the FK points UP: poker_tournaments.special_event_id →
 * special_events.id). These tests assert the dependency DIRECTION explicitly and
 * exercise the flexible gate + agent parity + prepaid seating.
 *
 * Asserts:
 *   (1) FREE event (all gates null) → any subject signs up + is confirmed.
 *   (2) HOLD-gated → a wallet meeting the threshold gets FREE entry (mocked
 *       supply+balance); a wallet below it is rejected (no fallback).
 *   (3) HOLD + SOL fallback → below-threshold wallet must pay SOL; a verified tx
 *       confirms; an underpaid tx is rejected.
 *   (4) SOL-gated → confirms only on a verified tx; a REPLAYED tx (2nd avatar,
 *       same sig) is rejected.
 *   (5) CT-gated → debits the ledger on confirm; insufficient balance throws.
 *   (6) AGENT signs up + is seated AS ITSELF (Rule E5).
 *   (7) closeSignupAndStart creates a tournament whose `special_event_id ===
 *       event.id` (dependency direction) AND seats every confirmed signup with
 *       NO double-charge (prepaid: tournament buyIn 0).
 *   (8) idempotent signup (re-signup → same row, no second charge).
 *   (9) the parent `special_events` row carries NO poker reference (direction).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  SpecialEventManager,
  SpecialEventError,
  SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT,
  SPECIAL_EVENT_START_CLAIM_STALE_MS,
  readSeedPrizePoolCt,
  toBigIntStrict,
  type EventRpc,
  type SignupSubject,
} from '../special-event-manager';
import {
  TournamentError,
  type CreateTournamentConfig,
  type CreateTournamentResult,
  type RegisterSubject,
  type RegisterResult,
  type StartResult,
} from '../poker/tournament-manager';

// ─── SQL render (same approach as the TM test) ────────────────────────────────

function renderSql(q: SQL): { text: string; params: unknown[] } {
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  const params: unknown[] = [];
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === 'StringChunk') {
      text += ((ch as { value: string[] }).value ?? []).join('');
    } else if (cn === 'SQL') {
      const sub = renderSql(ch as SQL);
      text += sub.text;
      params.push(...sub.params);
    } else if (cn === 'Name') {
      text += (ch as { value: string }).value;
    } else {
      params.push(ch);
      text += '?';
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

function parseJsonParam(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

interface Row {
  [k: string]: unknown;
}

// ─── Fake DB: interprets only the SQL the SpecialEventManager emits ───────────

class FakeDb {
  events = new Map<string, Row>(); // by id
  signups = new Map<string, Row>(); // by id
  tournaments = new Map<string, Row>(); // by id (linked tournaments)
  results: Row[] = []; // poker_tournament_results

  query = {};
  private seq = 0;

  /** Seed a linked tournament + its results for settleEvent tests. */
  seedTournament(row: Row): void {
    this.tournaments.set(String(row.id), row);
  }
  seedResult(row: Row): void {
    this.results.push(row);
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Every statement's normalized text, in order (lock-order assertions). */
  statements: string[] = [];

  async execute<T = Row>(q: SQL): Promise<T[]> {
    const { text, params } = renderSql(q);
    this.statements.push(text);
    return this.dispatch(text, params) as T[];
  }

  private bySlug(slug: unknown): Row | undefined {
    return [...this.events.values()].find((e) => e.slug === slug);
  }

  private dispatch(text: string, p: unknown[]): Row[] {
    // ── special_events ────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO special_events')) {
      const id = randomUUID();
      const row: Row = {
        id,
        slug: p[0],
        name: p[1],
        description: p[2] ?? null,
        kind: p[3],
        status: 'draft',
        gate_hold_mint: p[4] ?? null,
        gate_hold_bps: p[5] ?? null,
        gate_sol_lamports: p[6] ?? null,
        gate_ct: p[7] ?? null,
        venue_config_json: parseJsonParam(p[8]),
        prize_config_json: parseJsonParam(p[9]),
        max_participants: p[10] ?? null,
        registration_opens_at: p[11] ?? null,
        registration_closes_at: p[12] ?? null,
        starts_at: p[13] ?? null,
        created_by: p[14] ?? null,
        created_at: new Date(++this.seq),
        started_at: null,
        completed_at: null,
        start_claim_id: null,
        start_claimed_at: null,
      };
      this.events.set(id, row);
      return [row];
    }
    if (text.startsWith('SELECT * FROM special_events ORDER BY created_at DESC LIMIT ?')) {
      const lim = Number(p[0]);
      return [...this.events.values()]
        .sort((a, b) => Number(b.created_at) - Number(a.created_at))
        .slice(0, lim);
    }
    if (text.startsWith('SELECT * FROM special_events WHERE slug = ? FOR UPDATE')) {
      const e = this.bySlug(p[0]);
      return e ? [e] : [];
    }
    if (text.startsWith('SELECT * FROM special_events WHERE slug = ?')) {
      const e = this.bySlug(p[0]);
      return e ? [e] : [];
    }
    if (text.startsWith("SELECT id, status, gate_ct, max_participants FROM special_events WHERE id = ? FOR UPDATE")) {
      const e = this.events.get(String(p[0]));
      return e ? [e] : [];
    }
    if (text.startsWith("UPDATE special_events SET status = 'signup_open' WHERE id = ? RETURNING *")) {
      const e = this.events.get(String(p[0]))!;
      e.status = 'signup_open';
      return [e];
    }
    // Security M4 (2026-09-30): the start CLAIM (CAS signup_open → starting with a
    // claim token), the guarded final flip, the reconcile outcomes, and the settle
    // updates (all clear the claim).
    if (text.startsWith("UPDATE special_events SET status = 'starting', start_claim_id = ?, start_claimed_at = ? WHERE id = ? AND status = 'signup_open' RETURNING id")) {
      const e = this.events.get(String(p[2]));
      if (!e || e.status !== 'signup_open') return [];
      e.status = 'starting';
      e.start_claim_id = p[0];
      e.start_claimed_at = p[1];
      return [{ id: e.id }];
    }
    // Item 9: the flip is one tx — event lock, tournament lock, then the UPDATE.
    if (text.startsWith("UPDATE special_events SET status = 'live', started_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id = ? RETURNING id")) {
      const e = this.events.get(String(p[0]));
      if (!e || e.status !== 'starting' || e.start_claim_id !== p[1]) return [];
      e.status = 'live';
      e.started_at = new Date(++this.seq);
      e.start_claim_id = null;
      e.start_claimed_at = null;
      return [{ id: e.id }];
    }
    if (text.startsWith('SELECT id, status FROM poker_tournaments WHERE id = ? AND special_event_id = ? FOR UPDATE')) {
      const t = this.tournaments.get(String(p[0]));
      return t && t.special_event_id === p[1] ? [{ id: t.id, status: t.status }] : [];
    }
    // Item 9: live events whose tournaments were all cancelled.
    if (text.startsWith('SELECT id, status FROM special_events WHERE id = ? FOR UPDATE')) {
      const e = this.events.get(String(p[0]));
      return e ? [{ id: e.id, status: e.status }] : [];
    }
    if (text.startsWith("SELECT count(*)::int AS active FROM poker_tournaments WHERE special_event_id = ? AND status <> 'cancelled'")) {
      const active = [...this.tournaments.values()].filter(
        (t) => t.special_event_id === p[0] && t.status !== 'cancelled',
      ).length;
      return [{ active }];
    }
    if (text.startsWith("UPDATE special_events SET status = 'signup_open', started_at = NULL, start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'live'")) {
      const e = this.events.get(String(p[0]));
      if (e?.status === 'live') {
        e.status = 'signup_open';
        e.started_at = null;
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }
    if (text.startsWith("SELECT e.id FROM special_events e WHERE e.status = 'live' AND NOT EXISTS")) {
      return [...this.events.values()]
        .filter(
          (e) =>
            e.status === 'live' &&
            ![...this.tournaments.values()].some(
              (t) => t.special_event_id === e.id && t.status !== 'cancelled',
            ),
        )
        .slice(0, Number(p[0]))
        .map((e) => ({ id: e.id }));
    }
    if (text.startsWith('SELECT id, status, start_claim_id, start_claimed_at FROM special_events WHERE id = ? FOR UPDATE')) {
      const e = this.events.get(String(p[0]));
      return e ? [e] : [];
    }
    if (text.startsWith("UPDATE special_events SET status = 'completed', completed_at = now(), started_at = COALESCE(started_at, now()), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting'")) {
      const e = this.events.get(String(p[0]));
      if (e?.status === 'starting') {
        e.status = 'completed';
        e.completed_at = new Date(++this.seq);
        e.started_at = e.started_at ?? new Date(++this.seq);
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }
    if (text.startsWith("UPDATE special_events SET status = 'live', started_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting'")) {
      const e = this.events.get(String(p[0]));
      if (e?.status === 'starting') {
        e.status = 'live';
        e.started_at = new Date(++this.seq);
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }
    if (text.startsWith("UPDATE special_events SET status = 'signup_open', start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting'")) {
      const e = this.events.get(String(p[0]));
      if (e?.status === 'starting') {
        e.status = 'signup_open';
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }
    if (text.startsWith("SELECT id FROM special_events WHERE status = 'starting' AND (start_claimed_at IS NULL OR start_claimed_at < ?)")) {
      const cutoff = new Date(p[0] as Date).getTime();
      return [...this.events.values()]
        .filter(
          (e) =>
            e.status === 'starting' &&
            (e.start_claimed_at == null || new Date(e.start_claimed_at as Date).getTime() < cutoff),
        )
        .slice(0, Number(p[1]))
        .map((e) => ({ id: e.id }));
    }
    if (text.startsWith('SELECT e.status AS event_status, t.status AS tournament_status FROM special_events e LEFT JOIN poker_tournaments t')) {
      const e = this.events.get(String(p[1]));
      if (!e) return [];
      const t = this.tournaments.get(String(p[0]));
      return [{
        event_status: e.status,
        tournament_status: t && t.special_event_id === e.id ? t.status : null,
      }];
    }
    if (text.startsWith("UPDATE special_events SET status = 'completed', completed_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status IN ('live', 'starting')")) {
      const e = this.events.get(String(p[0]));
      if (e?.status === 'live' || e?.status === 'starting') {
        e.status = 'completed';
        e.completed_at = new Date(++this.seq);
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }
    if (text.startsWith("UPDATE special_events SET status = 'completed', completed_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status <> 'completed'")) {
      const e = this.events.get(String(p[0]));
      if (e && e.status !== 'completed') {
        e.status = 'completed';
        e.completed_at = new Date(++this.seq);
        e.start_claim_id = null;
        e.start_claimed_at = null;
      }
      return [];
    }

    // ── special_event_signups ─────────────────────────────────────────────────
    if (text.startsWith('SELECT id, status, entry_method FROM special_event_signups WHERE event_id = ? AND avatar_id = ?')) {
      const found = [...this.signups.values()].find(
        (s) => s.event_id === p[0] && s.avatar_id === p[1],
      );
      return found ? [{ id: found.id, status: found.status, entry_method: found.entry_method }] : [];
    }
    if (text.startsWith("SELECT count(*)::int AS cnt FROM special_event_signups WHERE event_id = ? AND status <> 'refunded'")) {
      const cnt = [...this.signups.values()].filter(
        (s) => s.event_id === p[0] && s.status !== 'refunded',
      ).length;
      return [{ cnt }];
    }
    // GLOBAL SOL replay guard — NOT scoped to event_id (one sig = one seat across
    // ALL SOL-gated events; the treasury is shared, so a per-event scope would let
    // one payment satisfy entry to every concurrent SOL event).
    if (text.startsWith('SELECT id FROM special_event_signups WHERE status <> \'refunded\' AND entry_method = \'sol\' AND entry_proof_json->>\'txSig\' = ?')) {
      const found = [...this.signups.values()].find(
        (s) =>
          s.status !== 'refunded' &&
          s.entry_method === 'sol' &&
          (s.entry_proof_json as { txSig?: string } | null)?.txSig === p[0],
      );
      return found ? [{ id: found.id }] : [];
    }
    if (text.startsWith("SELECT avatar_id, agent_id, subject_type, user_id FROM special_event_signups WHERE event_id = ? AND status = 'confirmed'")) {
      return [...this.signups.values()]
        .filter((s) => s.event_id === p[0] && s.status === 'confirmed')
        .sort((a, b) => Number(a.created_at) - Number(b.created_at))
        .map((s) => ({
          avatar_id: s.avatar_id,
          agent_id: s.agent_id,
          subject_type: s.subject_type,
          user_id: s.user_id,
        }));
    }
    if (text.startsWith('INSERT INTO special_event_signups')) {
      const id = randomUUID();
      const entryMethod = p[5];
      const proof = parseJsonParam(p[7]) as { txSig?: string } | null;
      // Model the partial unique index
      // `special_event_signups_sol_txsig_global_unique` ON (entry_proof_json->>'txSig')
      // WHERE entry_method='sol' AND status<>'refunded'. This is the race-proof
      // backstop: a concurrent cross-event SOL signup that passed the SELECT guard
      // (different event rows never serialize) still fails here at INSERT.
      if (entryMethod === 'sol' && proof?.txSig) {
        const collision = [...this.signups.values()].some(
          (s) =>
            s.entry_method === 'sol' &&
            s.status !== 'refunded' &&
            (s.entry_proof_json as { txSig?: string } | null)?.txSig === proof.txSig,
        );
        if (collision) {
          const err = new Error(
            'duplicate key value violates unique constraint "special_event_signups_sol_txsig_global_unique"',
          ) as Error & { code: string; constraint: string };
          err.code = '23505';
          err.constraint = 'special_event_signups_sol_txsig_global_unique';
          throw err;
        }
      }
      const row: Row = {
        id,
        event_id: p[0],
        user_id: p[1] ?? null,
        avatar_id: p[2],
        agent_id: p[3] ?? null,
        subject_type: p[4],
        entry_method: entryMethod,
        wallet_used: p[6] ?? null,
        entry_proof_json: proof,
        status: 'confirmed',
        created_at: new Date(++this.seq),
        confirmed_at: new Date(++this.seq),
      };
      this.signups.set(id, row);
      return [{ id }];
    }

    // ── poker_tournaments / results (settleEvent reads — dependency points UP) ──
    if (text.startsWith("SELECT id, status FROM poker_tournaments WHERE special_event_id = ? AND status <> 'cancelled' ORDER BY created_at DESC")) {
      return [...this.tournaments.values()]
        .filter((tt) => tt.special_event_id === p[0] && tt.status !== 'cancelled')
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
        .map((tt) => ({ id: tt.id, status: tt.status }));
    }
    if (text.startsWith('SELECT id, status FROM poker_tournaments WHERE special_event_id = ?')) {
      const t = [...this.tournaments.values()]
        .filter((tt) => tt.special_event_id === p[0])
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
      return t ? [{ id: t.id, status: t.status }] : [];
    }
    if (text.startsWith('SELECT e.*, t.status AS tournament_status FROM poker_tournaments t JOIN special_events e ON e.id = t.special_event_id WHERE t.id = ? FOR UPDATE OF e')) {
      const t = this.tournaments.get(String(p[0]));
      if (!t || !t.special_event_id) return [];
      const e = this.events.get(String(t.special_event_id));
      return e ? [{ ...e, tournament_status: t.status }] : [];
    }
    if (text.startsWith('SELECT avatar_id, agent_id, placement, prize_ct FROM poker_tournament_results WHERE tournament_id = ?')) {
      return this.results
        .filter((r) => r.tournament_id === p[0])
        .sort((a, b) => Number(a.placement) - Number(b.placement));
    }

    throw new Error(`FakeDb: unhandled SQL: ${text}`);
  }
}

// ─── Fake ledger ──────────────────────────────────────────────────────────────

class InsufficientTokensError extends Error {
  constructor(
    public readonly avatarId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`avatar ${avatarId} has ${available}, cannot debit ${requested}`);
    this.name = 'InsufficientTokensError';
  }
}

class FakeLedger {
  balances = new Map<string, number>();
  debits: Array<{ avatarId: string; amount: number; reason: string }> = [];
  credits: Array<{ avatarId: string; amount: number; reason: string }> = [];

  setBalance(a: string, n: number): void {
    this.balances.set(a, n);
  }
  get(a: string): number {
    return this.balances.get(a) ?? 0;
  }
  debitClawTokens = async (input: { avatarId: string; amount: number; reason: string }) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ ...input });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (input: { avatarId: string; amount: number; reason: string }) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal + input.amount);
    this.credits.push({ ...input });
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
}

// ─── Fake RPC ─────────────────────────────────────────────────────────────────

class FakeRpc implements EventRpc {
  supply = new Map<string, bigint>();
  balances = new Map<string, bigint>(); // key = `${mint}:${owner}`
  txs = new Map<string, { lamportsToDest: bigint; success: boolean; dest: string }>();

  setSupply(mint: string, s: bigint): void {
    this.supply.set(mint, s);
  }
  setBalance(mint: string, owner: string, b: bigint): void {
    this.balances.set(`${mint}:${owner}`, b);
  }
  setTx(sig: string, dest: string, lamports: bigint, success = true): void {
    this.txs.set(sig, { lamportsToDest: lamports, success, dest });
  }

  async getTokenSupply(mint: string): Promise<bigint> {
    return this.supply.get(mint) ?? 0n;
  }
  async getTokenBalance(mint: string, owner: string): Promise<bigint> {
    return this.balances.get(`${mint}:${owner}`) ?? 0n;
  }
  async getSolTransfer(sig: string, expectedDest: string) {
    const tx = this.txs.get(sig);
    if (!tx) return null;
    // Only credit lamports if the tx's recorded dest matches what we expect.
    return {
      lamportsToDest: tx.dest === expectedDest ? tx.lamportsToDest : 0n,
      success: tx.success,
    };
  }
}

// ─── Fake TournamentManager (records calls, asserts dependency link) ──────────

class FakeTM {
  created: Array<{ config: CreateTournamentConfig; createdBy: string | null; id: string }> = [];
  registered: Array<{ subject: RegisterSubject; tournamentId: string }> = [];
  started: string[] = [];
  /** Security M4 harness: every create ATTEMPT, cancels, and injected failures. */
  createCalls = 0;
  cancelled: string[] = [];
  createError: Error | null = null;
  registerError: Error | null = null;
  startStatus: StartResult['status'] = 'running';
  /** Every cancelAndRefundOrphan call (the real TM refunds the seed at most once). */
  cancelCalls = 0;
  /** Runs inside startTrigger after the tournament is running (race injection). */
  onStarted: ((tournamentId: string) => void) | null = null;
  /** The shared FakeDb, so the manager's SQL sees these tournaments. */
  db: FakeDb | null = null;
  private seq = 0;

  async createTournament(
    config: CreateTournamentConfig,
    createdBy: string | null,
  ): Promise<CreateTournamentResult> {
    this.createCalls += 1;
    // Yield so a concurrent start can interleave (the real create does DB I/O).
    await Promise.resolve();
    if (this.createError) throw this.createError;
    // Model `poker_tournaments_special_event_active_unique` (migration 0075).
    if (
      config.specialEventId &&
      this.created.some(
        (c) => c.config.specialEventId === config.specialEventId && !this.cancelled.includes(c.id),
      )
    ) {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "poker_tournaments_special_event_active_unique"'),
        { code: '23505' },
      );
    }
    const id = randomUUID();
    this.created.push({ config, createdBy, id });
    this.db?.seedTournament({
      id,
      status: 'registering',
      special_event_id: config.specialEventId ?? null,
      created_at: 1_000 + ++this.seq,
    });
    return {
      id,
      name: config.name,
      status: 'registering',
      buyInCt: String(config.buyInCt),
      rakeBps: config.rakeBps ?? 0,
      minEntrants: config.minEntrants,
      maxEntrants: config.maxEntrants,
      seatsPerTable: config.seatsPerTable ?? 9,
      startingStack: config.startingStack,
      prizePoolCt: String(config.prepaid?.seedPrizePoolCt ?? '0'),
      payoutCurve: config.payoutCurve ?? [],
      blindScheduleId: config.blindScheduleId ?? 'blind-default',
      registrationClosesAt: null,
      createdBy,
      specialEventId: config.specialEventId ?? null,
      createdAt: new Date(),
    };
  }
  async registerEntrant(subject: RegisterSubject, tournamentId: string): Promise<RegisterResult> {
    if (this.registerError) throw this.registerError;
    this.registered.push({ subject, tournamentId });
    return {
      entrantId: randomUUID(),
      prizePoolCt: '0',
      alreadyRegistered: false,
      capReached: false,
    };
  }
  async startTrigger(tournamentId: string): Promise<StartResult> {
    this.started.push(tournamentId);
    const row = this.db?.tournaments.get(tournamentId);
    if (this.startStatus === 'cancelled') {
      // The real TM cancels (and refunds the seed) when the field is below the floor.
      this.cancelled.push(tournamentId);
      if (row) row.status = 'cancelled';
      return { status: 'cancelled', seatedCount: 0, refundedCount: 0, tableCount: 0 };
    }
    if (row) row.status = 'running';
    this.onStarted?.(tournamentId);
    return {
      status: 'running',
      seatedCount: this.registered.filter((r) => r.tournamentId === tournamentId).length,
      refundedCount: 0,
      tableCount: 1,
    };
  }
  async cancelAndRefundOrphan(tournamentId: string): Promise<number> {
    this.cancelCalls += 1;
    const row = this.db?.tournaments.get(tournamentId);
    // Same terminal guard as the real TM: completed/cancelled → idempotent no-op.
    if (row && (row.status === 'completed' || row.status === 'cancelled')) return 0;
    if (row) row.status = 'cancelled';
    if (!this.cancelled.includes(tournamentId)) this.cancelled.push(tournamentId);
    return 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function human(avatarId = randomUUID(), userId = randomUUID()): SignupSubject {
  return { kind: 'human', userId, avatarId, agentId: null };
}
function agent(avatarId = randomUUID(), userId = randomUUID(), agentId = `oc-${randomUUID()}`): SignupSubject {
  return { kind: 'agent', userId, avatarId, agentId };
}

function makeManager() {
  const db = new FakeDb();
  const ledger = new FakeLedger();
  const rpc = new FakeRpc();
  const tm = new FakeTM();
  tm.db = db;
  const clock = { t: 1_900_000_000_000, now() { return this.t; } };
  const mgr = new SpecialEventManager({
    db: db as never,
    ledger: ledger as never,
    rpc,
    clock,
    tournamentManager: tm as never,
    treasuryPubkey: 'Treasury1111111111111111111111111111111111',
  });
  return { mgr, db, ledger, rpc, tm, clock };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('SpecialEventManager — pure helpers', () => {
  it('toBigIntStrict accepts integers + decimal strings, rejects garbage/negatives/fractions', () => {
    expect(toBigIntStrict(10, 'x')).toBe(10n);
    expect(toBigIntStrict('250', 'x')).toBe(250n);
    expect(toBigIntStrict(0n, 'x')).toBe(0n);
    expect(() => toBigIntStrict(-1, 'x')).toThrow(SpecialEventError);
    expect(() => toBigIntStrict(1.5, 'x')).toThrow(SpecialEventError);
    expect(() => toBigIntStrict('12.3', 'x')).toThrow(SpecialEventError);
    expect(() => toBigIntStrict('abc', 'x')).toThrow(SpecialEventError);
  });
});

describe('SpecialEventManager — create + gate validation', () => {
  it('rejects a half-configured hold gate (mint without bps)', async () => {
    const { mgr } = makeManager();
    await expect(
      mgr.createEvent({ slug: 'bad-hold', name: 'x', gateHoldMint: 'Mint1111', gateHoldBps: null }, null),
    ).rejects.toThrow(SpecialEventError);
  });

  it('rejects a bad slug', async () => {
    const { mgr } = makeManager();
    await expect(mgr.createEvent({ slug: 'BAD SLUG', name: 'x' }, null)).rejects.toThrow(
      SpecialEventError,
    );
  });
});

describe('SpecialEventManager — FREE event (all gates null)', () => {
  it('any human or agent signs up + is confirmed', async () => {
    const { mgr } = makeManager();
    await mgr.createEvent({ slug: 'free-party', name: 'Free Party' }, null);
    await mgr.openSignup('free-party');

    const h = await mgr.signup('free-party', human(), { entryMethod: 'free' });
    expect(h.status).toBe('confirmed');
    expect(h.entryMethod).toBe('free');

    const a = await mgr.signup('free-party', agent(), { entryMethod: 'free' });
    expect(a.status).toBe('confirmed');
  });

  it('signup is idempotent (re-signup → same row, no second charge)', async () => {
    const { mgr, ledger } = makeManager();
    await mgr.createEvent({ slug: 'idem', name: 'Idem', gateCt: 50 }, null);
    await mgr.openSignup('idem');
    const subj = human();
    ledger.setBalance(subj.avatarId, 1000);

    const first = await mgr.signup('idem', subj, { entryMethod: 'ct' });
    expect(first.alreadySignedUp).toBe(false);
    const second = await mgr.signup('idem', subj, { entryMethod: 'ct' });
    expect(second.alreadySignedUp).toBe(true);
    expect(second.signupId).toBe(first.signupId);
    // Exactly ONE debit despite two signup calls.
    expect(ledger.debits.length).toBe(1);
    expect(ledger.get(subj.avatarId)).toBe(950);
  });
});

describe('SpecialEventManager — HOLD gate (configured RPC)', () => {
  const MINT = 'Mint1111111111111111111111111111111111111111';

  it('threshold met → FREE entry with hold snapshot in proof', async () => {
    const { mgr, db, rpc } = makeManager();
    rpc.setSupply(MINT, 1_000_000n);
    const subj = human();
    const wallet = 'Wallet111111111111111111111111111111111111';
    rpc.setBalance(MINT, wallet, 20_000n); // 2% ≥ 1% (100 bps) required

    await mgr.createEvent({ slug: 'hold1', name: 'Hold1', gateHoldMint: MINT, gateHoldBps: 100 }, null);
    await mgr.openSignup('hold1');

    const res = await mgr.signup('hold1', subj, {
      entryMethod: 'hold',
      walletType: 'external',
      walletPubkey: wallet,
    });
    expect(res.status).toBe('confirmed');
    expect(res.entryMethod).toBe('hold');
    const row = [...db.signups.values()].find((s) => s.id === res.signupId)!;
    const proof = row.entry_proof_json as { requiredAtomic: string; balance: string };
    expect(proof.requiredAtomic).toBe('10000');
    expect(proof.balance).toBe('20000');
  });

  it('below threshold + NO fallback → rejected (402)', async () => {
    const { mgr, rpc } = makeManager();
    rpc.setSupply(MINT, 1_000_000n);
    const subj = human();
    const wallet = 'WalletLow11111111111111111111111111111111';
    rpc.setBalance(MINT, wallet, 5_000n); // 0.5% < 1% required

    await mgr.createEvent({ slug: 'hold2', name: 'Hold2', gateHoldMint: MINT, gateHoldBps: 100 }, null);
    await mgr.openSignup('hold2');

    await expect(
      mgr.signup('hold2', subj, { entryMethod: 'hold', walletType: 'external', walletPubkey: wallet }),
    ).rejects.toThrow(/insufficient_hold/);
  });

  it('below threshold + SOL fallback → must pay SOL; verified tx confirms, underpaid rejected', async () => {
    const { mgr, rpc } = makeManager();
    rpc.setSupply(MINT, 1_000_000n);
    const treasury = 'Treasury1111111111111111111111111111111111';
    await mgr.createEvent(
      { slug: 'hold-sol', name: 'HoldSol', gateHoldMint: MINT, gateHoldBps: 100, gateSolLamports: 1_000_000 },
      null,
    );
    await mgr.openSignup('hold-sol');

    // A below-threshold holder choosing the SOL fallback with a valid full payment.
    const paidSubj = human();
    rpc.setTx('sigFull', treasury, 1_000_000n, true);
    const ok = await mgr.signup('hold-sol', paidSubj, { entryMethod: 'sol', solTxSig: 'sigFull' });
    expect(ok.status).toBe('confirmed');
    expect(ok.entryMethod).toBe('sol');

    // An underpaid tx is rejected.
    const underSubj = human();
    rpc.setTx('sigShort', treasury, 500_000n, true);
    await expect(
      mgr.signup('hold-sol', underSubj, { entryMethod: 'sol', solTxSig: 'sigShort' }),
    ).rejects.toThrow(/sol_underpaid/);
  });
});

describe('SpecialEventManager — SOL gate + replay protection', () => {
  const TREASURY = 'Treasury1111111111111111111111111111111111';

  it('confirms only on a verified tx; a REPLAYED tx (2nd avatar) is rejected', async () => {
    const { mgr, rpc } = makeManager();
    await mgr.createEvent({ slug: 'sol-only', name: 'SolOnly', gateSolLamports: 2_000_000 }, null);
    await mgr.openSignup('sol-only');

    rpc.setTx('payA', TREASURY, 2_000_000n, true);
    const a = await mgr.signup('sol-only', human(), { entryMethod: 'sol', solTxSig: 'payA' });
    expect(a.status).toBe('confirmed');

    // A DIFFERENT avatar replaying the SAME sig → rejected (one payment = one seat).
    await expect(
      mgr.signup('sol-only', human(), { entryMethod: 'sol', solTxSig: 'payA' }),
    ).rejects.toThrow(/sol_tx_already_used/);

    // An unknown sig → rejected.
    await expect(
      mgr.signup('sol-only', human(), { entryMethod: 'sol', solTxSig: 'unknownSig' }),
    ).rejects.toThrow(/sol_tx_not_found_or_failed/);
  });

  it('one SOL payment can NOT satisfy entry to TWO concurrent SOL-gated events (cross-event replay closed)', async () => {
    // The treasury is a SINGLE shared pubkey and getSolTransfer is event-agnostic,
    // so a per-event replay scope would let one on-chain payment of `gate_sol_lamports`
    // enter event A AND event B for free. The global tx-sig uniqueness closes this.
    const { mgr, rpc } = makeManager();
    await mgr.createEvent({ slug: 'sol-a', name: 'SolA', gateSolLamports: 2_000_000 }, null);
    await mgr.createEvent({ slug: 'sol-b', name: 'SolB', gateSolLamports: 2_000_000 }, null);
    await mgr.openSignup('sol-a');
    await mgr.openSignup('sol-b');

    // ONE valid on-chain payment to the shared treasury.
    rpc.setTx('paid-once', TREASURY, 2_000_000n, true);

    // SAME avatar paid once → enters event A.
    const attacker = human();
    const inA = await mgr.signup('sol-a', attacker, { entryMethod: 'sol', solTxSig: 'paid-once' });
    expect(inA.status).toBe('confirmed');

    // Re-using the SAME sig to enter a DIFFERENT live SOL event → rejected globally,
    // by the same avatar...
    await expect(
      mgr.signup('sol-b', attacker, { entryMethod: 'sol', solTxSig: 'paid-once' }),
    ).rejects.toThrow(/sol_tx_already_used/);

    // ...and by a DIFFERENT avatar (the classic free-rider replay).
    await expect(
      mgr.signup('sol-b', human(), { entryMethod: 'sol', solTxSig: 'paid-once' }),
    ).rejects.toThrow(/sol_tx_already_used/);
  });

  it('DB partial-unique backstop: a 23505 on the SOL INSERT (race past the SELECT guard) surfaces as sol_tx_already_used', async () => {
    // Simulate the race the SELECT can't catch: two concurrent cross-event signups
    // lock DIFFERENT special_events rows, so neither sees the other's uncommitted
    // row in the dup-SELECT — only the partial unique index on the INSERT catches
    // the second one. Force that by making the dup-SELECT return empty while leaving
    // the INSERT index (modeled in FakeDb) intact, then pre-seed a colliding row.
    const db = new FakeDb();
    // Override the global SOL dup-SELECT to ALWAYS miss (the unserializable race).
    const baseExecute = db.execute.bind(db);
    db.execute = ((q: SQL) => {
      const { text } = renderSql(q);
      if (
        text.startsWith(
          "SELECT id FROM special_event_signups WHERE status <> 'refunded' AND entry_method = 'sol' AND entry_proof_json->>'txSig' = ?",
        )
      ) {
        return Promise.resolve([]); // race: dup-check sees nothing
      }
      return baseExecute(q);
    }) as typeof db.execute;

    const ledger = new FakeLedger();
    const rpc = new FakeRpc();
    const tm = new FakeTM();
    const mgr = new SpecialEventManager({
      db: db as never,
      ledger: ledger as never,
      rpc,
      tournamentManager: tm as never,
      treasuryPubkey: TREASURY,
    });

    await mgr.createEvent({ slug: 'sol-race', name: 'SolRace', gateSolLamports: 1_000_000 }, null);
    await mgr.openSignup('sol-race');
    rpc.setTx('race-sig', TREASURY, 1_000_000n, true);

    // Pre-seed a confirmed SOL signup carrying 'race-sig' (the row the racing txn
    // can't see in its SELECT but which the unique INDEX will collide with).
    db.signups.set('seed-race', {
      id: 'seed-race',
      event_id: randomUUID(),
      avatar_id: randomUUID(),
      entry_method: 'sol',
      status: 'confirmed',
      entry_proof_json: { txSig: 'race-sig' },
      created_at: new Date(),
    });

    await expect(
      mgr.signup('sol-race', human(), { entryMethod: 'sol', solTxSig: 'race-sig' }),
    ).rejects.toThrow(/sol_tx_already_used/);
  });
});

describe('SpecialEventManager — CT gate', () => {
  it('debits the ledger on confirm; insufficient balance throws', async () => {
    const { mgr, ledger } = makeManager();
    await mgr.createEvent({ slug: 'ct-gate', name: 'CtGate', gateCt: 100 }, null);
    await mgr.openSignup('ct-gate');

    const rich = human();
    ledger.setBalance(rich.avatarId, 500);
    const ok = await mgr.signup('ct-gate', rich, { entryMethod: 'ct' });
    expect(ok.status).toBe('confirmed');
    expect(ledger.get(rich.avatarId)).toBe(400);

    const poor = human();
    ledger.setBalance(poor.avatarId, 10);
    await expect(mgr.signup('ct-gate', poor, { entryMethod: 'ct' })).rejects.toThrow(
      InsufficientTokensError,
    );
  });
});

describe('SpecialEventManager — closeSignupAndStart (DEPENDENCY DIRECTION + prepaid)', () => {
  it('creates a tournament whose special_event_id === event.id, seats all confirmed signups, NO double-charge', async () => {
    const { mgr, ledger, tm, db } = makeManager();
    await mgr.createEvent(
      { slug: 'champ', name: 'Championship', gateCt: 200, prizeConfigJson: { seedPrizePoolCt: '5000' } },
      null,
    );
    await mgr.openSignup('champ');

    const subjects = [human(), human(), agent()];
    for (const s of subjects) {
      ledger.setBalance(s.avatarId, 1000);
      await mgr.signup('champ', s, { entryMethod: 'ct' });
    }
    expect(ledger.debits.length).toBe(3); // entry settled at the EVENT layer

    const ev = [...db.events.values()].find((e) => e.slug === 'champ')!;
    const result = await mgr.closeSignupAndStart('champ');

    // (1) exactly one tournament created, PREPAID (buyIn 0), pool seeded.
    expect(tm.created.length).toBe(1);
    const created = tm.created[0]!;
    expect(String(created.config.buyInCt)).toBe('0');
    expect(String(created.config.prepaid?.seedPrizePoolCt)).toBe('5000');

    // (2) DEPENDENCY DIRECTION: the tournament carries special_event_id === event.id.
    expect(created.config.specialEventId).toBe(ev.id as string);
    expect(created.id).toBe(result.tournamentId);

    // (3) the PARENT event row carries NO poker_tournament reference (direction).
    expect('poker_tournament_id' in ev).toBe(false);
    expect(Object.keys(ev)).not.toContain('poker_tournament_id');

    // (4) every confirmed signup seated; NO second buy-in debit (prepaid).
    expect(tm.registered.length).toBe(3);
    expect(tm.registered.every((r) => r.tournamentId === created.id)).toBe(true);
    expect(ledger.debits.length).toBe(3); // STILL 3 — seating did not re-charge
    expect(tm.started).toContain(created.id);

    // (5) the agent was seated AS ITSELF (Rule E5).
    const agentReg = tm.registered.find((r) => r.subject.kind === 'agent');
    expect(agentReg).toBeDefined();
    expect(agentReg!.subject.agentId).toBe(subjects[2]!.agentId);

    // event flipped to live.
    expect(ev.status).toBe('live');
  });

  it('refuses to start with < 2 confirmed signups', async () => {
    const { mgr, ledger } = makeManager();
    await mgr.createEvent({ slug: 'lonely', name: 'Lonely', gateCt: 10 }, null);
    await mgr.openSignup('lonely');
    const s = human();
    ledger.setBalance(s.avatarId, 100);
    await mgr.signup('lonely', s, { entryMethod: 'ct' });
    await expect(mgr.closeSignupAndStart('lonely')).rejects.toThrow(/not_enough_confirmed_signups/);
  });
});

describe('SpecialEventManager — start claim + seed bound (security M3/M4, 2026-09-30)', () => {
  /** A free event in 'signup_open' with two confirmed human signups. */
  async function openEventWithTwoSignups(
    slug: string,
    prizeConfigJson?: Record<string, unknown>,
  ) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Event ${slug}`, prizeConfigJson }, null);
    await h.mgr.openSignup(slug);
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    return { ...h, ev };
  }

  it('two CONCURRENT starts create exactly one tournament; the loser gets 409', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('race', { seedPrizePoolCt: 5000 });

    const [a, b] = await Promise.allSettled([
      mgr.closeSignupAndStart('race'),
      mgr.closeSignupAndStart('race'),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(SpecialEventError);
    expect(loser.reason.message).toBe('event_start_in_progress');
    expect(loser.reason.httpStatus).toBe(409);
    // The claim stops the loser BEFORE it reaches tournament creation (one seed).
    expect(tm.createCalls).toBe(1);
    expect(tm.created).toHaveLength(1);
    expect(ev.status).toBe('live');
  });

  it('a start on a live event and on a FRESH starting event is refused without a create', async () => {
    const h = await openEventWithTwoSignups('again');
    const { mgr, tm, ev } = h;
    await mgr.closeSignupAndStart('again');
    await expect(mgr.closeSignupAndStart('again')).rejects.toThrow(/event_already_started/);

    const { clock } = h;
    ev.status = 'starting';
    ev.start_claim_id = 'someone-else';
    ev.start_claimed_at = new Date(clock.now());
    await expect(mgr.closeSignupAndStart('again')).rejects.toThrow(/event_start_in_progress/);
    expect(tm.createCalls).toBe(1);
  });

  it('a create failure (treasury short) reopens signups and a retry succeeds', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('short', { seedPrizePoolCt: 5000 });
    tm.createError = new TournamentError('house_treasury_insufficient_for_seed', 402);

    await expect(mgr.closeSignupAndStart('short')).rejects.toMatchObject({
      message: 'tournament_create_failed:house_treasury_insufficient_for_seed',
      httpStatus: 402,
    });
    expect(ev.status).toBe('signup_open');
    expect(tm.created).toHaveLength(0);

    tm.createError = null;
    const result = await mgr.closeSignupAndStart('short');
    expect(result.status).toBe('live');
    expect(ev.status).toBe('live');
    expect(tm.created).toHaveLength(1);
  });

  it('a register failure cancels the created tournament (seed refund path) and reopens signups', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('reg-fail', { seedPrizePoolCt: 1000 });
    tm.registerError = new TournamentError('tournament_full', 409);

    await expect(mgr.closeSignupAndStart('reg-fail')).rejects.toMatchObject({
      message: 'tournament_start_failed:tournament_full',
      httpStatus: 409,
    });
    expect(tm.created).toHaveLength(1);
    expect(tm.cancelled).toEqual([tm.created[0]!.id]);
    expect(ev.status).toBe('signup_open');

    // The cancelled tournament no longer holds the event's active slot → retry works.
    tm.registerError = null;
    const result = await mgr.closeSignupAndStart('reg-fail');
    expect(result.tournamentId).toBe(tm.created[1]!.id);
    expect(ev.status).toBe('live');
  });

  it('a start the TM cancels (field below floor) reopens signups instead of going live', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('floor');
    tm.startStatus = 'cancelled';

    await expect(mgr.closeSignupAndStart('floor')).rejects.toMatchObject({
      message: 'tournament_start_cancelled',
      httpStatus: 409,
    });
    expect(tm.cancelled).toEqual([tm.created[0]!.id]);
    expect(ev.status).toBe('signup_open');
  });

  it('an existing active tournament for the event (DB unique index) → 409, signups reopened', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('dup');
    tm.created.push({ config: { specialEventId: ev.id } as never, createdBy: null, id: 'legacy-t' });

    await expect(mgr.closeSignupAndStart('dup')).rejects.toMatchObject({
      message: 'event_tournament_already_exists',
      httpStatus: 409,
    });
    expect(ev.status).toBe('signup_open');
  });

  it(`bounds the seed prize pool at create (max ${SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT})`, async () => {
    const { mgr } = makeManager();
    await expect(
      mgr.createEvent(
        { slug: 'too-rich', name: 'x', prizeConfigJson: { seedPrizePoolCt: SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT + 1 } },
        null,
      ),
    ).rejects.toMatchObject({ message: 'seed_prize_pool_exceeds_max', httpStatus: 400 });
    await expect(
      mgr.createEvent({ slug: 'weird', name: 'x', prizeConfigJson: { seedPrizePoolCt: { n: 1 } } }, null),
    ).rejects.toMatchObject({ message: 'invalid_seedPrizePoolCt' });
    const ok = await mgr.createEvent(
      { slug: 'at-max', name: 'x', prizeConfigJson: { seedPrizePoolCt: String(SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT) } },
      null,
    );
    expect(ok.status).toBe('draft');
    expect(readSeedPrizePoolCt(ok.prize_config_json)).toBe(BigInt(SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT));
  });

  it('a legacy over-bound seed is refused at start BEFORE the claim (event stays open)', async () => {
    const { mgr, tm, ev } = await openEventWithTwoSignups('legacy-seed');
    ev.prize_config_json = { seedPrizePoolCt: '999999999' };

    await expect(mgr.closeSignupAndStart('legacy-seed')).rejects.toMatchObject({
      message: 'seed_prize_pool_exceeds_max',
      httpStatus: 400,
    });
    expect(ev.status).toBe('signup_open');
    expect(tm.createCalls).toBe(0);
  });

  it("settleEventForTournament completes a 'starting' event whose tournament completed", async () => {
    const { mgr, db, ev } = await openEventWithTwoSignups('flip-lost');
    ev.status = 'starting'; // the final starting → live flip did not commit
    const tid = randomUUID();
    db.seedTournament({ id: tid, status: 'completed', special_event_id: ev.id, created_at: 1 });

    const out = await mgr.settleEventForTournament(tid);
    expect(out?.alreadySettled).toBe(false);
    expect(ev.status).toBe('completed');
  });
});

describe('SpecialEventManager — start recovery + guarded final flip (Codex BLOCKING 1+2)', () => {
  /** An open event with two confirmed signups, plus the shared fakes. */
  async function setup(slug: string) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Event ${slug}`, prizeConfigJson: { seedPrizePoolCt: 500 } }, null);
    await h.mgr.openSignup(slug);
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    return { ...h, ev };
  }
  /** Leave the event the way a crashed start would: 'starting' with a claim. */
  function crashedClaim(ev: Record<string, unknown>, claimedAt: number) {
    ev.status = 'starting';
    ev.start_claim_id = 'dead-claim';
    ev.start_claimed_at = new Date(claimedAt);
  }
  const STALE = SPECIAL_EVENT_START_CLAIM_STALE_MS + 1_000;

  it('crash after the claim, no tournament: the next start reconciles and succeeds', async () => {
    const { mgr, tm, ev, clock } = await setup('crash-claim');
    crashedClaim(ev, clock.now() - STALE);

    const result = await mgr.closeSignupAndStart('crash-claim');

    expect(result.status).toBe('live');
    expect(tm.created).toHaveLength(1);
    expect(ev.status).toBe('live');
    expect(ev.start_claim_id).toBeNull();
  });

  it('a FRESH claim (a start still in flight) is never taken over', async () => {
    const { mgr, tm, ev, clock } = await setup('fresh-claim');
    crashedClaim(ev, clock.now() - 1_000);

    await expect(mgr.closeSignupAndStart('fresh-claim')).rejects.toThrow(/event_start_in_progress/);
    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
    expect(ev.status).toBe('starting');
    expect(ev.start_claim_id).toBe('dead-claim');
    expect(tm.createCalls).toBe(0);
    expect(tm.cancelCalls).toBe(0);
  });

  it('crash after the create (funded, registering): the tick cancels it ONCE and reopens signups', async () => {
    const { mgr, tm, db, ev, clock } = await setup('crash-create');
    crashedClaim(ev, clock.now() - STALE);
    db.seedTournament({ id: 't-funded', status: 'registering', special_event_id: ev.id, created_at: 5 });

    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
    expect(db.tournaments.get('t-funded')!.status).toBe('cancelled');
    expect(tm.cancelCalls).toBe(1);
    expect(ev.status).toBe('signup_open');
    expect(ev.start_claim_id).toBeNull();

    // A second tick finds nothing to do: the seed refund cannot run twice.
    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
    expect(tm.cancelCalls).toBe(1);

    // The operator can start again; the cancelled tournament holds no active slot.
    const retry = await mgr.closeSignupAndStart('crash-create');
    expect(retry.status).toBe('live');
    expect(tm.created).toHaveLength(1);
  });

  it('crash after the tournament started (running): the tick marks the event live, no cancel', async () => {
    const { mgr, tm, db, ev, clock } = await setup('crash-running');
    crashedClaim(ev, clock.now() - STALE);
    db.seedTournament({ id: 't-running', status: 'running', special_event_id: ev.id, created_at: 5 });

    expect((await mgr.reconcileStaleStarts()).reconciled).toBe(1);
    expect(ev.status).toBe('live');
    expect(ev.start_claim_id).toBeNull();
    expect(db.tournaments.get('t-running')!.status).toBe('running');
    expect(tm.cancelCalls).toBe(0);
  });

  it('a stale claim whose tournament already completed → the event completes', async () => {
    const { mgr, db, ev, clock } = await setup('crash-done');
    crashedClaim(ev, clock.now() - STALE);
    db.seedTournament({ id: 't-done', status: 'completed', special_event_id: ev.id, created_at: 5 });

    await mgr.reconcileStaleStarts();
    expect(ev.status).toBe('completed');
    expect(ev.start_claim_id).toBeNull();
  });

  it('final flip with a LOST claim (reconciled mid-start): our tournament is cancelled, 409', async () => {
    const { mgr, tm, db, ev } = await setup('lost-claim');
    tm.onStarted = (tournamentId) => {
      // A takeover reopened the event and cancelled the tournament mid-start.
      db.tournaments.get(tournamentId)!.status = 'cancelled';
      ev.status = 'signup_open';
      ev.start_claim_id = null;
      ev.start_claimed_at = null;
    };

    await expect(mgr.closeSignupAndStart('lost-claim')).rejects.toMatchObject({
      message: 'event_start_claim_lost',
      httpStatus: 409,
    });
    expect(ev.status).toBe('signup_open');
    expect(db.tournaments.get(tm.created[0]!.id)!.status).toBe('cancelled');
  });

  it('final flip after the TM cancelled our tournament (room abort): 0 rows → reopen, 409', async () => {
    const { mgr, tm, db, ev } = await setup('aborted');
    tm.onStarted = (tournamentId) => {
      db.tournaments.get(tournamentId)!.status = 'cancelled';
    };

    await expect(mgr.closeSignupAndStart('aborted')).rejects.toMatchObject({
      message: 'tournament_start_cancelled',
      httpStatus: 409,
    });
    expect(ev.status).toBe('signup_open');
    expect(ev.start_claim_id).toBeNull();
  });

  it('final flip after someone else finalized the event WITH our tournament: success, no cancel', async () => {
    const { mgr, tm, ev } = await setup('finalized');
    tm.onStarted = () => {
      ev.status = 'live';
      ev.start_claim_id = null;
      ev.start_claimed_at = null;
    };

    const result = await mgr.closeSignupAndStart('finalized');
    expect(result.tournamentId).toBe(tm.created[0]!.id);
    expect(ev.status).toBe('live');
    expect(tm.cancelCalls).toBe(0);
  });
});

describe('SpecialEventManager — tournament cancelled around/after the live flip (Codex round 2, item 9)', () => {
  async function liveEvent(slug: string) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Event ${slug}`, prizeConfigJson: { seedPrizePoolCt: 500 } }, null);
    await h.mgr.openSignup(slug);
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    await h.mgr.signup(slug, human(), { entryMethod: 'free' });
    const result = await h.mgr.closeSignupAndStart(slug);
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    return { ...h, ev, tournamentId: result.tournamentId };
  }

  it('the flip locks the event row, THEN the tournament row, then updates (atomic vs a TM cancel)', async () => {
    const { db, ev, tournamentId } = await liveEvent('lock-order');
    const flipIdx = db.statements.findIndex((q) =>
      q.startsWith("UPDATE special_events SET status = 'live', started_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id = ? RETURNING id"),
    );
    const tournamentLockIdx = db.statements.lastIndexOf(
      'SELECT id, status FROM poker_tournaments WHERE id = ? AND special_event_id = ? FOR UPDATE',
    );
    const eventLockIdx = db.statements.lastIndexOf(
      'SELECT id, status, start_claim_id, start_claimed_at FROM special_events WHERE id = ? FOR UPDATE',
    );
    expect(flipIdx).toBeGreaterThan(-1);
    expect(eventLockIdx).toBeGreaterThan(-1);
    expect(eventLockIdx).toBeLessThan(tournamentLockIdx);
    expect(tournamentLockIdx).toBeLessThan(flipIdx);
    expect(ev.status).toBe('live');
    expect(db.tournaments.get(tournamentId)!.status).toBe('running');
  });

  it('room abort AFTER live: the worker pass reopens signups; a second pass is a no-op, no second refund', async () => {
    const { mgr, tm, db, ev, tournamentId } = await liveEvent('abort-after-live');
    // The room-abort / boot-recovery path is exactly tm.cancelAndRefundOrphan.
    await tm.cancelAndRefundOrphan(tournamentId);
    expect(tm.cancelCalls).toBe(1);
    expect(ev.status).toBe('live');

    expect(await mgr.reconcileEvents()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
    expect(ev.status).toBe('signup_open');
    expect(ev.started_at).toBeNull();
    expect(ev.start_claim_id).toBeNull();

    expect(await mgr.reconcileEvents()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
    expect(tm.cancelCalls).toBe(1); // the reopen itself never cancels or refunds
    expect(db.tournaments.get(tournamentId)!.status).toBe('cancelled');
  });

  it('a live event with a running tournament is never reopened', async () => {
    const { mgr, ev } = await liveEvent('still-running');
    expect(await mgr.reconcileEvents()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
    expect(await mgr.reconcileOrphanedLiveEvent(ev.id as string)).toBe('has_tournament');
    expect(ev.status).toBe('live');
  });

  it('a start on an orphaned live event reopens it first, then starts a fresh tournament', async () => {
    const { mgr, tm, ev, tournamentId } = await liveEvent('restart');
    await tm.cancelAndRefundOrphan(tournamentId);

    const again = await mgr.closeSignupAndStart('restart');
    expect(again.status).toBe('live');
    expect(again.tournamentId).not.toBe(tournamentId);
    expect(tm.created).toHaveLength(2);
    expect(ev.status).toBe('live');
  });
});

describe('SpecialEventManager — settleEvent (reads the linked tournament UP the FK)', () => {
  it('reads results via special_event_id and marks completed once the tournament settled', async () => {
    const { mgr, db } = makeManager();
    const ev = await mgr.createEvent({ slug: 'done-evt', name: 'DoneEvt' }, null);
    // Manually drive the event to 'live' and seed a SETTLED linked tournament.
    db.events.get(ev.id)!.status = 'live';
    const tid = randomUUID();
    db.seedTournament({ id: tid, status: 'completed', special_event_id: ev.id, created_at: 1 });
    db.seedResult({ tournament_id: tid, avatar_id: 'a1', agent_id: null, placement: 1, prize_ct: '3000' });
    db.seedResult({ tournament_id: tid, avatar_id: 'a2', agent_id: 'oc-x', placement: 2, prize_ct: '2000' });

    // A public status snapshot surfaces the linked results without performing
    // the event lifecycle write owned by the explicit settlement command.
    const snapshot = await mgr.getEventSettlementSnapshot('done-evt');
    expect(snapshot?.event.status).toBe('live');
    expect(snapshot?.tournamentId).toBe(tid);
    expect(snapshot?.results.length).toBe(2);
    expect(db.events.get(ev.id)!.status).toBe('live');

    const settle = await mgr.settleEvent('done-evt');
    expect(settle.tournamentId).toBe(tid);
    expect(settle.results.length).toBe(2);
    expect(settle.results[0]!.prizeCt).toBe('3000');
    expect(db.events.get(ev.id)!.status).toBe('completed');

    // Idempotent: second settle reports alreadySettled.
    const again = await mgr.settleEvent('done-evt');
    expect(again.alreadySettled).toBe(true);
  });

  it('early admin refusal is repaired by tournament completion and automatic replay is idempotent', async () => {
    const { mgr, db } = makeManager();
    const ev = await mgr.createEvent({ slug: 'late-finish', name: 'Late Finish' }, null);
    db.events.get(ev.id)!.status = 'live';
    const tid = randomUUID();
    db.seedTournament({ id: tid, status: 'running', special_event_id: ev.id, created_at: 1 });

    // Recovery command called too early: it must not complete the parent.
    const early = await mgr.settleEvent('late-finish');
    expect(early.alreadySettled).toBe(false);
    expect(db.events.get(ev.id)!.status).toBe('live');

    // The authoritative tournament transition later invokes this exact-id path.
    db.tournaments.get(tid)!.status = 'completed';
    db.seedResult({
      tournament_id: tid,
      avatar_id: 'winner',
      agent_id: null,
      placement: 1,
      prize_ct: '5000',
    });
    const automatic = await mgr.settleEventForTournament(tid);
    expect(automatic?.tournamentId).toBe(tid);
    expect(automatic?.results[0]?.prizeCt).toBe('5000');
    expect(db.events.get(ev.id)!.status).toBe('completed');

    // A replay (including a retry after an uncertain caller outcome) is harmless.
    const replay = await mgr.settleEventForTournament(tid);
    expect(replay?.alreadySettled).toBe(true);
    expect(db.events.get(ev.id)!.status).toBe('completed');
  });

  it('exact-id reconciliation never revives draft, signup-open, or cancelled parents', async () => {
    const { mgr, db } = makeManager();
    for (const status of ['draft', 'signup_open', 'cancelled']) {
      const ev = await mgr.createEvent(
        { slug: `${status.replace('_', '-')}-parent`, name: `${status} Parent` },
        null,
      );
      db.events.get(ev.id)!.status = status;
      const tid = randomUUID();
      db.seedTournament({ id: tid, status: 'completed', special_event_id: ev.id, created_at: 1 });

      const reconciliation = await mgr.settleEventForTournament(tid);

      expect(reconciliation?.alreadySettled).toBe(false);
      expect(db.events.get(ev.id)!.status).toBe(status);
      expect(db.events.get(ev.id)!.completed_at).toBeNull();
    }
  });
});
