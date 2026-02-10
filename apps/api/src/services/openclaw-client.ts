import type { OpenClawBotConfig } from '@legacyapp/shared';

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

export class OpenClawClient {
  private gatewayUrl: string;
  private authToken: string;
  private model: string;

  constructor(config: OpenClawBotConfig) {
    // Normalize URL — strip trailing slash
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.model = `openclaw:${config.agentId}`;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

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
          max_tokens: 150,
          temperature: 0.8,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenClaw API returned ${res.status}: ${body}`);
      }

      const data: ChatCompletionResponse = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
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
