'use client';

/**
 * PaytableModal — symbol payout table + line pattern viewer
 *
 * Reads directly from CLASSIC_SYMBOLS and CLASSIC_LINES constants
 * so it always matches the live paytable.
 *
 * Iris Xe safe: pure DOM/CSS, zero Three.js.
 */

import { useCallback } from 'react';
import { CLASSIC_SYMBOLS, CLASSIC_LINES } from '@clawville/shared';

export interface PaytableModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Mini line diagram — 5×3 grid showing which cells are on a payline
// ---------------------------------------------------------------------------
function LineDiagram({ rows, color }: { rows: [number, number, number, number, number]; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {rows.map((row, reel) => (
        <div
          key={reel}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {[0, 1, 2].map((r) => (
            <div
              key={r}
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: r === row ? color : 'rgba(255,255,255,0.08)',
                boxShadow: r === row ? `0 0 4px ${color}` : 'none',
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function PaytableModal({ isOpen, onClose }: PaytableModalProps) {
  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Paytable"
      onKeyDown={handleKey}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(6px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'rgba(10,0,21,0.97)',
          border: '1px solid rgba(0,255,224,0.3)',
          borderRadius: 16,
          maxWidth: 520,
          width: '94vw',
          maxHeight: '86vh',
          overflowY: 'auto',
          padding: '24px 28px',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ color: '#00ffe0', fontFamily: 'monospace', fontSize: 16, fontWeight: 800, margin: 0, letterSpacing: '0.1em' }}>
            PAYTABLE — CLASSIC 3×5
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)',
              fontSize: 20, cursor: 'pointer', padding: '2px 6px', lineHeight: 1,
            }}
            aria-label="Close paytable"
          >
            ✕
          </button>
        </div>

        {/* Symbol payouts */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, letterSpacing: '0.12em', fontFamily: 'monospace', marginBottom: 10, textTransform: 'uppercase' }}>
            Symbol Payouts (× Bet)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {CLASSIC_SYMBOLS.map((sym) => (
              <div
                key={sym.id}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${sym.color}44`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                {/* Symbol */}
                <div style={{
                  fontSize: 24,
                  width: 32,
                  textAlign: 'center',
                  background: `radial-gradient(circle, ${sym.color}33 0%, transparent 100%)`,
                  borderRadius: 6,
                }}>
                  {sym.emoji}
                </div>

                {/* Payouts */}
                <div style={{ flex: 1 }}>
                  <div style={{ color: sym.color, fontFamily: 'monospace', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                    {sym.name}{sym.isWild ? ' (WILD)' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {sym.payouts.map((p, i) => (
                      p > 0 && (
                        <span key={i} style={{
                          background: `${sym.color}22`,
                          color: sym.color,
                          fontFamily: 'monospace',
                          fontSize: 10,
                          padding: '2px 5px',
                          borderRadius: 3,
                          whiteSpace: 'nowrap',
                        }}>
                          {i + 2}× = {p}×
                        </span>
                      )
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Line patterns */}
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, letterSpacing: '0.12em', fontFamily: 'monospace', marginBottom: 10, textTransform: 'uppercase' }}>
            20 Paylines
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {CLASSIC_LINES.map((line) => (
              <div key={line.id} style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                background: 'rgba(255,255,255,0.03)',
                borderRadius: 6,
                padding: '6px 4px',
                border: `1px solid ${line.color}33`,
              }}>
                <div style={{ color: line.color, fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.08em' }}>
                  #{line.id + 1}
                </div>
                <LineDiagram rows={line.rows} color={line.color} />
              </div>
            ))}
          </div>
        </div>

        {/* RTP notice */}
        <div style={{
          marginTop: 20,
          padding: '10px 14px',
          background: 'rgba(0,255,224,0.05)',
          border: '1px solid rgba(0,255,224,0.15)',
          borderRadius: 8,
          color: 'rgba(255,255,255,0.5)',
          fontSize: 11,
          fontFamily: 'monospace',
          lineHeight: 1.6,
        }}>
          Theoretical RTP: <span style={{ color: '#00ffe0' }}>96%</span> · 20 paylines · Left-to-right matching
          <br/>
          Wild substitutes any non-scatter symbol · Free spins coming in Phase 6.1
        </div>
      </div>
    </div>
  );
}
