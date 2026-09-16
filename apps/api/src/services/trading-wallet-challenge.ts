import { randomBytes } from 'node:crypto';

export interface TradingSubject {
  kind: 'avatar' | 'agent';
  userId: string;
  avatarId: string;
  agentId: string | null;
}

export interface TradingWalletChallengeIssued {
  nonce: string;
  expiresAt: string;
  messageToSign: string;
  walletPubkey: string;
}

interface StoredChallenge {
  subjectKey: string;
  walletPubkey: string;
  expiresAtMs: number;
}

const CHALLENGE_TTL_MS = 120_000;
const MAX_CHALLENGES = 10_000;
const challenges = new Map<string, StoredChallenge>();

export function tradingSubjectKey(subject: TradingSubject): string {
  return subject.kind === 'agent'
    ? `agent:${subject.agentId ?? ''}`
    : `avatar:${subject.avatarId}`;
}

export function buildTradingWalletMessage(
  subjectKey: string,
  walletPubkey: string,
  nonce: string,
): string {
  return `ClawVille trading wallet\nsubject: ${subjectKey}\nwallet: ${walletPubkey}\nnonce: ${nonce}`;
}

export function issueTradingWalletChallenge(
  subjectKey: string,
  walletPubkey: string,
): TradingWalletChallengeIssued {
  if (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined;
    if (oldest) challenges.delete(oldest);
  }
  const nonce = randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
  challenges.set(nonce, { subjectKey, walletPubkey, expiresAtMs });
  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    messageToSign: buildTradingWalletMessage(subjectKey, walletPubkey, nonce),
    walletPubkey,
  };
}

export function consumeTradingWalletChallenge(
  nonce: string,
  subjectKey: string,
  walletPubkey: string,
): boolean {
  const stored = challenges.get(nonce);
  challenges.delete(nonce);
  return !!stored
    && stored.expiresAtMs >= Date.now()
    && stored.subjectKey === subjectKey
    && stored.walletPubkey === walletPubkey;
}

export function _resetTradingWalletNoncesForTest(): void {
  challenges.clear();
}

export function _expireTradingWalletNonceForTest(nonce: string): boolean {
  const stored = challenges.get(nonce);
  if (!stored) return false;
  stored.expiresAtMs = 0;
  return true;
}

const nonceJanitor = setInterval(() => {
  const now = Date.now();
  for (const [nonce, challenge] of challenges) {
    if (challenge.expiresAtMs < now) challenges.delete(nonce);
  }
}, 30_000);
nonceJanitor.unref?.();
