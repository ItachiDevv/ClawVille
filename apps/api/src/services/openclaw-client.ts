import type { OpenClawBotConfig, AgentWireProtocol } from '@clawville/shared';
import { signPayload } from './service-issuer';
import { validateHatcherProxyUrl } from './hatcher-config';

type Protocol = AgentWireProtocol;

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

  // --- Hatcher proxy-cognition fields (protocol === 'hatcher-proxy') ---
  private agentId: string;
  /** Raw partner agent id (no `hatcher:` prefix) for the outbound proxy. */
  private proxyAgentId: string;
  private proxyBaseUrl: string | null;
  private scopedToken: string | null;
  private systemContextProvider: (() => string | null) | null;

  constructor(config: OpenClawBotConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.agentId = config.agentId;
    this.model = config.modelName ?? `openclaw:${config.agentId}`;
    this.protocol = config.protocol ?? 'openai-compat';
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.maxTokens = config.maxTokens ?? 150;
    // Outbound proxy uses the RAW partner agent id (no `hatcher:` prefix). Fall
    // back to agentId for safety, then strip any `hatcher:` prefix defensively
    // so the partner never sees our internal namespace even if a caller passes
    // the namespaced id here.
    this.proxyAgentId = (config.proxyAgentId ?? config.agentId).replace(/^hatcher:/, '');
    this.proxyBaseUrl = config.proxyBaseUrl?.replace(/\/+$/, '') ?? null;
    this.scopedToken = config.scopedToken ?? null;
    this.systemContextProvider = config.systemContextProvider ?? null;
  }

  /**
   * Bind the orientation + world-state system-message provider after the
   * client is constructed. Used by `npcSimulation.registerOpenClaw` to wire
   * the provider to the resolved in-world npcId (only known once the body is
   * spawned). No-op for non-proxy protocols (they ignore it).
   */
  setSystemContextProvider(provider: () => string | null): void {
    this.systemContextProvider = provider;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    switch (this.protocol) {
      case 'nanoclaw':
        // Self-managed agents don't receive pushed chat — they pull world
        // state from the /events SSE stream and decide responses client-side.
        // Returning empty string tells the simulation "this bot doesn't speak
        // via gateway push" without throwing.
        return '';
      case 'hatcher-proxy':
        return this.chatHatcherProxy(messages);
      case 'anthropic':
        return this.chatAnthropic(messages);
      case 'custom-webhook':
        return this.chatCustomWebhook(messages);
      default:
        return this.chatOpenAI(messages);
    }
  }

  /**
   * Hatcher proxy cognition. POSTs an OpenAI chat-completions body to the
   * Hatcher-managed per-agent proxy with DUAL auth:
   *   - `Authorization: Bearer <scopedToken>` (Hatcher's per-agent token,
   *     decrypted in-memory by the caller — never logged).
   *   - `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature` (our ed25519
   *     signature over sha256(canonicalJSON(body)), via service-issuer).
   *
   * The body string we sign is the EXACT bytes we transmit (the canonical
   * JSON from signPayload) so the partner verifies what it receives.
   *
   * Orientation + world-state are prepended as a `role:'system'` message from
   * `systemContextProvider()` so the Hatcher-hosted brain acts as an agent
   * inside ClawVille.
   *
   * FAIL SOFT: any error (missing config, SSRF reject, network/timeout,
   * non-2xx, malformed JSON) returns '' so the simulation degrades
   * gracefully — a missing reply just means "this bot didn't speak this
   * turn". We log the failure WITHOUT the scoped token.
   */
  private async chatHatcherProxy(messages: ChatMessage[]): Promise<string> {
    if (!this.proxyBaseUrl || !this.scopedToken) {
      console.error(
        `[Hatcher] proxy cognition missing config for agent ${this.agentId} (no proxyBaseUrl/scopedToken) — failing soft`,
      );
      return '';
    }

    // SSRF guard — re-validate at call time (defense-in-depth). The proxy URL
    // is partner-supplied; never POST to a non-https or non-allowlisted host.
    const urlCheck = validateHatcherProxyUrl(this.proxyBaseUrl);
    if (!urlCheck.ok) {
      console.error(
        `[Hatcher] proxy URL rejected for agent ${this.agentId}: ${urlCheck.reason} — failing soft`,
      );
      return '';
    }

    // Prepend the ClawVille orientation + world-state system message so the
    // Hatcher brain knows it is acting inside ClawVille. Drop any system
    // messages the caller passed (this client owns the system context).
    const outMessages: ChatMessage[] = [];
    if (this.systemContextProvider) {
      try {
        const ctx = this.systemContextProvider();
        if (ctx && ctx.trim()) outMessages.push({ role: 'system', content: ctx });
      } catch (err) {
        console.error(`[Hatcher] systemContextProvider threw for agent ${this.agentId}:`, err);
      }
    }
    for (const m of messages) {
      if (m.role === 'system') continue; // owned by systemContextProvider
      outMessages.push(m);
    }

    // OpenAI chat-completions body — Hatcher's proxy is chat-completions
    // compatible (model = `hatcher:<rawAgentId>`). Use the RAW partner agent id
    // so Hatcher matches the model to the agent it knows (not our internal
    // `hatcher:<id>` namespace key).
    const requestBody = {
      model: `hatcher:${this.proxyAgentId}`,
      messages: outMessages,
      max_tokens: this.maxTokens,
      temperature: 0.8,
    };

    // signPayload returns the EXACT canonical JSON bytes to send + the
    // base58 signature + our issuer pubkey. We MUST send `signed.body`
    // verbatim so the partner hashes the same bytes.
    let signed: ReturnType<typeof signPayload>;
    try {
      signed = signPayload(requestBody);
    } catch (err) {
      console.error(`[Hatcher] failed to sign cognition request for agent ${this.agentId}:`, err);
      return '';
    }

    const endpoint = `${urlCheck.url.replace(/\/+$/, '')}/integrations/clawville/agents/${encodeURIComponent(this.proxyAgentId)}/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // SSRF: NEVER follow redirects. The SSRF allowlist only validates the
        // INITIAL host; a 3xx from an allowlisted (compromised / rebinding /
        // attacker-subdomain) Hatcher host could otherwise bounce us to
        // 169.254.169.254, localhost, or any RFC1918 address — turning us into
        // a request proxy AND forwarding the scoped token + our ed25519 sig on
        // the redirected hop. `redirect:'manual'` makes fetch surface the 3xx
        // as a response instead of following it; we treat any 3xx as a hard
        // fail. (Plan §14: "no redirect-following to non-allowlisted hosts".)
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          // Hatcher's per-agent scoped token — decrypted in-memory only.
          Authorization: `Bearer ${this.scopedToken}`,
          // ClawVille → Hatcher callback signature (ed25519 over the body).
          'X-Clawville-Issuer-Pubkey': signed.pubkey,
          'X-Clawville-Signature': signed.signature,
        },
        body: signed.body,
        signal: controller.signal,
      });

      // Hard-fail on any redirect. With redirect:'manual', a 3xx surfaces here
      // (status 300-399, or status 0 / res.type==='opaqueredirect' on some
      // runtimes). Do NOT follow it — fail soft and log status only.
      if (
        res.type === 'opaqueredirect' ||
        (res.status >= 300 && res.status < 400)
      ) {
        console.error(
          `[Hatcher] proxy cognition attempted redirect (status ${res.status}) for agent ${this.agentId} — refusing to follow, failing soft`,
        );
        return '';
      }

      if (!res.ok) {
        // Log status only — never the token, never the (possibly sensitive)
        // body which could echo headers back.
        console.error(
          `[Hatcher] proxy cognition returned ${res.status} for agent ${this.agentId} — failing soft`,
        );
        return '';
      }

      const data = (await res.json()) as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      // Network / timeout / abort / JSON-parse error — fail soft. Log the
      // error message but NOT the token.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Hatcher] proxy cognition failed for agent ${this.agentId}: ${msg} — failing soft`);
      return '';
    } finally {
      clearTimeout(timeout);
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
    // nanoclaw agents have no outbound gateway to ping — treat them as
    // always-reachable so registration doesn't block.
    if (this.protocol === 'nanoclaw') return true;
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
