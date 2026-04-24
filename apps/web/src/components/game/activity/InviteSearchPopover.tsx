'use client';

/**
 * InviteSearchPopover — stubbed party-invite popover for chunk #8.
 *
 * Renders a small popover anchored under the "+ Invite Friend / Agent"
 * button. Two filters: avatars (search by name) and agents (list connected
 * agents).
 *
 * Q2 reality:
 *   - There is no `/api/presence/search` endpoint yet (frontend-spec §2.5
 *     friend-system row is deferred — see Roadmap §7).
 *   - There is no "list my connected agents" endpoint yet — connected
 *     agents flow through `agent_connect_tokens` but no roster route
 *     exists.
 *
 * So this popover ships in a "Coming Soon" state for both filters. The
 * UI shape — title, search input, autocomplete list, click-to-invite —
 * is wired so chunk #11 (or a friend-system PR) can light it up by
 * dropping in a real fetcher. The "Coming Soon" copy is explicit
 * (anti-scaffolding-theater per CLAUDE.md).
 *
 * FEATURE_GATE: party_invite_search
 * Status: UI shell only — no fetch, no candidate list
 * Metric to graduate: presence/agent-roster endpoints exist + > 25 invites/wk
 * Current reading: 0 (endpoints not built)
 * Review deadline: 2026-06-15
 * On deadline: delete the popover; lobby keeps Solo + party-link-by-shortcode
 * Reference: frontend-spec §2.5; CLAUDE.md ZERO LAZINESS §Feature Gates
 */

import { useEffect, useRef, useState } from 'react';
import { StatusChip } from '@/components/rpg';

export type InviteFilter = 'avatars' | 'agents';

export interface InviteSearchPopoverProps {
  filter: InviteFilter;
  onClose: () => void;
  /** Callback fired when a candidate is selected (none in chunk #8). */
  onSelect?: (id: string) => void;
}

export default function InviteSearchPopover({
  filter,
  onClose,
}: InviteSearchPopoverProps) {
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside dismissal.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [onClose]);

  // ESC dismissal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const title = filter === 'avatars' ? 'Invite a Friend' : 'Invite an Agent';
  const placeholder =
    filter === 'avatars'
      ? 'Search avatars by name…'
      : 'Search your connected agents…';

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={title}
      style={{
        position: 'absolute',
        zIndex: 60,
        marginTop: 6,
        width: 280,
        background: 'rgba(10, 22, 40, 0.96)',
        border: '1px solid rgba(56, 189, 248, 0.35)',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            color: '#e2f2fc',
            fontWeight: 700,
            fontSize: 12,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {title}
        </div>
        <StatusChip tone="warning" size="sm" label="Coming Soon" />
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        disabled
        aria-disabled
        style={{
          width: '100%',
          padding: '6px 10px',
          background: 'rgba(15, 31, 58, 0.6)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          borderRadius: 4,
          color: 'rgba(148, 163, 184, 0.7)',
          fontSize: 12,
        }}
      />

      <div
        style={{
          color: 'rgba(148, 163, 184, 0.75)',
          fontSize: 11,
          lineHeight: 1.4,
        }}
      >
        {filter === 'avatars'
          ? 'Friend invites land with the friends panel — until then, queue solo or join a party with a short code.'
          : 'Agent-roster API is in flight. Connected agents will appear here once the listing endpoint ships.'}
      </div>

      <button
        type="button"
        onClick={onClose}
        style={{
          alignSelf: 'flex-end',
          padding: '4px 10px',
          background: 'rgba(15, 31, 58, 0.6)',
          border: '1px solid rgba(56, 189, 248, 0.25)',
          borderRadius: 4,
          color: '#7dd3fc',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          cursor: 'pointer',
        }}
      >
        Close
      </button>
    </div>
  );
}
