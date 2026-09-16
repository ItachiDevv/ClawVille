import { and, clawpumpAgentLinks, db, eq, isNull, sql, tradingWallets, wallets } from '@clawville/database';
import type { TradingBaselineEvidence, TradingLink } from '@clawville/database';
import type { TradingSubject } from './trading-wallet-challenge';
import { withKeyedMutex } from './keyed-mutex';

export async function readTradingLink(avatarId: string): Promise<TradingLink | null> {
  return (await db.query.clawpumpAgentLinks.findFirst({ where: eq(clawpumpAgentLinks.avatarId, avatarId) })) ?? null;
}

export async function readTradingLinkForUpdate(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  avatarId: string,
): Promise<TradingLink | null> {
  const rows = await tx.select().from(clawpumpAgentLinks).where(eq(clawpumpAgentLinks.avatarId, avatarId)).for('update').limit(1);
  return rows[0] ?? null;
}

export function tradingSubjectFromLink(link: TradingLink): TradingSubject {
  if (!link.clawvilleAgentId) throw new Error('trading link has no bound ClawVille agent');
  return { kind: 'agent', userId: link.userId, avatarId: link.avatarId, agentId: link.clawvilleAgentId };
}

export async function resolveTradingCustody(link: TradingLink) {
  const agentId = link.clawvilleAgentId;
  if (!agentId) return null;
  const wallet = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, link.avatarId)),
  });
  if (!wallet || wallet.publicKey !== link.walletPubkey || wallet.custodyVerified !== true) return null;
  const binding = await db.query.tradingWallets.findFirst({
    where: and(
      eq(tradingWallets.avatarId, link.avatarId),
      eq(tradingWallets.agentId, agentId),
      eq(tradingWallets.pubkey, link.walletPubkey),
      eq(tradingWallets.source, 'custodial'),
      isNull(tradingWallets.revokedAt),
    ),
  });
  return binding ? { wallet, binding } : null;
}

export async function armTradingLink(input: {
  avatarId: string;
  equityUsdMicros: bigint;
  nativeLamports: bigint;
  baselineSlot: number;
  baselineEvidence: TradingBaselineEvidence;
}): Promise<TradingLink | null> {
  if (input.equityUsdMicros <= 0n) return null;
  return withKeyedMutex('trading:fleet', () => withKeyedMutex(`trading:${input.avatarId}`, () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${input.avatarId}`}, 0))`);
    const rows = await tx.update(clawpumpAgentLinks).set({
      floatStartUsdMicros: input.equityUsdMicros.toString(),
      floatStartLamports: input.nativeLamports.toString(),
      baselineSlot: input.baselineSlot,
      baselineEvidence: input.baselineEvidence,
      armed: true,
      killed: false,
      updatedAt: new Date(),
    }).where(and(eq(clawpumpAgentLinks.avatarId, input.avatarId), eq(clawpumpAgentLinks.armed, false))).returning();
    return rows[0] ?? null;
  })));
}

export async function killTradingLink(avatarId: string): Promise<TradingLink | null> {
  return withKeyedMutex('trading:fleet', () => withKeyedMutex(`trading:${avatarId}`, () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${avatarId}`}, 0))`);
    const rows = await tx.update(clawpumpAgentLinks).set({ killed: true, updatedAt: new Date() })
      .where(eq(clawpumpAgentLinks.avatarId, avatarId)).returning();
    return rows[0] ?? null;
  })));
}
