/**
 * Tokenomics Phase A — minimal browser Solana-wallet signing helper.
 *
 * The web app ships NO `@solana/wallet-adapter` suite (checked 2026-07-08), and
 * the self-custody wallet-link flow (routes/wallet-link.ts) needs exactly ONE
 * capability: have the user's browser wallet sign a server-issued human-readable
 * message so we can prove they control the pubkey. So instead of pulling in the
 * full adapter stack, we talk to the injected provider directly.
 *
 * Every mainstream Solana wallet (Phantom, Solflare, Backpack) injects a
 * provider exposing `connect()` + `signMessage(bytes, 'utf8') → { signature }`.
 * We detect the provider, connect, sign the EXACT `messageToSign` the API
 * returned, and base58-encode the 64-byte signature for the link POST.
 *
 * We NEVER touch a secret key here — the wallet holds it; we only request a
 * signature over a public, account-bound message.
 */

import bs58 from 'bs58';

/** Minimal shape of an injected Solana wallet provider (Phantom/Solflare/…). */
interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage(
    message: Uint8Array,
    display?: 'utf8' | 'hex',
  ): Promise<{ signature: Uint8Array } | Uint8Array>;
}

interface ProviderWindow {
  solana?: SolanaProvider;
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
  phantom?: { solana?: SolanaProvider };
}

export class WalletSignError extends Error {
  constructor(
    message: string,
    /** Stable code the UI can branch on without string-matching. */
    readonly code:
      | 'no_wallet'
      | 'user_rejected'
      | 'sign_failed'
      | 'no_pubkey',
  ) {
    super(message);
    this.name = 'WalletSignError';
  }
}

/**
 * Find an injected Solana provider. Phantom exposes both `window.solana` and
 * `window.phantom.solana`; Solflare/Backpack inject their own namespaces.
 * Returns null when no wallet extension is present.
 */
export function getSolanaProvider(): SolanaProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as ProviderWindow;
  return w.phantom?.solana ?? w.solana ?? w.solflare ?? w.backpack ?? null;
}

/** Whether a browser Solana wallet is available to sign. */
export function hasSolanaWallet(): boolean {
  return getSolanaProvider() !== null;
}

export interface SignedLinkProof {
  /** base58 pubkey of the wallet that signed. */
  walletPubkey: string;
  /** base58-encoded 64-byte ed25519 signature over `messageToSign`. */
  signatureBase58: string;
}

/**
 * Connect the browser wallet and sign `messageToSign` (UTF-8). Returns the
 * signer pubkey + base58 signature ready for POST /api/wallet/link. Throws a
 * typed `WalletSignError` on the recoverable failure modes so the caller can
 * render the right message.
 */
export async function signWalletLinkMessage(messageToSign: string): Promise<SignedLinkProof> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new WalletSignError(
      'No Solana wallet detected. Install Phantom, Solflare, or Backpack to link a wallet.',
      'no_wallet',
    );
  }

  // Connect (surfaces the wallet's approval prompt). A user dismissing it
  // rejects with code 4001 in every mainstream wallet.
  let pubkey: string;
  try {
    const res = await provider.connect();
    pubkey = res.publicKey.toString();
  } catch (err) {
    if (isUserRejection(err)) {
      throw new WalletSignError('Wallet connection was rejected.', 'user_rejected');
    }
    throw new WalletSignError('Could not connect to the wallet.', 'sign_failed');
  }
  if (!pubkey) {
    throw new WalletSignError('Wallet returned no public key.', 'no_pubkey');
  }

  // Sign the exact server message. `display: 'utf8'` makes the wallet render
  // the human-readable SIWS-lite text instead of an opaque blob.
  const encoded = new TextEncoder().encode(messageToSign);
  let signatureBytes: Uint8Array;
  try {
    const signed = await provider.signMessage(encoded, 'utf8');
    // Phantom/Solflare return { signature }; a few wallets return the bytes.
    signatureBytes =
      signed instanceof Uint8Array
        ? signed
        : (signed as { signature: Uint8Array }).signature;
  } catch (err) {
    if (isUserRejection(err)) {
      throw new WalletSignError('Signature request was rejected.', 'user_rejected');
    }
    throw new WalletSignError('Message signing failed.', 'sign_failed');
  }

  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length !== 64) {
    throw new WalletSignError('Wallet returned a malformed signature.', 'sign_failed');
  }

  return { walletPubkey: pubkey, signatureBase58: bs58.encode(signatureBytes) };
}

/** Wallets reject with `{ code: 4001 }` (EIP-1193-style) on user dismissal. */
function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 4001 || /reject|denied|cancell?ed/i.test((err as Error)?.message ?? '');
}

/**
 * Shorten a base58 address for display: `AbCd…WxYz`. Full value stays available
 * for copy/reveal — this is presentation only.
 */
export function truncateAddress(addr: string, lead = 4, tail = 4): string {
  if (!addr) return '';
  if (addr.length <= lead + tail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}
