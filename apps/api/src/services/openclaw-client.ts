import type { OpenClawBotConfig } from '@legacyapp/shared';

type Protocol = 'openai-compat' | 'anthropic' | 'custom-webhook';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

interface CustomWebhookResponse {
  response: string;
}

export class OpenClawClient {
  private gatewayUrl: string;
  private authToken: string;
  private model: string;
  private protocol: Protocol;
  private timeoutMs: number;
  private maxTokens: number;

  constructor(config: OpenClawBotConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.model = config.modelName ?? `openclaw:${config.agentId}`;
    this.protocol = config.protocol ?? 'openai-compat';
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.maxTokens = config.maxTokens ?? 150;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    switch (this.protocol) {
      case 'anthropic':
        return this.chatAnthropic(messages);
      case 'custom-webhook':
        return this.chatCustomWebhook(messages);
      default:
        return this.chatOpenAI(messages);
    }
  }

  private async chatOpenAI(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: this.maxTokens,
          temperature: 0.8,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenClaw API returned ${res.status}: ${body}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatAnthropic(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.authToken,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemMsg?.content,
          messages: nonSystemMsgs.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic API returned ${res.status}: ${body}`);
      }

      const data = (await res.json()) as AnthropicResponse;
      return data.content?.[0]?.text ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatCustomWebhook(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          messages,
          context: { model: this.model },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Custom webhook returned ${res.status}: ${body}`);
      }

      const data = (await res.json()) as CustomWebhookResponse;
      return data.response ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.chat([
        { role: 'user', content: 'Hello' },
      ]);
      return result.length > 0;
    } catch (err) {
      console.error('[OpenClaw] Ping failed:', err);
      return false;
    }
  }
}
