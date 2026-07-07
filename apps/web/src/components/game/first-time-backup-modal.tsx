'use client';

/**
 * FirstTimeBackupModal — renders once on /game first mount after an
 * auto-provisioned signup (Phase 4d). Reads one-time identity + wallet
 * secrets from sessionStorage (written by /create-agent/personality
 * right before the redirect), forces the user to acknowledge they've
 * saved them, and purges the storage entry after acknowledgement.
 *
 * Phase 5.1 doctrine: the server discloses plaintext secrets EXACTLY
 * ONCE. If the user dismisses without saving, they can still recover
 * via the future support-chat flow using the envelope-encrypted
 * identity_encrypted_sk on the users row — but the Solana wallet
 * secret is lost permanently. The copy makes this tradeoff explicit.
 */

import { useCallback, useEffect, useState } from 'react';

interface FirstTimeDisclosure {
  // Optional (2026-07-04): the /login signup writer stores `res.avatar?.id`,
  // which is `string | undefined` when fail-soft provisioning returned no
  // avatar. The reader here never consumes avatarId, so the honest type is
  // optional rather than forcing a non-null assertion at the writer.
  avatarId?: string;
  avatarName: string;
  identity: {
    userId: string;
    publicKey: string;
    secretKey: string;
  } | null;
  wallet: {
    address: string;
    secretKey: string;
    chain: 'solana';
  } | null;
  issuedAt: number;
}

/**
 * Shared sessionStorage contract. Written by BOTH one-time-secret emitters:
 *  - /create-agent/personality (POST /api/avatars auto-provision response)
 *  - /login signup path (P2 Path-B: POST /api/auth/signup now provisions the
 *    agent + wallet server-side and returns the one-time payload — 2026-07-04)
 * Read + purged HERE on /game first mount. Key and payload shape
 * (FirstTimeDisclosure) must stay in lockstep across all three sites —
 * import this constant, never inline the literal.
 */
export const FIRST_TIME_DISCLOSURE_STORAGE_KEY = 'clawville:firstTimeDisclosure';

const STORAGE_KEY = FIRST_TIME_DISCLOSURE_STORAGE_KEY;

export default function FirstTimeBackupModal() {
  const [disclosure, setDisclosure] = useState<FirstTimeDisclosure | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as FirstTimeDisclosure;
      if (parsed.identity?.secretKey || parsed.wallet?.secretKey) {
        setDisclosure(parsed);
      }
    } catch {
      // Corrupt / missing — nothing to show.
    }
  }, []);

  const handleCopy = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      /* clipboard blocked — user can still select-all manually */
    }
  }, []);

  const handleAcknowledge = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* already gone */
    }
    setDisclosure(null);
  }, []);

  if (!disclosure) return null;

  const hasIdentity = !!disclosure.identity?.secretKey;
  const hasWallet = !!disclosure.wallet?.secretKey;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative max-w-lg w-full bg-[#08111d] border border-cyan-400/40 rounded-2xl shadow-[0_0_40px_rgba(0,229,255,0.25)] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-transparent">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300/80 mb-1">
            § save your keys
          </div>
          <h2 className="font-clawville text-xl uppercase tracking-wider text-cyan-100">
            {disclosure.avatarName} is alive
          </h2>
          <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
            These keys are shown <span className="text-cyan-200 font-bold">once</span>.
            Save them somewhere safe before you close this window. Your
            session keeps you logged in — the keys are for account
            recovery and self-custody.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {hasIdentity && (
            <SecretField
              label="Identity Private Key"
              hint="ed25519 — used to sign reconnect challenges if you lose your session."
              value={disclosure.identity!.secretKey}
              accent="cyan"
              onCopy={handleCopy}
              copiedField={copiedField}
              copyLabel="identity"
            />
          )}

          {hasWallet && (
            <SecretField
              label={`Solana Wallet Private Key (${disclosure.wallet!.address.slice(0, 8)}…)`}
              hint="Controls your avatar's $CLAWVILLE rewards. If you lose this, the funds are gone."
              value={disclosure.wallet!.secretKey}
              accent="pink"
              onCopy={handleCopy}
              copiedField={copiedField}
              copyLabel="wallet"
            />
          )}

          <label className="flex items-start gap-2 text-[12px] text-white/70 cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-[3px] accent-cyan-400"
            />
            <span>
              I&apos;ve saved these keys. I understand ClawVille will never
              show them again.
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end">
          <button
            type="button"
            onClick={handleAcknowledge}
            disabled={!acknowledged}
            className="px-6 py-2.5 rounded-lg font-clawville text-sm uppercase tracking-[0.2em] text-white bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:from-white/10 disabled:to-white/10 disabled:text-white/25 disabled:cursor-not-allowed shadow-[0_0_18px_rgba(0,229,255,0.25)] transition-all"
          >
            Enter ClawVille →
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretField({
  label,
  hint,
  value,
  accent,
  onCopy,
  copiedField,
  copyLabel,
}: {
  label: string;
  hint: string;
  value: string;
  accent: 'cyan' | 'pink';
  onCopy: (label: string, value: string) => void;
  copiedField: string | null;
  copyLabel: string;
}) {
  const accentCls =
    accent === 'pink'
      ? 'border-pink-400/30 bg-pink-500/5'
      : 'border-cyan-400/30 bg-cyan-500/5';
  const labelCls = accent === 'pink' ? 'text-pink-200' : 'text-cyan-200';

  return (
    <div className={`rounded-lg border ${accentCls} p-3 space-y-2`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`font-mono text-[10px] uppercase tracking-[0.2em] font-bold ${labelCls}`}>
          {label}
        </div>
        <button
          type="button"
          onClick={() => onCopy(copyLabel, value)}
          className="font-mono text-[9px] uppercase tracking-wider text-white/50 hover:text-white/90 transition-colors"
        >
          {copiedField === copyLabel ? 'copied' : 'copy'}
        </button>
      </div>
      <p className="text-[10px] text-white/50 leading-relaxed">{hint}</p>
      <div className="bg-black/50 border border-white/10 rounded-md p-2">
        <pre className="text-[11px] text-white/90 font-mono break-all whitespace-pre-wrap select-all">
          {value}
        </pre>
      </div>
    </div>
  );
}
