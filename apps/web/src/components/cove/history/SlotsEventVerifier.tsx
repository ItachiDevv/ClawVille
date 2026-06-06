'use client';

/**
 * Phase 6.7.0 — Single-event slot verifier component.
 *
 * Two-layer verification:
 *   1. Client-side commitment check: sha256(revealedServerSeed) === serverSeedHash
 *   2. Client-side spin replay via replaySpin() using cursorBefore/predict/nonce
 *      from outcomeJson (impl-schema backfill projects these into every slots row).
 *      Falls back to server verdict via fetchEventVerdict() if replaySpin throws
 *      (e.g. legacy row with missing fields, paytable mismatch).
 *
 * Used by `/cove/verify/[eventId]` when `gameType === 'slots'`.
 */

import { useEffect, useState } from 'react';
import { replaySpin, sha256Hex, type SpinReplayVerdict } from '@/lib/cove/verifier';
import {
  fetchHistoryEvent,
  fetchEventVerdict,
  type CoveHistoryEventRow,
  type EventVerifyResponse,
} from '@/lib/cove/history-client';
import type { MachineSlug, SymbolId, WildMultiplier } from '@/lib/cove/types';

// ---------------------------------------------------------------------------
// Slots outcomeJson shape — impl-schema is authoritative.
// Backfill projects cursorBefore/cursorAfter/predict into every slots row.
// predict is a stringified bigint (stored alongside betAmount for self-contained
// replay). kind discriminant added by impl-schema for future multi-game outcomeJson.
// ---------------------------------------------------------------------------

interface SlotsOutcome {
  kind: 'slots';
  paytableId: MachineSlug;
  reels: SymbolId[][];
  winningLines: unknown[];  // serialized WinningLine records — winAmount is string on wire, bigint in memory
  winAmount: string;
  isFreeSpin: boolean;
  predict: string;      // stringified bigint — use BigInt(predict) for replaySpin
  cursorBefore: number;
  cursorAfter: number;
  wildMultipliers?: WildMultiplier[];
  scatterPayout?: string;
}

const BIGINT_STRING = /^\d+$/;

function isSlotsOutcome(o: unknown): o is SlotsOutcome {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    r.kind === 'slots' &&
    typeof r.paytableId === 'string' &&
    Array.isArray(r.reels) &&
    typeof r.winAmount === 'string' &&
    typeof r.predict === 'string' &&
    BIGINT_STRING.test(r.predict) &&   // guard BigInt() throw on malformed predict
    typeof r.cursorBefore === 'number' &&
    typeof r.cursorAfter === 'number'
  );
}

// ---------------------------------------------------------------------------
// Props + local state types
// ---------------------------------------------------------------------------

interface SlotsEventVerifierProps {
  eventId: string;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; event: CoveHistoryEventRow; outcome: SlotsOutcome };

type VerifyState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'client'; verdict: SpinReplayVerdict; commitOk: boolean; computed: string }
  | { status: 'server'; verdict: EventVerifyResponse; commitOk: boolean; computed: string }
  | { status: 'error'; message: string; commitOk: boolean; computed: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SlotsEventVerifier({ eventId }: SlotsEventVerifierProps) {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' });

  // Fetch the event row
  useEffect(() => {
    let cancelled = false;
    fetchHistoryEvent(eventId)
      .then((event) => {
        if (cancelled) return;
        if (event.gameType !== 'slots') {
          setLoad({ phase: 'error', message: `Event ${eventId} is not a slots event (got ${event.gameType})` });
          return;
        }
        if (!isSlotsOutcome(event.outcomeJson)) {
          setLoad({
            phase: 'error',
            message:
              'This row cannot be verified yet — outcomeJson is missing required fields (kind, predict, cursorBefore, cursorAfter). The row was written before full verifier support landed; try again after the next history backfill, or contact support.',
          });
          return;
        }
        setLoad({ phase: 'loaded', event, outcome: event.outcomeJson });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [eventId]);

  // Run verification when loaded + seed revealed
  useEffect(() => {
    if (load.phase !== 'loaded') return;
    const { event, outcome } = load;
    if (!event.revealedServerSeed) return;

    let cancelled = false;
    setVerify({ status: 'running' });

    (async () => {
      // Layer 1 — commitment check: sha256(serverSeed) === serverSeedHash
      let commitOk = false;
      let computed = '(error)';
      try {
        computed = await sha256Hex(event.revealedServerSeed!.toLowerCase());
        commitOk = computed === event.serverSeedHash;
      } catch {
        // computed stays '(error)', commitOk stays false
      }

      if (cancelled) return;

      // Layer 2a — client-side replaySpin (uses cursorBefore/predict from outcomeJson)
      try {
        const versionTag = event.engineVersion.replace('slot-engine-', '');
        const paytableVersion: 'v1' | 'v2' = versionTag === 'v1' ? 'v1' : 'v2';

        const verdict = await replaySpin({
          paytableId: outcome.paytableId,
          serverSeed: event.revealedServerSeed!,
          clientSeed: event.clientSeed,
          nonce: event.nonce,
          cursor: outcome.cursorBefore,
          predict: BigInt(outcome.predict),
          freeSpinMode: outcome.isFreeSpin,
          paytableVersion,
          expected: {
            reels: outcome.reels,
            winAmount: outcome.winAmount,
            cursorAfter: outcome.cursorAfter,
            wildMultipliers: outcome.wildMultipliers,
            scatterPayout: outcome.scatterPayout,
          },
        });

        if (!cancelled) setVerify({ status: 'client', verdict, commitOk, computed });
        return;
      } catch (err) {
        // Client replay failed (legacy row / engine gap) — fall through to server verdict
        if (cancelled) return;
        const fallbackMsg = err instanceof Error ? err.message : String(err);

        try {
          const serverVerdict = await fetchEventVerdict(eventId);
          if (!cancelled) setVerify({ status: 'server', verdict: serverVerdict, commitOk, computed });
        } catch (serverErr) {
          if (!cancelled) {
            setVerify({
              status: 'error',
              message: `Client replay failed: ${fallbackMsg}. Server verdict also failed: ${serverErr instanceof Error ? serverErr.message : String(serverErr)}`,
              commitOk,
              computed,
            });
          }
        }
      }
    })();

    return () => { cancelled = true; };
  }, [load, eventId]);

  if (load.phase === 'loading') {
    return <InfoCard>Loading event…</InfoCard>;
  }

  if (load.phase === 'error') {
    return <ErrorCard>{load.message}</ErrorCard>;
  }

  const { event, outcome } = load;

  return (
    <div>
      <MetaPanel event={event} outcome={outcome} verify={verify} />

      {event.revealedServerSeed === null && (
        <InfoCard style={{ marginTop: 12 }}>
          Verification is available after the session closes and the server seed is revealed.
          Refresh this page after cashing out.
        </InfoCard>
      )}

      {event.revealedServerSeed !== null && verify.status === 'running' && (
        <InfoCard style={{ marginTop: 12 }}>Replaying spin…</InfoCard>
      )}

      {verify.status === 'error' && (
        <ErrorCard style={{ marginTop: 12 }}>{verify.message}</ErrorCard>
      )}

      {verify.status === 'client' && (
        <ClientVerdictPanel verdict={verify.verdict} outcome={outcome} />
      )}

      {verify.status === 'server' && (
        <ServerVerdictPanel verdict={verify.verdict} outcome={outcome} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetaPanel({
  event,
  outcome,
  verify,
}: {
  event: CoveHistoryEventRow;
  outcome: SlotsOutcome;
  verify: VerifyState;
}) {
  const commitOk = (verify.status === 'client' || verify.status === 'server' || verify.status === 'error')
    ? verify.commitOk
    : null;
  const computed = (verify.status === 'client' || verify.status === 'server' || verify.status === 'error')
    ? verify.computed
    : null;

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
      <MetaRow label="eventId" value={event.id} mono />
      <MetaRow label="paytable" value={outcome.paytableId} />
      <MetaRow label="engine" value={event.engineVersion} />
      <MetaRow label="nonce" value={String(event.nonce)} />
      <MetaRow label="cursor" value={`${outcome.cursorBefore} → ${outcome.cursorAfter}`} />
      <MetaRow label="predict" value={`${outcome.predict} CT`} />
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
          value={
            commitOk
              ? 'sha256(serverSeed) matches serverSeedHash'
              : `MISMATCH — sha256(serverSeed) = ${computed}`
          }
          tone={commitOk ? 'ok' : 'fail'}
        />
      )}
    </div>
  );
}

function ClientVerdictPanel({
  verdict,
  outcome,
}: {
  verdict: SpinReplayVerdict;
  outcome: SlotsOutcome;
}) {
  const ok = verdict.ok;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 18,
        borderRadius: 12,
        border: `1px solid ${ok ? 'rgba(0,255,100,0.45)' : 'rgba(255,56,96,0.5)'}`,
        background: ok ? 'rgba(0,255,100,0.05)' : 'rgba(255,56,96,0.06)',
      }}
    >
      <VerdictHeading ok={ok} label={ok ? 'Provably fair — byte-identical replay' : 'Mismatch — replay diverges from stored outcome'} />

      {verdict.computed.reels.length === 5 && (
        <div style={{ marginBottom: 14 }}>
          <ReelGrid label="Computed reels (client replay)" reels={verdict.computed.reels} />
        </div>
      )}

      {outcome.reels.length === 5 && (
        <div style={{ marginBottom: 14 }}>
          <ReelGrid label="Stored reels (outcomeJson)" reels={outcome.reels} />
        </div>
      )}

      <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'rgba(224,255,248,0.7)', marginBottom: 6 }}>
        winAmount (replay):{' '}
        <code style={{ color: '#ffd684' }}>{verdict.computed.winAmount.toString()}</code>
        {outcome.isFreeSpin && <span style={{ color: '#d0a0ff', marginLeft: 8 }}>[FREE SPIN]</span>}
      </div>

      {!ok && verdict.reasons.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#ff8aa0', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            Divergence reasons:
          </div>
          <ul style={{ color: 'rgba(255,138,160,0.85)', fontSize: 12, fontFamily: 'monospace', paddingLeft: 18, margin: 0 }}>
            {verdict.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ServerVerdictPanel({
  verdict,
  outcome,
}: {
  verdict: EventVerifyResponse;
  outcome: SlotsOutcome;
}) {
  if (verdict.verified === null) {
    return (
      <InfoCard style={{ marginTop: 16 }}>
        {verdict.reason === 'shoe-not-yet-closed'
          ? 'Session is still open — server seed not yet revealed. Refresh after cashing out.'
          : 'Verification engine not yet available for this event version.'}
      </InfoCard>
    );
  }

  const ok = verdict.verified === true;
  // Extract expected reels from both the verified:true (match) and verified:false
  // (divergence) cases — impl-api populates expected on divergence so we can
  // render a side-by-side diff. Only engine-error rows have expected:null.
  const expectedFromServer =
    verdict.verified !== null ? verdict.expected : null;
  const expectedReels: SymbolId[][] | null =
    expectedFromServer &&
    Array.isArray((expectedFromServer as { reels?: unknown }).reels)
      ? (expectedFromServer as { reels: SymbolId[][] }).reels
      : null;

  return (
    <div
      style={{
        marginTop: 16,
        padding: 18,
        borderRadius: 12,
        border: `1px solid ${ok ? 'rgba(0,255,100,0.45)' : 'rgba(255,56,96,0.5)'}`,
        background: ok ? 'rgba(0,255,100,0.05)' : 'rgba(255,56,96,0.06)',
      }}
    >
      <div style={{ color: 'rgba(0,255,224,0.45)', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>
        Server-side replay (client replay unavailable for this row)
      </div>

      <VerdictHeading
        ok={ok}
        label={ok ? 'Provably fair — server replay matches stored outcome' : 'Mismatch — server replay diverges from stored outcome'}
      />

      <div style={{ fontFamily: 'monospace', fontSize: 12, color: verdict.hashMatches ? '#7cff9a' : '#ff8aa0', marginBottom: 10 }}>
        Commitment hash: {verdict.hashMatches ? 'matches' : 'MISMATCH'}
      </div>

      {expectedReels && expectedReels.length === 5 && (
        <div style={{ marginBottom: 14 }}>
          <ReelGrid label="Expected reels (server replay)" reels={expectedReels} />
        </div>
      )}

      {outcome.reels.length === 5 && (
        <div style={{ marginBottom: 14 }}>
          <ReelGrid label="Stored reels (outcomeJson)" reels={outcome.reels} />
        </div>
      )}

      {verdict.verified === false && verdict.reason && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#ff8aa0', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            Divergence reason:
          </div>
          <div style={{ color: 'rgba(255,138,160,0.85)', fontSize: 12, fontFamily: 'monospace' }}>
            {verdict.reason}
          </div>
        </div>
      )}

      {outcome.isFreeSpin && <FreespinBadge />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared presentational atoms
// ---------------------------------------------------------------------------

function VerdictHeading({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      style={{
        color: ok ? '#7cff9a' : '#ff8aa0',
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

function ReelGrid({ label, reels }: { label: string; reels: SymbolId[][] }) {
  return (
    <>
      <div
        style={{
          color: 'rgba(0,255,224,0.6)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFamily: 'monospace',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row}>
              {reels.map((reel, r) => (
                <td
                  key={r}
                  style={{
                    width: 32,
                    height: 32,
                    border: '1px solid rgba(0,255,224,0.15)',
                    textAlign: 'center',
                    color: '#9bfff0',
                    fontFamily: 'monospace',
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {reel[row]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function FreespinBadge() {
  return (
    <div
      style={{
        display: 'inline-block',
        marginTop: 10,
        padding: '2px 8px',
        borderRadius: 6,
        background: 'rgba(208,160,255,0.12)',
        border: '1px solid rgba(208,160,255,0.3)',
        color: '#d0a0ff',
        fontFamily: 'monospace',
        fontSize: 11,
      }}
    >
      FREE SPIN
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'dim' | 'fail';
}) {
  const color =
    tone === 'ok'
      ? '#7cff9a'
      : tone === 'fail'
        ? '#ff8aa0'
        : tone === 'dim'
          ? 'rgba(224,255,248,0.35)'
          : '#d0ece8';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ color: 'rgba(0,255,224,0.5)', minWidth: 140 }}>{label}</span>
      <span style={{ color, fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>
        {value}
      </span>
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
        marginTop: 12,
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
