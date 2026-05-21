'use client';

/**
 * PaytableModal — symbol payout table + line pattern viewer
 *
 * Polish pass (Concern 6.0.4):
 *   - Built on NeonModal + NeonCard primitives
 *   - Symbol rows render the SVG asset (with emoji fallback)
 *   - Payout chips use the symbol's theme color
 *   - Line diagrams keep the original 5×3 dot grid (works great mobile)
 *
 * Reads directly from CLASSIC_SYMBOLS / CLASSIC_LINES /
 * CLASSIC_SLOT_SYMBOL_ASSETS so it always matches the live paytable
 * and asset manifest.
 *
 * Iris Xe safe: pure DOM/CSS, zero Three.js.
 */

import { useState } from 'react';
import { CLASSIC_SYMBOLS, CLASSIC_LINES, CLASSIC_SLOT_SYMBOL_ASSETS } from '@clawville/shared';
import { NeonModal, NeonCard, NeonButton } from './ui';

export interface PaytableModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Symbol art with SVG → emoji fallback
// ---------------------------------------------------------------------------

function SymbolArt({ id, size = 40 }: { id: number; size?: number }) {
  const sym = CLASSIC_SYMBOLS[id] ?? CLASSIC_SYMBOLS[0];
  const asset = CLASSIC_SLOT_SYMBOL_ASSETS[id] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
  const [failed, setFailed] = useState(false);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `radial-gradient(circle, ${asset.themeColor}22 0%, transparent 70%)`,
        borderRadius: 'var(--cv-radius-sm)',
        flexShrink: 0,
      }}
    >
      {failed ? (
        <span style={{ fontSize: size * 0.6, lineHeight: 1 }}>{sym.emoji}</span>
      ) : (
        <img
          src={asset.svgPath}
          alt={asset.displayName}
          draggable={false}
          onError={() => setFailed(true)}
          style={{ width: '85%', height: '85%', objectFit: 'contain' }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini line diagram — 5×3 grid showing which cells are on a payline
// ---------------------------------------------------------------------------
function LineDiagram({ rows, color }: { rows: [number, number, number, number, number]; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {rows.map((row, reel) => (
        <div key={reel} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {[0, 1, 2].map((r) => (
            <div
              key={r}
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: r === row ? color : 'rgba(255,255,255,0.08)',
                boxShadow: r === row ? `0 0 6px ${color}` : 'none',
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
  return (
    <NeonModal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Paytable"
      maxWidth={560}
      zIndex={9998}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 'var(--cv-space-5)',
      }}>
        <div>
          <div className="pt-fairness-eyebrow">Predict Terminal</div>
          <h2 className="pt-fairness-title" style={{ margin: '4px 0 0 0' }}>
            Paytable — Classic 3×5
          </h2>
        </div>
        <NeonButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close paytable"
          style={{ width: 36, padding: 0 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </NeonButton>
      </div>

      {/* Symbol payouts */}
      <NeonCard
        title="Symbol Payouts (× Predict)"
        style={{ marginBottom: 'var(--cv-space-5)' }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--cv-space-2)' }}>
          {CLASSIC_SYMBOLS.map((sym) => {
            const asset = CLASSIC_SLOT_SYMBOL_ASSETS[sym.id] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
            return (
              <div
                key={sym.id}
                style={{
                  background: 'var(--pt-velvet-soft)',
                  border: `1px solid ${asset.themeColor}33`,
                  padding: 'var(--cv-space-2) var(--cv-space-3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--cv-space-3)',
                }}
              >
                <SymbolArt id={sym.id} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    color: asset.themeColor,
                    fontFamily: 'var(--pt-data)',
                    fontSize: 12,
                    fontWeight: 500,
                    marginBottom: 4,
                    letterSpacing: 'var(--pt-label-letter)',
                    textTransform: 'uppercase',
                  }}>
                    {asset.displayName}{sym.isWild ? ' · WILD' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {sym.payouts.map((p, i) => (
                      p > 0 && (
                        <span key={i} style={{
                          background: `${asset.themeColor}1f`,
                          color: asset.themeColor,
                          fontFamily: 'var(--pt-data)',
                          fontSize: 10,
                          padding: '2px 6px',
                          whiteSpace: 'nowrap',
                          border: `1px solid ${asset.themeColor}33`,
                        }}>
                          {i + 2}× = {p}×
                        </span>
                      )
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </NeonCard>

      {/* Line patterns */}
      <NeonCard title="20 Paylines">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 'var(--cv-space-2)' }}>
          {CLASSIC_LINES.map((line) => (
            <div key={line.id} style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              background: 'var(--pt-velvet-soft)',
              padding: '8px 6px',
              border: `1px solid ${line.color}33`,
            }}>
              <div style={{
                color: line.color,
                fontFamily: 'var(--pt-data)',
                fontSize: 9,
                letterSpacing: '0.1em',
              }}>
                #{line.id + 1}
              </div>
              <LineDiagram rows={line.rows} color={line.color} />
            </div>
          ))}
        </div>
      </NeonCard>

      {/* RTP notice */}
      <div style={{
        marginTop: 'var(--cv-space-5)',
        padding: 'var(--cv-space-3) var(--cv-space-4)',
        background: 'var(--pt-velvet-soft)',
        border: '1px solid var(--pt-brass-dim)',
        color: 'var(--pt-cream-soft)',
        fontSize: 11,
        fontFamily: 'var(--pt-data)',
        lineHeight: 1.7,
      }}>
        Theoretical RTP: <span style={{ color: 'var(--pt-amber)', fontWeight: 700 }}>94%</span> · 20 paylines · Left-to-right matching
        <br/>
        Wild substitutes any non-scatter symbol · Free spins active in Phase 6.1
      </div>
    </NeonModal>
  );
}
