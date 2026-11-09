import { createHash } from 'node:crypto';

export type ComputeProvider = 'openai' | 'openrouter';
export const COMPUTE_JOB_CAP_MICROS = 10_000_000n;
export class BrainchainComputeError extends Error {
  constructor(readonly code: 'invalid_request' | 'policy_refused' | 'budget_refused' | 'capability_refused' | 'execution_refused' | 'expired' | 'uncertain' | 'unavailable') {
    super(`BrainChain compute refused: ${code}`); this.name = 'BrainchainComputeError';
  }
}
/** Trusted deployment policy. No task/client endpoint can supply or replace it. */
export interface ComputePricePolicy {
  readonly provider: ComputeProvider;
  readonly model: string;
  readonly version: string;
  readonly inputMicrosPerMillion: bigint;
  readonly outputMicrosPerMillion: bigint;
  readonly requestMicros: bigint;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly outputIncludesReasoning: true;
  readonly inputTokenBound: 'utf8-bytes';
  /** Reviewed upper bound for every provider message/frame/system wrapper outside prompt bytes. */
  readonly inputOverheadTokens: number;
}
export function computeHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function requiredInputTokens(policy: Pick<ComputePricePolicy, 'inputOverheadTokens'>, prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8') + policy.inputOverheadTokens;
}
export function tokenCost(policy: Pick<ComputePricePolicy, 'inputMicrosPerMillion' | 'outputMicrosPerMillion' | 'requestMicros'>, input: number, output: number): bigint {
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) throw new BrainchainComputeError('policy_refused');
  return (BigInt(input) * policy.inputMicrosPerMillion + 999_999n) / 1_000_000n
    + (BigInt(output) * policy.outputMicrosPerMillion + 999_999n) / 1_000_000n + policy.requestMicros;
}
export function freezePricePolicy(policy: ComputePricePolicy): Readonly<ComputePricePolicy> {
  if (!['openai', 'openrouter'].includes(policy.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(policy.model)
    || !/^[a-zA-Z0-9_-]{1,96}$/.test(policy.version) || policy.outputIncludesReasoning !== true || policy.inputTokenBound !== 'utf8-bytes'
    || !Number.isSafeInteger(policy.maxInputTokens) || policy.maxInputTokens < 1 || policy.maxInputTokens > 131072
    || !Number.isSafeInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 1 || policy.maxOutputTokens > 8192
    || !Number.isSafeInteger(policy.inputOverheadTokens) || policy.inputOverheadTokens < 0 || policy.inputOverheadTokens > 8192
    || [policy.inputMicrosPerMillion, policy.outputMicrosPerMillion, policy.requestMicros].some(rate => typeof rate !== 'bigint' || rate < 0n || rate > COMPUTE_JOB_CAP_MICROS * 1_000_000n)) {
    throw new BrainchainComputeError('policy_refused');
  }
  return Object.freeze({ ...policy });
}
