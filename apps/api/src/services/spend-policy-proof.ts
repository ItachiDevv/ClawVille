/**
 * Wallet proof for a spend-rules raise (MCP hub step 2, phase 1b, founder go
 * 2026-11-04).
 *
 * A magic link passes through the agent, so a human Lucia session alone does
 * not prove a human. To RAISE a cap or add a vendor, the human's linked
 * self-custody wallet signs a readable message that names the account, the
 * exact new values and a single-use nonce. The agent does not hold that key.
 *
 * The nonce is bound to the user AND to the exact values, so a signature for
 * one set of values can never save another. Storage is an in-memory Map, like
 * `wallet-link-challenge.ts` (single API node). TTL 120 s.
 */

import { createHash, randomBytes } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { SpendPolicyValues, StudiosOperationId, StudiosPayMode } from '@clawville/shared';

const NONCE_TTL_MS = 120 * 1000;
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface SpendProofNonce {
  userId: string;
  message: string;
  expiresAt: number;
}

const nonces = new Map<string, SpendProofNonce>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(nonce);
  }
  if (nonces.size > MAX_NONCES) {
    const sorted = [...nonces.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [nonce] of sorted.slice(0, nonces.size - MAX_NONCES)) nonces.delete(nonce);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function usd(cents: number | null): string {
  return cents === null ? 'not set' : `$${(cents / 100).toFixed(2)}`;
}

const PAY_MODE_LABELS: Record<StudiosPayMode | 'default', string> = {
  default: 'my own Studios key if I saved one, else my agent wallet',
  wallet: 'my agent wallet',
  key: 'my own Studios key',
  signin: 'my Studios sign-in',
};

/** The EXACT UTF-8 text the linked wallet signs. */
export function buildSpendRulesMessage(userId: string, values: SpendPolicyValues, nonce: string): string {
  const vendors = [...values.allowedVendors].sort();
  return [
    'ClawVille spend rules',
    `account: ${userId}`,
    `daily cap: ${usd(values.dailyCapUsdCents)}`,
    `per-call cap: ${usd(values.perCallCapUsdCents)}`,
    `paid tools: ${vendors.length ? vendors.join(', ') : 'none'}`,
    `Studios images per day with my own key: ${values.studiosKeyImagesPerDay}`,
    `Studios videos per day: ${values.studiosVideosPerDay}`,
    `Studios character shots per day: ${values.studiosCharacterShotsPerDay}`,
    `Studios recasts per day: ${values.studiosRecastsPerDay}`,
    `ask me before each payment: ${values.requireApproval ? 'yes' : 'no'}`,
    `Studios pays with: ${PAY_MODE_LABELS[values.studiosPayMode ?? 'default']}`,
    `nonce: ${nonce}`,
  ].join('\n');
}

export interface SpendProofChallenge {
  nonce: string;
  expiresAt: string;
  messageToSign: string;
}

export function issueSpendProofChallenge(userId: string, values: SpendPolicyValues): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildSpendRulesMessage(userId, values, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

export type SpendProofResult = 'ok' | 'invalid_challenge' | 'invalid_signature';

/**
 * Consume the nonce (single use, also on failure) and verify that
 * `walletPubkey` signed the message for THIS user and THESE values.
 */
export function verifySpendProof(input: {
  userId: string;
  values: SpendPolicyValues;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildSpendRulesMessage(input.userId, input.values, input.nonce));
}

/**
 * Saving or removing a vendor API key (MCP hub step 2 phase 2b) uses the same
 * proof: the key decides whose account pays, and a magic-link session alone
 * does not prove a human. The message names the account, the vendor, the
 * action, the last 4 characters of the key and the SHA-256 of the whole key
 * (so a signature for one key never saves another); never the key itself.
 */
export type VendorKeyAction = 'save' | 'remove';
export interface VendorKeyRef {
  last4: string;
  /** Lowercase hex SHA-256 of the whole key. */
  sha256: string;
}

/** The reference a save proof names; the browser computes the same value. */
export function vendorKeyRef(key: string): VendorKeyRef {
  return { last4: key.slice(-4), sha256: createHash('sha256').update(key, 'utf8').digest('hex') };
}

export function buildVendorKeyMessage(userId: string, vendor: string, action: VendorKeyAction, key: VendorKeyRef | null, nonce: string): string {
  return [
    'ClawVille paid tool key',
    `account: ${userId}`,
    `tool: ${vendor}`,
    action === 'save'
      ? `action: use my own ${vendor} key ending ${key?.last4 ?? ''}\nkey sha256: ${key?.sha256 ?? ''}`
      : `action: remove my ${vendor} key`,
    `nonce: ${nonce}`,
  ].join('\n');
}

export function issueVendorKeyChallenge(userId: string, vendor: string, action: VendorKeyAction, key: VendorKeyRef | null): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildVendorKeyMessage(userId, vendor, action, key, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

/** Consume the nonce and verify the linked wallet signed THIS key action. */
export function verifyVendorKeyProof(input: {
  userId: string;
  vendor: string;
  action: VendorKeyAction;
  key: VendorKeyRef | null;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildVendorKeyMessage(input.userId, input.vendor, input.action, input.key, input.nonce));
}

/**
 * Approving one waiting paid-tool request ("ask me before each payment", lead
 * decision 2026-11-06 after the Codex review): a magic link passes through the
 * agent, so a session cookie alone never approves a payment. The human's linked
 * wallet signs a message that names the account, the avatar, the request, the
 * Studios operation, who pays and the most it can cost, the SHA-256 of the
 * prompt, and (every operation but image) the SHA-256 of its settings.
 */
export interface ApprovalTerms {
  avatarId: string;
  requestId: string;
  /** The Studios operation that runs (phase 3b). */
  operation: StudiosOperationId;
  /** 'account' = the saved Studios key; 'signin' = the Studios sign-in; 'wallet' = the avatar wallet (x402). */
  mode: 'wallet' | 'account' | 'signin';
  /** Wallet mode: the most the call may cost; the approve enforces it. Null in account mode. */
  maxUsdCents: number | null;
  /** Lowercase hex SHA-256 of the prompt as stored. */
  promptSha256: string;
  /** Lowercase hex SHA-256 of the canonical JSON of the stored settings; null for image (prompt and model only). */
  paramsSha256: string | null;
  /**
   * Account mode: the SHA-256 of the saved Studios key when the request was
   * made (the same digest as the key-save proof; never the key). Signin
   * mode: the SHA-256 of the sign-in link id (`studiosSignInDigest`; a new
   * sign-in gets a new link id). Null in wallet mode. A key replaced or a new
   * sign-in since then refuses at approve.
   */
  credentialSha256: string | null;
}

export function promptSha256(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

const OPERATION_LABELS: Record<StudiosOperationId, string> = {
  image: 'image',
  video: 'video',
  character_shots: 'character shots',
  recast: 'recast',
};

export function buildApprovalMessage(userId: string, terms: ApprovalTerms, nonce: string): string {
  return [
    'ClawVille payment approval',
    `account: ${userId}`,
    `avatar: ${terms.avatarId}`,
    `request: ${terms.requestId}`,
    `tool: Studios ${OPERATION_LABELS[terms.operation] ?? 'unknown'}`,
    terms.mode === 'account'
      ? `pays: my own Studios key (my Studios credits), key sha256: ${terms.credentialSha256 ?? 'none'}`
      : terms.mode === 'signin'
        ? `pays: my Studios sign-in (my Studios credits), sign-in sha256: ${terms.credentialSha256 ?? 'none'}`
        : `pays: my agent wallet, at most ${usd(terms.maxUsdCents ?? 0)}`,
    `prompt sha256: ${terms.promptSha256}`,
    ...(terms.paramsSha256 === null ? [] : [`settings sha256: ${terms.paramsSha256}`]),
    `nonce: ${nonce}`,
  ].join('\n');
}

export function issueApprovalChallenge(userId: string, terms: ApprovalTerms): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildApprovalMessage(userId, terms, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

/** Consume the nonce and verify the linked wallet signed THESE terms for THIS user. */
export function verifyApprovalProof(input: {
  userId: string;
  terms: ApprovalTerms;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildApprovalMessage(input.userId, input.terms, input.nonce));
}

/**
 * Deleting one stored media item (MCP hub phase 3b, Codex review 2026-11-06):
 * a ledger-capable agent can redeem its own control link and hold a
 * `magic_link` cookie, so the human session alone never deletes media. The
 * linked wallet signs the account, the avatar, the media id and the action.
 */
export function buildMediaDeleteMessage(userId: string, avatarId: string, mediaId: string, nonce: string): string {
  return [
    'ClawVille media',
    `account: ${userId}`,
    `avatar: ${avatarId}`,
    `media: ${mediaId}`,
    'action: delete',
    `nonce: ${nonce}`,
  ].join('\n');
}

export function issueMediaDeleteChallenge(userId: string, avatarId: string, mediaId: string): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildMediaDeleteMessage(userId, avatarId, mediaId, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

/** Consume the nonce and verify the linked wallet signed THIS delete for THIS user. */
export function verifyMediaDeleteProof(input: {
  userId: string;
  avatarId: string;
  mediaId: string;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildMediaDeleteMessage(input.userId, input.avatarId, input.mediaId, input.nonce));
}

function verifyMessage(userId: string, nonce: string, signature: string, walletPubkey: string, expected: string): SpendProofResult {
  const entry = nonces.get(nonce);
  if (!entry) return 'invalid_challenge';
  nonces.delete(nonce);
  if (entry.userId !== userId || Date.now() > entry.expiresAt) return 'invalid_challenge';
  if (expected !== entry.message) return 'invalid_challenge';
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(signature);
    pub = bs58.decode(walletPubkey);
  } catch {
    return 'invalid_signature';
  }
  if (sig.length !== 64 || pub.length !== 32) return 'invalid_signature';
  return nacl.sign.detached.verify(new TextEncoder().encode(expected), sig, pub) ? 'ok' : 'invalid_signature';
}

/** Test-only helper: wipe the map. */
export function _resetSpendProofNoncesForTest(): void {
  nonces.clear();
}
