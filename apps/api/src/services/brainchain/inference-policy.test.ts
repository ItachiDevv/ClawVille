import { expect, test } from 'bun:test';
import { COMPUTE_JOB_CAP_MICROS, computeHash, freezePricePolicy, requiredInputTokens, tokenCost, type ComputePricePolicy } from './inference-policy';

const policy: ComputePricePolicy = { provider: 'openai', model: 'fixture-model', version: 'fixture-v1',
  inputMicrosPerMillion: 3n, outputMicrosPerMillion: 7n, requestMicros: 1n,
  maxInputTokens: 32768, maxOutputTokens: 8192, outputIncludesReasoning: true, inputTokenBound: 'utf8-bytes', inputOverheadTokens: 16 };
test('integer micro-USD cost rounds every positive token component upward', () => {
  expect(tokenCost(policy, 1, 1)).toBe(3n);
  expect(tokenCost(policy, 1_000_000, 1_000_000)).toBe(11n);
  expect(COMPUTE_JOB_CAP_MICROS).toBe(10_000_000n);
  expect(computeHash(' exact \n')).not.toBe(computeHash('exact'));
  expect(requiredInputTokens(policy, '😀')).toBe(20);
});
test('unknown reasoning billing, token semantics, provider, negative rates, or mutable policy cannot enter dispatch', () => {
  const copy = freezePricePolicy(policy);
  expect(Object.isFrozen(copy)).toBe(true);
  for (const change of [{ outputIncludesReasoning: false }, { inputTokenBound: 'chars-divided-by-four' },
    { provider: 'other' }, { inputMicrosPerMillion: -1n }, { maxOutputTokens: 8193 }]) {
    expect(() => freezePricePolicy({ ...policy, ...change } as ComputePricePolicy)).toThrow('policy_refused');
  }
  expect(() => tokenCost(policy, 0.5, 1)).toThrow('policy_refused');
});
