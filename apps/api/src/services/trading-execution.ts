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
  tradingWallets,
  wallets,
} from '@clawville/database';
import { readTradingLimits, TRADE_MINTS, type TradeRefusalCode } from '@clawville/shared';
import {
  admitTrade,
  prepareTrade,
  recordTradeOutcome,
  recordTradeRefusal,
  withTradingReservationMutation,
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
  publishDecision?: (decisionId: string) => Promise<void>;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

type ReconcileAlertCode =
  | 'capture_failed'
  | 'missing_signed_bytes'
  | 'signature_mismatch'
  | 'ambiguous_send'
  | 'reconcile_wedge';

function alertTradingReconcile(decisionId: string, code: ReconcileAlertCode): void {
  void alertError({
    severity: 'critical',
    source: 'trading-reconcile',
    message: 'A trading decision requires operator reconciliation.',
    context: { decisionId, code },
  });
}

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
  const publish = deps.publishDecision ?? publishDecisionId;
  const prepared = await prepareTrade(intent, deps);
  if ('kind' in prepared) {
    await publish(prepared.decisionId);
    return { kind: 'refused', decisionId: prepared.decisionId, code: prepared.code, detail: prepared.detail, signature: null };
  }
  const { link, amountAtomic, inputInfo, outputInfo, slippageBps } = prepared;
  const connection = prepared.connection;
  let quote;
  try {
    quote = await fetchTradingQuote({ inputMint: intent.inputMint, outputMint: intent.outputMint, amountAtomic, slippageBps, fetchImpl: deps.fetchImpl });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'quote failed';
    const code: TradeRefusalCode = error instanceof ZodError
      ? 'quote_schema_invalid'
      : detail.includes('route') ? 'route_discontinuous' : 'quote_failed';
    return refuse(intent, code, detail);
  }
  if (quote.priceImpactPct > readTradingLimits().maxQuoteImpactPct) {
    return refuse(intent, 'quote_impact_above_cap', 'Quoted price impact exceeds the cap.');
  }

  let built;
  let lookupTables: AddressLookupTableAccount[];
  try {
    built = await buildTradingSwapTransaction({ quote, userPublicKey: link.walletPubkey, maxPriorityFeeLamports: readTradingLimits().maxPriorityFeeLamports, fetchImpl: deps.fetchImpl });
    lookupTables = deps.addressLookupTableAccounts ?? await resolveLookups(built.transaction, connection);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'build failed';
    return refuse(intent, 'tx_binding_failed', detail);
  }
  const minimumOut = (quote.outAmount * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
  const wallet = new PublicKey(link.walletPubkey);
  const inputMode = intent.inputMint === TRADE_MINTS.WSOL ? 'native-sol' : 'token';
  const outputMode = intent.outputMint === TRADE_MINTS.WSOL ? 'native-sol' : 'token';
  const shape: SwapShape = inputMode === 'native-sol' ? 'sol-token' : outputMode === 'native-sol' ? 'token-sol' : 'token-token';
  const inputLeg: SwapLeg = { mint: new PublicKey(intent.inputMint), tokenProgram: inputInfo.programId, ata: deriveTradingAta(wallet, inputInfo), mode: inputMode, direction: 'debit' };
  const outputLeg: SwapLeg = { mint: new PublicKey(intent.outputMint), tokenProgram: outputInfo.programId, ata: deriveTradingAta(wallet, outputInfo), mode: outputMode, direction: 'credit' };
  const inspection = inspectTradingSwapTransaction({
    transaction: built.transaction,
    wallet,
    inputAmount: amountAtomic,
    minimumOutAmount: minimumOut,
    priorityFeeLamports: readTradingLimits().maxPriorityFeeLamports,
    addressLookupTableAccounts: lookupTables,
    inputLeg,
    outputLeg,
    shape,
    quotedOutAmount: quote.outAmount,
    slippageBps,
  });
  if (!inspection.ok) {
    const code: TradeRefusalCode = inspection.detail === 'minimum_out_mismatch' || inspection.detail === 'minimum_out_non_positive'
      ? 'min_out_below_admitted'
      : 'tx_binding_failed';
    return refuse(intent, code, inspection.detail);
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
    return refuse(intent, code, simulation.detail);
  }

  if (simulation.postTransactionWalletLamports < readTradingLimits().minSolReserveLamports) {
    return refuse(intent, 'sol_reserve_breached', 'The simulated liquid SOL balance crosses the reserve floor.');
  }

  const currentHeight = await connection.getBlockHeight('confirmed');
  if (currentHeight >= built.lastValidBlockHeight) {
    return refuse(intent, 'blockhash_expired', 'Blockhash expired before admission.');
  }
  let custody;
  try { custody = await resolveTradingCustody(link); }
  catch { custody = null; }
  if (!custody) return refuse(intent, 'keypair_mismatch', 'Custodial wallet binding is invalid.');
  let keypair;
  try { keypair = deps.keypair ?? await loadTradingKeypair(custody.wallet, link.walletPubkey); }
  catch { keypair = null; }
  if (!keypair) return refuse(intent, 'keypair_mismatch', 'Custodial key does not match.');

  let signedBytes: Uint8Array | null = null;
  const signedOutcomeBox: { value: SignAndSendOutcome | null } = { value: null };
  let capturedBinding: typeof tradingWallets.$inferSelect | null = null;
  const admission = await admitTrade(intent, deps, prepared, async ({ tx, decisionId, link: lockedLink }) => {
    const current = await tx.select().from(clawpumpAgentLinks).where(eq(clawpumpAgentLinks.avatarId, intent.avatarId)).for('update').limit(1);
    if (!current[0]?.armed) return { kind: 'refused_presign', code: 'armed_false' as const, detail: 'Link became unarmed.' };
    if (current[0].killed) return { kind: 'refused_presign', code: 'agent_killed' as const, detail: 'Agent became killed.' };
    if (current[0].walletPubkey !== lockedLink.walletPubkey) {
      return { kind: 'refused_presign', code: 'tx_binding_failed' as const, detail: 'Trading wallet changed before signing.' };
    }
    const activeHalt = await tx.select().from(tradingHalts).where(and(isNull(tradingHalts.clearedAt), sql`(${tradingHalts.scope}='fleet' OR ${tradingHalts.scopeId}=${intent.avatarId})`)).limit(1);
    if (activeHalt[0]) return { kind: 'refused_presign', code: (activeHalt[0].scope === 'fleet' ? 'fleet_halted' : 'agent_halted') as TradeRefusalCode, detail: 'A halt became active.' };
    const liveWalletRows = await tx.select().from(wallets).where(and(
      eq(wallets.subjectType, 'avatar'),
      eq(wallets.subjectId, intent.avatarId),
      eq(wallets.publicKey, current[0].walletPubkey),
      eq(wallets.custodyVerified, true),
    )).for('update').limit(1);
    const liveWallet = liveWalletRows[0];
    const liveBindingRows = current[0].clawvilleAgentId
      ? await tx.select().from(tradingWallets).where(and(
        eq(tradingWallets.avatarId, intent.avatarId),
        eq(tradingWallets.userId, current[0].userId),
        eq(tradingWallets.subjectKind, 'agent'),
        eq(tradingWallets.agentId, current[0].clawvilleAgentId),
        eq(tradingWallets.pubkey, current[0].walletPubkey),
        eq(tradingWallets.source, 'custodial'),
        isNull(tradingWallets.revokedAt),
      )).for('update').limit(1)
      : [];
    if (!liveWallet || !liveBindingRows[0]) {
      return { kind: 'refused_presign', code: 'keypair_mismatch' as const, detail: 'Custody or trading binding was revoked.' };
    }
    if (liveWallet.publicKey !== keypair.publicKey.toBase58()) {
      return { kind: 'refused_presign', code: 'keypair_mismatch' as const, detail: 'Custodial key does not match.' };
    }
    capturedBinding = liveBindingRows[0];
    signedOutcomeBox.value = await signTradingSwap({
      walletRow: liveWallet, boundPubkey: current[0].walletPubkey, transaction: built.transaction,
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
    return signedOutcomeBox.value;
  });
  if (admission.kind === 'refuse') {
    await publish(admission.decisionId);
    return { kind: 'refused', decisionId: admission.decisionId, code: admission.code, detail: admission.detail, signature: null };
  }
  const { decisionId } = admission.admission;
  const signed = signedOutcomeBox.value;
  if (!signed || signed.kind === 'refused_presign') throw new Error('admission_capture_outcome_invalid');
  if (signed.kind === 'reconcile') {
    alertTradingReconcile(decisionId, 'capture_failed');
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail: signed.detail, signature: signed.signature };
  }
  if (!signedBytes) {
    const detail = 'Signed transaction bytes were not captured.';
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: detail, expectedStatus: 'submitted' });
    alertTradingReconcile(decisionId, 'missing_signed_bytes');
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail, signature: signed.signature };
  }
  await publish(decisionId);
  const sent = await sendSignedTradingSwap({ signedBytes, expectedSignature: signed.signature, deps: { ...deps, connection } });
  if (sent.kind === 'signature_mismatch') {
    const detail = 'RPC returned a different signature.';
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: detail, expectedStatus: 'submitted' });
    alertTradingReconcile(decisionId, 'signature_mismatch');
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail, signature: signed.signature };
  }
  if (sent.kind === 'ambiguous') {
    await recordTradeOutcome({ decisionId, status: 'reconcile', signature: signed.signature, errorCode: 'chain_error', errorDetail: sent.detail, expectedStatus: 'submitted' });
    alertTradingReconcile(decisionId, 'ambiguous_send');
    return { kind: 'reconcile', decisionId, code: 'chain_error', detail: sent.detail, signature: signed.signature };
  }
  void ingestTradeSignature({
    wallet: capturedBinding as never,
    signature: signed.signature,
    source: 'prime',
    decisionId,
  }).catch((error: unknown) => alertError({
    severity: 'critical',
    source: 'trading-prime-ingest',
    message: 'Prime trading signature ingestion failed.',
    context: { decisionId, error: error instanceof Error ? error.message : 'unknown' },
  }));
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
  const rows = await withTradingReservationMutation(input.avatarId, async (tx) => {
    const promoted = await tx.update(tradingDecisions).set({ status: 'executed', verdict: 'executed', settledAt: new Date() }).where(where).returning({ id: tradingDecisions.id });
    if (promoted[0]) await tx.update(tradingUsdcReservations).set({ status: 'settled', releaseReason: 'observer_verified', releasedAt: new Date() }).where(eq(tradingUsdcReservations.decisionId, promoted[0].id));
    return promoted;
  });
  if (!rows[0]) return 'noop';
  await publishDecisionId(rows[0].id);
  return 'promoted';
}

async function sweepTradingDecisions(): Promise<void> {
  const age = Number(process.env.TRADING_PROMOTION_SWEEP_AGE_S ?? 300) * 1_000;
  const alertAge = Number(process.env.TRADING_PROMOTION_ALERT_AGE_S ?? 3_600) * 1_000;
  const max = Number(process.env.TRADING_PROMOTION_SWEEP_MAX ?? 50);
  const neverSigned = await db.select().from(tradingDecisions).where(and(
    eq(tradingDecisions.status, 'admitted'),
    isNull(tradingDecisions.signature),
  )).orderBy(desc(tradingDecisions.createdAt)).limit(max);
  for (const row of neverSigned) {
    const alerted = await db.update(tradingUsdcReservations).set({ lastWedgeAlertAt: new Date() }).where(and(
      eq(tradingUsdcReservations.decisionId, row.id),
      sql`${tradingUsdcReservations.lastWedgeAlertAt} IS NULL OR ${tradingUsdcReservations.lastWedgeAlertAt} < ${new Date(Date.now() - alertAge)}`,
    )).returning({ decisionId: tradingUsdcReservations.decisionId });
    if (alerted[0]) {
      void alertError({
        severity: 'critical',
        source: 'trading-admitted-wedge',
        message: 'A legacy admitted decision has no captured signature and requires operator release.',
        context: { decisionId: row.id, code: 'operator_never_signed' },
      });
    }
  }

  const reconcileRows = await db.select().from(tradingDecisions).where(eq(tradingDecisions.status, 'reconcile'))
    .orderBy(desc(tradingDecisions.createdAt)).limit(max);
  for (const row of reconcileRows) {
    const alerted = await db.update(tradingUsdcReservations).set({ lastWedgeAlertAt: new Date() }).where(and(
      eq(tradingUsdcReservations.decisionId, row.id),
      sql`${tradingUsdcReservations.lastWedgeAlertAt} IS NULL OR ${tradingUsdcReservations.lastWedgeAlertAt} < ${new Date(Date.now() - alertAge)}`,
    )).returning({ decisionId: tradingUsdcReservations.decisionId });
    if (alerted[0]) alertTradingReconcile(row.id, 'reconcile_wedge');
  }

  const conn = defaultConnection();
  const rows = await db.select().from(tradingDecisions).where(and(eq(tradingDecisions.status, 'submitted'), lt(tradingDecisions.createdAt, new Date(Date.now() - age)))).orderBy(desc(tradingDecisions.createdAt)).limit(max);
  for (const row of rows) {
    try {
      if (!row.signature) throw new Error('submitted decision has no signature');
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
            const reconciled = await recordTradeOutcome({
              decisionId: row.id,
              status: 'reconcile',
              signature: row.signature,
              errorCode: 'chain_error',
              errorDetail: 'Durable resend returned a different signature.',
              expectedStatus: 'submitted',
            });
            if (reconciled) alertTradingReconcile(row.id, 'signature_mismatch');
          }
        } else {
          const reconciled = await recordTradeOutcome({
            decisionId: row.id,
            status: 'reconcile',
            signature: row.signature,
            errorCode: 'chain_error',
            errorDetail: 'Captured transaction bytes are missing.',
            expectedStatus: 'submitted',
          });
          if (reconciled) alertTradingReconcile(row.id, 'missing_signed_bytes');
        }
      }
    } catch (error) {
      // Ambiguous network state holds both budget and reservation, but it is never silent.
      void alertError({
        severity: 'warning',
        source: 'trading-sweeper',
        message: 'Trading decision reconciliation failed.',
        context: { decisionId: row.id, error: error instanceof Error ? error.message : 'unknown' },
      });
    }
  }
}

export function startTradingSweeper(pollMs = Number(process.env.TRADING_PROMOTION_SWEEP_AGE_S ?? 300) * 1_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepTradingDecisions().catch((error: unknown) => alertError({
      severity: 'critical',
      source: 'trading-sweeper',
      message: 'Trading sweeper pass failed.',
      context: { decisionId: 'sweep-query', error: error instanceof Error ? error.message : 'unknown' },
    }));
  }, Math.max(5_000, pollMs));
  sweeper.unref?.();
}

export function stopTradingSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
