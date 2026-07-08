'use client';

/**
 * WalletPanel — the SINGLE shared wallet-visibility surface (Tokenomics Phase A).
 *
 * Rendered in two places (task requirement: one shared component):
 *   1. As a section inside the "My Agent" settings modal (avatar-settings-modal).
 *   2. As the body of the standalone HUD wallet modal (wallet-modal), opened by
 *      the avatar-status-bar chip / sidebar entry, and deep-linked by the Land
 *      Office when a human's self-custody wallet isn't linked.
 *
 * Two wallets, clearly distinguished:
 *   - IN-GAME CUSTODIAL wallet (`avatar.walletAddress`) — the ClawVille-held
 *     Solana address the account deposits SOL/USDC/CLV into. Read-only display
 *     + copy + deposit guidance. This is where the one-time first-connect
 *     secret belonged; we only ever show the PUBLIC key here.
 *   - LINKED self-custody wallet (`users.linked_wallet_pubkey`, via
 *     GET /api/wallet/link) — a wallet the user proves they own by signing a
 *     server challenge. Used for hold-tier / seller-license checks. We display
 *     the pubkey + its CLV balance, and offer the link flow when absent.
 *
 * HARD INVARIANT: this component NEVER fetches or displays any secret key. The
 * custodial secret is disclosed exactly once at first-connect and never again;
 * the linked wallet's key never leaves the user's browser wallet.
 */

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';
import {
  truncateAddress,
  signWalletLinkMessage,
  hasSolanaWallet,
  WalletSignError,
} from '@/lib/solana-wallet';

export function WalletPanel({ variant = 'section' }: { variant?: 'section' | 'modal' }) {
  const { data: avatar } = useAvatar();
  const custodial = ((avatar as { walletAddress?: string | null } | null)?.walletAddress) ?? null;

  return (
    <div className={variant === 'modal' ? 'space-y-4' : 'space-y-3'}>
      <CustodialWalletCard address={custodial} />
      <LinkedWalletCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-game custodial wallet
// ---------------------------------------------------------------------------

function CustodialWalletCard({ address }: { address: string | null }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🪙</span>
        <h3 className="font-bold text-sm text-white">In-game wallet</h3>
      </div>
      <div className="bg-amber-500/10 border border-amber-400/25 rounded-lg p-3 space-y-2.5">
        <p className="text-xs text-white/70 leading-relaxed">
          Your ClawVille Solana address. Send SOL, USDC, or{' '}
          <span className="font-mono text-amber-200">CLV</span> here to fund in-game
          purchases — deposits land on this address automatically.
        </p>
        {address ? (
          <AddressField label="Deposit address" address={address} accent="amber" />
        ) : (
          <div className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-400/20 rounded-md px-3 py-2 leading-relaxed">
            Your in-game wallet is still being provisioned. If this persists,
            reconnect your agent to finish setup.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linked self-custody wallet
// ---------------------------------------------------------------------------

function LinkedWalletCard() {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);
  const [error, setError] = useState<string | null>(null);

  const linkQuery = useWalletLink();

  const linkMutation = useMutation({
    mutationFn: async () => {
      // 1) server challenge → exact SIWS-lite message. 2) browser wallet signs.
      // 3) POST pubkey + nonce + signature. Public-key + signature only.
      const challenge = await api.walletLinkChallenge();
      const { walletPubkey, signatureBase58 } = await signWalletLinkMessage(
        challenge.messageToSign,
      );
      return api.linkWallet({
        walletPubkey,
        nonce: challenge.nonce,
        signature: signatureBase58,
      });
    },
    onSuccess: (res) => {
      setError(null);
      queryClient.setQueryData(['wallet-link'], {
        linked: true,
        walletPubkey: res.walletPubkey,
        clv: res.clv,
      });
      queryClient.invalidateQueries({ queryKey: ['wallet-link'] });
      addToast('🔗', 'Wallet linked', 3000);
    },
    onError: (err) => {
      if (err instanceof WalletSignError) {
        setError(err.message);
      } else {
        // ApiError carries a code/status; message is safe to show.
        setError(err instanceof Error && err.message ? err.message : 'Could not link wallet.');
      }
    },
  });

  const linked = linkQuery.linked;
  const clv = linkQuery.clv;

  const onLink = () => {
    setError(null);
    if (!hasSolanaWallet()) {
      setError(
        'No Solana wallet detected. Install Phantom, Solflare, or Backpack, then try again.',
      );
      return;
    }
    linkMutation.mutate();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🔗</span>
        <h3 className="font-bold text-sm text-white">Your linked wallet</h3>
      </div>

      {linked ? (
        <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(45,212,191,0.6)]"
            />
            <p className="text-sm font-bold text-white">Self-custody wallet linked</p>
          </div>
          <AddressField
            label="Linked wallet"
            address={linkQuery.walletPubkey!}
            accent="cyan"
          />
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/10">
            <span className="text-[11px] uppercase tracking-[0.16em] font-mono text-white/40">
              CLV balance
            </span>
            <span className="text-sm font-bold text-cyan-200 font-mono">
              {clv?.available && clv.uiAmount !== null
                ? `${clv.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} CLV`
                : 'unavailable'}
            </span>
          </div>
          <p className="text-[10px] text-white/40 leading-relaxed">
            Used for hold-tier perks and land hold-to-keep checks. Your CLV never
            leaves this wallet — ClawVille only reads the balance.
          </p>
        </div>
      ) : (
        <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2.5">
          <p className="text-xs text-white/70 leading-relaxed">
            Link a self-custody wallet (Phantom, Solflare, Backpack) to prove your{' '}
            <span className="font-mono text-cyan-200">CLV</span> holdings for hold-tier
            perks and land benefits. You sign a message — no funds move, no key
            leaves your wallet.
          </p>
          <button
            type="button"
            onClick={onLink}
            disabled={linkMutation.isPending}
            className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
          >
            {linkMutation.isPending ? 'Waiting for wallet…' : 'Link wallet'}
          </button>
          {error && (
            <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-relaxed">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddressField — truncated pill (click to reveal full) + copy button.
// ---------------------------------------------------------------------------

function AddressField({
  label,
  address,
  accent,
}: {
  label: string;
  address: string;
  accent: 'amber' | 'cyan';
}) {
  const addToast = useGameStore((s) => s.addToast);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const tone =
    accent === 'amber'
      ? { pill: 'border-amber-400/30 text-amber-100', btn: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-100' }
      : { pill: 'border-cyan-400/30 text-cyan-100', btn: 'bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100' };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      addToast('📋', 'Address copied', 2000);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (iOS sandbox / permissions) — reveal so the user can
      // select-and-copy manually.
      setRevealed(true);
    }
  }, [address, addToast]);

  return (
    <div className="space-y-1">
      <span className="block text-white/50 text-[10px] font-mono uppercase tracking-wider">
        {label}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          title={revealed ? 'Hide full address' : 'Show full address'}
          className={`flex-1 min-w-0 min-h-[44px] text-left bg-black/30 border rounded-lg px-3 py-2 text-sm font-mono break-all select-all ${tone.pill}`}
        >
          {revealed ? address : truncateAddress(address, 6, 6)}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className={`min-h-[44px] px-4 py-2 rounded-lg text-xs font-bold shrink-0 transition-colors ${tone.btn}`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
