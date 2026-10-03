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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'crypto';
import bs58 from 'bs58';
import {
  SpecialEventManager,
  SpecialEventError,
  SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT,
  SPECIAL_EVENT_START_CLAIM_STALE_MS,
  readSeedPrizePoolCt,
  singleCoveringSource,
  summarizeParsedSolTransfer,
  toBigIntStrict,
  type EventRpc,
  type SignupSubject,
} from '../special-event-manager';
import {
  TournamentError,
  SpecialEventClaimLostError,
  type CreateTournamentConfig,
  type CreateTournamentOptions,
  type CreateTournamentResult,
  type RegisterSubject,
  type RegisterResult,
  type StartResult,
} from '../poker/tournament-manager';
import { assertNoDateParams, takeDateParamViolations } from './helpers/sql-date-param-guard';

// Security batch 2 regression gate: every raw query the manager executes is
// checked for a bound JS Date (postgres-js throws a TypeError on one). The fake
// db throws on it; this hook also fails a test whose code swallowed that throw.
afterEach(() => {
  expect(takeDateParamViolations()).toEqual([]);
});

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
  /** claw_token_transactions rows the FakeLedger writes (cancel reads the entry burns). */
  ledgerRows: Row[] = [];

  query = {};
  private seq = 0;

  /** Seed a linked tournament + its results for settleEvent tests. */
  seedTournament(row: Row): void {
    this.tournaments.set(String(row.id), row);
  }
  seedResult(row: Row): void {
    this.results.push(row);
  }

  /** special_event_sol_refunds rows, by signup_id (UNIQUE signup_id). */
  solRefunds = new Map<string, Row>();

  /** special_event_used_tx_sigs rows, by tx_sig (PRIMARY KEY tx_sig, Codex r2). */
  usedTxSigs = new Map<string, Row>();

  /**
   * Race model (Codex r2): the signature PRE-CHECK SELECTs of signup and
   * mark-paid see nothing, as when two transactions run before either commits.
   * Only the used-signature PRIMARY KEY can then stop the second use.
   */
  blindSigPrechecks = false;

  /** Open transactions right now (a TM cancel must run with none: lock order). */
  txDepth = 0;

  /**
   * Opt-in Postgres ROLLBACK model: a transaction that throws restores the
   * events, signups, SOL refunds, ledger rows and every registered extra state
   * (the FakeLedger) IN PLACE (tests keep references to rows). Off by default:
   * concurrent fake transactions interleave, and a restore would clobber the
   * other transaction's writes. Only the single-call rollback tests turn it on.
   */
  rollbackOnThrow = false;
  rollbackParticipants: Array<() => () => void> = [];

  private snapshot(): () => void {
    const saveMap = (m: Map<string, Row>) => {
      const saved = new Map([...m].map(([k, v]) => [k, { ...v }] as const));
      return () => {
        for (const k of [...m.keys()]) if (!saved.has(k)) m.delete(k);
        for (const [k, v] of saved) {
          const live = m.get(k);
          if (live) {
            for (const key of Object.keys(live)) delete live[key];
            Object.assign(live, v);
          } else {
            m.set(k, v);
          }
        }
      };
    };
    const restores = [
      saveMap(this.events),
      saveMap(this.signups),
      saveMap(this.solRefunds),
      saveMap(this.usedTxSigs),
      (() => {
        const rows = [...this.ledgerRows];
        return () => void this.ledgerRows.splice(0, this.ledgerRows.length, ...rows);
      })(),
      ...this.rollbackParticipants.map((p) => p()),
    ];
    return () => restores.forEach((r) => r());
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    const restore = this.rollbackOnThrow && this.txDepth === 0 ? this.snapshot() : null;
    this.txDepth += 1;
    try {
      return await fn(this);
    } catch (err) {
      restore?.();
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** Every statement's normalized text, in order (lock-order assertions). */
  statements: string[] = [];

  async execute<T = Row>(q: SQL): Promise<T[]> {
    assertNoDateParams(q);
    const { text, params } = renderSql(q);
    this.statements.push(text);
    return this.dispatch(text, params) as T[];
  }

  /** `WHERE id = ? AND status = 'starting' AND start_claim_id IS NOT DISTINCT FROM ?`. */
  private casStarting(id: unknown, claimId: unknown): Row | undefined {
    const e = this.events.get(String(id));
    if (!e || e.status !== 'starting') return undefined;
    return (e.start_claim_id ?? null) === (claimId ?? null) ? e : undefined;
  }

  private bySlug(slug: unknown): Row | undefined {
    return [...this.events.values()].find((e) => e.slug === slug);
  }

  private dispatch(text: string, p: unknown[]): Row[] {
    // ── special_event_used_tx_sigs (Codex r2) ──────────────────────────────────
    if (text === 'INSERT INTO special_event_used_tx_sigs (tx_sig, use_kind, signup_id) VALUES (?, ?, ?) ON CONFLICT (tx_sig) DO NOTHING RETURNING tx_sig') {
      const sig = String(p[0]);
      if (this.usedTxSigs.has(sig)) return [];
      this.usedTxSigs.set(sig, { tx_sig: sig, use_kind: p[1], signup_id: p[2] });
      return [{ tx_sig: sig }];
    }
    if (text === 'SELECT 1 AS hit FROM special_event_used_tx_sigs WHERE tx_sig = ? UNION ALL SELECT 1 AS hit FROM special_event_sol_refunds WHERE refund_tx_sig = ? LIMIT 1') {
      if (this.blindSigPrechecks) return [];
      const hit =
        this.usedTxSigs.has(String(p[0])) ||
        [...this.solRefunds.values()].some((r) => r.refund_tx_sig === p[1]);
      return hit ? [{ hit: 1 }] : [];
    }
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
    if (text.startsWith("UPDATE special_events SET status = 'starting', start_claim_id = ?, start_claimed_at = ?::timestamptz WHERE id = ? AND status = 'signup_open' RETURNING id")) {
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
    // reconcileStartingEvent step 3: CAS on status + the SAME claim (null-safe).
    if (text === "UPDATE special_events SET status = 'completed', completed_at = now(), started_at = COALESCE(started_at, now()), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id IS NOT DISTINCT FROM ?::uuid RETURNING id") {
      const e = this.casStarting(p[0], p[1]);
      if (!e) return [];
      e.status = 'completed';
      e.completed_at = new Date(++this.seq);
      e.started_at = e.started_at ?? new Date(++this.seq);
      e.start_claim_id = null;
      e.start_claimed_at = null;
      return [{ id: e.id }];
    }
    if (text === "UPDATE special_events SET status = 'live', started_at = now(), start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id IS NOT DISTINCT FROM ?::uuid RETURNING id") {
      const e = this.casStarting(p[0], p[1]);
      if (!e) return [];
      e.status = 'live';
      e.started_at = new Date(++this.seq);
      e.start_claim_id = null;
      e.start_claimed_at = null;
      return [{ id: e.id }];
    }
    if (text === "UPDATE special_events SET status = 'signup_open', start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id IS NOT DISTINCT FROM ?::uuid RETURNING id") {
      const e = this.casStarting(p[0], p[1]);
      if (!e) return [];
      e.status = 'signup_open';
      e.start_claim_id = null;
      e.start_claimed_at = null;
      return [{ id: e.id }];
    }
    if (text.startsWith("SELECT id FROM special_events WHERE status = 'starting' AND (start_claimed_at IS NULL OR start_claimed_at < ?::timestamptz)")) {
      const cutoff = new Date(p[0] as string).getTime();
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
      if (this.blindSigPrechecks) return [];
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
      // (id, event_id, user_id, avatar_id, agent_id, subject_type, entry_method,
      //  wallet_used, entry_proof_json): the manager picks the id (Codex r2).
      const id = String(p[0]);
      p = p.slice(1);
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

    // ── cancelEvent (security pass gap, 2026-10-03) ─────────────────────────────
    if (text === "UPDATE special_events SET status = 'cancelled', start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status IN ('draft', 'signup_open') RETURNING id") {
      const e = this.events.get(String(p[0]));
      if (!e || (e.status !== 'draft' && e.status !== 'signup_open')) return [];
      e.status = 'cancelled';
      e.start_claim_id = null;
      e.start_claimed_at = null;
      return [{ id: e.id }];
    }
    if (text === "SELECT id, avatar_id, agent_id, entry_method, entry_proof_json, status FROM special_event_signups WHERE event_id = ? AND status <> 'refunded' ORDER BY created_at ASC") {
      return [...this.signups.values()]
        .filter((s) => s.event_id === p[0] && s.status !== 'refunded')
        .sort((a, b) => Number(a.created_at) - Number(b.created_at))
        .map((s) => ({ ...s }));
    }
    if (text === "UPDATE special_event_signups SET status = 'refunded' WHERE id = ? AND status <> 'refunded' RETURNING id") {
      const s = this.signups.get(String(p[0]));
      if (!s || s.status === 'refunded') return [];
      s.status = 'refunded';
      return [{ id: s.id }];
    }
    if (text === "SELECT provenance, (-amount)::int AS amount FROM claw_token_transactions WHERE avatar_id = ? AND reason = 'special_event_entry' AND amount < 0 AND metadata->>'eventId' = ?") {
      return this.ledgerRows
        .filter(
          (r) =>
            r.avatar_id === p[0] &&
            r.reason === 'special_event_entry' &&
            Number(r.amount) < 0 &&
            (r.metadata as { eventId?: unknown } | null)?.eventId === p[1],
        )
        .map((r) => ({ provenance: r.provenance ?? null, amount: -Number(r.amount) }));
    }

    // ── special_event_sol_refunds (Codex r1, 2026-10-03) ─────────────────────────
    const solSignupsWithoutRefund = (eventId: unknown) =>
      [...this.signups.values()]
        .filter(
          (s) =>
            s.event_id === eventId &&
            s.entry_method === 'sol' &&
            s.status !== 'refunded' &&
            !this.solRefunds.has(String(s.id)),
        )
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));
    if (text === "SELECT s.id, s.entry_proof_json FROM special_event_signups s WHERE s.event_id = ? AND s.entry_method = 'sol' AND s.status <> 'refunded' AND NOT EXISTS (SELECT 1 FROM special_event_sol_refunds r WHERE r.signup_id = s.id)") {
      return solSignupsWithoutRefund(p[0]).map((s) => ({ id: s.id, entry_proof_json: s.entry_proof_json }));
    }
    if (text === "SELECT s.id, s.avatar_id, s.entry_proof_json FROM special_event_signups s WHERE s.event_id = ? AND s.entry_method = 'sol' AND s.status <> 'refunded' AND NOT EXISTS (SELECT 1 FROM special_event_sol_refunds r WHERE r.signup_id = s.id) ORDER BY s.created_at ASC") {
      return solSignupsWithoutRefund(p[0]).map((s) => ({
        id: s.id,
        avatar_id: s.avatar_id,
        entry_proof_json: s.entry_proof_json,
      }));
    }
    if (text === 'INSERT INTO special_event_sol_refunds (event_id, signup_id, avatar_id, entry_tx_sig, lamports, receiving_pubkey, destination_pubkey) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (signup_id) DO NOTHING') {
      const signupId = String(p[1]);
      if (this.solRefunds.has(signupId)) return [];
      this.solRefunds.set(signupId, {
        event_id: p[0],
        signup_id: signupId,
        avatar_id: p[2],
        entry_tx_sig: p[3],
        lamports: p[4],
        receiving_pubkey: p[5],
        destination_pubkey: p[6] ?? null,
        destination_set_by: null,
        destination_set_at: null,
        status: 'owed',
        refund_tx_sig: null,
        refunded_at: null,
        refunded_by: null,
        created_at: ++this.seq,
      });
      return [];
    }
    const refundCols = (r: Row) => ({
      signup_id: r.signup_id,
      avatar_id: r.avatar_id,
      entry_tx_sig: r.entry_tx_sig,
      lamports: r.lamports,
      receiving_pubkey: r.receiving_pubkey,
      destination_pubkey: r.destination_pubkey,
      destination_set_by: r.destination_set_by ?? null,
      status: r.status,
      refund_tx_sig: r.refund_tx_sig,
      refunded_at: r.refunded_at,
      refunded_by: r.refunded_by,
    });
    if (text === 'SELECT signup_id, avatar_id, entry_tx_sig, lamports, receiving_pubkey, destination_pubkey, destination_set_by, status, refund_tx_sig, refunded_at, refunded_by FROM special_event_sol_refunds WHERE event_id = ? ORDER BY created_at ASC, signup_id ASC') {
      return [...this.solRefunds.values()]
        .filter((r) => r.event_id === p[0])
        .sort((a, b) => Number(a.created_at) - Number(b.created_at))
        .map(refundCols);
    }
    if (text === "UPDATE special_event_sol_refunds SET destination_pubkey = ? WHERE signup_id = ? AND event_id = ? AND status = 'owed' AND destination_pubkey IS NULL") {
      const r = this.solRefunds.get(String(p[1]));
      if (r && r.event_id === p[2] && r.status === 'owed' && r.destination_pubkey == null) {
        r.destination_pubkey = p[0];
      }
      return [];
    }
    if (text === "UPDATE special_event_sol_refunds SET destination_pubkey = ?, destination_set_by = ?, destination_set_at = ?::timestamptz WHERE signup_id = ? AND event_id = ? AND status = 'owed' AND destination_pubkey IS NULL RETURNING signup_id, avatar_id, entry_tx_sig, lamports, receiving_pubkey, destination_pubkey, destination_set_by, status, refund_tx_sig, refunded_at, refunded_by") {
      const r = this.solRefunds.get(String(p[3]));
      if (!r || r.event_id !== p[4] || r.status !== 'owed' || r.destination_pubkey != null) return [];
      r.destination_pubkey = p[0];
      r.destination_set_by = p[1] ?? null;
      r.destination_set_at = p[2];
      return [refundCols(r)];
    }
    if (text === "SELECT 1 AS hit FROM special_event_sol_refunds WHERE refund_tx_sig = ? UNION ALL SELECT 1 AS hit FROM special_event_signups WHERE entry_method = 'sol' AND entry_proof_json->>'txSig' = ? UNION ALL SELECT 1 AS hit FROM special_event_used_tx_sigs WHERE tx_sig = ? LIMIT 1") {
      if (this.blindSigPrechecks) return [];
      const hit =
        [...this.solRefunds.values()].some((r) => r.refund_tx_sig === p[0]) ||
        [...this.signups.values()].some(
          (s) => s.entry_method === 'sol' && (s.entry_proof_json as { txSig?: string } | null)?.txSig === p[1],
        ) ||
        this.usedTxSigs.has(String(p[2]));
      return hit ? [{ hit: 1 }] : [];
    }
    if (text === "UPDATE special_event_sol_refunds SET status = 'refunded', refund_tx_sig = ?, refunded_at = ?::timestamptz, refunded_by = ? WHERE signup_id = ? AND event_id = ? AND status = 'owed' AND destination_pubkey = ? RETURNING signup_id, avatar_id, entry_tx_sig, lamports, receiving_pubkey, destination_pubkey, destination_set_by, status, refund_tx_sig, refunded_at, refunded_by") {
      // Model the UNIQUE index special_event_sol_refunds_refund_tx_unique.
      if ([...this.solRefunds.values()].some((r) => r.refund_tx_sig === p[0])) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "special_event_sol_refunds_refund_tx_unique"'),
          { code: '23505' },
        );
      }
      const r = this.solRefunds.get(String(p[3]));
      if (!r || r.event_id !== p[4] || r.status !== 'owed' || r.destination_pubkey !== p[5]) return [];
      r.status = 'refunded';
      r.refund_tx_sig = p[0];
      r.refunded_at = p[1];
      r.refunded_by = p[2] ?? null;
      return [refundCols(r)];
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

type Tag = 'soft' | 'bought' | 'earned';

class FakeLedger {
  balances = new Map<string, number>();
  debits: Array<{ avatarId: string; amount: number; reason: string }> = [];
  credits: Array<{
    avatarId: string;
    amount: number;
    reason: string;
    provenance?: 'soft' | 'bought';
    metadata?: Record<string, unknown>;
  }> = [];
  /** Optional per-avatar tag split; absent ⇒ the whole balance is SOFT. */
  tags = new Map<string, Record<Tag, number>>();
  /** Shared with FakeDb.ledgerRows (claw_token_transactions). */
  rows: Row[] = [];

  setTags(a: string, t: Record<Tag, number>): void {
    this.tags.set(a, { ...t });
    this.balances.set(a, t.soft + t.bought + t.earned);
  }

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
    // Same burn order as the real ledger: SOFT → BOUGHT → EARNED, one row per tag.
    const tags = this.tags.get(input.avatarId) ?? { soft: bal, bought: 0, earned: 0 };
    let remaining = input.amount;
    let ledgerId = '';
    for (const tag of ['soft', 'bought', 'earned'] as const) {
      const take = Math.min(tags[tag], remaining);
      if (take <= 0) continue;
      tags[tag] -= take;
      remaining -= take;
      ledgerId = randomUUID();
      this.rows.push({
        id: ledgerId,
        avatar_id: input.avatarId,
        amount: -take,
        reason: input.reason,
        provenance: tag,
        metadata: (input as { metadata?: unknown }).metadata ?? {},
      });
    }
    if (this.tags.has(input.avatarId)) this.tags.set(input.avatarId, tags);
    return { balanceAfter: bal - input.amount, ledgerId };
  };
  creditClawTokens = async (input: {
    avatarId: string;
    amount: number;
    reason: string;
    provenance?: 'soft' | 'bought';
    metadata?: Record<string, unknown>;
  }) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal + input.amount);
    this.credits.push({ ...input });
    const t = this.tags.get(input.avatarId);
    if (t) t[input.provenance ?? 'soft'] += input.amount;
    this.rows.push({
      id: randomUUID(),
      avatar_id: input.avatarId,
      amount: input.amount,
      reason: input.reason,
      provenance: input.provenance ?? 'soft',
      metadata: input.metadata ?? {},
    });
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
}

// ─── Fake RPC ─────────────────────────────────────────────────────────────────

class FakeRpc implements EventRpc {
  supply = new Map<string, bigint>();
  balances = new Map<string, bigint>(); // key = `${mint}:${owner}`
  /** sig -> destination -> what the tx credits that destination, by source. */
  txs = new Map<
    string,
    Map<string, { lamportsToDest: bigint; success: boolean; transfers: Map<string, bigint> }>
  >();
  /** The commitment each getSolTransfer call asked for ('confirmed' when omitted). */
  commitments: string[] = [];
  /** A sig whose lookup throws (an RPC outage). */
  failing = new Set<string>();

  setSupply(mint: string, s: bigint): void {
    this.supply.set(mint, s);
  }
  setBalance(mint: string, owner: string, b: bigint): void {
    this.balances.set(`${mint}:${owner}`, b);
  }
  /**
   * `payer` = the source of ONE System transfer of the full `lamports` into
   * `dest` (null = no System transfer, so no provable payer).
   */
  setTx(sig: string, dest: string, lamports: bigint, success = true, payer: string | null = null): void {
    this.setTxTransfers(sig, dest, lamports, payer ? [[payer, lamports]] : [], success);
  }
  /**
   * The destination's balance increase plus every System transfer into it as
   * [source, lamports] (summed per source, like the real parser). Each call sets
   * one destination of the tx; other destinations of the same sig stay.
   */
  setTxTransfers(
    sig: string,
    dest: string,
    lamportsToDest: bigint,
    transfers: Array<[string, bigint]>,
    success = true,
  ): void {
    const bySource = new Map<string, bigint>();
    for (const [source, lamports] of transfers) {
      bySource.set(source, (bySource.get(source) ?? 0n) + lamports);
    }
    const legs = this.txs.get(sig) ?? new Map();
    legs.set(dest, { lamportsToDest, success, transfers: bySource });
    this.txs.set(sig, legs);
  }

  async getTokenSupply(mint: string): Promise<bigint> {
    return this.supply.get(mint) ?? 0n;
  }
  async getTokenBalance(mint: string, owner: string): Promise<bigint> {
    return this.balances.get(`${mint}:${owner}`) ?? 0n;
  }
  async getSolTransfer(
    sig: string,
    expectedDest: string,
    opts?: { commitment?: 'confirmed' | 'finalized' },
  ) {
    this.commitments.push(opts?.commitment ?? 'confirmed');
    if (this.failing.has(sig)) throw new Error('rpc unavailable');
    const legs = this.txs.get(sig);
    if (!legs) return null;
    // Only a destination the tx credits gets lamports and transfers.
    const leg = legs.get(expectedDest);
    return {
      lamportsToDest: leg?.lamportsToDest ?? 0n,
      success: leg?.success ?? [...legs.values()][0]!.success,
      transfersBySource: new Map(leg?.transfers ?? []),
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
  /** Runs after a cancelAndRefundOrphan (race injection between reconcile steps). */
  onCancel: ((tournamentId: string) => void) | null = null;
  /** db.txDepth at each cancelAndRefundOrphan call (lock-order assertions). */
  cancelTxDepths: number[] = [];
  /** The options each createTournament call received (claim pass-through). */
  createOpts: CreateTournamentOptions[] = [];
  /** Runs inside createTournament before its tx (a stalled start; race injection). */
  beforeCreateTx: (() => Promise<void>) | null = null;
  /** Runs at the top of cancelAndRefundOrphan, before its status checks. */
  beforeCancel: ((tournamentId: string) => void) | null = null;
  /** Cancels the status guard refused (the tournament moved past the caller's read). */
  refusedCancels: string[] = [];
  /** The shared FakeDb, so the manager's SQL sees these tournaments. */
  db: FakeDb | null = null;
  private seq = 0;

  async createTournament(
    config: CreateTournamentConfig,
    createdBy: string | null,
    opts: CreateTournamentOptions = {},
  ): Promise<CreateTournamentResult> {
    this.createCalls += 1;
    this.createOpts.push(opts);
    // Same up-front validation as the real TM: an event-linked create needs the claim.
    const claimId = opts.specialEventStartClaimId ?? null;
    if (config.specialEventId && claimId == null) {
      throw new TournamentError('special_event_start_claim_required', 400);
    }
    // Yield so a concurrent start can interleave (the real create does DB I/O).
    await Promise.resolve();
    // A start that stalls here (before the create tx) while a reconcile runs.
    if (this.beforeCreateTx) await this.beforeCreateTx();
    // The real TM's first statement in the create tx: lock the event row and
    // require 'starting' under the caller's claim, BEFORE the seed debit.
    if (config.specialEventId) {
      const ev = this.db?.events.get(String(config.specialEventId));
      if (!ev || ev.status !== 'starting' || ev.start_claim_id !== claimId) {
        throw new SpecialEventClaimLostError();
      }
    }
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
  async cancelAndRefundOrphan(
    tournamentId: string,
    opts: { onlyIfStatusIn?: readonly string[] } = {},
  ): Promise<number> {
    this.cancelCalls += 1;
    this.cancelTxDepths.push(this.db?.txDepth ?? 0);
    this.beforeCancel?.(tournamentId);
    const row = this.db?.tournaments.get(tournamentId);
    // Same terminal guard as the real TM: completed/cancelled → idempotent no-op.
    if (row && (row.status === 'completed' || row.status === 'cancelled')) return 0;
    // Same status guard as the real TM (checked under its row lock): a row whose
    // current status is outside `onlyIfStatusIn` is left as it is, no refund.
    if (row && opts.onlyIfStatusIn && !opts.onlyIfStatusIn.includes(String(row.status))) {
      this.refusedCancels.push(tournamentId);
      return 0;
    }
    if (row) row.status = 'cancelled';
    if (!this.cancelled.includes(tournamentId)) this.cancelled.push(tournamentId);
    this.onCancel?.(tournamentId);
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
  ledger.rows = db.ledgerRows;
  // The ledger state rolls back with the fake tx (when rollbackOnThrow is on).
  db.rollbackParticipants.push(() => {
    const balances = new Map(ledger.balances);
    const credits = [...ledger.credits];
    const debits = [...ledger.debits];
    const tags = new Map([...ledger.tags].map(([k, v]) => [k, { ...v }] as const));
    return () => {
      ledger.balances.clear();
      for (const [k, v] of balances) ledger.balances.set(k, v);
      ledger.credits.splice(0, ledger.credits.length, ...credits);
      ledger.debits.splice(0, ledger.debits.length, ...debits);
      ledger.tags.clear();
      for (const [k, v] of tags) ledger.tags.set(k, v);
    };
  });
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

  // Codex BLOCKING (security batch 2): a start that stalls before its create tx
  // must not insert a seeded tournament after a stale reconcile reopened the event.
  it('late insert after a stale reconcile reopened the event: claim lost, nothing created, signups stay open', async () => {
    const { mgr, tm, db, ev, clock } = await setup('late-insert');
    tm.beforeCreateTx = async () => {
      tm.beforeCreateTx = null;
      // The start stalls past the stale window; the worker tick finds no linked
      // tournament and reopens the event (Step 1 none → Step 3 reopen).
      clock.t += STALE;
      expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
      expect(ev.status).toBe('signup_open');
    };

    await expect(mgr.closeSignupAndStart('late-insert')).rejects.toMatchObject({
      name: 'SpecialEventError',
      message: 'event_start_claim_lost',
      httpStatus: 409,
    });
    expect(tm.createCalls).toBe(1);
    expect(tm.created).toHaveLength(0);
    expect(db.tournaments.size).toBe(0);
    expect(tm.registered).toHaveLength(0);
    expect(tm.started).toHaveLength(0);
    // Nothing was debited, so nothing is cancelled or refunded.
    expect(tm.cancelCalls).toBe(0);
    expect(ev.status).toBe('signup_open');
    expect(ev.start_claim_id).toBeNull();

    // The operator retries; the new claim inserts normally.
    const retry = await mgr.closeSignupAndStart('late-insert');
    expect(retry.status).toBe('live');
    expect(tm.created).toHaveLength(1);
    expect(ev.status).toBe('live');
  });

  it('the start passes its OWN claim to the create, and that claim inserts', async () => {
    const { mgr, tm, ev } = await setup('own-claim');
    let claimAtCreate: unknown = null;
    tm.beforeCreateTx = async () => {
      claimAtCreate = ev.start_claim_id;
    };

    const result = await mgr.closeSignupAndStart('own-claim');

    expect(typeof claimAtCreate).toBe('string');
    expect(tm.createOpts).toEqual([{ specialEventStartClaimId: claimAtCreate as string }]);
    expect(result.tournamentId).toBe(tm.created[0]!.id);
    expect(tm.created[0]!.config.specialEventId).toBe(ev.id as string);
    expect(ev.status).toBe('live');
  });
});

describe('SpecialEventManager — reconcile lock order: TM cancel outside the event lock (security batch 2)', () => {
  /** A 'starting' event with a stale claim and a funded registering tournament. */
  async function staleStarting(slug: string) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Event ${slug}`, prizeConfigJson: { seedPrizePoolCt: 500 } }, null);
    await h.mgr.openSignup(slug);
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    ev.status = 'starting';
    ev.start_claim_id = 'dead-claim';
    ev.start_claimed_at = new Date(h.clock.now() - SPECIAL_EVENT_START_CLAIM_STALE_MS - 1_000);
    h.db.seedTournament({ id: 't-reg', status: 'registering', special_event_id: ev.id, created_at: 5 });
    return { ...h, ev };
  }
  const LOCK = 'SELECT id, status, start_claim_id, start_claimed_at FROM special_events WHERE id = ? FOR UPDATE';
  const LINKED =
    "SELECT id, status FROM poker_tournaments WHERE special_event_id = ? AND status <> 'cancelled' ORDER BY created_at DESC";

  it('cancels with NO open transaction, then re-locks the event before the CAS write', async () => {
    const { mgr, tm, db, ev } = await staleStarting('lock-order');
    let locksAtCancel = -1;
    tm.onCancel = () => {
      locksAtCancel = db.statements.filter((t) => t === LOCK).length;
    };
    db.statements.length = 0;

    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });

    // The cancel ran between the two event locks, outside every transaction, so
    // the event lock is never held while the cancel takes the tournament and
    // treasury rows.
    expect(tm.cancelTxDepths).toEqual([0]);
    expect(locksAtCancel).toBe(1);
    const recon = db.statements.filter(
      (t) => t === LOCK || t === LINKED || t.startsWith('UPDATE special_events'),
    );
    expect(recon).toEqual([
      LOCK,
      LINKED,
      LOCK,
      LINKED,
      "UPDATE special_events SET status = 'signup_open', start_claim_id = NULL, start_claimed_at = NULL WHERE id = ? AND status = 'starting' AND start_claim_id IS NOT DISTINCT FROM ?::uuid RETURNING id",
    ]);
    expect(ev.status).toBe('signup_open');
    expect(ev.start_claim_id).toBeNull();
    expect(db.tournaments.get('t-reg')!.status).toBe('cancelled');
    expect(tm.cancelCalls).toBe(1);
  });

  it('event reopened by another pass between the cancel and the re-lock: no write, no second cancel', async () => {
    const { mgr, tm, ev } = await staleStarting('changed-reopened');
    tm.onCancel = () => {
      ev.status = 'signup_open';
      ev.start_claim_id = null;
      ev.start_claimed_at = null;
    };

    expect(await mgr.reconcileStartingEvent(String(ev.id), { claimId: 'dead-claim' })).toBe('not_starting');
    expect(ev.status).toBe('signup_open');
    expect(tm.cancelCalls).toBe(1);
    // A later tick finds nothing to do: the seed is refunded exactly once.
    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
    expect(tm.cancelCalls).toBe(1);
  });

  it('a NEW start claimed the event between the cancel and the re-lock: the new claim is left intact', async () => {
    const { mgr, tm, ev, clock } = await staleStarting('changed-new-claim');
    tm.onCancel = () => {
      // Another pass reopened it and a fresh start claimed it.
      ev.status = 'starting';
      ev.start_claim_id = 'new-claim';
      ev.start_claimed_at = new Date(clock.now());
    };

    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 0, failed: 0 });
    expect(ev.status).toBe('starting');
    expect(ev.start_claim_id).toBe('new-claim');
    expect(tm.cancelCalls).toBe(1);
  });

  it('a start finalized the event live between the cancel and the re-lock: live is not clobbered', async () => {
    const { mgr, tm, db, ev } = await staleStarting('changed-live');
    tm.onCancel = () => {
      db.seedTournament({ id: 't-run', status: 'running', special_event_id: ev.id, created_at: 9 });
      ev.status = 'live';
      ev.start_claim_id = null;
      ev.start_claimed_at = null;
    };

    expect(await mgr.reconcileStartingEvent(String(ev.id), { claimId: 'dead-claim' })).toBe('not_starting');
    expect(ev.status).toBe('live');
    expect(db.tournaments.get('t-run')!.status).toBe('running');
  });

  it('a registering tournament still linked at the re-lock keeps the event starting; the next pass cancels it once and reopens', async () => {
    const { mgr, tm, db, ev } = await staleStarting('leftover');
    let injected = false;
    tm.onCancel = () => {
      if (injected) return;
      injected = true;
      db.seedTournament({ id: 't-late', status: 'registering', special_event_id: ev.id, created_at: 9 });
    };

    expect(await mgr.reconcileStartingEvent(String(ev.id), { claimId: 'dead-claim' })).toBe('in_progress');
    expect(ev.status).toBe('starting');
    expect(ev.start_claim_id).toBe('dead-claim');
    expect(db.tournaments.get('t-late')!.status).toBe('registering');

    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
    expect(ev.status).toBe('signup_open');
    expect(db.tournaments.get('t-late')!.status).toBe('cancelled');
    expect(tm.cancelled.filter((id) => id === 't-late')).toHaveLength(1);
    expect(tm.cancelCalls).toBe(2);
  });

  it('after the cancel step, a running tournament maps the event to live and a completed one to completed', async () => {
    const live = await staleStarting('after-cancel-live');
    live.tm.onCancel = () => {
      live.db.seedTournament({ id: 't-run2', status: 'running', special_event_id: live.ev.id, created_at: 9 });
    };
    expect(await live.mgr.reconcileStartingEvent(String(live.ev.id), { claimId: 'dead-claim' })).toBe('live');
    expect(live.ev.status).toBe('live');
    expect(live.ev.start_claim_id).toBeNull();

    const done = await staleStarting('after-cancel-done');
    done.tm.onCancel = () => {
      done.db.seedTournament({ id: 't-done2', status: 'completed', special_event_id: done.ev.id, created_at: 9 });
    };
    expect(await done.mgr.reconcileStartingEvent(String(done.ev.id), { claimId: 'dead-claim' })).toBe('completed');
    expect(done.ev.status).toBe('completed');
    expect(done.ev.start_claim_id).toBeNull();
  });

  // Codex SHOULD-FIX (security batch 2): step 2 acts on a snapshot taken under a
  // released lock. The cancel is limited to registering/seating and re-checked
  // under the tournament row lock, so a tournament that started since is kept.
  it('a snapshot tournament that reached running before the cancel is NOT cancelled; the event maps to live', async () => {
    const { mgr, tm, db, ev } = await staleStarting('started-before-cancel');
    tm.beforeCancel = (tournamentId) => {
      db.tournaments.get(tournamentId)!.status = 'running';
    };

    expect(await mgr.reconcileStaleStarts()).toEqual({ scanned: 1, reconciled: 1, failed: 0 });

    expect(tm.cancelCalls).toBe(1);
    expect(tm.refusedCancels).toEqual(['t-reg']);
    expect(tm.cancelled).toEqual([]);
    expect(db.tournaments.get('t-reg')!.status).toBe('running');
    expect(ev.status).toBe('live');
    expect(ev.start_claim_id).toBeNull();
  });
});

describe('SpecialEventManager — raw sql timestamps bind as ISO strings (security batch 2)', () => {
  it('createEvent binds the registration/start Dates as ISO strings', async () => {
    const { mgr, db } = makeManager();
    const opens = new Date('2026-10-03T12:00:00.000Z');
    const closes = new Date('2026-10-04T12:00:00.000Z');
    const starts = new Date('2026-10-04T13:00:00.000Z');
    const row = await mgr.createEvent(
      { slug: 'dated', name: 'Dated', registrationOpensAt: opens, registrationClosesAt: closes, startsAt: starts },
      null,
    );
    expect(row.registration_opens_at).toBe(opens.toISOString());
    expect(row.registration_closes_at).toBe(closes.toISOString());
    expect(row.starts_at).toBe(starts.toISOString());
    expect(db.statements[0]).toContain('?::timestamptz, ?::timestamptz, ?::timestamptz');
  });

  it('the start claim binds start_claimed_at as an ISO string, and the worker pass runs', async () => {
    const { mgr, db, clock } = makeManager();
    await mgr.createEvent({ slug: 'claim-iso', name: 'x' }, null);
    await mgr.openSignup('claim-iso');
    await mgr.signup('claim-iso', human(), { entryMethod: 'free' });
    await mgr.signup('claim-iso', human(), { entryMethod: 'free' });
    const ev = [...db.events.values()].find((e) => e.slug === 'claim-iso')!;
    const claimTimes: unknown[] = [];
    const exec = db.execute.bind(db);
    db.execute = (async (q: SQL) => {
      const { text, params } = renderSql(q);
      if (text.startsWith("UPDATE special_events SET status = 'starting'")) claimTimes.push(params[1]);
      return exec(q);
    }) as typeof db.execute;

    await mgr.closeSignupAndStart('claim-iso');
    expect(claimTimes).toEqual([new Date(clock.now()).toISOString()]);
    expect(ev.status).toBe('live');

    // The worker pass (reconcileEvents → reconcileStaleStarts) binds its cutoff
    // as an ISO string too, so it runs instead of throwing.
    expect(await mgr.reconcileEvents()).toEqual({ scanned: 0, reconciled: 0, failed: 0 });
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

    // Recovery command called too early: it must not complete the parent, and
    // it reports the refusal (409), not ok (Codex r1, 2026-10-03).
    await expect(mgr.settleEvent('late-finish')).rejects.toMatchObject({
      message: 'event_not_settleable',
      httpStatus: 409,
    });
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

describe('SpecialEventManager — cancelEvent + refunds (security pass gap, 2026-10-03)', () => {
  const STALE = SPECIAL_EVENT_START_CLAIM_STALE_MS + 1_000;
  const TREASURY = 'house-treasury-avatar';
  const PROVEN_PAYER = 'ProvenPayer1111111111111111111111111111111';

  /**
   * An open event (CT gate 50 + SOL fallback, seed 500) with a human CT signup,
   * an agent CT signup whose balance spans SOFT/BOUGHT/EARNED, and a SOL signup.
   */
  async function paidEvent(slug: string) {
    const h = makeManager();
    await h.mgr.createEvent(
      {
        slug,
        name: `Event ${slug}`,
        gateCt: 50,
        gateSolLamports: 1_000_000,
        prizeConfigJson: { seedPrizePoolCt: 500 },
      },
      null,
    );
    await h.mgr.openSignup(slug);
    const humanCt = human();
    h.ledger.setBalance(humanCt.avatarId, 1_000);
    await h.mgr.signup(slug, humanCt, { entryMethod: 'ct' });

    // 20 SOFT + 10 BOUGHT + 100 EARNED: the 50 entry burns 20 soft, 10 bought, 20 earned.
    const agentCt = agent();
    h.ledger.setTags(agentCt.avatarId, { soft: 20, bought: 10, earned: 100 });
    await h.mgr.signup(slug, agentCt, { entryMethod: 'ct' });

    const solSubj = human();
    const sig = `sig-${slug}-${'x'.repeat(40)}`;
    // The proven payer differs from the client-claimed walletPubkey on purpose:
    // a refund must go to the sender the chain proves, never the claim.
    h.rpc.setTx(sig, 'Treasury1111111111111111111111111111111111', 1_000_000n, true, PROVEN_PAYER);
    await h.mgr.signup(slug, solSubj, {
      entryMethod: 'sol',
      walletPubkey: 'Payer11111111111111111111111111111111111111',
      solTxSig: sig,
    });
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    return { ...h, ev, humanCt, agentCt, solSubj, sig };
  }

  const signupsOf = (db: { signups: Map<string, Record<string, unknown>> }, eventId: unknown) =>
    [...db.signups.values()].filter((s) => s.event_id === eventId);

  it('pre-start cancel refunds every paid CT signup exactly once, mirroring provenance; SOL is listed as owed', async () => {
    const { mgr, db, ledger, ev, humanCt, agentCt, solSubj, sig } = await paidEvent('cancel-open');
    expect(ledger.get(humanCt.avatarId)).toBe(950);
    expect(ledger.get(agentCt.avatarId)).toBe(80);

    const result = await mgr.cancelEvent('cancel-open');

    expect(result.alreadyCancelled).toBe(false);
    expect(result.status).toBe('cancelled');
    expect(result.refundedSignups).toBe(2);
    expect(result.refundedCt).toBe(100);
    expect(ev.status).toBe('cancelled');

    // Human and agent get the same treatment, bound to their own avatar.
    expect(ledger.get(humanCt.avatarId)).toBe(1_000);
    expect(ledger.get(agentCt.avatarId)).toBe(130);
    const refunds = ledger.credits.filter((c) => c.reason === 'special_event_entry_refund');
    expect(refunds.filter((c) => c.avatarId === humanCt.avatarId)).toEqual([
      expect.objectContaining({ amount: 50, provenance: 'soft' }),
    ]);
    // SOFT → SOFT, BOUGHT → BOUGHT, EARNED → SOFT (EARNED is mintEarned-only).
    const agentRefunds = refunds.filter((c) => c.avatarId === agentCt.avatarId);
    expect(agentRefunds.map((c) => [c.amount, c.provenance, c.metadata?.burnedProvenance])).toEqual([
      [20, 'soft', 'soft'],
      [10, 'bought', 'bought'],
      [20, 'soft', 'earned'],
    ]);
    expect(ledger.tags.get(agentCt.avatarId)).toEqual({ soft: 40, bought: 10, earned: 80 });
    for (const c of refunds) {
      expect(c.metadata?.eventId).toBe(ev.id);
      expect(typeof c.metadata?.signupId).toBe('string');
    }
    // No treasury movement: a signup_open event holds no seed.
    expect(ledger.credits.some((c) => c.avatarId === TREASURY)).toBe(false);

    // SOL: kept 'confirmed' (tx sig stays reserved) and recorded as a durable
    // owed refund to the PROVEN payer (not the client-claimed walletPubkey).
    const solRow = signupsOf(db, ev.id).find((s) => s.avatar_id === solSubj.avatarId)!;
    expect(solRow.status).toBe('confirmed');
    const owed = {
      signupId: String(solRow.id),
      avatarId: solSubj.avatarId,
      entryTxSig: sig,
      lamports: '1000000',
      receivingPubkey: 'Treasury1111111111111111111111111111111111',
      destinationPubkey: PROVEN_PAYER,
      destinationSetBy: null,
      status: 'owed' as const,
      refundTxSig: null,
      refundedAt: null,
      refundedBy: null,
    };
    expect(result.solRefundsOwed).toEqual([owed]);
    expect(db.solRefunds.size).toBe(1);
    expect(db.solRefunds.get(String(solRow.id))).toMatchObject({
      event_id: ev.id,
      destination_pubkey: PROVEN_PAYER,
      lamports: '1000000',
      status: 'owed',
    });
    const ctRows = signupsOf(db, ev.id).filter((s) => s.entry_method === 'ct');
    expect(ctRows.every((s) => s.status === 'refunded')).toBe(true);
  });

  it('a second cancel is a no-op: no second refund, SOL still listed', async () => {
    const { mgr, ledger, humanCt, agentCt } = await paidEvent('cancel-twice');
    const first = await mgr.cancelEvent('cancel-twice');
    const creditsAfterFirst = ledger.credits.length;

    const second = await mgr.cancelEvent('cancel-twice');
    expect(second.alreadyCancelled).toBe(true);
    expect(second.refundedSignups).toBe(0);
    expect(second.refundedCt).toBe(0);
    expect(second.solRefundsOwed).toEqual(first.solRefundsOwed);
    expect(ledger.credits.length).toBe(creditsAfterFirst);
    expect(ledger.get(humanCt.avatarId)).toBe(1_000);
    expect(ledger.get(agentCt.avatarId)).toBe(130);
  });

  it('two concurrent cancels refund each signup once', async () => {
    const { mgr, ledger, humanCt } = await paidEvent('cancel-concurrent');
    const results = await Promise.allSettled([
      mgr.cancelEvent('cancel-concurrent'),
      mgr.cancelEvent('cancel-concurrent'),
    ]);
    const fresh = results.filter((r) => r.status === 'fulfilled' && !r.value.alreadyCancelled);
    expect(fresh).toHaveLength(1);
    const refunds = ledger.credits.filter((c) => c.reason === 'special_event_entry_refund');
    expect(refunds.reduce((n, c) => n + c.amount, 0)).toBe(100);
    expect(ledger.get(humanCt.avatarId)).toBe(1_000);
  });

  it('after a cancel: signup, start, open and settle are all refused', async () => {
    const { mgr } = await paidEvent('cancel-then');
    await mgr.cancelEvent('cancel-then');
    const late = human();
    await expect(mgr.signup('cancel-then', late, { entryMethod: 'ct' })).rejects.toThrow(/signup_not_open/);
    await expect(mgr.closeSignupAndStart('cancel-then')).rejects.toThrow(/event_not_open_for_start/);
    await expect(mgr.openSignup('cancel-then')).rejects.toThrow(/event_not_in_draft/);
    await expect(mgr.settleEvent('cancel-then')).rejects.toThrow(/event_cancelled/);
  });

  it('a draft event cancels with nothing to refund', async () => {
    const { mgr, db, ledger } = makeManager();
    await mgr.createEvent({ slug: 'cancel-draft', name: 'Draft' }, null);
    const r = await mgr.cancelEvent('cancel-draft');
    expect(r).toEqual({
      alreadyCancelled: false,
      status: 'cancelled',
      refundedSignups: 0,
      refundedCt: 0,
      solRefundsOwed: [],
    });
    expect([...db.events.values()][0]!.status).toBe('cancelled');
    expect(ledger.credits).toHaveLength(0);
  });

  it('crashed start with a funded registering tournament: the seed goes back to the treasury ONCE, then signups are refunded', async () => {
    const { mgr, db, tm, ledger, ev, clock, humanCt } = await paidEvent('cancel-crashed');
    ev.status = 'starting';
    ev.start_claim_id = 'dead-claim';
    ev.start_claimed_at = new Date(clock.now() - STALE);
    db.seedTournament({ id: 't-seeded', status: 'registering', special_event_id: ev.id, created_at: 5 });
    // The real TM cancel credits the seed to the house treasury in its own tx.
    tm.onCancel = () => {
      void ledger.creditClawTokens({ avatarId: TREASURY, amount: 500, reason: 'special_event_seed_refund' });
    };

    const r = await mgr.cancelEvent('cancel-crashed');
    expect(r.alreadyCancelled).toBe(false);
    expect(r.refundedCt).toBe(100);
    expect(tm.cancelCalls).toBe(1);
    expect(tm.cancelTxDepths).toEqual([0]); // the TM cancel ran outside the event lock
    expect(db.tournaments.get('t-seeded')!.status).toBe('cancelled');
    expect(ev.status).toBe('cancelled');
    expect(ledger.get(TREASURY)).toBe(500);
    expect(ledger.get(humanCt.avatarId)).toBe(1_000);

    await mgr.cancelEvent('cancel-crashed');
    expect(tm.cancelCalls).toBe(1);
    expect(ledger.get(TREASURY)).toBe(500);
  });

  it('refuses a started or settled event with a clear code and moves no CT', async () => {
    const { mgr, db, tm, ledger, ev, clock } = await paidEvent('cancel-refused');
    const creditsBefore = ledger.credits.length;

    // A FRESH start claim (a start in flight) is never taken over.
    ev.status = 'starting';
    ev.start_claim_id = 'live-claim';
    ev.start_claimed_at = new Date(clock.now() - 1_000);
    await expect(mgr.cancelEvent('cancel-refused')).rejects.toMatchObject({
      message: 'event_start_in_progress',
      httpStatus: 409,
    });

    // Live with a running tournament: play has started.
    ev.status = 'live';
    ev.start_claim_id = null;
    ev.start_claimed_at = null;
    db.seedTournament({ id: 't-run', status: 'running', special_event_id: ev.id, created_at: 5 });
    await expect(mgr.cancelEvent('cancel-refused')).rejects.toMatchObject({
      message: 'event_already_started',
      httpStatus: 409,
    });

    // Settled.
    db.tournaments.get('t-run')!.status = 'completed';
    ev.status = 'completed';
    await expect(mgr.cancelEvent('cancel-refused')).rejects.toMatchObject({
      message: 'event_already_settled',
      httpStatus: 409,
    });

    expect(ledger.credits.length).toBe(creditsBefore);
    expect(tm.cancelCalls).toBe(0);
    expect(signupsOf(db, ev.id).every((s) => s.status === 'confirmed')).toBe(true);
    await expect(mgr.cancelEvent('no-such-event')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('an open event that still links an active tournament (legacy data) is refused', async () => {
    const { mgr, db, ledger, ev } = await paidEvent('cancel-legacy');
    db.seedTournament({ id: 't-legacy', status: 'registering', special_event_id: ev.id, created_at: 5 });
    const creditsBefore = ledger.credits.length;
    await expect(mgr.cancelEvent('cancel-legacy')).rejects.toMatchObject({
      message: 'event_has_active_tournament',
      httpStatus: 409,
    });
    expect(ev.status).toBe('signup_open');
    expect(ledger.credits.length).toBe(creditsBefore);
  });

  it('an orphaned live event (tournament cancelled after live) reopens, then cancels and refunds', async () => {
    const { mgr, tm, ledger, ev, humanCt } = await paidEvent('cancel-orphan');
    const started = await mgr.closeSignupAndStart('cancel-orphan');
    expect(ev.status).toBe('live');
    await tm.cancelAndRefundOrphan(started.tournamentId); // room abort refunds the seed
    const r = await mgr.cancelEvent('cancel-orphan');
    expect(r.refundedCt).toBe(100);
    expect(ev.status).toBe('cancelled');
    expect(tm.cancelCalls).toBe(1);
    expect(ledger.get(humanCt.avatarId)).toBe(1_000);
  });

  it('cancel racing settle: never both — a cancelled event never completes', async () => {
    // Open event: cancel wins; settle either ran first (no change) or is refused.
    const a = await paidEvent('race-settle-a');
    const [cancelA, settleA] = await Promise.allSettled([
      a.mgr.cancelEvent('race-settle-a'),
      a.mgr.settleEvent('race-settle-a'),
    ]);
    expect(cancelA.status).toBe('fulfilled');
    expect(a.ev.status).toBe('cancelled');
    // An open event never settles: refused before (event_not_settleable) or
    // after (event_cancelled) the cancel.
    expect(settleA.status).toBe('rejected');
    if (settleA.status === 'rejected') {
      expect(String(settleA.reason)).toMatch(/event_cancelled|event_not_settleable/);
    }

    // Live event whose tournament completed: settle wins, cancel is refused.
    const b = await paidEvent('race-settle-b');
    const started = await b.mgr.closeSignupAndStart('race-settle-b');
    b.db.tournaments.get(started.tournamentId)!.status = 'completed';
    const creditsBefore = b.ledger.credits.length;
    const [cancelB, settleB] = await Promise.allSettled([
      b.mgr.cancelEvent('race-settle-b'),
      b.mgr.settleEvent('race-settle-b'),
    ]);
    expect(settleB.status).toBe('fulfilled');
    expect(cancelB.status).toBe('rejected');
    expect(b.ev.status).toBe('completed');
    expect(b.ledger.credits.length).toBe(creditsBefore);
  });

  it('cancel racing start: exactly one wins; the loser moves no CT', async () => {
    const { mgr, tm, ledger, ev } = await paidEvent('race-start');
    const [start, cancel] = await Promise.allSettled([
      mgr.closeSignupAndStart('race-start'),
      mgr.cancelEvent('race-start'),
    ]);
    expect([start, cancel].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refundTotal = ledger.credits
      .filter((c) => c.reason === 'special_event_entry_refund')
      .reduce((n, c) => n + c.amount, 0);
    if (cancel.status === 'fulfilled') {
      expect(ev.status).toBe('cancelled');
      expect(refundTotal).toBe(100);
      expect(tm.created).toHaveLength(0);
    } else {
      expect(ev.status).toBe('live');
      expect(refundTotal).toBe(0);
    }
  });
});

// ── Codex r1 (2026-10-03): durable SOL refunds, all-or-nothing CT, settle 409 ──

describe('SpecialEventManager — SOL refunds owed + mark-paid (Codex r1, 2026-10-03)', () => {
  const TREASURY_PK = 'Treasury1111111111111111111111111111111111';
  const HUMAN_PAYER = 'HumanPayer111111111111111111111111111111111';
  const AGENT_PAYER = 'AgentPayer111111111111111111111111111111111';
  const ADMIN = '11111111-1111-4111-8111-111111111111';

  /** A SOL-gated open event with a human and an agent SOL signup (proven payers). */
  async function solEvent(slug: string, opts: { agentPayer?: string | null } = {}) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Sol ${slug}`, gateSolLamports: 1_000_000 }, null);
    await h.mgr.openSignup(slug);
    const humanSubj = human();
    const humanSig = `entry-h-${slug}`;
    h.rpc.setTx(humanSig, TREASURY_PK, 1_000_000n, true, HUMAN_PAYER);
    await h.mgr.signup(slug, humanSubj, {
      entryMethod: 'sol',
      walletPubkey: 'ClaimedButNotProven11111111111111111111111',
      solTxSig: humanSig,
    });
    const agentSubj = agent();
    const agentSig = `entry-a-${slug}`;
    // The agent overpaid: the refund owes the verified amount, not the price.
    const agentPayer = opts.agentPayer === undefined ? AGENT_PAYER : opts.agentPayer;
    h.rpc.setTx(agentSig, TREASURY_PK, 1_500_000n, true, agentPayer);
    await h.mgr.signup(slug, agentSubj, { entryMethod: 'sol', solTxSig: agentSig });
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    const signupOf = (avatarId: string) =>
      [...h.db.signups.values()].find((s) => s.event_id === ev.id && s.avatar_id === avatarId)!;
    return { ...h, ev, humanSubj, agentSubj, humanSig, agentSig, signupOf };
  }

  it('signup stores the PROVEN payer; cancel records each SOL entry as owed to it (human and agent alike)', async () => {
    const { mgr, db, ev, humanSubj, agentSubj, signupOf } = await solEvent('sol-owed');
    const hRow = signupOf(humanSubj.avatarId);
    expect((hRow.entry_proof_json as Record<string, unknown>).payerPubkey).toBe(HUMAN_PAYER);
    expect((hRow.entry_proof_json as Record<string, unknown>).fromPubkey).toBe(
      'ClaimedButNotProven11111111111111111111111',
    );

    const r = await mgr.cancelEvent('sol-owed');
    expect(ev.status).toBe('cancelled');
    expect(r.refundedCt).toBe(0);
    expect(r.solRefundsOwed.map((o) => [o.avatarId, o.destinationPubkey, o.lamports, o.status])).toEqual([
      [humanSubj.avatarId, HUMAN_PAYER, '1000000', 'owed'],
      [agentSubj.avatarId, AGENT_PAYER, '1500000', 'owed'],
    ]);
    // Signup rows stay 'confirmed' (entry sigs stay reserved); the refund state
    // lives in special_event_sol_refunds, one row per signup.
    expect(signupOf(humanSubj.avatarId).status).toBe('confirmed');
    expect(signupOf(agentSubj.avatarId).status).toBe('confirmed');
    expect(db.solRefunds.size).toBe(2);

    // A retried cancel writes no second row and lists the same owed refunds.
    const again = await mgr.cancelEvent('sol-owed');
    expect(again.alreadyCancelled).toBe(true);
    expect(again.solRefundsOwed).toEqual(r.solRefundsOwed);
    expect(db.solRefunds.size).toBe(2);
  });

  it('an entry without a stored proven payer is re-verified on chain at cancel', async () => {
    const { mgr, rpc, humanSubj, signupOf } = await solEvent('sol-legacy');
    // A row written before 2026-10-03: no payerPubkey, only the client claim.
    const row = signupOf(humanSubj.avatarId);
    const proof = { ...(row.entry_proof_json as Record<string, unknown>) };
    delete proof.payerPubkey;
    row.entry_proof_json = proof;
    rpc.commitments.length = 0;

    const r = await mgr.cancelEvent('sol-legacy');
    const owed = r.solRefundsOwed.find((o) => o.avatarId === humanSubj.avatarId)!;
    expect(owed.destinationPubkey).toBe(HUMAN_PAYER);
    // One re-verification, at the entry path's finality.
    expect(rpc.commitments).toEqual(['confirmed']);
  });

  it('an unprovable payer is recorded with no destination; mark-paid resolves it from the entry tx', async () => {
    const { mgr, rpc, db, agentSubj, agentSig, signupOf } = await solEvent('sol-unresolved', {
      agentPayer: null,
    });
    const r = await mgr.cancelEvent('sol-unresolved');
    const owed = r.solRefundsOwed.find((o) => o.avatarId === agentSubj.avatarId)!;
    expect(owed.destinationPubkey).toBeNull();
    const signupId = String(signupOf(agentSubj.avatarId).id);

    // Still unprovable: refused, nothing recorded.
    rpc.setTx('refund-x', AGENT_PAYER, 1_500_000n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-unresolved', signupId, 'refund-x', ADMIN)).rejects.toMatchObject({
      message: 'refund_destination_unresolved',
      httpStatus: 409,
    });
    expect(db.solRefunds.get(signupId)!.status).toBe('owed');

    // The chain now proves the payer: the destination is resolved, then paid.
    rpc.setTx(agentSig, TREASURY_PK, 1_500_000n, true, AGENT_PAYER);
    const paid = await mgr.markSolRefundPaid('sol-unresolved', signupId, 'refund-x', ADMIN);
    expect(paid.status).toBe('refunded');
    expect(paid.destinationPubkey).toBe(AGENT_PAYER);
  });

  it('mark-paid succeeds ONCE with a finalized tx paying the owed lamports to the proven payer', async () => {
    const { mgr, rpc, db, humanSubj, signupOf } = await solEvent('sol-paid');
    await mgr.cancelEvent('sol-paid');
    const signupId = String(signupOf(humanSubj.avatarId).id);

    rpc.setTx('refund-ok', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    rpc.commitments.length = 0;
    const paid = await mgr.markSolRefundPaid('sol-paid', signupId, 'refund-ok', ADMIN);
    expect(rpc.commitments).toEqual(['finalized']);
    expect(paid).toMatchObject({
      signupId,
      status: 'refunded',
      refundTxSig: 'refund-ok',
      destinationPubkey: HUMAN_PAYER,
      refundedBy: ADMIN,
      refundedAt: new Date(1_900_000_000_000).toISOString(),
    });
    expect(db.solRefunds.get(signupId)!.status).toBe('refunded');

    // A second mark-paid (even with another valid payout) is refused.
    rpc.setTx('refund-ok-2', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-paid', signupId, 'refund-ok-2', ADMIN)).rejects.toMatchObject({
      message: 'refund_not_owed',
      httpStatus: 409,
    });

    const list = await mgr.listSolRefunds('sol-paid');
    expect(list.refunded.map((x) => x.signupId)).toEqual([signupId]);
    expect(list.owed).toHaveLength(1);
    expect(list.owedLamports).toBe('1500000');
    expect(list.eventStatus).toBe('cancelled');
  });

  it('mark-paid refuses a reused signature, an entry signature, a wrong destination, a short amount and a failed tx', async () => {
    const { mgr, rpc, db, humanSubj, agentSubj, humanSig, signupOf } = await solEvent('sol-bad');
    await mgr.cancelEvent('sol-bad');
    const hId = String(signupOf(humanSubj.avatarId).id);
    const aId = String(signupOf(agentSubj.avatarId).id);

    // Wrong destination: the tx pays someone else.
    rpc.setTx('refund-elsewhere', 'SomeoneElse1111111111111111111111111111111', 1_500_000n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-elsewhere', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
      httpStatus: 400,
    });
    // Short amount: 1 lamport below the owed 1,500,000.
    rpc.setTx('refund-short', AGENT_PAYER, 1_499_999n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-short', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
    });
    // Failed or unknown tx.
    rpc.setTx('refund-failed', AGENT_PAYER, 1_500_000n, false, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-failed', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
    });
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-unknown', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
    });
    // An RPC outage is a 503, never a success.
    rpc.failing.add('refund-rpc-down');
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-rpc-down', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_unverifiable',
      httpStatus: 503,
    });
    // An entry payment signature can never count as a refund.
    await expect(mgr.markSolRefundPaid('sol-bad', hId, humanSig, ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_reused',
      httpStatus: 409,
    });
    expect(db.solRefunds.get(aId)!.status).toBe('owed');

    // A signature already recorded for one refund cannot settle another, even
    // if that tx also paid the other destination enough.
    rpc.setTx('refund-h', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    await mgr.markSolRefundPaid('sol-bad', hId, 'refund-h', ADMIN);
    rpc.setTx('refund-h', AGENT_PAYER, 1_500_000n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-bad', aId, 'refund-h', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_reused',
      httpStatus: 409,
    });
    expect(db.solRefunds.get(aId)!.status).toBe('owed');
  });

  it('two concurrent mark-paid calls: exactly one succeeds', async () => {
    const { mgr, rpc, db, humanSubj, signupOf } = await solEvent('sol-race');
    await mgr.cancelEvent('sol-race');
    const id = String(signupOf(humanSubj.avatarId).id);
    rpc.setTx('refund-r1', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    rpc.setTx('refund-r2', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    const results = await Promise.allSettled([
      mgr.markSolRefundPaid('sol-race', id, 'refund-r1', ADMIN),
      mgr.markSolRefundPaid('sol-race', id, 'refund-r2', ADMIN),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('refund_not_owed');
    expect(db.solRefunds.get(id)!.status).toBe('refunded');
  });

  it('nothing is owed before a cancel, for an unknown signup, or for an unknown event', async () => {
    const { mgr, rpc, humanSubj, signupOf } = await solEvent('sol-open');
    const id = String(signupOf(humanSubj.avatarId).id);
    rpc.setTx('refund-early', HUMAN_PAYER, 1_000_000n, true, TREASURY_PK);
    await expect(mgr.markSolRefundPaid('sol-open', id, 'refund-early', ADMIN)).rejects.toMatchObject({
      message: 'refund_not_owed',
      httpStatus: 409,
    });
    await expect(mgr.markSolRefundPaid('sol-open', randomUUID(), 'refund-early', ADMIN)).rejects.toMatchObject({
      message: 'refund_not_owed',
    });
    await expect(mgr.markSolRefundPaid('no-such-event', id, 'refund-early', ADMIN)).rejects.toMatchObject({
      message: 'event_not_found',
      httpStatus: 404,
    });
    await expect(mgr.listSolRefunds('no-such-event')).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('SpecialEventManager — cancel is all-or-nothing on a bad CT proof (Codex r1, 2026-10-03)', () => {
  /** Two CT signups (human first, agent second) + one SOL signup; rollback model on. */
  async function ctEvent(slug: string) {
    const h = makeManager();
    await h.mgr.createEvent({ slug, name: `Ct ${slug}`, gateCt: 50, gateSolLamports: 1_000_000 }, null);
    await h.mgr.openSignup(slug);
    const first = human();
    h.ledger.setBalance(first.avatarId, 1_000);
    await h.mgr.signup(slug, first, { entryMethod: 'ct' });
    const second = agent();
    h.ledger.setBalance(second.avatarId, 1_000);
    await h.mgr.signup(slug, second, { entryMethod: 'ct' });
    h.rpc.setTx(`sol-${slug}`, 'Treasury1111111111111111111111111111111111', 1_000_000n, true, 'P1');
    await h.mgr.signup(slug, human(), { entryMethod: 'sol', solTxSig: `sol-${slug}` });
    const ev = [...h.db.events.values()].find((e) => e.slug === slug)!;
    const rowOf = (avatarId: string) =>
      [...h.db.signups.values()].find((s) => s.event_id === ev.id && s.avatar_id === avatarId)!;
    h.db.rollbackOnThrow = true;
    return { ...h, ev, first, second, rowOf };
  }

  const badProofs: Array<[string, string, unknown]> = [
    ['missing amountCt', 'missing', {}],
    ['zero amountCt', 'zero', { amountCt: 0 }],
    ['mismatched amountCt', 'mismatch', { amountCt: 60 }],
    ['invalid amountCt', 'invalid', { amountCt: 'abc' }],
    ['negative amountCt', 'negative', { amountCt: -50 }],
  ];

  for (const [label, key, proof] of badProofs) {
    it(`${label} with a recorded debit rolls the whole cancel back (no status change, no credits)`, async () => {
      const { mgr, db, ledger, ev, first, second, rowOf } = await ctEvent(`ct-bad-${key}`);
      // The SECOND signup is bad, so the first one's credit already ran.
      rowOf(second.avatarId).entry_proof_json = proof;
      const creditsBefore = ledger.credits.length;

      await expect(mgr.cancelEvent(`ct-bad-${key}`)).rejects.toMatchObject({
        message: 'entry_debit_ledger_mismatch',
        httpStatus: 500,
      });
      expect(ev.status).toBe('signup_open');
      expect(ledger.credits.length).toBe(creditsBefore);
      expect(ledger.get(first.avatarId)).toBe(950);
      expect(ledger.get(second.avatarId)).toBe(950);
      expect(rowOf(first.avatarId).status).toBe('confirmed');
      expect(rowOf(second.avatarId).status).toBe('confirmed');
      expect(db.solRefunds.size).toBe(0);
    });
  }

  it('a zero CT entry with no debit is a valid zero refund', async () => {
    const h = makeManager();
    await h.mgr.createEvent({ slug: 'ct-zero', name: 'Zero', gateCt: 0 }, null);
    await h.mgr.openSignup('ct-zero');
    await h.mgr.signup('ct-zero', human(), { entryMethod: 'ct' });
    h.db.rollbackOnThrow = true;
    const r = await h.mgr.cancelEvent('ct-zero');
    expect(r.refundedSignups).toBe(1);
    expect(r.refundedCt).toBe(0);
    expect(h.ledger.credits).toHaveLength(0);
    expect([...h.db.signups.values()][0]!.status).toBe('refunded');
  });

  it('a proof that claims a payment with no debit row also rolls back', async () => {
    const { mgr, db, ledger, ev, first, rowOf } = await ctEvent('ct-ghost');
    // Remove the first signup's debit rows: the proof says 50, the ledger says 0.
    for (let i = db.ledgerRows.length - 1; i >= 0; i--) {
      if (db.ledgerRows[i]!.avatar_id === first.avatarId) db.ledgerRows.splice(i, 1);
    }
    await expect(mgr.cancelEvent('ct-ghost')).rejects.toMatchObject({
      message: 'entry_debit_ledger_mismatch',
    });
    expect(ev.status).toBe('signup_open');
    expect(ledger.credits).toHaveLength(0);
    expect(rowOf(first.avatarId).status).toBe('confirmed');
  });
});

describe('SpecialEventManager — settleEvent refuses an unsettled event (Codex r1, 2026-10-03)', () => {
  it('an open event with no tournament and a live event with a running tournament both get 409', async () => {
    const { mgr, db } = makeManager();
    const open = await mgr.createEvent({ slug: 'settle-open', name: 'Open' }, null);
    await mgr.openSignup('settle-open');
    await expect(mgr.settleEvent('settle-open')).rejects.toMatchObject({
      message: 'event_not_settleable',
      httpStatus: 409,
    });
    expect(db.events.get(open.id)!.status).toBe('signup_open');

    const live = await mgr.createEvent({ slug: 'settle-live', name: 'Live' }, null);
    db.events.get(live.id)!.status = 'live';
    db.seedTournament({ id: randomUUID(), status: 'running', special_event_id: live.id, created_at: 1 });
    await expect(mgr.settleEvent('settle-live')).rejects.toMatchObject({ message: 'event_not_settleable' });
    expect(db.events.get(live.id)!.status).toBe('live');
    expect(db.events.get(live.id)!.completed_at).toBeNull();
  });
});

// ── Codex r2 (2026-10-03): per-source SOL attribution, shared signature guard,
//    treasury-sourced refunds, admin-set destination ─────────────────────────

describe('summarizeParsedSolTransfer + singleCoveringSource (Codex r2, 2026-10-03)', () => {
  const T = 'Treasury1111111111111111111111111111111111';
  const A = 'SourceA111111111111111111111111111111111111';
  const B = 'SourceB111111111111111111111111111111111111';
  const SYSTEM = '11111111111111111111111111111111';

  const sysIx = (source: string, destination: string, lamports: number, type = 'transfer', programId = SYSTEM) => ({
    program: 'system',
    programId,
    parsed: { type, info: { source, destination, lamports } },
  });
  /** An instruction of another program (no parsed System transfer). */
  const opaqueIx = () => ({ programId: 'OtherProgram1111111111111111111111111111111', accounts: [], data: 'x' });
  function parsedTx(o: {
    keys: string[];
    pre: number[];
    post: number[];
    ixs: unknown[];
    inner?: unknown[][];
    err?: unknown;
  }) {
    return {
      meta: {
        err: o.err ?? null,
        preBalances: o.pre,
        postBalances: o.post,
        innerInstructions: (o.inner ?? []).map((instructions, index) => ({ index, instructions })),
      },
      transaction: {
        message: {
          accountKeys: o.keys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
          instructions: o.ixs,
        },
      },
    };
  }

  it('split source: 1 lamport by System transfer from A + the rest from B by another instruction names NO payer', () => {
    const tx = parsedTx({
      keys: [A, B, T],
      pre: [5_000_000, 5_000_000, 0],
      post: [4_999_999, 4_000_001, 1_000_000],
      ixs: [sysIx(A, T, 1), opaqueIx()],
    });
    const proof = summarizeParsedSolTransfer(tx, T)!;
    expect(proof.lamportsToDest).toBe(1_000_000n);
    expect(proof.success).toBe(true);
    expect([...proof.transfersBySource!]).toEqual([[A, 1n]]);
    expect(singleCoveringSource(proof.transfersBySource, proof.lamportsToDest, T)).toBeNull();
  });

  it('one source paying the full amount is the payer; its transfers are summed (transfer + transferWithSeed)', () => {
    const tx = parsedTx({
      keys: [A, T],
      pre: [5_000_000, 0],
      post: [4_000_000, 1_000_000],
      ixs: [sysIx(A, T, 600_000), sysIx(A, T, 400_000, 'transferWithSeed')],
    });
    const proof = summarizeParsedSolTransfer(tx, T)!;
    expect([...proof.transfersBySource!]).toEqual([[A, 1_000_000n]]);
    expect(singleCoveringSource(proof.transfersBySource, proof.lamportsToDest, T)).toBe(A);
  });

  it('an inner-instruction (CPI) System transfer is counted', () => {
    const tx = parsedTx({
      keys: [A, T],
      pre: [5_000_000, 0],
      post: [4_000_000, 1_000_000],
      ixs: [opaqueIx()],
      inner: [[sysIx(A, T, 1_000_000)]],
    });
    const proof = summarizeParsedSolTransfer(tx, T)!;
    expect([...proof.transfersBySource!]).toEqual([[A, 1_000_000n]]);
    expect(singleCoveringSource(proof.transfersBySource, proof.lamportsToDest, T)).toBe(A);
  });

  it('ignores a fake "system" program id, other destinations, self-transfers and non-transfer types', () => {
    const tx = parsedTx({
      keys: [A, B, T],
      pre: [5_000_000, 5_000_000, 0],
      post: [4_000_000, 5_000_000, 1_000_000],
      ixs: [
        sysIx(B, T, 1_000_000, 'transfer', 'FakeSystem111111111111111111111111111111111'),
        sysIx(A, B, 1_000_000),
        sysIx(T, T, 1_000_000),
        sysIx(B, T, 1_000_000, 'createAccount'),
      ],
    });
    const proof = summarizeParsedSolTransfer(tx, T)!;
    expect(proof.lamportsToDest).toBe(1_000_000n);
    expect(proof.transfersBySource!.size).toBe(0);
  });

  it('a failed tx reports success=false; a missing tx or meta is null', () => {
    const failed = parsedTx({ keys: [A, T], pre: [1, 0], post: [1, 0], ixs: [], err: { InstructionError: [0, 'x'] } });
    expect(summarizeParsedSolTransfer(failed, T)!.success).toBe(false);
    expect(summarizeParsedSolTransfer(null, T)).toBeNull();
    expect(summarizeParsedSolTransfer({ ...failed, meta: null }, T)).toBeNull();
  });

  it('singleCoveringSource: two covering sources are ambiguous, partial sources never cover, excluded wallet ignored', () => {
    const m = (e: Array<[string, bigint]>) => new Map(e);
    expect(singleCoveringSource(m([[A, 1_000_000n], [B, 1_000_000n]]), 1_000_000n)).toBeNull();
    expect(singleCoveringSource(m([[A, 1n], [B, 999_999n]]), 1_000_000n)).toBeNull();
    expect(singleCoveringSource(m([[T, 1_000_000n], [A, 1_000_000n]]), 1_000_000n, T)).toBe(A);
    expect(singleCoveringSource(m([[A, 1_000_000n]]), 0n)).toBeNull();
    expect(singleCoveringSource(undefined, 1_000_000n)).toBeNull();
  });
});

describe('SpecialEventManager — SOL attribution, signature guard, treasury refunds (Codex r2, 2026-10-03)', () => {
  const TREASURY_PK = 'Treasury1111111111111111111111111111111111';
  const ADMIN = '11111111-1111-4111-8111-111111111111';
  const A = 'SourceA111111111111111111111111111111111111';
  const B = 'SourceB111111111111111111111111111111111111';
  const pubkey = () => bs58.encode(randomBytes(32));

  /** A SOL-gated open event (1,000,000 lamports). */
  async function openSolEvent(h: ReturnType<typeof makeManager>, slug: string) {
    await h.mgr.createEvent({ slug, name: `R2 ${slug}`, gateSolLamports: 1_000_000 }, null);
    await h.mgr.openSignup(slug);
    return [...h.db.events.values()].find((e) => e.slug === slug)!;
  }
  /** One SOL signup whose entry tx credits the treasury with the given System transfers. */
  async function solSignup(
    h: ReturnType<typeof makeManager>,
    slug: string,
    sig: string,
    transfers: Array<[string, bigint]>,
    subject: SignupSubject = human(),
  ) {
    h.rpc.setTxTransfers(sig, TREASURY_PK, 1_000_000n, transfers);
    await h.mgr.signup(slug, subject, { entryMethod: 'sol', solTxSig: sig });
    return [...h.db.signups.values()].find((s) => s.avatar_id === subject.avatarId)!;
  }
  const errOf = (r: PromiseSettledResult<unknown>) =>
    r.status === 'rejected' ? (r.reason as SpecialEventError).message : null;

  it('split-source entry (1 lamport System transfer from A + the rest from B) leaves the destination unresolved', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-split');
    // B's 999,999 lamports arrive by a non-System instruction: no transfer entry.
    const split = await solSignup(h, 'r2-split', 'entry-split', [[A, 1n]]);
    // Two System transfers, neither covering the full credit, are no proof either.
    const partial = await solSignup(h, 'r2-split', 'entry-partial', [[A, 1n], [B, 999_999n]], agent());
    expect((split.entry_proof_json as Record<string, unknown>).payerPubkey).toBeNull();
    expect((partial.entry_proof_json as Record<string, unknown>).payerPubkey).toBeNull();

    const r = await h.mgr.cancelEvent('r2-split');
    expect(r.solRefundsOwed.map((o) => o.destinationPubkey)).toEqual([null, null]);
    expect(r.solRefundsOwed.map((o) => o.receivingPubkey)).toEqual([TREASURY_PK, TREASURY_PK]);

    // A payout to A cannot be recorded: the chain still proves no payer.
    h.rpc.setTx('refund-to-a', A, 1_000_000n, true, TREASURY_PK);
    await expect(
      h.mgr.markSolRefundPaid('r2-split', String(split.id), 'refund-to-a', ADMIN),
    ).rejects.toMatchObject({ message: 'refund_destination_unresolved', httpStatus: 409 });
    expect(h.db.solRefunds.get(String(split.id))!.destination_pubkey).toBeNull();
    expect(h.db.solRefunds.get(String(split.id))!.status).toBe('owed');
  });

  it('a single source covering the full entry resolves to that source (human and agent alike)', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-single');
    const humanRow = await solSignup(h, 'r2-single', 'entry-single-h', [[A, 1_000_000n]]);
    const agentRow = await solSignup(h, 'r2-single', 'entry-single-a', [[B, 400_000n], [B, 600_000n]], agent());
    const r = await h.mgr.cancelEvent('r2-single');
    const dest = (id: unknown) => r.solRefundsOwed.find((o) => o.signupId === id)!.destinationPubkey;
    expect(dest(humanRow.id)).toBe(A);
    expect(dest(agentRow.id)).toBe(B);
  });

  it('signup with a signature already used as a refund payout is refused', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-refunded');
    const row = await solSignup(h, 'r2-refunded', 'entry-r1', [[A, 1_000_000n]]);
    await h.mgr.cancelEvent('r2-refunded');
    h.rpc.setTx('payout-1', A, 1_000_000n, true, TREASURY_PK);
    await h.mgr.markSolRefundPaid('r2-refunded', String(row.id), 'payout-1', ADMIN);
    expect(h.db.usedTxSigs.get('payout-1')).toMatchObject({ use_kind: 'refund', signup_id: row.id });

    // The same tx (if it also credited the treasury) can never buy an entry.
    const evB = await openSolEvent(h, 'r2-next');
    h.rpc.setTx('payout-1', TREASURY_PK, 1_000_000n, true, B);
    await expect(
      h.mgr.signup('r2-next', human(), { entryMethod: 'sol', solTxSig: 'payout-1' }),
    ).rejects.toMatchObject({ message: 'sol_tx_already_used', httpStatus: 409 });
    expect([...h.db.signups.values()].filter((s) => s.event_id === evB.id)).toHaveLength(0);
  });

  it('mark-paid with an entry signature is refused even after the signup row is gone (used-signature table)', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-entry-sig');
    const row1 = await solSignup(h, 'r2-entry-sig', 'entry-e1', [[A, 1_000_000n]]);
    const row2 = await solSignup(h, 'r2-entry-sig', 'entry-e2', [[B, 1_000_000n]], agent());
    expect(h.db.usedTxSigs.get('entry-e2')).toMatchObject({ use_kind: 'entry', signup_id: row2.id });
    await h.mgr.cancelEvent('r2-entry-sig');
    // The second signup's avatar was deleted: its signup row cascaded away.
    h.db.signups.delete(String(row2.id));
    h.rpc.setTx('entry-e2', A, 1_000_000n, true, TREASURY_PK);
    await expect(
      h.mgr.markSolRefundPaid('r2-entry-sig', String(row1.id), 'entry-e2', ADMIN),
    ).rejects.toMatchObject({ message: 'refund_tx_reused', httpStatus: 409 });
    expect(h.db.solRefunds.get(String(row1.id))!.status).toBe('owed');
  });

  /** A cancelled event owing A, an open event, and one signature S valid for both uses. */
  async function raceSetup(slugA: string, slugB: string) {
    const h = makeManager();
    await openSolEvent(h, slugA);
    const owedRow = await solSignup(h, slugA, `entry-${slugA}`, [[A, 1_000_000n]]);
    await h.mgr.cancelEvent(slugA);
    const evB = await openSolEvent(h, slugB);
    const S = `shared-${slugA}`;
    h.rpc.setTx(S, TREASURY_PK, 1_000_000n, true, B); // S credits the treasury (an entry)
    h.rpc.setTx(S, A, 1_000_000n, true, TREASURY_PK); // and pays A from the treasury (a refund)
    // Both requests pass their pre-check SELECTs (neither has committed yet).
    h.db.blindSigPrechecks = true;
    const entriesOfB = () => [...h.db.signups.values()].filter((s) => s.event_id === evB.id);
    return { ...h, owedId: String(owedRow.id), S, entriesOfB };
  }

  it('concurrent signup and mark-paid with ONE signature: exactly one succeeds', async () => {
    const h = await raceSetup('r2-race-a', 'r2-race-b');
    const results = await Promise.allSettled([
      h.mgr.signup('r2-race-b', human(), { entryMethod: 'sol', solTxSig: h.S }),
      h.mgr.markSolRefundPaid('r2-race-a', h.owedId, h.S, ADMIN),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [signup, paid] = results;
    const used = h.db.usedTxSigs.get(h.S)!;
    if (signup!.status === 'fulfilled') {
      expect(errOf(paid!)).toBe('refund_tx_reused');
      expect(used.use_kind).toBe('entry');
      expect(h.db.solRefunds.get(h.owedId)!.status).toBe('owed');
    } else {
      expect(errOf(signup!)).toBe('sol_tx_already_used');
      expect(used.use_kind).toBe('refund');
      expect(h.entriesOfB()).toHaveLength(0);
    }
  });

  it('the guard holds in both orders: refund first blocks the entry, entry first blocks the refund', async () => {
    const r1 = await raceSetup('r2-ord-a', 'r2-ord-b');
    await r1.mgr.markSolRefundPaid('r2-ord-a', r1.owedId, r1.S, ADMIN);
    await expect(
      r1.mgr.signup('r2-ord-b', human(), { entryMethod: 'sol', solTxSig: r1.S }),
    ).rejects.toMatchObject({ message: 'sol_tx_already_used', httpStatus: 409 });
    expect(r1.entriesOfB()).toHaveLength(0);

    const r2 = await raceSetup('r2-ord-c', 'r2-ord-d');
    await r2.mgr.signup('r2-ord-d', human(), { entryMethod: 'sol', solTxSig: r2.S });
    await expect(r2.mgr.markSolRefundPaid('r2-ord-c', r2.owedId, r2.S, ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_reused',
      httpStatus: 409,
    });
    expect(r2.db.solRefunds.get(r2.owedId)).toMatchObject({ status: 'owed', refund_tx_sig: null });
  });

  it('mark-paid refuses a payout from a non-treasury wallet and a short payout from the treasury', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-source');
    const row = await solSignup(h, 'r2-source', 'entry-src', [[A, 1_000_000n]]);
    await h.mgr.cancelEvent('r2-source');
    const id = String(row.id);

    // The full amount reaches A, but from B's wallet, not the treasury.
    h.rpc.setTx('payout-from-b', A, 1_000_000n, true, B);
    await expect(h.mgr.markSolRefundPaid('r2-source', id, 'payout-from-b', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
      httpStatus: 400,
    });
    // A gets the full amount, but only 999,999 of it from the treasury.
    h.rpc.setTxTransfers('payout-short', A, 1_000_000n, [[TREASURY_PK, 999_999n], [B, 1n]]);
    await expect(h.mgr.markSolRefundPaid('r2-source', id, 'payout-short', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
    });
    // A balance increase with no System transfer at all proves no source.
    h.rpc.setTxTransfers('payout-opaque', A, 1_000_000n, []);
    await expect(h.mgr.markSolRefundPaid('r2-source', id, 'payout-opaque', ADMIN)).rejects.toMatchObject({
      message: 'refund_tx_invalid',
    });
    expect(h.db.solRefunds.get(id)!.status).toBe('owed');
    expect(h.db.usedTxSigs.has('payout-from-b')).toBe(false);

    // Two treasury transfers that together cover the owed amount are accepted.
    h.rpc.setTxTransfers('payout-ok', A, 1_000_000n, [[TREASURY_PK, 500_000n], [TREASURY_PK, 500_000n]]);
    const paid = await h.mgr.markSolRefundPaid('r2-source', id, 'payout-ok', ADMIN);
    expect(paid).toMatchObject({ status: 'refunded', refundTxSig: 'payout-ok', destinationPubkey: A });
  });

  it('a named admin sets an unresolved destination once, only while owed and unresolved', async () => {
    const h = makeManager();
    await openSolEvent(h, 'r2-dest');
    const unresolved = await solSignup(h, 'r2-dest', 'entry-u', [[A, 1n]]);
    const proven = await solSignup(h, 'r2-dest', 'entry-p', [[B, 1_000_000n]], agent());
    const uId = String(unresolved.id);
    const D = pubkey();

    // Before the cancel there is no refund row.
    await expect(h.mgr.resolveSolRefundDestination('r2-dest', uId, D, ADMIN)).rejects.toMatchObject({
      message: 'refund_not_owed',
      httpStatus: 409,
    });
    await h.mgr.cancelEvent('r2-dest');

    // Not a 32-byte base58 key.
    for (const bad of ['not-base58!', '1111', `${pubkey()}${pubkey()}`]) {
      await expect(h.mgr.resolveSolRefundDestination('r2-dest', uId, bad, ADMIN)).rejects.toMatchObject({
        message: 'invalid_destination',
        httpStatus: 400,
      });
    }
    // The receiving wallet itself is never a refund destination.
    const R = pubkey();
    h.db.solRefunds.get(uId)!.receiving_pubkey = R;
    await expect(h.mgr.resolveSolRefundDestination('r2-dest', uId, R, ADMIN)).rejects.toMatchObject({
      message: 'invalid_destination',
    });
    h.db.solRefunds.get(uId)!.receiving_pubkey = TREASURY_PK;
    // A chain-proven destination is never overwritten.
    await expect(
      h.mgr.resolveSolRefundDestination('r2-dest', String(proven.id), D, ADMIN),
    ).rejects.toMatchObject({ message: 'refund_destination_already_set', httpStatus: 409 });
    await expect(h.mgr.resolveSolRefundDestination('no-such-event', uId, D, ADMIN)).rejects.toMatchObject({
      message: 'event_not_found',
      httpStatus: 404,
    });

    const set = await h.mgr.resolveSolRefundDestination('r2-dest', uId, D, ADMIN);
    expect(set).toMatchObject({ destinationPubkey: D, destinationSetBy: ADMIN, status: 'owed' });
    expect(h.db.solRefunds.get(uId)!.destination_set_at).toBe(new Date(1_900_000_000_000).toISOString());
    // Once only.
    await expect(h.mgr.resolveSolRefundDestination('r2-dest', uId, pubkey(), ADMIN)).rejects.toMatchObject({
      message: 'refund_destination_already_set',
    });

    // The admin-set destination is paid like a proven one (treasury-sourced).
    h.rpc.setTx('payout-d', D, 1_000_000n, true, TREASURY_PK);
    const paid = await h.mgr.markSolRefundPaid('r2-dest', uId, 'payout-d', ADMIN);
    expect(paid).toMatchObject({ status: 'refunded', destinationPubkey: D, destinationSetBy: ADMIN });
    await expect(h.mgr.resolveSolRefundDestination('r2-dest', uId, pubkey(), ADMIN)).rejects.toMatchObject({
      message: 'refund_not_owed',
    });
  });
});
