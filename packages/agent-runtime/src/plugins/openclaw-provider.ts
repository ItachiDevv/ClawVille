/**
 * OpenClaw Provider Plugin for ElizaOS
 *
 * Routes TEXT_GENERATION (TEXT_SMALL / TEXT_LARGE) through an external
 * OpenClaw gateway instead of Anthropic/OpenAI. Keeps TEXT_EMBEDDING
 * on the default provider so memory/RAG still works.
 */
import { ModelType, type Plugin, type IAgentRuntime, type GenerateTextParams } from '@elizaos/core';

export interface OpenClawGatewayConfig {
  gatewayUrl: string;
  authToken: string;
  agentId: string;
  protocol: 'openai-compat' | 'anthropic' | 'custom-webhook';
  modelName?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

async function generateViaGateway(
  config: OpenClawGatewayConfig,
  params: GenerateTextParams,
): Promise<string> {
  const url = config.gatewayUrl.replace(/\/+$/, '');
  const model = config.modelName ?? `openclaw:${config.agentId}`;
  const timeout = config.timeoutMs ?? 15000;
  const maxTokens = params.maxTokens ?? config.maxTokens ?? 1000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    switch (config.protocol) {
      case 'anthropic': {
        const res = await fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.authToken,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: params.prompt }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Anthropic gateway ${res.status}: ${await res.text().catch(() => '')}`);
        const data = await res.json() as { content?: Array<{ text: string }> };
        return data.content?.[0]?.text ?? '';
      }

      case 'custom-webhook': {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: params.prompt }],
            context: { model },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Custom webhook ${res.status}: ${await res.text().catch(() => '')}`);
        const data = await res.json() as { response?: string };
        return data.response ?? '';
      }

      default: {
        // openai-compat
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: params.prompt }],
            max_tokens: maxTokens,
            temperature: params.temperature ?? 0.8,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`OpenAI-compat gateway ${res.status}: ${await res.text().catch(() => '')}`);
        const data = await res.json() as { choices?: Array<{ message: { content: string } }> };
        return data.choices?.[0]?.message?.content ?? '';
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates an ElizaOS plugin that intercepts TEXT_SMALL and TEXT_LARGE
 * model calls, routing them through the OpenClaw gateway.
 */
export function createOpenClawProviderPlugin(config: OpenClawGatewayConfig): Plugin {
  const handler = async (_runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
    return generateViaGateway(config, params);
  };

  return {
    name: 'openclaw-provider',
    description: 'Routes text generation through an external OpenClaw gateway',
    models: {
      [ModelType.TEXT_SMALL]: handler,
      [ModelType.TEXT_LARGE]: handler,
    },
    priority: 100, // higher than Anthropic/OpenAI plugins so we win
  };
}
