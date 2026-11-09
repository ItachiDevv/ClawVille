import { describe, expect, test } from 'bun:test';
import {
  OWN_AI_DAILY_LIMIT_MAX_CENTS,
  OWN_AI_DAILY_LIMIT_MIN_CENTS,
  OWN_AI_MODEL_PRICES,
  OWN_AI_PROVIDER_SPECS,
  OWN_AI_PROVIDERS,
  OWN_AI_RECOMMENDED_MODELS,
  OWN_AI_SPEEDS_SECONDS,
  OWN_AI_UNKNOWN_MODEL_PRICE,
  bareOwnAiModelId,
  estimateOwnAiMicroUsd,
  isOwnAiDailyLimitCents,
  isOwnAiModelId,
  isOwnAiReasoningModel,
  isOwnAiSpeedSeconds,
  ownAiLimitMicroUsd,
  ownAiModelPrice,
} from './own-ai';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('provider specs', () => {
  test('every base URL is a fixed https host', () => {
    expect(OWN_AI_PROVIDER_SPECS.openai.baseUrl('x')).toBe('https://api.openai.com/v1');
    expect(OWN_AI_PROVIDER_SPECS.anthropic.baseUrl('x')).toBe('https://api.anthropic.com');
    expect(OWN_AI_PROVIDER_SPECS.openrouter.baseUrl('x')).toBe('https://openrouter.ai/api/v1');
    expect(OWN_AI_PROVIDER_SPECS.usepod.baseUrl(UUID)).toBe(`https://api.usepod.ai/proxy/${UUID}/v1`);
  });

  test('usepod refuses a token that is not a UUID (no path injection)', () => {
    for (const bad of ['../v1/register', `${UUID}/../x`, `${UUID}?a=b`, 'abc', '']) {
      expect(() => OWN_AI_PROVIDER_SPECS.usepod.baseUrl(bad)).toThrow('invalid_key');
    }
  });

  test('key patterns', () => {
    const tail = 'A'.repeat(24);
    expect(OWN_AI_PROVIDER_SPECS.openai.keyPattern.test(`sk-${tail}`)).toBe(true);
    expect(OWN_AI_PROVIDER_SPECS.openai.keyPattern.test(`sk-${'A'.repeat(19)}`)).toBe(false);
    expect(OWN_AI_PROVIDER_SPECS.openai.keyPattern.test(`sk-${tail} x`)).toBe(false);
    expect(OWN_AI_PROVIDER_SPECS.anthropic.keyPattern.test(`sk-ant-${tail}`)).toBe(true);
    expect(OWN_AI_PROVIDER_SPECS.anthropic.keyPattern.test(`sk-${tail}`)).toBe(false);
    expect(OWN_AI_PROVIDER_SPECS.openrouter.keyPattern.test(`sk-or-${tail}`)).toBe(true);
    expect(OWN_AI_PROVIDER_SPECS.openrouter.keyPattern.test(`sk-${tail}`)).toBe(false);
    expect(OWN_AI_PROVIDER_SPECS.usepod.keyPattern.test(UUID)).toBe(true);
    expect(OWN_AI_PROVIDER_SPECS.usepod.keyPattern.test(`sk-${tail}`)).toBe(false);
    for (const p of OWN_AI_PROVIDERS) expect(OWN_AI_PROVIDER_SPECS[p].id).toBe(p);
  });
});

describe('bounds', () => {
  test('speeds and floor', () => {
    expect([...OWN_AI_SPEEDS_SECONDS]).toEqual([25, 20, 15, 10]);
    expect(isOwnAiSpeedSeconds(10)).toBe(true);
    expect(isOwnAiSpeedSeconds(5)).toBe(false);
    expect(isOwnAiSpeedSeconds(30)).toBe(false);
    expect(isOwnAiSpeedSeconds('25')).toBe(false);
  });

  test('daily limit bounds', () => {
    expect(isOwnAiDailyLimitCents(OWN_AI_DAILY_LIMIT_MIN_CENTS)).toBe(true);
    expect(isOwnAiDailyLimitCents(OWN_AI_DAILY_LIMIT_MAX_CENTS)).toBe(true);
    expect(isOwnAiDailyLimitCents(9)).toBe(false);
    expect(isOwnAiDailyLimitCents(50_001)).toBe(false);
    expect(isOwnAiDailyLimitCents(10.5)).toBe(false);
    expect(isOwnAiDailyLimitCents(Number.NaN)).toBe(false);
  });

  test('model id pattern', () => {
    expect(isOwnAiModelId('deepseek/deepseek-chat-v3.1')).toBe(true);
    expect(isOwnAiModelId('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isOwnAiModelId('a'.repeat(129))).toBe(false);
    expect(isOwnAiModelId('gpt 4o')).toBe(false);
    expect(isOwnAiModelId('gpt-4o\n')).toBe(false);
    expect(isOwnAiModelId('')).toBe(false);
  });
});

describe('price lookup and cost math', () => {
  test('strips the vendor prefix and the :variant suffix', () => {
    expect(bareOwnAiModelId('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(bareOwnAiModelId('openai/gpt-oss-120b:free')).toBe('gpt-oss-120b');
    expect(ownAiModelPrice('google/gemini-2.5-pro')).toEqual(OWN_AI_MODEL_PRICES['gemini-2.5-pro']!);
    expect(ownAiModelPrice('claude-sonnet-4-5-20250929')).toEqual(OWN_AI_MODEL_PRICES['claude-sonnet-4-5']!);
  });

  test('unknown model uses the conservative price', () => {
    expect(ownAiModelPrice('some/new-model')).toEqual(OWN_AI_UNKNOWN_MODEL_PRICE);
    expect(OWN_AI_UNKNOWN_MODEL_PRICE).toEqual({ inputPerM: 15, outputPerM: 75 });
    expect(estimateOwnAiMicroUsd('some/new-model', 1_000_000, 0)).toBe(15_000_000);
  });

  test('every recommended model has a known price', () => {
    for (const m of OWN_AI_RECOMMENDED_MODELS) expect(ownAiModelPrice(m.model)).not.toBe(OWN_AI_UNKNOWN_MODEL_PRICE);
  });

  test('integer micro-USD: 1M gpt-4o input = $2.50', () => {
    expect(estimateOwnAiMicroUsd('gpt-4o', 1_000_000, 0)).toBe(2_500_000);
    expect(estimateOwnAiMicroUsd('gpt-4o-mini', 3000, 200)).toBe(570); // 3000*.15 + 200*.6
    expect(Number.isInteger(estimateOwnAiMicroUsd('deepseek-r1', 3333, 777))).toBe(true);
    expect(estimateOwnAiMicroUsd('gpt-4o', -5, Number.NaN)).toBe(0);
    expect(ownAiLimitMicroUsd(10)).toBe(100_000);
  });

  test('reasoning flag', () => {
    expect(isOwnAiReasoningModel('openai', 'gpt-5.1')).toBe(true);
    expect(isOwnAiReasoningModel('openai', 'gpt-4.1')).toBe(false);
    expect(isOwnAiReasoningModel('openai', 'o4-mini')).toBe(true);
    expect(isOwnAiReasoningModel('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(isOwnAiReasoningModel('anthropic', 'claude-sonnet-4-5')).toBe(false);
  });
});
