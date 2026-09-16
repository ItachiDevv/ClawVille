import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  WalletSignError,
  connectSolanaWallet,
  signMessageWithSolanaWallet,
  signWalletLinkMessage,
} from '@/lib/solana-wallet';

type FakeProvider = {
  publicKey: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
};

const PUBKEY_A = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PUBKEY_B = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function key(value: string) {
  return { toString: () => value };
}

function installProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const provider: FakeProvider = {
    publicKey: key(PUBKEY_A),
    connect: async () => ({ publicKey: key(PUBKEY_A) }),
    signMessage: async () => ({ signature: new Uint8Array(64).fill(7) }),
    ...overrides,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { solana: provider },
  });
  return provider;
}

async function expectCode(promise: Promise<unknown>, code: WalletSignError['code']) {
  try {
    await promise;
    throw new Error('Expected WalletSignError');
  } catch (error) {
    expect(error).toBeInstanceOf(WalletSignError);
    expect((error as WalletSignError).code).toBe(code);
    const expectedMessages: Record<WalletSignError['code'], readonly string[]> = {
      no_wallet: ['No Solana wallet detected. Install Phantom, Solflare, or Backpack to link a wallet.'],
      user_rejected: ['Wallet connection was rejected.', 'Signature request was rejected.'],
      sign_failed: [
        'Could not connect to the wallet.',
        'Message signing failed.',
        'Wallet returned a malformed signature.',
      ],
      no_pubkey: ['Wallet returned no public key.'],
      wallet_changed: ['The active wallet changed. Try again.'],
    };
    expect(expectedMessages[code]).toContain((error as WalletSignError).message);
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('Solana wallet helpers', () => {
  test('keeps the original proof shape', async () => {
    installProvider();

    const proof = await signWalletLinkMessage('Sign this message');

    expect(proof.walletPubkey).toBe(PUBKEY_A);
    expect(typeof proof.signatureBase58).toBe('string');
  });

  test('keeps the legacy signWalletLinkMessage signing body intact', () => {
    const source = readFileSync(new URL('../solana-wallet.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function signWalletLinkMessage'));
    expect(body).toContain('const encoded = new TextEncoder().encode(messageToSign);');
    expect(body).toContain("provider.signMessage(encoded, 'utf8')");
    expect(body).toContain('return { walletPubkey: pubkey, signatureBase58: bs58.encode(signatureBytes) };');
  });

  test('reports no wallet', async () => {
    await expectCode(signWalletLinkMessage('message'), 'no_wallet');
  });

  test('reports a rejected connection', async () => {
    installProvider({ connect: async () => { throw { code: 4001 }; } });

    await expectCode(signWalletLinkMessage('message'), 'user_rejected');
  });

  test('reports a connection failure', async () => {
    installProvider({ connect: async () => { throw new Error('offline'); } });

    await expectCode(signWalletLinkMessage('message'), 'sign_failed');
  });

  test('reports a missing public key', async () => {
    installProvider({ connect: async () => ({ publicKey: key('') }) });

    await expectCode(signWalletLinkMessage('message'), 'no_pubkey');
  });

  test('rejects a malformed signature', async () => {
    installProvider({
      signMessage: async () => ({ signature: new Uint8Array(63) }),
    });

    await expectCode(signWalletLinkMessage('message'), 'sign_failed');
  });

  test('connectSolanaWallet returns the connected key', async () => {
    installProvider();

    expect(await connectSolanaWallet()).toBe(PUBKEY_A);
  });

  test('signMessageWithSolanaWallet returns a signed proof', async () => {
    installProvider();

    const proof = await signMessageWithSolanaWallet('message', PUBKEY_A);

    expect(proof.walletPubkey).toBe(PUBKEY_A);
    expect(typeof proof.signatureBase58).toBe('string');
  });

  test('detects a wallet change at connect', async () => {
    installProvider({ connect: async () => ({ publicKey: key(PUBKEY_B) }) });

    await expectCode(
      signMessageWithSolanaWallet('message', PUBKEY_A),
      'wallet_changed',
    );
  });

  test('detects a wallet change after signing', async () => {
    const provider = installProvider();
    provider.signMessage = async () => {
      provider.publicKey = key(PUBKEY_B);
      return { signature: new Uint8Array(64) };
    };

    await expectCode(
      signMessageWithSolanaWallet('message', PUBKEY_A),
      'wallet_changed',
    );
  });
});
