'use client';

/**
 * HoldemModal — Phase 6.5.1 AUTHORITATIVE engine client.
 *
 * Replaces the 6.5.0 client-side mock (mulberry32 deck + local winner + local
 * bankroll). Every card, board, pot, side-pot, winner, payout, and stack now
 * comes from the server (`/api/cove/holdem/*`) — the client sends ONLY the
 * human's decision (fold|check|call|bet|raise + amount) and renders the
 * response verbatim. There is NO client-side deck, NO local hand-eval, NO local
 * pot/side-pot math, NO local winner resolution. Mirrors how BlackjackModal
 * drives the cove-blackjack route.
 *
 * Poker STACK custody model (distinct from blackjack's per-hand stake):
 *   open  → GET /session/current (restore an open table) else lazy POST
 *           /session/open {buyIn} on first Deal — buy-in is debited into the
 *           table's playerStack.
 *   deal  → POST /hand/deal {tableId}. A hand that needs no human action (human
 *           folds to a walk, or is all-in from blinds) settles inline
 *           (dealtImmediately). Otherwise the server runs bots up to the
 *           human's first decision.
 *   act   → POST /action {handId, action, amount?} per FOLD/CHECK/CALL/BET/RAISE.
 *           Server runs all bots to the next human turn or showdown.
 *   close → POST /session/close (Lucia auth) reveals serverSeed + cashes out
 *           the remaining playerStack to the avatar.
 *
 * Idempotency: a fresh UUID is minted per Deal press; the /action key is
 * DECISION-scoped (keyed to the (act, amount) decision, reused on a same-
 * decision re-press so a lost terminal settle replays instead of double-
 * charging, cleared on success). A synchronous `busyRef` lock blocks double-
 * fire before the first await. Every request is also bounded by a ~15s
 * client timeout so a stalled call can't freeze the modal forever.
 *
 * Agent modes (UI seam only — see AgentModeBar + FEATURE_GATE):
 *   - Control     — the human taps the buttons. A connected agent acts as an
 *                   ADVISOR (read-only hint panel) and NEVER submits a decision.
 *   - Autonomous  — a connected agent decides. Disabled until the connected-
 *                   agent WebSocket protocol ships (FEATURE_GATE, Phase 6.5.2).
 *
 * Iris Xe safe: pure React/CSS DOM, zero Three.js. No drei Text/Billboard, no
 * InstancedMesh+ShaderMaterial, no per-frame vector alloc. No-dark-text-on-
 * dark-panel: light tokens only on the dark felt/velvet (cream/amber/explicit
 * hex; never gray/slate-700+).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import '@/styles/cove-tokens.css';
import type {
  HoldemCard as ViewCard,
  SeatState,
  SeatStatus,
  RaiseConfig,
} from '@/lib/cove/holdem-types';
import { HOLDEM_SEATS, HOLDEM_BIG_BLIND } from '@/lib/cove/holdem-types';
import {
  COVE_HOLDEM_MIN_BUYIN,
  COVE_HOLDEM_MAX_BUYIN,
  HOLDEM_BOT_PERSONALITIES,
  type HoldemCard as WireCard,
  type HoldemTableWire,
  type HoldemDealResponse,
  type HoldemDealInProgressResponse,
  type HoldemActionInProgressResponse,
  type HoldemSettledResponse,
  type SerializedHoldemHand,
} from '@clawville/shared';
import {
  CoveApiError,
  describeHoldemError,
  fetchCurrentHoldemTable,
  isHoldemSettled,
  useOpenHoldemTable,
  useDealHoldemHand,
  useHoldemAction,
  useCloseHoldemTable,
} from '@/lib/cove/holdem-api-client';

// impl-card polished primitives — prop shapes match holdem-types.ts.
import SeatPosition from './SeatPosition';
import CommunityCardRow from './CommunityCardRow';
import PotDisplay from './PotDisplay';
import ChipStack from './ChipStack';

// ---------------------------------------------------------------------------
// Bot display names (deterministic, parallel to seats 1..5).
// ---------------------------------------------------------------------------
const BOT_NAMES: Record<number, string> = {
  1: 'Tess',  // tag
  2: 'Vex',   // lag
  3: 'Pip',   // tight-passive
  4: 'Cal',   // calling-station
  5: 'Nita',  // nit
};

function botLabel(seat: number): string {
  const p = HOLDEM_BOT_PERSONALITIES[seat];
  const name = BOT_NAMES[seat] ?? `Bot ${seat}`;
  if (!p) return name;
  // Short personality tag in parens (e.g. "Vex (LAG)").
  const short =
    p === 'tag' ? 'TAG' :
    p === 'lag' ? 'LAG' :
    p === 'tight-passive' ? 'TP' :
    p === 'calling-station' ? 'CS' :
    'NIT';
  return `${name} (${short})`;
}

// ---------------------------------------------------------------------------
// Seat oval layout positions — absolute within the felt area.
// ---------------------------------------------------------------------------
const SEAT_POSITIONS: Array<{ top: string; left: string }> = [
  { top: 'calc(100% - 78px)', left: '50%'         }, // 0 = human (bottom-center)
  { top: 'calc(100% - 56px)', left: '20%'         }, // 1 (bottom-left)
  { top: '50%',               left: '4%'          }, // 2 (mid-left)
  { top: '12%',               left: '18%'         }, // 3 (top-left)
  { top: '12%',               left: '70%'         }, // 4 (top-right)
  { top: '50%',               left: '90%'         }, // 5 (mid-right)
];

// ---------------------------------------------------------------------------
// View-model: in-progress hand (built only from server responses).
// ---------------------------------------------------------------------------
interface LiveHand {
  handId: string;
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  humanHole: WireCard[];
  board: WireCard[];
  /** Stringified bigints from the server. */
  toCall: string;
  currentBet: string;
  humanStack: string;
  humanCommitted: string;
}

// ---------------------------------------------------------------------------
// Toast (modal-local)
// ---------------------------------------------------------------------------
type ToastTone = 'info' | 'warn' | 'error';
interface ToastState { message: string; tone: ToastTone; id: number; }

// ---------------------------------------------------------------------------
// Agent mode (UI seam — see AgentModeBar; no WS protocol yet)
// ---------------------------------------------------------------------------
type AgentMode = 'control' | 'autonomous';
interface AdvisorMessage { id: number; text: string; }

// ---------------------------------------------------------------------------
// Helpers — build the rendered SeatState[] from server responses.
// ---------------------------------------------------------------------------

/** Convert a wire card to a view card (face-up). */
function viewCard(c: WireCard): ViewCard {
  return { suit: c.suit, rank: c.rank };
}

/**
 * Build the 6 rendered seats for an IN-PROGRESS hand. The server does NOT
 * expose bot hole cards / stacks mid-hand (anti-leak) — so bots render with
 * hidden cards and no stack number. Only the human seat (0) shows its hole
 * cards, live stack, and street commitment.
 */
function seatsForLiveHand(h: LiveHand, humanIsActing: boolean): SeatState[] {
  const seats: SeatState[] = [];
  const humanHole: [ViewCard, ViewCard] | null =
    h.humanHole.length === 2
      ? [viewCard(h.humanHole[0]!), viewCard(h.humanHole[1]!)]
      : null;
  const humanStreetBet = bigToNum(h.currentBet) > 0 || bigToNum(h.humanCommitted) > 0
    ? streetCommittedFromTotal(h)
    : 0;

  for (let s = 0; s < HOLDEM_SEATS; s++) {
    const isHuman = s === 0;
    seats.push({
      seatIndex: s,
      name: isHuman ? 'You' : botLabel(s),
      stack: isHuman ? bigToNum(h.humanStack) : 0,
      streetBet: isHuman ? humanStreetBet : 0,
      holeCards: isHuman
        ? humanHole
        : ([
            { suit: 'spades', rank: 'A', hidden: true },
            { suit: 'spades', rank: 'A', hidden: true },
          ] as [ViewCard, ViewCard]),
      status: 'active',
      isSmallBlind: s === h.smallBlindSeat,
      isBigBlind: s === h.bigBlindSeat,
      isDealer: s === h.buttonSeat,
      isActing: isHuman && humanIsActing,
    });
  }
  return seats;
}

/**
 * The human's street commitment for the live HUD pill. `humanCommitted` is the
 * human's TOTAL chips in the pot this hand; for a single-street display pill we
 * show what the human owes context via toCall, so the pill uses the lesser of
 * humanCommitted and currentBet (a coarse but honest "in this round" figure).
 * The authoritative per-street figure is recomputed by the server each turn;
 * this is display only.
 */
function streetCommittedFromTotal(h: LiveHand): number {
  const committed = bigToNum(h.humanCommitted);
  const currentBet = bigToNum(h.currentBet);
  return Math.min(committed, currentBet);
}

/**
 * Build the 6 rendered seats for a SETTLED hand from the full outcome. Every
 * seat reveals its hole cards (unless it folded preflop with no cards shown),
 * committed total, won, net, status, and best-hand category.
 */
function seatsForSettled(outcome: SerializedHoldemHand): SeatState[] {
  return outcome.seats.map((s) => {
    const status: SeatStatus =
      s.status === 'allin' ? 'allin' : s.status === 'folded' ? 'folded' : 'active';
    const hole: [ViewCard, ViewCard] | null =
      s.holeCards.length === 2
        ? [viewCard(s.holeCards[0]!), viewCard(s.holeCards[1]!)]
        : null;
    return {
      seatIndex: s.seat,
      name: s.isHuman ? 'You' : botLabel(s.seat),
      // After settle, "stack" shows what the seat won this hand (its return).
      stack: Number(s.won),
      streetBet: 0,
      holeCards: hole,
      status,
      isSmallBlind: s.seat === outcome.smallBlindSeat,
      isBigBlind: s.seat === outcome.bigBlindSeat,
      isDealer: s.seat === outcome.buttonSeat,
      isActing: false,
    };
  });
}

/** Number() a stringified bigint that provably fits a JS number (≤ 500 CT). */
function bigToNum(s: string | null | undefined): number {
  if (s == null) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Pad the server board (0/3/4/5 cards) to a 5-slot row with null placeholders. */
function boardToRow(board: WireCard[]): (ViewCard | null)[] {
  const row: (ViewCard | null)[] = [null, null, null, null, null];
  for (let i = 0; i < board.length && i < 5; i++) row[i] = viewCard(board[i]!);
  return row;
}

// ---------------------------------------------------------------------------
// Raise / bet slider
// ---------------------------------------------------------------------------
function RaiseSlider({ config, onChange, onConfirm, onCancel }: {
  config: RaiseConfig;
  onChange: (v: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const label = config.verb === 'bet' ? 'Bet' : 'Raise to';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'rgba(0,0,0,0.35)',
      border: '1px solid rgba(60,180,100,0.2)',
      borderRadius: 6, padding: '6px 10px',
    }}>
      <input
        type="range"
        min={config.min}
        max={config.max}
        step={1}
        value={config.value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--pt-amber)' }}
        aria-label={`${label} amount`}
      />
      <span style={{
        fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-amber)',
        fontWeight: 700, minWidth: 56, textAlign: 'right',
      }}>
        {config.value} CT
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className="pt-btn pt-btn-primary"
        style={{ height: 32, padding: '0 12px', fontSize: 11, fontWeight: 700, minWidth: 64 }}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="pt-btn pt-btn-ghost"
        style={{ height: 32, padding: '0 8px', fontSize: 11 }}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function HoldemModal() {
  const { holdemModalOpen, holdemBuyIn, closeHoldemTable } = useCoveStore();
  const { data: avatar } = useAvatar();

  // ── Server-mirrored state ────────────────────────────────────────────────
  const [table, setTable] = useState<HoldemTableWire | null>(null);
  const [balance, setBalance] = useState(0);
  const [live, setLive] = useState<LiveHand | null>(null);
  const [settled, setSettled] = useState<HoldemSettledResponse | null>(null);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  // ── Raise slider (the only local UI state) ───────────────────────────────
  const [showRaise, setShowRaise] = useState(false);
  const [raiseConfig, setRaiseConfig] = useState<RaiseConfig>({ min: 0, max: 0, value: 0, verb: 'bet' });

  // ── Agent mode + advisor surface (seam) ──────────────────────────────────
  const [agentMode, setAgentMode] = useState<AgentMode>('control');
  const [advisorMessages] = useState<AdvisorMessage[]>([]);

  // ── API hooks ─────────────────────────────────────────────────────────────
  const openTable = useOpenHoldemTable();
  const dealHand = useDealHoldemHand();
  const action = useHoldemAction();
  const closeTable = useCloseHoldemTable();

  // ── Refs ──────────────────────────────────────────────────────────────────
  const busyRef = useRef(false);                    // synchronous double-fire lock
  const dealKeyRef = useRef<string | null>(null);   // per-deal idempotency key
  // Decision-scoped idempotency key for /action. Keyed to the (act, amount)
  // DECISION — not the button press, not the hand. A same-decision re-press
  // REUSES the key so a lost-response TERMINAL action REPLAYS the settled
  // outcome (server IdempotencyReplayError) instead of double-charging; a
  // DIFFERENT decision mints a fresh key. Cleared on every success + in
  // resetHand so the same (act, amount) legitimately recurring across streets
  // (e.g. "check" preflop then "check" flop) can never collide into a stale
  // replay — that is why we do NOT key by a hash of (handId, act, amount).
  const pendingActionRef = useRef<{ act: string; amount?: number; key: string } | null>(null);
  const walkAwayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // deferred close after cash-out
  // Monotonic open-session epoch — bumped on every close (below). Async handlers
  // snapshot it before their first await and BAIL if it changed, so a stalled
  // request from a PRIOR open session can never setState (apply a stale hand /
  // outcome) onto a freshly reopened+dealt session, nor release the new session's
  // busyRef. Closes the reset()-un-gates-without-aborting late-continuation clobber.
  const openEpochRef = useRef(0);
  const toastSeqRef = useRef(0);
  const tableRef = useRef<HoldemTableWire | null>(null);
  tableRef.current = table;
  // Capture the mutation reset fns in a ref (react-query returns a new mutation
  // object every render, so referencing them directly in the close effect would
  // churn its deps). <HoldemModal/> is always mounted (cove/page.tsx) and only
  // self-gates with `if (!holdemModalOpen) return null`, so a stalled/in-flight
  // mutation's isPending would otherwise PERSIST across close→reopen and freeze
  // the reopened modal on "Dealing…"/disabled buttons. Cleared on close below.
  const resetMutationsRef = useRef<() => void>(() => {});
  resetMutationsRef.current = () => {
    openTable.reset();
    dealHand.reset();
    action.reset();
    closeTable.reset();
  };

  const isAuthed = Boolean(avatar);
  const phase: 'idle' | 'player-turn' | 'settled' =
    settled ? 'settled' : live ? 'player-turn' : 'idle';

  // ── Toast helpers ──────────────────────────────────────────────────────────
  const showToast = useCallback((message: string, tone: ToastTone = 'info') => {
    toastSeqRef.current += 1;
    setToast({ message, tone, id: toastSeqRef.current });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((p) => (p?.id === toast.id ? null : p)), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Reset transient hand state ──────────────────────────────────────────────
  const resetHand = useCallback(() => {
    setLive(null);
    setSettled(null);
    setShowRaise(false);
    dealKeyRef.current = null;
    pendingActionRef.current = null;
  }, []);

  // ── Eager restore on open ────────────────────────────────────────────────────
  useEffect(() => {
    if (!holdemModalOpen) return;
    setBalance(avatar?.clawTokens ?? 0);
    setRevealedSeed(null);
    resetHand();
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentHoldemTable();
        if (cancelled || !current) return;
        if (current.table.status !== 'open') return;
        setTable(current.table);
        setBalance(current.walletBalance);
        showToast('Resumed your open table.', 'info');
      } catch {
        // Network blip — lazy-open on first Deal handles it.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdemModalOpen]);

  // ── Reset everything on close ────────────────────────────────────────────────
  useEffect(() => {
    if (!holdemModalOpen) {
      // Invalidate any in-flight handler from this now-closing session (see
      // openEpochRef) so its late continuation can't clobber the next session.
      openEpochRef.current += 1;
      setTable(null);
      resetHand();
      setRevealedSeed(null);
      setToast(null); // clear any lingering toast so it can't flash on reopen
      busyRef.current = false;
      // Clear stale mutation isPending so a reopened modal starts clean (see
      // resetMutationsRef — the component stays mounted across open/close, so
      // a prior session's in-flight/stalled mutation would otherwise leave the
      // freshly reopened idle modal frozen on "Dealing…" until the 15s abort).
      resetMutationsRef.current();
      // Cancel a pending walk-away close so a late fire can't call handleClose
      // after the modal is already closed.
      if (walkAwayTimerRef.current) {
        clearTimeout(walkAwayTimerRef.current);
        walkAwayTimerRef.current = null;
      }
    }
  }, [holdemModalOpen, resetHand]);

  // ── Clear a pending walk-away timer on unmount ───────────────────────────────
  useEffect(() => () => {
    if (walkAwayTimerRef.current) {
      clearTimeout(walkAwayTimerRef.current);
      walkAwayTimerRef.current = null;
    }
  }, []);

  // ── Close handler (fire-and-forget close any open table, authed only) ────────
  const handleClose = useCallback(() => {
    const t = tableRef.current;
    if (t && t.status === 'open' && isAuthed && !live && !busyRef.current && !revealedSeed) {
      closeTable.mutate({ tableId: t.id });
    }
    closeHoldemTable();
  }, [isAuthed, live, revealedSeed, closeTable, closeHoldemTable]);

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!holdemModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fairnessOpen) { setFairnessOpen(false); return; }
        if (showRaise) { setShowRaise(false); return; }
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [holdemModalOpen, fairnessOpen, showRaise, handleClose]);

  // ── Open (or reuse) a table; returns the table or null on failure ────────────
  const ensureTable = useCallback(async (): Promise<HoldemTableWire | null> => {
    if (tableRef.current && tableRef.current.status === 'open') return tableRef.current;
    const myEpoch = openEpochRef.current; // bail if the modal closes mid-open
    try {
      const buyIn = Math.max(
        COVE_HOLDEM_MIN_BUYIN,
        Math.min(COVE_HOLDEM_MAX_BUYIN, Math.floor(holdemBuyIn || COVE_HOLDEM_MIN_BUYIN)),
      );
      const opened = await openTable.mutateAsync({ currency: 'clawtoken', buyIn });
      // Session closed during open — drop the stale setState. The opened table +
      // buy-in are recoverable server-side via the eager-restore on reopen.
      if (openEpochRef.current !== myEpoch) return null;
      setTable(opened.table);
      setBalance(opened.walletBalance);
      return opened.table;
    } catch (err) {
      if (openEpochRef.current !== myEpoch) return null; // stale error — drop toast
      showToast(describeHoldemError(err, 'open'), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
      return null;
    }
  }, [openTable, holdemBuyIn, showToast]);

  // ── Apply a settled response (single place balance/outcome land) ─────────────
  const applySettled = useCallback((res: HoldemSettledResponse) => {
    setSettled(res);
    setBalance(res.walletBalance);
    setLive(null);
    setShowRaise(false);
    // Reflect the table's new playerStack so the HUD + next deal are accurate.
    setTable((prev) => (prev ? { ...prev, playerStack: res.playerStack } : prev));
  }, []);

  // ── Apply an in-progress response (deal or action) ──────────────────────────
  const applyDealInProgress = useCallback((res: HoldemDealInProgressResponse) => {
    setSettled(null);
    setLive({
      handId: res.handId,
      handIndex: res.handIndex,
      buttonSeat: res.buttonSeat,
      smallBlindSeat: res.smallBlindSeat,
      bigBlindSeat: res.bigBlindSeat,
      humanHole: res.humanHole,
      board: res.board,
      toCall: res.toCall,
      currentBet: res.currentBet,
      humanStack: res.humanStack,
      humanCommitted: res.humanCommitted,
    });
    setShowRaise(false);
  }, []);

  const applyActionInProgress = useCallback((res: HoldemActionInProgressResponse) => {
    setLive((prev) =>
      prev
        ? {
            ...prev,
            humanHole: res.humanHole,
            board: res.board,
            toCall: res.toCall,
            currentBet: res.currentBet,
            humanStack: res.humanStack,
            humanCommitted: res.humanCommitted,
          }
        : prev,
    );
    setShowRaise(false);
  }, []);

  // ── DEAL ──────────────────────────────────────────────────────────────────────
  const handleDeal = useCallback(async () => {
    if (busyRef.current || phase !== 'idle') return;
    if (agentMode === 'autonomous') return; // gated — no connected-agent driver yet
    busyRef.current = true;
    const myEpoch = openEpochRef.current; // bail if the modal closes mid-request
    try {
      const t = await ensureTable();
      if (openEpochRef.current !== myEpoch) return; // session closed — drop
      if (!t) return;
      if (!dealKeyRef.current) dealKeyRef.current = crypto.randomUUID();
      const res: HoldemDealResponse = await dealHand.mutateAsync({
        tableId: t.id,
        idempotencyKey: dealKeyRef.current,
      });
      if (openEpochRef.current !== myEpoch) return; // stale continuation — drop
      if (isHoldemSettled(res)) {
        applySettled(res); // resolved inline (human never had to act)
      } else {
        applyDealInProgress(res);
      }
    } catch (err) {
      if (openEpochRef.current !== myEpoch) return; // stale error — drop
      showToast(describeHoldemError(err, 'deal'), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
    } finally {
      dealKeyRef.current = null;
      if (openEpochRef.current === myEpoch) busyRef.current = false; // only release MY lock
    }
  }, [phase, agentMode, ensureTable, dealHand, applySettled, applyDealInProgress, showToast]);

  // ── ACTION (fold / check / call / bet / raise) ──────────────────────────────
  const runAction = useCallback(async (act: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => {
    if (busyRef.current || !live) return;
    if (agentMode === 'autonomous') return;
    busyRef.current = true;
    const myEpoch = openEpochRef.current; // bail if the modal closes mid-request
    // Decision-scoped idempotency key. Same (act, amount) as the still-pending
    // decision → REUSE its key so a lost-response terminal settle REPLAYS
    // (never double-charges); a different decision mints fresh.
    const pending = pendingActionRef.current;
    if (!pending || pending.act !== act || pending.amount !== amount) {
      pendingActionRef.current = { act, amount, key: crypto.randomUUID() };
    }
    const idempotencyKey = pendingActionRef.current.key;
    try {
      const res = await action.mutateAsync({
        handId: live.handId,
        action: act,
        ...(amount !== undefined ? { amount } : {}),
        idempotencyKey,
      });
      if (openEpochRef.current !== myEpoch) return; // stale continuation — drop
      if (isHoldemSettled(res)) {
        applySettled(res);
      } else {
        applyActionInProgress(res);
      }
      // Success (terminal OR non-terminal) — clear the pending decision so the
      // NEXT action mints a fresh key, even the same (act, amount) on a later
      // street (e.g. "check" preflop then "check" flop won't reuse a stale key).
      pendingActionRef.current = null;
    } catch (err) {
      if (openEpochRef.current !== myEpoch) return; // stale error — drop
      // KEEP pendingActionRef: a same-decision re-press replays the (possibly
      // lost) terminal settle; a different-decision press mints fresh above.
      showToast(describeHoldemError(err, 'action'), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
    } finally {
      if (openEpochRef.current === myEpoch) busyRef.current = false; // only release MY lock
    }
  }, [live, agentMode, action, applySettled, applyActionInProgress, showToast]);

  // ── Open the raise/bet slider ────────────────────────────────────────────────
  const handleOpenRaise = useCallback(() => {
    if (!live || phase !== 'player-turn') return;
    const currentBet = bigToNum(live.currentBet);
    const humanCommitted = bigToNum(live.humanCommitted);
    const humanStack = bigToNum(live.humanStack);
    const maxShove = humanCommitted + humanStack; // TOTAL street commitment ceiling
    const verb: 'bet' | 'raise' = currentBet === 0 ? 'bet' : 'raise';
    // Min TOTAL street commitment: opening bet ≥ committed + BB; raise ≥
    // currentBet + BB (a full min-raise is at least one big blind over the
    // current bet — the server is the final validator and will reject a short
    // raise that isn't an all-in).
    const minRaise = verb === 'bet'
      ? humanCommitted + HOLDEM_BIG_BLIND
      : currentBet + HOLDEM_BIG_BLIND;
    const min = Math.min(minRaise, maxShove);
    if (maxShove <= currentBet) {
      // Can't out-bet the current bet — only a call/all-in is legal. Fall back
      // to calling.
      void runAction('call');
      return;
    }
    setRaiseConfig({ min, max: maxShove, value: min, verb });
    setShowRaise(true);
  }, [live, phase, runAction]);

  const handleConfirmRaise = useCallback(() => {
    const { value, verb } = raiseConfig;
    setShowRaise(false);
    void runAction(verb, value);
  }, [raiseConfig, runAction]);

  const handleAllIn = useCallback(() => {
    if (!live || phase !== 'player-turn') return;
    const currentBet = bigToNum(live.currentBet);
    const humanCommitted = bigToNum(live.humanCommitted);
    const humanStack = bigToNum(live.humanStack);
    const shoveTotal = humanCommitted + humanStack;
    setShowRaise(false);
    // If shoving still doesn't exceed the current bet, it's an all-in CALL.
    if (shoveTotal <= currentBet) {
      void runAction('call');
      return;
    }
    void runAction(currentBet === 0 ? 'bet' : 'raise', shoveTotal);
  }, [live, phase, runAction]);

  // ── NEXT HAND ────────────────────────────────────────────────────────────────
  const handleNextHand = useCallback(() => {
    resetHand();
  }, [resetHand]);

  // ── WALK AWAY (close table → reveal seed + cash out, authed) ─────────────────
  const handleWalkAway = useCallback(async () => {
    // Synchronous double-fire lock — mirror handleDeal/runAction. Without this a
    // sub-frame double-click (or a click during the 1500ms seed-reveal window
    // when `disabled={inFlight}` has lagged react-query) would fire two
    // concurrent POST /session/close for the same table; the loser lands in
    // catch, cancels the just-armed auto-close timer, and the modal hangs open
    // on a now-closed table.
    if (busyRef.current) return;
    const t = tableRef.current;
    if (!t || !isAuthed) { handleClose(); return; }
    if (live) { showToast('Finish the current hand first.', 'warn'); return; }
    busyRef.current = true;
    const myEpoch = openEpochRef.current; // bail if the modal closes mid-cash-out
    try {
      const res = await closeTable.mutateAsync({ tableId: t.id });
      if (openEpochRef.current !== myEpoch) return; // modal closed during cash-out — drop
      setRevealedSeed(res.serverSeed);
      setBalance(res.walletBalance);
      setTable((prev) => (prev ? { ...prev, status: 'closed', serverSeed: res.serverSeed, playerStack: '0' } : prev));
      showToast(`Cashed out ${res.cashOut} CT — seed ${res.serverSeed.slice(0, 10)}…${res.serverSeed.slice(-6)} revealed.`, 'info');
      if (walkAwayTimerRef.current) clearTimeout(walkAwayTimerRef.current);
      walkAwayTimerRef.current = setTimeout(() => {
        walkAwayTimerRef.current = null;
        handleClose();
      }, 1500);
    } catch (err) {
      if (openEpochRef.current !== myEpoch) return; // stale error — drop
      // Ambiguous outcome (0/408) or provably-already-closed (table_not_open):
      // resolve against the server. A close that actually LANDED would leave a
      // stale local 'open' table here — revealedSeed never set, Next Hand
      // enabled — and ensureTable would reuse it, looping Deal on
      // table_not_open 409s against a table whose chips were already credited.
      const ambiguousClose =
        err instanceof CoveApiError &&
        (err.status === 0 || err.status === 408 || err.code?.startsWith('table_not_open') === true);
      if (ambiguousClose) {
        try {
          const current = await fetchCurrentHoldemTable();
          if (openEpochRef.current !== myEpoch) return; // modal closed — drop
          if (!current || current.table.id !== t.id || current.table.status !== 'open') {
            // The close landed server-side (chips credited in the same tx).
            // Mark the local table closed so ensureTable can't reuse it — a
            // Next Hand from here legitimately opens a fresh session.
            setTable((prev) => (prev ? { ...prev, status: 'closed', playerStack: '0' } : prev));
            if (current) setBalance(current.walletBalance);
            showToast('Your cash-out went through — chips were credited.', 'info');
            return;
          }
          // Table is genuinely still open — the close never landed; fall
          // through to the retry copy (Walk Away again is safe).
        } catch {
          if (openEpochRef.current !== myEpoch) return; // modal closed — drop
          // Resolve probe also failed — fall through to the retry copy.
        }
      }
      showToast(describeHoldemError(err, 'close'), 'warn');
    } finally {
      if (openEpochRef.current === myEpoch) busyRef.current = false; // only release MY lock
    }
  }, [isAuthed, live, closeTable, showToast, handleClose]);

  // ── Derived display values ─────────────────────────────────────────────────
  const inFlight =
    openTable.isPending || dealHand.isPending || action.isPending || closeTable.isPending;

  // Once the cash-out resolves (serverSeed revealed) the table is already
  // 'closed' server-side; lock Walk Away so the 1500ms auto-close window can't
  // re-fire a close on a closed table. Guests never reveal a seed, so their
  // 'Close' button stays gated on inFlight only.
  const walkAwayLocked = inFlight || Boolean(revealedSeed);

  const outcome: SerializedHoldemHand | null = settled?.outcome ?? null;

  const seats: SeatState[] = useMemo(() => {
    if (outcome) return seatsForSettled(outcome);
    if (live) return seatsForLiveHand(live, phase === 'player-turn' && !inFlight);
    return [];
  }, [outcome, live, phase, inFlight]);

  const communityCards: (ViewCard | null)[] = useMemo(() => {
    if (outcome) return boardToRow(outcome.board);
    if (live) return boardToRow(live.board);
    return [null, null, null, null, null];
  }, [outcome, live]);

  const pot = useMemo(() => {
    if (outcome) {
      return outcome.pots.reduce((sum, p) => sum + Number(p.amount), 0);
    }
    if (live) {
      // Live pot is not directly returned — approximate from the action log we
      // don't have; instead show the human-visible figure: humanCommitted +
      // currentBet-context is incomplete, so we show 0 until the server-driven
      // outcome. (Honest: the server is authoritative; we never fabricate a pot.)
      return 0;
    }
    return 0;
  }, [outcome, live]);

  const toCallNum = live ? bigToNum(live.toCall) : 0;
  const facingBet = toCallNum > 0;
  const canCheck = !facingBet && phase === 'player-turn';

  const winnerLabel = useMemo(() => {
    if (!outcome) return null;
    const winners = outcome.seats.filter((s) => s.isWinner);
    if (winners.length === 0) return null;
    if (winners.length === 1) {
      const w = winners[0]!;
      return w.isHuman ? 'YOU WIN' : `${botLabel(w.seat).split(' ')[0]} WINS`;
    }
    return winners.some((w) => w.isHuman) ? 'SPLIT POT (you share)' : 'SPLIT POT';
  }, [outcome]);

  const humanNetNum = settled ? Number(settled.net) : 0;

  const fairnessSummary = useMemo(() => {
    if (!table) return 'Open a hand to commit the table seed';
    const short = `${table.serverSeedHash.slice(0, 8)}…${table.serverSeedHash.slice(-6)}`;
    return revealedSeed
      ? `Seed revealed: ${revealedSeed.slice(0, 6)}…${revealedSeed.slice(-4)}`
      : `Committed: ${short}`;
  }, [table, revealedSeed]);

  if (!holdemModalOpen) return null;

  const toastClass = toast
    ? `pt-toast${toast.tone === 'warn' ? ' pt-toast-warn' : toast.tone === 'error' ? ' pt-toast-error' : ''}`
    : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Texas Hold'em table"
      style={{
        position: 'fixed', inset: 0, zIndex: 9990,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        background: 'rgba(2, 16, 24, 0.88)',
        backdropFilter: 'blur(6px)',
        animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
      }}
    >
      <div
        style={{
          position: 'relative', width: '100%',
          maxWidth: 780,
          maxHeight: 'min(94vh, 760px)',
          borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(60,180,120,0.35)',
          background: 'var(--pt-velvet)',
          animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 16px',
          background: 'rgba(0,0,0,0.3)',
          borderBottom: '1px solid rgba(60,180,120,0.2)',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => setFairnessOpen(true)}
            aria-label={`Provably fair: ${fairnessSummary}`}
            title={fairnessSummary}
            style={{
              background: 'none', border: 'none', color: 'var(--pt-cream-soft)',
              cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="11" width="18" height="11" rx="1" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
          <div style={{
            fontSize: 11, fontFamily: 'var(--pt-data)',
            color: 'var(--pt-mute)', letterSpacing: '0.12em',
          }}>
            NO-LIMIT HOLD&apos;EM · 6-MAX · BLINDS 1/2
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              fontSize: 13, fontFamily: 'var(--pt-data)', fontWeight: 700,
              color: 'var(--pt-amber)', letterSpacing: '0.06em',
              background: 'rgba(150,110,30,0.15)', border: '1px solid rgba(150,110,30,0.3)',
              borderRadius: 6, padding: '3px 10px',
            }}>
              {balance.toLocaleString()} CT{!isAuthed ? ' demo' : ''}
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close Hold'em table"
              style={{
                background: 'none', border: 'none',
                color: 'var(--pt-mute)', cursor: 'pointer',
                padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* ── Agent mode toggle + advisor surface ──────────────────────── */}
        <AgentModeBar mode={agentMode} onMode={setAgentMode} advisorMessages={advisorMessages} />

        {/* ── Felt + seat oval ─────────────────────────────────────────── */}
        <div style={{
          flex: 1, position: 'relative', minHeight: 340,
          background: 'linear-gradient(180deg, #0d3a1e 0%, #0a2e18 50%, #0d3a1e 100%)',
          overflow: 'hidden',
        }}>
          {/* Felt texture */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(60,160,80,0.05) 20px)',
            pointerEvents: 'none',
          }} />

          {/* Oval table rim */}
          <div aria-hidden style={{
            position: 'absolute',
            top: '12%', left: '8%', right: '8%', bottom: '18%',
            borderRadius: '50%',
            border: '2px solid rgba(60,180,80,0.18)',
            background: 'rgba(0,0,0,0.1)',
            pointerEvents: 'none',
          }} />

          {/* Community cards + pot — table center */}
          <div style={{
            position: 'absolute', top: '46%', left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 10, zIndex: 3,
          }}>
            <CommunityCardRow cards={communityCards} />
            {pot > 0 && <PotDisplay pot={pot} />}
          </div>

          {/* Seat positions — absolute layout, SeatPosition is position-agnostic */}
          {seats.map((seat) => {
            const pos = SEAT_POSITIONS[seat.seatIndex] ?? SEAT_POSITIONS[0]!;
            const isPlayer = seat.seatIndex === 0;
            const revealCards = isPlayer || phase === 'settled';
            return (
              <div
                key={seat.seatIndex}
                style={{
                  position: 'absolute',
                  top: pos.top,
                  left: pos.left,
                  transform: 'translate(-50%, -50%)',
                  zIndex: isPlayer ? 2 : 1,
                }}
              >
                <SeatPosition seat={seat} isPlayer={isPlayer} revealCards={revealCards} />
              </div>
            );
          })}

          {/* Outcome overlay */}
          {phase === 'settled' && winnerLabel && (
            <div style={{
              position: 'absolute', top: '28%', left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10, pointerEvents: 'none',
              animation: 'bj-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
              textAlign: 'center',
            }}>
              <style>{`
                @keyframes bj-banner-in {
                  from { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
                  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                }
              `}</style>
              <div style={{
                background: 'var(--pt-velvet)',
                border: `2px solid ${humanNetNum >= 0 ? 'var(--pt-amber-glow)' : '#e85555'}`,
                padding: '14px 32px',
                boxShadow: `0 0 28px ${humanNetNum >= 0 ? 'var(--pt-amber-glow)' : '#e85555'}55`,
              }}>
                <div style={{
                  color: humanNetNum >= 0 ? 'var(--pt-amber)' : '#e85555',
                  fontSize: 11, fontFamily: 'var(--pt-data)',
                  letterSpacing: '0.2em', fontWeight: 700, marginBottom: 4,
                }}>
                  {winnerLabel}
                </div>
                <div style={{
                  color: humanNetNum >= 0 ? 'var(--pt-cream)' : '#e85555',
                  fontSize: 28, fontWeight: 700,
                  fontFamily: 'var(--pt-display)', lineHeight: 1,
                }}>
                  {humanNetNum >= 0 ? `+${humanNetNum}` : `${humanNetNum}`} CT
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Action strip ─────────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: 'rgba(0,0,0,0.38)',
          borderTop: '1px solid rgba(60,180,120,0.18)',
          padding: '10px 16px',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {showRaise && phase === 'player-turn' && (
            <RaiseSlider
              config={raiseConfig}
              onChange={(v) => setRaiseConfig((c) => ({ ...c, value: v }))}
              onConfirm={handleConfirmRaise}
              onCancel={() => setShowRaise(false)}
            />
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>

            {/* idle: buy-in + DEAL */}
            {phase === 'idle' && (
              <>
                <div style={{
                  fontSize: 11, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
                  letterSpacing: '0.1em',
                }}>
                  Buy-in {COVE_HOLDEM_MIN_BUYIN}–{COVE_HOLDEM_MAX_BUYIN} CT · Blinds 1/2
                  {table ? ` · Stack ${Number(table.playerStack).toLocaleString()} CT` : ''}
                </div>
                <button
                  type="button"
                  onClick={() => { void handleDeal(); }}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 100 }}
                >
                  {inFlight ? 'Dealing…' : 'Deal'}
                </button>
              </>
            )}

            {/* player-turn: live actions */}
            {phase === 'player-turn' && !showRaise && (
              <>
                <button
                  type="button" onClick={() => { void runAction('fold'); }}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 60 }}
                >
                  Fold
                </button>

                {canCheck ? (
                  <button
                    type="button" onClick={() => { void runAction('check'); }}
                    disabled={inFlight || agentMode === 'autonomous'}
                    className="pt-btn pt-btn-primary"
                    style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 70 }}
                  >
                    Check
                  </button>
                ) : (
                  <button
                    type="button" onClick={() => { void runAction('call'); }}
                    disabled={inFlight || agentMode === 'autonomous'}
                    className="pt-btn pt-btn-primary"
                    style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 90 }}
                  >
                    Call {toCallNum > 0 ? `${toCallNum} CT` : ''}
                  </button>
                )}

                <button
                  type="button" onClick={handleOpenRaise}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70 }}
                >
                  {facingBet ? 'Raise' : 'Bet'}
                </button>

                <button
                  type="button" onClick={handleAllIn}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70, color: '#f59e0b' }}
                >
                  All In
                </button>
              </>
            )}

            {/* settled: NEXT HAND + WALK AWAY */}
            {phase === 'settled' && (
              <>
                {/* revealedSeed gate (like walkAwayLocked): after Walk Away
                    cashes out, the 1500ms auto-close timer is armed. Without
                    this gate, Next Hand→Deal inside that window opens a FRESH
                    buy-in whose deal response the timer's handleClose then
                    epoch-drops — orphaning an in-progress hand server-side and
                    stranding the new buy-in (no resync endpoint yet). */}
                <button
                  type="button" onClick={handleNextHand}
                  disabled={inFlight || Boolean(revealedSeed)}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, minWidth: 110 }}
                >
                  Next Hand
                </button>
                {/* Crimson WALK AWAY — explicit bg+fg (No-Dark-Text-On-Dark-Panel). */}
                <button
                  type="button" onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked}
                  style={{
                    height: 40, fontSize: 12, fontWeight: 600,
                    fontFamily: 'var(--pt-data)', letterSpacing: '0.06em',
                    paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                    border: 'none', background: '#dc2626', color: '#ffffff',
                    cursor: walkAwayLocked ? 'not-allowed' : 'pointer', transition: 'background 0.15s',
                    opacity: walkAwayLocked ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#b91c1c'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626'; }}
                >
                  {isAuthed ? 'Walk Away' : 'Close'}
                </button>
              </>
            )}
          </div>

          {/* Footer line */}
          <div style={{
            fontSize: 9, color: 'rgba(100,180,130,0.45)',
            fontFamily: 'var(--pt-data)', letterSpacing: '0.12em',
            textAlign: 'right',
          }}>
            PHASE 6.5.1 · SERVER-AUTHORITATIVE · PROVABLY FAIR · {agentMode.toUpperCase()} MODE
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div role="status" aria-live="polite" className={toastClass}>
          {toast.message}
        </div>
      )}

      {/* Fairness tooltip */}
      {fairnessOpen && (
        <div
          role="dialog" aria-modal="true" aria-label="Provably fair commitment"
          onClick={() => setFairnessOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10001,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(6, 46, 59, 0.78)', padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="pt-fairness-modal">
            <div className="pt-fairness-eyebrow">Provably Fair</div>
            <div className="pt-fairness-title">Commitment &amp; Reveal</div>
            <p style={{ margin: '0 0 14px 0', color: 'var(--pt-cream-soft)' }}>
              Before any hand is dealt, the server publishes <code>sha256(serverSeed)</code> as a
              commitment. Each hand shuffles a fresh 52-card deck derived from
              <code> (serverSeed, clientSeed, handIndex)</code> and the bots play deterministically —
              the server cannot change the cards or the bots after seeing your decisions. The seed is
              revealed when you walk away so you can replay every hand.
            </p>
            <div style={{ display: 'grid', gap: 8, fontSize: 12, fontFamily: 'var(--pt-data)' }}>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Server seed hash: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {table?.serverSeedHash ?? '— (no table open yet)'}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Client seed: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {table?.clientSeed ?? '—'}
                </span>
              </div>
              {revealedSeed ? (
                <div>
                  <span style={{ color: 'var(--pt-amber)' }}>Revealed server seed: </span>
                  <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>{revealedSeed}</span>
                </div>
              ) : (
                <div style={{ color: 'var(--pt-cream-soft)' }}>
                  Server seed reveals when you walk away — then replay any hand at /cove/history.
                </div>
              )}
            </div>
            <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <a
                href="/cove/history" target="_blank" rel="noopener noreferrer"
                className="pt-btn pt-btn-ghost"
                style={{ padding: '0 14px', height: 36, fontSize: 11, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
              >
                Game history &amp; verifier →
              </a>
              <button type="button" onClick={() => setFairnessOpen(false)}
                className="pt-btn pt-btn-ghost"
                style={{ padding: '0 14px', height: 36, fontSize: 11 }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentModeBar — Control vs Autonomous toggle + read-only advisor surface.
//
// FEATURE_GATE: holdem_autonomous_agent_mode
// Status: UI seam only — the Control/Autonomous toggle + advisor display panel
//   are rendered, but the connected-agent WebSocket protocol that would drive
//   Autonomous mode (or feed Control-mode advisor hints) does NOT exist yet.
//   Autonomous is rendered disabled; the advisor panel shows a placeholder.
// Metric to graduate: ≥ 1 connected agent completing a Hold'em hand via the WS
//   protocol in a 7-day window (event: cove.holdem.agent.hand.settled).
// Current reading: 0 (protocol not shipped — Phase 6.5.2).
// Review deadline: 2026-07-15
// On deadline: if the WS protocol has not shipped, DELETE the Autonomous radio
//   + advisor panel and keep Control-only until the protocol lands.
// Reference: GameFeatures.md §18b (Hold'em agent modes) + CLAUDE.md three-surface rule.
//
// SEAM (Phase 6.5.2): a connected-agent WS client would, in Control mode, push
//   strategy hints into `advisorMessages` WITHOUT ever submitting a decision —
//   the human's buttons stay the only decision channel. In Autonomous mode the
//   same WS client would submit /action calls on the agent's behalf. Neither
//   path is wired here.
// ---------------------------------------------------------------------------
function AgentModeBar({ mode, onMode, advisorMessages }: {
  mode: AgentMode;
  onMode: (m: AgentMode) => void;
  advisorMessages: AdvisorMessage[];
}) {
  return (
    <div style={{
      flexShrink: 0, background: 'rgba(0,0,0,0.28)',
      borderBottom: '1px solid rgba(60,180,120,0.18)', padding: '8px 16px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          fontSize: 9, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
          letterSpacing: '0.16em', textTransform: 'uppercase',
        }}>
          Mode
        </span>
        <div role="radiogroup" aria-label="Agent mode" style={{ display: 'flex', gap: 6 }}>
          <button
            type="button" role="radio" aria-checked={mode === 'control'}
            onClick={() => onMode('control')}
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--pt-data)',
              fontWeight: mode === 'control' ? 700 : 400, cursor: 'pointer',
              border: mode === 'control' ? '1.5px solid var(--pt-amber)' : '1.5px solid rgba(160,140,100,0.3)',
              background: mode === 'control' ? 'rgba(200,150,50,0.18)' : 'rgba(10,30,20,0.5)',
              color: mode === 'control' ? 'var(--pt-amber)' : 'var(--pt-cream-soft)',
            }}
          >
            Control
          </button>
          <button
            type="button" role="radio" aria-checked={mode === 'autonomous'}
            disabled
            title="Autonomous agent mode arrives with the connected-agent protocol (Phase 6.5.2)"
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--pt-data)',
              cursor: 'not-allowed', opacity: 0.5,
              border: '1.5px solid rgba(160,140,100,0.3)',
              background: 'rgba(10,30,20,0.5)', color: 'var(--pt-cream-soft)',
            }}
          >
            Autonomous (soon)
          </button>
        </div>
        <span style={{
          marginLeft: 'auto', fontSize: 9, fontFamily: 'var(--pt-data)',
          color: 'var(--pt-mute)', letterSpacing: '0.06em',
        }}>
          {mode === 'control' ? 'You decide · agent advises' : 'Agent decides'}
        </span>
      </div>

      {/* Advisor surface — read-only display channel, NEVER a decision input. */}
      <div style={{
        background: 'rgba(10,22,40,0.55)', border: '1px solid rgba(60,180,180,0.18)',
        borderRadius: 6, padding: '6px 10px', minHeight: 26, maxHeight: 64,
        overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3,
      }}>
        {advisorMessages.length === 0 ? (
          <span style={{ fontSize: 10, color: 'var(--pt-cream-soft)', fontFamily: 'var(--pt-data)', fontStyle: 'italic' }}>
            Advisor: connect an agent to get pot-odds + range hints here (read-only — your taps stay the decision). Coming in Phase 6.5.2.
          </span>
        ) : (
          advisorMessages.map((m) => (
            <span key={m.id} style={{ fontSize: 10, color: 'var(--pt-cream)', fontFamily: 'var(--pt-data)' }}>
              <span style={{ color: 'var(--pt-cyan, #6fe6ff)' }}>Advisor:</span> {m.text}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
