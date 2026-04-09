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

export interface HermesClientConfig {
  gatewayUrl?: string;
  authToken?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

const HERMES_DEFAULTS = {
  gatewayUrl: 'http://localhost:8642',
  model: 'hermes',
  timeoutMs: 15000,
  maxTokens: 150,
  temperature: 0.8,
} as const;

export class HermesClient {
  private gatewayUrl: string;
  private authToken: string;
  private model: string;
  private timeoutMs: number;
  private maxTokens: number;
  private temperature: number;

  constructor(config: HermesClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? HERMES_DEFAULTS.gatewayUrl).replace(/\/+$/, '');
    this.authToken = config.authToken ?? process.env.API_SERVER_KEY ?? '';
    this.model = config.model ?? HERMES_DEFAULTS.model;
    this.timeoutMs = config.timeoutMs ?? HERMES_DEFAULTS.timeoutMs;
    this.maxTokens = config.maxTokens ?? HERMES_DEFAULTS.maxTokens;
    this.temperature = config.temperature ?? HERMES_DEFAULTS.temperature;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Hermes auth failed (${res.status}): check API_SERVER_KEY`);
        }
        throw new Error(`Hermes API returned ${res.status}: ${body}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err: unknown) {
      if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        throw new Error(`Hermes agent unreachable at ${this.gatewayUrl} — is it running?`);
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Hermes request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
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
      console.error('[Hermes] Ping failed:', err);
      return false;
    }
  }
}
