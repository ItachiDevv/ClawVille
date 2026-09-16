import {
  AddressLookupTableAccount,
  Connection,
  MessageV0,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { ZodError } from 'zod';
import {
  and,
  avatars,
  clawpumpAgentLinks,
  db,
  desc,
  eq,
  isNull,
  lt,
  sql,
  tradingDecisions,
  tradingHalts,
  tradingUsdcReservations,
} from '@clawville/database';
import { readTradingLimits, TRADE_MINTS, type TradeRefusalCode } from '@clawville/shared';
import { withKeyedMutex } from './keyed-mutex';
import {
  admitTrade,
  inspectTradePreconditions,
  recordTradeOutcome,
  recordTradeRefusal,
  type TradeIntent,
  type TradingGuardrailDeps,
} from './trading-guardrails';
import { buildTradingSwapTransaction, fetchTradingQuote } from './trading-jupiter';
import { deriveTradingAta } from './trading-mint-info';
import {
  inspectTradingSwapTransaction,
  validateTradingSwapSimulation,
  type SwapLeg,
  type SwapShape,
} from './trading-swap-validator';
import {
  loadTradingKeypair,
  sendSignedTradingSwap,
  signTradingSwap,
  type SignAndSendOutcome,
  type TradingSignerDeps,
} from './trading-signer';
import { resolveTradingCustody } from './trading-links';
import { buildTradeDecisionFrame, publishTradeDecision } from './trading-decision-feed';
import { ingestTradeSignature, lookupVerifiedTrade } from './trade-observer';
import { alertError } from './alert-error';

export interface ExecuteTradeResult {
  kind: 'submitted' | 'executed' | 'refused' | 'failed' | 'reconcile';
  decisionId: string | null;
  code: TradeRefusalCode | null;
  detail: string | null;
  signature: string | null;
}

export interface TradingExecutionDeps extends TradingGuardrailDeps, TradingSignerDeps {
  fetchImpl?: typeof fetch;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

function defaultConnection(): Connection {
  const endpoint = process.env.HELIUS_RPC_URL;
  if (!endpoint) throw new Error('[trading-floor] RPC is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().includes('mainnet')) throw new Error('[trading-floor] Helius RPC is not a mainnet endpoint');
  return new Connection(endpoint, 'confirmed');
}

async function resolveLookups(transaction: VersionedTransaction, connection: Connection): Promise<AddressLookupTableAccount[]> {
  if (transaction.message.version !== 0) throw new Error('message_not_v0');
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of (transaction.message as MessageV0).addressTableLookups) {
    const result = await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'confirmed' });
    if (!result.value) throw new Error('lookup_table_missing');
    tables.push(result.value);
  }
  return tables;
}

async function publishDecisionId(decisionId: string): Promise<void> {
  const rows = await db.select({
    row: tradingDecisions,
    avatarName: avatars.name,
    agentId: clawpumpAgentLinks.clawvilleAgentId,
    operated: clawpumpAgentLinks.operatedByClawville,
  })
    .from(tradingDecisions)
    .innerJoin(avatars, eq(avatars.id, tradingDecisions.avatarId))
    .leftJoin(clawpumpAgentLinks, eq(clawpumpAgentLinks.avatarId, tradingDecisions.avatarId))
    .where(eq(tradingDecisions.id, decisionId)).limit(1);
  const found = rows[0];
  if (found?.row.status === 'reconcile') return;
  if (found) publishTradeDecision(buildTradeDecisionFrame({
    row: found.row,
    agentId: found.agentId,
    avatarName: found.avatarName,
    operatedByClawville: found.operated ?? false,
  }));
}

async function refuse(intent: TradeIntent, code: TradeRefusalCode, detail: string): Promise<ExecuteTradeResult> {
  const verdict = await recordTradeRefusal(intent, code, detail);
  if (verdict.kind === 'refuse') await publishDecisionId(verdict.decisionId);
  return { kind: 'refused', decisionId: verdict.kind === 'refuse' ? verdict.decisionId : null, code, detail, signature: null };
}

export async function executeTrade(intent: TradeIntent, deps: TradingExecutionDeps = {}): Promise<ExecuteTradeResult> {
  const pre = await inspectTradePreconditions(intent, deps);
  if (pre.kind !== 'continue') {
    await publishDecisionId(pre.decisionId);
    return { kind: 'refused', decisionId: pre.decisionId, code: pre.code, detail: pre.detail, signature: null };
  }

  const admission = await admitTrade(intent, deps);
  if (admission.kind === 'refuse') {
    await publishDecisionId(admission.decisionId);
    return { kind: 'refused', decisionId: admission.decisionId, code: admission.code, detail: admission.detail, signature: null };
  }
  const { decisionId, link, amountAtomic, inputInfo, outputInfo, slippageBps } = admission.admission;
  const connection = deps.connection ?? defaultConnection();
  let quote;
  try {
    quote = await fetchTradingQuote({ inputMint: intent.inputMint, outputMint: intent.outputMint, amountAtomic, slippageBps, fetchImpl: deps.fetchImpl });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'quote failed';
    const code: TradeRefusalCode = error instanceof ZodError
      ? 'quote_schema_invalid'
      : detail.includes('route') ? 'route_discontinuous' : 'quote_failed';
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: code, errorDetail: detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code, detail, signature: null };
  }
  if (quote.priceImpactPct > readTradingLimits().maxQuoteImpactPct) {
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: 'quote_impact_above_cap', errorDetail: 'Quoted price impact exceeds the cap.', expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'quote_impact_above_cap', detail: 'Quoted price impact exceeds the cap.', signature: null };
  }

  let built;
  let lookupTables: AddressLookupTableAccount[];
  try {
    built = await buildTradingSwapTransaction({ quote, userPublicKey: link.walletPubkey, maxPriorityFeeLamports: readTradingLimits().maxPriorityFeeLamports, fetchImpl: deps.fetchImpl });
    lookupTables = deps.addressLookupTableAccounts ?? await resolveLookups(built.transaction, connection);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'build failed';
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: 'tx_binding_failed', errorDetail: detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'tx_binding_failed', detail, signature: null };
  }
  const minimumOut = (quote.outAmount * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
  const wallet = new PublicKey(link.walletPubkey);
  const inputMode = intent.inputMint === TRADE_MINTS.WSOL ? 'native-sol' : 'token';
  const outputMode = intent.outputMint === TRADE_MINTS.WSOL ? 'native-sol' : 'token';
  const shape: SwapShape = inputMode === 'native-sol' ? 'sol-token' : outputMode === 'native-sol' ? 'token-sol' : 'token-token';
  const inputLeg: SwapLeg = { mint: new PublicKey(intent.inputMint), tokenProgram: inputInfo.programId, ata: deriveTradingAta(wallet, inputInfo), mode: inputMode, direction: 'debit' };
  const outputLeg: SwapLeg = { mint: new PublicKey(intent.outputMint), tokenProgram: outputInfo.programId, ata: deriveTradingAta(wallet, outputInfo), mode: outputMode, direction: 'credit' };
  const inspection = inspectTradingSwapTransaction({ transaction: built.transaction, wallet, inputAmount: amountAtomic, minimumOutAmount: minimumOut, priorityFeeLamports: readTradingLimits().maxPriorityFeeLamports, addressLookupTableAccounts: lookupTables });
  if (!inspection.ok) {
    const code: TradeRefusalCode = inspection.detail === 'minimum_out_mismatch' ? 'min_out_below_admitted' : 'tx_binding_failed';
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: code, errorDetail: inspection.detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code, detail: inspection.detail, signature: null };
  }
  const simulation = await validateTradingSwapSimulation({
    transaction: built.transaction, wallet, connection, inputLeg, outputLeg, shape, inputAmount: amountAtomic,
    minimumOutAmount: minimumOut, priorityFeeLamports: inspection.priorityFeeLamports,
    transactionDerivedWsolAccounts: inspection.derivedWsolAccounts, addressLookupTableAccounts: lookupTables,
  });
  if (!simulation.ok) {
    const legFailures = new Set(['leg_direction', 'duplicate_mint', 'shape_mismatch', 'native_leg_mismatch', 'token_program', 'ata_mismatch']);
    const code: TradeRefusalCode = simulation.detail === 'sol_sol'
      ? 'unsupported_shape'
      : legFailures.has(simulation.detail)
        ? 'leg_spec_inconsistent'
        : simulation.detail.includes('writable') || simulation.detail.includes('unexpected_wallet')
          ? 'writable_account_failed'
          : 'simulation_failed';
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: code, errorDetail: simulation.detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code, detail: simulation.detail, signature: null };
  }

  let custody;
  try {
    custody = await resolveTradingCustody(link);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Custodial wallet lookup failed.';
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: 'keypair_mismatch', errorDetail: detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'keypair_mismatch', detail, signature: null };
  }
  if (!custody) {
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: 'keypair_mismatch', errorDetail: 'Custodial wallet binding is invalid.', expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'keypair_mismatch', detail: 'Custodial wallet binding is invalid.', signature: null };
  }
  let keypair;
  try {
    keypair = deps.keypair ?? await loadTradingKeypair(custody.wallet, link.walletPubkey);
  } catch {
    keypair = null;
  }
  if (!keypair) {
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: 'keypair_mismatch', errorDetail: 'Custodial key does not match.', expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'keypair_mismatch', detail: 'Custodial key does not match.', signature: null };
  }
  const currentHeight = await connection.getBlockHeight('confirmed');
  if (currentHeight >= built.lastValidBlockHeight) {
    await recordTradeOutcome({ decisionId, status: 'expired', errorCode: 'blockhash_expired', errorDetail: 'Blockhash expired before signing.', expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: 'blockhash_expired', detail: 'Blockhash expired before signing.', signature: null };
  }

  let signedBytes: Uint8Array | null = null;
  const signed: SignAndSendOutcome = await withKeyedMutex('trading:fleet', () => withKeyedMutex(`trading:${intent.avatarId}`, () => db.transaction(async (tx): Promise<SignAndSendOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${intent.avatarId}`}, 0))`);
    const current = await tx.select().from(clawpumpAgentLinks).where(eq(clawpumpAgentLinks.avatarId, intent.avatarId)).for('update').limit(1);
    if (!current[0]?.armed) return { kind: 'refused_presign', code: 'armed_false' as const, detail: 'Link became unarmed.' };
    if (current[0].killed) return { kind: 'refused_presign', code: 'agent_killed' as const, detail: 'Agent became killed.' };
    const activeHalt = await tx.select().from(tradingHalts).where(and(isNull(tradingHalts.clearedAt), sql`(${tradingHalts.scope}='fleet' OR ${tradingHalts.scopeId}=${intent.avatarId})`)).limit(1);
    if (activeHalt[0]) return { kind: 'refused_presign', code: (activeHalt[0].scope === 'fleet' ? 'fleet_halted' : 'agent_halted') as TradeRefusalCode, detail: 'A halt became active.' };
    return signTradingSwap({
      walletRow: custody.wallet, boundPubkey: link.walletPubkey, transaction: built.transaction,
      recentBlockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight,
      admittedMinOut: minimumOut, inputLeg, outputLeg, shape, inputAmount: amountAtomic,
      quotedOutAmount: quote.outAmount, slippageBps,
      deps: {
        ...deps, keypair, addressLookupTableAccounts: lookupTables,
        priorityFeeLamports: readTradingLimits().maxPriorityFeeLamports,
        persistCaptured: async (captured) => {
          signedBytes = captured.signedBytes;
          const capturedRows = await tx.update(tradingDecisions).set({
            signedTxBytes: Buffer.from(captured.signedBytes), signature: captured.signature,
            recentBlockhash: captured.recentBlockhash, lastValidBlockHeight: captured.lastValidBlockHeight,
            buildHash: captured.buildHash, status: 'submitted', verdict: 'submitted',
          }).where(and(eq(tradingDecisions.id, decisionId), eq(tradingDecisions.status, 'admitted'))).returning({ id: tradingDecisions.id });
          if (!capturedRows[0]) throw new Error('decision_capture_cas_lost');
        },
      },
    });
  })));
  if (signed.kind === 'refused_presign') {
    await recordTradeOutcome({ decisionId, status: 'refused', errorCode: signed.code, errorDetail: signed.detail, expectedStatus: 'admitted' });
    await publishDecisionId(decisionId);
    return { kind: 'refused', decisionId, code: signed.code, detail: signed.detail, signature: null };
  }
  if (signed.kind === 'reconcile') {
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: signed.detail, expectedStatus: 'admitted' });
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail: signed.detail, signature: signed.signature };
  }
  if (!signedBytes) {
    const detail = 'Signed transaction bytes were not captured.';
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: detail, expectedStatus: 'submitted' });
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail, signature: signed.signature };
  }
  await publishDecisionId(decisionId);
  const sent = await sendSignedTradingSwap({ signedBytes, expectedSignature: signed.signature, deps: { ...deps, connection } });
  if (sent.kind === 'signature_mismatch') {
    const detail = 'RPC returned a different signature.';
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: detail, expectedStatus: 'submitted' });
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail, signature: signed.signature };
  }
  if (sent.kind === 'ambiguous') {
    // Capture preceded send. Keep `submitted` so the sweeper resends these same
    // signed bytes while the blockhash remains valid.
    return { kind: 'submitted', decisionId, code: null, detail: 'send_pending_retry', signature: signed.signature };
  }
  void ingestTradeSignature({
    wallet: custody.binding as never,
    signature: signed.signature,
    source: 'prime',
    decisionId,
  }).catch(() => undefined);
  return { kind: 'submitted', decisionId, code: null, detail: null, signature: signed.signature };
}

export async function promoteDecisionToExecuted(input: { signature: string; decisionId: string | null; avatarId: string }): Promise<'promoted' | 'noop'> {
  const verified = await lookupVerifiedTrade(input.signature);
  if (!verified.verified || verified.avatarId !== input.avatarId) {
    if (verified.verified) void alertError({ severity: 'critical', source: 'trading-promotion', message: 'Verified trade avatar does not match decision.', context: { signature: input.signature } });
    return 'noop';
  }
  const where = input.decisionId
    ? and(eq(tradingDecisions.id, input.decisionId), eq(tradingDecisions.avatarId, input.avatarId), eq(tradingDecisions.signature, input.signature), eq(tradingDecisions.status, 'submitted'))
    : and(eq(tradingDecisions.signature, input.signature), eq(tradingDecisions.avatarId, input.avatarId), eq(tradingDecisions.status, 'submitted'));
  const rows = await db.transaction(async (tx) => {
    const promoted = await tx.update(tradingDecisions).set({ status: 'executed', verdict: 'executed', settledAt: new Date() }).where(where).returning({ id: tradingDecisions.id });
    if (promoted[0]) await tx.update(tradingUsdcReservations).set({ status: 'settled', releaseReason: 'observer_verified', releasedAt: new Date() }).where(eq(tradingUsdcReservations.decisionId, promoted[0].id));
    return promoted;
  });
  if (!rows[0]) return 'noop';
  await publishDecisionId(rows[0].id);
  return 'promoted';
}

async function sweepTradingDecisions(): Promise<void> {
  const conn = defaultConnection();
  const age = Number(process.env.TRADING_PROMOTION_SWEEP_AGE_S ?? 300) * 1_000;
  const alertAge = Number(process.env.TRADING_PROMOTION_ALERT_AGE_S ?? 3_600) * 1_000;
  const max = Number(process.env.TRADING_PROMOTION_SWEEP_MAX ?? 50);
  const rows = await db.select().from(tradingDecisions).where(and(eq(tradingDecisions.status, 'submitted'), lt(tradingDecisions.createdAt, new Date(Date.now() - age)))).orderBy(desc(tradingDecisions.createdAt)).limit(max);
  for (const row of rows) {
    if (!row.signature) continue;
    const verified = await lookupVerifiedTrade(row.signature);
    if (verified.verified) {
      await promoteDecisionToExecuted({ signature: row.signature, decisionId: row.id, avatarId: row.avatarId });
      continue;
    }
    if (Date.now() - row.createdAt.getTime() >= alertAge) {
      const alerted = await db.update(tradingUsdcReservations).set({ lastWedgeAlertAt: new Date() }).where(and(
        eq(tradingUsdcReservations.decisionId, row.id),
        isNull(tradingUsdcReservations.lastWedgeAlertAt),
      )).returning({ decisionId: tradingUsdcReservations.decisionId });
      if (alerted[0]) {
        void alertError({
          severity: 'warning',
          source: 'trading-promotion',
          message: 'A submitted trading decision has no verified observer match.',
          context: { decisionId: row.id },
        });
      }
    }
    try {
      const statuses = await conn.getSignatureStatuses([row.signature], { searchTransactionHistory: true });
      const status = statuses.value[0];
      if (status?.err) {
        await recordTradeOutcome({ decisionId: row.id, status: 'failed', signature: row.signature, errorCode: 'chain_error', errorDetail: 'Historical status reports failure.', expectedStatus: 'submitted' });
        await publishDecisionId(row.id);
      } else if (status) {
        await db.update(tradingDecisions).set({
          localConfirmOutcome: 'confirmed',
          localConfirmSlot: statuses.context.slot,
          localConfirmedAt: new Date(),
        }).where(and(eq(tradingDecisions.id, row.id), eq(tradingDecisions.status, 'submitted')));
      } else if (row.lastValidBlockHeight !== null) {
        const height = await conn.getBlockHeight({ commitment: 'confirmed', minContextSlot: statuses.context.slot });
        if (height > row.lastValidBlockHeight) {
          await recordTradeOutcome({ decisionId: row.id, status: 'expired', signature: row.signature, errorCode: 'blockhash_expired', errorDetail: 'Historical absence and block height prove expiry.', expectedStatus: 'submitted' });
          await publishDecisionId(row.id);
        } else if (row.signedTxBytes) {
          const returned = await conn.sendRawTransaction(new Uint8Array(row.signedTxBytes), {
            skipPreflight: false,
            maxRetries: 0,
          });
          if (returned !== row.signature) {
            await recordTradeOutcome({
              decisionId: row.id,
              status: 'reconcile',
              signature: row.signature,
              errorCode: 'chain_error',
              errorDetail: 'Durable resend returned a different signature.',
              expectedStatus: 'submitted',
            });
          }
        } else {
          await recordTradeOutcome({
            decisionId: row.id,
            status: 'reconcile',
            signature: row.signature,
            errorCode: 'chain_error',
            errorDetail: 'Captured transaction bytes are missing.',
            expectedStatus: 'submitted',
          });
        }
      }
    } catch {
      // Ambiguous network state holds both budget and reservation.
    }
  }
}

export function startTradingSweeper(pollMs = Number(process.env.TRADING_STALE_SENDING_MS ?? 180_000)): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepTradingDecisions(); }, Math.max(5_000, pollMs));
  sweeper.unref?.();
}

export function stopTradingSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
