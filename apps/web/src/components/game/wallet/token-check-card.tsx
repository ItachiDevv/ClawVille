'use client';

/**
 * TokenCheckCard: the human path for the market and trust reads (MCP hub,
 * 2026-11-07, GET /api/ecosystem/market/:op and /trust/:wallet). Each section
 * reads only when the human presses its button, because a read that reaches
 * the vendor costs one unit of the avatar's daily budget.
 *
 * Labels under `vendorData` are vendor text: React renders them as plain text.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ECOSYSTEM_READS_PER_AVATAR_PER_DAY,
  ECOSYSTEM_SEARCH_QUERY_MAX,
  type EcosystemMarketReply,
  type EcosystemTokenPrice,
  type EcosystemTokenSignal,
  type EcosystemTrustReply,
} from '@clawville/shared';
import { api, ApiError } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useHumanSpendPolicy } from './spending-card';
import { StudiosSection } from './studios-card';

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIELD = 'w-full min-w-0 min-h-[44px] rounded-md bg-black/30 border border-white/20 px-3 text-sm text-white placeholder:text-white/40';
const BUTTON = 'min-h-[44px] px-4 rounded-md bg-white/15 hover:bg-white/25 text-sm text-white disabled:opacity-50';

/** Plain text for a refused read. Branches on the API `code`, never on raw text. */
export function readErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'read_budget_exhausted':
        return `You used your ${ECOSYSTEM_READS_PER_AVATAR_PER_DAY} checks for today. Try again after 00:00 UTC.`;
      case 'rate_limited':
        return 'Too many checks. Wait one minute.';
      case 'invalid_request':
        return 'Check the address or the text and try again.';
      case 'token_not_found':
        return 'The vendor does not know this token.';
      case 'vendor_not_configured':
        return 'This check is not available right now.';
      case 'vendor_unreachable':
      case 'vendor_reply_unreadable':
        return 'The vendor did not give a usable answer. Try again later.';
    }
  }
  return 'The check failed. Try again.';
}

function usd(value: number | null): string {
  if (value === null) return 'not known';
  return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
}

function percent(value: number | null): string {
  if (value === null) return 'not known';
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return 'not known';
  return value ? 'yes' : 'no';
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function tokenLabel(token: { mint: string; vendorData: { symbol: string | null; name: string | null } }): string {
  return token.vendorData.symbol ?? token.vendorData.name ?? shortAddress(token.mint);
}

function PriceView({ token }: { token: EcosystemTokenPrice }) {
  return (
    <dl className="text-xs text-white/80 space-y-1 break-words" data-testid="token-price">
      <div><dt className="inline text-white/60">Token: </dt><dd className="inline">{tokenLabel(token)}</dd></div>
      <div><dt className="inline text-white/60">Price: </dt><dd className="inline">{usd(token.priceUsd)}</dd></div>
      <div><dt className="inline text-white/60">24 h change: </dt><dd className="inline">{percent(token.change24h)}</dd></div>
      <div><dt className="inline text-white/60">Market cap: </dt><dd className="inline">{usd(token.marketCapUsd)}</dd></div>
      <div><dt className="inline text-white/60">Liquidity: </dt><dd className="inline">{usd(token.liquidityUsd)}</dd></div>
      <div><dt className="inline text-white/60">24 h volume: </dt><dd className="inline">{usd(token.volume24hUsd)}</dd></div>
      <div><dt className="inline text-white/60">Address: </dt><dd className="inline break-all">{token.mint}</dd></div>
    </dl>
  );
}

function TokenLookup() {
  const isMobile = useIsMobile();
  const [text, setText] = useState('');
  const read = useMutation<EcosystemMarketReply, unknown, string>({
    mutationFn: (input) => (BASE58_ADDRESS.test(input)
      ? api.ecosystemMarket('price', { mint: input })
      : api.ecosystemMarket('search', { query: input, limit: 10 })),
  });
  const reply = read.data;
  const input = text.trim();
  return (
    <div className="space-y-2">
      <label className="block text-xs text-white/60" htmlFor="token-check-input">A token address, a name or a symbol</label>
      <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'flex-row'}`}>
        <input
          id="token-check-input"
          className={FIELD}
          value={text}
          maxLength={Math.max(ECOSYSTEM_SEARCH_QUERY_MAX, 44)}
          onChange={(event) => setText(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className={BUTTON} disabled={!input || read.isPending} onClick={() => read.mutate(input)}>
          {read.isPending ? 'Checking...' : 'Check'}
        </button>
      </div>
      {read.isError && <p role="alert" className="text-xs text-red-300 leading-relaxed">{readErrorText(read.error)}</p>}
      {reply?.op === 'price' && <PriceView token={reply.token} />}
      {reply?.op === 'search' && (reply.tokens.length === 0
        ? <p className="text-xs text-white/60">No token found.</p>
        : (
          <ul className="space-y-1" data-testid="token-search-results">
            {reply.tokens.map((token) => (
              <li key={token.mint}>
                <button
                  type="button"
                  className="w-full min-h-[44px] px-3 rounded-md border border-white/20 text-left text-xs text-white/80 hover:bg-white/10 break-words"
                  onClick={() => {
                    setText(token.mint);
                    read.mutate(token.mint);
                  }}
                >
                  {tokenLabel(token)}{token.verified ? ' (verified)' : ''} {shortAddress(token.mint)}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function SignalRows({ tokens }: { tokens: EcosystemTokenSignal[] }) {
  if (tokens.length === 0) return <p className="text-xs text-white/60">Nothing to show right now.</p>;
  return (
    <ul className="space-y-1" data-testid="token-movers">
      {tokens.map((token) => (
        <li key={token.mint} className="text-xs text-white/80 break-words">
          {tokenLabel(token)}: {usd(token.priceUsd)}, {percent(token.change24h)}
          <span className="block text-white/50 break-all">{token.mint}</span>
        </li>
      ))}
    </ul>
  );
}

function TopMovers() {
  const read = useMutation({ mutationFn: () => api.ecosystemMarket('top_movers', { limit: 10 }) });
  const reply = read.data;
  return (
    <div className="space-y-2">
      <button type="button" className={`w-full ${BUTTON}`} disabled={read.isPending} onClick={() => read.mutate()}>
        {read.isPending ? 'Loading...' : 'Show top movers'}
      </button>
      {read.isError && <p role="alert" className="text-xs text-red-300 leading-relaxed">{readErrorText(read.error)}</p>}
      {reply?.op === 'top_movers' && <SignalRows tokens={reply.tokens} />}
    </div>
  );
}

function TrustView({ reply }: { reply: EcosystemTrustReply }) {
  return (
    <dl className="text-xs text-white/80 space-y-1 break-words" data-testid="wallet-trust">
      <div><dt className="inline text-white/60">Registered on SAID: </dt><dd className="inline">{yesNo(reply.registered)}</dd></div>
      <div><dt className="inline text-white/60">Verified: </dt><dd className="inline">{yesNo(reply.verified)}</dd></div>
      <div><dt className="inline text-white/60">Trust tier: </dt><dd className="inline">{reply.vendorData.trustTier ?? 'not known'}</dd></div>
      <div><dt className="inline text-white/60">Rank: </dt><dd className="inline">{reply.vendorData.tier ?? 'not known'}</dd></div>
      <div><dt className="inline text-white/60">Score: </dt><dd className="inline">{reply.compositeScore ?? 'not known'}</dd></div>
    </dl>
  );
}

function WalletTrust() {
  const isMobile = useIsMobile();
  const [wallet, setWallet] = useState('');
  const read = useMutation({ mutationFn: (address: string) => api.ecosystemTrust(address) });
  const address = wallet.trim();
  return (
    <div className="space-y-2">
      <label className="block text-xs text-white/60" htmlFor="wallet-check-input">A Solana wallet address</label>
      <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'flex-row'}`}>
        <input
          id="wallet-check-input"
          className={FIELD}
          value={wallet}
          maxLength={44}
          onChange={(event) => setWallet(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={!BASE58_ADDRESS.test(address) || read.isPending}
          onClick={() => read.mutate(address)}
        >
          {read.isPending ? 'Checking...' : 'Check trust'}
        </button>
      </div>
      {read.isError && <p role="alert" className="text-xs text-red-300 leading-relaxed">{readErrorText(read.error)}</p>}
      {read.data && <TrustView reply={read.data} />}
      <p className="text-xs text-white/60 leading-relaxed">An unregistered wallet is not proof of a bad actor. It is one signal.</p>
    </div>
  );
}

export function TokenCheckCard() {
  const { signedIn } = useHumanSpendPolicy();
  if (!signedIn) return null;
  return (
    <div className="space-y-2" data-testid="token-check-card">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🔎</span>
        <h3 className="font-bold text-sm text-white">Token and wallet check</h3>
      </div>
      <div className="bg-sky-500/10 border border-sky-400/25 rounded-lg p-3 space-y-2 min-w-0">
        <p className="text-xs text-white/70 leading-relaxed">
          Free checks, up to {ECOSYSTEM_READS_PER_AVATAR_PER_DAY} a day for you and your agent together. Prices come from ClawPump and trust comes from SAID. This is not advice.
        </p>
        <StudiosSection title="Token price or search"><TokenLookup /></StudiosSection>
        <StudiosSection title="Top movers"><TopMovers /></StudiosSection>
        <StudiosSection title="Wallet trust"><WalletTrust /></StudiosSection>
      </div>
    </div>
  );
}
