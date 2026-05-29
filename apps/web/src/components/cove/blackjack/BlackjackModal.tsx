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
import { useAvatar } from '@/hooks/use-avatar';
import BlackjackCard from './BlackjackCard';
import '@/styles/cove-tokens.css';
import {
  COVE_BLACKJACK_MIN_BET,
  COVE_BLACKJACK_MAX_BET,
} from '@/lib/cove/blackjack-types';
import type {
  BlackjackCard as BJCard,
  BlackjackOutcome,
  SerializedBlackjackHandResult,
  SerializedPlayerHand,
} from '@/lib/cove/blackjack-types';
import {
  CoveApiError,
  describeBlackjackError,
  fetchCurrentBlackjackShoe,
  isActionInProgress,
  isSettled,
  reshuffledBody,
  useBlackjackAction,
  useCloseBlackjackShoe,
  useDealHand,
  useOpenBlackjackShoe,
  useTakeInsurance,
  type ActionResponse,
  type BlackjackShoeWire,
  type DealResponse,
  type SettledHandResponse,
} from '@/lib/cove/blackjack-api-client';

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
function OutcomeBanner({ outcome, net }: { outcome: BlackjackOutcome; net: bigint }) {
  const isWin = outcome === 'blackjack' || outcome === 'win';
  const isPush = outcome === 'push';
  const isSurrender = outcome === 'surrender';
  const accent =
    isWin ? 'var(--pt-amber-glow)' :
    isPush ? 'var(--pt-cream-soft)' :
    isSurrender ? '#d6a14a' :
    '#e85555';
  const label =
    outcome === 'blackjack' ? 'BLACKJACK!' :
    outcome === 'win' ? 'YOU WIN' :
    outcome === 'push' ? 'PUSH' :
    outcome === 'surrender' ? 'SURRENDER' :
    'YOU LOSE';

  const netNum = Number(net);
  const showNet = netNum !== 0;

  return (
    <div
      role="status"
      aria-live="assertive"
      style={{
        position: 'absolute',
        left: '50%',
        top: '38%',
        transform: 'translate(-50%, -50%)',
        zIndex: 10,
        pointerEvents: 'none',
        animation: 'bj-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
        textAlign: 'center',
      }}
    >
      <style>{`
        @keyframes bj-banner-in {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
      `}</style>
      <div style={{
        background: 'var(--pt-velvet)',
        border: `2px solid ${accent}`,
        padding: '14px 32px',
        boxShadow: `0 0 28px ${accent}55, 0 0 56px ${accent}22`,
        minWidth: 180,
      }}>
        <div style={{
          color: accent,
          fontSize: 11,
          fontFamily: 'var(--pt-data)',
          letterSpacing: '0.2em',
          fontWeight: 700,
          marginBottom: showNet ? 4 : 0,
        }}>
          {label}
        </div>
        {showNet && (
          <div style={{
            color: netNum > 0 ? 'var(--pt-cream)' : '#e85555',
            fontSize: 28,
            fontWeight: 700,
            fontFamily: 'var(--pt-display)',
            lineHeight: 1,
          }}>
            {netNum > 0 ? `+${netNum}` : `${netNum}`} CT
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
// Agent mode (UI seam — see SEAM markers; no WS protocol yet)
// ---------------------------------------------------------------------------
type AgentMode = 'control' | 'autonomous';
interface AdvisorMessage { id: number; text: string; }

// ---------------------------------------------------------------------------
// Local in-progress hand view (built from server responses only)
// ---------------------------------------------------------------------------
interface SubHandView {
  cards: BJCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
}
interface HandView {
  handId: string;
  shoeId: string;
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
  const [hand, setHand] = useState<HandView | null>(null);
  const [settled, setSettled] = useState<SettledHandResponse | null>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  // ── Agent mode + advisor surface (seam) ─────────────────────────────────
  const [agentMode, setAgentMode] = useState<AgentMode>('control');
  const [advisorMessages, setAdvisorMessages] = useState<AdvisorMessage[]>([]);
  const advisorSeqRef = useRef(0);

  // ── API hooks ─────────────────────────────────────────────────────────────
  const openShoe = useOpenBlackjackShoe();
  const dealHand = useDealHand();
  const action = useBlackjackAction();
  const takeInsurance = useTakeInsurance();
  const closeShoe = useCloseBlackjackShoe();

  // ── Refs ──────────────────────────────────────────────────────────────────
  const busyRef = useRef(false);                  // synchronous double-fire lock
  const dealKeyRef = useRef<string | null>(null); // per-deal idempotency key
  const actionKeyRef = useRef<string | null>(null); // per-terminal-action key
  const toastSeqRef = useRef(0);
  const shoeRef = useRef<BlackjackShoeWire | null>(null);
  shoeRef.current = shoe;

  const isAuthed = Boolean(avatar);
  const phase: 'idle' | 'player-turn' | 'settled' =
    settled ? 'settled' : hand ? 'player-turn' : 'idle';

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
    setHand(null);
    setSettled(null);
    setActiveSlot(0);
    dealKeyRef.current = null;
    actionKeyRef.current = null;
  }, []);

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
        showToast('Resumed your open shoe.', 'info');
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
    }
  }, [blackjackOpen, resetHand]);

  // ── Close handler ───────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    // Fire-and-forget close any open shoe (authed only — guests have no close
    // endpoint). Skip if a hand is in progress (server would 409) or a request
    // is in flight (avoid racing the settle lock).
    const s = shoeRef.current;
    if (s && s.status === 'open' && isAuthed && !hand && !busyRef.current && !revealedSeed) {
      closeShoe.mutate({ shoeId: s.id });
    }
    closeBlackjackTable();
  }, [isAuthed, hand, revealedSeed, closeShoe, closeBlackjackTable]);

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
  const applySettled = useCallback((res: SettledHandResponse) => {
    setSettled(res);
    setBalance(res.balance);
    setHand(null);
    // Reflect the shoe's new dealtCount locally so the next deal's penetration
    // gate + fairness HUD are accurate without a refetch.
    setShoe((prev) => (prev ? { ...prev, dealtCount: res.dealtCount } : prev));
    if (res.reshuffleSuggested) {
      showToast('Shoe nearly spent — next deal opens a fresh shoe.', 'info');
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
      playerHands: [{ cards: opening, total: t.total, isSoft: t.isSoft, isBust: false }],
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
  ) => {
    setHand((prev) => {
      if (!prev) return prev;
      const merged: SubHandView[] = res.playerHands.map((h) => ({
        cards: h.cards,
        total: h.total,
        isSoft: h.isSoft,
        isBust: h.isBust,
      }));
      return {
        ...prev,
        playerHands: merged,
        dealerUpcard: res.dealerUpcard ?? prev.dealerUpcard,
        didSplit: res.didSplit,
      };
    });
    // After a split, focus the first non-resolved sub-hand.
    if (res.didSplit) {
      const firstLive = res.playerHands.findIndex((h) => !h.isBust);
      setActiveSlot((firstLive === 1 ? 1 : 0) as 0 | 1);
    }
  }, []);

  // ── DEAL ────────────────────────────────────────────────────────────────────
  const handleDeal = useCallback(async () => {
    if (busyRef.current || phase !== 'idle') return;
    if (agentMode === 'autonomous') return; // gated — no connected-agent driver yet
    busyRef.current = true;
    try {
      const s = await ensureShoe();
      if (!s) return;
      if (!dealKeyRef.current) dealKeyRef.current = crypto.randomUUID();

      const wantInsurance = false; // insurance is taken AFTER the upcard shows
      let res: DealResponse;
      try {
        res = await dealHand.mutateAsync({
          shoeId: s.id,
          bet: blackjackBet,
          insurance: wantInsurance,
          idempotencyKey: dealKeyRef.current,
        });
      } catch (err) {
        // 75% penetration → open a fresh shoe (new seed pair) + retry once.
        if (reshuffledBody(err)) {
          showToast('Shoe reshuffled — dealing from a fresh shoe.', 'info');
          setShoe(null);
          const fresh = await ensureShoe();
          if (!fresh) return;
          dealKeyRef.current = crypto.randomUUID();
          res = await dealHand.mutateAsync({
            shoeId: fresh.id,
            bet: blackjackBet,
            insurance: wantInsurance,
            idempotencyKey: dealKeyRef.current,
          });
        } else {
          throw err;
        }
      }

      setSettled(null);
      if (isSettled(res)) {
        applySettled(res); // natural settled inline
      } else {
        setHand(handViewFromDeal(res));
        setActiveSlot(0);
        // Stake is committed at deal (finding #3) — reflect the debited balance
        // in the HUD immediately if the server returned it.
        if (typeof res.balance === 'number') setBalance(res.balance);
      }
    } catch (err) {
      showToast(describeBlackjackError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
    } finally {
      dealKeyRef.current = null;
      busyRef.current = false;
    }
  }, [phase, agentMode, ensureShoe, dealHand, blackjackBet, showToast, applySettled, handViewFromDeal]);

  // ── INSURANCE (before any main-hand action; dealer-Ace only) ───────────────
  const handleInsure = useCallback(async () => {
    if (busyRef.current || !hand || hand.tookInsurance || !hand.insuranceOffered) return;
    busyRef.current = true;
    try {
      const res = await takeInsurance.mutateAsync({ handId: hand.handId });
      setHand((prev) => (prev ? { ...prev, tookInsurance: res.tookInsurance } : prev));
      showToast('Insurance taken.', 'info');
    } catch (err) {
      showToast(describeBlackjackError(err), 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [hand, takeInsurance, showToast]);

  // ── ACTION (hit / stand / double / split / surrender) ──────────────────────
  const runAction = useCallback(async (
    act: 'hit' | 'stand' | 'double' | 'split' | 'surrender',
  ) => {
    if (busyRef.current || !hand) return;
    if (agentMode === 'autonomous') return;
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
        handId: hand.handId,
        action: act,
        handSlot: activeSlot,
        idempotencyKey: actionKeyRef.current,
      });
      if (isSettled(res)) {
        applySettled(res);
        actionKeyRef.current = null;
      } else if (isActionInProgress(res)) {
        mergeActionInProgress(res);
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
      showToast(describeBlackjackError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [hand, agentMode, action, activeSlot, applySettled, mergeActionInProgress, showToast]);

  // ── NEXT HAND ───────────────────────────────────────────────────────────────
  const handleNextHand = useCallback(() => {
    resetHand();
  }, [resetHand]);

  // ── WALK AWAY (close shoe → reveal seed, authed) ───────────────────────────
  const handleWalkAway = useCallback(async () => {
    const s = shoeRef.current;
    if (!s || !isAuthed) { handleClose(); return; }
    if (hand) { showToast('Finish the current hand first.', 'warn'); return; }
    busyRef.current = true;
    try {
      const res = await closeShoe.mutateAsync({ shoeId: s.id });
      setRevealedSeed(res.serverSeed);
      setShoe((prev) => (prev ? { ...prev, status: 'closed', serverSeed: res.serverSeed } : prev));
      showToast(`Cashed out — seed ${res.serverSeed.slice(0, 10)}…${res.serverSeed.slice(-6)} revealed.`, 'info');
      setTimeout(() => handleClose(), 1400);
    } catch (err) {
      showToast(describeBlackjackError(err), 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [isAuthed, hand, closeShoe, showToast, handleClose]);

  // ── Derived button legality (server is final validator; this gates UI) ─────
  const activeHand = hand?.playerHands[activeSlot] ?? hand?.playerHands[0] ?? null;
  // Double is legal as the FIRST decision on a 2-card hand (the server is the
  // final validator; this only gates the button's enabled state).
  const canDouble = Boolean(
    activeHand && activeHand.cards.length === 2 && !activeHand.isBust,
  );
  const canSurrender = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 && !activeHand.isBust,
  );
  const canSplit = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 &&
    cardValuePair(activeHand.cards),
  );

  const inFlight = openShoe.isPending || dealHand.isPending || action.isPending ||
    takeInsurance.isPending || closeShoe.isPending;

  // ── Settled outcome view helpers ───────────────────────────────────────────
  const settledOutcome: SerializedBlackjackHandResult | null = settled?.outcome ?? null;
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
        cards: h.cards, total: h.total, isSoft: h.isSoft, isBust: h.isBust,
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
              {balance.toLocaleString()} CT{!isAuthed ? ' demo' : ''}
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

          <div aria-hidden style={{ borderTop: '1px dashed rgba(60,180,100,0.2)', position: 'relative', zIndex: 1 }} />

          {/* Player (one or two sub-hands) */}
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {playerRenderHands.length === 0 ? (
              <HandRow label="You" cards={[]} />
            ) : (
              playerRenderHands.map((h, i) => {
                const isActive = phase === 'player-turn' && hand?.didSplit && i === activeSlot;
                const labelSuffix = hand?.didSplit ? ` · Hand ${i + 1}` : '';
                const total = `${h.total}${h.isSoft ? ' (soft)' : ''}${h.isBust ? ' BUST' : ''}`;
                return (
                  <div
                    key={i}
                    onClick={() => { if (phase === 'player-turn' && hand?.didSplit) setActiveSlot((i === 1 ? 1 : 0) as 0 | 1); }}
                    style={{
                      borderRadius: 8,
                      padding: hand?.didSplit ? '8px 10px' : 0,
                      border: hand?.didSplit
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
                type="button" onClick={() => { void handleInsure(); }} disabled={inFlight || agentMode === 'autonomous'}
                className="pt-btn pt-btn-ghost"
                style={{ height: 30, fontSize: 11, minWidth: 80, color: 'var(--pt-amber)', flexShrink: 0 }}
              >
                Insure ({Math.floor(blackjackBet / 2)} CT)
              </button>
            </div>
          )}

          {/* Settled banner */}
          {phase === 'settled' && settledPrimary && (
            <OutcomeBanner
              outcome={settledPrimary.outcome}
              net={settled ? BigInt(settled.net) : 0n}
            />
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
                disabled={inFlight || agentMode === 'autonomous'}
                className="pt-btn pt-btn-primary"
                style={{ minWidth: 110, height: 40, fontSize: 13, fontWeight: 700 }}
              >
                {inFlight ? 'Dealing…' : `Deal (${blackjackBet} CT)`}
              </button>
            )}

            {/* player-turn: live actions */}
            {phase === 'player-turn' && (
              <>
                <button type="button" onClick={() => { void runAction('hit'); }}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 70 }}>
                  Hit
                </button>
                <button type="button" onClick={() => { void runAction('stand'); }}
                  disabled={inFlight || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70 }}>
                  Stand
                </button>
                <button type="button" onClick={() => { void runAction('double'); }}
                  disabled={inFlight || !canDouble || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  title={canDouble ? 'Double down (one card, doubled stake)' : 'Double only on your first two cards'}
                  style={{ height: 40, fontSize: 12, minWidth: 70, opacity: canDouble ? 1 : 0.4 }}>
                  Double
                </button>
                <button type="button" onClick={() => { void runAction('split'); }}
                  disabled={inFlight || !canSplit || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  title={canSplit ? 'Split your pair into two hands' : 'Split only on a matching pair'}
                  style={{ height: 40, fontSize: 12, minWidth: 70, opacity: canSplit ? 1 : 0.4 }}>
                  Split
                </button>
                <button type="button" onClick={() => { void runAction('surrender'); }}
                  disabled={inFlight || !canSurrender || agentMode === 'autonomous'}
                  className="pt-btn pt-btn-ghost"
                  title={canSurrender ? 'Surrender — forfeit half your bet' : 'Surrender only on your first two cards (no split)'}
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
                  {isAuthed ? 'Walk Away' : 'Close'}
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
              <code> (serverSeed, clientSeed, handIndex, cursor)</code> — the server cannot change
              the cards after seeing your decisions. The seed is revealed when you walk away so you
              can replay every hand.
            </p>
            <div style={{ display: 'grid', gap: 8, fontSize: 12, fontFamily: 'var(--pt-data)' }}>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Server seed hash: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {shoe?.serverSeedHash ?? '— (no shoe open yet)'}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--pt-brass)' }}>Client seed: </span>
                <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                  {shoe?.clientSeed ?? '—'}
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
// FEATURE_GATE: blackjack_autonomous_agent_mode
// Status: UI seam only — the Control/Autonomous toggle + advisor display panel
//   are rendered, but the connected-agent WebSocket protocol that would drive
//   Autonomous mode (or feed Control-mode advisor messages) does NOT exist yet.
//   Autonomous is rendered disabled; the advisor panel shows a placeholder.
// Metric to graduate: ≥ 1 connected agent completing a blackjack hand via the
//   WS protocol in a 7-day window (event: cove.blackjack.agent.hand.settled).
// Current reading: 0 (protocol not shipped — Phase 6.4.2).
// Review deadline: 2026-07-15
// On deadline: if the WS protocol has not shipped, DELETE the Autonomous radio
//   + advisor panel and keep Control-only until the protocol lands.
// Reference: GameFeatures.md §18a.f (agent modes) + CLAUDE.md three-surface rule.
//
// SEAM (Phase 6.4.2): a connected-agent WS client would, in Control mode, call
//   the (future) advisor callback to push strategy hints into `advisorMessages`
//   WITHOUT ever submitting a decision — the human's buttons stay the only
//   decision channel. In Autonomous mode the same WS client would submit
//   /action calls on the agent's behalf. Neither path is wired here.
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
            onClick={() => onMode('autonomous')}
            disabled
            title="Autonomous agent mode arrives with the connected-agent protocol (Phase 6.4.2)"
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
            Advisor: connect an agent to get basic-strategy hints here (read-only — your taps stay the decision). Coming in Phase 6.4.2.
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
