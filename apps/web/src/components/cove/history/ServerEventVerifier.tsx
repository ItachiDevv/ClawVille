'use client';

/**
 * Server-attested verifier for blackjack / hold'em / baccarat.
 *
 * These three engines have no in-browser replay (only slots ships a client-side
 * engine via `replaySpin`). Verification here is two-layer:
 *   1. TRUSTLESS commitment check, fully in-browser: sha256(revealedServerSeed)
 *      === serverSeedHash. This proves the server COMMITTED to the seed before
 *      the hand (the hash was shown up-front, the seed revealed only at shoe
 *      close) — the player verifies it locally with WebCrypto, trusting nobody.
 *   2. SERVER replay attestation via GET /api/cove/history/:id/verify: the API
 *      re-derives the hand from the revealed seed with the live engine and
 *      reports whether it matches the stored outcome. (Not yet a browser replay,
 *      so labelled as server-attested — honest about what is and isn't trustless.)
 *
 * Replaces the stale "ships in Phase 6.7.x" placeholder: the server-authoritative
 * commit-reveal engine + the /verify endpoint are live, so this surface is real.
 *
 * Used by `/cove/verify/[eventId]` when gameType is blackjack/holdem/baccarat.
 */

import { useEffect, useState } from 'react';
import { sha256Hex } from '@/lib/cove/verifier';
import {
  fetchHistoryEvent,
  fetchEventVerdict,
  type CoveHistoryEventRow,
  type EventVerifyResponse,
  type GameType,
} from '@/lib/cove/history-client';

interface Props {
  eventId: string;
  gameType: GameType;
}

const GAME_LABEL: Record<GameType, string> = {
  slots: 'Slots',
  blackjack: 'Blackjack',
  holdem: "Hold'em",
  baccarat: 'Baccarat',
};

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; event: CoveHistoryEventRow };

type VerifyState =
  | { status: 'idle' }
  | { status: 'running'; commitOk: boolean | null; computed: string | null }
  | { status: 'done'; verdict: EventVerifyResponse; commitOk: boolean; computed: string }
  | { status: 'error'; message: string; commitOk: boolean | null; computed: string | null };

export default function ServerEventVerifier({ eventId, gameType }: Props) {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' });

  // Fetch the event row.
  useEffect(() => {
    let cancelled = false;
    fetchHistoryEvent(eventId)
      .then((event) => {
        if (cancelled) return;
        if (event.gameType !== gameType) {
          setLoad({
            phase: 'error',
            message: `Event ${eventId} is a ${event.gameType} event, not ${gameType}.`,
          });
          return;
        }
        setLoad({ phase: 'loaded', event });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [eventId, gameType]);

  // Once loaded + the seed is revealed: run the in-browser commitment check, then
  // fetch the server verdict.
  useEffect(() => {
    if (load.phase !== 'loaded') return;
    const { event } = load;
    if (!event.revealedServerSeed) return;

    let cancelled = false;
    setVerify({ status: 'running', commitOk: null, computed: null });

    (async () => {
      // Layer 1 — trustless commitment check (in-browser).
      let commitOk = false;
      let computed = '(error)';
      try {
        computed = await sha256Hex(event.revealedServerSeed!.toLowerCase());
        commitOk = computed === event.serverSeedHash;
      } catch {
        // computed stays '(error)', commitOk stays false
      }
      if (cancelled) return;

      // Layer 2 — server replay attestation.
      try {
        const verdict = await fetchEventVerdict(eventId);
        if (!cancelled) setVerify({ status: 'done', verdict, commitOk, computed });
      } catch (err) {
        if (!cancelled) {
          setVerify({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
            commitOk,
            computed,
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [load, eventId]);

  if (load.phase === 'loading') return <InfoCard>Loading event…</InfoCard>;
  if (load.phase === 'error') return <ErrorCard>{load.message}</ErrorCard>;

  const { event } = load;
  const label = GAME_LABEL[gameType];

  // Resolve the headline verdict.
  const sealed = event.revealedServerSeed !== null;
  const serverVerified =
    verify.status === 'done' ? verify.verdict.verified : undefined; // true | false | null | undefined(loading)
  const commitOk = verify.status === 'done' || verify.status === 'error' || verify.status === 'running'
    ? verify.commitOk
    : null;
  const computed = verify.status === 'done' || verify.status === 'error' || verify.status === 'running'
    ? verify.computed
    : null;

  return (
    <div>
      <MetaPanel event={event} label={label} commitOk={commitOk} computed={computed} />

      {!sealed && (
        <InfoCard style={{ marginTop: 12 }}>
          Verification unlocks after the session closes and the server seed is revealed.
          Finish your open hand and cash out (close the shoe), then refresh this page —
          the revealed seed lets you confirm the commitment hash yourself, in your browser.
        </InfoCard>
      )}

      {sealed && verify.status === 'running' && (
        <InfoCard style={{ marginTop: 12 }}>Verifying…</InfoCard>
      )}

      {sealed && verify.status === 'error' && (
        <ErrorCard style={{ marginTop: 12 }}>
          Could not reach the server verifier: {verify.message}. The commitment check above is
          independent of the server and still holds.
        </ErrorCard>
      )}

      {sealed && verify.status === 'done' && (
        <VerdictPanel
          label={label}
          commitOk={verify.commitOk}
          verified={serverVerified ?? null}
          verdict={verify.verdict}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VerdictPanel({
  label,
  commitOk,
  verified,
  verdict,
}: {
  label: string;
  commitOk: boolean;
  verified: boolean | null;
  verdict: EventVerifyResponse;
}) {
  // Overall fairness = commitment holds AND server replay matched.
  const pending = verified === null;
  const ok = commitOk && verified === true;
  const tone = pending ? 'pending' : ok ? 'ok' : 'fail';
  const border =
    tone === 'ok' ? 'rgba(0,255,100,0.45)' : tone === 'fail' ? 'rgba(255,56,96,0.5)' : 'rgba(0,255,224,0.2)';
  const bg =
    tone === 'ok' ? 'rgba(0,255,100,0.05)' : tone === 'fail' ? 'rgba(255,56,96,0.06)' : 'rgba(5,10,24,0.5)';

  const reason = verdict.verified !== true ? (verdict as { reason?: string }).reason : undefined;
  const expected = verdict.verified !== null ? (verdict.expected as Record<string, unknown> | null) : null;
  const stored = verdict.stored as Record<string, unknown> | undefined;

  return (
    <div style={{ marginTop: 16, padding: 18, borderRadius: 12, border: `1px solid ${border}`, background: bg }}>
      <VerdictHeading
        tone={tone}
        label={
          pending
            ? 'Awaiting server-seed reveal'
            : ok
              ? `Provably fair — ${label} hand verified`
              : 'Mismatch — this hand did not verify'
        }
      />

      {/* Layer 1 — trustless commitment, computed in YOUR browser */}
      <Line tone={commitOk ? 'ok' : 'fail'}>
        {commitOk
          ? '✓ Commitment check (in your browser): sha256(serverSeed) = serverSeedHash'
          : '✗ Commitment check FAILED: sha256(serverSeed) ≠ serverSeedHash'}
      </Line>

      {/* Layer 2 — server replay attestation */}
      {pending ? (
        <Line tone="dim">
          Server replay pending — {reason === 'shoe-not-yet-closed'
            ? 'the session is still open.'
            : 'engine replay not available for this row version.'}
        </Line>
      ) : (
        <Line tone={verdict.verified === true ? 'ok' : 'fail'}>
          {verdict.verified === true
            ? '✓ Server replay: re-derived this hand from the revealed seed; it matches the stored outcome.'
            : `✗ Server replay diverged${reason ? `: ${reason}` : ''}.`}
        </Line>
      )}

      <div style={{ color: 'rgba(0,255,224,0.4)', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 14, marginBottom: 6 }}>
        Stored outcome
      </div>
      <OutcomeJson value={stored ?? null} />

      {verdict.verified === false && expected && (
        <>
          <div style={{ color: '#ff8aa0', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 12, marginBottom: 6 }}>
            Expected (server replay)
          </div>
          <OutcomeJson value={expected} />
        </>
      )}
    </div>
  );
}

function MetaPanel({
  event,
  label,
  commitOk,
  computed,
}: {
  event: CoveHistoryEventRow;
  label: string;
  commitOk: boolean | null;
  computed: string | null;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        border: '1px solid rgba(0,255,224,0.16)',
        background: 'rgba(5,10,24,0.65)',
        display: 'grid',
        gap: 5,
        fontSize: 12,
        fontFamily: 'monospace',
        marginTop: 12,
      }}
    >
      <MetaRow label="game" value={label} />
      <MetaRow label="eventId" value={event.id} mono />
      <MetaRow label="engine" value={event.engineVersion} />
      <MetaRow label="nonce" value={String(event.nonce)} />
      <MetaRow label="bet" value={`${event.betAmount} CT`} />
      <MetaRow label="payout" value={`${event.payout} CT`} />
      <MetaRow label="serverSeedHash" value={event.serverSeedHash} mono />
      <MetaRow
        label="serverSeed"
        value={event.revealedServerSeed ?? '(redacted — session open)'}
        mono
        tone={event.revealedServerSeed ? 'ok' : 'dim'}
      />
      <MetaRow label="clientSeed" value={event.clientSeed} mono />
      {commitOk !== null && computed !== null && (
        <MetaRow
          label="commitment"
          value={commitOk ? 'sha256(serverSeed) matches serverSeedHash' : `MISMATCH — sha256(serverSeed) = ${computed}`}
          tone={commitOk ? 'ok' : 'fail'}
        />
      )}
    </div>
  );
}

function OutcomeJson({ value }: { value: Record<string, unknown> | null }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        borderRadius: 8,
        border: '1px solid rgba(0,255,224,0.12)',
        background: 'rgba(2,4,8,0.6)',
        color: '#9bfff0',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.5,
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {value ? JSON.stringify(value, null, 2) : '(none)'}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Presentational atoms (self-contained — slots verifier keeps its own copies)
// ---------------------------------------------------------------------------

function VerdictHeading({ tone, label }: { tone: 'ok' | 'fail' | 'pending'; label: string }) {
  const color = tone === 'ok' ? '#7cff9a' : tone === 'fail' ? '#ff8aa0' : 'rgba(0,255,224,0.8)';
  return (
    <div
      style={{
        color,
        fontFamily: 'monospace',
        fontSize: 16,
        fontWeight: 800,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        marginBottom: 12,
      }}
    >
      {label}
    </div>
  );
}

function Line({ tone, children }: { tone: 'ok' | 'fail' | 'dim'; children: React.ReactNode }) {
  const color = tone === 'ok' ? '#7cff9a' : tone === 'fail' ? '#ff8aa0' : 'rgba(224,255,248,0.6)';
  return (
    <div style={{ color, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, marginBottom: 6 }}>
      {children}
    </div>
  );
}

function MetaRow({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'ok' | 'dim' | 'fail' }) {
  const color =
    tone === 'ok' ? '#7cff9a' : tone === 'fail' ? '#ff8aa0' : tone === 'dim' ? 'rgba(224,255,248,0.35)' : '#d0ece8';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ color: 'rgba(0,255,224,0.5)', minWidth: 140 }}>{label}</span>
      <span style={{ color, fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function InfoCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        border: '1px solid rgba(0,255,224,0.14)',
        background: 'rgba(5,10,24,0.5)',
        color: 'rgba(224,255,248,0.6)',
        fontFamily: 'monospace',
        fontSize: 13,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function ErrorCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        border: '1px solid rgba(255,56,96,0.35)',
        background: 'rgba(255,56,96,0.06)',
        color: '#ff8aa0',
        fontFamily: 'monospace',
        fontSize: 13,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
