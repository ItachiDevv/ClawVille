import { z } from 'zod';
import type { Sql } from 'postgres';
import { decodeEventLog, keccak256, pad, toBytes, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { buildIsolatedTaskPrompt } from '@clawville/agent-runtime/isolated-task';
import { createBrainChainReader, workerHireAbi } from './chain-client';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import { computeHash, requiredInputTokens, tokenCost } from './inference-policy';
import { DurableInferenceProxy, type RootComputeEnvelopeApproval } from './inference-proxy';
import { OPENAI_BRAINCHAIN_PRICE_POLICY, OpenAIReservedProviderAdapter } from './openai-provider';
import { runBrainchainIsolatedProcess, type IsolatedProcessBundle } from './isolated-process-coordinator';
import { ProtectedRootComputeStore, reconcileRootComputeDocument, readRootTrialRecord, writeRootTrialRecord } from './root-compute-store';

export class PaidTrialError extends Error { readonly code = 'paid_trial_refused'; constructor() { super('BrainChain paid trial refused'); } }
const inputSchema = z.object({ runId: z.string().uuid(), avatarId: z.string().uuid(), taskId: z.string().uuid(), authorityId: z.string().uuid(),
  rootReservationId: z.string().uuid(), brief: z.string().min(1).max(16384),
}).strict();
export type PaidTrialInput = z.infer<typeof inputSchema>;
export function paidTrialLimits(prompt: string): { maxInputTokens: 4096; maxOutputTokens: 256; maximumMicros: bigint } {
  if (requiredInputTokens(OPENAI_BRAINCHAIN_PRICE_POLICY, prompt) > 4096) throw new PaidTrialError();
  const maximumMicros = tokenCost(OPENAI_BRAINCHAIN_PRICE_POLICY, 4096, 256);
  if (maximumMicros !== 13312n) throw new PaidTrialError();
  return Object.freeze({ maxInputTokens: 4096, maxOutputTokens: 256, maximumMicros });
}
export interface PaidTrialTicket {
  readonly input: Readonly<PaidTrialInput>; readonly promptHash: string; readonly maximumMicros: '13312'; readonly approval: Readonly<RootComputeEnvelopeApproval>;
}
/** Root-only host entry. It discovers no credential and creates no execution or budget authority. */
type TrialReadTransport = Pick<NonNullable<Parameters<typeof createBrainChainReader>[1]>, 'fetch' | 'validateUrl'>;
export class BoundedBrainchainPaidTrial {
  private readonly tickets = new WeakSet<PaidTrialTicket>();
  private readonly options: Readonly<{ database: Sql; store: ProtectedRootComputeStore; journalDirectory: string; expectedUid: number; bundle: IsolatedProcessBundle; readTransport?: TrialReadTransport }>;
  constructor(options: { database: Sql; store: ProtectedRootComputeStore; journalDirectory: string; expectedUid: number; bundle: IsolatedProcessBundle; readTransport?: TrialReadTransport }) {
    if (process.platform !== 'linux' || process.getuid?.() !== options.expectedUid) throw new PaidTrialError();
    this.options = Object.freeze({ ...options, bundle: Object.freeze({ ...options.bundle }), readTransport: options.readTransport ? Object.freeze({ ...options.readTransport }) : undefined });
  }
  private path(runId: string, phase: string): string { return `${this.options.journalDirectory}/${runId}-${phase}.json`; }
  private async eligibility(input: Readonly<PaidTrialInput>) {
    const prompt = buildIsolatedTaskPrompt(input.brief), limits = paidTrialLimits(prompt);
    const task = await this.options.database.begin(async tx => {
      await tx`SET LOCAL lock_timeout='1000ms'`; await tx`SET LOCAL statement_timeout='2000ms'`;
      const [row] = await tx`SELECT t.*,w.address,w.requested_state,a.expires_at AS authority_expires_at,a.generation AS authority_generation,a.prompt_hash,a.input_hash,a.brief_hash AS authority_brief_hash,a.revoked_at,a.consumed_at
      FROM brainchain_worker_tasks t JOIN brainchain_worker_bindings w ON w.id=t.binding_id JOIN brainchain_execution_authorities a ON a.task_id=t.id AND a.binding_id=w.id AND a.avatar_id=t.avatar_id
      WHERE t.id=${input.taskId} AND t.avatar_id=${input.avatarId} AND a.id=${input.authorityId}`;
      return row;
    });
    if (!task || !task.canonical || task.environment !== 'testnet' || task.chain_id !== 274630 || task.status !== 2 || task.requested_state !== 'running'
      || task.revoked_at || task.consumed_at || task.authority_expires_at.getTime() <= Date.now() + 5000
      || task.authority_generation !== task.lease_generation + 1 || task.prompt_hash !== computeHash(prompt)
      || task.input_hash !== computeHash(input.brief) || task.brief_hash !== keccak256(toBytes(input.brief))
      || task.authority_brief_hash !== task.brief_hash || BigInt(task.deadline_unix) * 1000n <= BigInt(Date.now() + 300_000)
      || !BRAINCHAIN_CONTRACTS.testnet.boards.some(board => board.address === task.board_address)) throw new PaidTrialError();
    const reader = createBrainChainReader('testnet', this.options.readTransport), at = await reader.stableBlock();
    const observedAt = new Date(), timestamp = BigInt(at.timestamp);
    if (Date.now() / 1000 - Number(timestamp) > 120 || timestamp > BigInt(Math.floor(Date.now()/1000))
      || BigInt(task.observed_block) !== BigInt(at.number) || task.observed_block_hash.toLowerCase() !== at.hash.toLowerCase()) throw new PaidTrialError();
    await reader.assertCode(task.board_address as Address, at);
    const live = z.object({ status: z.number().int(), model: z.string(), briefHash: z.string(), deadline: z.bigint(), payee: z.string() }).passthrough()
      .parse(await reader.task(task.board_address as Address, BigInt(task.task_id), at));
    const model = pad(task.address as Address, { size: 32 }).toLowerCase();
    if (live.status !== 2 || live.model.toLowerCase() !== model || live.briefHash.toLowerCase() !== task.brief_hash.toLowerCase()
      || live.deadline !== BigInt(task.deadline_unix) || live.payee.toLowerCase() !== zeroAddress) throw new PaidTrialError();
    const hireBlock = await reader.block(BigInt(task.hire_block));
    const logs = await reader.hiredLogs(task.board_address as Address, model as Hex, BigInt(task.hire_block), BigInt(task.hire_block));
    if (hireBlock.hash.toLowerCase() !== task.hire_block_hash.toLowerCase() || !logs.some(log => {
      if (log.removed || log.address.toLowerCase() !== task.board_address || BigInt(log.blockNumber) !== BigInt(task.hire_block)
        || log.blockHash.toLowerCase() !== task.hire_block_hash.toLowerCase() || log.transactionHash.toLowerCase() !== task.hire_tx_hash.toLowerCase()
        || BigInt(log.logIndex) !== BigInt(task.hire_log_index) || log.topics.length !== 4 || log.data !== '0x') return false;
      try {
        const decoded = decodeEventLog({ abi: workerHireAbi, eventName: 'WorkerHired', data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]], strict: true });
        return decoded.args.id === BigInt(task.task_id) && decoded.args.model.toLowerCase() === model
          && typeof decoded.args.decisionId === 'bigint'
          && log.topics[3]!.toLowerCase() === pad(toHex(decoded.args.decisionId), { size: 32 }).toLowerCase();
      } catch { return false; }
    })) throw new PaidTrialError();
    if ((await reader.block(BigInt(at.number))).hash.toLowerCase() !== at.hash.toLowerCase()) throw new PaidTrialError();
    const document = await this.options.store.authority().verifyCurrentDocument();
    const reservation = document.reservations.find(item => item.rootReservationId === input.rootReservationId);
    if (!reservation || reservation.provider !== 'openai' || reservation.limitMicros !== limits.maximumMicros.toString()) throw new PaidTrialError();
    const approval = Object.freeze({ jobId: document.jobId, provider: 'openai' as const, rootReservationId: reservation.rootReservationId,
      approvalRef: reservation.approvalRef, limitMicros: limits.maximumMicros, expiresAt: new Date(reservation.expiresAtMs) });
    await this.options.store.authority().verifyReservation(approval);
    await this.options.database.begin(async tx => { await tx`SET LOCAL lock_timeout='1000ms'`; await tx`SET LOCAL statement_timeout='2000ms'`; await reconcileRootComputeDocument(tx, document); });
    if (Date.now() - observedAt.getTime() > 30_000) throw new PaidTrialError();
    return { prompt, limits, approval, observation: { observedAt, blockTimestamp: timestamp, blockNumber: BigInt(at.number), blockHash: at.hash } };
  }
  /** Run this before root constructs an adapter or supplies any provider credential. */
  async preflight(raw: PaidTrialInput): Promise<PaidTrialTicket> {
    try {
      const input = Object.freeze(inputSchema.parse(raw));
      const ready = await this.eligibility(input);
      const ticket = Object.freeze({ input, promptHash: computeHash(ready.prompt), maximumMicros: '13312' as const, approval: ready.approval });
      await writeRootTrialRecord(this.path(input.runId, 'preflight'), this.options.expectedUid,
        { version: 1, runId: input.runId, taskId: input.taskId, authorityId: input.authorityId, rootReservationId: input.rootReservationId, promptHash: ticket.promptHash, maximumMicros: ticket.maximumMicros });
      this.tickets.add(ticket); return ticket;
    } catch { throw new PaidTrialError(); }
  }
  /** The root supplies the reviewed host adapter only after preflight. No automatic retry exists. */
  async run(ticket: PaidTrialTicket, adapter: OpenAIReservedProviderAdapter) {
    if (!this.tickets.delete(ticket) || !(adapter instanceof OpenAIReservedProviderAdapter)) throw new PaidTrialError();
    try {
      const { input } = ticket;
      await readRootTrialRecord(this.path(input.runId, 'preflight'), this.options.expectedUid);
      await writeRootTrialRecord(this.path(input.runId, 'started'), this.options.expectedUid, { version: 1, runId: input.runId, atMs: Date.now() });
      const ready = await this.eligibility(input);
      if (computeHash(ready.prompt) !== ticket.promptHash || ready.approval.jobId !== ticket.approval.jobId) throw new PaidTrialError();
      // Lazy import preserves a credential-free module and fixture import boundary.
      const { db, sql } = await import('@clawville/database');
      const [local] = await this.options.database`SELECT current_database() AS name,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port`;
      const [canonical] = await db.execute<{ name: string; role: string; address: string; port: number }>(sql`SELECT current_database() AS name,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port`);
      if (!local || !canonical || ['name','role','address','port'].some(key => local[key] !== canonical[key as keyof typeof canonical])) throw new PaidTrialError();
      const { claimExecutionAttempt } = await import('./execution');
      const attempt = await claimExecutionAttempt({ avatarId: input.avatarId, taskId: input.taskId, authorityId: input.authorityId,
        brief: input.brief, prompt: ready.prompt, observation: ready.observation });
      await writeRootTrialRecord(this.path(input.runId, 'attempt'), this.options.expectedUid, { attemptId: attempt.id, taskId: input.taskId, generation: attempt.generation });
      const proxy = new DurableInferenceProxy(this.options.database, [OPENAI_BRAINCHAIN_PRICE_POLICY], [adapter], this.options.store.authority());
      const envelope = await proxy.approveEnvelope(ready.approval);
      const deadlineMs = Math.min(Date.now()+30_000, attempt.leaseUntil.getTime()-1, ready.approval.expiresAt.getTime()-1);
      const reserved = await proxy.reserve({ envelopeId: envelope.id, avatarId: input.avatarId, taskId: input.taskId,
        attemptId: attempt.id, leaseOwner: attempt.leaseOwner, generation: attempt.generation,
        model: OPENAI_BRAINCHAIN_PRICE_POLICY.model, pricingVersion: OPENAI_BRAINCHAIN_PRICE_POLICY.version,
        prompt: ready.prompt, maxInputTokens: ready.limits.maxInputTokens, maxOutputTokens: ready.limits.maxOutputTokens, deadlineMs });
      await writeRootTrialRecord(this.path(input.runId, 'call'), this.options.expectedUid, { callId: reserved.binding.callId, attemptId: attempt.id, envelopeId: envelope.id, maximumMicros: ticket.maximumMicros });
      const result = await runBrainchainIsolatedProcess({ bundle: this.options.bundle, binding: reserved.binding, brief: input.brief, capability: reserved.capability, proxy });
      await writeRootTrialRecord(this.path(input.runId, 'receipt'), this.options.expectedUid,
        { callId: result.receipt.callId, state: result.receipt.state, chargedMicros: result.receipt.chargedMicros, textHash: computeHash(result.result.text) });
      return result;
    } catch { throw new PaidTrialError(); }
  }
  /** Restart reads accounting only. It never reconstructs a capability or resumes dispatch. */
  async inspect(runId: string) {
    try {
      z.string().uuid().parse(runId);
      const record = z.object({ version: z.literal(1), runId: z.literal(runId), taskId: z.string().uuid(), authorityId: z.string().uuid(),
        rootReservationId: z.string().uuid(), promptHash: z.string().regex(/^[a-f0-9]{64}$/), maximumMicros: z.literal('13312') }).strict()
        .parse(JSON.parse(await readRootTrialRecord(this.path(runId, 'preflight'), this.options.expectedUid)));
      return await this.options.database`SELECT c.id AS call_id,c.state,c.maximum_micros,c.charged_micros FROM brainchain_compute_calls c JOIN brainchain_task_attempts a ON a.id=c.attempt_id
        WHERE a.authority_id=${record.authorityId} AND a.task_id=${record.taskId} AND a.prompt_hash=${record.promptHash}`;
    } catch { throw new PaidTrialError(); }
  }
}
