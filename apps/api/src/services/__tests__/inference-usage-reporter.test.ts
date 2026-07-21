import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EndpointStats,
  InferenceUsageSnapshot,
} from '@clawville/agent-runtime';
import {
  inferenceUsageReporterSeams,
  resolveInferenceUsageReportGate,
  runInferenceUsageReportOnce,
  stopInferenceUsageReporter,
} from '../inference-usage-reporter';

const originalSnapshotProvider = inferenceUsageReporterSeams.snapshotProvider;
const originalStatsProvider = inferenceUsageReporterSeams.statsProvider;
const originalSender = inferenceUsageReporterSeams.sender;
const originalClawvilleEnv = process.env.CLAWVILLE_ENV;
const originalReportEnv = process.env.INFERENCE_USAGE_REPORT;

function snapshot(
  rows: InferenceUsageSnapshot['rows'] = [],
  blackouts: Record<string, number> = {},
): InferenceUsageSnapshot {
  return { rows, blackouts };
}

function endpointStats(id: string, breakerOpen: boolean): EndpointStats {
  return {
    id,
    kind: id === 'openai' ? 'cloud' : 'local',
    requests: 0,
    successes: 0,
    failures: 0,
    lastLatencyMs: 0,
    breakerOpen,
    consecutiveFailures: 0,
    inflight: 0,
  };
}

beforeEach(() => {
  stopInferenceUsageReporter();
  process.env.CLAWVILLE_ENV = 'production';
  delete process.env.INFERENCE_USAGE_REPORT;
  inferenceUsageReporterSeams.snapshotProvider = () => snapshot();
  inferenceUsageReporterSeams.statsProvider = () => [];
  inferenceUsageReporterSeams.sender = async () => {};
});

afterEach(() => {
  stopInferenceUsageReporter();
  inferenceUsageReporterSeams.snapshotProvider = originalSnapshotProvider;
  inferenceUsageReporterSeams.statsProvider = originalStatsProvider;
  inferenceUsageReporterSeams.sender = originalSender;
  if (originalClawvilleEnv === undefined) delete process.env.CLAWVILLE_ENV;
  else process.env.CLAWVILLE_ENV = originalClawvilleEnv;
  if (originalReportEnv === undefined) delete process.env.INFERENCE_USAGE_REPORT;
  else process.env.INFERENCE_USAGE_REPORT = originalReportEnv;
});

describe('inference usage report gate', () => {
  it('defaults on only in production and honors exact on/off overrides', () => {
    expect(
      resolveInferenceUsageReportGate({ CLAWVILLE_ENV: 'staging' }).enabled,
    ).toBe(false);
    expect(
      resolveInferenceUsageReportGate({
        CLAWVILLE_ENV: 'staging',
        INFERENCE_USAGE_REPORT: 'on',
      }).enabled,
    ).toBe(true);
    expect(
      resolveInferenceUsageReportGate({ CLAWVILLE_ENV: 'production' }).enabled,
    ).toBe(true);
    expect(
      resolveInferenceUsageReportGate({
        CLAWVILLE_ENV: 'production',
        INFERENCE_USAGE_REPORT: 'off',
      }).enabled,
    ).toBe(false);
    expect(
      resolveInferenceUsageReportGate({
        CLAWVILLE_ENV: 'staging',
        INFERENCE_USAGE_REPORT: 'true',
      }).enabled,
    ).toBe(false);
  });
});

describe('inference usage report tick', () => {
  it('subtracts the previous successful cumulative snapshot on the second run', async () => {
    const snapshots = [
      snapshot(
        [
          {
            route: 'teacher',
            endpointId: 'openai',
            model: 'gpt-4o-mini',
            calls: 2,
            inTokens: 100,
            outTokens: 50,
          },
          {
            route: 'fleet',
            endpointId: 'johns-pc',
            model: 'qwen3:14b',
            calls: 1,
            inTokens: 20,
            outTokens: 10,
          },
        ],
        { fleet: 1 },
      ),
      snapshot(
        [
          {
            route: 'teacher',
            endpointId: 'openai',
            model: 'gpt-4o-mini',
            calls: 5,
            inTokens: 300,
            outTokens: 150,
          },
          {
            route: 'fleet',
            endpointId: 'johns-pc',
            model: 'qwen3:14b',
            calls: 3,
            inTokens: 50,
            outTokens: 20,
          },
        ],
        { fleet: 3 },
      ),
    ];
    const messages: string[] = [];
    inferenceUsageReporterSeams.snapshotProvider = () => snapshots.shift()!;
    inferenceUsageReporterSeams.sender = async (message) => {
      messages.push(message);
    };

    await runInferenceUsageReportOnce();
    await runInferenceUsageReportOnce();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('since boot (production)');
    expect(messages[0]).toContain('OpenAI (paid): 2 calls · in 100 · out 50');
    expect(messages[0]).toContain('johns-pc: 1 call');
    expect(messages[0]).toContain('1 calls failed on ALL endpoints (fleet)');
    expect(messages[1]).toContain('last hour (production)');
    expect(messages[1]).toContain('OpenAI (paid): 3 calls · in 200 · out 100');
    expect(messages[1]).toContain('johns-pc: 2 calls');
    expect(messages[1]).toContain('2 calls failed on ALL endpoints (fleet)');
    expect(messages[1]).not.toContain('in 300 · out 150');
  });

  it('sends the zero-activity heartbeat', async () => {
    const sender = mock(async (_message: string) => {});
    inferenceUsageReporterSeams.sender = sender;

    await runInferenceUsageReportOnce();

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toBe(
      '📊 ClawVille inference — since boot (production)\n\n0 inference calls this hour.',
    );
  });

  it('estimates known OpenAI models and leaves unknown-model tokens unpriced', async () => {
    const messages: string[] = [];
    inferenceUsageReporterSeams.sender = async (message) => {
      messages.push(message);
    };
    inferenceUsageReporterSeams.snapshotProvider = () =>
      snapshot([
        {
          route: 'teacher',
          endpointId: 'openai',
          model: 'gpt-4o-mini',
          calls: 1,
          inTokens: 1_000_000,
          outTokens: 1_000_000,
        },
      ]);

    await runInferenceUsageReportOnce();
    expect(messages[0]).toContain('est. $0.750000');

    stopInferenceUsageReporter();
    inferenceUsageReporterSeams.snapshotProvider = () =>
      snapshot([
        {
          route: 'default',
          endpointId: 'openai',
          model: 'unknown-model',
          calls: 1,
          inTokens: 12,
          outTokens: 34,
        },
      ]);
    await runInferenceUsageReportOnce();
    expect(messages[1]).toContain(
      'default / unknown-model: 1 call · in 12 · out 34',
    );
    expect(messages[1]).not.toContain('$');
  });

  it('shows only non-zero blackout and currently-open breaker warnings', async () => {
    const messages: string[] = [];
    inferenceUsageReporterSeams.snapshotProvider = () =>
      snapshot([], { teacher: 0, fleet: 2 });
    inferenceUsageReporterSeams.statsProvider = () => [
      endpointStats('openai', false),
      endpointStats('johns-pc', true),
    ];
    inferenceUsageReporterSeams.sender = async (message) => {
      messages.push(message);
    };

    await runInferenceUsageReportOnce();

    expect(messages[0]).toContain('Warnings:');
    expect(messages[0]).toContain(
      '⚠️ 2 calls failed on ALL endpoints (fleet)',
    );
    expect(messages[0]).toContain('⚠️ breaker open: johns-pc');
    expect(messages[0]).not.toContain('ALL endpoints (teacher)');

    stopInferenceUsageReporter();
    inferenceUsageReporterSeams.snapshotProvider = () => snapshot();
    inferenceUsageReporterSeams.statsProvider = () => [
      endpointStats('johns-pc', false),
    ];
    await runInferenceUsageReportOnce();
    expect(messages[1]).not.toContain('Warnings:');
    expect(messages[1]).not.toContain('⚠️');
  });

  it('swallows sender failures and retries the same since-boot window', async () => {
    const report = snapshot([
      {
        route: 'fleet',
        endpointId: '7900xtx-desktop',
        model: 'qwen3.6:27b',
        calls: 2,
        inTokens: 10,
        outTokens: 20,
      },
    ]);
    const messages: string[] = [];
    let attempts = 0;
    inferenceUsageReporterSeams.snapshotProvider = () => report;
    inferenceUsageReporterSeams.sender = async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error('telegram unavailable');
      messages.push(message);
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      await expect(runInferenceUsageReportOnce()).resolves.toBeUndefined();
      await expect(runInferenceUsageReportOnce()).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }

    expect(messages[0]).toContain('since boot (production)');
    expect(messages[0]).toContain('7900xtx-desktop: 2 calls');
  });
});
