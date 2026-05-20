'use client';

/**
 * NeonCard — sectioned content surface with title/subtitle.
 *
 * Uses the `--pt-velvet-soft` surface + brass rim. Title is rendered
 * as a small uppercase mono label (mirrors HUD typography). The card
 * is purely presentational — content shapes itself.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface NeonCardProps {
  /** Small label above the content. */
  title?: ReactNode;
  /** Optional secondary line under the title. */
  subtitle?: ReactNode;
  /** Action node aligned to the right of the title (close button, link, etc). */
  action?: ReactNode;
  /** Optional accent color override (defaults to brass). */
  accentColor?: string;
  /** Card padding override. */
  padding?: CSSProperties['padding'];
  /** Children rendered inside the card body. */
  children: ReactNode;
  style?: CSSProperties;
}

export default function NeonCard({
  title,
  subtitle,
  action,
  accentColor,
  padding,
  children,
  style,
}: NeonCardProps) {
  const accent = accentColor ?? 'var(--pt-brass)';
  return (
    <section
      style={{
        background: 'var(--pt-velvet-soft)',
        border: `1px solid ${accentColor ? accentColor + '55' : 'var(--pt-brass-dim)'}`,
        boxShadow: 'var(--cv-shadow-card)',
        padding: padding ?? 'var(--cv-space-5)',
        color: 'var(--pt-cream)',
        ...style,
      }}
    >
      {(title || subtitle || action) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--cv-space-3)',
            marginBottom: title || subtitle ? 'var(--cv-space-4)' : 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title && (
              <div
                style={{
                  color: accent,
                  fontFamily: 'var(--pt-data)',
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: 'var(--pt-label-letter)',
                  textTransform: 'uppercase',
                }}
              >
                {title}
              </div>
            )}
            {subtitle && (
              <div
                style={{
                  color: 'var(--pt-mute)',
                  fontSize: 12,
                  marginTop: 4,
                  fontFamily: 'var(--pt-data)',
                  letterSpacing: '0.04em',
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {action && <div style={{ flex: '0 0 auto' }}>{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
