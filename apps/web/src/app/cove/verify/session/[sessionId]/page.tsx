'use client';

/**
 * Phase 6.1 slice 5 — Per-session verifier.
 *
 * Auth-gated: requires Lucia session AND ownership of the slot session.
 * The wire types we depend on (`useSlotSession`, `useSlotSessionSpins`)
 * surface 401/403/404 cleanly so we render owner-only messaging without
 * leaking session existence to non-owners.
 *
 * Flow:
 *   1. Fetch session detail. If `status==='open'`, show "verify after close".
 *      Server redacts `serverSeed: null` while open, so verification is
 *      mathematically impossible until close anyway.
 *   2. Fetch ALL spins (limit=200) via /session/:id/spins.
 *   3. For each spin: run browser `replaySpin()` using
 *      (session.serverSeed, session.clientSeed, spin.nonce, spin.cursorBefore,
 *      spin.predict) and compare reels[][] + winAmount + cursorAfter.
 *   4. Show table: green/red per row, divergence reasons, summary line at top.
 */

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import {
  CoveApiError,
  useSlotSession,
  useSlotSessionSpins,
} from '@/lib/cove/slot-api-client';
import type { SessionSpinRow } from '@/lib/cove/slot-api-client';
import { replaySpin, type SpinReplayVerdict, sha256Hex } from '@/lib/cove/verifier';

import '@/styles/cove-tokens.css';

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

type SpinVerdictMap = Map<string, SpinReplayVerdict>;

export default function SessionVerifyPage({ params }: PageProps) {
  // Next.js 15+: params is a Promise — `use()` unwraps it on the client.
  const { sessionId } = use(params);

  const sessionQuery = useSlotSession(sessionId);
  const spinsQuery = useSlotSessionSpins({
    sessionId: sessionQuery.data?.session.status === 'open' ? null : sessionId,
    limit: 200,
  });

  const session = sessionQuery.data?.session ?? null;
  const spins = spinsQuery.data?.spins ?? [];

  const [verdicts, setVerdicts] = useState<SpinVerdictMap>(new Map());
  const [verifying, setVerifying] = useState(false);
  const [commitCheck, setCommitCheck] = useState<{ ok: boolean; computed: string } | null>(null);

  // Run the local replay batch when session+spins are loaded and the seed is revealed.
  useEffect(() => {
    if (!session || !session.serverSeed) return;
    if (spins.length === 0) return;
    let cancelled = false;
    setVerifying(true);
    (async () => {
      // Check commitment first — sha256(serverSeed) should equal serverSeedHash.
      try {
        const computed = await sha256Hex(session.serverSeed!.toLowerCase());
        if (!cancelled) {
          setCommitCheck({ ok: computed === session.serverSeedHash, computed });
        }
      } catch {
        if (!cancelled) setCommitCheck({ ok: false, computed: '(error)' });
      }

      const next: SpinVerdictMap = new Map();
      // Spins are returned newest-first; we verify in temporal order for
      // a predictable progress UI.
      const sorted = [...spins].sort((a, b) => a.nonce - b.nonce);
      for (const spin of sorted) {
        if (cancelled) return;
        try {
          const verdict = await replaySpin({
            paytableId: session.paytableId,
            serverSeed: session.serverSeed!,
            clientSeed: session.clientSeed,
            nonce: spin.nonce,
            cursor: spin.cursorBefore,
            predict: BigInt(spin.predict),
            // Phase 6.1.5 — propagate FS mode so bonus-session replays
            // pick the right cursor/payout math. Defaults to false for
            // legacy classic-3x5 rows where the column may be absent.
            freeSpinMode: spin.isFreeSpin,
            // Phase 6.1.10 — propagate paytable version so v1 (pre-retune)
            // spins skip the winAmount cross-check (recomputed under v2
            // payouts wouldn't match the stored v1 amount). Reels + cursor
            // still fully verify on both versions.
            paytableVersion: spin.paytableVersion,
            expected: {
              reels: spin.reels,
              winAmount: spin.winAmount,
              cursorAfter: spin.cursorAfter,
              // Phase 6.1.5 — deep-compare bonus fields when the server
              // shipped them. Absence on a row means classic-3x5 (no
              // bonus features) and the verifier skips those checks.
              wildMultipliers: spin.wildMultipliers,
              scatterPayout: spin.scatterPayout,
              freeSpinsAwarded: spin.freeSpinsAwarded,
            },
          });
          next.set(spin.id, verdict);
        } catch (err) {
          // Surface as a non-match verdict so the UI shows the failure.
          next.set(spin.id, {
            ok: false,
            reasons: [(err as Error).message],
            computed: {
              reels: [],
              winningLines: [],
              winAmount: 0n,
              freeSpinsAwarded: 0,
              isFreeSpin: false,
              wildMultipliers: [],
              scatterPayout: 0n,
              cursorAfter: 0,
            },
          });
        }
        if (!cancelled) setVerdicts(new Map(next));
      }
      if (!cancelled) setVerifying(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, spins]);

  const summary = useMemo(() => {
    const verified = Array.from(verdicts.values());
    if (verified.length === 0) return null;
    const fails = verified.filter((v) => !v.ok).length;
    return { total: verified.length, passes: verified.length - fails, fails };
  }, [verdicts]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          'radial-gradient(ellipse at 50% 0%, rgba(123,47,247,0.12) 0%, transparent 60%), ' +
          'linear-gradient(180deg, #060a18 0%, #02040a 100%)',
        color: '#e0fff8',
        fontFamily: 'monospace',
        padding: '40px 24px',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1
            style={{
              color: 'var(--cv-neon-cyan, #00ffe0)',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              textShadow: '0 0 16px rgba(0, 255, 224, 0.35)',
              margin: 0,
            }}
          >
            Session Verifier
          </h1>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link
              href="/cove/verify"
              style={navLinkStyle()}
            >
              ← Manual verifier
            </Link>
            <Link href="/cove" style={navLinkStyle()}>
              ← Cove
            </Link>
          </div>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 8 }}>
          Session: <code style={{ color: '#9bfff0' }}>{sessionId}</code>
        </p>

        {/* ── Auth/load states ───────────────────────────────────────── */}
        {sessionQuery.isLoading ? (
          <Card>Loading session…</Card>
        ) : sessionQuery.isError ? (
          <Card tone="error">
            {renderAuthError(sessionQuery.error)}
          </Card>
        ) : session ? (
          <>
            <SessionMetaCard session={session} commitCheck={commitCheck} />

            {/* Open-session: cannot verify */}
            {session.status === 'open' ? (
              <Card>
                Verification is available after the session is closed (the server reveals the
                <code> serverSeed</code> on cash-out). Once you cash out this session, refresh this page.
              </Card>
            ) : null}

            {/* Closed session: spin-by-spin verifier */}
            {session.status !== 'open' && spinsQuery.isLoading ? (
              <Card>Loading spins…</Card>
            ) : null}
            {session.status !== 'open' && spinsQuery.isError ? (
              <Card tone="error">{renderAuthError(spinsQuery.error)}</Card>
            ) : null}

            {session.status !== 'open' && spinsQuery.data && spins.length === 0 ? (
              <Card>This session has no spins to verify.</Card>
            ) : null}

            {session.status !== 'open' && spins.length > 0 ? (
              <>
                <SummaryBar summary={summary} verifying={verifying} total={spins.length} />
                <SpinsTable spins={spins} verdicts={verdicts} />
              </>
            ) : null}
          </>
        ) : (
          <Card>Session not found.</Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function renderAuthError(err: unknown): string {
  if (err instanceof CoveApiError) {
    if (err.status === 401) return 'You must be signed in to view session verification.';
    if (err.status === 403) return 'This session belongs to a different account.';
    if (err.status === 404) return 'Session not found (or it was never created).';
    return `Server error (${err.status}): ${err.serverMessage}`;
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

function SessionMetaCard({
  session,
  commitCheck,
}: {
  session: NonNullable<ReturnType<typeof useSlotSession>['data']>['session'];
  commitCheck: { ok: boolean; computed: string } | null;
}) {
  return (
    <Card>
      <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        <Row k="paytable" v={session.paytableId} />
        <Row k="currency" v={session.currency} />
        <Row k="status" v={session.status} />
        <Row k="serverSeedHash" v={session.serverSeedHash} mono />
        <Row k="serverSeed" v={session.serverSeed ?? '(redacted while open)'} mono />
        <Row k="clientSeed" v={session.clientSeed} mono />
        <Row k="spins" v={String(session.spinCount)} />
        <Row k="totalStaked" v={session.totalStaked} />
        <Row k="totalWon" v={session.totalWon} />
        {commitCheck ? (
          <Row
            k="commitment"
            v={
              commitCheck.ok
                ? '✓ sha256(serverSeed) matches serverSeedHash'
                : `✗ sha256(serverSeed) = ${commitCheck.computed}`
            }
            tone={commitCheck.ok ? 'ok' : 'fail'}
          />
        ) : null}
      </div>
    </Card>
  );
}

function SummaryBar({
  summary,
  verifying,
  total,
}: {
  summary: { total: number; passes: number; fails: number } | null;
  verifying: boolean;
  total: number;
}) {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 16,
        background: summary?.fails
          ? 'rgba(255, 56, 96, 0.08)'
          : summary && summary.total === total && !verifying
            ? 'rgba(0, 255, 100, 0.06)'
            : 'rgba(0, 255, 224, 0.05)',
        border: `1px solid ${
          summary?.fails
            ? 'rgba(255, 56, 96, 0.5)'
            : summary && summary.total === total && !verifying
              ? 'rgba(0, 255, 100, 0.45)'
              : 'rgba(0,255,224,0.25)'
        }`,
        borderRadius: 10,
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 13,
      }}
    >
      <span
        style={{
          color: summary?.fails ? '#ff8aa0' : summary && !verifying ? '#7cff9a' : 'rgba(0,255,224,0.85)',
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        {summary?.fails
          ? `✗ ${summary.fails} spin(s) failed`
          : summary && !verifying
            ? `✓ all ${summary.total} spins verified`
            : verifying
              ? `Verifying… ${summary?.total ?? 0} / ${total}`
              : 'Pending'}
      </span>
    </div>
  );
}

function SpinsTable({
  spins,
  verdicts,
}: {
  spins: SessionSpinRow[];
  verdicts: SpinVerdictMap;
}) {
  // Render in ascending nonce order so the table reads chronologically.
  const sorted = [...spins].sort((a, b) => a.nonce - b.nonce);
  return (
    <div style={{ marginTop: 20, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
        <thead>
          <tr style={{ color: 'rgba(0,255,224,0.75)', textAlign: 'left' }}>
            <th style={th()}>nonce</th>
            <th style={th()}>cursorBefore → cursorAfter</th>
            <th style={th()}>predict</th>
            <th style={th()}>winAmount (server)</th>
            <th style={th()}>winAmount (local)</th>
            <th style={th()}>verdict</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((spin) => {
            const verdict = verdicts.get(spin.id);
            const computedWin = verdict?.computed.winAmount.toString();
            return (
              <tr
                key={spin.id}
                style={{
                  borderTop: '1px solid rgba(0,255,224,0.08)',
                  background: verdict
                    ? verdict.ok
                      ? 'rgba(0, 255, 100, 0.04)'
                      : 'rgba(255, 56, 96, 0.06)'
                    : 'transparent',
                }}
              >
                <td style={td()}>{spin.nonce}</td>
                <td style={td()}>{spin.cursorBefore} → {spin.cursorAfter}</td>
                <td style={td()}>{spin.predict}</td>
                <td style={td()}>{spin.winAmount}</td>
                <td style={td()}>{computedWin ?? '…'}</td>
                <td style={td()}>
                  {!verdict ? (
                    <span style={{ color: 'rgba(255,255,255,0.45)' }}>pending</span>
                  ) : verdict.ok ? (
                    <span style={{ color: '#7cff9a', fontWeight: 800 }}>✓ match</span>
                  ) : (
                    <details>
                      <summary style={{ color: '#ff8aa0', fontWeight: 800, cursor: 'pointer' }}>✗ mismatch</summary>
                      <ul style={{ margin: '6px 0 0 16px', color: 'rgba(255,138,160,0.85)' }}>
                        {verdict.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny presentation helpers
// ---------------------------------------------------------------------------

function Card({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: 18,
        background: tone === 'error' ? 'rgba(255, 56, 96, 0.06)' : 'rgba(5, 10, 24, 0.7)',
        border: tone === 'error' ? '1px solid rgba(255, 56, 96, 0.4)' : '1px solid rgba(0,255,224,0.18)',
        borderRadius: 12,
        color: tone === 'error' ? '#ff8aa0' : 'rgba(255,255,255,0.78)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function Row({ k, v, mono, tone }: { k: string; v: string; mono?: boolean; tone?: 'ok' | 'fail' }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: 'rgba(0,255,224,0.65)', minWidth: 130 }}>{k}</span>
      <span
        style={{
          color: tone === 'ok' ? '#7cff9a' : tone === 'fail' ? '#ff8aa0' : '#e0fff8',
          fontFamily: mono ? 'monospace' : 'monospace',
          wordBreak: 'break-all',
        }}
      >
        {v}
      </span>
    </div>
  );
}

function th(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontSize: 11,
  };
}

function td(): React.CSSProperties {
  return { padding: '8px 10px', verticalAlign: 'top' };
}

function navLinkStyle(): React.CSSProperties {
  return {
    color: 'rgba(0, 255, 224, 0.75)',
    textDecoration: 'none',
    fontSize: 12,
    border: '1px solid rgba(0,255,224,0.4)',
    padding: '6px 12px',
    borderRadius: 6,
  };
}
