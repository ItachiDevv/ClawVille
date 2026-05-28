'use client';

import { useCallback, useState } from 'react';
import { useHistory, type GameType } from '@/lib/cove/history-client';
import HistoryFilterBar, { type HistoryFilters } from './HistoryFilterBar';
import HistoryRow from './HistoryRow';

export default function HistoryTable() {
  const [filters, setFilters] = useState<HistoryFilters>({
    game: undefined,
    outcome: undefined,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useHistory({
      game: filters.game as GameType | undefined,
      outcome: filters.outcome,
      limit: 50,
    });

  const handleFiltersChange = useCallback((next: HistoryFilters) => {
    setFilters(next);
  }, []);

  const allEvents = data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div>
      <HistoryFilterBar filters={filters} onChange={handleFiltersChange} />

      {isLoading ? (
        <LoadingCard>Loading history…</LoadingCard>
      ) : isError ? (
        <ErrorCard>
          {error instanceof Error ? error.message : 'Failed to load history.'}
        </ErrorCard>
      ) : allEvents.length === 0 ? (
        <EmptyCard>
          No game history yet
          {filters.game ? ` for ${filters.game}` : ''}
          {filters.outcome ? ` (${filters.outcome}s only)` : ''}.
          {!filters.game && !filters.outcome && (
            <> Play a game in the Cove to see your history here.</>
          )}
        </EmptyCard>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
            }}
          >
            <thead>
              <tr
                style={{
                  color: 'rgba(0,255,224,0.6)',
                  textAlign: 'left',
                  borderBottom: '1px solid rgba(0,255,224,0.12)',
                }}
              >
                <th style={th()}>Time</th>
                <th style={th()}>Game</th>
                <th style={{ ...th(), textAlign: 'right' }}>Bet</th>
                <th style={{ ...th(), textAlign: 'right' }}>P&amp;L</th>
                <th style={th()}>Result</th>
                <th style={th()}>Verify</th>
              </tr>
            </thead>
            <tbody>
              {allEvents.map((event) => (
                <HistoryRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>

          {/* Load more */}
          {hasNextPage && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                style={{
                  padding: '10px 24px',
                  borderRadius: 8,
                  border: '1px solid rgba(0,255,224,0.35)',
                  background: 'rgba(0,255,224,0.07)',
                  color: 'rgba(0,255,224,0.8)',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: isFetchingNextPage ? 'wait' : 'pointer',
                  opacity: isFetchingNextPage ? 0.6 : 1,
                  letterSpacing: '0.08em',
                }}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}

          {!hasNextPage && allEvents.length > 0 && (
            <div
              style={{
                marginTop: 14,
                textAlign: 'center',
                color: 'rgba(224,255,248,0.3)',
                fontSize: 11,
                fontFamily: 'monospace',
                letterSpacing: '0.08em',
              }}
            >
              End of history
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local card helpers
// ---------------------------------------------------------------------------

function th(): React.CSSProperties {
  return {
    padding: '8px 12px',
    fontFamily: 'monospace',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontSize: 10,
  };
}

function LoadingCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 10,
        border: '1px solid rgba(0,255,224,0.12)',
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
        marginTop: 16,
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

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 20,
        borderRadius: 10,
        border: '1px solid rgba(0,255,224,0.1)',
        background: 'rgba(5,10,24,0.4)',
        color: 'rgba(224,255,248,0.45)',
        fontFamily: 'monospace',
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
