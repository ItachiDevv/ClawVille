'use client';

/**
 * AgentAiCard: the human picks the AI that powers their hosted agent (own AI
 * part A, 2026-11-09, GET/PUT/DELETE /api/agent-ai). ClawVille AI is the
 * default. The human can use their own key (OpenAI, Anthropic, OpenRouter) or
 * UsePod, with a model, a speed and a daily dollar limit. Avatar
 * agent-wallet money moves through the separate UsePod deposit control.
 *
 * Secrets: the key input is a password field and clears after each save; the
 * server returns only the last 4 characters. The UsePod dashboard link holds
 * the UsePod token, so it lives only in this component's state (never the
 * query cache) and shows only after register or a "Show my UsePod link" tap,
 * and both need the linked wallet's signature (a magic_link session alone is
 * not proof of a human). Without a linked wallet the human can paste a token
 * from their own UsePod account instead.
 *
 * A daily limit above the saved one needs the linked wallet's signature, the
 * same flow as the spend rules raise: on 403 `raise_needs_signature` the card
 * asks POST /api/agent-ai/challenge for the message, the wallet signs it, and
 * the PUT goes again with `proof`.
 */

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OWN_AI_DAILY_LIMIT_MAX_CENTS,
  OWN_AI_USEPOD_DEPOSIT_MAX_CENTS,
  OWN_AI_USEPOD_DEPOSIT_MIN_CENTS,
  OWN_AI_USEPOD_MIN_SOL_LAMPORTS,
  USEPOD_DEPOSITS_PER_DAY,
  OWN_AI_DAILY_LIMIT_MIN_CENTS,
  OWN_AI_DEFAULT_MAX_TOKENS,
  OWN_AI_DEFAULT_SPEED_SECONDS,
  OWN_AI_PROVIDER_SPECS,
  OWN_AI_REASONING_MAX_TOKENS,
  OWN_AI_RECOMMENDED_MODELS,
  OWN_AI_SPEEDS_SECONDS,
  isOwnAiReasoningModel,
  ownAiModelPrice,
  type OwnAiFallbackReason,
  type OwnAiProvider,
  type OwnAiRecommendedModel,
  type OwnAiSource,
  type OwnAiStatus,
} from '@clawville/shared';
import { api, ApiError } from '@/lib/api';
import { getFingerprint } from '@/lib/fingerprint';
import { WalletSignError, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { centsToUsdText, parseUsdToCents } from '@/lib/usd-cents';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useHumanSpendPolicy } from './spending-card';
import { StudiosSection } from './studios-card';

export const AGENT_AI_QUERY_KEY = ['agent-ai'] as const;

/** Input tokens per decision used for the estimate (the decide prompt is about 3k tokens). */
export const ESTIMATE_INPUT_TOKENS = 3000;

const FIELD = 'w-full min-w-0 min-h-[44px] rounded-md bg-black/40 border border-white/15 px-3 text-sm text-white placeholder:text-white/40';
const BUTTON = 'min-h-[44px] px-4 rounded-md bg-white/15 hover:bg-white/25 text-sm text-white disabled:opacity-50';
const OWN_KEY_PROVIDERS: OwnAiProvider[] = ['openai', 'anthropic', 'openrouter'];

const SOURCE_LABELS: Record<OwnAiSource, string> = {
  clawville: 'ClawVille AI',
  own_key: 'Your own key',
  usepod: 'UsePod',
};

const SPEED_LABELS: Record<number, string> = {
  25: "Every 25 s (today's speed)",
  20: 'Every 20 s',
  15: 'Every 15 s',
  10: 'Every 10 s (fastest)',
};

// ── API (lib/api.ts has no /api/agent-ai methods yet; this mirrors its request()) ──

const API_URL = process.env.NEXT_PUBLIC_API_SAME_ORIGIN === '1' ? '' : process.env.NEXT_PUBLIC_API_URL || '';

async function agentAiRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const fp = await getFingerprint().catch(() => '');
  if (fp) headers['X-CV-Fingerprint'] = fp;
  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown; reason?: unknown };
    // Only the code (and the key-test `reason` code) travel on: an error body
    // is never shown as text.
    const apiError = new ApiError(
      typeof err.error === 'string' ? err.error : `HTTP ${res.status}`,
      res.status,
      typeof err.code === 'string' ? err.code : undefined,
    );
    if (typeof err.reason === 'string') apiError.detail = err.reason;
    throw apiError;
  }
  // An empty body is tolerated.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface SaveAgentAiBody {
  source: OwnAiSource;
  provider?: OwnAiProvider;
  model?: string;
  speedSeconds?: number;
  dailyLimitCents?: number;
  key?: string;
}

type UsepodAction = 'register' | 'link';
interface WalletProof { nonce: string; signature: string }
interface UsepodRegisterReply { dashboardUrl: string; depositCode: string; contractAddress: string; ai: OwnAiStatus }

const agentAiApi = {
  status: () => agentAiRequest<{ ai: OwnAiStatus }>('/api/agent-ai').then((r) => r.ai),
  save: (body: SaveAgentAiBody & { proof?: { nonce: string; signature: string } }) =>
    agentAiRequest<{ ai: OwnAiStatus }>('/api/agent-ai', { method: 'PUT', body }).then((r) => r.ai),
  challenge: (body: SaveAgentAiBody) =>
    agentAiRequest<{ nonce: string; expiresAt: string; messageToSign: string; walletPubkey: string }>(
      '/api/agent-ai/challenge', { method: 'POST', body },
    ),
  clear: () => agentAiRequest<{ ai: OwnAiStatus }>('/api/agent-ai', { method: 'DELETE' }).then((r) => r.ai),
  models: (provider: OwnAiProvider, key?: string) =>
    agentAiRequest<{ models: string[]; recommended: OwnAiRecommendedModel[] }>(
      '/api/agent-ai/models', { method: 'POST', body: key ? { provider, key } : { provider } },
    ),
  usepodChallenge: (action: UsepodAction) =>
    agentAiRequest<{ nonce: string; expiresAt: string; messageToSign: string; walletPubkey: string }>(
      `/api/agent-ai/usepod/${action}/challenge`, { method: 'POST' },
    ),
  usepodRegister: (proof: WalletProof) =>
    agentAiRequest<UsepodRegisterReply>('/api/agent-ai/usepod/register', { method: 'POST', body: { proof } }),
  usepodLink: (proof: WalletProof) =>
    agentAiRequest<{ dashboardUrl: string }>('/api/agent-ai/usepod/link', { method: 'POST', body: { proof } }),
  usepodBalance: () => agentAiRequest<{ usdcMicro: number; isActive: boolean }>('/api/agent-ai/usepod/balance'),
  /** Can ClawVille pay the network fee of the next deposit NOW (server checks the fee wallet, its SOL and the caps). */
  usepodFee: () => agentAiRequest<{
    sponsored: boolean;
    reason: 'no_fee_wallet' | 'avatar_daily_limit' | 'daily_limit' | 'fee_wallet_empty' | 'unavailable' | null;
    avatarSponsoredToday: number | null;
    sponsoredPerAvatarPerDay: number;
    avatarMinSolLamports: number;
  }>('/api/agent-ai/usepod/fee'),
};

/**
 * Save the settings. A daily limit above the saved one comes back 403
 * `raise_needs_signature`: the linked wallet then signs the challenge for the
 * exact same values (the spend rules raise flow), and the PUT goes again.
 */
export async function saveWithRaiseProof(body: SaveAgentAiBody): Promise<OwnAiStatus> {
  try {
    return await agentAiApi.save(body);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'raise_needs_signature') throw error;
  }
  const challenge = await agentAiApi.challenge(body);
  const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
  return agentAiApi.save({ ...body, proof: { nonce: challenge.nonce, signature: signed.signatureBase58 } });
}

/**
 * The UsePod token (inside the dashboard link) never reaches a session without
 * the linked wallet's signature: the wallet signs the challenge for this one
 * action ('ClawVille UsePod register' / 'ClawVille UsePod link'), then the POST
 * goes with `proof`. No linked wallet -> 403 wallet_link_required.
 */
async function signUsepodAction(action: UsepodAction): Promise<WalletProof> {
  const challenge = await agentAiApi.usepodChallenge(action);
  const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
  return { nonce: challenge.nonce, signature: signed.signatureBase58 };
}

export async function registerUsepodWithProof(): Promise<UsepodRegisterReply> {
  return agentAiApi.usepodRegister(await signUsepodAction('register'));
}

export async function readUsepodLinkWithProof(): Promise<{ dashboardUrl: string }> {
  return agentAiApi.usepodLink(await signUsepodAction('link'));
}

export interface UsepodDepositReply {
  ok: true;
  ledgerId: string;
  status: 'pending' | 'paid' | 'ambiguous' | 'failed';
  txSignature: string | null;
  usdCents: number;
  creditStatus: 'unknown' | 'seen';
  balance: { usdcMicro: number; isActive: boolean } | null;
  /** Who is the fee payer of this transaction (chosen, not proof of a charge). */
  feePayer?: 'clawville' | 'avatar';
  /** true = the chain finalized it (fee charged); false = it never landed (no fee); null = not known yet. */
  feeCharged?: boolean | null;
}

export async function depositUsepodWithProof(
  amountCents: number, idempotencyKey: string, requireApproval: boolean,
): Promise<UsepodDepositReply> {
  const body = { amountCents, idempotencyKey };
  let proof: WalletProof | undefined;
  if (requireApproval) {
    const challenge = await agentAiRequest<{ nonce: string; messageToSign: string; walletPubkey: string }>(
      '/api/agent-ai/usepod/deposit/challenge', { method: 'POST', body },
    );
    const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
    proof = { nonce: challenge.nonce, signature: signed.signatureBase58 };
  }
  return agentAiRequest<UsepodDepositReply>('/api/agent-ai/usepod/deposit', {
    method: 'POST', body: { ...body, ...proof },
  });
}

// ── Pure helpers (tested) ──

/** Decisions per day at one speed. */
export function decisionsPerDay(speedSeconds: number): number {
  return Math.floor(86_400 / speedSeconds);
}

/**
 * ESTIMATED US dollars per day: each decision = 3000 input tokens + output
 * tokens (OWN_AI_DEFAULT_MAX_TOKENS, or OWN_AI_REASONING_MAX_TOKENS for a
 * reasoning model), priced per million tokens with the shared price table the
 * server meter uses, times the decisions per day at this speed.
 */
export function estimateDailyUsd(model: string, speedSeconds: number, reasoning: boolean): number {
  const price = ownAiModelPrice(model);
  const output = reasoning ? OWN_AI_REASONING_MAX_TOKENS : OWN_AI_DEFAULT_MAX_TOKENS;
  const perCall = (ESTIMATE_INPUT_TOKENS * price.inputPerM + output * price.outputPerM) / 1_000_000;
  return perCall * (86_400 / speedSeconds);
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return 'less than $0.01';
  return `$${value.toFixed(2)}`;
}

/** Plain words for why the agent went back to ClawVille AI. */
export function fallbackReasonText(reason: OwnAiFallbackReason): string {
  switch (reason) {
    case 'daily_limit':
      return "Today's limit is reached. Your agent uses ClawVille AI until midnight UTC.";
    case 'key_rejected':
      return 'Your provider refused the key. Your agent uses ClawVille AI until you save a working key.';
    case 'balance_empty':
      return 'Your UsePod balance is empty. Your agent uses ClawVille AI until you add funds.';
    case 'provider_error':
      return 'Your provider did not answer in time, so your agent used ClawVille AI.';
    case 'model_unavailable':
      return 'Your provider does not offer this model now. Pick another model and save.';
  }
  return 'Your agent uses ClawVille AI for now.';
}

/** Plain text for a failed action. Branches on the API `code`, never on raw text. */
export function agentAiErrorText(error: unknown): string {
  // The wallet's own messages are plain text written for people.
  if (error instanceof WalletSignError) return error.message;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'needs_sol_for_fee':
        return 'Your avatar wallet needs at least 0.000015 SOL for the network fee.';
      case 'fee_wallet_empty':
        return 'The ClawVille fee wallet is empty now. Add at least 0.000015 SOL to your avatar wallet, or try again later.';
      case 'fee_sponsor_daily_limit':
        return 'ClawVille paid all the network fees it can pay today. Add at least 0.000015 SOL to your avatar wallet, or try again after midnight UTC.';
      case 'fee_sponsor_avatar_daily_limit':
        return 'ClawVille paid the network fee of your agent\'s deposits the most times it can today. Add at least 0.000015 SOL to your avatar wallet, or try again after midnight UTC.';
      case 'insufficient_usdc':
        return 'Your avatar wallet does not have enough USDC.';
      case 'approval_required':
      case 'signature_required':
        return 'Your linked wallet must approve this deposit. Check your spend rules, then sign again.';
      case 'usepod_deposit_code_missing':
        return 'This UsePod balance cannot accept wallet deposits here. Use your private UsePod link instead.';
      case 'vendor_not_allowed':
        return 'Allow UsePod in Spending before you add funds.';
      case 'wallet_link_required':
        return 'Link your own wallet first (below). Your linked wallet must approve a higher daily limit.';
      case 'raise_needs_signature':
        return 'A higher daily limit needs a signature from your linked wallet. Approve it in your wallet and try again.';
      case 'usepod_needs_signature':
        return 'Your linked wallet must sign before ClawVille shows the UsePod link. Approve it in your wallet and try again.';
      case 'invalid_wallet_proof':
        return 'The wallet signature did not match. Sign again with your linked wallet.';
      case 'key_test_failed':
        return keyTestFailedText(error.detail);
      case 'key_required':
        return 'Paste the API key for this provider.';
      case 'models_unavailable':
        return 'The provider did not send a model list. Check the key and try again.';
      case 'usepod_register_failed':
        return 'UsePod did not create a balance. Try again later.';
      case 'usepod_not_set':
        return 'Your agent has no UsePod balance yet. Create one first.';
      case 'usepod_token_registered':
        return 'ClawVille already made a UsePod balance for your agent. Leave the token field empty and save.';
      case 'usepod_already_registered':
        return 'Your agent already has a UsePod balance. Tap "Show my UsePod link" to fund it.';
      case 'rate_limited':
        return 'Too many tries. Wait a little and try again.';
      case 'openclaw_gateway_set':
        return 'Your agent uses its own OpenClaw gateway. Remove the gateway first, then pick an AI here.';
      case 'human_only':
        return 'Only you can change this, from your own browser sign-in. Your agent can only read it.';
      case 'needs_human_login':
        return 'Sign in again in your browser, then change the AI of your agent.';
      case 'invalid_agent_ai':
        return 'Some values are not valid. Check the key, the model, the speed and the daily limit.';
      case 'key_rejected':
      case 'invalid_key':
        return 'The provider refused this key. Check the key and try again.';
      case 'model_unavailable':
        return 'This model does not work with this key. Pick another model.';
      case 'balance_empty':
        return 'Your UsePod balance is empty. Add funds on UsePod first.';
      case 'timeout':
      case 'provider_error':
        return 'The provider did not answer. Try again later.';
    }
    if (error.status === 400) return 'Check the values and try again.';
  }
  return 'That did not work. Try again.';
}

/** Plain words for the `reason` of a 400 key_test_failed (a safe code from the server). */
export function keyTestFailedText(reason: string | undefined): string {
  switch (reason) {
    case 'key_rejected':
    case 'invalid_key':
      return 'The provider refused this key. Check the key and try again.';
    case 'balance_empty':
      return 'Your UsePod balance is empty. Add funds on UsePod first, then save.';
    case 'model_unavailable':
    case 'invalid_model':
      return 'This model does not work with this key. Pick another model.';
    case 'rate_limited':
      return 'The provider is limiting this key now. Wait a little and try again.';
    case 'timeout':
      return 'The provider did not answer the test in time. Try again.';
  }
  return 'The provider refused a test call with this key and model. Try again later.';
}

// ── UI ──

function StatusLine({ ai }: { ai: OwnAiStatus }) {
  const own = ai.source !== 'clawville';
  return (
    <div className="text-xs text-white/80 space-y-1 leading-relaxed" data-testid="agent-ai-status">
      <p>
        Now using: <span className="font-semibold">{ai.activeNow === 'own' ? `your AI (${ai.model ?? 'no model'})` : 'ClawVille AI'}</span>
      </p>
      {own && (
        <p>
          Today: {ai.today.calls} call{ai.today.calls === 1 ? '' : 's'}, about {formatUsd(ai.today.estimatedCents / 100)} estimated
          {ai.dailyLimitCents !== null ? ` of your $${centsToUsdText(ai.dailyLimitCents)} limit` : ''}.
        </p>
      )}
      {ai.fallbackReason && (
        <p role="status" className="text-amber-200" data-testid="agent-ai-fallback">{fallbackReasonText(ai.fallbackReason)}</p>
      )}
    </div>
  );
}

export const USEPOD_NEEDS_WALLET_TEXT =
  'Link your own wallet first (below): your linked wallet must approve a UsePod balance and its link. '
  + 'Or paste a token from your own UsePod account in the token field instead.';

/** The network fee line of a deposit receipt: "paid" only for a fee the chain charged. */
export function feeLineText(feePayer: 'clawville' | 'avatar', feeCharged: boolean | null): string | null {
  const who = feePayer === 'clawville' ? 'ClawVille' : 'Your agent wallet';
  if (feeCharged === true) return `${who} paid the network fee.`;
  if (feeCharged === null) return `${who} will pay the network fee if this deposit lands.`;
  return null; // Never landed: no fee.
}

function FeeLine({ feePayer, feeCharged }: { feePayer: 'clawville' | 'avatar'; feeCharged: boolean | null }) {
  const text = feeLineText(feePayer, feeCharged);
  return text ? <p data-testid="usepod-fee-line">{text}</p> : null;
}

function UsepodDepositControl() {
  const { query } = useHumanSpendPolicy();
  const policy = query.data;
  const client = useQueryClient();
  const [amount, setAmount] = useState('0.50');
  const [error, setError] = useState<string | null>(null);
  // Preserve the request identity after a transport error. A retry cannot pay twice.
  const request = useRef<{ amountCents: number; key: string } | null>(null);
  const wallet = useQuery({ queryKey: ['wallet-balances'], queryFn: api.walletBalances, retry: false, staleTime: 15_000 });
  const fee = useQuery({ queryKey: [...AGENT_AI_QUERY_KEY, 'usepod-fee'], queryFn: agentAiApi.usepodFee, retry: false, staleTime: 60_000 });
  const max = Math.min(policy?.perCallCapUsdCents ?? 0, OWN_AI_USEPOD_DEPOSIT_MAX_CENTS);
  const allowed = !!policy?.configured && policy.allowedVendors.includes('usepod') && max >= OWN_AI_USEPOD_DEPOSIT_MIN_CENTS;
  const deposit = useMutation({
    mutationFn: ({ amountCents, key, refresh = false }: { amountCents: number; key: string; refresh?: boolean }) =>
      depositUsepodWithProof(amountCents, key, !refresh && (policy?.requireApproval ?? true)),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: [...AGENT_AI_QUERY_KEY, 'usepod-balance'] });
      client.invalidateQueries({ queryKey: [...AGENT_AI_QUERY_KEY, 'usepod-fee'] });
      client.invalidateQueries({ queryKey: ['wallet-balances'] });
    },
    onError: (failure) => {
      // These failures precede admission. Network errors retain the same key.
      if (failure instanceof WalletSignError || (failure instanceof ApiError && [
        'approval_required', 'invalid_wallet_proof', 'wallet_link_required', 'vendor_not_allowed',
        'spend_rules_not_set', 'over_per_call_cap', 'over_daily_cap', 'deposit_daily_limit', 'signature_required',
        'needs_sol_for_fee', 'fee_wallet_empty', 'fee_sponsor_daily_limit', 'fee_sponsor_avatar_daily_limit', 'insufficient_usdc',
        'usepod_deposit_code_missing',
      ].includes(failure.code ?? ''))) request.current = null;
    },
    retry: false,
  });
  const submit = () => {
    setError(null);
    if (request.current) return deposit.mutate({ ...request.current, refresh: !!deposit.data });
    const parsed = parseUsdToCents(amount, max);
    if (!parsed.ok) return setError(parsed.reason);
    if (parsed.cents === null || parsed.cents < OWN_AI_USEPOD_DEPOSIT_MIN_CENTS) return setError('Enter at least $0.10.');
    if (!request.current) request.current = { amountCents: parsed.cents, key: crypto.randomUUID() };
    deposit.mutate(request.current);
  };
  const balances = wallet.data?.balances;
  const sol = balances?.SOL;
  // When ClawVille can pay the network fee now, the avatar wallet needs no SOL.
  // The server checks the fee wallet, its SOL and both daily caps; it decides again at deposit.
  const sponsored = fee.data?.sponsored === true;
  const needsSol = !sponsored && sol?.available && sol.amountAtomic !== null && BigInt(sol.amountAtomic) < BigInt(OWN_AI_USEPOD_MIN_SOL_LAMPORTS);
  const receipt = deposit.data;
  const settled = receipt?.status === 'paid' || receipt?.status === 'failed';
  return (
    <div className="space-y-2 border-t border-white/15 pt-2" data-testid="usepod-deposit">
      <p className="text-xs text-white/80">Add USDC from your avatar wallet to your AI balance.</p>
      <p className="text-xs text-white/65">
        Wallet USDC: {balances?.USDC.available && balances.USDC.uiAmount !== null ? `$${balances.USDC.uiAmount.toFixed(2)}` : 'unavailable'}.
        {' '}Wallet SOL: {sol?.available && sol.uiAmount !== null ? sol.uiAmount : 'unavailable'}.
      </p>
      <p className={`text-xs ${needsSol ? 'text-amber-200' : 'text-white/65'}`} data-testid="usepod-fee-note">
        {sponsored
          ? 'ClawVille pays the network fee. Your wallet needs no SOL.'
          : `Your wallet needs at least ${OWN_AI_USEPOD_MIN_SOL_LAMPORTS / 1_000_000_000} SOL for the network fee.`}
        {' '}At most {USEPOD_DEPOSITS_PER_DAY} deposits per UTC day.
      </p>
      {!allowed && <p className="text-xs text-amber-200">Allow UsePod and set both caps in Spending first.</p>}
      <label className="block text-xs text-white/80 space-y-1">
        <span>Deposit amount (US$), $0.10 to ${centsToUsdText(max)}</span>
        <input inputMode="decimal" className={FIELD} value={amount} disabled={deposit.isPending || request.current !== null}
          onChange={(event) => setAmount(event.target.value)} />
      </label>
      {policy?.requireApproval && <p className="text-xs text-white/65">Your linked wallet signs each deposit because approval is on.</p>}
      <button type="button" className={`w-full ${BUTTON}`} disabled={!allowed || deposit.isPending || !!needsSol || !!receipt}
        onClick={submit}>{deposit.isPending ? 'Check your wallet and wait...' : receipt ? 'Deposit submitted' : request.current ? 'Check the same deposit' : 'Add to AI balance'}</button>
      {(error || deposit.error) && <p role="alert" className="text-xs text-red-300">{error ?? agentAiErrorText(deposit.error)}</p>}
      {receipt && <div role="status" className="text-xs text-white/80 break-words">
        <p>Chain status: {receipt.status}. UsePod credit: {receipt.creditStatus}.</p>
        {receipt.status === 'paid' && <p>The chain finalized this deposit.</p>}
        {receipt.feePayer && <FeeLine feePayer={receipt.feePayer} feeCharged={receipt.feeCharged ?? null} />}
        {receipt.creditStatus === 'unknown' && <p>UsePod credit is not confirmed. Do not repeat this deposit.</p>}
        {receipt.balance && <p>UsePod balance: ${(receipt.balance.usdcMicro / 1_000_000).toFixed(2)}.</p>}
        {receipt.txSignature && <p className="break-all">Transaction: {receipt.txSignature}</p>}
      </div>}
      {receipt && (!settled || (receipt.status === 'paid' && receipt.creditStatus === 'unknown')) &&
        <button type="button" className={BUTTON} disabled={deposit.isPending} onClick={submit}>Check the same deposit</button>}
      {settled && <p className="text-xs text-white/65">A new deposit spends more USDC. It does not check the previous credit.</p>}
      {settled && <button type="button" className={BUTTON} onClick={() => { request.current = null; deposit.reset(); }}>Start another deposit</button>}
    </div>
  );
}

function UsepodBlock({ ai, onStatus }: { ai: OwnAiStatus; onStatus: (ai: OwnAiStatus) => void }) {
  const isMobile = useIsMobile();
  // The link holds the UsePod token: component state only, never the query cache.
  const [link, setLink] = useState<string | null>(null);
  const [depositCode, setDepositCode] = useState<string | null>(null);
  // A token ClawVille registered (source can still be 'clawville' right after
  // register) or a token the human pasted from their own UsePod account.
  const hasToken = ai.usepodRegistered || (ai.provider === 'usepod' && ai.keyLast4 !== null);
  const register = useMutation({
    mutationFn: registerUsepodWithProof,
    onSuccess: (reply) => {
      setLink(reply.dashboardUrl);
      setDepositCode(reply.depositCode);
      onStatus(reply.ai);
    },
  });
  const showLink = useMutation({ mutationFn: readUsepodLinkWithProof, onSuccess: (reply) => setLink(reply.dashboardUrl) });
  const balance = useQuery({
    queryKey: [...AGENT_AI_QUERY_KEY, 'usepod-balance'],
    queryFn: agentAiApi.usepodBalance,
    enabled: hasToken,
    retry: false,
    staleTime: 60_000,
  });
  const failure = register.error ?? showLink.error;
  const needsWallet = failure instanceof ApiError && failure.code === 'wallet_link_required';
  const safeLink = link && /^https:\/\/usepod\.ai\//.test(link) ? link : null;

  return (
    <div className="space-y-2" data-testid="usepod-block">
      <p className="text-xs text-white/70 leading-relaxed">
        UsePod sends prompts to independent GPU operators who can read them.
      </p>
      {!hasToken && (
        <button
          type="button"
          className={`w-full ${BUTTON}`}
          disabled={register.isPending}
          onClick={() => register.mutate()}
        >
          {register.isPending ? 'Approve in your wallet...' : 'Create a UsePod balance for my agent'}
        </button>
      )}
      {hasToken && balance.data && (
        <p className="text-xs text-white/80" data-testid="usepod-balance">
          UsePod balance: ${(balance.data.usdcMicro / 1_000_000).toFixed(2)}{balance.data.isActive ? '' : ' (not active)'}
        </p>
      )}
      {ai.usepodRegistered && <UsepodDepositControl />}
      {hasToken && !safeLink && (
        <button
          type="button"
          className={`w-full ${BUTTON}`}
          disabled={showLink.isPending}
          onClick={() => showLink.mutate()}
        >
          {showLink.isPending ? 'Approve in your wallet...' : 'Show my UsePod link'}
        </button>
      )}
      {safeLink && (
        <div className="space-y-2 text-xs text-white/80 break-words" data-testid="usepod-link">
          <p className="text-amber-200">This link controls your UsePod balance. Keep it private.</p>
          <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'flex-row'}`}>
            <a
              href={safeLink}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[44px] px-4 rounded-md bg-emerald-500/80 hover:bg-emerald-400 text-sm font-bold text-white flex items-center justify-center"
            >
              Add funds on UsePod
            </a>
            <button type="button" className={BUTTON} onClick={() => setLink(null)}>Hide link</button>
          </div>
          <p className="break-all text-white/60">{safeLink}</p>
          {depositCode && <p>Deposit code: <span className="font-mono break-all">{depositCode}</span></p>}
          <p className="text-white/60">Fund it by card or wallet on UsePod. If you lose this link, you lose access to the balance.</p>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-xs text-red-300">
          {needsWallet ? USEPOD_NEEDS_WALLET_TEXT : agentAiErrorText(failure)}
        </p>
      )}
    </div>
  );
}

function AgentAiForm({ ai }: { ai: OwnAiStatus }) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [source, setSource] = useState<OwnAiSource>(ai.source);
  const [provider, setProvider] = useState<OwnAiProvider>(ai.provider && ai.provider !== 'usepod' ? ai.provider : 'openai');
  const [model, setModel] = useState(ai.model ?? '');
  const [speed, setSpeed] = useState<number>(ai.speedSeconds || OWN_AI_DEFAULT_SPEED_SECONDS);
  const [limitText, setLimitText] = useState(centsToUsdText(ai.dailyLimitCents));
  const [keyText, setKeyText] = useState('');
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  // The form starts from the saved settings and reloads them only after a
  // save. A UsePod register also changes `ai`, but it must not move the radio
  // away from UsePod while the human is still filling the form.
  const loadSaved = (saved: OwnAiStatus) => {
    setSource(saved.source);
    if (saved.provider && saved.provider !== 'usepod') setProvider(saved.provider);
    setModel(saved.model ?? '');
    setSpeed(saved.speedSeconds || OWN_AI_DEFAULT_SPEED_SECONDS);
    setLimitText(centsToUsdText(saved.dailyLimitCents));
  };

  const activeProvider: OwnAiProvider = source === 'usepod' ? 'usepod' : provider;
  // UsePod with a registered token: the server uses that token, so the card
  // never asks for (or sends) a token. The server answers 400
  // usepod_token_registered to a pasted one.
  const registeredPod = source === 'usepod' && ai.usepodRegistered;
  const storedKeyHere = registeredPod || (ai.provider === activeProvider && ai.keyLast4 !== null);
  const setStatus = (next: OwnAiStatus) => queryClient.setQueryData(AGENT_AI_QUERY_KEY, next);

  const save = useMutation({
    mutationFn: saveWithRaiseProof,
    onSuccess: (next) => {
      setKeyText('');
      setStatus(next);
      loadSaved(next);
    },
    // The server decides what a raise is: reload the saved values after a refusal.
    onError: () => queryClient.invalidateQueries({ queryKey: AGENT_AI_QUERY_KEY, exact: true }),
  });
  const clear = useMutation({
    mutationFn: agentAiApi.clear,
    onSuccess: (next) => {
      setKeyText('');
      setStatus(next);
      loadSaved(next);
    },
  });
  const loadModels = useMutation({
    mutationFn: () => agentAiApi.models(activeProvider, keyText || undefined),
    onSuccess: (reply) => setLiveModels(reply.models),
  });

  const recommended = OWN_AI_RECOMMENDED_MODELS.filter((m) => m.provider === activeProvider);
  const recommendedIds = new Set(recommended.map((m) => m.model));
  const others = liveModels.filter((id) => !recommendedIds.has(id));
  const knownIds = new Set([...recommendedIds, ...others]);
  const reasoning = isOwnAiReasoningModel(activeProvider, model);

  const changeSource = (next: OwnAiSource) => {
    setSource(next);
    setLiveModels([]);
    setFormError(null);
  };
  const changeProvider = (next: OwnAiProvider) => {
    setProvider(next);
    setModel('');
    setLiveModels([]);
    setKeyText('');
  };

  const submit = () => {
    setFormError(null);
    const key = registeredPod ? '' : keyText.trim();
    if (key && !OWN_AI_PROVIDER_SPECS[activeProvider].keyPattern.test(key)) {
      return setFormError(source === 'usepod' ? 'This does not look like a UsePod token.' : 'This does not look like a key for this provider.');
    }
    if (!key && !storedKeyHere) {
      return setFormError(source === 'usepod' ? 'Paste a UsePod token or create a UsePod balance first.' : 'Paste your API key.');
    }
    if (!model) return setFormError('Pick a model.');
    const limit = parseUsdToCents(limitText, OWN_AI_DAILY_LIMIT_MAX_CENTS);
    if (!limit.ok) return setFormError(`Daily limit: ${limit.reason}`);
    if (limit.cents === null || limit.cents < OWN_AI_DAILY_LIMIT_MIN_CENTS) {
      return setFormError(`Daily limit: set at least $${centsToUsdText(OWN_AI_DAILY_LIMIT_MIN_CENTS)}.`);
    }
    save.mutate({
      source,
      provider: activeProvider,
      model,
      speedSeconds: speed,
      dailyLimitCents: limit.cents,
      ...(key ? { key } : {}),
    });
  };

  const failure = save.error ?? clear.error ?? loadModels.error;

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="text-xs text-white/80">Which AI runs your agent</legend>
        {(Object.keys(SOURCE_LABELS) as OwnAiSource[]).map((s) => (
          <label key={s} className="flex items-center gap-2 min-h-[44px] text-xs text-white/85">
            <input
              type="radio"
              name="agent-ai-source"
              className="h-5 w-5"
              checked={source === s}
              onChange={() => changeSource(s)}
            />
            {SOURCE_LABELS[s]}
          </label>
        ))}
      </fieldset>

      {source === 'clawville' ? (
        <div className="space-y-2">
          <p className="text-xs text-white/70 leading-relaxed">ClawVille AI is free and runs your agent at today&apos;s speed.</p>
          {ai.source !== 'clawville' && (
            <button
              type="button"
              className={`w-full ${BUTTON}`}
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {clear.isPending ? 'Switching...' : 'Use ClawVille AI'}
            </button>
          )}
        </div>
      ) : (
        <>
          {source === 'own_key' && (
            <label className="block text-xs text-white/80 space-y-1">
              <span>Provider</span>
              <select
                className={FIELD}
                value={provider}
                onChange={(e) => changeProvider(e.target.value as OwnAiProvider)}
              >
                {OWN_KEY_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{OWN_AI_PROVIDER_SPECS[p]?.label ?? p}</option>
                ))}
              </select>
            </label>
          )}
          {source === 'own_key' && provider === 'openrouter' && (
            <p className="text-xs text-white/70">OpenRouter sends prompts to the model&apos;s host.</p>
          )}
          {source === 'usepod' && <UsepodBlock ai={ai} onStatus={setStatus} />}

          {registeredPod ? (
            <p className="text-xs text-white/70" data-testid="agent-ai-registered-pod">
              Your agent uses the UsePod balance ClawVille created for it. No token to paste.
            </p>
          ) : (
          <label className="block text-xs text-white/80 space-y-1">
            <span>{source === 'usepod' ? 'UsePod token from your own UsePod account (optional)' : 'API key'}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyText}
              onChange={(e) => setKeyText(e.target.value.trim())}
              placeholder={storedKeyHere ? `Saved, ending ${ai.keyLast4}` : 'Paste it here'}
              aria-label={source === 'usepod' ? 'UsePod token' : 'API key'}
              className={FIELD}
            />
            {storedKeyHere && (
              <span className="block text-white/55" data-testid="agent-ai-key-last4">
                Saved key ending {ai.keyLast4}. Leave this empty to keep it.
              </span>
            )}
          </label>
          )}

          <div className="space-y-1">
            <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'flex-row items-end'}`}>
              <label className="block flex-1 min-w-0 text-xs text-white/80 space-y-1">
                <span>Model</span>
                <select className={FIELD} value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Pick a model</option>
                  {model && !knownIds.has(model) && <option value={model}>{model}</option>}
                  {recommended.length > 0 && (
                    <optgroup label="Recommended">
                      {recommended.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label="All models">
                      {others.map((id) => <option key={id} value={id}>{id}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              <button
                type="button"
                className={BUTTON}
                disabled={loadModels.isPending || (!keyText && !storedKeyHere)}
                onClick={() => loadModels.mutate()}
              >
                {loadModels.isPending ? 'Loading...' : 'Load models'}
              </button>
            </div>
          </div>

          <label className="block text-xs text-white/80 space-y-1">
            <span>Speed (time between decisions)</span>
            <select className={FIELD} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {OWN_AI_SPEEDS_SECONDS.map((s) => <option key={s} value={s}>{SPEED_LABELS[s] ?? `Every ${s} s`}</option>)}
            </select>
          </label>
          {model && (
            <p className="text-xs text-white/70 leading-relaxed" data-testid="agent-ai-estimate">
              Estimated: about {formatUsd(estimateDailyUsd(model, speed, reasoning))} per day at this speed
              ({decisionsPerDay(speed).toLocaleString('en-US')} decisions a day). Your provider bills the real cost.
            </p>
          )}

          <label className="block text-xs text-white/80 space-y-1">
            <span>Daily limit (US$)</span>
            <input
              inputMode="decimal"
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
              placeholder="For example 2"
              className={FIELD}
            />
            <span className="block text-white/55 leading-relaxed">
              When the estimated spend reaches this, your agent uses ClawVille AI until midnight UTC. A higher limit needs
              your linked wallet to sign. Lowering needs no signature.
            </span>
          </label>

          {(formError || failure) && (
            <p role="alert" className="text-xs text-red-300">{formError ?? agentAiErrorText(failure)}</p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="w-full min-h-[44px] rounded-md bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-sm font-bold text-white"
          >
            {save.isPending ? 'Testing and saving...' : 'Save'}
          </button>
          {save.isSuccess && !formError && <p className="text-xs text-emerald-300">Saved.</p>}
          {ai.source !== 'clawville' && (
            <button
              type="button"
              className={`w-full ${BUTTON}`}
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {clear.isPending ? 'Switching...' : 'Use ClawVille AI'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function AgentAiCard() {
  const { signedIn } = useHumanSpendPolicy();
  const query = useQuery({
    queryKey: AGENT_AI_QUERY_KEY,
    queryFn: agentAiApi.status,
    enabled: signedIn,
    retry: false,
    staleTime: 30_000,
  });
  if (!signedIn) return null;
  const ai = query.data;
  return (
    <div className="space-y-2" data-testid="agent-ai-card">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🧠</span>
        <h3 className="font-bold text-sm text-white">Agent AI</h3>
      </div>
      <div className="bg-sky-500/10 border border-sky-400/25 rounded-lg p-3 space-y-3 min-w-0">
        <p className="text-xs text-white/70 leading-relaxed">
          Pick the AI that runs your hosted agent. With your own key or UsePod, your agent can decide faster, and you pay
          your provider. Only you can change this; your agent can only read it.
        </p>
        {query.isLoading ? (
          <p className="text-xs text-white/60">Loading...</p>
        ) : query.isError || !ai ? (
          <p className="text-xs text-red-300">Your agent AI settings did not load. Try again later.</p>
        ) : (
          <>
            <StatusLine ai={ai} />
            <StudiosSection title="Change the AI"><AgentAiForm ai={ai} /></StudiosSection>
          </>
        )}
      </div>
    </div>
  );
}
