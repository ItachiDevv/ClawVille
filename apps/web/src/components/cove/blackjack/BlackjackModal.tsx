'use client';

/**
 * BlackjackModal — Phase 6.4.1 AUTHORITATIVE engine client.
 *
 * Replaces the 6.4.0 client-side mock (mulberry32 deck + local payouts). Every
 * card, total, outcome, and balance now comes from the server
 * (`/api/cove/blackjack/*`) — the client sends ONLY its decision + bet and
 * renders the response verbatim. There is NO client-side deck, NO client-side
 * payout math, NO local outcome resolution. Mirrors how SlotScreenModal drives
 * the cove-slots route.
 *
 * Flow:
 *   open  → GET /session/current (restore an open shoe) else lazy POST
 *           /session/open on first Deal.
 *   deal  → POST /hand/deal {shoeId, bet, insurance}. Natural settles inline
 *           (dealtImmediately). 409 {reshuffled} → open a fresh shoe + retry.
 *   act   → POST /action {handId, action, handSlot} per HIT/STAND/DOUBLE/
 *           SPLIT/SURRENDER; insurance via POST /action {action:'insure'}
 *           BEFORE any main-hand action (offered only on a dealer-Ace upcard).
 *   close → POST /session/close (Lucia auth) reveals serverSeed for replay.
 *
 * Idempotency: a fresh UUID is minted per Deal press and per terminal action
 * press, reused on retry within that press (mirrors slots). A synchronous
 * `busyRef` lock blocks double-fire before the first await.
 *
 * Agent modes (Phase 6.4.1 UI seam only):
 *   - Control     — the human taps the action buttons. A connected agent acts
 *                   as an ADVISOR: it posts advice text into the advisor panel
 *                   and NEVER submits a decision. (Advisor wiring is a clean
 *                   seam for Phase 6.4.2 — see SEAM markers.)
 *   - Autonomous  — a connected agent makes the decisions. Disabled until the
 *                   connected-agent WebSocket protocol ships (FEATURE_GATE).
 *
 * Iris Xe safe: pure React/CSS DOM, zero Three.js. No drei Text/Billboard,
 * no InstancedMesh. No-dark-text-on-dark-panel: light tokens only on the dark
 * felt/velvet (cream / amber / explicit hex; never gray/slate-700+).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsGuest } from '@/hooks/use-is-guest';
import BlackjackCard from './BlackjackCard';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import '@/styles/cove-tokens.css';
import {
  COVE_BLACKJACK_MIN_BET,
  COVE_BLACKJACK_MAX_BET,
} from '@/lib/cove/blackjack-types';
import type {
  BlackjackCard as BJCard,
  SerializedBlackjackHandResult,
  SerializedPlayerHand,
} from '@/lib/cove/blackjack-types';
import {
  AgentDriverUnavailableError,
  AgentUndecidedError,
  CoveApiError,
  describeBlackjackError,
  fetchAgentBlackjackDecision,
  fetchCurrentBlackjackShoe,
  fetchCurrentBlackjackHand,
  isActionInProgress,
  isCurrentHandLive,
  isSettled,
  reshuffledBody,
  useBlackjackAction,
  useCloseBlackjackShoe,
  useDealHand,
  useOpenBlackjackShoe,
  useTakeInsurance,
  type ActionResponse,
  type AgentDecisionAction,
  type BlackjackShoeWire,
  type CurrentHandLive,
  type CurrentHandResponse,
  type DealResponse,
  type SettledHandResponse,
} from '@/lib/cove/blackjack-api-client';
import {
  BlackjackRevealEpoch,
  buildBlackjack2dBannerText,
  buildNaturalHoleHand,
  mergeBlackjack2dActionHand,
  useBlackjack2dPublisher,
  type Blackjack2dDisplayStep,
} from '@/lib/cove/blackjack-2d-publisher';

// ---------------------------------------------------------------------------
// Bet chips — must stay within engine bounds (5–500 CT).
// ---------------------------------------------------------------------------
const BET_STEPS = [5, 25, 50, 100, 250, 500] as const;
type BetStep = (typeof BET_STEPS)[number];

function BetChip({ value, selected, disabled, onClick }: {
  value: BetStep;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        border: selected ? '1.5px solid var(--pt-amber)' : '1.5px solid rgba(160,140,100,0.35)',
        background: selected ? 'rgba(200,150,50,0.18)' : 'rgba(10,30,20,0.6)',
        color: selected ? 'var(--pt-amber)' : 'var(--pt-cream-soft)',
        fontFamily: 'var(--pt-data)',
        fontWeight: selected ? 700 : 400,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'border-color 0.15s, background 0.15s',
        letterSpacing: '0.04em',
        flexShrink: 0,
      }}
    >
      {value}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Outcome banner — driven entirely by the server-settled result.
// ---------------------------------------------------------------------------
function OutcomeBanner({
  outcome,
  bannerText,
  net,
  rake,
}: {
  outcome: SerializedBlackjackHandResult;
  bannerText: string;
  net: bigint;
  rake: bigint;
}) {
  const isWin = outcome.playerHands.some(
    (hand) => hand.outcome === 'blackjack' || hand.outcome === 'win',
  );
  const isPush = outcome.playerHands.every((hand) => hand.outcome === 'push');
  const isSurrender = outcome.playerHands.every((hand) => hand.outcome === 'surrender');
  const accent =
    isWin ? 'var(--pt-amber-glow)' :
    isPush ? 'var(--pt-cream-soft)' :
    isSurrender ? '#d6a14a' :
    '#e85555';
  const netNum = Number(net);
  return (
    <div
      role="status"
      aria-live="assertive"
      data-testid="bj-outcome-banner"
      data-banner-text={bannerText}
      style={{
        // IN-FLOW between the dealer and player rows — never absolute over the
        // card strips. The old absolute top-38% placement sat ON the dealer row
        // and covered every dealer card past the third (a 4-card dealer bust
        // showed "26 BUST" with the bust card hidden under the banner).
        position: 'relative',
        zIndex: 2,
        alignSelf: 'center',
        pointerEvents: 'none',
        animation: 'bj-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
        textAlign: 'center',
      }}
    >
      <style>{`
        @keyframes bj-banner-in {
          from { opacity: 0; transform: scale(0.85); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div style={{
        background: 'var(--pt-velvet)',
        border: `2px solid ${accent}`,
        // Compact — the banner is in-flow now, so its height pushes the player
        // row down; keep it short enough that both rows + banner fit at 720p.
        padding: '7px 24px',
        boxShadow: `0 0 28px ${accent}55, 0 0 56px ${accent}22`,
        minWidth: 180,
      }}>
        <div style={{
          color: accent,
          fontSize: 11,
          fontFamily: 'var(--pt-data)',
          letterSpacing: '0.2em',
          fontWeight: 700,
          marginBottom: 3,
        }}>
          {bannerText}
        </div>
        <div
          data-testid="bj-banner-net"
          style={{
            color: netNum > 0
              ? 'var(--pt-cream)'
              : netNum < 0
                ? '#e85555'
                : 'var(--pt-cream-soft)',
            fontSize: 20,
            fontWeight: 700,
            fontFamily: 'var(--pt-display)',
            lineHeight: 1,
          }}
        >
          {netNum > 0 ? `+${netNum}` : `${netNum}`} vCLAW
        </div>
        {rake > 0n && (
          <div style={{
            marginTop: 4, fontSize: 10, fontFamily: 'var(--pt-data)',
            color: 'var(--pt-brass)', letterSpacing: '0.04em',
          }}>
            {Number(rake)} vCLAW rake kept
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand display — renders cards + a server-or-display total.
// ---------------------------------------------------------------------------
function HandRow({ label, cards, totalLabel, highlight }: {
  label: string;
  cards: BJCard[];
  totalLabel?: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        fontSize: 10,
        fontFamily: 'var(--pt-data)',
        color: highlight ? 'var(--pt-amber)' : 'var(--pt-mute)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>{label}</span>
        {totalLabel && (
          <span style={{ color: 'var(--pt-cream-soft)', fontSize: 11, fontWeight: 600 }}>
            {totalLabel}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {cards.map((card, i) => (
          <BlackjackCard key={i} card={card} slideIn delay={i * 70} />
        ))}
        {cards.length === 0 && (
          <div style={{
            width: 52, height: 76, borderRadius: 6,
            border: '1.5px dashed rgba(120,200,180,0.2)', opacity: 0.4,
          }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display-only running total of visible cards (UX hint while mid-hand).
// The AUTHORITATIVE total/outcome always comes from the server response —
// this is purely a "what am I looking at" helper, never used for money.
// ---------------------------------------------------------------------------
function displayTotal(cards: BJCard[]): { total: number; isSoft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.hidden) continue;
    if (c.rank === 'A') { aces++; total += 1; }
    else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J' || c.rank === '10') total += 10;
    else total += parseInt(c.rank, 10);
  }
  let isSoft = false;
  if (aces > 0 && total + 10 <= 21) { total += 10; isSoft = true; }
  return { total, isSoft };
}

// ---------------------------------------------------------------------------
// Toast (modal-local)
// ---------------------------------------------------------------------------
type ToastTone = 'info' | 'warn' | 'error';
interface ToastState { message: string; tone: ToastTone; id: number; }

// ---------------------------------------------------------------------------
// Agent mode
//   - control     — the human taps; a connected agent advises read-only.
//   - autonomous  — a connected agent decides; the human keeps a veto window.
// ---------------------------------------------------------------------------
type AgentMode = 'control' | 'autonomous';
interface AdvisorMessage { id: number; text: string; }

// ── Autonomous-mode human-input window ([cards] spec msg 8) ────────────────
// The agent WAITS this long after a decision point before it auto-applies its
// decision, so a human can always step in. The base wait is 8s; if the human
// is actively steering with the keyboard the wait extends to 15s. Any human
// action (a button tap that changes phase, or closing the modal) cancels the
// pending auto-apply outright.
const AGENT_DECISION_WAIT_BASE_MS = 8000;
const AGENT_DECISION_WAIT_KEYBOARD_MS = 15000;
// How recent a keypress must be to count as "actively steering".
const KEYBOARD_ACTIVE_WINDOW_MS = 5000;
// Keys that count as movement steering (WASD + arrows). Matches the open-world
// keyboard movement set so "moving on the keyboard" means the same thing here.
const MOVEMENT_KEYS = new Set([
  'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
// Pause between a settled hand and the agent auto-dealing the next one.
const AGENT_NEXT_HAND_PAUSE_MS = 2200;

function waitForCommittedPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

// ── In-modal Autonomous availability ───────────────────────────────────────
// The in-modal, human-supervised Autonomous driver below is LIVE: it asks the
// human's connected agent for a decision via the
// `POST /api/cove/blackjack/agent/decide` relay (shipped on the cove router —
// resolves the human's bound connected agent and queries its runtime), then
// applies the returned verb through the same server-authoritative deal/action
// endpoints after the 8s/15s human-veto window. Enabled only when an agent is
// connected (autonomousEnabled also gates on agentConnected). Honest boundary:
// self-managed nanoclaw agents decide client-side and cannot be push-asked, so
// the relay returns 503 agent_unavailable for them and the driver degrades to
// Control with a clear notice (NOT a crash). The separate, also-live autonomous
// path is the agent playing entirely from its OWN runtime via the session-bound
// cove tools (cove_blackjack_*), which needs no browser driver.
const AUTONOMOUS_RELAY_LIVE = true;

// ---------------------------------------------------------------------------
// Local in-progress hand view (built from server responses only)
// ---------------------------------------------------------------------------
interface SubHandView {
  cards: BJCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  /**
   * Server-authoritative per-sub-hand terminal flag (FROZEN WIRE CONTRACT). True
   * for stood-21 / doubled-no-bust / surrendered / split-ace as well as bust —
   * the client CANNOT derive these from cards/total/isBust (a stood-21 and a live
   * 21 are byte-identical on the wire). Used to focus a LIVE split sub-hand and to
   * gate the action buttons so a stale focus can't fire a doomed `400
   * sub_hand_already_terminal`. A fresh deal's single sub-hand is `false`.
   */
  isResolved: boolean;
}
interface HandView {
  handId: string;
  shoeId: string;
  handIndex: number | null;
  /** Player sub-hands (1 normally, 2 after split). */
  playerHands: SubHandView[];
  dealerUpcard: BJCard | null;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  didSplit: boolean;
  bet: number;
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function BlackjackModal() {
  const {
    blackjackOpen,
    blackjackBet,
    closeBlackjackTable,
    setBlackjackBet,
  } = useCoveStore();

  const { data: avatar } = useAvatar();

  // ── Server-mirrored state ────────────────────────────────────────────────
  const [shoe, setShoe] = useState<BlackjackShoeWire | null>(null);
  const [balance, setBalance] = useState(0);
  const [liveHand, setLiveHand] = useState<HandView | null>(null);
  const [pendingSettlement, setPendingSettlement] =
    useState<SettledHandResponse | null>(null);
  const [displayStep, setDisplayStep] =
    useState<Blackjack2dDisplayStep>('idle');
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  // ── Connected-agent presence (drives Autonomous availability) ────────────
  // A connected agent is what makes Autonomous mode real — without one, the
  // browser has no agent to ask for a decision, so the radio stays disabled.
  const agentConnected = useGameStore((s) => s.agentConnected);

  // ── Agent mode + advisor surface ─────────────────────────────────────────
  const [agentMode, setAgentMode] = useState<AgentMode>('control');
  const [advisorMessages, setAdvisorMessages] = useState<AdvisorMessage[]>([]);
  const advisorSeqRef = useRef(0);

  // ── Autonomous-driver state ──────────────────────────────────────────────
  // `agentPending` is the human-veto countdown: the agent has chosen, and we
  // are waiting AGENT_DECISION_WAIT_* before applying so a human can step in.
  const [agentPending, setAgentPending] = useState<{
    action: AgentDecisionAction;
    amount?: number;
    /** Server-authoritative target hand/slot for the apply (relay-derived). */
    handId?: string | null;
    handSlot?: 0 | 1;
    /**
     * Stale-decision guard: the hand version the agent decided at (relay-derived,
     * null for `deal`/no live hand). Threaded to /action as expectedHandVersion so
     * a human tap that advanced the hand mid-window rejects this stale apply.
     */
    handVersion?: number | null;
    /**
     * Stale-DEAL guard: the shoe epoch (handCounter) the agent decided at
     * (relay-derived, set only for `deal`). Threaded to /hand/deal as
     * expectedHandsPlayed so a deal that lands after an intervening human deal
     * rejects this stale apply (409 stale_agent_deal).
     */
    expectedHandsPlayed?: number | null;
    deadline: number;
  } | null>(null);
  // True while a decision is being applied (so we don't double-fire).
  const agentBusyRef = useRef(false);
  // Last movement keypress timestamp — extends the wait window to 15s.
  const lastKeyMoveRef = useRef(0);
  // If the relay 404/501s once, stop trying for the rest of this sit-down.
  const [agentDriverUnavailable, setAgentDriverUnavailable] = useState(false);
  // Monotonic token so a stale in-flight decision can't apply after the phase
  // moved on or the human took over.
  const agentRunRef = useRef(0);

  // ── API hooks ─────────────────────────────────────────────────────────────
  const openShoe = useOpenBlackjackShoe();
  const dealHand = useDealHand();
  const action = useBlackjackAction();
  const takeInsurance = useTakeInsurance();
  const closeShoe = useCloseBlackjackShoe();

  // ── Refs ──────────────────────────────────────────────────────────────────
  const busyRef = useRef(false);                  // synchronous double-fire lock
  // F4 (2026-06-22): handIds we have already settled this session. A stale
  // GET /hand/current restore — read in the server's commit→settle window where a
  // busted hand is momentarily status='in_progress' AND terminal — must NOT
  // overwrite a hand we already settled and re-strand the player in player-turn on
  // a terminal hand with no legal action and no Next Hand button (the founder's
  // "bust shows but the table is stuck" freeze). Closes the root-cause race.
  const settledHandIdsRef = useRef<Set<string>>(new Set());
  // One-shot guard so the stranded-hand self-heal fires at most once per handId.
  const healedHandIdRef = useRef<string | null>(null);
  const dealKeyRef = useRef<string | null>(null); // per-deal idempotency key
  const actionKeyRef = useRef<string | null>(null); // per-terminal-action key
  const toastSeqRef = useRef(0);
  const shoeRef = useRef<BlackjackShoeWire | null>(null);
  shoeRef.current = shoe;
  const parityInstanceIdRef = useRef(crypto.randomUUID());
  const revealEpochRef = useRef<BlackjackRevealEpoch | null>(null);
  if (!revealEpochRef.current) {
    revealEpochRef.current = new BlackjackRevealEpoch();
  }

  const hand = liveHand;
  const settled = pendingSettlement;

  // Hook must run unconditionally — a short-circuited call here would change
  // the hook order when the avatar query resolves after mount.
  const isGuestTier = useIsGuest();
  const isRealTier = Boolean(avatar) && !isGuestTier;
  const phase: 'idle' | 'revealing' | 'player-turn' | 'settled' =
    pendingSettlement
      ? displayStep === 'settled' ? 'settled' : 'revealing'
      : liveHand
        ? displayStep === 'player-turn' || displayStep === 'split'
          ? 'player-turn'
          : 'revealing'
        : 'idle';
  const bannerText = pendingSettlement
    ? buildBlackjack2dBannerText(pendingSettlement.outcome)
    : null;
  const paritySnapshot = useMemo(() => ({
    liveHand,
    pendingSettlement,
    displayStep,
    activeSlot,
    bannerText,
  }), [activeSlot, bannerText, displayStep, liveHand, pendingSettlement]);
  useBlackjack2dPublisher({
    open: blackjackOpen,
    instanceId: parityInstanceIdRef.current,
    snapshot: paritySnapshot,
  });

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

  const pushAdvisor = useCallback((text: string) => {
    advisorSeqRef.current += 1;
    setAdvisorMessages((prev) => [...prev.slice(-19), { id: advisorSeqRef.current, text }]);
  }, []);

  // ── Reset transient state ──────────────────────────────────────────────────
  const resetHand = useCallback(() => {
    revealEpochRef.current?.cancel();
    setLiveHand(null);
    setPendingSettlement(null);
    setDisplayStep('idle');
    setActiveSlot(0);
    dealKeyRef.current = null;
    actionKeyRef.current = null;
  }, []);

  // ── Rebuild the local hand view from the server's authoritative /hand/current ──
  // Shared by the eager-restore-on-open path (below) and the autonomous stale-409
  // resync. A live hand → show it so the player can FINISH it (server blocks a new
  // deal while a hand is in_progress, and the shoe can't be closed either — without
  // restoring the hand the player is soft-locked on the betting UI). A null result
  // (the prior hand settled) → clear. Read-only; no money, no ledger.
  //
  // `allowClear` (default true): the autonomous resync intends to CLEAR a settled
  // hand, so it keeps the default. The eager-restore-on-open path passes FALSE —
  // FINDING #1: the Deal button is tappable while the open effect awaits
  // /hand/current, and if a deal commits the in_progress row AFTER this GET hit
  // the server (returning {hand:null}) but BEFORE this resolves, an unconditional
  // setHand(null) would WIPE the just-dealt hand → server holds a hand the UI
  // doesn't show → next Deal 409s `hand_in_progress` (the exact soft-lock recurs).
  // On open there is nothing legitimate to clear (the hand was just reset to null),
  // so a null result must NOT wipe a hand the user dealt during the await.
  const restoreHandFromServer = useCallback((
    handRes: CurrentHandResponse | null,
    allowClear = true,
  ) => {
    if (!handRes) return;
    if (isCurrentHandLive(handRes)) {
      const live: CurrentHandLive = handRes;
      // F4 ROOT-CAUSE GUARD: ignore a "live" hand we already settled this session.
      // This is the stale read from the server's commit→settle window — acting on
      // it would clear `settled` and re-mount a terminal hand in player-turn, the
      // exact strand. The authoritative settle already landed via applySettled.
      if (settledHandIdsRef.current.has(live.handId)) return;
      const subHands: SubHandView[] = live.playerHands.map((h) => ({
        cards: h.cards,
        total: h.total,
        isSoft: h.isSoft,
        isBust: h.isBust,
        isResolved: h.isResolved,
      }));
      revealEpochRef.current?.begin(live.handId);
      setLiveHand({
        handId: live.handId,
        shoeId: live.shoeId,
        handIndex: live.handIndex,
        playerHands: subHands.length > 0 ? subHands : [{ cards: [], total: 0, isSoft: false, isBust: false, isResolved: false }],
        dealerUpcard: live.dealerUpcard,
        insuranceOffered: live.insuranceOffered,
        tookInsurance: live.tookInsurance,
        didSplit: live.didSplit,
        bet: Number(live.bet),
      });
      // Focus the first non-RESOLVED sub-hand for a split (mirrors merge). isBust
      // alone is wrong — a stood-21/doubled/split-ace slot is resolved yet not
      // bust, and focusing it routes actions to a terminal slot (400
      // sub_hand_already_terminal). Fall back to slot 1 when slot 0 is resolved.
      if (live.didSplit) {
        const firstLive = live.playerHands.findIndex((h) => !h.isResolved);
        setActiveSlot((firstLive === 1 ? 1 : 0) as 0 | 1);
      } else {
        setActiveSlot(0);
      }
      setPendingSettlement(null);
      setDisplayStep(live.didSplit ? 'split' : 'player-turn');
    } else if (allowClear) {
      // Server confirms NO in-progress hand (the prior hand settled) → clear.
      // Gated by allowClear so the eager-restore-on-open path can't wipe a hand
      // the user dealt during the await (FINDING #1).
      resetHand();
    }
  }, [resetHand]);

  // ── Eager restore on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!blackjackOpen) return;
    setBalance(avatar?.clawTokens ?? 0);
    setRevealedSeed(null);
    resetHand();
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentBlackjackShoe();
        if (cancelled || !current) return;
        if (current.shoe.status !== 'open') return;
        setShoe(current.shoe);
        setBalance(current.walletBalance);
        // ALSO restore an in-progress HAND, not just the shoe. Without this, a
        // player who dealt then closed/refreshed/reopened the modal lands on the
        // betting UI while the server still holds an in_progress hand — DEAL then
        // 409s `hand_in_progress` and the shoe can't be closed, a permanent
        // soft-lock. Restoring lets them play the hand out (Hit/Stand → settle →
        // shoe freed). Best-effort + read-only: a blip just leaves the shoe view.
        let resumedHand = false;
        try {
          const handRes = await fetchCurrentBlackjackHand();
          if (cancelled) return;
          // allowClear=false (FINDING #1): a {hand:null} result here must NOT wipe
          // a hand the user dealt while this GET was in flight — that re-creates
          // the soft-lock (server holds the dealt hand, UI shows none, next Deal
          // 409s hand_in_progress). On open the hand was just reset to null, so
          // there is nothing legitimate to clear.
          restoreHandFromServer(handRes, false);
          resumedHand = !!handRes && isCurrentHandLive(handRes);
        } catch (err) {
          // /hand/current blip — leave the betting UI; the player can still play.
          // NIT #2: a deterministic 5xx (e.g. hand_peek_failed) means the server
          // holds a hidden in_progress hand we couldn't restore — surface a real
          // error instead of the misleading "Resumed your open shoe." toast below.
          if (err instanceof CoveApiError && err.status >= 500) {
            showToast('Could not restore your hand. Refresh to retry.', 'warn');
          }
        }
        if (cancelled) return;
        showToast(resumedHand ? 'Resumed your hand in progress.' : 'Resumed your open shoe.', 'info');
      } catch {
        // Network blip — lazy-open on first Deal handles it.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blackjackOpen]);

  // ── Reset everything on close ──────────────────────────────────────────────
  useEffect(() => {
    if (!blackjackOpen) {
      setShoe(null);
      resetHand();
      setRevealedSeed(null);
      setAdvisorMessages([]);
      busyRef.current = false;
      // F4: bound the settled-hand set + reset the self-heal guard per session-open.
      settledHandIdsRef.current.clear();
      healedHandIdRef.current = null;
      // Autonomous-driver teardown — cancel any pending auto-apply + reset the
      // run token so a stale in-flight decision can't fire after re-open.
      setAgentPending(null);
      setAgentMode('control');
      setAgentDriverUnavailable(false);
      agentBusyRef.current = false;
      agentRunRef.current += 1;
    }
  }, [blackjackOpen, resetHand]);

  useEffect(() => () => {
    revealEpochRef.current?.cancel();
  }, []);

  // Advance only from a committed display snapshot. Scheduling inside the
  // async action/deal callback races the modal-open restore effect; that
  // restore can invalidate the epoch after the response arrives and leave the
  // DOM pinned on `hole`. Each committed step owns exactly one next-step timer.
  useEffect(() => {
    const correlation = pendingSettlement?.handId ?? liveHand?.handId ?? null;
    if (!blackjackOpen || !correlation) return;
    const epoch = revealEpochRef.current;
    if (!epoch?.isCurrent(correlation)) return;

    if (!pendingSettlement && displayStep === 'hole') {
      const timer = window.setTimeout(() => {
        if (!epoch.isCurrent(correlation)) return;
        setDisplayStep('player-turn');
      }, 120);
      return () => window.clearTimeout(timer);
    }

    if (!pendingSettlement && displayStep === 'split') {
      const timer = window.setTimeout(() => {
        if (!epoch.isCurrent(correlation)) return;
        setDisplayStep('player-turn');
      }, 120);
      return () => window.clearTimeout(timer);
    }

    if (pendingSettlement && displayStep === 'hole') {
      const timer = window.setTimeout(() => {
        if (!epoch.isCurrent(correlation)) return;
        setDisplayStep('dealer-reveal');
      }, 420);
      return () => window.clearTimeout(timer);
    }

    if (pendingSettlement && displayStep === 'dealer-reveal') {
      const timer = window.setTimeout(() => {
        if (!epoch.isCurrent(correlation)) return;
        setDisplayStep('settled');
        setActiveSlot(0);
        setBalance(pendingSettlement.balance);
      }, 550);
      return () => window.clearTimeout(timer);
    }
  }, [blackjackOpen, displayStep, liveHand?.handId, pendingSettlement]);

  // ── Force back to Control if the agent disconnects mid-session ──────────────
  // Autonomous has no decision source without a connected agent, so drop the
  // human back into Control rather than stranding a dead table.
  useEffect(() => {
    if (!agentConnected && agentMode === 'autonomous') {
      setAgentMode('control');
      setAgentPending(null);
      agentRunRef.current += 1;
      showToast('Agent disconnected. Back to Control mode.', 'warn');
    }
  }, [agentConnected, agentMode, showToast]);

  // ── Keyboard-movement detector (extends the auto-decide window 8s→15s) ─────
  // Only while the modal is open + autonomous. A movement keypress marks the
  // human as "actively steering" so the agent waits the longer window.
  useEffect(() => {
    if (!blackjackOpen || agentMode !== 'autonomous') return;
    const onMoveKey = (e: KeyboardEvent) => {
      if (MOVEMENT_KEYS.has(e.key)) lastKeyMoveRef.current = Date.now();
    };
    window.addEventListener('keydown', onMoveKey);
    return () => window.removeEventListener('keydown', onMoveKey);
  }, [blackjackOpen, agentMode]);

  // ── Close handler ───────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    // Fire-and-forget close any open shoe (authed only — guests have no close
    // endpoint). Skip if a hand is in progress (server would 409) or a request
    // is in flight (avoid racing the settle lock).
    const s = shoeRef.current;
    if (s && s.status === 'open' && isRealTier && !hand && !busyRef.current && !revealedSeed) {
      closeShoe.mutate({ shoeId: s.id });
    }
    closeBlackjackTable();
  }, [isRealTier, hand, revealedSeed, closeShoe, closeBlackjackTable]);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!blackjackOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fairnessOpen) { setFairnessOpen(false); return; }
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blackjackOpen, fairnessOpen, handleClose]);

  // ── Open (or reuse) a shoe; returns the shoe or null on failure ────────────
  const ensureShoe = useCallback(async (): Promise<BlackjackShoeWire | null> => {
    if (shoeRef.current && shoeRef.current.status === 'open') return shoeRef.current;
    try {
      const opened = await openShoe.mutateAsync({ currency: 'clawtoken' });
      setShoe(opened.shoe);
      setBalance(opened.walletBalance);
      return opened.shoe;
    } catch (err) {
      showToast(describeBlackjackError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
      return null;
    }
  }, [openShoe, showToast]);

  // ── Apply a settled response (single place balance/outcome land) ───────────
  const applySettled = useCallback((
    res: SettledHandResponse,
    source: 'deal' | 'action',
  ) => {
    // F4: remember this hand is settled so a late/stale /hand/current restore
    // (server commit→settle window) can never re-seed it as a live player-turn hand.
    settledHandIdsRef.current.add(res.handId);
    revealEpochRef.current?.begin(res.handId);
    setPendingSettlement(res);
    setLiveHand(buildNaturalHoleHand(res));
    setActiveSlot(0);
    if (source === 'deal' && res.dealtImmediately) {
      setDisplayStep('hole');
    } else {
      setDisplayStep('dealer-reveal');
    }
    // Reflect the shoe's new dealtCount locally so the next deal's penetration
    // gate + fairness HUD are accurate without a refetch.
    setShoe((prev) => (prev ? { ...prev, dealtCount: res.dealtCount } : prev));
    if (res.reshuffleSuggested) {
      showToast('Shoe nearly spent. The next deal opens a fresh shoe.', 'info');
    }
    // SEAM: in Control mode an advisor could comment on the result here.
  }, [showToast]);

  // ── Build a HandView from a deal in-progress response ──────────────────────
  const handViewFromDeal = useCallback((res: Extract<DealResponse, { status: 'in_progress' }>): HandView => {
    const opening = res.playerHand;
    const t = displayTotal(opening);
    return {
      handId: res.handId,
      shoeId: res.shoeId,
      handIndex: res.handIndex,
      // A fresh deal's single sub-hand is always live (the player hasn't acted yet,
      // and a dealt natural settles inline via isSettled, never reaching here).
      playerHands: [{ cards: opening, total: t.total, isSoft: t.isSoft, isBust: false, isResolved: false }],
      dealerUpcard: res.dealerUpcard,
      insuranceOffered: res.insuranceOffered,
      tookInsurance: res.tookInsurance,
      didSplit: false,
      bet: Number(res.bet),
    };
  }, []);

  // ── Merge an in-progress action response into the HandView ─────────────────
  const mergeActionInProgress = useCallback((
    res: Extract<ActionResponse, { status: 'in_progress'; playerHands: unknown }>,
    sourceAction: 'hit' | 'stand' | 'double' | 'split' | 'surrender',
  ) => {
    revealEpochRef.current?.begin(res.handId);
    setPendingSettlement(null);
    setLiveHand((prev) => {
      if (!prev) return prev;
      return mergeBlackjack2dActionHand(prev, res);
    });
    setDisplayStep(sourceAction === 'split' ? 'split' : 'player-turn');
    // After a split, focus the first non-RESOLVED sub-hand. isBust alone is the
    // pre-existing live-split bug — a stood-21/doubled/split-ace slot is resolved
    // yet not bust, so focusing it routes the next action to a terminal slot (400
    // sub_hand_already_terminal). Fall back to slot 1 when slot 0 is resolved.
    if (res.didSplit) {
      const firstLive = res.playerHands.findIndex((h) => !h.isResolved);
      setActiveSlot((firstLive === 1 ? 1 : 0) as 0 | 1);
    }
  }, []);

  // ── Re-sync live state after a stale agent 409 (concurrency BLOCKING fix) ──
  // When /action (stale_agent_decision) or /hand/deal (stale_agent_deal) 409s
  // because the hand/shoe advanced since the agent decided, the agent's apply is
  // discarded. Before the NEXT autonomous loop we re-derive the AUTHORITATIVE
  // state from the server, never guess from the stale local view:
  //   1. refetch the shoe (dealtCount, balance) so the penetration gate + HUD are
  //      fresh;
  //   2. fetch the server's in-progress hand via GET /hand/current and RESTORE it
  //      if one exists, or CLEAR the local hand only when the server confirms NO
  //      live hand (the prior hand truly settled).
  // The earlier version cleared the local hand on a handId match but only
  // refetched the shoe — so when the server still had an in_progress hand the
  // modal stranded in idle and the autonomous loop spun (runAction no-ops on
  // !hand; a deal 409s hand_in_progress). Restoring from /hand/current is correct
  // for ALL staleness sources (same-tab human takeover, deal-epoch race, external
  // races), not just same-tab takeover. Best-effort + non-fatal: a refetch blip
  // leaves the local hand as-is and the next /agent/decide re-derives server-side.
  // Authed-only (guests never run the autonomous relay).
  const resyncAfterStaleDecision = useCallback(async () => {
    try {
      const [shoeRes, handRes] = await Promise.all([
        fetchCurrentBlackjackShoe(),
        fetchCurrentBlackjackHand(),
      ]);
      if (shoeRes && shoeRes.shoe.status === 'open') {
        setShoe(shoeRes.shoe);
        setBalance(shoeRes.walletBalance);
      }
      // Authoritative hand reconciliation — restore a live server hand, or clear
      // when the server confirms none. A null result (no open shoe / network blip)
      // leaves the local hand untouched so we never strand on a transient miss; the
      // next /agent/decide corrects it server-side. Shared with eager-restore-on-open.
      restoreHandFromServer(handRes);
    } catch {
      // Network blip — leave local state as-is; the next /agent/decide re-derives
      // authoritative state server-side regardless.
    }
  }, [restoreHandFromServer]);

  // ── DEAL ────────────────────────────────────────────────────────────────────
  // `agentDriven` is set ONLY by the autonomous driver after the human-input
  // window elapses; a human tap leaves it false and is blocked in autonomous
  // mode (the agent owns the decision channel then).
  // `betOverride` lets the autonomous driver deal at the agent's chosen bet
  // WITHOUT depending on a `setBlackjackBet()` store round-trip landing first
  // (React state updates are async, so reading `blackjackBet` right after
  // setting it would use the stale value). Human deals omit it and use the
  // selected chip.
  // `expectedHandsPlayed` is the stale-agent-deal precondition (relay-supplied
  // shoe epoch); set ONLY by the autonomous driver. /hand/deal 409s
  // `stale_agent_deal` if a hand was opened since the agent decided, so a stale
  // agent deal can't open an extra hand after an intervening human deal. Human
  // taps omit it (unconditional). Discarded on a reshuffle-retry (the fresh shoe
  // has its own epoch the agent never decided against).
  const handleDeal = useCallback(async (
    agentDriven = false,
    betOverride?: number,
    expectedHandsPlayed?: number,
  ) => {
    if (busyRef.current || phase !== 'idle') return;
    // Human tap in autonomous mode = take over THIS decision: void the agent's
    // queued decision (bump the run token so a late timer can't fire) and play
    // the human's choice instead.
    if (agentMode === 'autonomous' && !agentDriven) {
      agentRunRef.current += 1;
      setAgentPending(null);
    }
    busyRef.current = true;
    try {
      const s = await ensureShoe();
      if (!s) return;
      if (!dealKeyRef.current) dealKeyRef.current = crypto.randomUUID();

      // The agent's bet (clamped) wins when driven; otherwise the chip value.
      const betForHand = typeof betOverride === 'number'
        ? Math.max(COVE_BLACKJACK_MIN_BET, Math.min(COVE_BLACKJACK_MAX_BET, Math.round(betOverride)))
        : blackjackBet;
      const wantInsurance = false; // insurance is taken AFTER the upcard shows
      let res: DealResponse;
      try {
        res = await dealHand.mutateAsync({
          shoeId: s.id,
          bet: betForHand,
          insurance: wantInsurance,
          idempotencyKey: dealKeyRef.current,
          // Only the agent-driven deal carries the stale-deal precondition; human
          // taps omit it so /hand/deal stays unconditional for them.
          ...(agentDriven && expectedHandsPlayed !== undefined
            ? { expectedHandsPlayed }
            : {}),
        });
      } catch (err) {
        // 75% penetration → open a fresh shoe (new seed pair) + retry once. The
        // fresh shoe has its OWN epoch the agent never decided against, so the
        // retry deal MUST omit expectedHandsPlayed (the original epoch is stale).
        if (reshuffledBody(err)) {
          showToast('Shoe reshuffled. Dealing from a fresh shoe.', 'info');
          setShoe(null);
          const fresh = await ensureShoe();
          if (!fresh) return;
          dealKeyRef.current = crypto.randomUUID();
          res = await dealHand.mutateAsync({
            shoeId: fresh.id,
            bet: betForHand,
            insurance: wantInsurance,
            idempotencyKey: dealKeyRef.current,
          });
        } else {
          throw err;
        }
      }

      if (isSettled(res)) {
        applySettled(res, 'deal'); // natural settled inline
      } else {
        revealEpochRef.current?.begin(res.handId);
        setPendingSettlement(null);
        setLiveHand(handViewFromDeal(res));
        setDisplayStep('hole');
        setActiveSlot(0);
        // Stake is committed at deal (finding #3) — reflect the debited balance
        // in the HUD immediately if the server returned it.
        if (typeof res.balance === 'number') setBalance(res.balance);
      }
    } catch (err) {
      // Stale agent DEAL (409): an intervening human deal opened a hand since the
      // agent decided (possibly natural-settled inline), so the server rejected
      // this stale in-flight agent deal. Discard silently — same as a skipped
      // turn — refetch the live shoe, and stay in Autonomous so the next decision
      // point re-asks against fresh state. Never crash, never blind-retry.
      if (
        agentDriven && err instanceof CoveApiError &&
        err.status === 409 && err.code === 'stale_agent_deal'
      ) {
        void resyncAfterStaleDecision();
        pushAdvisor('You dealt this hand; the agent stood down. Still in Autonomous.');
      } else {
        showToast(describeBlackjackError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
      }
    } finally {
      dealKeyRef.current = null;
      busyRef.current = false;
    }
  }, [phase, agentMode, ensureShoe, dealHand, blackjackBet, showToast, applySettled, handViewFromDeal, resyncAfterStaleDecision, pushAdvisor]);

  // ── INSURANCE (before any main-hand action; dealer-Ace only) ───────────────
  // Parity with runAction: the agent driver passes the relay's server-authoritative
  // target hand (`handIdOverride`) + the `expectedHandVersion` it decided at, so a
  // stale agent insure that races a human takeover (or an already-settled hand) is
  // rejected/replayed server-side instead of being mis-applied to a stale local
  // view. Human manual insure passes neither → /action stays unconditional and
  // targets the modal's own hand exactly as before.
  const handleInsure = useCallback(async (
    agentDriven = false,
    expectedHandVersion?: number,
    handIdOverride?: string | null,
  ) => {
    if (busyRef.current || !hand) return;
    // Human manual insure keeps the local-flag guard (no point firing a request the
    // local view already knows is invalid). The AGENT-DRIVEN path must NOT early-return
    // on stale local flags: the server is authoritative, so a genuinely-stale decision
    // has to reach takeInsurance.mutateAsync to get a 409 stale_agent_decision back —
    // the catch below then resyncs + re-asks. Dropping it silently here would strand the
    // agent on a stale view (the round-4 stale-decision contract, parity with runAction).
    if (hand.tookInsurance || !hand.insuranceOffered) {
      if (agentDriven) {
        void resyncAfterStaleDecision();
        pushAdvisor('Insurance is no longer available on this hand.');
      }
      return;
    }
    if (agentMode === 'autonomous' && !agentDriven) {
      agentRunRef.current += 1;
      setAgentPending(null);
    }
    const targetHandId = handIdOverride ?? hand.handId;
    busyRef.current = true;
    try {
      const res = await takeInsurance.mutateAsync({
        handId: targetHandId,
        // Only the agent-driven apply carries the stale-decision precondition;
        // human manual taps omit it so /action stays unconditional for them.
        ...(agentDriven && expectedHandVersion !== undefined
          ? { expectedHandVersion }
          : {}),
      });
      // A stale agent insure decision that raced an already-settled hand comes back
      // as a full settled-hand replay (status:'settled') — land it the same way the
      // main action path does, never as a phantom { tookInsurance } ack on a dead
      // hand. A live in-progress ack just flips the tookInsurance flag.
      if (isSettled(res)) {
        applySettled(res, 'action');
      } else {
        setLiveHand((prev) => (prev
          ? {
              ...prev,
              insuranceOffered: false,
              tookInsurance: res.tookInsurance,
            }
          : prev));
        setDisplayStep('player-turn');
        showToast('Insurance taken.', 'info');
        // The ACK is intentionally rendered/published first. Only after that paint
        // do we read the complete current-hand wire and publish its player-turn
        // revision (the insure ACK itself is card-free).
        await waitForCommittedPaint();
        try {
          const current = await fetchCurrentBlackjackHand();
          restoreHandFromServer(current, false);
        } catch {
          // Keep the truthful ACK state; the next action/resync remains authoritative.
        }
      }
    } catch (err) {
      // Stale agent decision (409): the human advanced the hand since the agent
      // decided to insure, so the server rejected this in-flight apply. DISCARD it
      // silently — same as the runAction path — re-derive the authoritative state,
      // and stay in Autonomous so the next decision point re-asks. Never crash.
      if (
        agentDriven && err instanceof CoveApiError &&
        err.status === 409 && err.code === 'stale_agent_decision'
      ) {
        void resyncAfterStaleDecision();
        pushAdvisor('You took over this hand; the agent stood down. Still in Autonomous.');
      } else {
        showToast(describeBlackjackError(err), 'warn');
      }
    } finally {
      busyRef.current = false;
    }
  }, [
    hand,
    agentMode,
    takeInsurance,
    showToast,
    applySettled,
    resyncAfterStaleDecision,
    pushAdvisor,
    restoreHandFromServer,
  ]);

  // ── ACTION (hit / stand / double / split / surrender) ──────────────────────
  const runAction = useCallback(async (
    act: 'hit' | 'stand' | 'double' | 'split' | 'surrender',
    agentDriven = false,
    slotOverride?: 0 | 1,
    expectedHandVersion?: number,
    handIdOverride?: string | null,
  ) => {
    if (busyRef.current || !hand) return;
    if (agentMode === 'autonomous' && !agentDriven) {
      agentRunRef.current += 1;
      setAgentPending(null);
    }
    // The agent driver passes the relay's server-authoritative slot; humans use
    // the focused slot. Avoids a stale-closure read of activeSlot in the driver.
    const slot = slotOverride ?? activeSlot;
    // Target the relay's SERVER-AUTHORITATIVE hand (concurrency minor a), not the
    // modal's possibly-stale local view. /agent/decide derives the in-progress
    // hand from the shoe and returns its id; applying to that id (with the
    // matching handVersion precondition) means the action lands on the hand the
    // agent actually decided for. Human taps pass no override → modal's hand.
    const targetHandId = handIdOverride ?? hand.handId;
    busyRef.current = true;
    // Terminal actions need a stable idempotency key reused across retries.
    const terminal = act === 'stand' || act === 'double' || act === 'surrender';
    if (terminal && !actionKeyRef.current) actionKeyRef.current = crypto.randomUUID();
    // A 'hit' that busts is terminal server-side, and 'split' creates two hands
    // that may each terminate — mint a key for any action so a settle that
    // arrives unexpectedly is still idempotent on retry.
    if (!actionKeyRef.current) actionKeyRef.current = crypto.randomUUID();
    try {
      const res = await action.mutateAsync({
        handId: targetHandId,
        action: act,
        handSlot: slot,
        idempotencyKey: actionKeyRef.current,
        // Only the agent-driven apply carries the stale-decision precondition;
        // human manual taps omit it so /action stays unconditional for them.
        ...(agentDriven && expectedHandVersion !== undefined
          ? { expectedHandVersion }
          : {}),
      });
      if (isSettled(res)) {
        applySettled(res, 'action');
        actionKeyRef.current = null;
      } else if (isActionInProgress(res)) {
        mergeActionInProgress(res, act);
        // A non-terminal continuation: clear the key so the NEXT terminal
        // action mints a fresh one (the key is per terminal settle, not per
        // hand). Hits/non-terminal continuations are naturally idempotent
        // server-side (script append), so dropping the key here is safe.
        actionKeyRef.current = null;
      } else {
        // insure ack shouldn't arrive here, but tolerate it.
        actionKeyRef.current = null;
      }
    } catch (err) {
      // Stale agent decision (409): the human (or a prior apply) already advanced
      // the hand, so the server rejected this in-flight agent apply. DISCARD it
      // silently — same as a skipped turn — and stay in Autonomous; the next
      // decision point re-asks the agent against the fresh state. Never crash,
      // never blind-retry. Mint a fresh idempotency key so the discarded key is
      // not reused on the next (different) decision.
      if (
        agentDriven && err instanceof CoveApiError &&
        err.status === 409 && err.code === 'stale_agent_decision'
      ) {
        actionKeyRef.current = null;
        // Refetch the live shoe/balance before the next loop (concurrency minor
        // b) so the agent's next decision is made against fresh state, not the
        // stale local view the human already advanced past.
        void resyncAfterStaleDecision();
        pushAdvisor('You took over this hand; the agent stood down. Still in Autonomous.');
      } else {
        showToast(describeBlackjackError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
      }
    } finally {
      busyRef.current = false;
    }
  }, [hand, agentMode, action, activeSlot, applySettled, mergeActionInProgress, showToast, pushAdvisor, resyncAfterStaleDecision]);

  // ── NEXT HAND ───────────────────────────────────────────────────────────────
  const handleNextHand = useCallback(() => {
    resetHand();
  }, [resetHand]);

  // ── WALK AWAY (close shoe → reveal seed, authed) ───────────────────────────
  const handleWalkAway = useCallback(async () => {
    const s = shoeRef.current;
    if (!s || !isRealTier) { handleClose(); return; }
    if (displayStep !== 'settled') { showToast('Finish the current hand first.', 'warn'); return; }
    busyRef.current = true;
    try {
      const res = await closeShoe.mutateAsync({ shoeId: s.id });
      setRevealedSeed(res.serverSeed);
      setShoe((prev) => (prev ? { ...prev, status: 'closed', serverSeed: res.serverSeed } : prev));
      showToast(`Cashed out. Seed ${res.serverSeed.slice(0, 10)}…${res.serverSeed.slice(-6)} revealed.`, 'info');
      setTimeout(() => handleClose(), 1400);
    } catch (err) {
      showToast(describeBlackjackError(err), 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [isRealTier, displayStep, closeShoe, showToast, handleClose]);

  // ── Derived button legality (server is final validator; this gates UI) ─────
  const activeHand = hand?.playerHands[activeSlot] ?? hand?.playerHands[0] ?? null;
  // The focused sub-hand is RESOLVED (stood-21 / doubled-no-bust / surrendered /
  // split-ace / bust). Hit/Stand/Double/Surrender against it would 400
  // `sub_hand_already_terminal` and re-lock the player (FINDING #3). Gate ALL
  // action buttons on it; the player overrides by click-to-focus on the other
  // sub-hand. (On a non-split hand a resolved active hand only happens transiently
  // between settle and the merge clearing it, so gating is harmless there.)
  const activeResolved = Boolean(activeHand && activeHand.isResolved);
  // Double is legal as the FIRST decision on a 2-card hand (the server is the
  // final validator; this only gates the button's enabled state).
  const canDouble = Boolean(
    activeHand && activeHand.cards.length === 2 && !activeResolved,
  );
  const canSurrender = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 && !activeResolved,
  );
  const canSplit = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 &&
    !activeResolved && cardValuePair(activeHand.cards),
  );

  const inFlight = openShoe.isPending || dealHand.isPending || action.isPending ||
    takeInsurance.isPending || closeShoe.isPending;

  // ─────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS DRIVER (FEATURE_GATE: blackjack_autonomous_agent_mode)
  //
  // When a connected agent is present and the human flips the table to
  // Autonomous, the browser asks the agent (server-side, bound to this live
  // session) for its decision at each decision point, surfaces it in the
  // advisor panel, then waits the human-input window ([cards] spec msg 8 —
  // 8s base, 15s if the human is steering with the keyboard) before APPLYING
  // it through the SAME server-authoritative deal/action endpoints. A human
  // tap during the window pre-empts the agent (handleDeal/runAction return
  // early for agent-driven calls once the phase has moved on). The server is
  // still the only authority — the browser never receives undealt cards, the
  // dealer hole, or the seed; it only relays the agent's chosen verb.
  // ─────────────────────────────────────────────────────────────────────────

  // Apply a relayed agent decision through the existing handlers (driven=true
  // bypasses the human-yields-to-agent guard). Split-aware: the relay returns
  // the verb for the active slot; activeSlot is already focused by the merge.
  const applyAgentDecision = useCallback(async (
    decision: {
      action: AgentDecisionAction;
      amount?: number;
      handId?: string | null;
      handSlot?: 0 | 1;
      handVersion?: number | null;
      expectedHandsPlayed?: number | null;
    },
  ) => {
    switch (decision.action) {
      case 'deal': {
        let betOverride: number | undefined;
        if (typeof decision.amount === 'number') {
          // Clamp to engine bounds defensively; the server re-validates.
          const clamped = Math.max(
            COVE_BLACKJACK_MIN_BET,
            Math.min(COVE_BLACKJACK_MAX_BET, Math.round(decision.amount)),
          );
          betOverride = clamped;
          setBlackjackBet(clamped); // reflect the agent's bet on the HUD chip
        }
        // Pass the bet explicitly so the deal does not depend on the async
        // setBlackjackBet landing first (stale-closure-safe). Thread the relay's
        // shoe epoch as the stale-agent-deal precondition (concurrency BLOCKING
        // #2) so a deal that lands after an intervening human deal is rejected.
        await handleDeal(
          true,
          betOverride,
          decision.expectedHandsPlayed ?? undefined,
        );
        break;
      }
      case 'insure':
        // Thread the relay's server-authoritative target hand + the handVersion it
        // decided at, so a stale agent insure that races a human takeover (or an
        // already-settled hand) is rejected/replayed server-side — same contract as
        // the hit/stand/... apply below. Previously insure dropped both, so it could
        // mis-apply to the modal's stale local hand.
        await handleInsure(
          true,
          decision.handVersion ?? undefined,
          decision.handId ?? undefined,
        );
        break;
      case 'hit':
      case 'stand':
      case 'double':
      case 'split':
      case 'surrender':
        // Honor the relay's server-authoritative target hand + slot for split
        // hands (concurrency minor a — apply to the server's hand, not the modal's
        // local view), and thread the relay's handVersion as the stale-decision
        // precondition (a human tap that advanced the hand mid-window 409s this).
        await runAction(
          decision.action,
          true,
          decision.handSlot,
          decision.handVersion ?? undefined,
          decision.handId ?? undefined,
        );
        break;
    }
  }, [handleDeal, handleInsure, runAction, setBlackjackBet]);

  // Clear any pending auto-apply the instant the decision context changes
  // (new hand, phase change, mode switch, modal close) so a stale decision can
  // never apply to the wrong state.
  const decisionContextKey = `${phase}:${hand?.handId ?? 'none'}:${activeSlot}:${settled?.handId ?? 'none'}`;
  useEffect(() => {
    setAgentPending(null);
  }, [decisionContextKey, agentMode]);

  // Driver step 1 — REQUEST a decision at a fresh decision point.
  useEffect(() => {
    if (agentMode !== 'autonomous' || !agentConnected || agentDriverUnavailable) return;
    if (inFlight || busyRef.current || agentBusyRef.current) return;
    if (agentPending) return; // already waiting to apply
    if (revealedSeed) return; // shoe closed — nothing to decide

    // Decide only at points where an action is legal: idle (→ deal), settled
    // (→ next hand then deal), or player-turn (→ hit/stand/etc). We let the
    // settled→next-hand advance happen below without a relay call.
    const s = shoeRef.current;
    const shoeId = s?.id ?? null;

    if (phase === 'settled') {
      // Auto-advance to the next hand after a short pause so the human can read
      // the result; the next idle tick then requests a deal decision.
      const t = setTimeout(() => {
        if (agentMode === 'autonomous') handleNextHand();
      }, AGENT_NEXT_HAND_PAUSE_MS);
      return () => clearTimeout(t);
    }

    if (phase !== 'idle' && phase !== 'player-turn') return;
    // The relay requires a valid shoeId (uuid). During a hand we always have
    // one; at idle we may need to open one first so the agent has a table to
    // decide on.
    if (phase === 'player-turn' && !shoeId) return;

    const myRun = ++agentRunRef.current;
    let cancelled = false;
    void (async () => {
      try {
        // Ensure an open shoe exists before asking the relay (it needs the
        // shoeId; at idle this lazy-opens one, matching the human deal path).
        let activeShoeId = shoeId;
        if (!activeShoeId) {
          const opened = await ensureShoe();
          if (cancelled || myRun !== agentRunRef.current) return;
          if (!opened) return; // ensureShoe surfaced its own toast
          activeShoeId = opened.id;
        }
        // Request carries ONLY the shoeId — the server derives the authoritative
        // in-progress hand + slot from the shoe (a client can't aim the agent at
        // a stale/foreign hand).
        const decision = await fetchAgentBlackjackDecision({ shoeId: activeShoeId });
        if (cancelled || myRun !== agentRunRef.current) return;
        if (decision.rationale) pushAdvisor(decision.rationale);
        // Open the human-veto window. The keyboard-active check uses the most
        // recent movement keypress.
        const keyboardActive =
          Date.now() - lastKeyMoveRef.current < KEYBOARD_ACTIVE_WINDOW_MS;
        const waitMs = keyboardActive
          ? AGENT_DECISION_WAIT_KEYBOARD_MS
          : AGENT_DECISION_WAIT_BASE_MS;
        pushAdvisor(
          `Agent will ${decision.action}${decision.amount ? ` ${decision.amount} vCLAW` : ''} in ${Math.round(waitMs / 1000)}s. Tap any action to take over.`,
        );
        setAgentPending({
          action: decision.action,
          amount: decision.amount,
          handId: decision.handId ?? null,
          handSlot: decision.handSlot,
          handVersion: decision.handVersion ?? null,
          expectedHandsPlayed: decision.expectedHandsPlayed ?? null,
          deadline: Date.now() + waitMs,
        });
      } catch (err) {
        if (cancelled || myRun !== agentRunRef.current) return;
        if (err instanceof AgentUndecidedError) {
          // Transient: the agent replied but produced no parseable move for this
          // spot. Skip THIS decision (the human can act) and stay in Autonomous
          // so the next decision point asks the agent again.
          pushAdvisor('Agent could not decide this hand. Your call. Still in Autonomous.');
          showToast('Agent did not return a decision. Tap an action; autonomous resumes next hand.', 'info');
        } else if (err instanceof AgentDriverUnavailableError) {
          // Sticky: cannot ask the agent for this table at all → Control. Only a
          // nanoclaw self-managed agent gets the "plays itself" message; other
          // sticky failures (no agent, transient cognition error) get a generic
          // notice.
          setAgentDriverUnavailable(true);
          setAgentMode('control');
          showToast(
            err.isSelfManaged
              ? 'This agent plays itself from its own runtime and cannot be co-piloted here. Switched to Control.'
              : 'Could not reach your agent for this table. Switched to Control.',
            'warn',
          );
        } else {
          showToast(describeBlackjackError(err), 'warn');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [
    agentMode, agentConnected, agentDriverUnavailable, phase, inFlight,
    agentPending, revealedSeed, hand?.handId, activeSlot, ensureShoe,
    handleNextHand, pushAdvisor, showToast,
  ]);

  // Driver step 2 — APPLY the pending decision when the veto window elapses.
  useEffect(() => {
    if (!agentPending || agentMode !== 'autonomous') return;
    const remaining = agentPending.deadline - Date.now();
    const myRun = agentRunRef.current;
    const t = setTimeout(() => {
      // Re-check guards at fire time — the human may have acted, or the phase
      // moved on, in which case the context-change effect already cleared
      // agentPending and bumped agentRunRef.
      if (myRun !== agentRunRef.current) return;
      if (busyRef.current || agentBusyRef.current) return;
      agentBusyRef.current = true;
      void applyAgentDecision({
        action: agentPending.action,
        amount: agentPending.amount,
        // Thread the relay's server-authoritative target hand (minor a) + the
        // shoe epoch (BLOCKING #2) so the apply lands on the agent's decided hand
        // and a stale deal is rejected. Previously handId/expectedHandsPlayed were
        // dropped here, so the action applied to the modal's local handId.
        handId: agentPending.handId,
        handSlot: agentPending.handSlot,
        handVersion: agentPending.handVersion,
        expectedHandsPlayed: agentPending.expectedHandsPlayed,
      })
        .finally(() => {
          agentBusyRef.current = false;
          setAgentPending(null);
        });
    }, Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [agentPending, agentMode, applyAgentDecision]);

  // ── F4 self-heal: recover a stranded terminal hand (2026-06-22) ─────────────
  // SAFETY NET (independent of the root-cause guard above). If we are in
  // player-turn with EVERY sub-hand terminal/resolved (so Hit/Stand are disabled
  // via `activeResolved` and there are no live slots left) but never transitioned
  // to `settled` — the one-off race the founder hit — the player is in a dead end:
  // no legal action AND no "Next Hand" button (that's settled-phase-only). Re-derive
  // the authoritative server state (which HAS settled the hand) to recover to the
  // betting UI. Gated to fire at most once per handId (no loop), and only when
  // nothing is in flight so it can never race a real settle/merge mid-transition
  // (the normal post-hit settle window is covered by busyRef still being true).
  useEffect(() => {
    if (phase !== 'player-turn' || !hand) return;
    if (inFlight || busyRef.current || agentBusyRef.current) return;
    if (hand.playerHands.length === 0) return;
    if (!hand.playerHands.every((h) => h.isResolved)) return;
    if (healedHandIdRef.current === hand.handId) return;
    healedHandIdRef.current = hand.handId;
    showToast('Hand resolved. Syncing the table…', 'info');
    void resyncAfterStaleDecision();
  }, [phase, hand, inFlight, resyncAfterStaleDecision, showToast]);

  // ── Settled outcome view helpers ───────────────────────────────────────────
  const settledOutcome: SerializedBlackjackHandResult | null =
    (displayStep === 'dealer-reveal' || displayStep === 'settled')
      ? settled?.outcome ?? null
      : null;
  const settledPrimary: SerializedPlayerHand | null =
    settledOutcome?.playerHands[0] ?? null;

  // ── Fairness summary ───────────────────────────────────────────────────────
  const fairnessSummary = useMemo(() => {
    if (!shoe) return 'Open a hand to commit the shoe seed';
    const short = `${shoe.serverSeedHash.slice(0, 8)}…${shoe.serverSeedHash.slice(-6)}`;
    return revealedSeed
      ? `Seed revealed: ${revealedSeed.slice(0, 6)}…${revealedSeed.slice(-4)}`
      : `Committed: ${short}`;
  }, [shoe, revealedSeed]);

  if (!blackjackOpen) return null;

  // Dealer cards to render: during play only the upcard + a hidden hole card;
  // after settle the full dealer hand from the server outcome.
  const dealerRenderCards: BJCard[] = settledOutcome
    ? settledOutcome.dealer.cards
    : hand?.dealerUpcard
      ? [hand.dealerUpcard, { suit: 'spades', rank: 'A', hidden: true }]
      : [];
  const dealerTotalLabel = settledOutcome
    ? `${settledOutcome.dealer.total}${settledOutcome.dealer.isBust ? ' BUST' : ''}`
    : hand?.dealerUpcard
      ? `${displayTotal([hand.dealerUpcard]).total}+?`
      : undefined;

  const playerRenderHands: SubHandView[] = settledOutcome
    ? settledOutcome.playerHands.map((h) => ({
        // Settled view is display-only (the action strip is hidden in `settled`
        // phase) — every sub-hand is terminal, so isResolved is trivially true.
        cards: h.cards, total: h.total, isSoft: h.isSoft, isBust: h.isBust, isResolved: true,
      }))
    : hand?.playerHands ?? [];

  const toastClass = toast
    ? `pt-toast${toast.tone === 'warn' ? ' pt-toast-warn' : toast.tone === 'error' ? ' pt-toast-error' : ''}`
    : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Blackjack table"
      style={{
        position: 'fixed', inset: 0, zIndex: 9990,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        background: 'rgba(2, 16, 24, 0.82)',
        backdropFilter: 'blur(6px)',
        animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
      }}
    >
      <ParityMirror
        surface="blackjack-2d"
        instanceId={parityInstanceIdRef.current}
      />
      <div
        style={{
          position: 'relative', width: '100%', maxWidth: 620,
          maxHeight: 'min(94vh, 760px)', borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(60,180,120,0.4)',
          background: 'var(--pt-velvet)',
          animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: 'rgba(0,0,0,0.3)',
          borderBottom: '1px solid rgba(60,180,120,0.25)', flexShrink: 0,
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
            fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
            letterSpacing: '0.12em',
          }}>
            BLACKJACK · 6-DECK · S17 · 3:2
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              fontSize: 13, fontFamily: 'var(--pt-data)', fontWeight: 700,
              color: 'var(--pt-amber)', letterSpacing: '0.06em',
              background: 'rgba(150,110,30,0.15)', border: '1px solid rgba(150,110,30,0.3)',
              borderRadius: 6, padding: '3px 10px',
            }}>
              {balance.toLocaleString()} vCLAW{!isRealTier ? ' demo' : ''}
            </div>
            <button
              type="button" onClick={handleClose} aria-label="Close blackjack table"
              style={{
                background: 'none', border: 'none', color: 'var(--pt-mute)',
                cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
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
        <AgentModeBar
          mode={agentMode}
          onMode={setAgentMode}
          advisorMessages={advisorMessages}
          agentConnected={agentConnected}
          driverUnavailable={agentDriverUnavailable}
          pendingAction={agentPending?.action ?? null}
        />

        {/* ── Felt ─────────────────────────────────────────────────────── */}
        <div style={{
          flex: 1, position: 'relative',
          background: 'linear-gradient(180deg, #0d3a1e 0%, #0a2e18 50%, #0d3a1e 100%)',
          padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18,
          minHeight: 0, overflowY: 'auto',
        }}>
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(60,160,80,0.06) 20px)',
            pointerEvents: 'none',
          }} />

          {/* Dealer */}
          <div style={{
            background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(60,180,100,0.18)',
            borderRadius: 10, padding: '14px 16px', position: 'relative', zIndex: 1,
          }}>
            <div style={{
              fontSize: 9, fontFamily: 'var(--pt-data)', color: 'rgba(90,200,120,0.7)',
              letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10,
            }}>
              DEALER STANDS ON ALL 17 (S17)
            </div>
            <HandRow label="Dealer" cards={dealerRenderCards} totalLabel={dealerTotalLabel} />
          </div>

          {/* Settled banner — IN FLOW between the rows so it can never cover a card.
              net = the RAKED net (what the balance actually moved) — the gross
              `net` overstated wins by the 5% rake and made the HUD math look
              wrong (+75 shown, +72 credited). Falls back to gross for pre-rake rows. */}
          {phase === 'settled' && settledPrimary && settledOutcome && (
            <OutcomeBanner
              outcome={settledOutcome}
              bannerText={bannerText ?? 'YOU LOSE'}
              net={BigInt(settledOutcome?.rakedNet ?? settled?.net ?? '0')}
              rake={BigInt(settledOutcome?.rake ?? '0')}
            />
          )}

          <div aria-hidden style={{ borderTop: '1px dashed rgba(60,180,100,0.2)', position: 'relative', zIndex: 1 }} />

          {/* Player (one or two sub-hands) */}
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {playerRenderHands.length === 0 ? (
              <HandRow label="You" cards={[]} />
            ) : (
              playerRenderHands.map((h, i) => {
                const splitVisible = playerRenderHands.length > 1;
                const displayedActiveSlot = phase === 'settled' ? 0 : activeSlot;
                const isActive = splitVisible && i === displayedActiveSlot;
                const labelSuffix = splitVisible ? ` · Hand ${i + 1}` : '';
                const total = `${h.total}${h.isSoft ? ' (soft)' : ''}${h.isBust ? ' BUST' : ''}`;
                return (
                  <div
                    key={i}
                    data-testid={`bj-subhand-${i}`}
                    data-active={String(isActive)}
                    onClick={() => { if (phase === 'player-turn' && hand?.didSplit) setActiveSlot((i === 1 ? 1 : 0) as 0 | 1); }}
                    style={{
                      borderRadius: 8,
                      padding: splitVisible ? '8px 10px' : 0,
                      border: splitVisible
                        ? `1.5px solid ${isActive ? 'var(--pt-amber)' : 'rgba(160,140,100,0.25)'}`
                        : 'none',
                      cursor: phase === 'player-turn' && hand?.didSplit ? 'pointer' : 'default',
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <HandRow label={`You${labelSuffix}`} cards={h.cards} totalLabel={total} highlight={isActive} />
                  </div>
                );
              })
            )}
          </div>

          {/* Insurance prompt (dealer-Ace, before main action) */}
          {phase === 'player-turn' && hand?.insuranceOffered && !hand.tookInsurance && (
            <div style={{
              position: 'relative', zIndex: 1,
              background: 'rgba(40,30,10,0.6)', border: '1px solid rgba(214,161,74,0.4)',
              borderRadius: 8, padding: '8px 12px', display: 'flex',
              alignItems: 'center', justifyContent: 'space-between', gap: 10,
            }}>
              <span style={{ color: 'var(--pt-cream-soft)', fontSize: 11, fontFamily: 'var(--pt-data)' }}>
                Dealer shows an Ace. Insurance? (pays 2:1 if dealer has blackjack)
              </span>
              <button
                type="button" onClick={() => { void handleInsure(); }} disabled={inFlight}
                className="pt-btn pt-btn-ghost"
                style={{ height: 30, fontSize: 11, minWidth: 80, color: 'var(--pt-amber)', flexShrink: 0 }}
              >
                Insure ({Math.floor(blackjackBet / 2)} vCLAW)
              </button>
            </div>
          )}

        </div>

        {/* ── Action strip ─────────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0, background: 'rgba(0,0,0,0.35)',
          borderTop: '1px solid rgba(60,180,120,0.2)', padding: '12px 16px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {/* Bet selector — idle only */}
          {phase === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
                letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0,
              }}>
                BET ({COVE_BLACKJACK_MIN_BET}–{COVE_BLACKJACK_MAX_BET})
              </span>
              {BET_STEPS.map((step) => (
                <BetChip
                  key={step}
                  value={step}
                  selected={blackjackBet === step}
                  disabled={inFlight}
                  onClick={() => setBlackjackBet(step)}
                />
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* idle: DEAL */}
            {phase === 'idle' && (
              <button
                type="button"
                onClick={() => { void handleDeal(); }}
                disabled={inFlight}
                className="pt-btn pt-btn-primary"
                style={{ minWidth: 110, height: 40, fontSize: 13, fontWeight: 700 }}
              >
                {inFlight ? 'Dealing…' : agentMode === 'autonomous' ? `Deal now (${blackjackBet} vCLAW)` : `Deal (${blackjackBet} vCLAW)`}
              </button>
            )}

            {/* player-turn: live actions */}
            {phase === 'player-turn' && (
              <>
                <button type="button" onClick={() => { void runAction('hit'); }}
                  disabled={inFlight || activeResolved}
                  title={activeResolved ? 'This hand is finished. Tap your other hand.' : undefined}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 70, opacity: activeResolved ? 0.4 : 1 }}>
                  Hit
                </button>
                <button type="button" onClick={() => { void runAction('stand'); }}
                  disabled={inFlight || activeResolved}
                  title={activeResolved ? 'This hand is finished. Tap your other hand.' : undefined}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70, opacity: activeResolved ? 0.4 : 1 }}>
                  Stand
                </button>
                <button type="button" onClick={() => { void runAction('double'); }}
                  disabled={inFlight || !canDouble}
                  className="pt-btn pt-btn-ghost"
                  title={canDouble ? 'Double down (one card, doubled stake)' : 'Double only on your first two cards'}
                  style={{ height: 40, fontSize: 12, minWidth: 70, opacity: canDouble ? 1 : 0.4 }}>
                  Double
                </button>
                <button type="button" onClick={() => { void runAction('split'); }}
                  disabled={inFlight || !canSplit}
                  className="pt-btn pt-btn-ghost"
                  title={canSplit ? 'Split your pair into two hands' : 'Split only on a matching pair'}
                  style={{ height: 40, fontSize: 12, minWidth: 70, opacity: canSplit ? 1 : 0.4 }}>
                  Split
                </button>
                <button type="button" onClick={() => { void runAction('surrender'); }}
                  disabled={inFlight || !canSurrender}
                  className="pt-btn pt-btn-ghost"
                  title={canSurrender ? 'Surrender: forfeit half your bet' : 'Surrender only on your first two cards (no split)'}
                  style={{ height: 40, fontSize: 12, minWidth: 90, opacity: canSurrender ? 1 : 0.4 }}>
                  Surrender
                </button>
              </>
            )}

            {/* settled: NEXT HAND + WALK AWAY */}
            {phase === 'settled' && (
              <>
                <button type="button" onClick={handleNextHand}
                  disabled={inFlight}
                  className="pt-btn pt-btn-primary"
                  style={{ minWidth: 110, height: 40, fontSize: 13 }}>
                  Next Hand
                </button>
                {/* Crimson WALK AWAY — explicit bg+fg (No-Dark-Text-On-Dark-Panel). */}
                <button type="button" onClick={() => { void handleWalkAway(); }}
                  disabled={inFlight}
                  style={{
                    height: 40, fontSize: 12, fontWeight: 600, fontFamily: 'var(--pt-data)',
                    letterSpacing: '0.06em', paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                    border: 'none', background: '#dc2626', color: '#ffffff',
                    cursor: inFlight ? 'not-allowed' : 'pointer', transition: 'background 0.15s',
                    opacity: inFlight ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#b91c1c'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626'; }}>
                  {isRealTier ? 'Walk Away' : 'Close'}
                </button>
              </>
            )}
          </div>

          {/* Footer line */}
          <div style={{
            fontSize: 9, color: 'rgba(100,180,130,0.45)', fontFamily: 'var(--pt-data)',
            letterSpacing: '0.12em', textAlign: 'right',
          }}>
            PHASE 6.4.1 · SERVER-AUTHORITATIVE · PROVABLY FAIR · {agentMode.toUpperCase()} MODE
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
              Before any card is dealt, the server publishes <code>sha256(serverSeed)</code> as a
              commitment. Every card in the shoe is derived from
              <code> (serverSeed, clientSeed, handIndex, cursor)</code>. The server cannot change
              the cards after seeing your decisions. The seed is revealed when you walk away so you
              can replay every hand.
            </p>
            <div style={{ display: 'grid', gap: 8, fontSize: 12, fontFamily: 'var(--pt-data)' }}>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Server seed hash: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {shoe?.serverSeedHash ?? 'Not available (no shoe open yet)'}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Client seed: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {shoe?.clientSeed ?? 'Not available'}
                </span>
              </div>
              {revealedSeed ? (
                <div>
                  <span style={{ color: 'var(--pt-amber)' }}>Revealed server seed: </span>
                  <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>{revealedSeed}</span>
                </div>
              ) : (
                <div style={{ color: 'var(--pt-cream-soft)' }}>
                  Server seed reveals when you walk away. Then replay any hand at /cove/history.
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
// AgentModeBar — Control vs Autonomous toggle + advisor surface.
//
// FEATURE_GATE: blackjack_autonomous_agent_mode
// Status: WIRED (2026-06-03, gateway-cognition agents). The in-modal,
//   human-supervised Autonomous DRIVER is LIVE: with a connected agent it asks
//   the relay (POST /api/cove/blackjack/agent/decide, shipped) for a decision,
//   shows it in the read-only advisor panel, and applies it via the
//   server-authoritative deal/action endpoints after the 8s/15s human-veto
//   window. `AUTONOMOUS_RELAY_LIVE = true`; the radio enables only when an agent
//   is connected. HONEST BOUNDARY: self-managed nanoclaw agents decide
//   client-side and cannot be push-asked, so the relay returns 503 and the
//   driver degrades to Control with a clear notice (a documented capability
//   boundary, NOT a disabled feature). The separate also-live autonomous path is
//   the agent playing entirely from its OWN runtime via the cove tools.
// Metric to graduate: ≥ 1 connected agent completing a blackjack hand in
//   Autonomous mode in a 7-day window (event: cove.blackjack.agent.hand.settled).
// Current reading: 0 (newly shipped — to fill from /dash).
// Review deadline: 2026-07-15
// On deadline: if the metric is unmet, keep it gated on connected-agent presence
//   (already done) and revisit; do NOT delete — it is the human-supervised
//   parity path (CLAUDE.md TOP DIRECTIVE + Rule E5).
// Known LATENT follow-up (FOLLOW-UP task #6): server-side rate-limit on
//   /agent/decide (today the 8s/15s client window is the only throttle) — a
//   hardening item, not a functional gap.
// Reference: GameFeatures.md §18a.f (agent modes) + CLAUDE.md three-surface rule
//   + .claude/plans/cove-blackjack.md.
//
// Advisor surface stays a read-only display channel — it NEVER submits a
// decision. In Control mode it shows the agent's hints; in Autonomous mode it
// shows the agent's chosen action + the veto countdown.
// ---------------------------------------------------------------------------
function AgentModeBar({
  mode, onMode, advisorMessages, agentConnected, driverUnavailable, pendingAction,
}: {
  mode: AgentMode;
  onMode: (m: AgentMode) => void;
  advisorMessages: AdvisorMessage[];
  agentConnected: boolean;
  driverUnavailable: boolean;
  pendingAction: AgentDecisionAction | null;
}) {
  // The in-modal driver is LIVE (AUTONOMOUS_RELAY_LIVE) and enables only when an
  // agent is connected. driverUnavailable flips true after a sticky relay
  // failure (e.g. a self-managed nanoclaw agent that returns 503), dropping the
  // table back to Control with a clear notice.
  const autonomousEnabled = AUTONOMOUS_RELAY_LIVE && agentConnected && !driverUnavailable;
  const autonomousTitle = !AUTONOMOUS_RELAY_LIVE
    ? 'In-modal autonomous play arrives with the agent-decision relay. Today a connected agent plays on its own from its runtime via the cove tools.'
    : !agentConnected
      ? 'Connect an agent to let it play your open table on its own'
      : driverUnavailable
        ? 'This agent plays itself from its own runtime and cannot be co-piloted here. Switch to Control.'
        : 'Let your connected agent decide. You keep an 8s (15s if steering) window to take over.';
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
            onClick={() => { if (autonomousEnabled) onMode('autonomous'); }}
            disabled={!autonomousEnabled}
            title={autonomousTitle}
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--pt-data)',
              fontWeight: mode === 'autonomous' ? 700 : 400,
              cursor: autonomousEnabled ? 'pointer' : 'not-allowed',
              opacity: autonomousEnabled ? 1 : 0.5,
              border: mode === 'autonomous' ? '1.5px solid var(--pt-amber)' : '1.5px solid rgba(160,140,100,0.3)',
              background: mode === 'autonomous' ? 'rgba(200,150,50,0.18)' : 'rgba(10,30,20,0.5)',
              color: mode === 'autonomous' ? 'var(--pt-amber)' : 'var(--pt-cream-soft)',
            }}
          >
            {autonomousEnabled
              ? 'Autonomous'
              : !AUTONOMOUS_RELAY_LIVE
                ? 'Autonomous (agent plays from its runtime)'
                : 'Autonomous (connect agent)'}
          </button>
        </div>
        <span style={{
          marginLeft: 'auto', fontSize: 9, fontFamily: 'var(--pt-data)',
          color: 'var(--pt-mute)', letterSpacing: '0.06em',
        }}>
          {mode === 'control' ? 'You decide · agent advises' : 'Agent decides · tap to take over'}
        </span>
      </div>

      {/* Advisor surface — read-only display channel, NEVER a decision input. */}
      <div style={{
        background: 'rgba(10,22,40,0.55)', border: '1px solid rgba(60,180,180,0.18)',
        borderRadius: 6, padding: '6px 10px', minHeight: 26, maxHeight: 64,
        overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3,
      }}>
        {mode === 'autonomous' && pendingAction && (
          <span style={{ fontSize: 10, color: 'var(--pt-amber)', fontFamily: 'var(--pt-data)', fontWeight: 700 }}>
            Agent is about to {pendingAction}. Tap any action to take over.
          </span>
        )}
        {advisorMessages.length === 0 ? (
          <span style={{ fontSize: 10, color: 'var(--pt-cream-soft)', fontFamily: 'var(--pt-data)', fontStyle: 'italic' }}>
            {!AUTONOMOUS_RELAY_LIVE
              ? 'Advisor: a connected agent plays blackjack on its own from its runtime (via the cove tools). In-modal supervised Autonomous, where it plays your open table and you keep an 8s/15s window to take over, arrives with the agent-decision relay.'
              : agentConnected
                ? 'Advisor: your connected agent posts hints here (read-only; your taps stay the decision in Control mode). Switch to Autonomous to let it play.'
                : 'Advisor: connect an agent to get basic-strategy hints here (read-only; your taps stay the decision).'}
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

// ---------------------------------------------------------------------------
// Helper: is this a value-pair (split-eligible opening)?
// ---------------------------------------------------------------------------
function cardValuePair(cards: BJCard[]): boolean {
  if (cards.length !== 2) return false;
  const v = (r: string) => (r === 'K' || r === 'Q' || r === 'J' || r === '10' ? 10 : r === 'A' ? 11 : parseInt(r, 10));
  return v(cards[0]!.rank) === v(cards[1]!.rank);
}
