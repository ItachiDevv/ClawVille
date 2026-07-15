/**
 * OpenAI Text Generation Provider Plugin for ElizaOS v2
 *
 * Provides TEXT_SMALL / TEXT_LARGE for all non-OpenClaw runtimes. As of the
 * InferenceRouter refactor this plugin NO LONGER talks to OpenAI directly and no
 * longer reads a global base URL — it delegates every call to the shared
 * `InferenceRouter`, passing this runtime's ROUTE (teacher / fleet / hosted-user /
 * default) and the SIZE (small/large). The router owns endpoint selection, per-box
 * config, health-based failover, and metering. See `../inference/`.
 *
 * Priority 95 keeps it immediately below the OpenClaw gateway plugin (100):
 *
 *   OpenClaw override (100) ─► wins when a gateway is configured (BYO agents)
 *   OpenAI text (95) ─────────► default for all other runtimes → InferenceRouter
 *
 * Route is set per-runtime via `config.route` (assigned by the orchestrator from
 * the agent's type + house flag). Unset ⇒ 'default' (→ OpenAI), unchanged from
 * before. Model selection now lives on the ROUTER'S ENDPOINTS, not here:
 * `config.forceSize` (used by the Pro preset) forces the large model on BOTH
 * handlers; `config.smallModel/largeModel/model` are retained for API
 * compatibility but no longer influence routing (endpoints define the models).
 *
 * EMBEDDINGS are unaffected — they go through openai-embedding-provider
 * (text-embedding-3-small, 1536-dim), still pinned to OpenAI.
 */

import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
} from '@elizaos/core';
import { getInferenceRouter } from '../inference/inference-config';
import type { InferenceRoute, InferenceSize } from '../inference/inference-router';

export interface OpenAITextConfig {
  /** @deprecated Auth now lives on the router's `openai` endpoint (OPENAI_API_KEY). */
  apiKey?: string;
  /** @deprecated Model selection moved to router endpoints. Retained for API compat. */
  smallModel?: string;
  /** @deprecated Model selection moved to router endpoints. Retained for API compat. */
  largeModel?: string;
  /** @deprecated Superseded by `forceSize`. Retained for API compat. */
  model?: string;
  /** Default max output tokens if not supplied by caller. */
  defaultMaxTokens?: number;
  /** Default temperature if not supplied. */
  defaultTemperature?: number;
  /**
   * Consumer class for THIS runtime — decides which ordered endpoint list the
   * router walks. Assigned by the orchestrator (agent type + house flag).
   * Absent ⇒ 'default' (OpenAI), identical to pre-router behavior.
   */
  route?: InferenceRoute;
  /**
   * Force BOTH handlers to request the endpoint's LARGE model (the Pro preset:
   * collaboration runtimes that benefit from the larger model everywhere).
   */
  forceSize?: InferenceSize;
}

async function generate(
  prompt: string,
  params: Partial<GenerateTextParams>,
  config: OpenAITextConfig,
  size: InferenceSize,
): Promise<string> {
  const maxTokens =
    (params as any)?.maxTokens ??
    (params as any)?.maxOutputTokens ??
    config.defaultMaxTokens ??
    1000;

  const temperature =
    (params as any)?.temperature ?? config.defaultTemperature ?? 0.7;

  const stopSequences: string[] = Array.isArray((params as any)?.stopSequences)
    ? ((params as any).stopSequences as string[])
    : [];

  const localAttemptTimeoutMs =
    typeof (params as any)?.localAttemptTimeoutMs === 'number'
      ? ((params as any).localAttemptTimeoutMs as number)
      : undefined;

  const { text } = await getInferenceRouter().generateText({
    route: config.route ?? 'default',
    size: config.forceSize ?? size,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    maxTokens,
    stopSequences,
    localAttemptTimeoutMs,
  });
  return text;
}

/**
 * Creates an ElizaOS plugin that provides TEXT_SMALL + TEXT_LARGE via the
 * InferenceRouter. Default priority 95 (immediately below the OpenClaw gateway).
 * TEXT_SMALL → router size 'small', TEXT_LARGE → router size 'large' (unless
 * `config.forceSize` pins one for both).
 */
export function createOpenAITextPlugin(config: OpenAITextConfig = {}): Plugin {
  const makeHandler =
    (size: InferenceSize) =>
    async (
      _runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      const prompt = (params as any)?.prompt ?? '';
      if (!prompt) {
        throw new Error('[OpenAIText] Missing prompt');
      }
      return generate(prompt, params, config, size);
    };

  const routeLabel = config.route ?? 'default';
  return {
    name: 'openai-text-provider',
    description: `InferenceRouter TEXT_SMALL/TEXT_LARGE (route=${routeLabel}, priority 95)`,
    models: {
      [ModelType.TEXT_SMALL]: makeHandler('small'),
      [ModelType.TEXT_LARGE]: makeHandler('large'),
    },
    priority: 95,
  };
}

/** Preset for collaboration runtimes that benefit from the large model on BOTH sizes. */
export function createOpenAIProTextPlugin(
  config: Omit<OpenAITextConfig, 'model' | 'smallModel' | 'largeModel' | 'forceSize'> = {},
): Plugin {
  return createOpenAITextPlugin({
    ...config,
    forceSize: 'large',
  });
}
