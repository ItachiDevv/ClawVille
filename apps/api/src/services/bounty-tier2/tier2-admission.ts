import { AsyncLocalStorage } from 'node:async_hooks';
import { avatars, users, eq } from '@clawville/database';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encryptSecretKey } from '../keypair-vault';
import { bountyEscrowNonce } from '../bounty-escrow-link';
import { resolveV2UsdcEscrowAddress } from '../sap/sap-client';
import { admitBounty, type Tx } from './tier2-db';
import { asTier2Error, Tier2Error, type Tier2ErrorCode } from './tier2-errors';
import { tier2MerchantWallet } from './tier2-config';

export interface AdmitTier2Input {
  bountyId: string;
  posterAvatarId: string;
  posterUsdcAta: string;
  mint: string;
  genesis: string;
  branch: 'A_plus_fee' | 'B_grossed_up' | 'C_house_funded';
  formulaVersion: number;
  payoutExpectedAtomic: bigint;
}

type QueryTx = Pick<Tx, 'select'>;
type AdmissionActorKind = 'human' | 'agent';
const admissionActorContext = new AsyncLocalStorage<AdmissionActorKind>();

/** Route-only context preserves the frozen public admission signature. */
export function withTier2AdmissionActorKind<T>(kind: AdmissionActorKind, fn: () => T): T {
  return admissionActorContext.run(kind, fn);
}

export function selectTier2ActorWallet(
  kind: AdmissionActorKind,
  row: { walletAddress: string | null; linkedWalletPubkey: string | null },
): string | null {
  return kind === 'agent' ? row.walletAddress : row.linkedWalletPubkey;
}

/** Posting retains the existing bounty rail's custodial creator-wallet authority. */
export async function deriveTier2PosterUsdcAta(
  tx: QueryTx,
  posterAvatarId: string,
  mint: PublicKey,
): Promise<{ wallet: PublicKey; ata: PublicKey }> {
  const [row] = await tx
    .select({ walletAddress: avatars.walletAddress, linkedWalletPubkey: users.linkedWalletPubkey })
    .from(avatars)
    .innerJoin(users, eq(users.id, avatars.userId))
    .where(eq(avatars.id, posterAvatarId))
    .limit(1);
  const actorKind = admissionActorContext.getStore();
  const raw = actorKind && row ? selectTier2ActorWallet(actorKind, row) : null;
  if (!raw) throw new Tier2Error('payee_provenance_unverified');
  try {
    const wallet = new PublicKey(raw);
    return { wallet, ata: await getAssociatedTokenAddress(mint, wallet, false) };
  } catch (cause) {
    throw new Tier2Error('payee_provenance_unverified', undefined, { cause });
  }
}

export async function admitTier2Bounty(
  tx: Tx,
  input: AdmitTier2Input,
): Promise<
  | { ok: true; depositorPubkey: string }
  | { ok: false; code: Tier2ErrorCode; message: string }
> {
  try {
    const mint = new PublicKey(input.mint);
    const poster = await deriveTier2PosterUsdcAta(tx, input.posterAvatarId, mint);
    if (poster.ata.toBase58() !== input.posterUsdcAta) {
      throw new Error('tier2_poster_ata_mismatch');
    }

    const depositor = Keypair.generate();
    const depositorUsdcAta = await getAssociatedTokenAddress(mint, depositor.publicKey, false);
    const merchant = tier2MerchantWallet();
    const resolved = resolveV2UsdcEscrowAddress({
      workerWalletPubkey: merchant.toBase58(),
      depositorWalletPubkey: depositor.publicKey.toBase58(),
      escrowNonce: bountyEscrowNonce(input.bountyId),
    });
    if (!resolved.ok) throw new Error(`tier2_address_derivation_failed:${resolved.code}`);
    if (!resolved.mint.equals(mint)) throw new Error('tier2_mint_mismatch');
    const vaultAta = await getAssociatedTokenAddress(mint, resolved.escrowPda, true);
    const encrypted = encryptSecretKey(depositor.secretKey);

    await admitBounty(tx, {
      bountyId: input.bountyId,
      mint: mint.toBase58(),
      genesis: input.genesis,
      posterWallet: poster.wallet.toBase58(),
      posterAta: poster.ata.toBase58(),
      vaultAta: vaultAta.toBase58(),
      solReturn: merchant.toBase58(),
      branch: input.branch,
      formulaVersion: input.formulaVersion,
      payoutAtomic: input.payoutExpectedAtomic,
      hunterAta: null,
      depositorPublicKey: depositor.publicKey.toBase58(),
      depositorUsdcAta: depositorUsdcAta.toBase58(),
      encryptedSecret: encrypted.encryptedSecretKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
    });
    return { ok: true, depositorPubkey: depositor.publicKey.toBase58() };
  } catch (error) {
    const tier2 = asTier2Error(error);
    return { ok: false, code: tier2.code, message: tier2.message };
  }
}
