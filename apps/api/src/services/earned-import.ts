/**
 * Tokenomics E1/E2 — default-off, house-backed EARNED import + payer verifier.
 * Entry fee is ZERO. One vCLAW is backed by exactly 10,000 micro-USDC.
 */
import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { db, sql } from '@clawville/database';
import {
  clawBackEarnedMint,
  mintEarned,
  type ClawTokenSource,
  type EarnedClawbackResult,
} from './claw-token-ledger';
import { withKeyedMutex } from './keyed-mutex';
import { verifyUsdcTransfer } from './x402-chain-verifier';
import { usdcMintForNetwork, type X402Network } from './x402-payai';
import { readSplTokenBalance } from './solana-token-balance';
import {
  calculateEarnedBackingSolvency,
  earnedBackingIntegrityQuery,
  earnedBackingCustodyLockKey,
  earnedBackingCustodyMutexKey,
  summarizeEarnedBackingIntegrity,
  type EarnedBackingIntegrityCounts,
  type EarnedFundingPrincipal,
} from './earned-solvency';

export interface TokenomicsEarnConfig {
  enabled: boolean;
  /** Founder-locked: the sole loop fee is the 444-bps exit fee. */
  rakeFloorBps: 0;
  pairCapUsdPerEpoch: number;
  epochDays: number;
  vestDays: number;
  payerMinAgeDays: number;
  payerMinSignatures: number;
  verificationBatchSize: number;
  verificationPollMs: number;
  verificationMaxPages: number;
}

function intEnv(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

export function loadTokenomicsEarnConfig(): TokenomicsEarnConfig {
  return {
    enabled: process.env.TOKENOMICS_EARN_ENABLED === 'true',
    rakeFloorBps: intEnv('TOKENOMICS_EARN_RAKE_FLOOR_BPS', 0, 0, 0) as 0,
    pairCapUsdPerEpoch: intEnv('TOKENOMICS_EARN_PAIR_CAP_USD', 100, 1, 1_000_000),
    epochDays: intEnv('TOKENOMICS_EARN_EPOCH_DAYS', 7, 1, 365),
    vestDays: intEnv('TOKENOMICS_EARN_VEST_DAYS', 7, 0, 365),
    payerMinAgeDays: intEnv('TOKENOMICS_EARN_PAYER_MIN_AGE_DAYS', 7, 0, 3650),
    payerMinSignatures: intEnv('TOKENOMICS_EARN_PAYER_MIN_SIGNATURES', 2, 1, 1000),
    verificationBatchSize: intEnv('TOKENOMICS_EARN_VERIFY_BATCH_SIZE', 25, 1, 200),
    verificationPollMs: intEnv('TOKENOMICS_EARN_VERIFY_POLL_MS', 300_000, 60_000),
    verificationMaxPages: intEnv('TOKENOMICS_EARN_VERIFY_MAX_PAGES', 5, 1, 20),
  };
}

export type EarnSettlementSource = 'sap_escrow' | 'x402' | 'admin_test';
const LEDGER_SOURCE: Record<EarnSettlementSource, ClawTokenSource> = {
  sap_escrow: 'bounty',
  x402: 'x402',
  admin_test: 'admin',
};
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ATOMIC = 1_000_000_000_000_000n;

export interface EarnFromExternalSettlementInput {
  earnerAvatarId: string;
  payerWallet: string;
  usdcAmountAtomic: bigint | string | number;
  source: EarnSettlementSource;
  /** Founder-locked: must be zero. Retained only to reject stale callers. */
  rakeBps?: number;
  idempotencyKey: string;
  /** Exact confirmed transfer into the singleton earned-backing wallet. */
  backingTxSignature: string;
  backingNetwork: X402Network;
  metadata?: Record<string, unknown>;
}

export interface EarnImportDeps {
  verifyTransfer?: typeof verifyUsdcTransfer;
  getParsedTransaction?: (network: X402Network, signature: string) => Promise<unknown | null>;
  readCustodyUsdcBalance?: (
    network: X402Network,
    owner: string,
    options?: { minContextSlot?: number },
  ) => Promise<{ amountAtomic: bigint; contextSlot: number }>;
  database?: Pick<typeof db, 'execute' | 'transaction'>;
}

export type EarnRejectReason =
  | 'invalid_input'
  | 'entry_rake_forbidden'
  | 'amount_not_cent_aligned'
  | 'payer_is_earner_wallet'
  | 'payer_is_clawville_wallet'
  | 'payer_wallet_cap_exceeded'
  | 'idempotency_conflict'
  | 'backing_network_forbidden'
  | 'backing_custody_unconfigured'
  | 'backing_custody_insolvent'
  | 'backing_custody_indeterminate'
  | 'backing_transfer_unverified';

export type EarnImportResult =
  | { status: 'gated_off' }
  | { status: 'rejected'; reason: EarnRejectReason; detail?: string }
  | {
      status: 'minted' | 'duplicate';
      earnEventId: string;
      ledgerId: string | null;
      vclawMinted: number;
      usdBasis: string;
      vestsAt?: Date;
    };

export function toAtomicBigint(value: bigint | string | number): bigint | null {
  try {
    const out = typeof value === 'bigint'
      ? value
      : typeof value === 'number'
        ? Number.isSafeInteger(value) ? BigInt(value) : -1n
        : /^\d+$/.test(value.trim()) ? BigInt(value.trim()) : -1n;
    return out > 0n && out <= MAX_ATOMIC ? out : null;
  } catch {
    return null;
  }
}

export function atomicToUsdString(atomic: bigint): string {
  return `${atomic / 1_000_000n}.${(atomic % 1_000_000n).toString().padStart(6, '0')}`;
}

/**
 * A production-backed claim can only be proven on the network that holds the
 * production backing wallet. Devnet is deliberately limited to isolated
 * staging/test environments so test USDC can never create a mainnet claim.
 */
export function isEarnBackingNetworkAllowed(network: X402Network): boolean {
  if (network === 'mainnet') return true;
  if (process.env.CLAWVILLE_ENV === 'production') return false;
  return process.env.CLAWVILLE_ENV === 'staging' || process.env.NODE_ENV === 'test';
}

function epochStartFor(now: Date, days: number): Date {
  const width = days * 86_400_000;
  return new Date(Math.floor(now.getTime() / width) * width);
}

function lockKey(namespace: string, ...parts: string[]): bigint {
  const digest = createHash('sha256').update(`${namespace}:${parts.join(':')}`).digest();
  return digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

type ExistingEvent = {
  id: string; ledger_id: string | null; vclaw_minted: number; gross_usdc_atomic: string;
  earner_avatar_id: string; payer_wallet: string; source: string; backing_network: string;
  source_ref: string | null; proof_count: number;
};

function existingResult(
  row: ExistingEvent,
  input: EarnFromExternalSettlementInput,
  gross: bigint,
): EarnImportResult {
  const backingTxSignature = input.backingTxSignature.trim();
  if (row.earner_avatar_id !== input.earnerAvatarId
    || row.payer_wallet !== input.payerWallet
    || row.source !== input.source
    || row.backing_network !== input.backingNetwork
    || row.source_ref !== `usdc:${input.backingNetwork}:${backingTxSignature}`
    || Number(row.proof_count) !== 1
    || BigInt(row.gross_usdc_atomic) !== gross) {
    return { status: 'rejected', reason: 'idempotency_conflict' };
  }
  return {
    status: 'duplicate', earnEventId: row.id, ledgerId: row.ledger_id,
    vclawMinted: Number(row.vclaw_minted),
    usdBasis: atomicToUsdString(BigInt(row.gross_usdc_atomic)),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: string; cause?: unknown } | undefined;
  return value?.code === '23505' || (value?.cause ? isUniqueViolation(value.cause) : false);
}

export async function earnFromExternalSettlement(
  input: EarnFromExternalSettlementInput,
  deps: EarnImportDeps = {},
): Promise<EarnImportResult> {
  const cfg = loadTokenomicsEarnConfig();
  if (!cfg.enabled) return { status: 'gated_off' };
  const database = deps.database ?? db;
  const reject = (reason: EarnRejectReason, detail?: string): EarnImportResult => ({
    status: 'rejected', reason, detail,
  });
  if (!input.earnerAvatarId || !BASE58_RE.test(input.payerWallet ?? '')
    || !input.idempotencyKey?.trim() || input.idempotencyKey.length > 128
    || !input.backingTxSignature?.trim()
    || (input.backingNetwork !== 'mainnet' && input.backingNetwork !== 'devnet')
    || !Object.prototype.hasOwnProperty.call(LEDGER_SOURCE, input.source)) {
    return reject('invalid_input');
  }
  if ((input.rakeBps ?? 0) !== 0) {
    return reject('entry_rake_forbidden', 'the only fee is 444 bps at exit');
  }
  if (!isEarnBackingNetworkAllowed(input.backingNetwork)) {
    return reject(
      'backing_network_forbidden',
      'production backing requires a mainnet USDC transfer; devnet is staging/test only',
    );
  }
  const gross = toAtomicBigint(input.usdcAmountAtomic);
  if (!gross) return reject('invalid_input');
  if (gross % 10_000n !== 0n) {
    return reject('amount_not_cent_aligned', 'backed imports require whole vCLAW cents');
  }
  const vclaw = Number(gross / 10_000n);
  if (!Number.isSafeInteger(vclaw) || vclaw <= 0) return reject('invalid_input');
  const now = new Date();
  const epochStart = epochStartFor(now, cfg.epochDays);
  const vestsAt = new Date(now.getTime() + cfg.vestDays * 86_400_000);
  const capAtomic = BigInt(cfg.pairCapUsdPerEpoch) * 1_000_000n;
  const idem = input.idempotencyKey.trim();
  const backingTxSignature = input.backingTxSignature.trim();
  const walletLock = lockKey('tok-earn-wallet', input.payerWallet, input.earnerAvatarId);

  const [prior] = await database.execute<ExistingEvent>(sql`SELECT e.id, e.ledger_id,
      e.vclaw_minted, e.gross_usdc_atomic, e.earner_avatar_id, e.payer_wallet,
      e.source, e.backing_network, b.source_ref,
      COUNT(*) OVER ()::integer AS proof_count
      FROM earn_events e
      LEFT JOIN earned_mint_lots l ON l.earn_event_id = e.id
      LEFT JOIN earned_backing b ON b.mint_lot_id = l.id
      WHERE e.idempotency_key = ${idem} LIMIT 2`);
  if (prior) return existingResult(prior, input, gross);

  if (input.source === 'admin_test'
    && process.env.CLAWVILLE_ENV !== 'staging'
    && process.env.NODE_ENV !== 'test') {
    return reject('invalid_input', 'admin_test is staging/test only');
  }
  const custodyRows = await database.execute<{ id: string; public_key: string }>(
    sql`SELECT id, public_key FROM treasury_wallets WHERE purpose = 'earned-backing'`,
  );
  if (custodyRows.length !== 1) {
    return reject('backing_custody_unconfigured', 'exactly one earned-backing wallet is required');
  }
  const custody = custodyRows[0];
  const getParsedTransaction = deps.getParsedTransaction ?? (async (network, signature) => {
    const rpcUrl = network === 'mainnet'
      ? (process.env.HELIUS_API_KEY?.trim()
          ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`
          : process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com')
      : process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
    return new Connection(rpcUrl, 'confirmed').getParsedTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
  });
  const chainProof = await (deps.verifyTransfer ?? verifyUsdcTransfer)({
    network: input.backingNetwork,
    signature: backingTxSignature,
    expectedAtomic: gross.toString(),
    expectedMint: usdcMintForNetwork(input.backingNetwork),
    destinationOwner: custody.public_key,
    expectedPayer: input.payerWallet,
  }, { getParsedTransaction });
  if (chainProof.kind !== 'confirmed_match') {
    return reject('backing_transfer_unverified', chainProof.kind);
  }
  const readCustodyUsdcBalance = deps.readCustodyUsdcBalance ?? (async (network, owner, options) => {
    const rpcUrl = network === 'mainnet'
      ? (process.env.HELIUS_API_KEY?.trim()
          ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`
          : process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com')
      : process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
    return readSplTokenBalance(
      new Connection(rpcUrl, 'confirmed'),
      usdcMintForNetwork(network),
      owner,
      options,
    );
  });

  try {
    return await withKeyedMutex(`tok-earn-wallet:${input.payerWallet}:${input.earnerAvatarId}`, () =>
    withKeyedMutex(earnedBackingCustodyMutexKey(custody.id), () =>
    database.transaction(async (tx): Promise<EarnImportResult> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${walletLock})`);
      const [existing] = await tx.execute<ExistingEvent>(
        sql`SELECT e.id, e.ledger_id, e.vclaw_minted, e.gross_usdc_atomic,
                   e.earner_avatar_id, e.payer_wallet, e.source, e.backing_network,
                   b.source_ref, COUNT(*) OVER ()::integer AS proof_count
            FROM earn_events e
            LEFT JOIN earned_mint_lots l ON l.earn_event_id = e.id
            LEFT JOIN earned_backing b ON b.mint_lot_id = l.id
            WHERE e.idempotency_key = ${idem} LIMIT 2`,
      );
      if (existing) {
        return existingResult(existing, input, gross);
      }

      const currentCustody = await tx.execute<{ id: string; public_key: string }>(
        sql`SELECT id, public_key FROM treasury_wallets WHERE purpose = 'earned-backing'`,
      );
      if (currentCustody.length !== 1 || currentCustody[0].id !== custody.id
        || currentCustody[0].public_key !== custody.public_key) {
        return reject('backing_custody_unconfigured', 'exactly one earned-backing wallet is required');
      }

      // Serialize every liability reservation against the one custody wallet.
      // A confirmed historical receipt is insufficient: the dollars must still
      // be held after all existing backing, retained fees, and unswept buys.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${earnedBackingCustodyLockKey(custody.id)})`);
      const [integrityRow] = await tx.execute<EarnedBackingIntegrityCounts>(
        earnedBackingIntegrityQuery(custody.id),
      );
      const integrity = summarizeEarnedBackingIntegrity(integrityRow);
      if (integrity.mismatchCount !== 0) {
        return reject(
          'backing_custody_indeterminate',
          `earned backing ledger mismatch count=${integrity.mismatchCount}; ${integrity.reasons.join(',')}`,
        );
      }
      const [obligations] = await tx.execute<{
        outstanding_usdc_atomic: string;
        retained_fees_usdc_atomic: string;
      }>(sql`SELECT
          COALESCE((SELECT SUM(b.remaining_usdc_atomic)
            FROM earned_backing b
            JOIN earned_mint_lots l ON l.id = b.mint_lot_id
            JOIN earn_events e ON e.id = l.earn_event_id
            WHERE b.custody_wallet_id = ${custody.id}
              AND e.backing_network = ${input.backingNetwork}), 0)
            AS outstanding_usdc_atomic,
          COALESCE((SELECT SUM(r.exit_fee_usdc_atomic)
            FROM earned_redemptions r
            WHERE r.backing_custody_wallet_id = ${custody.id}
              AND ${input.backingNetwork} = 'mainnet'
              AND r.exit_fee_retained_at IS NOT NULL), 0)
            AS retained_fees_usdc_atomic`);
      if (!obligations) {
        return reject('backing_custody_indeterminate', 'custody obligations query returned no row');
      }
      const principals = await tx.execute<EarnedFundingPrincipal>(sql`SELECT
          r.id AS "redemptionId",
          r.buy_usdc_atomic AS "buyUsdcAtomic",
          f.status AS "fundingStatus",
          f.sweep_tx_signature AS "fundingSignature",
          f.sweep_confirmed_slot AS "fundingConfirmedSlot"
        FROM earned_redemptions r
        LEFT JOIN clv_swap_funding f ON f.id = r.clv_swap_funding_id
        WHERE r.backing_custody_wallet_id = ${custody.id}
          AND ${input.backingNetwork} = 'mainnet'
          AND r.exit_fee_retained_at IS NOT NULL`);
      const preflight = calculateEarnedBackingSolvency({
        onchainUsdcAtomic: 0n,
        outstandingBackingUsdcAtomic: BigInt(obligations.outstanding_usdc_atomic),
        retainedExitFeesUsdcAtomic: BigInt(obligations.retained_fees_usdc_atomic),
        principals,
        newBackingUsdcAtomic: gross,
      });
      if (preflight.indeterminateReasons.length > 0) {
        return reject(
          'backing_custody_indeterminate',
          `ambiguous redemption funding: ${preflight.indeterminateReasons.join(',')}`,
        );
      }
      const minContextSlot = principals.reduce((max, principal) =>
        principal.fundingStatus === 'swept'
          ? Math.max(max, Number(principal.fundingConfirmedSlot ?? 0))
          : max, 0);
      let chainBalance: { amountAtomic: bigint; contextSlot: number };
      try {
        chainBalance = await readCustodyUsdcBalance(
          input.backingNetwork,
          custody.public_key,
          minContextSlot > 0 ? { minContextSlot } : undefined,
        );
      } catch (error) {
        return reject(
          'backing_custody_indeterminate',
          `custody balance read failed: ${(error as Error).message}`,
        );
      }
      if (minContextSlot > 0 && chainBalance.contextSlot < minContextSlot) {
        return reject(
          'backing_custody_indeterminate',
          `custody RPC context ${chainBalance.contextSlot} predates sweep ${minContextSlot}`,
        );
      }
      const onchainUsdcAtomic = chainBalance.amountAtomic;
      const admission = calculateEarnedBackingSolvency({
        onchainUsdcAtomic,
        outstandingBackingUsdcAtomic: BigInt(obligations.outstanding_usdc_atomic),
        retainedExitFeesUsdcAtomic: BigInt(obligations.retained_fees_usdc_atomic),
        principals,
        newBackingUsdcAtomic: gross,
      });
      if (!admission.solvent) {
        return reject(
          'backing_custody_insolvent',
          `on-chain ${onchainUsdcAtomic} < required ${admission.requiredUsdcAtomic}`,
        );
      }

      const [known] = await tx.execute<{
        earner_owned: boolean; clawville_owned: boolean;
      }>(sql`SELECT
          EXISTS(SELECT 1 FROM wallets WHERE public_key = ${input.payerWallet}
            AND subject_type = 'avatar' AND subject_id = ${input.earnerAvatarId})
          OR EXISTS(SELECT 1 FROM avatars WHERE id = ${input.earnerAvatarId}
            AND wallet_address = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM avatars a JOIN users u ON u.id = a.user_id
            WHERE a.id = ${input.earnerAvatarId}
              AND u.linked_wallet_pubkey = ${input.payerWallet}) AS earner_owned,
          EXISTS(SELECT 1 FROM wallets WHERE public_key = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM treasury_wallets WHERE public_key = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM vanity_keypairs WHERE public_key = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM avatars WHERE wallet_address = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM openclaw_bots WHERE wallet_address = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM users WHERE identity_pubkey = ${input.payerWallet})
          OR EXISTS(SELECT 1 FROM users WHERE linked_wallet_pubkey = ${input.payerWallet})
          AS clawville_owned`);
      if (known?.earner_owned) return reject('payer_is_earner_wallet');
      if (known?.clawville_owned) return reject('payer_is_clawville_wallet');

      const [counter] = await tx.execute<{ usdc_atomic: string }>(
        sql`SELECT usdc_atomic FROM earn_wallet_epoch_counters
            WHERE backing_network = ${input.backingNetwork}
              AND payer_wallet = ${input.payerWallet}
              AND earner_avatar_id = ${input.earnerAvatarId}
              AND epoch_start = ${epochStart.toISOString()} LIMIT 1`,
      );
      const used = counter ? BigInt(counter.usdc_atomic) : 0n;
      if (used + gross > capAtomic) return reject('payer_wallet_cap_exceeded');
      await tx.execute(sql`INSERT INTO earn_wallet_epoch_counters
          (backing_network, payer_wallet, earner_avatar_id, epoch_start, usdc_atomic, updated_at)
          VALUES (${input.backingNetwork}, ${input.payerWallet}, ${input.earnerAvatarId}, ${epochStart.toISOString()},
                  ${gross.toString()}, now())
          ON CONFLICT (backing_network, payer_wallet, earner_avatar_id, epoch_start) DO UPDATE
          SET usdc_atomic = earn_wallet_epoch_counters.usdc_atomic + EXCLUDED.usdc_atomic,
              updated_at = now()`);

      const [event] = await tx.execute<{ id: string }>(sql`INSERT INTO earn_events
          (idempotency_key, earner_avatar_id, payer_wallet, payer_cluster_key, source,
           backing_network,
           gross_usdc_atomic, rake_bps, vclaw_minted, payer_verification, vests_at,
           epoch_start, metadata)
          VALUES (${idem}, ${input.earnerAvatarId}, ${input.payerWallet}, ${input.payerWallet},
                  ${input.source}, ${input.backingNetwork}, ${gross.toString()}, 0, ${vclaw}, 'pending',
                  ${vestsAt.toISOString()}, ${epochStart.toISOString()},
                  ${JSON.stringify(input.metadata ?? {})}::jsonb)
          RETURNING id`);
      if (!event) throw new Error('earn event insert returned no row');

      const usdBasis = atomicToUsdString(gross);
      const minted = await mintEarned({
        avatarId: input.earnerAvatarId,
        amount: vclaw,
        reason: 'external_settlement',
        source: LEDGER_SOURCE[input.source],
        usdBasis,
        backing: {
          kind: 'backed',
          mintRef: `earn:${event.id}`,
          earnEventId: event.id,
          custodyWalletId: custody.id,
          sourceRef: `usdc:${input.backingNetwork}:${backingTxSignature}`,
          usdcAtomic: gross.toString(),
        },
        metadata: {
          earnEventId: event.id,
          payerWallet: input.payerWallet,
          backingCustodyWallet: custody.public_key,
          backingTxSignature,
          backingNetwork: input.backingNetwork,
          rail: input.source,
          ...input.metadata,
        },
      }, tx);
      await tx.execute(sql`UPDATE earn_events SET ledger_id = ${minted.ledgerId} WHERE id = ${event.id}`);
      return {
        status: 'minted', earnEventId: event.id, ledgerId: minted.ledgerId,
        vclawMinted: vclaw, usdBasis, vestsAt,
      };
    })),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [winner] = await database.execute<ExistingEvent>(sql`SELECT e.id, e.ledger_id,
          e.vclaw_minted, e.gross_usdc_atomic, e.earner_avatar_id, e.payer_wallet,
          e.source, e.backing_network, b.source_ref,
          COUNT(*) OVER ()::integer AS proof_count
          FROM earn_events e
          LEFT JOIN earned_mint_lots l ON l.earn_event_id = e.id
          LEFT JOIN earned_backing b ON b.mint_lot_id = l.id
          WHERE e.idempotency_key = ${idem} LIMIT 2`);
      if (winner) return existingResult(winner, input, gross);
    }
    throw error;
  }
}

export type PayerInspection =
  | { verdict: 'verified'; firstFunderWallet: string; walletAgeSeconds: number; signatureCount: number }
  | { verdict: 'rejected'; reason: string; firstFunderWallet?: string; walletAgeSeconds: number; signatureCount: number };

export interface PayerVerificationDeps {
  inspectPayerWallet?: (
    payerWallet: string,
    network: X402Network,
    cfg: TokenomicsEarnConfig,
  ) => Promise<PayerInspection>;
  now?: () => Date;
  database?: Pick<typeof db, 'execute' | 'transaction'>;
}

async function inspectPayerWalletDefault(
  payerWallet: string,
  network: X402Network,
  cfg: TokenomicsEarnConfig,
): Promise<PayerInspection> {
  const url = network === 'mainnet'
    ? (process.env.HELIUS_API_KEY?.trim()
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`
        : process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com')
    : process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
  const connection = new Connection(url, 'confirmed');
  const pubkey = new PublicKey(payerWallet);
  const signatures: Awaited<ReturnType<typeof connection.getSignaturesForAddress>> = [];
  let before: string | undefined;
  for (let page = 0; page < cfg.verificationMaxPages; page += 1) {
    const rows = await connection.getSignaturesForAddress(pubkey, { limit: 1000, before }, 'confirmed');
    signatures.push(...rows);
    if (rows.length < 1000) break;
    before = rows.at(-1)?.signature;
  }
  if (signatures.length === 0) {
    return { verdict: 'rejected', reason: 'no_funding_history', walletAgeSeconds: 0, signatureCount: 0 };
  }
  if (signatures.length >= cfg.verificationMaxPages * 1000) {
    return { verdict: 'rejected', reason: 'history_scan_cap_reached', walletAgeSeconds: 0, signatureCount: signatures.length };
  }
  const oldest = signatures.at(-1)!;
  const age = oldest.blockTime ? Math.max(0, Math.floor(Date.now() / 1000) - oldest.blockTime) : 0;
  if (age < cfg.payerMinAgeDays * 86_400) {
    return { verdict: 'rejected', reason: 'payer_too_young', walletAgeSeconds: age, signatureCount: signatures.length };
  }
  if (signatures.length < cfg.payerMinSignatures) {
    return { verdict: 'rejected', reason: 'insufficient_history', walletAgeSeconds: age, signatureCount: signatures.length };
  }
  const parsed = await connection.getParsedTransaction(oldest.signature, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  const funder = parsed?.transaction.message.accountKeys.find(
    (key) => key.signer && key.pubkey.toBase58() !== payerWallet,
  )?.pubkey.toBase58();
  if (!funder) {
    return { verdict: 'rejected', reason: 'first_funder_unresolved', walletAgeSeconds: age, signatureCount: signatures.length };
  }
  return { verdict: 'verified', firstFunderWallet: funder, walletAgeSeconds: age, signatureCount: signatures.length };
}

type PendingEvent = {
  id: string; earner_avatar_id: string; payer_wallet: string;
  gross_usdc_atomic: string; epoch_start: Date; backing_network: X402Network;
};

async function rejectEvent(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], event: PendingEvent, inspection: PayerInspection, reason: string, now: Date) {
  await tx.execute(sql`UPDATE earn_events SET payer_verification = 'rejected',
      first_funder_wallet = ${inspection.firstFunderWallet ?? null}, verified_at = ${now.toISOString()},
      verification_reason = ${reason}
      WHERE id = ${event.id} AND payer_verification = 'pending'`);
  // Rejected units stay spendable, but their physical dollars are no longer a
  // redemption liability. The lot becomes `none`; backing release is durable.
  await tx.execute(sql`UPDATE earned_mint_lots SET backing_kind = 'none',
      released_at = now(), release_reason = ${`payer_rejected:${reason}`}
      WHERE earn_event_id = ${event.id}`);
  await tx.execute(sql`UPDATE earned_backing b
      SET released_usdc_atomic = released_usdc_atomic + remaining_usdc_atomic,
          remaining_usdc_atomic = 0, updated_at = now()
      FROM earned_mint_lots l WHERE l.earn_event_id = ${event.id} AND b.mint_lot_id = l.id`);
}

export async function runPayerVerificationBatch(
  deps: PayerVerificationDeps = {},
): Promise<{ processed: number; verified: number; rejected: number }> {
  const cfg = loadTokenomicsEarnConfig();
  if (!cfg.enabled) return { processed: 0, verified: 0, rejected: 0 };
  const inspect = deps.inspectPayerWallet ?? inspectPayerWalletDefault;
  const database = deps.database ?? db;
  const pending = await database.execute<PendingEvent>(sql`SELECT id, earner_avatar_id, payer_wallet,
      gross_usdc_atomic, epoch_start, backing_network FROM earn_events
      WHERE payer_verification = 'pending' ORDER BY created_at LIMIT ${cfg.verificationBatchSize}`);
  let verified = 0;
  let rejected = 0;
  for (const event of pending) {
    const inspection = await inspect(event.payer_wallet, event.backing_network, cfg);
    const now = deps.now?.() ?? new Date();
    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM avatars WHERE id = ${event.earner_avatar_id} FOR UPDATE`);
      const [current] = await tx.execute<{ id: string }>(sql`SELECT id FROM earn_events
          WHERE id = ${event.id} AND payer_verification = 'pending' FOR UPDATE`);
      if (!current) return;
      if (inspection.verdict === 'rejected') {
        await rejectEvent(tx, event, inspection, inspection.reason, now);
        rejected += 1;
        return;
      }
      const cluster = inspection.firstFunderWallet;
      // Serialize the durable payer->first-funder identity before consulting
      // or choosing a cluster. This lock is taken after the event row and
      // before the cluster/earner cap lock on every verification path.
      const payerMappingLock = lockKey(
        'tok-earn-payer-map',
        event.backing_network,
        event.payer_wallet,
      );
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${payerMappingLock})`);
      const [mapping] = await tx.execute<{ first_funder_wallet: string }>(sql`SELECT first_funder_wallet
          FROM earn_payer_clusters WHERE backing_network = ${event.backing_network}
            AND payer_wallet = ${event.payer_wallet} FOR UPDATE`);
      if (mapping && mapping.first_funder_wallet !== cluster) {
        await rejectEvent(tx, event, inspection, 'first_funder_mapping_conflict', now);
        rejected += 1;
        return;
      }
      // The first verified chain observation is immutable identity evidence,
      // even when later policy (house funding or the cap) rejects this event.
      // Conflict updates intentionally never replace funder/cluster columns.
      await tx.execute(sql`INSERT INTO earn_payer_clusters
          (backing_network, payer_wallet, first_funder_wallet, cluster_key,
           wallet_age_seconds, signature_count, verified_at, metadata)
          VALUES (${event.backing_network}, ${event.payer_wallet}, ${cluster}, ${cluster},
           ${inspection.walletAgeSeconds}, ${inspection.signatureCount}, ${now.toISOString()}, '{}'::jsonb)
          ON CONFLICT (backing_network, payer_wallet) DO UPDATE
            SET wallet_age_seconds = EXCLUDED.wallet_age_seconds,
            signature_count = EXCLUDED.signature_count, verified_at = EXCLUDED.verified_at`);
      const clusterLock = lockKey(
        'tok-earn-cluster',
        event.backing_network,
        cluster,
        event.earner_avatar_id,
      );
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${clusterLock})`);
      const [known] = await tx.execute<{ clawville_owned: boolean }>(sql`SELECT
          EXISTS(SELECT 1 FROM wallets WHERE public_key = ${cluster})
          OR EXISTS(SELECT 1 FROM treasury_wallets WHERE public_key = ${cluster})
          OR EXISTS(SELECT 1 FROM vanity_keypairs WHERE public_key = ${cluster})
          OR EXISTS(SELECT 1 FROM avatars WHERE wallet_address = ${cluster})
          OR EXISTS(SELECT 1 FROM openclaw_bots WHERE wallet_address = ${cluster})
          OR EXISTS(SELECT 1 FROM users WHERE identity_pubkey = ${cluster})
          OR EXISTS(SELECT 1 FROM users WHERE linked_wallet_pubkey = ${cluster})
          AS clawville_owned`);
      if (known?.clawville_owned) {
        await rejectEvent(tx, event, inspection, 'first_funder_is_clawville_wallet', now);
        rejected += 1;
        return;
      }
      const [counter] = await tx.execute<{ usdc_atomic: string }>(sql`SELECT usdc_atomic
          FROM earn_cluster_epoch_counters WHERE backing_network = ${event.backing_network}
            AND payer_cluster_key = ${cluster}
            AND earner_avatar_id = ${event.earner_avatar_id}
            AND epoch_start = ${new Date(event.epoch_start).toISOString()} LIMIT 1`);
      const cap = BigInt(cfg.pairCapUsdPerEpoch) * 1_000_000n;
      if ((counter ? BigInt(counter.usdc_atomic) : 0n) + BigInt(event.gross_usdc_atomic) > cap) {
        await rejectEvent(tx, event, inspection, 'first_funder_cluster_cap_exceeded', now);
        rejected += 1;
        return;
      }
      await tx.execute(sql`INSERT INTO earn_cluster_epoch_counters
          (backing_network, payer_cluster_key, earner_avatar_id, epoch_start, usdc_atomic, updated_at)
          VALUES (${event.backing_network}, ${cluster}, ${event.earner_avatar_id}, ${new Date(event.epoch_start).toISOString()},
                  ${event.gross_usdc_atomic}, now())
          ON CONFLICT (backing_network, payer_cluster_key, earner_avatar_id, epoch_start) DO UPDATE
          SET usdc_atomic = earn_cluster_epoch_counters.usdc_atomic + EXCLUDED.usdc_atomic,
              updated_at = now()`);
      await tx.execute(sql`UPDATE earn_events SET payer_verification = 'verified',
          payer_cluster_key = ${cluster}, first_funder_wallet = ${cluster},
          verified_at = ${now.toISOString()}, verification_reason = 'heuristics_v1_passed'
          WHERE id = ${event.id} AND payer_verification = 'pending'`);
      verified += 1;
    });
  }
  return { processed: verified + rejected, verified, rejected };
}

let verificationTimer: ReturnType<typeof setInterval> | null = null;
export function startEarnedPayerVerificationWorker(): void {
  if (verificationTimer || !loadTokenomicsEarnConfig().enabled) return;
  const tick = () => void runPayerVerificationBatch().catch((error) => {
    console.error('[earned-payer-verifier] batch failed', error instanceof Error ? error.message : error);
  });
  tick();
  verificationTimer = setInterval(tick, loadTokenomicsEarnConfig().verificationPollMs);
  verificationTimer.unref?.();
}

export function stopEarnedPayerVerificationWorker(): void {
  if (verificationTimer) clearInterval(verificationTimer);
  verificationTimer = null;
}

export async function clawBackEarnEvent(input: {
  earnEventId: string; adminUserId: string; reason: string;
}): Promise<EarnedClawbackResult> {
  if (!loadTokenomicsEarnConfig().enabled) throw new Error('tokenomics_earn_disabled');
  return clawBackEarnedMint(input);
}
