'use client';

/**
 * BaccaratModal — Phase 6.6.1 AUTHORITATIVE engine client.
 *
 * The cove's FIRST playable baccarat surface (there was only a 3D sign before).
 * Punto Banco has NO player decisions — once the bet (PLAYER / BANKER / TIE) +
 * stake are placed, the server deals + applies the fixed third-card tableau +
 * settles the whole coup in ONE round-trip. The client sends ONLY {bet, stake}
 * and renders the response verbatim. There is NO client-side shoe, NO tableau,
 * NO payout/commission math, NO local winner resolution. Mirrors how
 * BlackjackModal / HoldemModal drive their cove routes.
 *
 * Flow:
 *   open  → GET /session/current (restore an open shoe) else lazy POST
 *           /session/open on the first coup.
 *   coup  → POST /coup {shoeId, bet, stake}. Always settles inline. A 409
 *           {reshuffled} → open a fresh shoe (new seed pair) + retry once.
 *   close → POST /session/close (Lucia auth) reveals serverSeed for replay.
 *
 * Idempotency: a fresh UUID is minted per coup press, reused on retry within
 * that press (mirrors blackjack/holdem). A synchronous `busyRef` lock blocks
 * double-fire before the first await.
 *
 * Agent modes (Phase 6.6.1 UI seam only):
 *   - Control     — the human taps the bet + DEAL buttons. A connected agent
 *                   acts as an ADVISOR (read-only hint panel) and NEVER submits
 *                   a bet. (Advisor wiring is a clean seam for the protocol.)
 *   - Autonomous  — a connected agent makes the bets. Disabled until the
 *                   connected-agent WebSocket protocol ships (FEATURE_GATE).
 *
 * Iris Xe safe: pure React/CSS DOM, zero Three.js. No drei Text/Billboard, no
 * InstancedMesh. No-dark-text-on-dark-panel: light tokens only on the dark
 * felt/velvet (cream / amber / explicit hex; never gray/slate-700+).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import BaccaratCard from './BaccaratCard';
import '@/styles/cove-tokens.css';
import {
  COVE_BACCARAT_MIN_BET,
  COVE_BACCARAT_MAX_BET,
  COVE_BACCARAT_BANKER_COMMISSION_PERCENT,
  COVE_BACCARAT_TIE_PAYOUT,
} from '@clawville/shared';
import type {
  BaccaratBet,
  BaccaratCard as BACCard,
  BaccaratWinner,
  SerializedBaccaratCoup,
  BaccaratShoeWire,
  BaccaratCoupResponse,
} from '@clawville/shared';
import {
  CoveApiError,
  describeBaccaratError,
  fetchCurrentBaccaratShoe,
  reshuffledBody,
  useCloseBaccaratShoe,
  useOpenBaccaratShoe,
  usePlayBaccaratCoup,
} from '@/lib/cove/baccarat-api-client';

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
// Bet-type selector — PLAYER / BANKER / TIE (one bet per coup).
// ---------------------------------------------------------------------------
const BET_META: Record<BaccaratBet, { label: string; payout: string; accent: string }> = {
  player: { label: 'PLAYER', payout: '1 : 1', accent: '#6fb6ff' },
  banker: { label: 'BANKER', payout: `0.95 : 1 (${COVE_BACCARAT_BANKER_COMMISSION_PERCENT}% comm.)`, accent: '#f59e0b' },
  tie:    { label: 'TIE',    payout: `${COVE_BACCARAT_TIE_PAYOUT} : 1`, accent: '#7cff9a' },
};

function BetTypeSelector({ value, disabled, onChange }: {
  value: BaccaratBet;
  disabled: boolean;
  onChange: (b: BaccaratBet) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Baccarat bet" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(['player', 'banker', 'tie'] as const).map((b) => {
        const meta = BET_META[b];
        const selected = value === b;
        return (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(b)}
            disabled={disabled}
            style={{
              flex: '1 1 0',
              minWidth: 96,
              padding: '8px 10px',
              borderRadius: 8,
              border: selected ? `2px solid ${meta.accent}` : '1.5px solid rgba(160,140,100,0.3)',
              background: selected ? `${meta.accent}1f` : 'rgba(10,30,20,0.55)',
              color: selected ? meta.accent : 'var(--pt-cream-soft)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              fontFamily: 'var(--pt-data)',
              transition: 'border-color 0.15s, background 0.15s',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.1em' }}>{meta.label}</span>
            <span style={{ fontSize: 9, opacity: 0.85, letterSpacing: '0.04em' }}>{meta.payout}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand row — Player or Banker side with its server-derived total + natural badge.
// ---------------------------------------------------------------------------
function HandSide({ label, cards, total, isNatural, accent, isWinner, settled }: {
  label: string;
  cards: BACCard[];
  total: number | null;
  isNatural: boolean;
  accent: string;
  isWinner: boolean;
  settled: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 10,
        padding: '12px 14px',
        background: 'rgba(0,0,0,0.25)',
        border: settled && isWinner
          ? `2px solid ${accent}`
          : '1px solid rgba(60,180,100,0.18)',
        boxShadow: settled && isWinner ? `0 0 18px ${accent}44` : 'none',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        position: 'relative',
        zIndex: 1,
      }}
    >
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10,
      }}>
        <span style={{
          fontSize: 10, fontFamily: 'var(--pt-data)', color: accent,
          letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700,
        }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isNatural && (
            <span style={{
              fontSize: 9, fontFamily: 'var(--pt-data)', fontWeight: 700,
              color: '#0a2e18', background: accent, borderRadius: 4,
              padding: '1px 6px', letterSpacing: '0.08em',
            }}>
              NATURAL
            </span>
          )}
          <span style={{
            fontSize: 16, fontWeight: 800, fontFamily: 'var(--pt-display)',
            color: 'var(--pt-cream)', lineHeight: 1, minWidth: 18, textAlign: 'right',
          }}>
            {total ?? '—'}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minHeight: 68 }}>
        {cards.length === 0 ? (
          <>
            <EmptyCardSlot />
            <EmptyCardSlot />
          </>
        ) : (
          cards.map((card, i) => (
            <BaccaratCard key={i} card={card} slideIn delay={i * 70} />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyCardSlot() {
  return (
    <div aria-hidden style={{
      width: 46, height: 68, borderRadius: 6,
      border: '1.5px dashed rgba(120,200,180,0.2)', opacity: 0.4, flexShrink: 0,
    }} />
  );
}

// ---------------------------------------------------------------------------
// Outcome banner — driven entirely by the server-settled coup.
// ---------------------------------------------------------------------------
function OutcomeBanner({ outcome }: { outcome: SerializedBaccaratCoup }) {
  const net = Number(outcome.net);
  const won = net > 0;
  const push = net === 0; // tie + P/B bet returns the stake (PUSH)
  const accent = won
    ? BET_META[outcome.winner === 'tie' ? 'tie' : outcome.winner].accent
    : push
      ? 'var(--pt-cream-soft)'
      : '#e85555';
  const winnerLabel =
    outcome.winner === 'player' ? 'PLAYER WINS' :
    outcome.winner === 'banker' ? 'BANKER WINS' :
    'TIE';

  const resultLabel = won ? 'YOU WIN' : push ? 'PUSH (stake returned)' : 'YOU LOSE';
  const commission = Number(outcome.commission);

  return (
    <div
      role="status"
      aria-live="assertive"
      style={{
        // IN-FLOW below the two hand columns — never absolute over the cards.
        // The old absolute center placement (top 50%) sat directly on the
        // Player/Banker card rows and covered the drawn third cards.
        position: 'relative',
        zIndex: 2,
        alignSelf: 'center',
        pointerEvents: 'none',
        animation: 'bac-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
        textAlign: 'center',
      }}
    >
      <style>{`
        @keyframes bac-banner-in {
          from { opacity: 0; transform: scale(0.85); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div style={{
        background: 'var(--pt-velvet)',
        border: `2px solid ${accent}`,
        padding: '14px 32px',
        boxShadow: `0 0 28px ${accent}55, 0 0 56px ${accent}22`,
        minWidth: 200,
      }}>
        <div style={{
          color: accent, fontSize: 11, fontFamily: 'var(--pt-data)',
          letterSpacing: '0.2em', fontWeight: 700, marginBottom: 4,
        }}>
          {winnerLabel} · {resultLabel}
        </div>
        <div style={{
          color: won ? 'var(--pt-cream)' : push ? 'var(--pt-cream-soft)' : '#e85555',
          fontSize: 28, fontWeight: 700, fontFamily: 'var(--pt-display)', lineHeight: 1,
        }}>
          {net > 0 ? `+${net}` : `${net}`} CT
        </div>
        {commission > 0 && (
          <div style={{
            marginTop: 6, fontSize: 10, fontFamily: 'var(--pt-data)',
            color: 'var(--pt-brass)', letterSpacing: '0.04em',
          }}>
            Banker win — {commission} CT commission ({COVE_BACCARAT_BANKER_COMMISSION_PERCENT}%) kept
          </div>
        )}
      </div>
    </div>
  );
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
// Main modal
// ---------------------------------------------------------------------------
export default function BaccaratModal() {
  const {
    baccaratOpen,
    baccaratBet,
    closeBaccaratTable,
    setBaccaratBet,
  } = useCoveStore();

  const { data: avatar } = useAvatar();

  // ── Local bet-type selection (the only pre-deal choice; stake lives in store) ─
  const [betType, setBetType] = useState<BaccaratBet>('player');

  // ── Server-mirrored state ────────────────────────────────────────────────
  const [shoe, setShoe] = useState<BaccaratShoeWire | null>(null);
  const [balance, setBalance] = useState(0);
  const [settled, setSettled] = useState<BaccaratCoupResponse | null>(null);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  // ── Agent mode + advisor surface (seam) ─────────────────────────────────
  const [agentMode, setAgentMode] = useState<AgentMode>('control');
  const [advisorMessages] = useState<AdvisorMessage[]>([]);

  // ── API hooks ─────────────────────────────────────────────────────────────
  const openShoe = useOpenBaccaratShoe();
  const playCoup = usePlayBaccaratCoup();
  const closeShoe = useCloseBaccaratShoe();

  // ── Refs ──────────────────────────────────────────────────────────────────
  const busyRef = useRef(false);                  // synchronous double-fire lock
  const coupKeyRef = useRef<string | null>(null); // per-coup idempotency key
  const toastSeqRef = useRef(0);
  const shoeRef = useRef<BaccaratShoeWire | null>(null);
  shoeRef.current = shoe;

  const isAuthed = Boolean(avatar);
  const phase: 'idle' | 'settled' = settled ? 'settled' : 'idle';

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

  // ── Reset transient coup state ─────────────────────────────────────────────
  const resetCoup = useCallback(() => {
    setSettled(null);
    coupKeyRef.current = null;
  }, []);

  // ── Eager restore on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!baccaratOpen) return;
    setBalance(avatar?.clawTokens ?? 0);
    setRevealedSeed(null);
    resetCoup();
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentBaccaratShoe();
        if (cancelled || !current) return;
        if (current.shoe.status !== 'open') return;
        setShoe(current.shoe);
        setBalance(current.walletBalance);
        showToast('Resumed your open shoe.', 'info');
      } catch {
        // Network blip — lazy-open on the first coup handles it.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baccaratOpen]);

  // ── Reset everything on close ──────────────────────────────────────────────
  useEffect(() => {
    if (!baccaratOpen) {
      setShoe(null);
      resetCoup();
      setRevealedSeed(null);
      busyRef.current = false;
    }
  }, [baccaratOpen, resetCoup]);

  // ── Close handler ───────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    // Fire-and-forget close any open shoe (authed only — guests have no close
    // endpoint). Skip if a request is in flight or the seed already revealed.
    const s = shoeRef.current;
    if (s && s.status === 'open' && isAuthed && !busyRef.current && !revealedSeed) {
      closeShoe.mutate({ shoeId: s.id });
    }
    closeBaccaratTable();
  }, [isAuthed, revealedSeed, closeShoe, closeBaccaratTable]);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!baccaratOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fairnessOpen) { setFairnessOpen(false); return; }
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [baccaratOpen, fairnessOpen, handleClose]);

  // ── Open (or reuse) a shoe; returns the shoe or null on failure ────────────
  const ensureShoe = useCallback(async (): Promise<BaccaratShoeWire | null> => {
    if (shoeRef.current && shoeRef.current.status === 'open') return shoeRef.current;
    try {
      const opened = await openShoe.mutateAsync({ currency: 'clawtoken' });
      setShoe(opened.shoe);
      setBalance(opened.walletBalance);
      return opened.shoe;
    } catch (err) {
      showToast(describeBaccaratError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
      return null;
    }
  }, [openShoe, showToast]);

  // ── Apply a settled coup (single place balance/outcome land) ───────────────
  const applySettled = useCallback((res: BaccaratCoupResponse) => {
    setSettled(res);
    setBalance(res.balance);
    // Reflect the shoe's new dealtCount locally so the next coup's penetration
    // gate + fairness HUD are accurate without a refetch.
    setShoe((prev) => (prev ? { ...prev, dealtCount: res.dealtCount } : prev));
    if (res.reshuffleSuggested) {
      showToast('Shoe nearly spent — next coup opens a fresh shoe.', 'info');
    }
  }, [showToast]);

  // ── DEAL THE COUP ────────────────────────────────────────────────────────────
  const handleDeal = useCallback(async () => {
    if (busyRef.current || phase !== 'idle') return;
    if (agentMode === 'autonomous') return; // gated — no connected-agent driver yet
    busyRef.current = true;
    try {
      const s = await ensureShoe();
      if (!s) return;
      if (!coupKeyRef.current) coupKeyRef.current = crypto.randomUUID();

      let res: BaccaratCoupResponse;
      try {
        res = await playCoup.mutateAsync({
          shoeId: s.id,
          bet: betType,
          stake: baccaratBet,
          idempotencyKey: coupKeyRef.current,
        });
      } catch (err) {
        // 75% penetration → open a fresh shoe (new seed pair) + retry once.
        if (reshuffledBody(err)) {
          showToast('Shoe reshuffled — dealing from a fresh shoe.', 'info');
          setShoe(null);
          const fresh = await ensureShoe();
          if (!fresh) return;
          coupKeyRef.current = crypto.randomUUID();
          res = await playCoup.mutateAsync({
            shoeId: fresh.id,
            bet: betType,
            stake: baccaratBet,
            idempotencyKey: coupKeyRef.current,
          });
        } else {
          throw err;
        }
      }
      applySettled(res);
    } catch (err) {
      showToast(describeBaccaratError(err), err instanceof CoveApiError && err.status >= 500 ? 'error' : 'warn');
    } finally {
      coupKeyRef.current = null;
      busyRef.current = false;
    }
  }, [phase, agentMode, ensureShoe, playCoup, betType, baccaratBet, applySettled, showToast]);

  // ── NEXT COUP ────────────────────────────────────────────────────────────────
  const handleNextCoup = useCallback(() => {
    resetCoup();
  }, [resetCoup]);

  // ── WALK AWAY (close shoe → reveal seed, authed) ───────────────────────────
  const handleWalkAway = useCallback(async () => {
    const s = shoeRef.current;
    if (!s || !isAuthed) { handleClose(); return; }
    busyRef.current = true;
    try {
      const res = await closeShoe.mutateAsync({ shoeId: s.id });
      setRevealedSeed(res.serverSeed);
      setShoe((prev) => (prev ? { ...prev, status: 'closed', serverSeed: res.serverSeed } : prev));
      showToast(`Cashed out — seed ${res.serverSeed.slice(0, 10)}…${res.serverSeed.slice(-6)} revealed.`, 'info');
      setTimeout(() => handleClose(), 1400);
    } catch (err) {
      showToast(describeBaccaratError(err), 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [isAuthed, closeShoe, showToast, handleClose]);

  const inFlight = openShoe.isPending || playCoup.isPending || closeShoe.isPending;

  const outcome: SerializedBaccaratCoup | null = settled?.outcome ?? null;

  // ── Fairness summary ───────────────────────────────────────────────────────
  const fairnessSummary = useMemo(() => {
    if (!shoe) return 'Place a bet to commit the shoe seed';
    const short = `${shoe.serverSeedHash.slice(0, 8)}…${shoe.serverSeedHash.slice(-6)}`;
    return revealedSeed
      ? `Seed revealed: ${revealedSeed.slice(0, 6)}…${revealedSeed.slice(-4)}`
      : `Committed: ${short}`;
  }, [shoe, revealedSeed]);

  if (!baccaratOpen) return null;

  // Cards to render: empty placeholders while idle; the server's final hands
  // after settle.
  const playerCards: BACCard[] = outcome?.player.cards ?? [];
  const bankerCards: BACCard[] = outcome?.banker.cards ?? [];
  const playerTotal = outcome ? outcome.player.total : null;
  const bankerTotal = outcome ? outcome.banker.total : null;
  const winner: BaccaratWinner | null = outcome?.winner ?? null;

  const toastClass = toast
    ? `pt-toast${toast.tone === 'warn' ? ' pt-toast-warn' : toast.tone === 'error' ? ' pt-toast-error' : ''}`
    : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Baccarat table"
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
          position: 'relative', width: '100%', maxWidth: 640,
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
            BACCARAT · PUNTO BANCO · 8-DECK · COMM 5%
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
              type="button" onClick={handleClose} aria-label="Close baccarat table"
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
        <AgentModeBar mode={agentMode} onMode={setAgentMode} advisorMessages={advisorMessages} />

        {/* ── Felt ─────────────────────────────────────────────────────── */}
        <div style={{
          flex: 1, position: 'relative',
          background: 'linear-gradient(180deg, #0d3a1e 0%, #0a2e18 50%, #0d3a1e 100%)',
          padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16,
          minHeight: 0, overflowY: 'auto',
        }}>
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(60,160,80,0.06) 20px)',
            pointerEvents: 'none',
          }} />

          {/* Player + Banker side-by-side */}
          <div style={{ display: 'flex', gap: 14, position: 'relative', zIndex: 1 }}>
            <HandSide
              label="Player"
              cards={playerCards}
              total={playerTotal}
              isNatural={outcome?.player.isNatural ?? false}
              accent={BET_META.player.accent}
              isWinner={winner === 'player'}
              settled={phase === 'settled'}
            />
            <HandSide
              label="Banker"
              cards={bankerCards}
              total={bankerTotal}
              isNatural={outcome?.banker.isNatural ?? false}
              accent={BET_META.banker.accent}
              isWinner={winner === 'banker'}
              settled={phase === 'settled'}
            />
          </div>

          {/* Settled banner — IN FLOW under the hands so it can never cover a card */}
          {phase === 'settled' && outcome && <OutcomeBanner outcome={outcome} />}

          {/* Your bet pill — shows the active wager once a coup is settled */}
          {phase === 'settled' && outcome && (
            <div style={{
              position: 'relative', zIndex: 1, textAlign: 'center',
              fontSize: 10, fontFamily: 'var(--pt-data)', color: 'var(--pt-cream-soft)',
              letterSpacing: '0.08em',
            }}>
              Your bet: <span style={{ color: BET_META[outcome.bet].accent, fontWeight: 700 }}>
                {BET_META[outcome.bet].label}
              </span> · {outcome.stake} CT
            </div>
          )}

        </div>

        {/* ── Action strip ─────────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0, background: 'rgba(0,0,0,0.35)',
          borderTop: '1px solid rgba(60,180,120,0.2)', padding: '12px 16px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {/* Bet-type + stake selector — idle only */}
          {phase === 'idle' && (
            <>
              <BetTypeSelector
                value={betType}
                disabled={inFlight || agentMode === 'autonomous'}
                onChange={setBetType}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
                  letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0,
                }}>
                  STAKE ({COVE_BACCARAT_MIN_BET}–{COVE_BACCARAT_MAX_BET})
                </span>
                {BET_STEPS.map((step) => (
                  <BetChip
                    key={step}
                    value={step}
                    selected={baccaratBet === step}
                    disabled={inFlight || agentMode === 'autonomous'}
                    onClick={() => setBaccaratBet(step)}
                  />
                ))}
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* idle: DEAL */}
            {phase === 'idle' && (
              <button
                type="button"
                onClick={() => { void handleDeal(); }}
                disabled={inFlight || agentMode === 'autonomous'}
                className="pt-btn pt-btn-primary"
                style={{ minWidth: 130, height: 40, fontSize: 13, fontWeight: 700 }}
              >
                {inFlight ? 'Dealing…' : `Deal ${BET_META[betType].label} (${baccaratBet} CT)`}
              </button>
            )}

            {/* settled: NEXT COUP + WALK AWAY */}
            {phase === 'settled' && (
              <>
                <button type="button" onClick={handleNextCoup}
                  disabled={inFlight}
                  className="pt-btn pt-btn-primary"
                  style={{ minWidth: 110, height: 40, fontSize: 13 }}>
                  Next Coup
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
            PHASE 6.6.1 · SERVER-AUTHORITATIVE · PROVABLY FAIR · {agentMode.toUpperCase()} MODE
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
              commitment. Every card in the 8-deck shoe is derived from
              <code> (serverSeed, clientSeed, coupIndex, cursor)</code> — Punto Banco has no
              player decisions, so the entire coup (deal + fixed third-card tableau + winner) is
              determined by the seed and cannot be changed after you bet. The seed is revealed when
              you walk away so you can replay every coup.
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
                  Server seed reveals when you walk away — then replay any coup at /cove/history.
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
// FEATURE_GATE: baccarat_autonomous_agent_mode
// Status: UI seam only — the Control/Autonomous toggle + advisor display panel
//   are rendered, but the connected-agent WebSocket protocol that would drive
//   Autonomous mode (or feed Control-mode advisor hints) does NOT exist yet.
//   Autonomous is rendered disabled; the advisor panel shows a placeholder.
// Metric to graduate: ≥ 1 connected agent completing a baccarat coup via the
//   WS protocol in a 7-day window (event: cove.baccarat.agent.coup.settled).
// Current reading: 0 (protocol not shipped — connected-agent protocol drop).
// Review deadline: 2026-07-15
// On deadline: if the WS protocol has not shipped, DELETE the Autonomous radio
//   + advisor panel and keep Control-only until the protocol lands.
// Reference: GameFeatures.md §18a.j (baccarat agent modes) + CLAUDE.md three-surface rule.
//
// SEAM: a connected-agent WS client would, in Control mode, push odds/edge hints
//   into `advisorMessages` WITHOUT ever submitting a bet — the human's buttons
//   stay the only decision channel. In Autonomous mode the same WS client would
//   submit /coup calls on the agent's behalf. Neither path is wired here.
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
            title="Autonomous agent mode arrives with the connected-agent protocol"
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
            Advisor: connect an agent to get house-edge + bet hints here (read-only — your taps stay the decision). Coming with the connected-agent protocol.
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
