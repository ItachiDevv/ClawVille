/**
 * Ultrathink Provider Plugin for ElizaOS
 *
 * Intercepts TEXT_SMALL and TEXT_LARGE model calls, routing them through
 * the Anthropic SDK with extended thinking enabled. Falls back to plain
 * generation if the thinking call fails.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
} from '@elizaos/core';
import { type ThinkingEffort, THINKING_BUDGET } from '@elizapets/shared';

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

export interface UltrathinkConfig {
  effort: ThinkingEffort;
  enableThinkTool?: boolean;
  model?: string;       // default: 'claude-haiku-4-5-20251001'
  apiKey?: string;      // fallback to process.env.ANTHROPIC_API_KEY
  maxTokens?: number;   // response token cap (separate from thinking budget)
}

/** Response-token caps per effort level (excludes thinking budget). */
const RESPONSE_TOKEN_CAP: Record<ThinkingEffort, number> = {
  low: 500,
  medium: 1000,
  high: 1500,
  max: 2000,
};

/** Maximum think-tool loop iterations to prevent runaway calls. */
const MAX_THINK_ITERATIONS = 5;

/* ------------------------------------------------------------------ */
/*  Think tool definition                                             */
/* ------------------------------------------------------------------ */

const THINK_TOOL = {
  name: 'think',
  description:
    'Use this tool to think step-by-step about a complex question before answering.',
  input_schema: {
    type: 'object' as const,
    properties: {
      thought: {
        type: 'string' as const,
        description: 'Your reasoning process',
      },
    },
    required: ['thought'],
  },
};

/* ------------------------------------------------------------------ */
/*  Core generation helpers                                           */
/* ------------------------------------------------------------------ */

function resolveModel(config: UltrathinkConfig): string {
  return config.model ?? 'claude-haiku-4-5-20251001';
}

function createClient(config: UltrathinkConfig): Anthropic {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('[Ultrathink] Missing ANTHROPIC_API_KEY');
  }
  return new Anthropic({ apiKey });
}

/**
 * Generate a response using Anthropic extended thinking.
 * Optionally loops over the "think" tool if enabled.
 */
async function generateWithThinking(
  config: UltrathinkConfig,
  prompt: string,
): Promise<string> {
  const client = createClient(config);
  const model = resolveModel(config);
  const budget = THINKING_BUDGET[config.effort];
  const responseCap = config.maxTokens ?? RESPONSE_TOKEN_CAP[config.effort];
  const maxTokens = budget + responseCap;

  console.log(
    `[Ultrathink] effort=${config.effort} budget=${budget} model=${model}`,
  );

  const tools = config.enableThinkTool ? [THINK_TOOL] : undefined;

  // Build the initial messages array
  let messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt },
  ];

  let response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'enabled', budget_tokens: budget },
    messages,
    ...(tools ? { tools } : {}),
  } as any);

  // Think-tool loop: if the model invokes the think tool, feed results back
  if (config.enableThinkTool) {
    let iteration = 0;
    while (
      response.stop_reason === 'tool_use' &&
      iteration < MAX_THINK_ITERATIONS
    ) {
      iteration++;
      console.log(`[Ultrathink] Think tool iteration ${iteration}`);

      // Find the think tool_use block
      const toolUseBlock = response.content.find(
        (b: any) => b.type === 'tool_use' && b.name === 'think',
      ) as any;

      if (!toolUseBlock) break;

      // Append assistant turn + tool result
      messages = [
        ...messages,
        { role: 'assistant', content: response.content as any },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: 'Thinking noted. Continue with your response.',
            },
          ],
        },
      ] as any;

      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'enabled', budget_tokens: budget },
        messages,
        ...(tools ? { tools } : {}),
      } as any);
    }
  }

  // Extract text blocks from the final response
  const text = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  return text;
}

/**
 * Plain fallback — same model, no thinking parameter.
 * Used when the thinking call fails.
 */
async function generatePlain(
  config: UltrathinkConfig,
  prompt: string,
): Promise<string> {
  const client = createClient(config);
  const model = resolveModel(config);
  const responseCap = config.maxTokens ?? RESPONSE_TOKEN_CAP[config.effort];

  console.log(`[Ultrathink] Fallback plain generation model=${model}`);

  const response = await client.messages.create({
    model,
    max_tokens: responseCap,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => {
      if (b.type === 'text') return b.text;
      return '';
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/*  Plugin factory                                                    */
/* ------------------------------------------------------------------ */

/**
 * Creates an ElizaOS plugin that intercepts TEXT_SMALL and TEXT_LARGE
 * model calls, routing them through Anthropic with extended thinking.
 */
export function createUltrathinkProviderPlugin(
  config: UltrathinkConfig,
): Plugin {
  const handler = async (
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
  ): Promise<string> => {
    const prompt = params.prompt;
    try {
      return await generateWithThinking(config, prompt);
    } catch (err) {
      console.error(
        '[Ultrathink] Thinking generation failed, falling back to plain:',
        err instanceof Error ? err.message : err,
      );
      return generatePlain(config, prompt);
    }
  };

  return {
    name: 'ultrathink-provider',
    description: `Anthropic provider with extended thinking (effort=${config.effort})`,
    models: {
      [ModelType.TEXT_SMALL]: handler,
      [ModelType.TEXT_LARGE]: handler,
    },
    priority: 90, // under OpenClaw (100), over default Anthropic (~0)
  };
}

/* ------------------------------------------------------------------ */
/*  Presets                                                           */
/* ------------------------------------------------------------------ */

export const ULTRATHINK_PRESETS = {
  buildingAgent: { effort: 'high' as ThinkingEffort, enableThinkTool: true },
  petAgent: { effort: 'medium' as ThinkingEffort, enableThinkTool: false },
  npcAmbient: { effort: 'low' as ThinkingEffort, enableThinkTool: false },
  deepReasoning: { effort: 'max' as ThinkingEffort, enableThinkTool: true },
} satisfies Record<string, UltrathinkConfig>;
