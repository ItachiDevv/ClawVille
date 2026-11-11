/** Custodial UsePod deposits. Never rebuild or resend an admitted transaction. */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AccountMeta,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  agentAiSettings,
  and,
  asc,
  avatars,
  db,
  eq,
  inArray,
  sql,
  userSpendPolicies,
  users,
  vendorSpendLedger,
  wallets,
  type VendorSpendRow,
} from '@clawville/database';
import {
  OWN_AI_USEPOD_PROGRAM_ID,
  OWN_AI_USEPOD_DEPOSIT_MIN_CENTS,
  OWN_AI_USEPOD_DEPOSIT_MAX_CENTS,
  OWN_AI_USEPOD_MIN_SOL_LAMPORTS,
  USEPOD_DEPOSITS_PER_DAY,
  USEPOD_FEE_WALLET_LOW_LAMPORTS,
  USEPOD_FEE_WALLET_MIN_LAMPORTS,
  USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY,
  USEPOD_SPONSORED_DEPOSITS_PER_DAY,
  type SpendPolicyView,
} from '@clawville/shared';
import { decryptWalletRow } from './keypair-vault';
import { loadUsepodFeePayerKeypair, readUsepodFeePayer, wipeKeypair } from './usepod-fee-payer';
import { lockSpendRules, toSpendPolicyView } from './spend-policy';
import { OwnAiError, readUsepodBalance } from './own-ai';
import {
  issueUsepodDepositChallenge,
  verifyUsepodDepositProof,
  type UsepodDepositApprovalTerms,
} from './spend-policy-proof';
import { resolveAgentPayRail } from './agent-pay';

export const USEPOD_PROGRAM_ID = OWN_AI_USEPOD_PROGRAM_ID;
export const USEPOD_CONFIG_PDA = 'G9ko998ReQinG5Cc6YT7NS7hZJucXyuxLxTXTwKEpNPH';
export const USEPOD_OPS_WALLET = '55XjZhXbLMRoEpNY2JmkHhcFfbTnjFnGh75j36Xk6YgP';
export const USEPOD_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USEPOD_MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const DEPOSIT_DISCRIMINATOR = Buffer.from([184, 148, 250, 169, 224, 213, 34, 126]);
export const DEPOSIT_EVENT_DISCRIMINATOR = Buffer.from([120, 248, 61, 83, 31, 142, 107, 144]);
const CONFIG_DISCRIMINATOR = Buffer.from([196, 210, 90, 231, 144, 149, 140, 63]);
export const USEPOD_MAX_CREDIT_RECONCILE_ATTEMPTS = 8;
/** Sticky: a finalized tx with no error whose evidence did not match. Never becomes 'failed'. */
export const FINALIZED_EVIDENCE_MISMATCH = 'finalized_evidence_mismatch';
/** The ledger `fee_payer` and the signed `deposit_terms.feePayer` differ: operator review, never automatic. */
export const FEE_PAYER_MISMATCH = 'fee_payer_mismatch';
const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export function usepodAta(owner: string): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(TOKEN_PROGRAM).toBuffer(),
      new PublicKey(USEPOD_USDC_MINT).toBuffer(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  )[0].toBase58();
}
export function buildDepositData(code: string, amount: bigint): Buffer {
  if (!/^[0-9a-f]{16}$/.test(code) || amount <= 0n || amount > 0xffffffffffffffffn)
    throw new Error('invalid_deposit_terms');
  const data = Buffer.alloc(24);
  DEPOSIT_DISCRIMINATOR.copy(data);
  Buffer.from(code, 'hex').copy(data, 8);
  data.writeBigUInt64LE(amount, 16);
  return data;
}
export function buildDepositAccounts(depositor: string): AccountMeta[] {
  return [
    usepodAta(depositor),
    usepodAta(USEPOD_OPS_WALLET),
    USEPOD_CONFIG_PDA,
    depositor,
    USEPOD_USDC_MINT,
    TOKEN_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
  ].map((key, i) => ({
    pubkey: new PublicKey(key),
    isSigner: i === 3,
    isWritable: i === 0 || i === 1 || i === 3,
  }));
}
export interface DepositTerms {
  code: string;
  amount: string;
  depositor: string;
  ledgerId: string;
  baselineMicro: number;
  /** Set only when the ClawVille fee wallet pays the network fee. Absent = the depositor pays (all rows before 2026-11-11). */
  feePayer?: string;
}
/** The account that must pay the fee for these terms. */
export function expectedFeePayer(terms: DepositTerms): string {
  return terms.feePayer ?? terms.depositor;
}
export function buildDepositTransaction(terms: DepositTerms, blockhash: string): Transaction {
  if (terms.feePayer !== undefined && terms.feePayer === terms.depositor) throw new Error('invalid_deposit_terms');
  return new Transaction({
    feePayer: new PublicKey(expectedFeePayer(terms)),
    recentBlockhash: blockhash,
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(USEPOD_PROGRAM_ID),
      keys: buildDepositAccounts(terms.depositor),
      data: buildDepositData(terms.code, BigInt(terms.amount)),
    }),
    new TransactionInstruction({
      programId: new PublicKey(USEPOD_MEMO_PROGRAM),
      keys: [],
      data: Buffer.from(`clawville:usepod:${terms.ledgerId}`),
    }),
  );
}
export function decodeDepositEvent(data: Uint8Array): {
  code: string;
  amount: bigint;
  mint: string;
  depositor: string;
  timestamp: bigint;
} | null {
  const b = Buffer.from(data);
  if (b.length !== 96 || !b.subarray(0, 8).equals(DEPOSIT_EVENT_DISCRIMINATOR)) return null;
  return {
    code: b.subarray(8, 16).toString('hex'),
    amount: b.readBigUInt64LE(16),
    mint: new PublicKey(b.subarray(24, 56)).toBase58(),
    depositor: new PublicKey(b.subarray(56, 88)).toBase58(),
    timestamp: b.readBigInt64LE(88),
  };
}
export interface DepositProof {
  finalized: boolean;
  err: unknown;
  fee: number;
  signatures: string[];
  feePayer: string;
  instructions: {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: Uint8Array;
  }[];
  logs: string[];
}
export function checkDepositProof(proof: DepositProof | null, terms: DepositTerms, signature: string): boolean {
  if (
    !proof?.finalized ||
    proof.err !== null ||
    proof.signatures[0] !== signature ||
    // The fee payer pinned in the terms: the ClawVille fee wallet, or the depositor for an unsponsored row.
    proof.feePayer !== expectedFeePayer(terms) ||
    proof.signatures.length !== (terms.feePayer === undefined ? 1 : 2) ||
    proof.instructions.length !== 2
  )
    return false;
  const [ix, memo] = proof.instructions;
  if (
    !ix ||
    !memo ||
    ix.programId !== USEPOD_PROGRAM_ID ||
    memo.programId !== USEPOD_MEMO_PROGRAM ||
    memo.keys.length !== 0
  )
    return false;
  if (
    !Buffer.from(ix.data).equals(buildDepositData(terms.code, BigInt(terms.amount))) ||
    Buffer.from(memo.data).toString() !== `clawville:usepod:${terms.ledgerId}`
  )
    return false;
  const expected = buildDepositAccounts(terms.depositor);
  if (
    ix.keys.length !== expected.length ||
    ix.keys.some(
      (key, i) =>
        key.pubkey !== expected[i]!.pubkey.toBase58() ||
        key.isSigner !== expected[i]!.isSigner ||
        key.isWritable !== expected[i]!.isWritable,
    )
  )
    return false;
  // Accept only an event emitted directly by this program, never a nested CPI log.
  const stack: string[] = [];
  let events = 0;
  for (const log of proof.logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \S+ (success|failed:)/.test(log)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== USEPOD_PROGRAM_ID || !log.startsWith('Program data: ')) continue;
    const event = decodeDepositEvent(Buffer.from(log.slice(14), 'base64'));
    if (
      event &&
      event.code === terms.code &&
      event.amount === BigInt(terms.amount) &&
      event.mint === USEPOD_USDC_MINT &&
      event.depositor === terms.depositor
    )
      events++;
  }
  return events === 1;
}
/**
 * The exact transaction a key may sign for THESE terms: one deposit_usdc
 * instruction for the pinned program with the exact seven accounts and the
 * exact data (code, amount), and one memo `clawville:usepod:<ledgerId>` with no
 * accounts, nothing else. The fee payer and depositor are the ones in the
 * terms. No durable nonce. The signer count is 2 when sponsored, else 1. When
 * the fee wallet pays, it appears in no instruction account list, so its
 * signature only pays the fee (writable only as the fee payer). Throws on any
 * other transaction.
 */
export function assertDepositTransaction(
  transaction: Transaction,
  terms: DepositTerms,
): {
  depositor: string;
  feePayer: string;
  sponsored: boolean;
} {
  const fail = (): never => {
    throw new Error('unexpected_transaction_shape');
  };
  const [ix, memo] = transaction.instructions;
  const feePayer = transaction.feePayer?.toBase58();
  if (
    transaction.nonceInfo ||
    transaction.instructions.length !== 2 ||
    !ix ||
    !memo ||
    !feePayer ||
    feePayer !== expectedFeePayer(terms) ||
    ix.programId.toBase58() !== USEPOD_PROGRAM_ID ||
    !Buffer.from(ix.data).equals(buildDepositData(terms.code, BigInt(terms.amount))) ||
    memo.programId.toBase58() !== USEPOD_MEMO_PROGRAM ||
    memo.keys.length !== 0 ||
    Buffer.from(memo.data).toString() !== `clawville:usepod:${terms.ledgerId}`
  )
    fail();
  const expected = buildDepositAccounts(terms.depositor);
  if (
    ix!.keys.length !== expected.length ||
    ix!.keys.some(
      (key, i) =>
        !key.pubkey.equals(expected[i]!.pubkey) ||
        key.isSigner !== expected[i]!.isSigner ||
        key.isWritable !== expected[i]!.isWritable,
    )
  )
    fail();
  const sponsored = terms.feePayer !== undefined;
  if (sponsored && transaction.instructions.some((i) => i.keys.some((key) => key.pubkey.toBase58() === feePayer)))
    fail();
  if (transaction.compileMessage().header.numRequiredSignatures !== (sponsored ? 2 : 1)) fail();
  return { depositor: terms.depositor, feePayer: feePayer!, sponsored };
}
/** The 64-byte secret a web3.js Keypair holds, by reference (the `secretKey` getter returns a copy). */
function heldSecret(keypair: Keypair): Uint8Array {
  const secret = (keypair as unknown as { _keypair?: { secretKey?: unknown } })._keypair?.secretKey;
  if (!(secret instanceof Uint8Array) || secret.length !== 64) throw new Error('keypair_unreadable');
  return secret;
}
/**
 * Signs a deposit transaction checked against its terms with the avatar key
 * (depositor) and, when sponsored, the fee wallet key. It signs with
 * nacl.sign.detached over the held secret buffers (never the `secretKey`
 * getter or `Transaction.sign`, which make copies nobody wipes) and wipes both
 * keys on every path.
 */
export function signDepositTransaction(
  transaction: Transaction,
  terms: DepositTerms,
  depositorKey: Keypair,
  feeKey: Keypair | null,
): { bytes: Uint8Array; signature: string } {
  try {
    const shape = assertDepositTransaction(transaction, terms);
    if (depositorKey.publicKey.toBase58() !== shape.depositor) throw new Error('wallet_changed');
    let signers: Keypair[];
    if (shape.sponsored) {
      if (!feeKey || feeKey.publicKey.toBase58() !== shape.feePayer) throw new Error('fee_wallet_changed');
      signers = [feeKey, depositorKey];
    } else {
      if (feeKey) throw new Error('fee_wallet_unexpected');
      signers = [depositorKey];
    }
    const message = transaction.serializeMessage();
    for (const signer of signers)
      transaction.addSignature(signer.publicKey, Buffer.from(nacl.sign.detached(message, heldSecret(signer))));
    // The first signature is the fee payer's: it is the transaction id.
    if (!transaction.signature || !transaction.verifySignatures(true)) throw new Error('signature_missing');
    return {
      bytes: transaction.serialize(),
      signature: bs58.encode(transaction.signature),
    };
  } finally {
    wipeKeypair(depositorKey);
    wipeKeypair(feeKey);
  }
}
export interface DepositInput {
  avatarId: string;
  actor: 'human' | 'agent';
  userId?: string;
  amountCents: number;
  idempotencyKey: string;
  nonce?: string;
  signature?: string;
}
export interface DepositSettings {
  code: string;
  tokenLast4: string;
  wallet: string;
}
type Balance = { usdcMicro: number; isActive: boolean };
export type DepositResult =
  | {
      ok: true;
      ledgerId: string;
      status: 'pending' | 'paid' | 'failed' | 'ambiguous';
      txSignature: string | null;
      usdCents: number;
      creditStatus: 'unknown' | 'seen';
      balance: Balance | null;
      /** 'clawville' = the ClawVille fee wallet paid the network fee; 'avatar' = the avatar wallet paid. */
      feePaidBy: 'clawville' | 'avatar';
    }
  | { ok: false; code: string; ledgerId?: string };
/** A fee wallet chosen before admission, and whether the avatar wallet could pay instead. */
export type Sponsorship = { feePayer: string; avatarCanPay: boolean };
type Admission =
  /** feePayer: the fee wallet that pays, or null when the avatar wallet pays (absent = as requested). */
  | { ok: true; ledgerId: string; approvalProven?: boolean; feePayer?: string | null }
  | { ok: false; code: string; ledgerId?: string };
export interface UsepodDepositDeps {
  policyPrecheck(input: DepositInput): Promise<string | null>;
  replay(input: DepositInput): Promise<DepositResult | null>;
  closeUnsigned(id: string): Promise<boolean>;
  deferReconcile(id: string): Promise<void>;
  settings(avatarId: string): Promise<DepositSettings | null>;
  /** Vendor accounts and depositor USDC. The SOL fee check is in chooseFeePayer. */
  precheck(wallet: string, amount: bigint): Promise<string | null>;
  /** The ACTIVE ClawVille fee wallet public key, or null (sponsorship off). */
  feePayer(): Promise<string | null>;
  solBalance(wallet: string): Promise<number>;
  /** Sponsored deposits today (UTC), all avatars, that hold a reservation or may have been sent. */
  sponsoredToday(): Promise<number>;
  /** The same count for one avatar. */
  avatarSponsoredToday(avatarId: string): Promise<number>;
  balance(avatarId: string): Promise<Balance | null>;
  /** True when this avatar has a usepod ledger row that may have moved money (pending, ambiguous or paid). */
  priorDeposit(avatarId: string): Promise<boolean>;
  /**
   * firstDeposit: baseline 0 was assumed; admission rechecks hasPriorUsepodDeposit under the lock.
   * sponsor: the fee wallet chosen before admission. Admission rechecks the per-avatar and global
   * sponsored caps under the locks, BEFORE the approval nonce is consumed. At a cap it falls back to
   * the avatar wallet when `avatarCanPay`, else refuses. The result names the final fee payer.
   */
  admit(input: DepositInput, settings: DepositSettings, firstDeposit?: boolean, sponsor?: Sponsorship | null): Promise<Admission>;
  blockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sign(avatarId: string, transaction: Transaction, terms: DepositTerms): Promise<{ bytes: Uint8Array; signature: string }>;
  simulate(bytes: Uint8Array): Promise<boolean>;
  persist(
    id: string,
    signed: { bytes: Uint8Array; signature: string },
    height: number,
    terms: DepositTerms,
    input: DepositInput,
    approvalProven: boolean,
  ): Promise<boolean>;
  send(bytes: Uint8Array): Promise<void>;
  proof(signature: string): Promise<DepositProof | null>;
  signatureKnown(signature: string): Promise<boolean>;
  blockHeight(): Promise<number>;
  finish(
    id: string,
    status: 'paid' | 'failed' | 'ambiguous',
    fields: {
      feeLamports?: number;
      failureReason?: string | null;
      txSignature?: string;
      creditStatus?: 'unknown' | 'seen';
    },
  ): Promise<void>;
  sleep(ms: number): Promise<void>;
  reconcileRows(includeExhausted?: boolean): Promise<VendorSpendRow[]>;
}
export function approvalTerms(input: DepositInput, settings: DepositSettings): UsepodDepositApprovalTerms {
  return {
    avatarId: input.avatarId,
    amountCents: input.amountCents,
    opsWallet: USEPOD_OPS_WALLET,
    programId: USEPOD_PROGRAM_ID,
    tokenLast4: settings.tokenLast4,
    idempotencyKey: input.idempotencyKey,
  };
}
export function checkDepositPolicy(
  policy: SpendPolicyView,
  amountCents: number,
  spent: bigint,
  attempts: number,
): string | null {
  if (!policy.configured || policy.perCallCapUsdCents === null || policy.dailyCapUsdCents === null)
    return 'spend_rules_not_set';
  if (!policy.allowedVendors.includes('usepod')) return 'vendor_not_allowed';
  if (amountCents > policy.perCallCapUsdCents) return 'over_per_call_cap';
  if (spent + BigInt(amountCents) * 10000n > BigInt(policy.dailyCapUsdCents) * 10000n) return 'over_daily_cap';
  if (attempts >= USEPOD_DEPOSITS_PER_DAY) return 'deposit_daily_limit';
  return null;
}
/** True when the avatar has a usepod ledger row that may have moved money (pending, ambiguous or paid). */
export async function hasPriorUsepodDeposit(executor: Pick<typeof db, 'select'>, avatarId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: vendorSpendLedger.id })
    .from(vendorSpendLedger)
    .where(
      and(
        eq(vendorSpendLedger.avatarId, avatarId),
        eq(vendorSpendLedger.vendor, 'usepod'),
        sql`${vendorSpendLedger.status} IN ('pending','ambiguous','paid')`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
/** Global lock for the sponsored cap. Always taken AFTER the per-avatar spend lock (one lock order). */
export const USEPOD_FEE_PAYER_LOCK_KEY = 'usepod:fee-payer:global';
/**
 * Sponsored UsePod rows today (UTC) that hold a reservation or may have been
 * sent (same rule as the per-avatar attempt count). All avatars, or one avatar.
 * Served by the partial index of migration 0121c.
 */
export function sponsoredTodaySql(avatarId?: string) {
  return sql`SELECT COUNT(*)::int AS n FROM vendor_spend_ledger
    WHERE vendor = 'usepod' AND fee_payer IS NOT NULL
    AND (status IN ('pending','paid','ambiguous') OR (status = 'failed' AND failure_reason NOT LIKE 'not_sent_%'))
    AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ${avatarId === undefined ? sql.empty() : sql`AND avatar_id = ${avatarId}`}`;
}
async function admit(
  input: DepositInput,
  settings: DepositSettings,
  firstDeposit = false,
  sponsor: Sponsorship | null = null,
): Promise<Admission> {
  return db.transaction(async (tx) => {
    await lockSpendRules(tx, input.avatarId);
    const [existing] = await tx
      .select({ id: vendorSpendLedger.id })
      .from(vendorSpendLedger)
      .where(
        and(eq(vendorSpendLedger.avatarId, input.avatarId), eq(vendorSpendLedger.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1);
    if (existing) return { ok: false, code: 'duplicate_request', ledgerId: existing.id };
    // Baseline 0 was assumed for a token UsePod has not activated: recheck
    // under the lock, so two concurrent first deposits cannot both use it.
    if (firstDeposit && (await hasPriorUsepodDeposit(tx, input.avatarId))) return { ok: false, code: 'provider_error' };
    const [row] = await tx
      .select()
      .from(userSpendPolicies)
      .where(eq(userSpendPolicies.avatarId, input.avatarId))
      .limit(1);
    const policy = toSpendPolicyView(row);
    const totals = Array.from(
      await tx.execute<{ spent: string; attempts: number; sponsored?: number }>(sql`SELECT
      COALESCE(SUM(usdc_atomic) FILTER (WHERE status IN ('pending','paid','ambiguous')),0)::text AS spent,
      COUNT(*) FILTER (WHERE vendor = 'usepod' AND (status IN ('pending','paid','ambiguous') OR (status = 'failed' AND failure_reason NOT LIKE 'not_sent_%')))::int AS attempts,
      COUNT(*) FILTER (WHERE vendor = 'usepod' AND fee_payer IS NOT NULL AND (status IN ('pending','paid','ambiguous') OR (status = 'failed' AND failure_reason NOT LIKE 'not_sent_%')))::int AS sponsored
      FROM vendor_spend_ledger WHERE avatar_id = ${input.avatarId}
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`),
    )[0];
    const refusal = checkDepositPolicy(policy, input.amountCents, BigInt(totals?.spent ?? '0'), totals?.attempts ?? 0);
    if (refusal) return { ok: false, code: refusal };
    // Re-read the registered destination under the same lock as register.
    const [current] = await tx
      .select()
      .from(agentAiSettings)
      .where(eq(agentAiSettings.avatarId, input.avatarId))
      .limit(1);
    if (
      !current?.usepodRegistered ||
      current.usepodDepositCode !== settings.code ||
      current.usepodTokenLast4 !== settings.tokenLast4
    )
      return { ok: false, code: 'usepod_deposit_code_missing' };
    // Fee payer, decided under the locks and BEFORE the approval nonce is
    // consumed. Per-avatar cap under the spend lock; global cap under the
    // global lock (always taken after the spend lock: one lock order). At a cap
    // the avatar wallet pays when it can (its SOL was read before admission),
    // else a clear refusal.
    let feePayer: string | null = null;
    if (sponsor) {
      let full: string | null =
        (totals?.sponsored ?? 0) >= USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY ? 'fee_sponsor_avatar_daily_limit' : null;
      if (!full) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${USEPOD_FEE_PAYER_LOCK_KEY}, 0))`);
        const sponsored = Array.from(await tx.execute<{ n: number }>(sponsoredTodaySql()))[0]?.n ?? 0;
        if (sponsored >= USEPOD_SPONSORED_DEPOSITS_PER_DAY) full = 'fee_sponsor_daily_limit';
      }
      if (!full) feePayer = sponsor.feePayer;
      else if (!sponsor.avatarCanPay) return { ok: false, code: full };
    }
    if (policy.requireApproval) {
      if (input.actor === 'agent') return { ok: false, code: 'approval_required' };
      if (!input.userId || !input.nonce || !input.signature) return { ok: false, code: 'signature_required' };
      const [owner] = await tx
        .select({ wallet: users.linkedWalletPubkey })
        .from(users)
        .innerJoin(avatars, eq(avatars.userId, users.id))
        .where(and(eq(avatars.id, input.avatarId), eq(users.id, input.userId)))
        .limit(1);
      if (!owner?.wallet) return { ok: false, code: 'wallet_link_required' };
      if (
        verifyUsepodDepositProof({
          userId: input.userId,
          terms: approvalTerms(input, settings),
          nonce: input.nonce,
          signature: input.signature,
          walletPubkey: owner.wallet,
        }) !== 'ok'
      )
        return { ok: false, code: 'invalid_wallet_proof' };
    }
    const [inserted] = await tx
      .insert(vendorSpendLedger)
      .values({
        avatarId: input.avatarId,
        vendor: 'usepod',
        tool: 'usepod_deposit',
        actor: input.actor,
        status: 'pending',
        usdcAtomic: String(input.amountCents * 10000),
        usdCents: input.amountCents,
        payTo: USEPOD_OPS_WALLET,
        payerWallet: settings.wallet,
        network: NETWORK,
        idempotencyKey: input.idempotencyKey,
        creditStatus: 'unknown',
        feePayer,
      })
      .returning({ id: vendorSpendLedger.id });
    return {
      ok: true,
      ledgerId: inserted!.id,
      approvalProven: policy.requireApproval,
      feePayer,
    };
  });
}
function defaultDeps(): UsepodDepositDeps {
  const rail = resolveAgentPayRail();
  const connection = new Connection(
    rail.network === 'mainnet' && rail.rpcUrl
      ? rail.rpcUrl
      : process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
    'finalized',
  );
  return {
    policyPrecheck: async (input) => {
      const [row] = await db
        .select()
        .from(userSpendPolicies)
        .where(eq(userSpendPolicies.avatarId, input.avatarId))
        .limit(1);
      const policy = toSpendPolicyView(row);
      const refusal = checkDepositPolicy(policy, input.amountCents, 0n, 0);
      if (refusal) return refusal;
      if (policy.requireApproval && input.actor === 'agent') return 'approval_required';
      if (policy.requireApproval && (!input.userId || !input.nonce || !input.signature)) return 'signature_required';
      return null;
    },
    replay: async (input) => {
      const [row] = await db
        .select()
        .from(vendorSpendLedger)
        .where(
          and(
            eq(vendorSpendLedger.avatarId, input.avatarId),
            eq(vendorSpendLedger.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.vendor !== 'usepod' || row.usdCents !== input.amountCents)
        return { ok: false, code: 'duplicate_request', ledgerId: row.id };
      return {
        ok: true,
        ledgerId: row.id,
        status: row.status,
        txSignature: row.txSignature ?? row.payerSignature,
        usdCents: row.usdCents,
        creditStatus: row.creditStatus === 'seen' ? 'seen' : 'unknown',
        balance: null,
        feePaidBy: row.feePayer ? 'clawville' : 'avatar',
      };
    },
    closeUnsigned: async (id) =>
      (
        await db
          .update(vendorSpendLedger)
          .set({
            status: 'failed',
            failureReason: 'not_sent_interrupted',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(vendorSpendLedger.id, id),
              eq(vendorSpendLedger.status, 'pending'),
              sql`${vendorSpendLedger.payerSignature} IS NULL`,
            ),
          )
          .returning({ id: vendorSpendLedger.id })
      ).length === 1,
    deferReconcile: async (id) => {
      await db
        .update(vendorSpendLedger)
        .set({
          reconcileAttempts: sql`${vendorSpendLedger.reconcileAttempts} + 1`,
          reconcileNextAt: sql`now() + make_interval(mins => LEAST(15 * power(2, LEAST(${vendorSpendLedger.reconcileAttempts}, 7)), 1440)::int)`,
          updatedAt: new Date(),
        })
        .where(eq(vendorSpendLedger.id, id));
    },
    settings: async (avatarId) => {
      const [settings] = await db
        .select({
          registered: agentAiSettings.usepodRegistered,
          code: agentAiSettings.usepodDepositCode,
          tokenLast4: agentAiSettings.usepodTokenLast4,
        })
        .from(agentAiSettings)
        .where(eq(agentAiSettings.avatarId, avatarId))
        .limit(1);
      const wallet = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
        columns: { publicKey: true },
      });
      return settings?.registered && settings.code && settings.tokenLast4 && wallet
        ? {
            code: settings.code,
            tokenLast4: settings.tokenLast4,
            wallet: wallet.publicKey,
          }
        : null;
    },
    precheck: async (wallet, amount) => {
      const config = await connection.getAccountInfo(new PublicKey(USEPOD_CONFIG_PDA), 'finalized');
      if (
        !config ||
        config.owner.toBase58() !== USEPOD_PROGRAM_ID ||
        config.data.length < 137 ||
        !config.data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR) ||
        new PublicKey(config.data.subarray(8, 40)).toBase58() !== USEPOD_OPS_WALLET ||
        new PublicKey(config.data.subarray(105, 137)).toBase58() !== USEPOD_USDC_MINT
      )
        return 'vendor_pay_to_changed';
      const ops = await connection.getAccountInfo(new PublicKey(usepodAta(USEPOD_OPS_WALLET)), 'finalized');
      if (
        !ops ||
        ops.owner.toBase58() !== TOKEN_PROGRAM ||
        ops.data.length < 165 ||
        new PublicKey(ops.data.subarray(0, 32)).toBase58() !== USEPOD_USDC_MINT ||
        new PublicKey(ops.data.subarray(32, 64)).toBase58() !== USEPOD_OPS_WALLET
      )
        return 'vendor_pay_to_changed';
      const ata = await connection.getAccountInfo(new PublicKey(usepodAta(wallet)), 'finalized');
      if (
        !ata ||
        ata.owner.toBase58() !== TOKEN_PROGRAM ||
        ata.data.length < 165 ||
        new PublicKey(ata.data.subarray(0, 32)).toBase58() !== USEPOD_USDC_MINT ||
        new PublicKey(ata.data.subarray(32, 64)).toBase58() !== wallet ||
        ata.data.readBigUInt64LE(64) < amount
      )
        return 'insufficient_usdc';
      return null;
    },
    feePayer: readUsepodFeePayer,
    solBalance: (wallet) => connection.getBalance(new PublicKey(wallet), 'finalized'),
    sponsoredToday: async () => Array.from(await db.execute<{ n: number }>(sponsoredTodaySql()))[0]?.n ?? 0,
    avatarSponsoredToday: async (avatarId) =>
      Array.from(await db.execute<{ n: number }>(sponsoredTodaySql(avatarId)))[0]?.n ?? 0,
    balance: readUsepodBalance,
    priorDeposit: (avatarId) => hasPriorUsepodDeposit(db, avatarId),
    admit,
    blockhash: () => connection.getLatestBlockhash('finalized'),
    sign: async (avatarId, transaction, terms) => {
      const row = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      });
      if (!row) throw new Error('wallet_missing');
      // Check the transaction against its terms before any key is decrypted.
      const shape = assertDepositTransaction(transaction, terms);
      const key = await decryptWalletRow(row);
      let feeKey: Keypair | null = null;
      try {
        if (shape.sponsored) feeKey = await loadUsepodFeePayerKeypair(shape.feePayer);
      } catch (err) {
        wipeKeypair(key);
        throw err;
      }
      // signDepositTransaction wipes both keys in every case.
      return signDepositTransaction(transaction, terms, key, feeKey);
    },
    simulate: async (bytes) =>
      (
        await connection.simulateTransaction(VersionedTransaction.deserialize(bytes), {
          sigVerify: true,
          commitment: 'finalized',
        })
      ).value.err === null,
    persist: async (id, signed, height, terms, input, approvalProven) =>
      db.transaction(async (tx) => {
        await lockSpendRules(tx, input.avatarId);
        const [policyRow] = await tx
          .select()
          .from(userSpendPolicies)
          .where(eq(userSpendPolicies.avatarId, input.avatarId))
          .limit(1);
        const policy = toSpendPolicyView(policyRow);
        const [settings] = await tx
          .select()
          .from(agentAiSettings)
          .where(eq(agentAiSettings.avatarId, input.avatarId))
          .limit(1);
        const totals = Array.from(
          await tx.execute<{ total: string }>(
            sql`SELECT COALESCE(SUM(usdc_atomic),0)::text AS total FROM vendor_spend_ledger WHERE avatar_id=${input.avatarId} AND status IN ('pending','paid','ambiguous') AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          ),
        );
        if (
          !settings?.usepodRegistered ||
          settings.usepodDepositCode !== terms.code ||
          !policy.configured ||
          !policy.allowedVendors.includes('usepod') ||
          policy.perCallCapUsdCents === null ||
          policy.dailyCapUsdCents === null ||
          input.amountCents > policy.perCallCapUsdCents ||
          BigInt(totals[0]?.total ?? '0') > BigInt(policy.dailyCapUsdCents) * 10000n ||
          (policy.requireApproval && (!approvalProven || input.actor === 'agent'))
        )
          return false;
        const rows = await tx
          .update(vendorSpendLedger)
          .set({
            payerSignature: signed.signature,
            signedTxB64: Buffer.from(signed.bytes).toString('base64'),
            lastValidBlockHeight: height,
            depositTerms: terms,
            signedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(vendorSpendLedger.id, id),
              eq(vendorSpendLedger.status, 'pending'),
              sql`${vendorSpendLedger.payerSignature} IS NULL`,
              sql`${vendorSpendLedger.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
            ),
          )
          .returning({ id: vendorSpendLedger.id });
        return rows.length === 1;
      }),
    send: async (bytes) => {
      await connection.sendRawTransaction(bytes, {
        skipPreflight: false,
        maxRetries: 3,
      });
    },
    proof: async (signature) => {
      const tx = await connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) return null;
      const msg = tx.transaction.message;
      const keys = msg.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      });
      return {
        finalized: true,
        err: tx.meta.err,
        fee: tx.meta.fee,
        signatures: tx.transaction.signatures,
        feePayer: keys.get(0)!.toBase58(),
        logs: tx.meta.logMessages ?? [],
        instructions: msg.compiledInstructions.map((ix) => ({
          programId: keys.get(ix.programIdIndex)!.toBase58(),
          data: ix.data,
          keys: ix.accountKeyIndexes.map((index) => ({
            pubkey: keys.get(index)!.toBase58(),
            isSigner: msg.isAccountSigner(index),
            isWritable: msg.isAccountWritable(index),
          })),
        })),
      };
    },
    signatureKnown: async (signature) =>
      (
        await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0] !== null,
    blockHeight: () => connection.getBlockHeight('finalized'),
    finish: async (id, status, fields) => {
      await db
        .update(vendorSpendLedger)
        .set({
          status,
          ...fields,
          // The mismatch marker survives every non-paid write, atomically in
          // SQL, so a stale concurrent writer cannot erase it (Codex round 3).
          ...(status !== 'paid' && 'failureReason' in fields
            ? {
                failureReason: sql`CASE WHEN failure_reason = ${FINALIZED_EVIDENCE_MISMATCH}::text THEN ${FINALIZED_EVIDENCE_MISMATCH}::text ELSE ${fields.failureReason ?? null}::text END`,
              }
            : {}),
          ...(status === 'paid'
            ? { reconcileAttempts: sql`CASE WHEN status <> 'paid' THEN 0 ELSE reconcile_attempts END` }
            : {}),
          ...(fields.creditStatus
            ? {
                creditStatus: sql`CASE WHEN credit_status = 'seen' THEN 'seen' ELSE ${fields.creditStatus} END`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendorSpendLedger.id, id),
            eq(vendorSpendLedger.vendor, 'usepod'),
            inArray(
              vendorSpendLedger.status,
              status === 'paid' ? ['pending', 'ambiguous', 'paid'] : ['pending', 'ambiguous'],
            ),
            // A row once seen finalized with no error never becomes 'failed'.
            ...(status === 'failed'
              ? [sql`${vendorSpendLedger.failureReason} IS DISTINCT FROM ${FINALIZED_EVIDENCE_MISMATCH}`]
              : []),
          ),
        );
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reconcileRows: async (includeExhausted = false) =>
      db
        .select()
        .from(vendorSpendLedger)
        .where(
          and(
            eq(vendorSpendLedger.vendor, 'usepod'),
            sql`(${vendorSpendLedger.status} IN ('pending','ambiguous') OR (${vendorSpendLedger.status} = 'paid' AND ${vendorSpendLedger.creditStatus} = 'unknown'))`,
            sql`${vendorSpendLedger.createdAt} < now() - interval '1 minute'`,
            ...(includeExhausted
              ? []
              : [
                  sql`(${vendorSpendLedger.status} <> 'paid' OR ${vendorSpendLedger.reconcileAttempts} < ${USEPOD_MAX_CREDIT_RECONCILE_ATTEMPTS})`,
                  sql`(${vendorSpendLedger.reconcileNextAt} IS NULL OR ${vendorSpendLedger.reconcileNextAt} <= now())`,
                ]),
          ),
        )
        .orderBy(asc(vendorSpendLedger.updatedAt), asc(vendorSpendLedger.id))
        .limit(100),
  };
}
function validInput(input: DepositInput): boolean {
  return (
    Number.isInteger(input.amountCents) &&
    input.amountCents >= OWN_AI_USEPOD_DEPOSIT_MIN_CENTS &&
    input.amountCents <= OWN_AI_USEPOD_DEPOSIT_MAX_CENTS &&
    /^[A-Za-z0-9_-]{1,64}$/.test(input.idempotencyKey)
  );
}
export async function createUsepodDepositChallenge(input: DepositInput) {
  if (!validInput(input) || !input.userId) return { ok: false as const, code: 'invalid_deposit' };
  const settings = await defaultDeps().settings(input.avatarId);
  if (!settings) return { ok: false as const, code: 'usepod_deposit_code_missing' };
  return {
    ok: true as const,
    ...issueUsepodDepositChallenge(input.userId, approvalTerms(input, settings)),
  };
}
export function usepodCreditSeen(baseline: number, amount: bigint, balance: Balance | null): boolean {
  const slack = amount / 100n > 2000n ? amount / 100n : 2000n;
  return balance !== null && BigInt(balance.usdcMicro) >= BigInt(baseline) + amount - slack;
}
async function credit(
  deps: UsepodDepositDeps,
  avatarId: string,
  terms: DepositTerms,
  poll: boolean,
): Promise<{ creditStatus: 'seen' | 'unknown'; balance: Balance | null }> {
  let balance: Balance | null = null;
  const deadline = Date.now() + 20000;
  for (let i = 0; i < (poll ? 11 : 1); i++) {
    if (i) await deps.sleep(2000);
    if (Date.now() >= deadline) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      balance = await Promise.race([
        deps.balance(avatarId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()));
          timer.unref?.();
        }),
      ]);
    } catch {
      /* Credit is separate from chain settlement. */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (usepodCreditSeen(terms.baselineMicro, BigInt(terms.amount), balance)) return { creditStatus: 'seen', balance };
  }
  return { creditStatus: 'unknown', balance };
}
/**
 * The balance before a deposit (credit baseline B0). UsePod answers 401
 * "token not found or not activated" for a registered token that never held a
 * balance; the first deposit activates it. So a rejected balance read counts as
 * B0 = 0 ONLY when this avatar has no usepod row that may have moved money. A
 * token that was funded before and is now rejected still refuses the deposit.
 * The deposit code (the money route) comes from the stored register reply.
 */
async function firstBalance(
  deps: UsepodDepositDeps,
  avatarId: string,
): Promise<{ balance: Balance | null; assumed: boolean }> {
  try {
    return { balance: await deps.balance(avatarId), assumed: false };
  } catch (err) {
    if (!(err instanceof OwnAiError) || err.code !== 'usepod_not_activated') throw err;
    if (await deps.priorDeposit(avatarId)) throw err;
    return { balance: { usdcMicro: 0, isActive: false }, assumed: true };
  }
}
/** Why the ClawVille fee wallet cannot pay now (null = it can). */
export type SponsorBlock = 'no_fee_wallet' | 'avatar_daily_limit' | 'daily_limit' | 'fee_wallet_empty';
/**
 * Can the ClawVille fee wallet pay the network fee for this avatar NOW? It
 * needs an active row, this avatar under USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY,
 * all avatars under USEPOD_SPONSORED_DEPOSITS_PER_DAY, and at least
 * USEPOD_FEE_WALLET_MIN_LAMPORTS (it stays rent exempt after the fee). Under
 * USEPOD_FEE_WALLET_LOW_LAMPORTS it logs a refill warning (public key and
 * lamports only). Errors propagate (the caller fails closed).
 */
export async function sponsorAvailability(
  deps: Pick<UsepodDepositDeps, 'feePayer' | 'solBalance' | 'sponsoredToday' | 'avatarSponsoredToday'>,
  avatarId: string,
): Promise<{ feePayer: string; block: null } | { feePayer: string | null; block: SponsorBlock }> {
  const sponsor = await deps.feePayer();
  if (!sponsor) return { feePayer: null, block: 'no_fee_wallet' };
  if ((await deps.avatarSponsoredToday(avatarId)) >= USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY)
    return { feePayer: sponsor, block: 'avatar_daily_limit' };
  if ((await deps.sponsoredToday()) >= USEPOD_SPONSORED_DEPOSITS_PER_DAY) return { feePayer: sponsor, block: 'daily_limit' };
  const lamports = await deps.solBalance(sponsor);
  if (lamports < USEPOD_FEE_WALLET_LOW_LAMPORTS)
    console.warn(`[usepod-fee-payer] fee wallet ${sponsor} is low: ${lamports} lamports. Refill it.`);
  if (lamports < USEPOD_FEE_WALLET_MIN_LAMPORTS) return { feePayer: sponsor, block: 'fee_wallet_empty' };
  return { feePayer: sponsor, block: null };
}
const SPONSOR_BLOCK_CODES: Record<SponsorBlock, string> = {
  no_fee_wallet: 'needs_sol_for_fee',
  avatar_daily_limit: 'fee_sponsor_avatar_daily_limit',
  daily_limit: 'fee_sponsor_daily_limit',
  fee_wallet_empty: 'fee_wallet_empty',
};
/**
 * Who pays the network fee. The ClawVille fee wallet pays when
 * sponsorAvailability says it can. Otherwise the avatar wallet pays if it holds
 * OWN_AI_USEPOD_MIN_SOL_LAMPORTS (the behaviour before 2026-11-11). Else a clear
 * refusal: fee_wallet_empty, fee_sponsor_avatar_daily_limit,
 * fee_sponsor_daily_limit or needs_sol_for_fee. The avatar SOL is always read,
 * so admission can fall back to the avatar wallet when a cap fills in a race.
 */
export async function chooseFeePayer(
  deps: Pick<UsepodDepositDeps, 'feePayer' | 'solBalance' | 'sponsoredToday' | 'avatarSponsoredToday'>,
  avatarId: string,
  depositor: string,
): Promise<{ ok: true; feePayer: string | null; avatarCanPay: boolean } | { ok: false; code: string }> {
  const avatarCanPay = (await deps.solBalance(depositor)) >= OWN_AI_USEPOD_MIN_SOL_LAMPORTS;
  const availability = await sponsorAvailability(deps, avatarId);
  if (availability.block === null && availability.feePayer !== depositor)
    return { ok: true, feePayer: availability.feePayer, avatarCanPay };
  if (avatarCanPay) return { ok: true, feePayer: null, avatarCanPay };
  return { ok: false, code: availability.block === null ? 'needs_sol_for_fee' : SPONSOR_BLOCK_CODES[availability.block] };
}
/**
 * GET /api/agent-ai/usepod/fee: can ClawVille pay the network fee for this
 * avatar's next deposit NOW. Human and agent sessions read the same answer.
 * A read error answers `sponsored: false` with reason `unavailable`.
 */
export async function readUsepodFeeStatus(
  avatarId: string,
  overrides: Partial<UsepodDepositDeps> = {},
): Promise<{
  sponsored: boolean;
  reason: SponsorBlock | 'unavailable' | null;
  avatarSponsoredToday: number | null;
  sponsoredPerAvatarPerDay: number;
  avatarMinSolLamports: number;
}> {
  const base = {
    sponsoredPerAvatarPerDay: USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY,
    avatarMinSolLamports: OWN_AI_USEPOD_MIN_SOL_LAMPORTS,
  };
  try {
    const deps = { ...defaultDeps(), ...overrides };
    const availability = await sponsorAvailability(deps, avatarId);
    const avatarSponsoredToday = availability.feePayer ? await deps.avatarSponsoredToday(avatarId) : 0;
    return { sponsored: availability.block === null, reason: availability.block, avatarSponsoredToday, ...base };
  } catch {
    return { sponsored: false, reason: 'unavailable', avatarSponsoredToday: null, ...base };
  }
}
export async function depositUsepod(
  input: DepositInput,
  overrides: Partial<UsepodDepositDeps> = {},
): Promise<DepositResult> {
  if (!validInput(input)) return { ok: false, code: 'invalid_deposit' };
  const deps = { ...defaultDeps(), ...overrides };
  const replay = await deps.replay(input);
  if (replay) return replay;
  const policyRefusal = await deps.policyPrecheck(input);
  if (policyRefusal) return { ok: false, code: policyRefusal };
  let settings: DepositSettings | null;
  let baseline: Balance | null;
  let assumedBaseline: boolean;
  let sponsor: Sponsorship | null;
  try {
    settings = await deps.settings(input.avatarId);
    if (!settings) return { ok: false, code: 'usepod_deposit_code_missing' };
    const refusal = await deps.precheck(settings.wallet, BigInt(input.amountCents) * 10000n);
    if (refusal) return { ok: false, code: refusal };
    const payer = await chooseFeePayer(deps, input.avatarId, settings.wallet);
    if (!payer.ok) return { ok: false, code: payer.code };
    sponsor = payer.feePayer ? { feePayer: payer.feePayer, avatarCanPay: payer.avatarCanPay } : null;
    ({ balance: baseline, assumed: assumedBaseline } = await firstBalance(deps, input.avatarId));
    if (!baseline) return { ok: false, code: 'provider_error' };
  } catch {
    return { ok: false, code: 'provider_error' };
  }
  const admitted = await deps.admit(input, settings, assumedBaseline, sponsor);
  if (!admitted.ok) return admitted.code === 'duplicate_request' ? ((await deps.replay(input)) ?? admitted) : admitted;
  const ledgerId = admitted.ledgerId;
  // Admission may fall back to the avatar wallet at a cap; it never adds a sponsor.
  const feePayer = admitted.feePayer === undefined ? (sponsor?.feePayer ?? null) : admitted.feePayer;
  if (feePayer !== null && feePayer !== sponsor?.feePayer) {
    await deps.finish(ledgerId, 'failed', { failureReason: 'not_sent_prepare_failed' });
    return { ok: false, code: 'payment_prepare_failed', ledgerId };
  }
  const terms: DepositTerms = {
    code: settings.code,
    amount: String(input.amountCents * 10000),
    depositor: settings.wallet,
    ledgerId,
    baselineMicro: baseline.usdcMicro,
    ...(feePayer ? { feePayer } : {}),
  };
  const feePaidBy = feePayer ? ('clawville' as const) : ('avatar' as const);
  let signed: { bytes: Uint8Array; signature: string };
  try {
    const hash = await deps.blockhash();
    signed = await deps.sign(input.avatarId, buildDepositTransaction(terms, hash.blockhash), terms);
    if (!(await deps.simulate(signed.bytes))) {
      await deps.finish(ledgerId, 'failed', {
        failureReason: 'not_sent_simulation_failed',
      });
      return { ok: false, code: 'simulation_failed', ledgerId };
    }
    if (
      !(await deps.persist(ledgerId, signed, hash.lastValidBlockHeight, terms, input, admitted.approvalProven === true))
    ) {
      await deps.finish(ledgerId, 'failed', {
        failureReason: 'not_sent_payment_fenced',
      });
      return { ok: false, code: 'payment_fenced', ledgerId };
    }
  } catch {
    await deps.finish(ledgerId, 'failed', {
      failureReason: 'not_sent_prepare_failed',
    });
    return { ok: false, code: 'payment_prepare_failed', ledgerId };
  }
  let proof: DepositProof | null = null;
  try {
    await deps.send(signed.bytes);
    for (let i = 0; i < 11; i++) {
      if (i) await deps.sleep(2000);
      proof = await deps.proof(signed.signature);
      if (proof?.finalized) break;
    }
  } catch {
    /* A send timeout never proves no transfer. */
  }
  if (proof?.finalized && proof.err !== null) {
    await deps.finish(ledgerId, 'failed', {
      feeLamports: proof.fee,
      failureReason: 'onchain_error_finalized',
      txSignature: signed.signature,
    });
    return {
      ok: true,
      ledgerId,
      status: 'failed',
      txSignature: signed.signature,
      usdCents: input.amountCents,
      creditStatus: 'unknown',
      balance: null,
      feePaidBy,
    };
  }
  const paid = checkDepositProof(proof, terms, signed.signature);
  await deps.finish(ledgerId, paid ? 'paid' : 'ambiguous', {
    txSignature: signed.signature,
    ...(proof ? { feeLamports: proof.fee } : {}),
    failureReason: paid ? null : proof?.finalized ? FINALIZED_EVIDENCE_MISMATCH : 'finalized_proof_missing',
  });
  const credited = paid
    ? await credit(deps, input.avatarId, terms, true)
    : { creditStatus: 'unknown' as const, balance: null };
  if (paid)
    await deps.finish(ledgerId, 'paid', {
      creditStatus: credited.creditStatus,
    });
  return {
    ok: true,
    ledgerId,
    status: paid ? 'paid' : 'ambiguous',
    txSignature: signed.signature,
    usdCents: input.amountCents,
    ...credited,
    feePaidBy,
  };
}
export async function reconcileUsepodDeposits(
  options: { apply: boolean; includeExhausted?: boolean; deps?: Partial<UsepodDepositDeps> } = {
    apply: false,
  },
) {
  const deps = { ...defaultDeps(), ...options.deps };
  const decisions: {
    id: string;
    status: string;
    creditStatus?: string;
    operatorReview?: boolean;
  }[] = [];
  for (const row of await deps.reconcileRows(options.includeExhausted)) {
    if (
      !options.includeExhausted &&
      row.status === 'paid' &&
      (row.reconcileAttempts ?? 0) >= USEPOD_MAX_CREDIT_RECONCILE_ATTEMPTS
    ) {
      decisions.push({
        id: row.id,
        status: 'paid',
        creditStatus: row.creditStatus ?? 'unknown',
        operatorReview: row.creditStatus === 'unknown' && Date.now() - row.createdAt.getTime() > 600000,
      });
      continue;
    }
    try {
      const terms = row.depositTerms as DepositTerms | null;
      if (!row.payerSignature) {
        let closed = false;
        if (options.apply) {
          if (Date.now() - row.createdAt.getTime() > 600000) closed = await deps.closeUnsigned(row.id);
          await deps.deferReconcile(row.id);
        }
        decisions.push({ id: row.id, status: closed ? 'failed' : row.status });
        continue;
      }
      if (!terms || row.lastValidBlockHeight === null) {
        if (options.apply) await deps.deferReconcile(row.id);
        decisions.push({ id: row.id, status: row.status });
        continue;
      }
      // The ledger column and the signed terms must name the same fee payer.
      // A difference is never settled automatically: ambiguous, for the operator.
      if ((row.feePayer ?? null) !== (terms.feePayer ?? null)) {
        if (options.apply && row.status !== 'paid') {
          await deps.finish(row.id, 'ambiguous', { failureReason: FEE_PAYER_MISMATCH });
          await deps.deferReconcile(row.id);
        }
        decisions.push({ id: row.id, status: row.status === 'paid' ? 'paid' : 'ambiguous', operatorReview: true });
        continue;
      }
      // Finalized settlement is immutable. Paid rows need only a credit read.
      const proof = row.status === 'paid' ? null : await deps.proof(row.payerSignature);
      let status: 'paid' | 'failed' | 'ambiguous' = row.status === 'paid' ? 'paid' : 'ambiguous';
      // Keep the sticky marker on every write of this row.
      let reason: string | null = row.failureReason === FINALIZED_EVIDENCE_MISMATCH ? FINALIZED_EVIDENCE_MISMATCH : null;
      if (proof?.finalized && proof.err !== null) {
        status = 'failed';
        reason = 'onchain_error_finalized';
      } else if (checkDepositProof(proof, terms, row.payerSignature)) {
        status = 'paid';
        reason = null;
      } else if (proof?.finalized) {
        // Finalized with no error, but the evidence does not match: USDC may
        // have moved. The row stays 'ambiguous' for an operator, for ever.
        reason = FINALIZED_EVIDENCE_MISMATCH;
      }
      // Only a tx that the chain never showed as finalized may expire to 'failed'.
      else if (
        row.status !== 'paid' &&
        proof === null &&
        reason !== FINALIZED_EVIDENCE_MISMATCH &&
        (await deps.blockHeight()) > row.lastValidBlockHeight &&
        !(await deps.signatureKnown(row.payerSignature))
      ) {
        status = 'failed';
        reason = 'expired_signature_unknown';
      }
      const credited =
        status === 'paid'
          ? await credit(deps, row.avatarId, terms, false)
          : { creditStatus: 'unknown' as const, balance: null };
      if (options.apply)
        await deps.finish(row.id, status, {
          failureReason: reason,
          creditStatus: credited.creditStatus,
          ...(proof ? { feeLamports: proof.fee } : {}),
          ...(status === 'paid' ? { txSignature: row.payerSignature } : {}),
        });
      if (options.apply && (status === 'ambiguous' || (status === 'paid' && credited.creditStatus === 'unknown')))
        await deps.deferReconcile(row.id);
      decisions.push({
        id: row.id,
        status,
        creditStatus: credited.creditStatus,
        operatorReview:
          status === 'paid' && credited.creditStatus === 'unknown' && Date.now() - row.createdAt.getTime() > 600000,
      });
    } catch {
      if (options.apply) await deps.deferReconcile(row.id).catch(() => {});
      decisions.push({ id: row.id, status: row.status });
    }
  }
  return decisions;
}
