'use client';

/**
 * Phase 6.7.0 — Per-event verifier page.
 *
 * Fetches the event by ID and dispatches to the correct per-game
 * verifier component based on `gameType`. Only slots ships in 6.7.0;
 * the other three games show a "ships in 6.7.X" placeholder until
 * their engines go real.
 *
 * Next.js 16 App Router: params is a Promise — unwrap via React `use()`.
 * Component is 'use client' because it imports SlotsEventVerifier which
 * uses WebCrypto + useEffect for browser-side replay.
 */

import { use } from 'react';
import Link from 'next/link';
import SlotsEventVerifier from '@/components/cove/history/SlotsEventVerifier';
import ServerEventVerifier from '@/components/cove/history/ServerEventVerifier';
import { useEffect, useState } from 'react';
import { fetchHistoryEvent, type CoveHistoryEventRow, type GameType } from '@/lib/cove/history-client';
import '@/styles/cove-tokens.css';

interface PageProps {
  params: Promise<{ eventId: string }>;
}

const GAME_LABEL: Record<GameType, string> = {
  slots: 'Slots',
  blackjack: 'Blackjack',
  holdem: "Hold'em",
  baccarat: 'Baccarat',
};

export default function CoveVerifyEventPage({ params }: PageProps) {
  const { eventId } = use(params);

  const [gameType, setGameType] = useState<GameType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Pre-fetch just the gameType for the dispatch header
  useEffect(() => {
    let cancelled = false;
    fetchHistoryEvent(eventId)
      .then((ev) => {
        if (!cancelled) setGameType(ev.gameType);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [eventId]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          'radial-gradient(ellipse at 50% 0%, rgba(123,47,247,0.10) 0%, transparent 55%), ' +
          'linear-gradient(180deg, #060a18 0%, #020408 100%)',
        color: '#e0fff8',
        fontFamily: 'monospace',
        padding: '40px 24px',
      }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Nav */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 4,
          }}
        >
          <h1
            style={{
              color: 'var(--cv-neon-cyan, #00ffe0)',
              fontSize: 20,
              fontWeight: 800,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              textShadow: '0 0 14px rgba(0,255,224,0.3)',
              margin: 0,
            }}
          >
            {gameType ? `${GAME_LABEL[gameType]} Verifier` : 'Event Verifier'}
          </h1>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link href="/cove/history" style={navLink()}>
              ← History
            </Link>
            <Link href="/cove/verify" style={navLink()}>
              Manual verifier
            </Link>
            <Link href="/cove" style={navLink()}>
              Cove
            </Link>
          </div>
        </div>

        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 4, marginBottom: 0 }}>
          Event: <code style={{ color: 'rgba(0,255,224,0.75)' }}>{eventId}</code>
        </p>

        {/* Dispatch */}
        {loadError ? (
          <ErrorCard>
            {loadError.includes('401')
              ? 'You must be signed in to verify this event.'
              : loadError.includes('403')
                ? 'This event belongs to a different account.'
                : loadError.includes('404')
                  ? 'Event not found.'
                  : loadError}
          </ErrorCard>
        ) : gameType === null ? (
          <InfoCard>Resolving event…</InfoCard>
        ) : gameType === 'slots' ? (
          <SlotsEventVerifier eventId={eventId} />
        ) : (
          <ServerEventVerifier eventId={eventId} gameType={gameType} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card helpers
// ---------------------------------------------------------------------------

function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: 16,
        borderRadius: 10,
        border: '1px solid rgba(0,255,224,0.14)',
        background: 'rgba(5,10,24,0.5)',
        color: 'rgba(224,255,248,0.55)',
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function ErrorCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: 16,
        borderRadius: 10,
        border: '1px solid rgba(255,56,96,0.35)',
        background: 'rgba(255,56,96,0.06)',
        color: '#ff8aa0',
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function navLink(): React.CSSProperties {
  return {
    color: 'rgba(0,255,224,0.7)',
    textDecoration: 'none',
    fontSize: 12,
    border: '1px solid rgba(0,255,224,0.35)',
    padding: '5px 11px',
    borderRadius: 6,
    fontFamily: 'monospace',
  };
}
