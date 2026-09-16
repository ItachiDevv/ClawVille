import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Connection } from '@solana/web3.js';
import {
  agentBots,
  and,
  avatars,
  db,
  eq,
  isNull,
  sql,
  tradingWallets,
  users,
  wallets,
} from '@clawville/database';
import type { TradingSubject } from './trading-wallet-challenge';
import {
  buildTradingWalletMessage,
  consumeTradingWalletChallenge,
  tradingSubjectKey,
} from './trading-wallet-challenge';

export type TradingWalletSource = 'linked' | 'clawpump' | 'custodial' | 'signed';
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface BoundTradingWallet {
  id: string; pubkey: string; source: TradingWalletSource;
  subjectKind: 'avatar' | 'agent'; userId: string; avatarId: string; agentId: string | null;
  boundAt: Date; boundSlot: number; cursorSignature: string | null;
  cursorBlockTime: number | null; lastPolledAt: Date | null; operatedByClawville: boolean;
}

export const MAX_TRADING_WALLETS_PER_SUBJECT = 5;

export class TradingWalletError extends Error {
  constructor(message: string, readonly code:
    | 'wallet_already_bound' | 'wallet_limit_reached' | 'invalid_wallet_pubkey'
    | 'invalid_or_expired_challenge' | 'signature_verification_failed'
    | 'no_linked_wallet' | 'linked_wallet_is_human_only' | 'no_custodial_wallet'
    | 'wallet_not_found', readonly status: 400 | 401 | 403 | 404 | 409) {
    super(message);
  }
}

function rowToBound(row: typeof tradingWallets.$inferSelect): BoundTradingWallet {
  return {
    id: row.id, pubkey: row.pubkey, source: row.source as TradingWalletSource,
    subjectKind: row.subjectKind as 'avatar' | 'agent', userId: row.userId,
    avatarId: row.avatarId, agentId: row.agentId, boundAt: row.boundAt,
    boundSlot: row.boundSlot, cursorSignature: row.cursorSignature,
    cursorBlockTime: row.cursorBlockTime, lastPolledAt: row.lastPolledAt,
    operatedByClawville: row.operatedByClawville,
  };
}

function validatePubkey(pubkey: string): Uint8Array {
  try {
    const decoded = bs58.decode(pubkey);
    if (decoded.length !== 32) throw new Error('bad length');
    return decoded;
  } catch {
    throw new TradingWalletError('Invalid Solana wallet public key.', 'invalid_wallet_pubkey', 400);
  }
}

export async function currentBindSlot(): Promise<number> {
  const { tradeObserverRpcUrl } = await import('./trade-observer');
  const connection = new Connection(tradeObserverRpcUrl(), 'confirmed');
  try {
    return await connection.getSlot('confirmed');
  } catch {
    throw new Error('Trading wallet bind slot is unavailable.');
  }
}

export async function resolveBoundTradingWallets(filter:
  | { scope: 'subject'; subject: TradingSubject }
  | { scope: 'all' },
): Promise<BoundTradingWallet[]> {
  const rows = filter.scope === 'all'
    ? await db.select().from(tradingWallets).where(isNull(tradingWallets.revokedAt)).orderBy(tradingWallets.boundAt)
    : await db.select().from(tradingWallets).where(and(eq(tradingWallets.avatarId, filter.subject.avatarId), isNull(tradingWallets.revokedAt))).orderBy(tradingWallets.boundAt);
  return rows.map(rowToBound);
}

export async function resolveWritableTradingWallet(input: {
  subject: TradingSubject; walletPubkey: string;
}): Promise<BoundTradingWallet | null> {
  const exact = input.subject.kind === 'agent'
    ? and(eq(tradingWallets.pubkey, input.walletPubkey), eq(tradingWallets.subjectKind, 'agent'), eq(tradingWallets.agentId, input.subject.agentId!), isNull(tradingWallets.revokedAt))
    : and(eq(tradingWallets.pubkey, input.walletPubkey), eq(tradingWallets.subjectKind, 'avatar'), eq(tradingWallets.avatarId, input.subject.avatarId), isNull(tradingWallets.agentId), isNull(tradingWallets.revokedAt));
  const rows = await db.select().from(tradingWallets).where(exact).limit(1);
  return rows[0] ? rowToBound(rows[0]) : null;
}

async function bindWithExecutor(input: {
  subject: TradingSubject; walletPubkey: string; source: TradingWalletSource;
  operatedByClawville?: boolean; metadata?: Record<string, unknown>; tx: DbExecutor;
  boundSlot?: number;
}): Promise<BoundTradingWallet> {
  validatePubkey(input.walletPubkey);
  const existing = await input.tx.select().from(tradingWallets)
    .where(and(eq(tradingWallets.pubkey, input.walletPubkey), isNull(tradingWallets.revokedAt))).limit(1);
  if (existing[0]) {
    if (existing[0].avatarId === input.subject.avatarId) return rowToBound(existing[0]);
    throw new TradingWalletError('This wallet is already bound.', 'wallet_already_bound', 409);
  }
  const active = await input.tx.select({ id: tradingWallets.id }).from(tradingWallets)
    .where(and(eq(tradingWallets.avatarId, input.subject.avatarId), isNull(tradingWallets.revokedAt)));
  if (active.length >= MAX_TRADING_WALLETS_PER_SUBJECT) {
    throw new TradingWalletError('The trading wallet limit is reached.', 'wallet_limit_reached', 409);
  }
  const boundSlot = input.boundSlot ?? await currentBindSlot();
  const inserted = await input.tx.insert(tradingWallets).values({
    subjectKind: input.subject.kind,
    userId: input.subject.userId,
    avatarId: input.subject.avatarId,
    agentId: input.subject.kind === 'agent' ? input.subject.agentId : null,
    pubkey: input.walletPubkey,
    source: input.source,
    operatedByClawville: input.operatedByClawville ?? false,
    metadata: input.metadata,
    boundSlot,
  }).returning();
  if (!inserted[0]) throw new Error('trading wallet insert returned no row');
  return rowToBound(inserted[0]);
}

async function bindWithLock(input: Omit<Parameters<typeof bindWithExecutor>[0], 'tx'>): Promise<BoundTradingWallet> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${input.subject.avatarId}`}, 0))`);
      return bindWithExecutor({ ...input, tx });
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') throw new TradingWalletError('This wallet is already bound.', 'wallet_already_bound', 409);
    throw error;
  }
}

export async function bindTradingWalletBySignature(input: {
  subject: TradingSubject; walletPubkey: string; nonce: string; signature: string;
}): Promise<BoundTradingWallet> {
  const publicKey = validatePubkey(input.walletPubkey);
  const subjectKey = tradingSubjectKey(input.subject);
  if (!consumeTradingWalletChallenge(input.nonce, subjectKey, input.walletPubkey)) {
    throw new TradingWalletError('The wallet challenge is invalid or expired.', 'invalid_or_expired_challenge', 401);
  }
  let signature: Uint8Array;
  try { signature = bs58.decode(input.signature); } catch { signature = new Uint8Array(); }
  const message = new TextEncoder().encode(buildTradingWalletMessage(subjectKey, input.walletPubkey, input.nonce));
  if (signature.length !== 64 || !nacl.sign.detached.verify(message, signature, publicKey)) {
    throw new TradingWalletError('The wallet signature is invalid.', 'signature_verification_failed', 401);
  }
  return bindWithLock({ subject: input.subject, walletPubkey: input.walletPubkey, source: 'signed' });
}

export async function bindLinkedTradingWallet(subject: TradingSubject): Promise<BoundTradingWallet> {
  if (subject.kind === 'agent') throw new TradingWalletError('Linked wallets are human only.', 'linked_wallet_is_human_only', 403);
  const rows = await db.select({ pubkey: users.linkedWalletPubkey }).from(users).where(eq(users.id, subject.userId)).limit(1);
  if (!rows[0]?.pubkey) throw new TradingWalletError('No linked wallet is available.', 'no_linked_wallet', 409);
  return bindWithLock({ subject, walletPubkey: rows[0].pubkey, source: 'linked' });
}

export async function bindCustodialTradingWallet(input: {
  subject: TradingSubject; operatedByClawville?: boolean; tx?: DbExecutor;
}): Promise<BoundTradingWallet> {
  const executor = input.tx ?? db;
  let rows = await executor.select({ publicKey: wallets.publicKey }).from(wallets)
    .where(and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, input.subject.avatarId), eq(wallets.custodyVerified, true))).limit(1);
  if (!rows[0] && input.subject.kind === 'agent' && input.subject.agentId) {
    const bot = await executor.select({ id: agentBots.id }).from(agentBots).where(eq(agentBots.agentId, input.subject.agentId)).limit(1);
    if (bot[0]) rows = await executor.select({ publicKey: wallets.publicKey }).from(wallets)
      .where(and(eq(wallets.subjectType, 'agent'), eq(wallets.subjectId, bot[0].id), eq(wallets.custodyVerified, true))).limit(1);
  }
  if (!rows[0]) throw new TradingWalletError('No verified custodial wallet is available.', 'no_custodial_wallet', 409);
  return bindWithExecutor({ subject: input.subject, walletPubkey: rows[0].publicKey, source: 'custodial',
    operatedByClawville: input.operatedByClawville, tx: input.tx ?? db });
}

export async function bindClawPumpTradingWallet(input: {
  subject: TradingSubject; walletPubkey: string; clawpumpAgentId: string;
  operatedByClawville?: boolean; tx?: DbExecutor;
}): Promise<BoundTradingWallet> {
  return bindWithExecutor({ subject: input.subject, walletPubkey: input.walletPubkey, source: 'clawpump',
    operatedByClawville: input.operatedByClawville ?? true, metadata: { clawpumpAgentId: input.clawpumpAgentId }, tx: input.tx ?? db });
}

export async function revokeTradingWallet(input: { subject: TradingSubject; walletPubkey: string }): Promise<void> {
  const owned = await resolveWritableTradingWallet(input);
  if (!owned) {
    const exact = input.subject.kind === 'agent'
      ? and(eq(tradingWallets.pubkey, input.walletPubkey), eq(tradingWallets.subjectKind, 'agent'), eq(tradingWallets.agentId, input.subject.agentId!))
      : and(eq(tradingWallets.pubkey, input.walletPubkey), eq(tradingWallets.subjectKind, 'avatar'), eq(tradingWallets.avatarId, input.subject.avatarId), isNull(tradingWallets.agentId));
    const historical = await db.select({ revokedAt: tradingWallets.revokedAt }).from(tradingWallets).where(exact).limit(1);
    if (historical[0]?.revokedAt) return;
    throw new TradingWalletError('The trading wallet was not found.', 'wallet_not_found', 404);
  }
  await db.update(tradingWallets).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(tradingWallets.id, owned.id));
}

export async function syncLinkedTradingWallet(input: { userId: string; newPubkey: string; tx: DbExecutor }): Promise<void> {
  let existing = await input.tx.select().from(tradingWallets)
    .where(and(eq(tradingWallets.userId, input.userId), eq(tradingWallets.source, 'linked'), isNull(tradingWallets.revokedAt))).limit(1);
  if (!existing[0]) return;
  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${existing[0].avatarId}`}, 0))`);
  existing = await input.tx.select().from(tradingWallets)
    .where(and(eq(tradingWallets.userId, input.userId), eq(tradingWallets.source, 'linked'), isNull(tradingWallets.revokedAt))).limit(1);
  if (!existing[0]) return;
  await input.tx.update(tradingWallets).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(tradingWallets.id, existing[0].id));
  await bindWithExecutor({
    subject: { kind: 'avatar', userId: existing[0].userId, avatarId: existing[0].avatarId, agentId: null },
    walletPubkey: input.newPubkey, source: 'linked', tx: input.tx,
  });
}

export async function advanceTradingWalletCursor(input: {
  walletId: string; expectedCursorSignature: string | null;
  signature: string; slot: number; blockTime: number | null;
}): Promise<boolean> {
  const rows = await db.update(tradingWallets).set({
    cursorSignature: input.signature, cursorBlockTime: input.blockTime,
    lastPolledAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(tradingWallets.id, input.walletId), sql`${tradingWallets.cursorSignature} IS NOT DISTINCT FROM ${input.expectedCursorSignature}`)).returning({ id: tradingWallets.id });
  return rows.length === 1;
}

export async function withTradingWalletLease<T>(walletId: string, fn: () => Promise<T>): Promise<T | 'lease_unavailable'> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`trading-wallet:${walletId}`}, 0)) AS acquired`);
    const acquired = Array.isArray(lock) ? Boolean((lock[0] as { acquired?: boolean } | undefined)?.acquired) : false;
    if (!acquired) return 'lease_unavailable';
    return fn();
  });
}
