import type { BrainchainCapability, BrainchainCurriculumSection } from '@clawville/shared';
import { getFingerprint } from '@/lib/fingerprint';

export interface OfficeKnowledge {
  version: number;
  contentHash: string;
  reviewedAt: string;
  manual: string;
  sections: BrainchainCurriculumSection[];
  capabilities: BrainchainCapability[];
}

type PaymentObservation =
  | { state: 'observed'; checkedAt: string; offers: { network: string; amount: string; asset: string }[] }
  | { state: 'unavailable'; checkedAt: string; reason: string };

type ExitObservation =
  | { state: 'observed'; checkedAt: string; terms: { payoutChainId: number; feeBps: number } }
  | { state: 'unavailable'; checkedAt: string; reason: string };

export interface OfficeStatus {
  capabilities: BrainchainCapability[];
  observation: {
    observedAt: string;
    expiresAt: string;
    executionEnabled: false;
    payment: PaymentObservation;
    exits: { mainnet: ExitObservation; testnet: ExitObservation };
  };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
export type OfficeWorkerLocalState = 'paused' | 'draining' | 'running';
export function workerRequestDescription(state: OfficeWorkerLocalState): string {
  return {
    paused: 'Pause requested. Existing on-chain hires can remain active.',
    draining: 'Drain requested. Preserve accepted work until its result is confirmed.',
    running: 'Testnet work requested. This status does not confirm a task or payment.',
  }[state];
}

/** Public reads never forward the browser session or accept a vendor URL. */
export async function readOffice<T>(path: 'knowledge' | 'status', signal: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}/api/brainchain/${path}`, {
    credentials: 'omit', cache: 'no-store', signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(response.status === 429
      ? 'The Office received too many requests. Wait a minute before you retry.'
      : 'The Office cannot load this information. Try again shortly.');
  }
  return response.json() as Promise<T>;
}

export function observationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString();
}

export function paymentNetworkLabel(network: string): string {
  if (network.startsWith('solana:')) return 'Solana';
  if (network === 'eip155:8453') return 'Base';
  if (network === 'eip155:4663') return 'Robinhood Chain';
  return network;
}

export function officialEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'docs.usebrainchain.com') return url.href;
    if (url.hostname === 'github.com' && url.pathname.startsWith('/usebrainchain/')) return url.href;
  } catch { /* Invalid evidence URLs are not navigation targets. */ }
  return null;
}

const PRIVATE_ERRORS: Record<string, string> = {
  associated_token_account_required:'Create the payer devnet USDC token account in your wallet. Ask the desk to provision its receive account. The Office creates neither account.',
  execution_disabled:'Test-token signing and submission await the payment review.',
  owner_grant_required:'Set BrainChain spend rules in your account before a test purchase.',
  human_approval_required:'The account owner must approve this purchase with the linked wallet.',
  over_per_call_cap:'This purchase exceeds your per-call limit.',
  over_daily_cap:'Your purchase holds and daily spend exceed the daily limit.',
  order_conflict:'Refresh this order. Do not create another payment.',
  quote_refused:'The current quote does not match the reviewed test network and price.',
  receipt_unavailable:'The Office cannot verify the receipt. Its hold remains reserved.',
  payer_conflict:'This payer address belongs to another avatar.',
  authentication_required: 'Sign in with your own account before this action.',
  access_denied: 'Your account cannot use this action. Check your avatar connection.',
  invalid_request: 'Check the address, network, and signature fields.',
  invalid_proof: 'The signature does not match this request, or the request expired. Request a new message.',
  binding_conflict: 'This address or network already has a permanent connection. Keep the existing connection.',
  worker_not_found: 'The worker connection no longer appears in your account. Refresh the list.',
  chain_read_unavailable: 'The Office cannot confirm this chain observation. Try again later.',
  rate_limited: 'Wait a minute before another request.',
  agent_not_connected: 'Connect your agent in town before you install this curriculum.',
  runtime_unavailable: 'Your agent runtime is unavailable. Check its connection before another request.',
};

/** Private writes use the account cookie and never create a guest session or retry. */
export async function officeAccountRequest<T>(
  path: 'funding-exit' | `funding-exit/${string}` | `workers/${string}/recovery` | `workers/${string}/recovery/${string}/${'challenge'|'approve'|'revoke'|'narrow'}` | `workers/${string}/policy` | `workers/${string}/policy/control` | `workers/${string}/policy/narrow` | `workers/${string}/policy/${string}/challenge` | `workers/${string}/policy/${string}/approve` | 'purchases' | `purchases/${string}` | 'workers' | 'workers/challenge' | 'workers/bind' | 'install' | `workers/${string}/control` | `workers/${string}/earnings${'' | `?${string}`}` | `workers/${string}/identity-credit?agentId=${string}`,
  signal: AbortSignal,
  body?: Record<string, unknown>,
): Promise<T> {
  const fingerprint = await getFingerprint();
  signal.throwIfAborted();
  const response = await fetch(`${API_BASE}/api/brainchain/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(fingerprint ? { 'X-CV-Fingerprint': fingerprint } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const code = error && typeof error === 'object' && 'error' in error && typeof error.error === 'string' ? error.error : '';
    throw new Error(PRIVATE_ERRORS[code] ?? 'The Office cannot confirm this action. Refresh its status before another request.');
  }
  return response.json() as Promise<T>;
}
