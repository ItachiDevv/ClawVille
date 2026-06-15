'use client';

/**
 * PokerActionBar — the player's betting controls for the live MTT table.
 *
 * Reads the PRIVATE seat view (`poker.your_turn`) from `stores/poker.ts`:
 * `seatView` carries `legalActions`, `toCall`, `minRaiseTo`, `maxRaiseTo`,
 * `chipStack`, and the wall-clock `deadlineMs`. The bar is DISABLED whenever it
 * is not our turn (`seatView == null` or stale hand) OR the turn clock has
 * expired (the server auto-acts on timeout, so we must not also send).
 *
 * Sends `{ type: 'poker.action', handNumber, actionSeq, action }` via the
 * caller-supplied `send`. `actionSeq` is a monotonic per-seat counter held in a
 * ref so a retransmit/double-tap is a stable server-side no-op (the server's
 * idempotency key is `<handNumber>:<actionSeq>:<avatarId>`).
 *
 * Bet/raise sizing: a slider bounded by `[minRaiseTo, maxRaiseTo]` (TOTAL
 * "raise to" semantics — matches the wire `PokerAction.amount`) plus pot-fraction
 * preset chips (½, ¾, pot, all-in) clamped to the legal band.
 *
 * Iris Xe safe: pure DOM/CSS. No Three.js. Dark-panel text uses LIGHT tokens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePokerStore } from '@/stores/poker';
import type { ClientFrame, PokerActionPayload } from '@clawville/shared';
import { TurnClock } from './TurnClock';

export interface PokerActionBarProps {
  /** WS send (returns false if the socket isn't open). */
  send: (frame: ClientFrame) => boolean;
  /** Mobile thumb-zone layout (larger tap targets, stacked). */
  isMobile?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export default function PokerActionBar({ send, isMobile = false }: PokerActionBarProps) {
  const seatView = usePokerStore((s) => s.seatView);
  const seatViewHandNumber = usePokerStore((s) => s.seatViewHandNumber);
  const table = usePokerStore((s) => s.table);

  // Monotonic per-seat action counter — survives re-renders.
  const actionSeqRef = useRef(0);
  // Per-(hand) guard so we never send twice for the same prompt.
  const sentForKeyRef = useRef<string | null>(null);
  // Clock-expiry latch — once the deadline passes we lock the bar.
  const [expired, setExpired] = useState(false);

  // The hand our action targets MUST be the one the `your_turn` prompt named —
  // it is the authoritative idempotency-key component (`<handNumber>:<seq>:
  // <avatarId>`). The PUBLIC `table.handNumber` can lag the private prompt by a
  // frame, so we send with `seatViewHandNumber`, never the table's.
  const handNumber = seatViewHandNumber ?? table?.handNumber ?? 0;
  const isOurTurn =
    !!seatView &&
    seatViewHandNumber != null &&
    (table == null || seatViewHandNumber === table.handNumber);

  // Reset the per-prompt latches whenever a NEW your_turn prompt arrives.
  const promptKey = isOurTurn ? `${seatViewHandNumber}:${seatView?.deadlineMs}` : null;
  useEffect(() => {
    if (promptKey) {
      setExpired(false);
      sentForKeyRef.current = null;
    }
  }, [promptKey]);

  // Raise/bet sizing state — re-seed when a new prompt arrives.
  const [raiseTo, setRaiseTo] = useState(0);
  useEffect(() => {
    if (seatView) {
      setRaiseTo(seatView.minRaiseTo);
    }
  }, [seatView?.minRaiseTo, seatView?.maxRaiseTo, promptKey]);

  const legal = seatView?.legalActions ?? [];
  const canFold = legal.includes('fold');
  const canCheck = legal.includes('check');
  const canCall = legal.includes('call');
  const canBet = legal.includes('bet');
  const canRaise = legal.includes('raise');
  const showSizing = canBet || canRaise;
  const sizingVerb: 'bet' | 'raise' = canRaise ? 'raise' : 'bet';

  const disabled = !isOurTurn || expired;

  // Pot-fraction presets (TOTAL "to" targets). Pot is the public pot + toCall
  // for a rough "pot-sized raise" approximation; clamped to the legal band.
  const presets = useMemo(() => {
    if (!seatView) return [] as Array<{ label: string; to: number }>;
    const pot = table?.pot ?? 0;
    const { minRaiseTo, maxRaiseTo, toCall } = seatView;
    const potNow = pot + toCall;
    const candidates: Array<{ label: string; to: number }> = [
      { label: '½ Pot', to: Math.round(toCall + potNow * 0.5) },
      { label: '¾ Pot', to: Math.round(toCall + potNow * 0.75) },
      { label: 'Pot', to: Math.round(toCall + potNow) },
      { label: 'All-in', to: maxRaiseTo },
    ];
    return candidates
      .map((c) => ({ ...c, to: clamp(c.to, minRaiseTo, maxRaiseTo) }))
      // Drop degenerate presets (e.g. when min === max, only All-in matters).
      .filter((c, i, arr) => arr.findIndex((x) => x.to === c.to) === i);
  }, [seatView, table?.pot]);

  const dispatch = useCallback(
    (action: PokerActionPayload) => {
      if (disabled) return;
      // One send per prompt — double-tap / re-render is a stable no-op anyway
      // (idempotency key), but we also latch locally to keep the UI honest.
      const key = `${seatViewHandNumber}:${seatView?.deadlineMs}`;
      if (sentForKeyRef.current === key) return;
      const seq = actionSeqRef.current++;
      const ok = send({
        type: 'poker.action',
        handNumber,
        actionSeq: seq,
        action,
      });
      if (ok) {
        sentForKeyRef.current = key;
        // Optimistically clear our private turn view so the bar disables the
        // instant we act — the next `poker.your_turn` (or `hand_ended`) is the
        // authoritative re-enable. Prevents a stale-but-enabled action bar
        // between our send and the server's next frame.
        usePokerStore.setState({ seatView: null });
      }
    },
    [disabled, send, handNumber, seatViewHandNumber, seatView?.deadlineMs],
  );

  const onExpire = useCallback(() => setExpired(true), []);

  // ── Styles ──────────────────────────────────────────────────────────────
  const barBg = 'rgba(6,24,18,0.94)';
  const btnBase: React.CSSProperties = {
    flex: 1,
    minWidth: isMobile ? 0 : 88,
    minHeight: isMobile ? 52 : 44,
    borderRadius: 10,
    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
    fontWeight: 800,
    fontSize: isMobile ? 14 : 13,
    letterSpacing: '0.06em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'opacity 0.15s, transform 0.1s',
    border: '1px solid transparent',
    color: '#f0fdf4',
  };

  function btnStyle(kind: 'fold' | 'check' | 'call' | 'raise', enabled: boolean): React.CSSProperties {
    const palettes = {
      fold: { bg: 'linear-gradient(180deg,#7f1d1d,#5b1414)', border: '#b91c1c' },
      check: { bg: 'linear-gradient(180deg,#1e3a5f,#13263f)', border: '#3b82f6' },
      call: { bg: 'linear-gradient(180deg,#1e3a5f,#13263f)', border: '#3b82f6' },
      raise: { bg: 'linear-gradient(180deg,#b45309,#7c3a06)', border: '#f59e0b' },
    } as const;
    const p = palettes[kind];
    return {
      ...btnBase,
      background: p.bg,
      borderColor: p.border,
      opacity: !enabled || disabled ? 0.35 : 1,
      pointerEvents: !enabled || disabled ? 'none' : 'auto',
    };
  }

  return (
    <div
      role="toolbar"
      aria-label="Poker actions"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        // Lift above the iPad/phone home indicator. devtools can't prove
        // env(safe-area-inset-*) — verify on a real iPad screenshot.
        padding: isMobile
          ? 'calc(10px + env(safe-area-inset-bottom, 0px)) 12px 12px'
          : '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
        background: barBg,
        borderTop: '1px solid rgba(124,255,203,0.18)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Status row: whose turn + clock. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0.08em',
            color: isOurTurn ? '#7cffcb' : 'rgba(148,184,170,0.75)',
          }}
        >
          {isOurTurn
            ? expired
              ? 'TIME UP — auto-acted'
              : 'YOUR TURN'
            : 'Waiting for your turn…'}
        </div>
        {isOurTurn && seatView && !expired && (
          <TurnClock deadlineMs={seatView.deadlineMs} onExpire={onExpire} />
        )}
      </div>

      {/* Sizing control (only when bet/raise is legal). */}
      {showSizing && seatView && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            opacity: disabled ? 0.4 : 1,
            pointerEvents: disabled ? 'none' : 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontFamily: 'ui-monospace, monospace',
                color: '#fbbf24',
                fontWeight: 700,
                minWidth: 64,
              }}
            >
              {sizingVerb === 'raise' ? 'Raise to' : 'Bet to'}
            </span>
            <input
              type="range"
              min={seatView.minRaiseTo}
              max={seatView.maxRaiseTo}
              step={1}
              value={clamp(raiseTo, seatView.minRaiseTo, seatView.maxRaiseTo)}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
              disabled={disabled}
              aria-label="Bet size"
              style={{ flex: 1, accentColor: '#f59e0b', minWidth: 0 }}
            />
            <input
              type="number"
              min={seatView.minRaiseTo}
              max={seatView.maxRaiseTo}
              value={clamp(raiseTo, seatView.minRaiseTo, seatView.maxRaiseTo)}
              onChange={(e) =>
                setRaiseTo(
                  clamp(
                    Math.floor(Number(e.target.value) || seatView.minRaiseTo),
                    seatView.minRaiseTo,
                    seatView.maxRaiseTo,
                  ),
                )
              }
              disabled={disabled}
              aria-label="Bet size (chips)"
              style={{
                width: 78,
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(245,158,11,0.4)',
                borderRadius: 6,
                color: '#fde68a',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 13,
                fontWeight: 700,
                padding: '5px 6px',
                textAlign: 'right',
              }}
            />
          </div>
          {/* Pot-fraction presets. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={disabled}
                onClick={() => setRaiseTo(p.to)}
                style={{
                  flex: isMobile ? '1 1 0' : '0 0 auto',
                  padding: '5px 12px',
                  borderRadius: 6,
                  background:
                    raiseTo === p.to ? 'rgba(245,158,11,0.25)' : 'rgba(0,0,0,0.35)',
                  border: `1px solid ${raiseTo === p.to ? '#f59e0b' : 'rgba(245,158,11,0.3)'}`,
                  color: '#fde68a',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, monospace',
                  fontWeight: 700,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons. */}
      <div style={{ display: 'flex', gap: 8 }}>
        {canFold && (
          <button
            type="button"
            style={btnStyle('fold', canFold)}
            disabled={disabled}
            onClick={() => dispatch({ kind: 'fold' })}
          >
            Fold
          </button>
        )}
        {canCheck && (
          <button
            type="button"
            style={btnStyle('check', canCheck)}
            disabled={disabled}
            onClick={() => dispatch({ kind: 'check' })}
          >
            Check
          </button>
        )}
        {canCall && seatView && (
          <button
            type="button"
            style={btnStyle('call', canCall)}
            disabled={disabled}
            onClick={() => dispatch({ kind: 'call' })}
          >
            Call {seatView.toCall > 0 ? seatView.toCall : ''}
          </button>
        )}
        {showSizing && seatView && (
          <button
            type="button"
            style={btnStyle('raise', showSizing)}
            disabled={disabled}
            onClick={() =>
              dispatch(
                sizingVerb === 'raise'
                  ? {
                      kind: 'raise',
                      amount: clamp(raiseTo, seatView.minRaiseTo, seatView.maxRaiseTo),
                    }
                  : {
                      kind: 'bet',
                      amount: clamp(raiseTo, seatView.minRaiseTo, seatView.maxRaiseTo),
                    },
              )
            }
          >
            {sizingVerb === 'raise' ? 'Raise' : 'Bet'} {clamp(raiseTo, seatView.minRaiseTo, seatView.maxRaiseTo)}
          </button>
        )}
      </div>
    </div>
  );
}
