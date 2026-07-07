'use client';

/**
 * RpgModal — the full-screen modal shell every Gameify feature mounts inside.
 *
 * Replaces the generic `fixed inset-0 bg-black/70` pattern. Renders the
 * radial vignette backdrop, the rune-framed shell (via RuneFrame), a header
 * with title/subtitle and close button, a scrollable body, and an optional
 * footer slot for CTAs.
 *
 * Controls
 * --------
 *   open      — visibility toggle. When false, returns null (no DOM).
 *   onClose   — called on backdrop click, close button, or Escape.
 *   title     — main header text (Orbitron display font).
 *   subtitle  — small uppercase tagline under the title.
 *   tier      — rarity that drives the frame glow (defaults to 'rare' cyan).
 *   glow      — override the tier's automatic glow setting.
 *   headerIcon — optional icon node (e.g. crest, sigil) rendered to the left of title.
 *   tokenBadge — optional right-side slot for a currency pill (e.g. a CT balance).
 *   footer    — optional footer slot rendered below the scroll body.
 *   maxWidth  — override the default 960px max-width for wider content.
 *
 * Escape handling: listens for `keydown` on `window` while open and calls
 * `onClose()`. The parent is responsible for any nested escape state (review
 * form dismissal, etc.) by intercepting escape BEFORE the RpgModal sees it
 * (quest-board-modal does this via its own useEffect for its nested submission modal).
 *
 * Usage
 * -----
 *   <RpgModal
 *     open={questBoardOpen}
 *     onClose={closeQuestBoard}
 *     title="Quest Board"
 *     subtitle="Earn · Compete"
 *     tier="rare"
 *     tokenBadge={<span>{tokens} CT</span>}
 *   >
 *     <QuestBoardBody />
 *   </RpgModal>
 */

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { RuneFrame } from './rune-frame';
import type { RuneFrameGlow } from './rune-frame';
import type { RarityId } from './rarity';

export interface RpgModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  tier?: RarityId;
  glow?: RuneFrameGlow;
  headerIcon?: ReactNode;
  tokenBadge?: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  children?: ReactNode;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

export function RpgModal({
  open,
  onClose,
  title,
  subtitle,
  tier = 'rare',
  glow = 'subtle',
  headerIcon,
  tokenBadge,
  footer,
  maxWidth = 960,
  className,
  bodyClassName,
  style,
  children,
  closeOnBackdrop = true,
  closeOnEscape = true,
}: RpgModalProps) {
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  const shellStyle: CSSProperties = { maxWidth, ...style };

  return (
    <div
      className="rpg-modal-backdrop"
      onClick={closeOnBackdrop ? onClose : undefined}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rpg-modal-shell"
        style={shellStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <RuneFrame
          tier={tier}
          glow={glow}
          className={className}
          style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
        >
          <header className="rpg-modal-shell__header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              {headerIcon && (
                <div
                  style={{
                    flexShrink: 0,
                    width: 42,
                    height: 42,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    background: 'rgba(15, 31, 58, 0.85)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    fontSize: 22,
                  }}
                >
                  {headerIcon}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <h2 className="rpg-modal-shell__title">{title}</h2>
                {subtitle && <p className="rpg-modal-shell__subtitle">{subtitle}</p>}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {tokenBadge}
              <button
                type="button"
                onClick={onClose}
                className="rpg-modal-shell__close"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </header>

          <div
            className={['rpg-modal-shell__body', bodyClassName]
              .filter(Boolean)
              .join(' ')}
          >
            {children}
          </div>

          {footer && <div className="rpg-modal-shell__footer">{footer}</div>}
        </RuneFrame>
      </div>
    </div>
  );
}
