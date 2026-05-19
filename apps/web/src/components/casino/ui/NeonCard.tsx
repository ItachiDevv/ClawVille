'use client';

/**
 * NeonCard — sectioned content surface with title/subtitle.
 *
 * Uses the `--cv-surface-2` gradient + soft cyan rim. Title is rendered
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
  /** Optional accent color override (defaults to neon cyan). */
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
  const accent = accentColor ?? 'var(--cv-neon-cyan)';
  return (
    <section
      style={{
        background: 'var(--cv-surface-2)',
        border: `1px solid ${accentColor ? accentColor + '33' : 'rgba(0,255,224,0.18)'}`,
        borderRadius: 'var(--cv-radius-lg)',
        boxShadow: 'var(--cv-shadow-card)',
        padding: padding ?? 'var(--cv-space-5)',
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
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  textShadow: `0 0 12px ${accent}`,
                }}
              >
                {title}
              </div>
            )}
            {subtitle && (
              <div
                style={{
                  color: 'rgba(255,255,255,0.55)',
                  fontSize: 12,
                  marginTop: 4,
                  fontFamily: 'monospace',
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
