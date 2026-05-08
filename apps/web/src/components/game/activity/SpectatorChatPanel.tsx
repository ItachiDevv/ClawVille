'use client';

/**
 * SpectatorChatPanel — chat input + scrolling transcript scoped to the
 * spectator-only channel. Spec: frontend-spec.md §7.4.
 *
 * Chunk #11 wiring:
 *  - Send: `onSend(text)` posts a `chat` WS frame with `spectator: true`
 *    (additive protocol field). Server-side fan-out filtering is deferred
 *    to a future chunk; today the spectator only sees their OWN echoes
 *    plus any other client that also tagged `spectator: true`.
 *  - Transcript: rows from `selectSpectatorChat(state)` rendered in time
 *    order, newest at bottom. Auto-scrolls when a new row arrives.
 *
 * Sized to fit inside the EliminatedOverlay panel without taking the full
 * viewport. Fixed height with overflow-y: auto on the transcript.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ActivityChatMessage } from '@/stores/activity';

export interface SpectatorChatPanelProps {
  messages: ActivityChatMessage[];
  /** Resolves an avatarId to a friendly display name when available. */
  resolveName: (avatarId: string) => string;
  /** Self avatar id — own messages render with a distinct tint. */
  selfAvatarId: string | null;
  /** Returns true if the send succeeded (false if WS dropped, etc.). */
  onSend: (text: string) => boolean;
  /** Optional override for the panel max height (default 160). */
  maxHeight?: number;
}

/** Cap on per-message length matches `clientChatFrameSchema.text.max(140)`. */
const MAX_MESSAGE_LEN = 140;

export default function SpectatorChatPanel({
  messages,
  resolveName,
  selfAvatarId,
  onSend,
  maxHeight = 160,
}: SpectatorChatPanelProps) {
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when a new message arrives.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > MAX_MESSAGE_LEN) {
      setSendError(`Max ${MAX_MESSAGE_LEN} chars`);
      return;
    }
    const ok = onSend(trimmed);
    if (!ok) {
      setSendError('Disconnected — try reconnecting');
      return;
    }
    setDraft('');
    setSendError(null);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 9,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'rgba(0, 229, 255, 0.7)',
            fontWeight: 700,
          }}
        >
          Spectator Chat
        </span>
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 9,
            color: 'rgba(148, 163, 184, 0.6)',
            letterSpacing: '0.08em',
          }}
        >
          ghost-only · not visible to players
        </span>
      </div>
      <div
        ref={transcriptRef}
        style={{
          maxHeight,
          minHeight: 60,
          overflowY: 'auto',
          padding: '6px 8px',
          borderRadius: 6,
          background: 'rgba(2, 6, 14, 0.7)',
          border: '1px solid rgba(0, 229, 255, 0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        {messages.length === 0 ? (
          <span
            style={{
              fontSize: 10,
              color: 'rgba(148, 163, 184, 0.55)',
              fontStyle: 'italic',
              padding: '12px 4px',
              textAlign: 'center',
            }}
          >
            No spectator chatter yet — say hi.
          </span>
        ) : (
          messages.map((m, i) => {
            const isSelf = m.avatarId === selfAvatarId;
            const isEmote = Boolean(m.emoteId);
            return (
              <div
                key={`${m.at}-${i}`}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'flex-start',
                  fontSize: 11,
                  lineHeight: 1.3,
                }}
              >
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 9,
                    color: 'rgba(148, 163, 184, 0.55)',
                    flexShrink: 0,
                    paddingTop: 1,
                  }}
                >
                  {formatTime(m.at)}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                    fontWeight: 700,
                    fontSize: 10,
                    color: isSelf ? '#86efac' : '#7dd3fc',
                    flexShrink: 0,
                  }}
                >
                  {resolveName(m.avatarId)}
                </span>
                <span
                  style={{
                    color: isEmote ? '#facc15' : '#e2e8f0',
                    fontStyle: isEmote ? 'italic' : 'normal',
                    wordBreak: 'break-word',
                  }}
                >
                  {isEmote ? `* ${m.text}` : m.text}
                </span>
              </div>
            );
          })
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'stretch',
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (sendError) setSendError(null);
          }}
          maxLength={MAX_MESSAGE_LEN}
          placeholder="Spectator chat…"
          aria-label="Spectator chat message"
          data-hud-interactive="true"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid rgba(0, 229, 255, 0.4)',
            background: 'rgba(2, 6, 14, 0.85)',
            color: '#e0f7ff',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: 12,
            outline: 'none',
            pointerEvents: 'auto',
          }}
        />
        <button
          type="submit"
          data-hud-interactive="true"
          disabled={draft.trim().length === 0}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid rgba(0, 229, 255, 0.6)',
            background: draft.trim().length === 0
              ? 'rgba(15, 31, 58, 0.6)'
              : 'linear-gradient(180deg, rgba(0, 229, 255, 0.22), rgba(0, 229, 255, 0.08))',
            color: '#e0f7ff',
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            cursor: draft.trim().length === 0 ? 'not-allowed' : 'pointer',
            opacity: draft.trim().length === 0 ? 0.55 : 1,
            pointerEvents: 'auto',
          }}
        >
          Send
        </button>
      </form>
      {sendError && (
        <span
          role="alert"
          style={{
            fontSize: 10,
            color: '#fca5a5',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          {sendError}
        </span>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
