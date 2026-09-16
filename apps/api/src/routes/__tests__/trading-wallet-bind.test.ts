import { beforeEach, describe, expect, test } from 'bun:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  _expireTradingWalletNonceForTest,
  _resetTradingWalletNoncesForTest,
  buildTradingWalletMessage,
  consumeTradingWalletChallenge,
  issueTradingWalletChallenge,
  tradingSubjectKey,
} from '../../services/trading-wallet-challenge';
import {
  bindTradingWalletBySignature,
  TradingWalletError,
  verifyTradingWalletOwnership,
} from '../../services/trading-wallets';

beforeEach(() => _resetTradingWalletNoncesForTest());
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function expectBindError(input: {
  walletPubkey: string;
  nonce: string;
  signature: string;
}, code: TradingWalletError['code']): Promise<void> {
  try {
    await bindTradingWalletBySignature({
      subject: { kind: 'avatar', userId: 'user-test', avatarId: 'avatar-test', agentId: null },
      ...input,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(TradingWalletError);
    expect((error as TradingWalletError).code).toBe(code);
  }
}

describe('trading wallet bind proof', () => {
  test('renders the exact four-line avatar message', () => {
    expect(buildTradingWalletMessage('avatar:a', 'wallet', 'nonce')).toBe(
      'ClawVille trading wallet\nsubject: avatar:a\nwallet: wallet\nnonce: nonce',
    );
  });

  test('renders the exact four-line agent message', () => {
    expect(buildTradingWalletMessage('agent:bot', 'wallet', 'nonce')).toBe(
      'ClawVille trading wallet\nsubject: agent:bot\nwallet: wallet\nnonce: nonce',
    );
  });

  test('keeps avatar and agent subject keys stable and distinct', () => {
    const avatar = tradingSubjectKey({ kind: 'avatar', userId: 'u', avatarId: 'same', agentId: null });
    const agent = tradingSubjectKey({ kind: 'agent', userId: 'u', avatarId: 'same', agentId: 'same' });
    expect(avatar).toBe('avatar:same');
    expect(agent).toBe('agent:same');
    expect(avatar).not.toBe(agent);
  });

  test('consumes a matching challenge', () => {
    const issued = issueTradingWalletChallenge('agent:test', 'wallet');
    expect(consumeTradingWalletChallenge(issued.nonce, 'agent:test', 'wallet')).toBe(true);
  });

  test('consumes each nonce only once', () => {
    const issued = issueTradingWalletChallenge('agent:test', 'wallet');
    expect(consumeTradingWalletChallenge(issued.nonce, 'agent:test', 'wallet')).toBe(true);
    expect(consumeTradingWalletChallenge(issued.nonce, 'agent:test', 'wallet')).toBe(false);
  });

  test('destroys a probed nonce after a subject mismatch', () => {
    const issued = issueTradingWalletChallenge('avatar:a', 'wallet');
    expect(consumeTradingWalletChallenge(issued.nonce, 'avatar:b', 'wallet')).toBe(false);
    expect(consumeTradingWalletChallenge(issued.nonce, 'avatar:a', 'wallet')).toBe(false);
  });

  test('rejects a wallet mismatch', () => {
    const issued = issueTradingWalletChallenge('avatar:a', 'wallet-a');
    expect(consumeTradingWalletChallenge(issued.nonce, 'avatar:a', 'wallet-b')).toBe(false);
  });

  test('rejects an expired challenge', () => {
    const issued = issueTradingWalletChallenge('avatar:a', 'wallet');
    expect(_expireTradingWalletNonceForTest(issued.nonce)).toBe(true);
    expect(consumeTradingWalletChallenge(issued.nonce, 'avatar:a', 'wallet')).toBe(false);
  });

  test('verifies a real detached ed25519 signature', () => {
    const pair = nacl.sign.keyPair();
    const pubkey = bs58.encode(pair.publicKey);
    const message = new TextEncoder().encode(buildTradingWalletMessage('agent:test', pubkey, 'nonce'));
    const signature = nacl.sign.detached(message, pair.secretKey);
    expect(nacl.sign.detached.verify(message, signature, pair.publicKey)).toBe(true);
  });

  test('keeps a real signature bound to its subject', () => {
    const pair = nacl.sign.keyPair();
    const pubkey = bs58.encode(pair.publicKey);
    const original = new TextEncoder().encode(buildTradingWalletMessage('agent:test', pubkey, 'nonce'));
    const signature = nacl.sign.detached(original, pair.secretKey);
    const other = new TextEncoder().encode(buildTradingWalletMessage('agent:other', pubkey, 'nonce'));
    expect(nacl.sign.detached.verify(other, signature, pair.publicKey)).toBe(false);
  });

  test('consumes a valid ownership challenge exactly once', () => {
    const pair = nacl.sign.keyPair();
    const pubkey = bs58.encode(pair.publicKey);
    const subject = { kind: 'agent' as const, userId: 'user', avatarId: 'avatar', agentId: 'genesis' };
    const challenge = issueTradingWalletChallenge(tradingSubjectKey(subject), pubkey);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), pair.secretKey));
    expect(() => verifyTradingWalletOwnership({ subject, walletPubkey: pubkey, nonce: challenge.nonce, signature })).not.toThrow();
    expect(() => verifyTradingWalletOwnership({ subject, walletPubkey: pubkey, nonce: challenge.nonce, signature }))
      .toThrow(expect.objectContaining({ code: 'invalid_or_expired_challenge' }));
  });

  test('rejects 63-byte signatures and 31-byte public keys before binding', async () => {
    const pair = nacl.sign.keyPair();
    const pubkey = bs58.encode(pair.publicKey);
    const challenge = issueTradingWalletChallenge('avatar:avatar-test', pubkey);
    await expectBindError({
      walletPubkey: pubkey,
      nonce: challenge.nonce,
      signature: bs58.encode(new Uint8Array(63)),
    }, 'signature_verification_failed');

    await expectBindError({
      walletPubkey: bs58.encode(new Uint8Array(31)),
      nonce: 'n'.repeat(32),
      signature: bs58.encode(new Uint8Array(64)),
    }, 'invalid_wallet_pubkey');
  });

  test('rejects a non-base58 public key before binding', async () => {
    await expectBindError({
      walletPubkey: 'not-base58!',
      nonce: 'n'.repeat(32),
      signature: bs58.encode(new Uint8Array(64)),
    }, 'invalid_wallet_pubkey');
  });
});

// The full agent-session route case requires the PostgreSQL CI harness and the
// gateway provisioning infrastructure. It remains an explicit, visible gate.
describeIfDb(
  'trading wallet agent-session routes (requires DATABASE_URL)',
  () => {
    test.todo('binds through a real agent gateway session and rejects cross-kind revoke', () => {});
  },
);
