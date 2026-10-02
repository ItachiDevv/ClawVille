/**
 * Special Event Manager (2026-06-16) — the GENERIC, REUSABLE PARENT-layer
 * service that owns the lifecycle of a one-time event and links its dependent
 * poker tournament(s).
 *
 * ── DEPENDENCY DIRECTION (CRITICAL) ──────────────────────────────────────────
 * `special_events` is the PARENT. The poker tournament is a DEPENDENT subtable:
 * the FK points UP — `poker_tournaments.special_event_id → special_events.id`.
 * This manager NEVER stores a tournament id on the event row; instead it creates
 * the tournament in PREPAID mode with `specialEventId = event.id`, so the
 * tournament carries the link and `settleEvent` finds it via
 * `WHERE special_event_id = event.id`. The parent stays reusable: a future event
 * type adds its OWN subtable + its OWN sub-manager without touching this one.
 *
 * ── GATE MODEL (FLEXIBLE) ────────────────────────────────────────────────────
 * `evaluateGate(event, subject, choice)`:
 *   - ALL gate_* null                     → 'free' (anyone in).
 *   - gate_hold_mint + gate_hold_bps set  → TOKEN-HOLD: the subject's chosen
 *     wallet must hold ≥ (gate_hold_bps / 10000 × getTokenSupply(mint)). Met ⇒
 *     'hold' (free entry, holding snapshotted). The hold-gate is ONLY invoked
 *     when gate_hold_mint is non-null.
 *   - UNMET hold (or no hold gate) → require a configured fallback:
 *       gate_sol_lamports (verifySolPayment to treasury) OR gate_ct (CT debit).
 *
 * ── MONEY (no new ledger path) ───────────────────────────────────────────────
 * Entry settlement is one of: nothing (free/hold), a verified SOL transfer to
 * the treasury, or a CT debit via `claw-token-ledger`. The dependent tournament
 * is funded directly (`seedPrizePoolCt`, bounded by
 * SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT and debited from the HOUSE TREASURY by
 * the TournamentManager in its create tx — security M3, 2026-09-30), so seating
 * a confirmed signup as an entrant SKIPS the per-entrant tournament buy-in debit
 * (entry was already settled here). CT is atomic-integer; SOL is lamports.
 *
 * ── AGENT PARITY (Rule E5) ───────────────────────────────────────────────────
 * `signup` takes a `SignupSubject` resolved upstream from a Lucia human XOR an
 * agent session → its bound avatar. There is NO guest tier (an economy gate has
 * no demo mode). A confirmed agent signup is seated as ITSELF in the tournament,
 * earning the same prize + leaderboard placement a human gets.
 *
 * ── TESTABILITY ──────────────────────────────────────────────────────────────
 * db / ledger / rpc / clock / the TournamentManager are all injectable seams.
 * Tests mock the DB (the same raw-SQL-interpreter fake the TM tests use), the
 * ledger (in-memory CT), and the RPC (scripted supply/balance/tx), and drive a
 * full free / hold-gated / SOL-gated / agent / prepaid-seating flow with no live
 * services.
 */

import { randomUUID } from 'crypto';
import { db as realDb } from '@clawville/database';
import { sql } from 'drizzle-orm';
import { readSplTokenBalance } from './solana-token-balance';
import * as ledgerModule from './claw-token-ledger';
import type {
  creditClawTokens as CreditFn,
  debitClawTokens as DebitFn,
} from './claw-token-ledger';
import {
  tournamentManager as realTournamentManager,
  TournamentManager,
  TournamentError,
  type CreateTournamentResult,
  type RegisterSubject,
} from './poker/tournament-manager';

// ── Injectable seams ──────────────────────────────────────────────────────────

type DbLike = typeof realDb;
type LedgerLike = {
  debitClawTokens: typeof DebitFn;
  creditClawTokens: typeof CreditFn;
};

/**
 * Minimal Solana RPC seam — abstracts ONLY what the gate needs so tests can
 * script it without a live `Connection`. All amounts are ATOMIC (token base
 * units / lamports) bigints.
 */
export interface EventRpc {
  /** Total supply of a mint (atomic base units). */
  getTokenSupply(mint: string): Promise<bigint>;
  /** A wallet's balance of a mint (atomic base units). 0 when no token account. */
  getTokenBalance(mint: string, ownerPubkey: string): Promise<bigint>;
  /**
   * Resolve a confirmed SOL-transfer tx. Returns the lamports transferred TO
   * `expectedDestPubkey` (summed across instructions) + the success flag, or
   * null when the tx is unknown / unconfirmed. The manager rejects a tx whose
   * destination sum is below the required lamports or whose success is false.
   */
  getSolTransfer(
    txSig: string,
    expectedDestPubkey: string,
  ): Promise<{ lamportsToDest: bigint; success: boolean } | null>;
}

/** A pluggable wall clock (for confirmedAt timestamps + window checks). */
export interface EventClock {
  now(): number;
}

const REAL_CLOCK: EventClock = { now: () => Date.now() };

export interface SpecialEventManagerDeps {
  db?: DbLike;
  ledger?: LedgerLike;
  rpc?: EventRpc;
  clock?: EventClock;
  /** The TournamentManager used to create + seat the dependent tournament. */
  tournamentManager?: TournamentManager;
  /** Treasury pubkey a SOL gate must be paid TO. Default = env merchant wallet. */
  treasuryPubkey?: string;
}

// ── Public types ──────────────────────────────────────────────────────────────

/** A signup subject resolved upstream (Lucia human XOR agent session). NO guest. */
export type SignupSubject =
  | { kind: 'human'; userId: string; avatarId: string; agentId: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string };

/** Entry-method the caller chose; the gate validates it against the event config. */
export type EntryChoice = {
  entryMethod: 'free' | 'hold' | 'sol' | 'ct';
  /** Wallet for an on-chain gate (hold/sol). Required for 'hold'/'sol'. */
  walletType?: 'external' | 'custodial';
  /** The base58 pubkey the subject holds the gate token in / paid SOL from. */
  walletPubkey?: string;
  /** On-chain SOL payment signature (required for 'sol'). */
  solTxSig?: string;
};

export interface GateDecision {
  granted: boolean;
  /** How entry was (or would be) satisfied. */
  method: 'free' | 'hold' | 'sol' | 'ct';
  /** Settlement-shaped proof: hold snapshot, sol tx, or ct debit marker. */
  proof: Record<string, unknown>;
  /** A machine reason when `granted=false`. */
  reason?: string;
}

export interface CreateEventConfig {
  slug: string;
  name: string;
  description?: string | null;
  kind?: string;
  gateHoldMint?: string | null;
  gateHoldBps?: number | null;
  gateSolLamports?: number | bigint | string | null;
  gateCt?: number | null;
  venueConfigJson?: Record<string, unknown> | null;
  prizeConfigJson?: Record<string, unknown> | null;
  maxParticipants?: number | null;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  startsAt?: Date | null;
}

// A `type` (not `interface`) with a string index so it satisfies the
// `db.execute<T extends Record<string, unknown>>` constraint (interfaces lack an
// implicit index signature).
type EventRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  gate_hold_mint: string | null;
  gate_hold_bps: number | null;
  gate_sol_lamports: string | null;
  gate_ct: number | null;
  venue_config_json: unknown;
  prize_config_json: unknown;
  max_participants: number | null;
  registration_opens_at: Date | string | null;
  registration_closes_at: Date | string | null;
  starts_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  /** The in-flight start's claim token + time (security M4); null unless 'starting'. */
  start_claim_id: string | null;
  start_claimed_at: Date | string | null;
} & Record<string, unknown>;

export interface SignupResult {
  signupId: string;
  status: 'pending' | 'confirmed' | 'refunded';
  entryMethod: 'free' | 'hold' | 'sol' | 'ct';
  alreadySignedUp: boolean;
}

export interface CloseAndStartResult {
  tournamentId: string;
  seatedCount: number;
  status: string;
}

export class SpecialEventError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'SpecialEventError';
  }
}

export class SpecialEventManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly rpc: EventRpc;
  private readonly clock: EventClock;
  private readonly tm: TournamentManager;
  private readonly treasuryPubkey: string;

  constructor(deps: SpecialEventManagerDeps = {}) {
    this.db = deps.db ?? realDb;
    this.ledger = deps.ledger ?? {
      debitClawTokens: (...args) => ledgerModule.debitClawTokens(...args),
      creditClawTokens: (...args) => ledgerModule.creditClawTokens(...args),
    };
    this.rpc = deps.rpc ?? defaultEventRpc();
    this.clock = deps.clock ?? REAL_CLOCK;
    this.tm = deps.tournamentManager ?? realTournamentManager;
    this.treasuryPubkey =
      deps.treasuryPubkey ?? process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY ?? '';
  }

  // ── Creation + discovery ────────────────────────────────────────────────────

  /**
   * Create a NEW event (status 'draft'). Validates the gate config strictly: a
   * hold gate needs BOTH mint + bps; a configured SOL/CT amount must be a sane
   * non-negative integer. Returns the created row.
   */
  async createEvent(
    config: CreateEventConfig,
    createdByAvatarId: string | null,
  ): Promise<EventRow> {
    const slug = (config.slug ?? '').trim();
    if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
      throw new SpecialEventError('invalid_slug', 400);
    }
    const name = (config.name ?? '').trim();
    if (!name) throw new SpecialEventError('invalid_name', 400);

    const kind = (config.kind ?? 'poker_tournament').trim() || 'poker_tournament';

    // ── Gate validation ───────────────────────────────────────────────────────
    const holdMint = config.gateHoldMint ?? null;
    const holdBps = config.gateHoldBps ?? null;
    if ((holdMint == null) !== (holdBps == null)) {
      // A hold gate needs BOTH mint AND bps or NEITHER (half a hold gate is a bug).
      throw new SpecialEventError('invalid_hold_gate_requires_mint_and_bps', 400);
    }
    if (holdBps != null && (!Number.isInteger(holdBps) || holdBps < 1 || holdBps > 10000)) {
      throw new SpecialEventError('invalid_gate_hold_bps', 400);
    }
    const solLamports =
      config.gateSolLamports != null ? toBigIntStrict(config.gateSolLamports, 'gate_sol_lamports') : null;
    if (solLamports != null && solLamports <= 0n) {
      throw new SpecialEventError('invalid_gate_sol_lamports', 400);
    }
    const gateCt = config.gateCt ?? null;
    if (gateCt != null && (!Number.isInteger(gateCt) || gateCt < 0)) {
      throw new SpecialEventError('invalid_gate_ct', 400);
    }
    const maxParticipants = config.maxParticipants ?? null;
    if (
      maxParticipants != null &&
      (!Number.isInteger(maxParticipants) || maxParticipants < 1)
    ) {
      throw new SpecialEventError('invalid_max_participants', 400);
    }
    // The seed prize pool is funded from the house treasury at start (M3); bound it.
    readSeedPrizePoolCt(config.prizeConfigJson ?? null);

    const inserted = await this.db.execute<EventRow>(
      sql`INSERT INTO special_events
            (slug, name, description, kind, status,
             gate_hold_mint, gate_hold_bps, gate_sol_lamports, gate_ct,
             venue_config_json, prize_config_json, max_participants,
             registration_opens_at, registration_closes_at, starts_at, created_by)
          VALUES (${slug}, ${name}, ${config.description ?? null}, ${kind}, 'draft',
                  ${holdMint}, ${holdBps}, ${solLamports != null ? solLamports.toString() : null}, ${gateCt},
                  ${config.venueConfigJson != null ? JSON.stringify(config.venueConfigJson) : null}::jsonb,
                  ${config.prizeConfigJson != null ? JSON.stringify(config.prizeConfigJson) : null}::jsonb,
                  ${maxParticipants},
                  ${config.registrationOpensAt ?? null}, ${config.registrationClosesAt ?? null},
                  ${config.startsAt ?? null}, ${createdByAvatarId})
          RETURNING *`,
    );
    const row = inserted[0];
    if (!row) throw new SpecialEventError('create_failed', 500);
    return row;
  }

  /** Public list of events (newest-first, capped). Pure read. */
  async listEvents(limit = 50): Promise<EventRow[]> {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.execute<EventRow>(
      sql`SELECT * FROM special_events ORDER BY created_at DESC LIMIT ${lim}`,
    );
  }

  /** Look up one event by slug (null when absent). Pure read. */
  async getEventBySlug(slug: string): Promise<EventRow | null> {
    const rows = await this.db.execute<EventRow>(
      sql`SELECT * FROM special_events WHERE slug = ${slug}`,
    );
    return rows[0] ?? null;
  }

  // ── Signup lifecycle ────────────────────────────────────────────────────────

  /**
   * Open an event for signups (draft → signup_open). Idempotent. A 'starting'
   * event is not reopened here (409); only a failed start reopens it.
   */
  async openSignup(slug: string): Promise<EventRow> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<EventRow>(
        sql`SELECT * FROM special_events WHERE slug = ${slug} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e) throw new SpecialEventError('event_not_found', 404);
      if (e.status === 'signup_open') return e;
      if (e.status !== 'draft') {
        throw new SpecialEventError('event_not_in_draft', 409);
      }
      const updated = await tx.execute<EventRow>(
        sql`UPDATE special_events SET status = 'signup_open' WHERE id = ${e.id} RETURNING *`,
      );
      return updated[0]!;
    });
  }

  /**
   * FLEXIBLE gate evaluation. Pure decision (the SOL/CT settlement happens in
   * `signup` under the row lock). Reads supply/balance/tx through the injected
   * RPC. NEVER invokes the hold path when `gate_hold_mint` is null.
   */
  async evaluateGate(
    event: EventRow,
    subject: SignupSubject,
    choice: EntryChoice,
  ): Promise<GateDecision> {
    const hasHold = event.gate_hold_mint != null && event.gate_hold_bps != null;
    const hasSol = event.gate_sol_lamports != null;
    const hasCt = event.gate_ct != null;

    // ── FREE: no gate fields at all ─────────────────────────────────────────────
    if (!hasHold && !hasSol && !hasCt) {
      return { granted: true, method: 'free', proof: {} };
    }

    // ── HOLD gate (only when gate_hold_mint is non-null) ────────────────────────
    if (hasHold && (choice.entryMethod === 'hold' || (!hasSol && !hasCt))) {
      // Either the subject explicitly chose 'hold', or the hold gate is the ONLY
      // gate (no fallback) so it must be satisfied. Verify the holding.
      if (!choice.walletPubkey) {
        return { granted: false, method: 'hold', proof: {}, reason: 'hold_requires_wallet' };
      }
      const mint = event.gate_hold_mint!;
      const bps = BigInt(event.gate_hold_bps!);
      const supply = await this.rpc.getTokenSupply(mint);
      if (supply <= 0n) {
        return { granted: false, method: 'hold', proof: {}, reason: 'mint_supply_unavailable' };
      }
      // required = ceil(supply × bps / 10000) — round UP so the threshold is met
      // strictly (a subject at exactly the boundary needs the full required amount).
      const required = (supply * bps + 9999n) / 10000n;
      const balance = await this.rpc.getTokenBalance(mint, choice.walletPubkey);
      const proof = {
        mint,
        walletPubkey: choice.walletPubkey,
        balance: balance.toString(),
        supply: supply.toString(),
        thresholdBps: Number(bps),
        requiredAtomic: required.toString(),
      };
      if (balance >= required) {
        return { granted: true, method: 'hold', proof };
      }
      // Hold unmet. If there's a fallback configured, fall through to require it;
      // otherwise this is the only gate → reject.
      if (!hasSol && !hasCt) {
        return { granted: false, method: 'hold', proof, reason: 'insufficient_hold' };
      }
      // Subject must pick a fallback explicitly (they asked for 'hold' but didn't
      // meet it) — reject so the client re-submits with sol/ct.
      return { granted: false, method: 'hold', proof, reason: 'hold_unmet_use_fallback' };
    }

    // ── SOL fallback ────────────────────────────────────────────────────────────
    if (hasSol && choice.entryMethod === 'sol') {
      if (!this.treasuryPubkey) {
        return { granted: false, method: 'sol', proof: {}, reason: 'treasury_not_configured' };
      }
      if (!choice.solTxSig) {
        return { granted: false, method: 'sol', proof: {}, reason: 'sol_requires_tx_sig' };
      }
      const required = BigInt(event.gate_sol_lamports!);
      const transfer = await this.rpc.getSolTransfer(choice.solTxSig, this.treasuryPubkey);
      if (!transfer || !transfer.success) {
        return { granted: false, method: 'sol', proof: {}, reason: 'sol_tx_not_found_or_failed' };
      }
      if (transfer.lamportsToDest < required) {
        return {
          granted: false,
          method: 'sol',
          proof: { txSig: choice.solTxSig, lamports: transfer.lamportsToDest.toString() },
          reason: 'sol_underpaid',
        };
      }
      return {
        granted: true,
        method: 'sol',
        proof: {
          txSig: choice.solTxSig,
          lamports: transfer.lamportsToDest.toString(),
          toPubkey: this.treasuryPubkey,
          fromPubkey: choice.walletPubkey ?? null,
        },
      };
    }

    // ── CT fallback ─────────────────────────────────────────────────────────────
    if (hasCt && choice.entryMethod === 'ct') {
      // The DEBIT happens in `signup` under the lock (atomic with the confirm).
      // Here we only assert the choice is valid against the config.
      return {
        granted: true,
        method: 'ct',
        proof: { amountCt: event.gate_ct! },
      };
    }

    // Choice did not match any configured gate.
    return {
      granted: false,
      method: choice.entryMethod,
      proof: {},
      reason: 'entry_method_not_available_for_event',
    };
  }

  /**
   * Sign a subject up for an event. Persists a signup row; on a verified entry it
   * is confirmed (CT debit settled in-tx for the 'ct' method). Idempotent on
   * (event, avatar): a re-signup returns the existing row WITHOUT a second
   * debit/charge. NO guest tier.
   *
   * SOL/hold verification (RPC reads) happens BEFORE the tx; the CT debit happens
   * INSIDE the tx so the debit and the confirmed row commit atomically. A replayed
   * SOL tx is rejected GLOBALLY (across ALL SOL-gated events, not just this one — the
   * treasury is a single shared pubkey, so one payment must buy exactly one seat
   * anywhere): the in-tx dup-SELECT rejects a sig used on any non-refunded SOL signup,
   * and the partial unique index `special_event_signups_sol_txsig_global_unique` is the
   * race-proof backstop (two concurrent signups for DIFFERENT events lock different
   * event rows and never serialize on the SELECT — only the DB index guarantees global
   * single-use; its 23505 is translated to `sol_tx_already_used`).
   */
  async signup(
    slug: string,
    subject: SignupSubject,
    choice: EntryChoice,
  ): Promise<SignupResult> {
    // Load the event (pre-tx) to evaluate the gate (RPC reads are slow; do them
    // outside the row lock). The tx re-reads + locks before any write.
    const event = await this.getEventBySlug(slug);
    if (!event) throw new SpecialEventError('event_not_found', 404);
    if (event.status !== 'signup_open') {
      throw new SpecialEventError('signup_not_open', 409);
    }
    if (event.registration_closes_at) {
      const closes = new Date(event.registration_closes_at).getTime();
      if (this.clock.now() >= closes) {
        throw new SpecialEventError('signup_closed', 409);
      }
    }

    const decision = await this.evaluateGate(event, subject, choice);
    if (!decision.granted) {
      throw new SpecialEventError(decision.reason ?? 'gate_not_satisfied', 402);
    }

    const subjectType = subject.kind === 'agent' ? 'agent' : 'human';
    const walletUsed =
      decision.method === 'hold' || decision.method === 'sol'
        ? choice.walletType ?? 'external'
        : null;

    return this.db.transaction(async (tx) => {
      // Lock the event row for the duration (max_participants count + status are
      // read under it so a burst of concurrent signups can't overfill).
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        gate_ct: number | null;
        max_participants: number | null;
      }>(
        sql`SELECT id, status, gate_ct, max_participants
            FROM special_events WHERE id = ${event.id} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e) throw new SpecialEventError('event_not_found', 404);

      // Idempotency: an existing signup for (event, avatar) returns as-is, no
      // second charge.
      const existing = await tx.execute<{
        id: string;
        status: string;
        entry_method: string;
      }>(
        sql`SELECT id, status, entry_method FROM special_event_signups
            WHERE event_id = ${e.id} AND avatar_id = ${subject.avatarId}`,
      );
      if (existing[0]) {
        return {
          signupId: existing[0].id,
          status: existing[0].status as SignupResult['status'],
          entryMethod: existing[0].entry_method as SignupResult['entryMethod'],
          alreadySignedUp: true,
        };
      }

      if (e.status !== 'signup_open') {
        throw new SpecialEventError('signup_not_open', 409);
      }

      // Capacity check (confirmed + pending count, excluding refunded).
      if (e.max_participants != null) {
        const countRows = await tx.execute<{ cnt: number }>(
          sql`SELECT count(*)::int AS cnt FROM special_event_signups
              WHERE event_id = ${e.id} AND status <> 'refunded'`,
        );
        if (Number(countRows[0]?.cnt ?? 0) >= e.max_participants) {
          throw new SpecialEventError('event_full', 409);
        }
      }

      // Replay guard for SOL: the same on-chain tx sig may settle entry for ONE
      // signup GLOBALLY (otherwise one payment buys many seats). The treasury is a
      // single shared pubkey across EVERY SOL-gated event, and getSolTransfer is
      // event-agnostic (it only proves "a tx paid >= required lamports to the
      // treasury and succeeded"), so a sig scoped per-event would let one on-chain
      // payment satisfy entry to event A AND event B AND ... — pay once, enter every
      // live SOL-gated event for free. Reject a sig already recorded on ANY
      // non-refunded signup (any event). The partial unique index on
      // (entry_proof_json->>'txSig') WHERE entry_method='sol' AND status<>'refunded'
      // (special-events.ts) is the race-proof backstop — two concurrent signups for
      // DIFFERENT events lock different event rows and never serialize on this SELECT,
      // so the DB index is what actually guarantees global single-use.
      if (decision.method === 'sol') {
        const sig = (decision.proof as { txSig?: string }).txSig;
        if (sig) {
          const dup = await tx.execute<{ id: string }>(
            sql`SELECT id FROM special_event_signups
                WHERE status <> 'refunded'
                  AND entry_method = 'sol'
                  AND entry_proof_json->>'txSig' = ${sig}`,
          );
          if (dup[0]) {
            throw new SpecialEventError('sol_tx_already_used', 409);
          }
        }
      }

      // Settle a CT-method entry in-tx (debit before confirming).
      let proof = decision.proof;
      if (decision.method === 'ct') {
        const amount = e.gate_ct ?? 0;
        if (amount > 0) {
          const debit = await this.ledger.debitClawTokens(
            {
              avatarId: subject.avatarId,
              amount,
              reason: 'special_event_entry',
              source: 'simulation',
              metadata: { eventId: e.id, slug, agentId: subject.agentId },
              actorKind: subject.kind === 'agent' ? 'agent' : 'human',
            },
            tx,
          );
          proof = { ...proof, amountCt: amount, ledgerId: debit.ledgerId };
        }
      }

      let insRows: { id: string }[];
      try {
        insRows = await tx.execute<{ id: string }>(
          sql`INSERT INTO special_event_signups
                (event_id, user_id, avatar_id, agent_id, subject_type, entry_method,
                 wallet_used, entry_proof_json, status, confirmed_at)
              VALUES (${e.id}, ${subject.kind === 'human' ? subject.userId : subject.userId},
                      ${subject.avatarId}, ${subject.agentId}, ${subjectType},
                      ${decision.method}, ${walletUsed},
                      ${JSON.stringify(proof)}::jsonb, 'confirmed', now())
              RETURNING id`,
        );
      } catch (err) {
        // The partial unique index `special_event_signups_sol_txsig_global_unique`
        // is the race-proof backstop for the cross-event SOL-replay bypass: two
        // concurrent signups for DIFFERENT events lock different `special_events`
        // rows, so they never serialize on the SELECT dup-check above — only the DB
        // index actually guarantees one sig = one seat globally. Translate its
        // unique-violation (Postgres 23505) into the same clean error the SELECT
        // guard raises. The (event, avatar) idempotency index can't collide here
        // (the existing-row check returned early above), so a 23505 on this INSERT
        // is the SOL tx-sig index.
        const code = (err as { code?: string }).code;
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (
          code === '23505' &&
          (constraint.includes('sol_txsig') || decision.method === 'sol')
        ) {
          throw new SpecialEventError('sol_tx_already_used', 409);
        }
        throw err;
      }

      return {
        signupId: insRows[0]!.id,
        status: 'confirmed' as const,
        entryMethod: decision.method,
        alreadySignedUp: false,
      };
    });
  }

  // ── Close signups → create + seat the dependent tournament ──────────────────

  /**
   * Close signups and stand up the DEPENDENT poker tournament. Steps:
   *   1. Lock the event; require status 'signup_open'; collect every CONFIRMED
   *      signup; CLAIM the start by flipping 'signup_open' → 'starting' in the
   *      SAME tx (security M4, 2026-09-30). A concurrent second start then finds
   *      'starting' and gets 409 — it can never create a second tournament or
   *      fund a second seed pool. The partial unique index
   *      `poker_tournaments_special_event_active_unique` is the DB backstop.
   *   2. Create a PREPAID tournament (`buyInCt: 0`, `seedPrizePoolCt` from
   *      prize_config_json, `specialEventId = event.id`) — the link is the FK on
   *      the tournament (dependency points UP). The TournamentManager debits the
   *      seed from the HOUSE TREASURY in its create tx (security M3).
   *   3. Register every confirmed signup as an entrant. The tournament buyIn is 0,
   *      so `registerEntrant` SKIPS the per-entrant debit (entry was already
   *      settled at the event layer — no double-charge).
   *   4. Force-start the tournament (seat the field).
   *   5. Flip the event 'starting' → 'live'; the UPDATE must match exactly one row
   *      (our claim token AND our tournament still running/completed).
   * FAILURE: a create failure reconciles the claim (normally → 'signup_open'). A
   * register/start failure first cancels the tournament (the cancel credits the
   * seed back to the treasury), then reopens signups, so an operator can retry. A
   * 0-row final flip goes to `recoverUnflippedStart`. A CRASHED start leaves a
   * claim that `reconcileStartingEvent` resolves once it is older than
   * SPECIAL_EVENT_START_CLAIM_STALE_MS — on the next start call for the event or
   * the settlement worker tick (`reconcileStaleStarts`).
   */
  async closeSignupAndStart(slug: string): Promise<CloseAndStartResult> {
    // Phase 0: a claim left by a crashed start is reconciled first, so a dead
    // start can never block this event forever (fresh claims are left alone).
    const current = await this.getEventBySlug(slug);
    if (current?.status === 'starting') {
      await this.reconcileStartingEvent(current.id, { staleBefore: this.staleClaimCutoff() });
    } else if (current?.status === 'live') {
      // A live event whose tournament was cancelled (room abort / boot recovery)
      // reopens here, so the operator can start it again.
      await this.reconcileOrphanedLiveEvent(current.id);
    }

    // Phase 1 (tx): lock, validate, and CLAIM the start ('signup_open' →
    // 'starting' with a fresh claim token), then release the row lock for the
    // tournament work. Every later write for this start CASes on the token.
    const claimId = randomUUID();
    const prep = await this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<EventRow>(
        sql`SELECT * FROM special_events WHERE slug = ${slug} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e) throw new SpecialEventError('event_not_found', 404);
      if (e.status === 'live' || e.status === 'completed') {
        throw new SpecialEventError('event_already_started', 409);
      }
      if (e.status === 'starting') {
        throw new SpecialEventError('event_start_in_progress', 409);
      }
      if (e.status !== 'signup_open') {
        throw new SpecialEventError('event_not_open_for_start', 409);
      }

      const signups = await tx.execute<{
        avatar_id: string;
        agent_id: string | null;
        subject_type: string;
        user_id: string | null;
      }>(
        sql`SELECT avatar_id, agent_id, subject_type, user_id
            FROM special_event_signups
            WHERE event_id = ${e.id} AND status = 'confirmed'
            ORDER BY created_at ASC`,
      );
      if (signups.length < 2) {
        throw new SpecialEventError('not_enough_confirmed_signups', 409);
      }

      // Validate the seed BEFORE the claim so a bad legacy prize config leaves the
      // event open (rows created before the route bound may exceed it).
      const seedPrizePoolCt = readSeedPrizePoolCt(e.prize_config_json);

      const claimed = await tx.execute<{ id: string }>(
        sql`UPDATE special_events
            SET status = 'starting', start_claim_id = ${claimId},
                start_claimed_at = ${new Date(this.clock.now())}
            WHERE id = ${e.id} AND status = 'signup_open'
            RETURNING id`,
      );
      if (!claimed[0]) {
        throw new SpecialEventError('event_start_in_progress', 409);
      }
      return { event: e, signups, seedPrizePoolCt };
    });

    const { event, signups, seedPrizePoolCt } = prep;

    // ── Create the PREPAID dependent tournament (link via FK) ───────────────────
    const prize = (event.prize_config_json ?? {}) as {
      payoutCurve?: Array<{ placement: number; share: number }>;
      startingStack?: number;
      seatsPerTable?: number;
      rakeBps?: number;
      blindScheduleId?: string;
    };

    let tournament: CreateTournamentResult;
    try {
      tournament = await this.tm.createTournament(
        {
          name: event.name,
          buyInCt: 0,
          prepaid: { seedPrizePoolCt: seedPrizePoolCt.toString() },
          rakeBps: prize.rakeBps ?? 0,
          minEntrants: 2,
          maxEntrants: Math.max(signups.length, 2),
          seatsPerTable: prize.seatsPerTable ?? 9,
          startingStack: prize.startingStack ?? 10000,
          payoutCurve: prize.payoutCurve,
          blindScheduleId: prize.blindScheduleId,
          specialEventId: event.id,
        },
        event.created_by,
      );
    } catch (err) {
      // Normally nothing was created (the TM create tx rolled back, seed debit
      // included). The reconcile also covers an ambiguous commit or a pre-0075
      // linked tournament: it cancels a registering one (seed refunded) and
      // reopens signups, or marks a running one live.
      await this.reconcileStartingEvent(event.id, { claimId });
      if (err instanceof TournamentError) {
        throw new SpecialEventError(`tournament_create_failed:${err.message}`, err.httpStatus);
      }
      if (isUniqueViolation(err)) {
        // A non-cancelled tournament already links to this event (pre-0075 data).
        throw new SpecialEventError('event_tournament_already_exists', 409);
      }
      throw err;
    }

    let start: Awaited<ReturnType<TournamentManager['startTrigger']>>;
    let seatedCount = 0;
    try {
      // ── Seat every confirmed signup WITHOUT a second buy-in (buyIn 0 → no debit) ─
      for (const s of signups) {
        const regSubject: RegisterSubject =
          s.subject_type === 'agent'
            ? {
                kind: 'agent',
                userId: s.user_id ?? s.avatar_id,
                avatarId: s.avatar_id,
                agentId: s.agent_id ?? s.avatar_id,
              }
            : {
                kind: 'user',
                userId: s.user_id ?? s.avatar_id,
                avatarId: s.avatar_id,
                agentId: null,
              };
        const reg = await this.tm.registerEntrant(regSubject, tournament.id);
        if (!reg.alreadyRegistered) seatedCount += 1;
        else seatedCount += 1; // already-present entrant still counts as seated
      }

      // ── Force-start the tournament (seat the field) ───────────────────────────
      start = await this.tm.startTrigger(tournament.id, { force: true });
      if (start.status === 'cancelled') {
        // The TM cancelled it (field below the floor) and refunded the seed.
        throw new SpecialEventError('tournament_start_cancelled', 409);
      }
    } catch (err) {
      // Cancel (idempotent; credits the seed back to the treasury) and reopen
      // signups. A cancelled tournament drops out of the active-unique index, so
      // a retried start can create a fresh one.
      try {
        await this.tm.cancelAndRefundOrphan(tournament.id);
      } catch (cancelErr) {
        // The tournament still holds the event's active slot. Leave the claim;
        // the stale-claim reconcile retries the cancel later.
        console.error(
          `[special-event] start of event ${event.id} failed and tournament ${tournament.id} could not be cancelled; the stale-claim reconcile will retry:`,
          cancelErr,
        );
        throw err;
      }
      await this.reconcileStartingEvent(event.id, { claimId });
      if (err instanceof SpecialEventError) throw err;
      if (err instanceof TournamentError) {
        throw new SpecialEventError(`tournament_start_failed:${err.message}`, err.httpStatus);
      }
      throw err;
    }

    // ── Flip the event 'starting' → 'live' (link already on the tournament row) ──
    // Exactly one row, or this start does not own the outcome: the claim must
    // still be ours AND our tournament must still be running/completed (a room
    // abort or boot recovery may have cancelled it after startTrigger returned).
    const flipped = await this.flipStartToLive(event.id, claimId, tournament.id);
    if (!flipped) {
      await this.recoverUnflippedStart(event.id, claimId, tournament.id);
    }

    return {
      tournamentId: tournament.id,
      seatedCount: start.seatedCount || seatedCount,
      status: 'live',
    };
  }

  /**
   * The guarded 'starting' → 'live' flip, in ONE transaction that locks the
   * event row and THEN the tournament row (Codex round 2, item 9). Every TM
   * cancel takes the tournament row lock (FOR UPDATE), so the status check and
   * the flip are atomic against it: a cancel either commits first (the check
   * sees 'cancelled', no flip) or waits until the flip commits (the event is
   * live; `reconcileOrphanedLiveEvent` then reopens it). The event-then-
   * tournament order matches `reconcileStartingEvent` (event lock held while the
   * TM cancel locks the tournament), so the two paths cannot deadlock.
   * Returns true only when exactly one event row flipped.
   */
  private async flipStartToLive(
    eventId: string,
    claimId: string,
    tournamentId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const eventRows = await tx.execute<{
        id: string;
        status: string;
        start_claim_id: string | null;
        start_claimed_at: Date | string | null;
      }>(
        sql`SELECT id, status, start_claim_id, start_claimed_at
            FROM special_events WHERE id = ${eventId} FOR UPDATE`,
      );
      const e = eventRows[0];
      if (!e || e.status !== 'starting' || e.start_claim_id !== claimId) return false;

      const tournamentRows = await tx.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM poker_tournaments
            WHERE id = ${tournamentId} AND special_event_id = ${eventId}
            FOR UPDATE`,
      );
      const t = tournamentRows[0];
      if (!t || (t.status !== 'running' && t.status !== 'completed')) return false;

      const flipped = await tx.execute<{ id: string }>(
        sql`UPDATE special_events
            SET status = 'live', started_at = now(),
                start_claim_id = NULL, start_claimed_at = NULL
            WHERE id = ${eventId} AND status = 'starting'
              AND start_claim_id = ${claimId}
            RETURNING id`,
      );
      return flipped.length === 1;
    });
  }

  /**
   * The final flip matched 0 rows. Returns only when the event already ended in
   * the right state WITH our tournament (someone else finalized it); otherwise it
   * cancels our tournament (the cancel refunds the seed exactly once) and throws.
   */
  private async recoverUnflippedStart(
    eventId: string,
    claimId: string,
    tournamentId: string,
  ): Promise<void> {
    const outcome = await this.reconcileStartingEvent(eventId, { claimId });
    if (outcome === 'live' || outcome === 'completed') return;
    if (outcome === 'reopened') {
      throw new SpecialEventError('tournament_start_cancelled', 409);
    }
    // The claim is gone (the stale-claim reconcile or a settle took over).
    const rows = await this.db.execute<{ event_status: string; tournament_status: string | null }>(
      sql`SELECT e.status AS event_status, t.status AS tournament_status
          FROM special_events e
          LEFT JOIN poker_tournaments t
            ON t.id = ${tournamentId} AND t.special_event_id = e.id
          WHERE e.id = ${eventId}`,
    );
    const state = rows[0];
    const eventDone = state?.event_status === 'live' || state?.event_status === 'completed';
    const oursActive =
      state?.tournament_status === 'running' || state?.tournament_status === 'completed';
    if (eventDone && oursActive) return;
    await this.tm.cancelAndRefundOrphan(tournamentId);
    throw new SpecialEventError('event_start_claim_lost', 409);
  }

  /** Claims older than this belong to a dead start (SPECIAL_EVENT_START_CLAIM_STALE_MS). */
  private staleClaimCutoff(): Date {
    return new Date(this.clock.now() - SPECIAL_EVENT_START_CLAIM_STALE_MS);
  }

  /**
   * Bring ONE 'starting' event back in line with its linked tournament (security
   * M4 recovery), under the event row lock. Acts only when the event still holds
   * `claimId` (a start's own failure path) or its claim is older than
   * `staleBefore` (a crashed start). Outcome by the non-cancelled linked
   * tournaments:
   *   - registering/seating → cancel through the TM (seed refunded exactly once:
   *     the TM cancel is idempotent under its row lock) → 'signup_open';
   *   - running → 'live'; completed → 'completed';
   *   - none → 'signup_open'.
   * Every outcome clears the claim in the same UPDATE. The TM cancel is its own
   * transaction; if this one then fails, the next reconcile sees the cancelled
   * tournament and reopens, so no path moves CT twice.
   */
  async reconcileStartingEvent(
    eventId: string,
    opts: { claimId?: string; staleBefore?: Date },
  ): Promise<StartReconcileOutcome> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        start_claim_id: string | null;
        start_claimed_at: Date | string | null;
      }>(
        sql`SELECT id, status, start_claim_id, start_claimed_at
            FROM special_events WHERE id = ${eventId} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e || e.status !== 'starting') return 'not_starting';
      if (opts.claimId && e.start_claim_id !== opts.claimId) return 'claim_lost';
      if (
        opts.staleBefore &&
        e.start_claimed_at != null &&
        new Date(e.start_claimed_at).getTime() >= opts.staleBefore.getTime()
      ) {
        return 'in_progress';
      }

      const linked = await tx.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM poker_tournaments
            WHERE special_event_id = ${e.id} AND status <> 'cancelled'
            ORDER BY created_at DESC`,
      );
      for (const t of linked) {
        if (t.status === 'registering' || t.status === 'seating') {
          await this.tm.cancelAndRefundOrphan(t.id);
        }
      }

      if (linked.some((t) => t.status === 'completed')) {
        await tx.execute(
          sql`UPDATE special_events
              SET status = 'completed', completed_at = now(),
                  started_at = COALESCE(started_at, now()),
                  start_claim_id = NULL, start_claimed_at = NULL
              WHERE id = ${e.id} AND status = 'starting'`,
        );
        return 'completed';
      }
      if (linked.some((t) => t.status === 'running')) {
        await tx.execute(
          sql`UPDATE special_events
              SET status = 'live', started_at = now(),
                  start_claim_id = NULL, start_claimed_at = NULL
              WHERE id = ${e.id} AND status = 'starting'`,
        );
        return 'live';
      }
      await tx.execute(
        sql`UPDATE special_events
            SET status = 'signup_open', start_claim_id = NULL, start_claimed_at = NULL
            WHERE id = ${e.id} AND status = 'starting'`,
      );
      return 'reopened';
    });
  }

  /**
   * A 'live' event whose linked tournaments were ALL cancelled after it went
   * live (room abort, boot orphan recovery) goes back to 'signup_open' under the
   * event row lock (Codex round 2, item 9), so an operator can start it again.
   * No CT moves here: the TM cancel already refunded the seed exactly once, and
   * a second pass finds the event not 'live' and does nothing. Confirmed signups
   * stay confirmed; their entry is not charged again at the next start.
   */
  async reconcileOrphanedLiveEvent(eventId: string): Promise<'not_live' | 'has_tournament' | 'reopened'> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM special_events WHERE id = ${eventId} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e || e.status !== 'live') return 'not_live';
      const active = await tx.execute<{ active: number }>(
        sql`SELECT count(*)::int AS active FROM poker_tournaments
            WHERE special_event_id = ${e.id} AND status <> 'cancelled'`,
      );
      if (Number(active[0]?.active ?? 0) > 0) return 'has_tournament';
      await tx.execute(
        sql`UPDATE special_events
            SET status = 'signup_open', started_at = NULL,
                start_claim_id = NULL, start_claimed_at = NULL
            WHERE id = ${e.id} AND status = 'live'`,
      );
      return 'reopened';
    });
  }

  /**
   * One recovery pass for the settlement worker: stale start claims first, then
   * live events left without a tournament. One bad event never blocks the rest.
   */
  async reconcileEvents(
    limit = 50,
  ): Promise<{ scanned: number; reconciled: number; failed: number }> {
    const starts = await this.reconcileStaleStarts(limit);
    const lim = Math.min(Math.max(Math.floor(limit), 1), 500);
    const rows = await this.db.execute<{ id: string }>(
      sql`SELECT e.id FROM special_events e
          WHERE e.status = 'live'
            AND NOT EXISTS (
              SELECT 1 FROM poker_tournaments t
              WHERE t.special_event_id = e.id AND t.status <> 'cancelled'
            )
          ORDER BY e.started_at ASC NULLS FIRST
          LIMIT ${lim}`,
    );
    let reconciled = starts.reconciled;
    let failed = starts.failed;
    for (const row of rows) {
      try {
        if ((await this.reconcileOrphanedLiveEvent(row.id)) === 'reopened') reconciled += 1;
      } catch (err) {
        failed += 1;
        console.error(`[special-event] orphaned live event reconcile failed for event ${row.id}:`, err);
      }
    }
    return { scanned: starts.scanned + rows.length, reconciled, failed };
  }

  /**
   * Reconcile every event whose start claim is stale (a crashed start). Run by
   * the settlement worker on each tick (through `reconcileEvents`); one bad
   * event never blocks the rest.
   */
  async reconcileStaleStarts(
    limit = 50,
  ): Promise<{ scanned: number; reconciled: number; failed: number }> {
    const cutoff = this.staleClaimCutoff();
    const lim = Math.min(Math.max(Math.floor(limit), 1), 500);
    const rows = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM special_events
          WHERE status = 'starting'
            AND (start_claimed_at IS NULL OR start_claimed_at < ${cutoff})
          ORDER BY start_claimed_at ASC NULLS FIRST
          LIMIT ${lim}`,
    );
    let reconciled = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const outcome = await this.reconcileStartingEvent(row.id, { staleBefore: cutoff });
        if (outcome === 'reopened' || outcome === 'live' || outcome === 'completed') reconciled += 1;
      } catch (err) {
        failed += 1;
        console.error(`[special-event] stale start reconcile failed for event ${row.id}:`, err);
      }
    }
    return { scanned: rows.length, reconciled, failed };
  }

  /**
   * Read the event plus its dependent tournament/results without mutating either
   * lifecycle. This is the public-status read used by GET /api/events/:slug;
   * event completion remains an explicit command through `settleEvent`.
   */
  async getEventSettlementSnapshot(slug: string): Promise<{
    event: EventRow;
    tournamentId: string | null;
    results: Array<{ avatarId: string; agentId: string | null; placement: number; prizeCt: string }>;
  } | null> {
    const event = await this.getEventBySlug(slug);
    if (!event) return null;

    // Preserve the existing public response semantics: dependent settlement is
    // surfaced only after the event has started.
    if (event.status !== 'live' && event.status !== 'completed') {
      return { event, tournamentId: null, results: [] };
    }

    const tournamentRows = await this.db.execute<{ id: string; status: string }>(
      sql`SELECT id, status FROM poker_tournaments
          WHERE special_event_id = ${event.id}
          ORDER BY created_at DESC LIMIT 1`,
    );
    const tournament = tournamentRows[0] ?? null;
    if (!tournament) {
      return { event, tournamentId: null, results: [] };
    }

    const results = await this.db.execute<{
      avatar_id: string;
      agent_id: string | null;
      placement: number;
      prize_ct: string;
    }>(
      sql`SELECT avatar_id, agent_id, placement, prize_ct
          FROM poker_tournament_results
          WHERE tournament_id = ${tournament.id}
          ORDER BY placement ASC`,
    );

    return {
      event,
      tournamentId: tournament.id,
      results: results.map((row) => ({
        avatarId: row.avatar_id,
        agentId: row.agent_id,
        placement: row.placement,
        prizeCt: row.prize_ct,
      })),
    };
  }

  /**
   * Settle the event: read the LINKED tournament's results (found via the
   * dependency FK — `WHERE special_event_id = event.id`) and flip the event →
   * 'completed'. Prize CREDITS were already paid by the tournament's own
   * idempotent `settleTournament` at champion-crown; this method records the
   * event-level completion + surfaces the results. Idempotent.
   */
  async settleEvent(slug: string): Promise<{
    alreadySettled: boolean;
    tournamentId: string | null;
    results: Array<{ avatarId: string; agentId: string | null; placement: number; prizeCt: string }>;
  }> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<EventRow>(
        sql`SELECT * FROM special_events WHERE slug = ${slug} FOR UPDATE`,
      );
      const e = lockRows[0];
      if (!e) throw new SpecialEventError('event_not_found', 404);

      // Find the dependent tournament via the FK (dependency points UP).
      const tRows = await tx.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM poker_tournaments
            WHERE special_event_id = ${e.id}
            ORDER BY created_at DESC LIMIT 1`,
      );
      const tournament = tRows[0] ?? null;

      const results = tournament
        ? await tx.execute<{
            avatar_id: string;
            agent_id: string | null;
            placement: number;
            prize_ct: string;
          }>(
            sql`SELECT avatar_id, agent_id, placement, prize_ct
                FROM poker_tournament_results
                WHERE tournament_id = ${tournament.id}
                ORDER BY placement ASC`,
          )
        : [];

      const mapped = results.map((r) => ({
        avatarId: r.avatar_id,
        agentId: r.agent_id,
        placement: r.placement,
        prizeCt: r.prize_ct,
      }));

      if (e.status === 'completed') {
        return { alreadySettled: true, tournamentId: tournament?.id ?? null, results: mapped };
      }

      // Only mark completed once the dependent tournament has settled.
      if (tournament && tournament.status === 'completed') {
        await tx.execute(
          sql`UPDATE special_events SET status = 'completed', completed_at = now(),
                start_claim_id = NULL, start_claimed_at = NULL
              WHERE id = ${e.id} AND status <> 'completed'`,
        );
      }

      return { alreadySettled: false, tournamentId: tournament?.id ?? null, results: mapped };
    });
  }

  /**
   * Reconcile the parent event for one EXACT dependent tournament. This is the
   * automatic completion path called by TournamentManager after its settlement
   * transaction commits. A standalone tournament has no parent and returns null.
   * The event row lock makes concurrent automatic/admin retries one-winner and
   * the completed-state replay is idempotent.
   */
  async settleEventForTournament(tournamentId: string): Promise<{
    alreadySettled: boolean;
    tournamentId: string;
    results: Array<{ avatarId: string; agentId: string | null; placement: number; prizeCt: string }>;
  } | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<EventRow & { tournament_status: string }>(
        sql`SELECT e.*, t.status AS tournament_status
            FROM poker_tournaments t
            JOIN special_events e ON e.id = t.special_event_id
            WHERE t.id = ${tournamentId}
            FOR UPDATE OF e`,
      );
      const linked = rows[0];
      if (!linked) return null;

      const results = await tx.execute<{
        avatar_id: string;
        agent_id: string | null;
        placement: number;
        prize_ct: string;
      }>(
        sql`SELECT avatar_id, agent_id, placement, prize_ct
            FROM poker_tournament_results
            WHERE tournament_id = ${tournamentId}
            ORDER BY placement ASC`,
      );
      const mapped = results.map((r) => ({
        avatarId: r.avatar_id,
        agentId: r.agent_id,
        placement: r.placement,
        prizeCt: r.prize_ct,
      }));

      if (linked.status === 'completed') {
        return { alreadySettled: true, tournamentId, results: mapped };
      }
      // 'starting' counts as live here: a completed tournament proves the start
      // succeeded even if the final 'starting' → 'live' flip did not commit.
      const eventStarted = linked.status === 'live' || linked.status === 'starting';
      if (linked.tournament_status !== 'completed' || !eventStarted) {
        return { alreadySettled: false, tournamentId, results: mapped };
      }

      await tx.execute(
        sql`UPDATE special_events SET status = 'completed', completed_at = now(),
              start_claim_id = NULL, start_claimed_at = NULL
            WHERE id = ${linked.id} AND status IN ('live', 'starting')`,
      );
      return { alreadySettled: false, tournamentId, results: mapped };
    });
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Upper bound on a special event's seed prize pool (atomic CT). 100,000 vCLAW is
 * $1,000 at 1 vCLAW = $0.01 — the same ceiling as the quest `tokenReward` bound
 * (security M2) and the `CASH_HOUSE_BANK_BANKROLL` default, the largest single
 * house-funded amounts elsewhere. The house treasury pays the seed (M3), so the
 * bound caps one operator action, and the treasury balance caps the total.
 */
export const SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT = 100_000;

/**
 * A start claim older than this belongs to a dead start (process crash) and is
 * reconciled by the next start call or the settlement worker tick. A live start
 * is one tournament create, at most 200 single-row registrations, and one seat
 * pass (seconds), so 10 minutes does not take over a working start in practice.
 * If it ever did, the start's claim CAS and its guarded final flip still keep
 * every path conserving (security M4, 2026-09-30).
 */
export const SPECIAL_EVENT_START_CLAIM_STALE_MS = 10 * 60_000;

export type StartReconcileOutcome =
  | 'not_starting'
  | 'claim_lost'
  | 'in_progress'
  | 'reopened'
  | 'live'
  | 'completed';

/**
 * Read + bound `prize_config_json.seedPrizePoolCt` (absent ⇒ 0). Enforced at
 * create AND again at start, because events created before the bound may hold
 * any value.
 */
export function readSeedPrizePoolCt(prizeConfig: unknown): bigint {
  const raw = (prizeConfig as { seedPrizePoolCt?: unknown } | null)?.seedPrizePoolCt;
  if (raw == null) return 0n;
  if (typeof raw !== 'number' && typeof raw !== 'bigint' && typeof raw !== 'string') {
    throw new SpecialEventError('invalid_seedPrizePoolCt', 400);
  }
  const seed = toBigIntStrict(raw, 'seedPrizePoolCt');
  if (seed > BigInt(SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT)) {
    throw new SpecialEventError('seed_prize_pool_exceeds_max', 400);
  }
  return seed;
}

/** Postgres unique violation (23505), raw or wrapped in `cause`. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Strictly coerce a non-negative atomic amount (number | bigint | decimal string)
 * to bigint. Rejects fractions/NaN/Infinity/negatives/garbage strings.
 */
export function toBigIntStrict(value: number | bigint | string, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new SpecialEventError(`invalid_${field}`, 400);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new SpecialEventError(`invalid_${field}`, 400);
    return BigInt(value);
  }
  const s = value.trim();
  if (!/^\d+$/.test(s)) throw new SpecialEventError(`invalid_${field}`, 400);
  return BigInt(s);
}

/**
 * Default production RPC seam — a lazily-constructed `@solana/web3.js` Connection
 * reading SOLANA_RPC_URL (devnet default, mirroring wager-program-client). Only
 * instantiated when a hold/sol gate is actually exercised on prod; tests inject
 * a scripted EventRpc and never reach this.
 */
function defaultEventRpc(): EventRpc {
  let conn: import('@solana/web3.js').Connection | null = null;
  const getConn = () => {
    if (!conn) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');
      const url = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      conn = new web3.Connection(url, 'confirmed');
    }
    return conn;
  };
  const PublicKey = () =>
    (require('@solana/web3.js') as typeof import('@solana/web3.js')).PublicKey;

  return {
    async getTokenSupply(mint: string): Promise<bigint> {
      const res = await getConn().getTokenSupply(new (PublicKey())(mint));
      return BigInt(res.value.amount);
    },
    async getTokenBalance(mint: string, ownerPubkey: string): Promise<bigint> {
      // Extracted to the shared reader (Tokenomics Phase A) — the CLV
      // linked-wallet balance service reads through the SAME helper. The
      // hold-gate only needs the atomic total, so we drop decimals/uiAmount.
      return (await readSplTokenBalance(getConn(), mint, ownerPubkey)).amountAtomic;
    },
    async getSolTransfer(
      txSig: string,
      expectedDestPubkey: string,
    ): Promise<{ lamportsToDest: bigint; success: boolean } | null> {
      const tx = await getConn().getParsedTransaction(txSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta) return null;
      const success = tx.meta.err == null;
      // Sum SOL credited to the expected dest by diffing pre/post balances on the
      // account keys (robust to System-program transfer instruction shape).
      const keys = tx.transaction.message.accountKeys;
      let lamportsToDest = 0n;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const pubkey = typeof k === 'string' ? k : (k.pubkey?.toBase58?.() ?? String(k.pubkey));
        if (pubkey === expectedDestPubkey) {
          const pre = BigInt(tx.meta.preBalances[i] ?? 0);
          const post = BigInt(tx.meta.postBalances[i] ?? 0);
          if (post > pre) lamportsToDest += post - pre;
        }
      }
      return { lamportsToDest, success };
    },
  };
}

/** Process-wide manager (production singleton — real db + ledger + rpc + TM). */
export const specialEventManager = new SpecialEventManager();
