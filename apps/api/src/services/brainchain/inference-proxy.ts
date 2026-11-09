import {lockComputeAccounting,assertComputeAccounting} from './compute-accounting';
import {assertConfiguredAuthorityPolicy,assertConfiguredAuthorityEvidence} from './configured-authority';
import {observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {databaseDate} from './database-values';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import type { IsolatedTaskBinding, IsolatedTaskProxy, IsolatedTaskProxyRequest, IsolatedTaskProxyResponse } from '@clawville/agent-runtime/isolated-task';
import { BrainchainComputeError, COMPUTE_JOB_CAP_MICROS, computeHash, freezePricePolicy, requiredInputTokens, tokenCost, type ComputePricePolicy, type ComputeProvider } from './inference-policy';

export interface ReservedProviderRequest {
  readonly callId: string; readonly model: string; readonly prompt: string;
  readonly maxInputTokens: number; readonly maxOutputTokens: number;
}
/** Exactly one adapter invocation. The trusted adapter must disable SDK retries and fallback. */
export interface ReservedProviderAdapter {
  readonly provider: ComputeProvider;
  generate(request: ReservedProviderRequest, signal: AbortSignal): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}
export interface RootComputeEnvelopeApproval {
  readonly jobId: string; readonly provider: ComputeProvider; readonly rootReservationId: string;
  readonly approvalRef: string; readonly limitMicros: bigint; readonly expiresAt: Date;
}
/** Must verify an existing sealed reservation in the root's ledger, never create another budget owner. */
export interface RootComputeBudgetAuthority {
  verifyReservation(approval: RootComputeEnvelopeApproval): Promise<void>;
}
type Envelope = { id: string; root_reservation_id: string; approval_ref: string; budget_id: string; job_id: string; provider: ComputeProvider; state: string; expires_at: Date|string;
  limit_micros: string; reserved_micros: string; uncertain_micros: string; settled_micros: string; reconciliation_id: string | null };
type Call = { id: string; reservation_id: string; envelope_id: string; avatar_id: string; task_id: string; attempt_id: string;
  generation: number; lease_owner: string; model: string; pricing_version: string; prompt_hash: string; prompt: string;
  max_input_tokens: number; max_output_tokens: number; input_overhead_tokens: number; input_rate: string; output_rate: string; request_micros: string;
  maximum_micros: string; charged_micros: string | null; capability_hash: string; deadline: Date|string; state: string;
  output: string | null; input_tokens: number | null; output_tokens: number | null };
export type ComputeReceipt = { callId: string; state: string; maximumMicros: string; chargedMicros: string | null; response?: IsolatedTaskProxyResponse };
const uuid = z.string().uuid();
const bindingSchema = z.object({ jobId: uuid, avatarId: uuid, taskId: uuid, attemptId: uuid, generation: z.number().int().positive(),
  reservationId: uuid, callId: uuid, model: z.string().min(1).max(128), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  maxInputTokens: z.number().int().positive().max(131072), maxOutputTokens: z.number().int().positive().max(8192),
  deadlineMs: z.number().int().positive() }).strict();
const requestSchema = z.object({ binding: bindingSchema, prompt: z.string().min(1).max(32768).refine(value => Buffer.byteLength(value, 'utf8') <= 32768) }).strict();
const reserveSchema = z.object({ envelopeId: uuid, avatarId: uuid, taskId: uuid, attemptId: uuid, leaseOwner: uuid,
  generation: z.number().int().positive(), model: z.string().max(128), pricingVersion: z.string().max(96), prompt: z.string().min(1).max(32768),
  maxInputTokens: z.number().int().positive().max(131072), maxOutputTokens: z.number().int().positive().max(8192),
  deadlineMs: z.number().int().positive() }).strict();
export type ReserveComputeInput = z.infer<typeof reserveSchema>;
export type WorkerComputeFenceInput = {deadlineMs?:number;taskId:string;attemptId:string;avatarId:string;generation:number;leaseOwner:string;promptHash:string;envelopeId:string;maximumMicros:bigint};
/** Trusted host only. The autonomous worker composition requires this fence; direct reviewed trials retain their root-only policy. */
export type WorkerComputeFence = (tx:TransactionSql,input:Readonly<WorkerComputeFenceInput>)=>Promise<void>;
const envelopeSchema = z.object({ jobId: uuid, provider: z.enum(['openai', 'openrouter']),
  rootReservationId: z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/), approvalRef: z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/),
  limitMicros: z.bigint().positive().max(COMPUTE_JOB_CAP_MICROS), expiresAt: z.date() }).strict();

/** Trusted internal service; it registers no HTTP route and reads no credentials or environment. */
export class DurableInferenceProxy {
  private readonly policies: ReadonlyMap<string, Readonly<ComputePricePolicy>>;
  private readonly adapters: ReadonlyMap<ComputeProvider, ReservedProviderAdapter>;
  private readonly verifyRoot?: RootComputeBudgetAuthority['verifyReservation'];
  constructor(private readonly database: Sql, policies: readonly ComputePricePolicy[], adapters: readonly ReservedProviderAdapter[], rootBudget?: RootComputeBudgetAuthority,private readonly workerFence?:WorkerComputeFence,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()) {
    if (rootBudget && typeof rootBudget.verifyReservation !== 'function') throw new BrainchainComputeError('budget_refused');
    this.verifyRoot = rootBudget?.verifyReservation.bind(rootBudget);
    const prices = policies.map(freezePricePolicy);
    if (new Set(prices.map(p => `${p.provider}:${p.model}:${p.version}`)).size !== prices.length
      || new Set(adapters.map(p => p.provider)).size !== adapters.length
      || adapters.some(p => !['openai', 'openrouter'].includes(p.provider) || typeof p.generate !== 'function')) throw new BrainchainComputeError('policy_refused');
    this.policies = new Map(prices.map(p => [`${p.provider}:${p.model}:${p.version}`, p]));
    this.adapters = new Map(adapters.map(adapter => [adapter.provider, Object.freeze({ provider: adapter.provider, generate: adapter.generate.bind(adapter) })]));
  }

  /** Root only: this records a root ledger reservation that already exists. */
  async approveEnvelope(raw: z.infer<typeof envelopeSchema>, expectedEnvelopeId?: string): Promise<{ id: string }> {
    if(expectedEnvelopeId!==undefined)uuid.parse(expectedEnvelopeId);
    const input = envelopeSchema.parse(raw);
    if (!this.verifyRoot) throw new BrainchainComputeError('budget_refused');
    try { await this.verifyRoot(Object.freeze({ ...input, expiresAt: new Date(input.expiresAt) })); }
    catch { throw new BrainchainComputeError('budget_refused'); }
    return this.database.begin(async tx => {
      if(expectedEnvelopeId!==undefined){await tx`SET LOCAL lock_timeout='1000ms'`;await tx`SET LOCAL statement_timeout='2000ms'`;}
      await tx`INSERT INTO brainchain_compute_budgets(job_id,provider,cap_micros) VALUES(${input.jobId},${input.provider},10000000) ON CONFLICT(job_id,provider) DO NOTHING`;
      const [budget] = await tx`SELECT * FROM brainchain_compute_budgets WHERE job_id=${input.jobId} AND provider=${input.provider} FOR UPDATE`;
      const [time] = await tx`SELECT clock_timestamp() AS now`;
      if (!budget || databaseDate(input.expiresAt) <= databaseDate(time!.now) || input.expiresAt.getTime() > databaseDate(time!.now).getTime() + 86_400_000) throw new BrainchainComputeError('expired');
      const [prior] = await tx`SELECT * FROM brainchain_compute_envelopes WHERE root_reservation_id=${input.rootReservationId}`;
      if (prior) {
        if ((expectedEnvelopeId!==undefined && prior.id!==expectedEnvelopeId) || prior.budget_id !== budget.id || prior.limit_micros !== input.limitMicros.toString()
          || prior.approval_ref !== input.approvalRef || databaseDate(prior.expires_at).getTime() !== input.expiresAt.getTime()) throw new BrainchainComputeError('budget_refused');
        return { id: String(prior.id) };
      }
      if (BigInt(budget.allocated_micros) + input.limitMicros > COMPUTE_JOB_CAP_MICROS) throw new BrainchainComputeError('budget_refused');
      const id = expectedEnvelopeId ?? randomUUID();
      await tx`INSERT INTO brainchain_compute_envelopes(id,budget_id,root_reservation_id,approval_ref,limit_micros,expires_at)
        VALUES(${id},${budget.id},${input.rootReservationId},${input.approvalRef},${input.limitMicros.toString()},${tx.typed(input.expiresAt.toISOString(),25)}::timestamptz)`;
      await tx`UPDATE brainchain_compute_budgets SET allocated_micros=allocated_micros+${input.limitMicros.toString()} WHERE id=${budget.id}`;
      return { id };
    });
  }

  /** Bound trusted root reads; late results never authorize a provider call. */
  private async verifyDispatchRoot(envelope: Envelope, deadlineMs: number, signal: AbortSignal): Promise<void> {
    if (!this.verifyRoot) throw new BrainchainComputeError('budget_refused');
    if (signal.aborted || Date.now() >= deadlineMs) throw new BrainchainComputeError('expired');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new BrainchainComputeError('expired'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new BrainchainComputeError('budget_refused')), Math.min(2000, deadlineMs - Date.now()));
    });
    try {
      const approval = Object.freeze({ jobId: envelope.job_id, provider: envelope.provider,
        rootReservationId: envelope.root_reservation_id, approvalRef: envelope.approval_ref,
        limitMicros: BigInt(envelope.limit_micros), expiresAt: new Date(envelope.expires_at) });
      await Promise.race([this.verifyRoot(approval), stopped]);
      if (signal.aborted || Date.now() >= deadlineMs) throw new BrainchainComputeError('expired');
    } catch { throw new BrainchainComputeError(signal.aborted || Date.now() >= deadlineMs ? 'expired' : 'budget_refused'); }
    finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }

  private async lockEnvelope(tx: TransactionSql, id: string): Promise<Envelope> {
    const [owner] = await tx`SELECT budget_id FROM brainchain_compute_envelopes WHERE id=${id}`;
    if (!owner) throw new BrainchainComputeError('budget_refused');
    await tx`SELECT id FROM brainchain_compute_budgets WHERE id=${owner.budget_id} FOR UPDATE`;
    const [envelope] = await tx<Envelope[]>`SELECT e.*,b.job_id,b.provider FROM brainchain_compute_envelopes e JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE e.id=${id} FOR UPDATE OF e`;
    if (!envelope) throw new BrainchainComputeError('budget_refused');
    return envelope;
  }

  private async fence(tx: TransactionSql, input: { taskId: string; attemptId: string; avatarId: string; generation: number; leaseOwner: string; deadlineMs: number; promptHash: string },readPolicy=true): Promise<void> {
    await tx`SELECT id FROM brainchain_worker_tasks WHERE id=${input.taskId} FOR UPDATE`;
    const [live] = await tx`SELECT t.id,auth.approved_by,auth.observation_policy,auth.authority_policy_version,auth.authority_policy_digest FROM brainchain_worker_tasks t JOIN brainchain_task_attempts a ON a.task_id=t.id
      JOIN brainchain_worker_bindings w ON w.id=t.binding_id JOIN brainchain_execution_authorities auth ON auth.id=a.authority_id
      WHERE t.id=${input.taskId} AND t.avatar_id=${input.avatarId} AND t.canonical=true AND t.environment='testnet' AND t.chain_id=274630
      AND t.status=2 AND t.lease_generation=${input.generation} AND t.deadline_unix>EXTRACT(EPOCH FROM clock_timestamp())+300
      AND a.id=${input.attemptId} AND a.avatar_id=t.avatar_id AND a.binding_id=t.binding_id AND a.environment=t.environment AND a.chain_id=t.chain_id
      AND a.generation=${input.generation} AND a.lease_owner=${input.leaseOwner} AND a.purpose='execution' AND a.state='executing'
      AND a.prompt_hash=${input.promptHash} AND auth.prompt_hash=a.prompt_hash AND auth.revoked_at IS NULL
      AND auth.consumed_at IS NOT NULL AND auth.expires_at>clock_timestamp() AND w.requested_state IN ('running','draining')
      AND a.lease_until>clock_timestamp() AND a.lease_until>=${tx.typed(new Date(input.deadlineMs).toISOString(),25)}::timestamptz AND ${tx.typed(new Date(input.deadlineMs).toISOString(),25)}::timestamptz>clock_timestamp()`;
    if (!live) throw new BrainchainComputeError('execution_refused');
    assertConfiguredAuthorityPolicy({authorityPolicyVersion:live.authority_policy_version,authorityPolicyDigest:live.authority_policy_digest});
    if(readPolicy){const authorityEvidence=await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(input.deadlineMs,Date.now()+2000),observationPolicy:live.observation_policy});
    assertConfiguredAuthorityEvidence(authorityEvidence);
    const [finalClock]=await tx`SELECT clock_timestamp() AS now`;
    if(databaseDate(finalClock!.now).getTime()>=input.deadlineMs)throw new BrainchainComputeError('expired');
    await this.fence(tx,input,false);}
    if(String(live.approved_by).startsWith('owner-policy:')&&!this.workerFence)throw new BrainchainComputeError('execution_refused');
  }

  /** Reserves cost and creates one short-lived bearer capability for this exact attempt. */
  async reserve(raw: ReserveComputeInput): Promise<{ binding: IsolatedTaskBinding; capability: string }> {
    const input = reserveSchema.parse(raw);
    if (Buffer.byteLength(input.prompt, 'utf8') > 32768 || Buffer.byteLength(input.prompt, 'utf8') > input.maxInputTokens
      || input.deadlineMs <= Date.now() || input.deadlineMs > Date.now() + 120_000) throw new BrainchainComputeError('invalid_request');
    return this.database.begin(async tx => {
      await this.fence(tx, { ...input, promptHash: computeHash(input.prompt) });
      const envelope = await this.lockEnvelope(tx, input.envelopeId);
      await this.fence(tx, { ...input, promptHash: computeHash(input.prompt) });
      const [clock] = await tx`SELECT clock_timestamp() AS now`;
      if (envelope.state !== 'open' || databaseDate(envelope.expires_at) <= databaseDate(clock!.now) || input.deadlineMs > databaseDate(envelope.expires_at).getTime()
        || input.deadlineMs <= databaseDate(clock!.now).getTime()) throw new BrainchainComputeError('expired');
      const price = this.policies.get(`${envelope.provider}:${input.model}:${input.pricingVersion}`);
      if (!price || !this.adapters.has(envelope.provider) || input.maxInputTokens > price.maxInputTokens || input.maxOutputTokens > price.maxOutputTokens
        || requiredInputTokens(price, input.prompt) > input.maxInputTokens) throw new BrainchainComputeError('policy_refused');
      const maximum = tokenCost(price, input.maxInputTokens, input.maxOutputTokens);
      if (maximum <= 0n || BigInt(envelope.reserved_micros) + BigInt(envelope.uncertain_micros) + BigInt(envelope.settled_micros) + maximum > BigInt(envelope.limit_micros)) throw new BrainchainComputeError('budget_refused');
      await this.workerFence?.(tx,Object.freeze({...input,promptHash:computeHash(input.prompt),maximumMicros:maximum}));
      await this.fence(tx,{...input,promptHash:computeHash(input.prompt)});
      const [afterWorker]=await tx`SELECT clock_timestamp() AS now`;
      if(databaseDate(envelope.expires_at)<=databaseDate(afterWorker!.now)||input.deadlineMs<=databaseDate(afterWorker!.now).getTime())throw new BrainchainComputeError('expired');
      const callId = randomUUID(), reservationId = randomUUID(), capability = randomBytes(32).toString('hex');
      const promptHash = computeHash(input.prompt);
      await tx`INSERT INTO brainchain_compute_calls(id,reservation_id,envelope_id,avatar_id,task_id,attempt_id,generation,lease_owner,model,pricing_version,prompt_hash,prompt,max_input_tokens,max_output_tokens,input_overhead_tokens,input_rate,output_rate,request_micros,maximum_micros,capability_hash,deadline)
        VALUES(${callId},${reservationId},${envelope.id},${input.avatarId},${input.taskId},${input.attemptId},${input.generation},${input.leaseOwner},${input.model},${input.pricingVersion},${promptHash},${input.prompt},${input.maxInputTokens},${input.maxOutputTokens},${price.inputOverheadTokens},${price.inputMicrosPerMillion.toString()},${price.outputMicrosPerMillion.toString()},${price.requestMicros.toString()},${maximum.toString()},${computeHash(capability)},${tx.typed(new Date(input.deadlineMs).toISOString(),25)}::timestamptz)`;
      await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros+${maximum.toString()} WHERE id=${envelope.id}`;
      return { binding: Object.freeze({ jobId: envelope.job_id, avatarId: input.avatarId, taskId: input.taskId, attemptId: input.attemptId,
        generation: input.generation, reservationId, callId, model: input.model, promptHash, maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens, deadlineMs: input.deadlineMs }), capability };
    });
  }

  private callFence(call: Call) { return { taskId: call.task_id, attemptId: call.attempt_id, avatarId: call.avatar_id,
    generation: call.generation, leaseOwner: call.lease_owner, deadlineMs: databaseDate(call.deadline).getTime(), promptHash: call.prompt_hash }; }

  private async lookup(capability: string): Promise<Call> {
    if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) throw new BrainchainComputeError('capability_refused');
    const [call] = await this.database<Call[]>`SELECT * FROM brainchain_compute_calls WHERE capability_hash=${computeHash(capability)}`;
    if (!call) throw new BrainchainComputeError('capability_refused');
    return call;
  }

  private matches(call: Call, jobId: string, request: IsolatedTaskProxyRequest): boolean {
    const expected: IsolatedTaskBinding = { jobId, avatarId: call.avatar_id, taskId: call.task_id, attemptId: call.attempt_id,
      generation: call.generation, reservationId: call.reservation_id, callId: call.id, model: call.model, promptHash: call.prompt_hash,
      maxInputTokens: call.max_input_tokens, maxOutputTokens: call.max_output_tokens, deadlineMs: databaseDate(call.deadline).getTime() };
    return Object.keys(request).sort().join(',') === 'binding,prompt' && Object.keys(request.binding).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => request.binding[key as keyof IsolatedTaskBinding] === value)
      && request.prompt === call.prompt && computeHash(request.prompt) === call.prompt_hash;
  }

  /** A replay only observes the existing call. It never performs another adapter invocation. */
  async dispatch(capability: string, request: IsolatedTaskProxyRequest, signal: AbortSignal): Promise<ComputeReceipt> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new BrainchainComputeError('capability_refused');
    request = Object.freeze({ binding: Object.freeze({ ...parsed.data.binding }), prompt: parsed.data.prompt });
    const known = await this.lookup(capability);
    const admission = await this.database.begin(async tx => {
      await this.fence(tx, this.callFence(known));
      const envelope = await this.lockEnvelope(tx, known.envelope_id);
      const [call] = await tx<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${known.id} FOR UPDATE`;
      if (!call || !this.matches(call, envelope.job_id, request)) throw new BrainchainComputeError('capability_refused');
      await this.fence(tx, this.callFence(call));
      const [clock] = await tx`SELECT clock_timestamp() AS now`;
      if (signal.aborted || databaseDate(call.deadline) <= databaseDate(clock!.now) || databaseDate(envelope.expires_at) <= databaseDate(clock!.now) || envelope.state !== 'open') throw new BrainchainComputeError('expired');
      const price = this.policies.get(`${envelope.provider}:${call.model}:${call.pricing_version}`);
      if (!price || price.inputMicrosPerMillion.toString() !== call.input_rate || price.outputMicrosPerMillion.toString() !== call.output_rate
        || price.requestMicros.toString() !== call.request_micros || call.max_input_tokens > price.maxInputTokens
        || price.inputOverheadTokens !== call.input_overhead_tokens || requiredInputTokens(price, call.prompt) > call.max_input_tokens
        || call.max_output_tokens > price.maxOutputTokens || !this.adapters.has(envelope.provider)) throw new BrainchainComputeError('policy_refused');
      if (call.state !== 'reserved') return { call, envelope, provider: envelope.provider, dispatch: false };
      await this.verifyDispatchRoot(envelope, databaseDate(call.deadline).getTime(), signal);
      await this.workerFence?.(tx,Object.freeze({...this.callFence(call),envelopeId:call.envelope_id,maximumMicros:BigInt(call.maximum_micros)}));
      // Root reads can outlast a lease or cancellation while task/budget locks remain held.
      await this.fence(tx, this.callFence(call));
      const [ready] = await tx`SELECT clock_timestamp() AS now`;
      if (signal.aborted || databaseDate(call.deadline) <= databaseDate(ready!.now) || databaseDate(envelope.expires_at) <= databaseDate(ready!.now)) throw new BrainchainComputeError('expired');
      await tx`UPDATE brainchain_compute_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=${call.id}`;
      await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros-${call.maximum_micros},uncertain_micros=uncertain_micros+${call.maximum_micros} WHERE id=${envelope.id}`;
      return { call, envelope, provider: envelope.provider, dispatch: true };
    });
    if (!admission.dispatch) return this.status(capability);
    const { call } = admission;
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (signal.aborted || Date.now() >= databaseDate(call.deadline).getTime()) throw new BrainchainComputeError('expired');
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BrainchainComputeError('expired')); }, Math.max(1, databaseDate(call.deadline).getTime() - Date.now()));
        controller.signal.addEventListener('abort', () => reject(new BrainchainComputeError('expired')), { once: true });
      });
      void timeout.catch(() => {});
      const adapter = this.adapters.get(admission.provider)!;
      const frozen = Object.freeze({ callId: call.id, model: call.model, prompt: call.prompt,
        maxInputTokens: call.max_input_tokens, maxOutputTokens: call.max_output_tokens });
      // The committed liability stays uncertain if this final external authority check refuses.
      await this.verifyDispatchRoot(admission.envelope, databaseDate(call.deadline).getTime(), controller.signal);
      // Root I/O can outlast execution authority. Recheck after that asynchronous boundary.
      await this.database.begin(async tx => {
        await this.fence(tx, this.callFence(call));
        const envelope = await this.lockEnvelope(tx, call.envelope_id);
        const [current] = await tx<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${call.id} FOR UPDATE`;
        await this.workerFence?.(tx,Object.freeze({...this.callFence(call),envelopeId:call.envelope_id,maximumMicros:BigInt(call.maximum_micros)}));
        await this.fence(tx, this.callFence(call));
        const [clock] = await tx`SELECT clock_timestamp() AS now`;
        if (!current || current.state !== 'dispatched' || envelope.state !== 'open'
          || databaseDate(envelope.expires_at) <= databaseDate(clock!.now) || databaseDate(call.deadline) <= databaseDate(clock!.now) || controller.signal.aborted || signal.aborted) {
          throw new BrainchainComputeError('execution_refused');
        }
      });
      if (signal.aborted || controller.signal.aborted || Date.now() >= databaseDate(call.deadline).getTime()) throw new BrainchainComputeError('expired');
      const response = await Promise.race([adapter.generate(frozen, controller.signal), timeout]);
      if (controller.signal.aborted || Date.now() >= databaseDate(call.deadline).getTime() || !response || typeof response.text !== 'string'
        || !response.text.trim() || Buffer.byteLength(response.text, 'utf8') > 32768
        || !Number.isSafeInteger(response.inputTokens) || response.inputTokens! < 0 || response.inputTokens! > call.max_input_tokens
        || !Number.isSafeInteger(response.outputTokens) || response.outputTokens! < 1 || response.outputTokens! > call.max_output_tokens) throw new BrainchainComputeError('uncertain');
      const charged = tokenCost({ inputMicrosPerMillion: BigInt(call.input_rate), outputMicrosPerMillion: BigInt(call.output_rate), requestMicros: BigInt(call.request_micros) }, response.inputTokens!, response.outputTokens!);
      await this.settle(call, charged, response.text, response.inputTokens!, response.outputTokens!);
    } catch {
      await this.database`UPDATE brainchain_compute_calls SET state='uncertain',failure_code='provider_outcome_uncertain' WHERE id=${call.id} AND state='dispatched'`;
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort(); }
    return this.status(capability);
  }

  private async settle(call: Call, charged: bigint, output?: string, input?: number, tokens?: number, reconciliationRef?: string): Promise<void> {
    await this.database.begin(async tx => {
      await this.lockEnvelope(tx, call.envelope_id);
      const [current] = await tx<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${call.id} FOR UPDATE`;
      if (!current || !['dispatched', 'uncertain'].includes(current.state) || charged < 0n || charged > BigInt(current.maximum_micros)) throw new BrainchainComputeError('unavailable');
      await tx`UPDATE brainchain_compute_calls SET state='settled',charged_micros=${charged.toString()},output=${output ?? null},input_tokens=${input ?? null},output_tokens=${tokens ?? null},reconciliation_ref=${reconciliationRef ?? null} WHERE id=${call.id}`;
      await tx`UPDATE brainchain_compute_envelopes SET uncertain_micros=uncertain_micros-${call.maximum_micros},settled_micros=settled_micros+${charged.toString()} WHERE id=${call.envelope_id}`;
    });
  }

  /** The short-lived bearer permits status lookup, never another provider dispatch. */
  async status(capability: string): Promise<ComputeReceipt> {
    const call = await this.lookup(capability);
    if (databaseDate(call.deadline).getTime() <= Date.now()) throw new BrainchainComputeError('expired');
    const receipt: ComputeReceipt = { callId: call.id, state: call.state, maximumMicros: call.maximum_micros, chargedMicros: call.charged_micros };
    if (call.state === 'settled' && call.output !== null && call.input_tokens !== null && call.output_tokens !== null) {
      try {
        await this.database.begin(tx => this.fence(tx, this.callFence(call)));
        receipt.response = { callId: call.id, model: call.model, promptHash: call.prompt_hash, text: call.output,
          inputTokens: call.input_tokens, outputTokens: call.output_tokens };
      } catch { /* Accounting survives lease loss; stale task output never leaves the proxy. */ }
    }
    return receipt;
  }

  /** Root recovery can inspect accounting after capability expiry, without releasing task output. */
  async inspectCall(callId: string): Promise<Omit<ComputeReceipt, 'response'>> {
    uuid.parse(callId);
    const [call] = await this.database<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${callId}`;
    if (!call) throw new BrainchainComputeError('unavailable');
    return { callId: call.id, state: call.state, maximumMicros: call.maximum_micros, chargedMicros: call.charged_micros };
  }

  /** Trusted transport binds the opaque bearer without exposing a provider endpoint. */
  client(capability: string): IsolatedTaskProxy {
    return Object.freeze({ generate: async (request: IsolatedTaskProxyRequest, signal: AbortSignal) => {
      const receipt = await this.dispatch(capability, request, signal);
      if (!receipt.response) throw new BrainchainComputeError(receipt.state === 'uncertain' || receipt.state === 'dispatched' ? 'uncertain' : 'execution_refused');
      return receipt.response;
    } });
  }

  /** Root reconciliation charges the conservative maximum; it never releases an unknown charge. */
  async settleFullCost(callId: string, reconciliationRef: string): Promise<void> {
    uuid.parse(callId); if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(reconciliationRef)) throw new BrainchainComputeError('invalid_request');
    const [call] = await this.database<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${callId}`;
    if (!call) throw new BrainchainComputeError('unavailable');
    await this.settle(call, BigInt(call.maximum_micros), undefined, undefined, undefined, reconciliationRef);
  }

  /** Only an undispatched reservation can release its local hold without charge evidence. */
  async cancelReserved(callId: string): Promise<void> {
    uuid.parse(callId);
    await this.database.begin(async tx => {
      const [known] = await tx<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${callId}`;
      if (!known) throw new BrainchainComputeError('unavailable');
      await this.lockEnvelope(tx, known.envelope_id);
      const [call] = await tx<Call[]>`SELECT * FROM brainchain_compute_calls WHERE id=${callId} FOR UPDATE`;
      if (!call || call.state !== 'reserved') throw new BrainchainComputeError('uncertain');
      await tx`UPDATE brainchain_compute_calls SET state='canceled',charged_micros=0 WHERE id=${callId}`;
      await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros-${call.maximum_micros} WHERE id=${call.envelope_id}`;
    });
  }

  /** Root reconciles this returned amount against its original ledger reservation separately. */
  async closeEnvelope(envelopeId: string): Promise<{ releasedMicros: string; reconciliationId: string }> {
    uuid.parse(envelopeId);
    return this.database.begin(async tx => {
      const envelope = await this.lockEnvelope(tx, envelopeId);
      const totals=assertComputeAccounting(envelope,await lockComputeAccounting(tx,[envelopeId]));
      if(totals.reserved!==0n||totals.uncertain!==0n)throw new BrainchainComputeError('uncertain');
      if (envelope.state === 'closed' && envelope.reconciliation_id) return {
        releasedMicros: (BigInt(envelope.limit_micros) - BigInt(envelope.settled_micros)).toString(), reconciliationId: envelope.reconciliation_id };
      if (envelope.state !== 'open' || BigInt(envelope.reserved_micros) !== 0n || BigInt(envelope.uncertain_micros) !== 0n) throw new BrainchainComputeError('uncertain');
      const released = BigInt(envelope.limit_micros) - BigInt(envelope.settled_micros), reconciliationId = randomUUID();
      await tx`UPDATE brainchain_compute_envelopes SET state='closed',closed_at=clock_timestamp(),reconciliation_id=${reconciliationId} WHERE id=${envelopeId}`;
      await tx`UPDATE brainchain_compute_budgets SET allocated_micros=allocated_micros-${released.toString()} WHERE id=${envelope.budget_id}`;
      return { releasedMicros: released.toString(), reconciliationId };
    });
  }
}
