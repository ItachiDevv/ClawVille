/**
 * Tokenomics Phase A / Slice A1 — wallet-link challenge store unit tests.
 *
 * Proves the single-use + user-binding + expiry semantics that make the
 * self-custody wallet-link flow replay-safe and cross-account-safe.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  issueWalletLinkChallenge,
  consumeWalletLinkChallenge,
  buildWalletLinkMessage,
  _resetWalletLinkNoncesForTest,
} from '../wallet-link-challenge';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('wallet-link-challenge', () => {
  beforeEach(() => {
    _resetWalletLinkNoncesForTest();
  });

  it('issues a base58 nonce with a future ISO expiry', () => {
    const { nonce, expiresAt } = issueWalletLinkChallenge(USER_A);
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('consumes a valid nonce exactly once for the issuing user', () => {
    const { nonce } = issueWalletLinkChallenge(USER_A);
    expect(consumeWalletLinkChallenge(nonce, USER_A)).toBe(true);
    // Second consume of the same nonce fails (single-use / replay guard).
    expect(consumeWalletLinkChallenge(nonce, USER_A)).toBe(false);
  });

  it('refuses a nonce issued to a DIFFERENT user (cross-account replay guard)', () => {
    const { nonce } = issueWalletLinkChallenge(USER_A);
    // User B cannot consume A's nonce — and the attempt still burns it (delete
    // on read) so A cannot use it afterward either.
    expect(consumeWalletLinkChallenge(nonce, USER_B)).toBe(false);
    expect(consumeWalletLinkChallenge(nonce, USER_A)).toBe(false);
  });

  it('refuses an unknown / never-issued nonce', () => {
    expect(consumeWalletLinkChallenge('never-issued-nonce', USER_A)).toBe(false);
  });

  it('two issues to the same user produce distinct nonces, each single-use', () => {
    const a = issueWalletLinkChallenge(USER_A);
    const b = issueWalletLinkChallenge(USER_A);
    expect(a.nonce).not.toBe(b.nonce);
    expect(consumeWalletLinkChallenge(a.nonce, USER_A)).toBe(true);
    expect(consumeWalletLinkChallenge(b.nonce, USER_A)).toBe(true);
  });

  it('issues an account-bound human-readable messageToSign (anti blind-signing)', () => {
    const issued = issueWalletLinkChallenge(USER_A);
    expect(issued.messageToSign).toBe(buildWalletLinkMessage(USER_A, issued.nonce));
    // Readable + binds the exact account and nonce the wallet UI displays.
    expect(issued.messageToSign).toContain('ClawVille wallet link');
    expect(issued.messageToSign).toContain(`account: ${USER_A}`);
    expect(issued.messageToSign).toContain(`nonce: ${issued.nonce}`);
  });

  it('messages for different accounts differ even with the same nonce (binding)', () => {
    const { nonce } = issueWalletLinkChallenge(USER_A);
    expect(buildWalletLinkMessage(USER_A, nonce)).not.toBe(buildWalletLinkMessage(USER_B, nonce));
  });
});
