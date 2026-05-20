'use client';

/**
 * NeonModal — backdrop-blur dialog with ESC + click-outside close.
 *
 * Renders a fixed-position overlay (z-index defaults to 9998 so the
 * paytable + fairness modals stack above the slot screen at 9990 and
 * the win flash at 9999). Uses `role="dialog"` + `aria-modal` for AT
 * support and traps focus on the container via `tabIndex={-1}`.
 *
 * Animation: cv-modal-bg-in + cv-modal-in keyframes from
 * casino-tokens.css. No external lib; pure CSS.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

export interface NeonModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible label (announced by screen readers). */
  ariaLabel: string;
  /** Optional max width for the modal card. */
  maxWidth?: number;
  /** Optional z-index override (defaults to 9998). */
  zIndex?: number;
  /** When true, ESC + click-outside are both disabled. */
  persistent?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

export default function NeonModal({
  isOpen,
  onClose,
  ariaLabel,
  maxWidth = 540,
  zIndex = 9998,
  persistent,
  children,
  style,
}: NeonModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // ESC handler — bound at window level so it works no matter where
  // focus is inside the modal subtree.
  useEffect(() => {
    if (!isOpen || persistent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, persistent]);

  // Move focus into the modal on open for keyboard users.
  useEffect(() => {
    if (isOpen && cardRef.current) {
      const id = window.setTimeout(() => cardRef.current?.focus(), 16);
      return () => window.clearTimeout(id);
    }
  }, [isOpen]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (persistent) return;
      if (e.target === e.currentTarget) onClose();
    },
    [onClose, persistent],
  );

  if (!isOpen) return null;

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(2, 1, 3, 0.82)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
        padding: 'var(--cv-space-4)',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{
          background: 'var(--pt-velvet)',
          border: '1px solid var(--pt-brass)',
          boxShadow: 'var(--cv-shadow-modal)',
          color: 'var(--pt-cream)',
          fontFamily: 'var(--pt-data)',
          width: '100%',
          maxWidth,
          maxHeight: '86vh',
          overflowY: 'auto',
          padding: 'var(--cv-space-6)',
          animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          outline: 'none',
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}
