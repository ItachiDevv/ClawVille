'use client';

/**
 * PartySlot — a single row in the lobby's party panel.
 *
 * Two visual variants:
 *   - `filled`: shows a member (icon + name + ready chip + optional kick)
 *   - `empty`:  shows an invite/share CTA
 *
 * Per locked Q2 decision the party cap is 4 (mirrored from the server's
 * `MAX_PARTY_SIZE = 4` constant in `apps/api/src/services/activity/
 * activity-queue.ts`). The lobby renders the current roster plus share-code
 * rows up to that cap.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §2.2 / §13.2.
 */

import { StatusChip } from '@/components/rpg';
import type { ReactNode } from 'react';

export interface PartySlotMember {
  avatarId: string;
  displayName: string;
  /** Avatar emoji / species-derived avatar character. Defaults to 🦞. */
  icon?: string;
  /** Are they ready (true) or still queuing in (false)? */
  ready: boolean;
  /** Mark this row as the local player. */
  isSelf?: boolean;
  /** Mark this row as a connected agent (renders 🤖 prefix in chip). */
  isAgent?: boolean;
}

export interface PartySlotProps {
  /** When provided renders a "filled" slot. Otherwise renders empty CTA. */
  member?: PartySlotMember;
  /** CTA label when empty (e.g. "+ Invite Friend", "+ Invite Agent"). */
  ctaLabel?: string;
  /** Disable the empty-slot CTA — used when the system is gated. */
  ctaDisabled?: boolean;
  /** Tooltip explaining why the empty-slot CTA is disabled. */
  ctaDisabledReason?: string;
  /** Click handler for empty-slot CTAs. */
  onClick?: () => void;
  /** Optional kick handler (rendered as small button on filled rows). */
  onKick?: () => void;
  /** Render slot footer content (e.g. small subtitle). */
  footer?: ReactNode;
}

export default function PartySlot({
  member,
  ctaLabel = '+ Invite',
  ctaDisabled = false,
  ctaDisabledReason,
  onClick,
  onKick,
  footer,
}: PartySlotProps) {
  if (!member) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={ctaDisabled}
        title={ctaDisabled ? ctaDisabledReason : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minHeight: 44,
          padding: '8px 12px',
          borderRadius: 6,
          background: 'rgba(15, 31, 58, 0.4)',
          border: '1px dashed rgba(56, 189, 248, 0.35)',
          color: ctaDisabled ? 'rgba(148, 163, 184, 0.5)' : '#7dd3fc',
          fontWeight: 600,
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          cursor: ctaDisabled ? 'not-allowed' : 'pointer',
          transition: 'background 120ms, border-color 120ms',
        }}
        onMouseEnter={(e) => {
          if (!ctaDisabled) {
            e.currentTarget.style.background = 'rgba(15, 31, 58, 0.7)';
            e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.6)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(15, 31, 58, 0.4)';
          e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.35)';
        }}
      >
        {ctaLabel}
      </button>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: 44,
        padding: '8px 12px',
        borderRadius: 6,
        background: member.isSelf
          ? 'rgba(56, 189, 248, 0.10)'
          : 'rgba(15, 31, 58, 0.6)',
        border: `1px solid ${
          member.isSelf
            ? 'rgba(56, 189, 248, 0.45)'
            : 'rgba(56, 189, 248, 0.18)'
        }`,
      }}
    >
      <span
        style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}
        aria-hidden
      >
        {member.icon ?? (member.isAgent ? '🤖' : '🦞')}
      </span>
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <div
          style={{
            color: '#e2f2fc',
            fontWeight: 700,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {member.displayName}
          {member.isSelf && (
            <span
              style={{
                marginLeft: 6,
                color: 'rgba(125, 211, 252, 0.7)',
                fontWeight: 500,
                fontSize: 11,
              }}
            >
              (you)
            </span>
          )}
        </div>
        {footer && (
          <div style={{ color: 'rgba(148, 163, 184, 0.85)', fontSize: 11 }}>
            {footer}
          </div>
        )}
      </div>
      <StatusChip
        tone={member.ready ? 'positive' : 'neutral'}
        size="sm"
        label={member.ready ? 'Ready ✓' : 'Waiting'}
      />
      {onKick && !member.isSelf && (
        <button
          type="button"
          onClick={onKick}
          aria-label={`Remove ${member.displayName}`}
          style={{
            width: 24,
            height: 24,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            background: 'transparent',
            border: '1px solid rgba(248, 113, 113, 0.35)',
            color: '#f87171',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
