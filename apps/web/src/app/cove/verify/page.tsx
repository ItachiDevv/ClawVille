'use client';

/**
 * Phase 6.1 slice 5 — Provably-fair manual verifier.
 *
 * Anonymous, public page. Paste:
 *   - serverSeed (revealed after session close — 64 hex chars)
 *   - clientSeed (server-generated, shown in the slot HUD fairness chip)
 *   - nonce (per-spin counter)
 *   - cursor (byte offset into the HMAC stream this spin started at)
 *   - predict (atomic units, stringified bigint; e.g. "20")
 *   - paytable (only "classic-3x5" today)
 *
 * Then hit Verify:
 *   - LOCAL: browser re-derives reels + winAmount via `runSpinLocal`
 *     (WebCrypto port of the server's `runSpin`).
 *   - REMOTE: POST /api/cove/slots/verify — pure-compute replay on the
 *     server, used to confirm both sides agree.
 *
 * Visual: green check if local computed == remote, red flag otherwise.
 * Every comparison is byte-level on reels[][] + winAmount string.
 */

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  CoveApiError,
  describeCoveError,
  useVerifySpinRemote,
} from '@/lib/cove/slot-api-client';
import { runSpinLocal, sha256Hex } from '@/lib/cove/verifier';
import type { SpinResult } from '@/lib/cove/types';

import '@/styles/cove-tokens.css';

interface FormState {
  paytableId: 'classic-3x5';
  serverSeed: string;
  clientSeed: string;
  nonce: string;
  cursor: string;
  predict: string;
}

const DEFAULT_FORM: FormState = {
  paytableId: 'classic-3x5',
  serverSeed: '',
  clientSeed: '',
  nonce: '0',
  cursor: '0',
  predict: '20',
};

interface Verdict {
  local: {
    reels: number[][];
    winAmount: string;
    cursorAfter: number;
  };
  remote: {
    reels: number[][];
    winAmount: string;
    cursorAfter: number;
  };
  match: boolean;
  reasons: string[];
}

export default function CoveVerifyPage() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [serverHashCheck, setServerHashCheck] = useState<string | null>(null);
  const [deeplink, setDeeplink] = useState('');

  const remote = useVerifySpinRemote();

  const onField = useCallback(
    (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
    },
    [],
  );

  const handleVerify = useCallback(async () => {
    setErrorMsg(null);
    setVerdict(null);
    setServerHashCheck(null);
    try {
      const parsedNonce = parseInt(form.nonce, 10);
      const parsedCursor = parseInt(form.cursor, 10);
      if (!Number.isFinite(parsedNonce) || parsedNonce < 0) {
        setErrorMsg('nonce must be a non-negative integer');
        return;
      }
      if (!Number.isFinite(parsedCursor) || parsedCursor < 0) {
        setErrorMsg('cursor must be a non-negative integer');
        return;
      }
      let predictBig: bigint;
      try {
        predictBig = BigInt(form.predict);
      } catch {
        setErrorMsg('predict must be a stringified integer (e.g. "20")');
        return;
      }
      if (predictBig <= 0n) {
        setErrorMsg('predict must be > 0');
        return;
      }

      // 1. Browser-local compute (WebCrypto).
      const local: SpinResult = await runSpinLocal({
        paytableId: form.paytableId,
        serverSeed: form.serverSeed.trim(),
        clientSeed: form.clientSeed.trim(),
        nonce: parsedNonce,
        cursor: parsedCursor,
        predict: predictBig,
      });

      // 2. Re-derive sha256(serverSeed) — independently confirms the commit
      // hash a player would have seen at session open.
      try {
        const recommit = await sha256Hex(form.serverSeed.trim().toLowerCase());
        setServerHashCheck(recommit);
      } catch {
        // ignore — hash failure is non-fatal to the verification step
      }

      // 3. Server-side replay for cross-check.
      const remoteRes = await remote.mutateAsync({
        paytableId: form.paytableId,
        serverSeed: form.serverSeed.trim(),
        clientSeed: form.clientSeed.trim(),
        nonce: parsedNonce,
        cursor: parsedCursor,
        predict: form.predict,
      });

      // 4. Compare local ↔ remote.
      const reasons: string[] = [];
      const localReels = local.reels;
      const remoteReels = remoteRes.reels;
      if (localReels.length !== remoteReels.length) {
        reasons.push(`reels row count mismatch (${localReels.length} vs ${remoteReels.length})`);
      } else {
        for (let r = 0; r < localReels.length; r++) {
          const a = localReels[r]!;
          const b = remoteReels[r]!;
          for (let c = 0; c < a.length; c++) {
            if (a[c] !== b[c]) {
              reasons.push(`reels[${r}][${c}] local=${a[c]} vs remote=${b[c]}`);
            }
          }
        }
      }
      const localWinAmount = local.winAmount.toString();
      if (localWinAmount !== remoteRes.winAmount) {
        reasons.push(`winAmount: local=${localWinAmount} vs remote=${remoteRes.winAmount}`);
      }
      if (local.cursorAfter !== remoteRes.cursorAfter) {
        reasons.push(`cursorAfter: local=${local.cursorAfter} vs remote=${remoteRes.cursorAfter}`);
      }

      setVerdict({
        local: {
          reels: localReels,
          winAmount: localWinAmount,
          cursorAfter: local.cursorAfter,
        },
        remote: {
          reels: remoteReels,
          winAmount: remoteRes.winAmount,
          cursorAfter: remoteRes.cursorAfter,
        },
        match: reasons.length === 0,
        reasons,
      });
    } catch (err) {
      const message =
        err instanceof CoveApiError ? describeCoveError(err) : (err as Error).message;
      setErrorMsg(message);
    }
  }, [form, remote]);

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
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1
            style={{
              color: 'var(--cv-neon-cyan, #00ffe0)',
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              textShadow: '0 0 16px rgba(0, 255, 224, 0.35)',
              margin: 0,
            }}
          >
            Cove Verifier
          </h1>
          <Link
            href="/cove"
            style={{
              color: 'rgba(0, 255, 224, 0.7)',
              textDecoration: 'none',
              fontSize: 12,
              border: '1px solid rgba(0,255,224,0.4)',
              padding: '6px 12px',
              borderRadius: 6,
            }}
          >
            ← Back to Cove
          </Link>
        </div>

        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 1.6, marginTop: 12 }}>
          Replay any slot spin off-chain. Browser computes the result via WebCrypto using the same
          HMAC-SHA256 commit-reveal algorithm the server uses; we cross-check against the server's
          pure-compute <code>/verify</code> route. Green means byte-identical math — no edge case,
          no rounding gap. This is the proof that the cove can't bias outcomes.
        </p>

        {/* ───── Past-session deeplink ─────────────────────────────────── */}
        <div
          style={{
            marginTop: 18,
            padding: 14,
            background: 'rgba(0, 255, 224, 0.04)',
            border: '1px solid rgba(0,255,224,0.18)',
            borderRadius: 10,
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: 'rgba(0,255,224,0.85)', fontSize: 13 }}>Verify a past session:</span>
          <input
            value={deeplink}
            onChange={(e) => setDeeplink(e.target.value)}
            placeholder="session UUID"
            style={inputStyle({ flex: '1 1 240px', minWidth: 0 })}
          />
          <Link
            href={`/cove/verify/session/${deeplink.trim()}`}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              background: 'rgba(0, 255, 224, 0.12)',
              border: '1px solid rgba(0, 255, 224, 0.55)',
              color: '#9bfff0',
              textDecoration: 'none',
              fontWeight: 700,
              fontSize: 12,
              opacity: deeplink.trim().length > 0 ? 1 : 0.4,
              pointerEvents: deeplink.trim().length > 0 ? 'auto' : 'none',
            }}
          >
            Open →
          </Link>
        </div>

        {/* ───── Manual form ───────────────────────────────────────────── */}
        <div
          style={{
            marginTop: 24,
            padding: 24,
            background: 'rgba(5, 10, 24, 0.7)',
            border: '1px solid rgba(0,255,224,0.18)',
            borderRadius: 14,
            backdropFilter: 'blur(4px)',
          }}
        >
          <h2
            style={{
              color: 'rgba(0,255,224,0.85)',
              fontSize: 14,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              marginTop: 0,
              marginBottom: 16,
            }}
          >
            Manual Replay
          </h2>

          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Server seed (64 hex chars)">
              <input
                style={inputStyle()}
                value={form.serverSeed}
                onChange={onField('serverSeed')}
                placeholder="64-char lowercase hex revealed after session close"
              />
            </Field>
            <Field label="Client seed (hex)">
              <input
                style={inputStyle()}
                value={form.clientSeed}
                onChange={onField('clientSeed')}
                placeholder="hex string shown in HUD"
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="Nonce">
                <input
                  style={inputStyle()}
                  value={form.nonce}
                  onChange={onField('nonce')}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </Field>
              <Field label="Cursor (bytes)">
                <input
                  style={inputStyle()}
                  value={form.cursor}
                  onChange={onField('cursor')}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </Field>
              <Field label="Predict (atomic units)">
                <input
                  style={inputStyle()}
                  value={form.predict}
                  onChange={onField('predict')}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </Field>
            </div>
            <Field label="Paytable">
              <select
                style={inputStyle()}
                value={form.paytableId}
                onChange={onField('paytableId')}
              >
                <option value="classic-3x5">classic-3x5</option>
              </select>
            </Field>
          </div>

          <button
            onClick={handleVerify}
            disabled={remote.isPending}
            style={{
              marginTop: 22,
              padding: '12px 22px',
              borderRadius: 10,
              border: '1px solid rgba(0,255,224,0.5)',
              background: 'rgba(0,255,224,0.16)',
              color: '#9bfff0',
              fontWeight: 800,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: remote.isPending ? 'wait' : 'pointer',
              fontFamily: 'monospace',
              fontSize: 13,
              opacity: remote.isPending ? 0.6 : 1,
            }}
          >
            {remote.isPending ? 'Verifying…' : 'Verify'}
          </button>

          {errorMsg ? (
            <div
              role="alert"
              style={{
                marginTop: 16,
                padding: 12,
                background: 'rgba(255, 56, 96, 0.12)',
                border: '1px solid rgba(255, 56, 96, 0.5)',
                borderRadius: 8,
                color: '#ff9aad',
                fontSize: 13,
              }}
            >
              {errorMsg}
            </div>
          ) : null}
        </div>

        {/* ───── Verdict ───────────────────────────────────────────────── */}
        {verdict ? (
          <div
            style={{
              marginTop: 24,
              padding: 24,
              background: verdict.match
                ? 'rgba(0, 255, 100, 0.06)'
                : 'rgba(255, 56, 96, 0.06)',
              border: `1px solid ${verdict.match ? 'rgba(0, 255, 100, 0.45)' : 'rgba(255, 56, 96, 0.55)'}`,
              borderRadius: 14,
            }}
          >
            <div
              style={{
                color: verdict.match ? '#7cff9a' : '#ff8aa0',
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                marginBottom: 12,
              }}
            >
              {verdict.match ? '✓ Provably fair — byte-identical replay' : '✗ Mismatch — server output diverges'}
            </div>

            {serverHashCheck ? (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 12, wordBreak: 'break-all' }}>
                sha256(serverSeed) = <code>{serverHashCheck}</code>
              </div>
            ) : null}

            <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              <ResultPanel title="Local (browser WebCrypto)" data={verdict.local} />
              <ResultPanel title="Server (/verify)" data={verdict.remote} />
            </div>

            {!verdict.match ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ color: '#ff8aa0', fontSize: 13, marginBottom: 6, fontWeight: 700 }}>
                  Divergence reasons:
                </div>
                <ul style={{ color: 'rgba(255, 138, 160, 0.85)', fontSize: 12, paddingLeft: 18 }}>
                  {verdict.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local UI helpers
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4, color: 'rgba(0,255,224,0.7)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function inputStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: 'rgba(10, 18, 36, 0.85)',
    border: '1px solid rgba(0,255,224,0.25)',
    color: '#e0fff8',
    padding: '8px 12px',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 13,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    ...extra,
  };
}

function ResultPanel({ title, data }: { title: string; data: { reels: number[][]; winAmount: string; cursorAfter: number } }) {
  return (
    <div style={{ background: 'rgba(2, 6, 14, 0.55)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 14 }}>
      <div style={{ color: 'rgba(0,255,224,0.8)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8 }}>
        {title}
      </div>
      <table style={{ borderCollapse: 'collapse', margin: '0 auto', marginBottom: 10 }}>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row}>
              {data.reels.map((reel, r) => (
                <td
                  key={r}
                  style={{
                    width: 36,
                    height: 36,
                    border: '1px solid rgba(0,255,224,0.18)',
                    textAlign: 'center',
                    color: '#9bfff0',
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
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
        winAmount: <code style={{ color: '#ffd684' }}>{data.winAmount}</code>
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
        cursorAfter: <code style={{ color: '#ffd684' }}>{data.cursorAfter}</code>
      </div>
    </div>
  );
}
