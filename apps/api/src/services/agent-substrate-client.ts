import type {
  AgentBotConfig,
  HatcherWorldState,
} from '@clawville/shared';
import { signPayload } from './service-issuer';
import { validateHatcherProxyUrlResolved, validateOutboundUrlResolved } from './hatcher-config';
import { PROTOCOL_VERSION } from './skill-protocol';
import {
  HERMES_LOCAL_GATEWAY_URL,
  HERMES_LOCAL_GATEWAY_KEY,
  type InWorldWireProtocol,
} from './agent-session-config';

// The IN-WORLD protocol union — the shared AgentWireProtocol widened by the
// server-internal 'hermes-local' (D7 host-it-for-me Hermes; derivation +
// rationale in agent-session-config.ts).
type Protocol = InWorldWireProtocol;

/**
 * Hard cap on the raw proxy-cognition reply we will accept (chars). Our
 * `max_tokens` ask is advisory — a compromised / prompt-injected / hostile proxy
 * box can ignore it and stream back a multi-megabyte body. Truncating at the
 * source guarantees a bounded string reaches the [ACTION:] tag parser +
 * dispatch loop in npc-simulation.ts, which is the only defense against a
 * synchronous A*-pathfinding DoS on the shared single-threaded sim. 4000 chars
 * is ~10× the longest legitimate reply (max_tokens:150 ≈ 600 chars) yet small
 * enough that even an all-tags body bounds the parser to a trivial cost.
 */
const MAX_HATCHER_REPLY_LEN = 4000;

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

export class AgentSubstrateClient {
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
  /**
   * Structured PUBLIC-ONLY world-state provider for the hatcher-proxy path.
   * Bound to the resolved in-world npcId by `npcSimulation.registerAgentBot`.
   * Replaces `systemContextProvider` for cognition: the partner owns the root
   * prompt and builds it from the `clawville` block we ship.
   */
  private worldStateProvider: (() => HatcherWorldState | null) | null;

  constructor(config: AgentBotConfig) {
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
    this.worldStateProvider = config.worldStateProvider ?? null;
  }

  /**
   * Bind the orientation + world-state system-message provider after the
   * client is constructed. Used by `npcSimulation.registerAgentBot` to wire
   * the provider to the resolved in-world npcId (only known once the body is
   * spawned). No-op for non-proxy protocols (they ignore it).
   *
   * @deprecated For the hatcher-proxy path use `setWorldStateProvider` — the
   * partner now owns the root prompt and we ship a structured `clawville`
   * block instead of forcing a `role:'system'` message. Kept for any
   * non-Hatcher caller still relying on a forced system message.
   */
  setSystemContextProvider(provider: () => string | null): void {
    this.systemContextProvider = provider;
  }

  /**
   * Bind the structured PUBLIC-ONLY world-state provider after construction.
   * Used by `npcSimulation.registerAgentBot` to wire the provider to the
   * resolved in-world npcId. The hatcher-proxy chat ships this object in the
   * top-level `clawville.worldState` block so Hatcher builds its own prompt.
   * No-op for non-proxy protocols.
   */
  setWorldStateProvider(provider: () => HatcherWorldState | null): void {
    this.worldStateProvider = provider;
  }

  /** The wire protocol this client speaks (read-only). Used by the cognition
   *  consumer to gate the hatcher-proxy [ACTION:] parsing/dispatch path. */
  getProtocol(): Protocol {
    return this.protocol;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    switch (this.protocol) {
      case 'nanoclaw':
        // Self-managed agents don't receive pushed chat — they pull world
        // state from the /events SSE stream and decide responses client-side.
        // Returning empty string tells the simulation "this bot doesn't speak
        // via gateway push" without throwing.
        return '';
      case 'hermes-local':
        return this.chatHermesLocal(messages);
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
   * HATCHER OWNS THE ROOT PROMPT (Phase A++, 2026-06-02): we no longer force a
   * `role:'system'` message on this path. Instead the body carries a top-level
   * structured `clawville` object (playerMessage + PUBLIC-ONLY worldState +
   * an orientation pointer) so the partner builds its own system prompt. The
   * `messages` array carries ONLY the user turn so it can never conflict with
   * the partner's root prompt.
   *
   * SECURITY: the `clawville` block contains ONLY public world-state — never the
   * scoped token, wallet/identity secret, session id, userId, or any internal
   * id beyond public npc/building ids.
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

    // SSRF guard — DNS-AWARE re-validation at call time (Codex round-2 R2-3,
    // 2026-06-12). The proxy URL is partner-supplied. Registration runs the
    // DNS-aware validator (resolve + reject private/loopback/link-local IPs), but
    // the per-call cognition path previously re-ran only the SYNCHRONOUS hostname
    // allowlist. An allowlisted Hatcher subdomain can DNS-REBIND to a private IP
    // AFTER registration, so the sync string check would still pass and we would
    // POST the scoped bearer + our ed25519 signature to an internal address
    // (169.254.169.254 metadata, RFC1918, localhost). `redirect:'manual'` below
    // stops a redirect-hop rebind but NOT a resolve-time rebind. We therefore
    // resolve-and-check the host's CURRENT A/AAAA records here, immediately before
    // building + sending the request, and reject if any resolves to a private IP.
    //
    // RESIDUAL (documented, narrowed not eliminated): a classic DNS TOCTOU
    // remains between this resolve and fetch's own resolve — the gap is only the
    // synchronous body-build + sign below (no further awaits/DNS), so the window
    // is small. Fully closing it needs a pinned-IP fetch (resolve once, connect to
    // the literal with SNI/Host preserved), which the platform fetch does not
    // expose; the resolve-and-check here is the call-time mitigation the round-2
    // finding asks for. Fail-SOFT preserved: a blocked/failed check returns ''
    // (this bot just doesn't speak this turn), never throws.
    const urlCheck = await validateHatcherProxyUrlResolved(this.proxyBaseUrl);
    if (!urlCheck.ok) {
      console.error(
        `[Hatcher] proxy URL rejected for agent ${this.agentId}: ${urlCheck.reason} — failing soft`,
      );
      return '';
    }

    // Hatcher owns the root prompt: ship ONLY the user turn. Drop any system
    // message the caller passed (the partner builds its own from `clawville`)
    // and keep the LAST user turn as the player message / situation text. We
    // pass a single user message so the partner's root prompt can never be
    // overridden by ours.
    const userTurns = messages.filter((m) => m.role === 'user');
    const playerMessage = userTurns.length > 0 ? userTurns[userTurns.length - 1].content : '';
    const outMessages: ChatMessage[] = [{ role: 'user', content: playerMessage }];

    // Structured world-state (PUBLIC-ONLY). Bound to the agent's in-world body
    // by `npcSimulation.registerAgentBot`. May be null if the body isn't in the
    // world (or the provider threw) — we then omit `worldState` but still ship
    // the user turn + orientation pointer so cognition degrades, not crashes.
    let worldState: HatcherWorldState | null = null;
    if (this.worldStateProvider) {
      try {
        worldState = this.worldStateProvider();
      } catch (err) {
        console.error(`[Hatcher] worldStateProvider threw for agent ${this.agentId}:`, err);
      }
    }

    // OpenAI chat-completions body + a top-level `clawville` block so the
    // partner builds its own system prompt. Model = `hatcher:<rawAgentId>` so
    // Hatcher matches the model to the agent it knows (not our internal
    // `hatcher:<id>` namespace key).
    const requestBody = {
      model: `hatcher:${this.proxyAgentId}`,
      messages: outMessages,
      max_tokens: this.maxTokens,
      temperature: 0.8,
      clawville: {
        playerMessage,
        // Omit `worldState` entirely when unavailable rather than send null —
        // keeps the canonical signed bytes clean for the partner's verifier.
        ...(worldState ? { worldState } : {}),
        orientation: {
          // Single source of truth — the manifest's canonical protocol version
          // (services/skill-protocol.ts), so this pointer never drifts from the
          // served `/api/skills/protocol/skill.md` manual.
          version: PROTOCOL_VERSION,
          url: '/api/skills/protocol/skill.md',
        },
      },
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
      const content = data.choices?.[0]?.message?.content ?? '';
      // Truncate at the source: max_tokens is advisory and a hostile / injected
      // proxy can return an arbitrarily large body. Cap before it ever reaches
      // the sim's [ACTION:] tag parser + A* dispatch loop (the only defense
      // against a synchronous pathfinding DoS on the shared single-threaded
      // sim). Slicing mid-tag at worst yields a malformed tag the dispatcher
      // safely drops — it never crashes.
      return content.length > MAX_HATCHER_REPLY_LEN
        ? content.slice(0, MAX_HATCHER_REPLY_LEN)
        : content;
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

  /**
   * D7 host-it-for-me Hermes cognition (magic-link onboarding, 2026-07-02).
   * POSTs an OpenAI chat-completions body ({model:'hermes', messages}) to the
   * HARDCODED local Hermes runtime (`HERMES_LOCAL_GATEWAY_URL`, localhost:8642).
   * Reached ONLY when `resolveInWorldProtocol` derived 'hermes-local' — i.e. a
   * 'hermes' identity with the env gate on.
   *
   * NO SSRF CHECK, ON PURPOSE: `validateOutboundUrlResolved` exists to stop a
   * CALLER-SUPPLIED URL from aiming our POSTs at localhost/RFC1918/metadata.
   * This target is a compile-time SERVER-SIDE constant that no caller input or
   * bot-row column can influence, so the localhost-rejecting guard would only
   * veto the one address the feature is FOR. The general guard on every
   * caller-supplied gatewayUrl is untouched. Auth: a same-box shared secret
   * (`HERMES_LOCAL_GATEWAY_KEY`) is carried as a Bearer when configured —
   * hermes ≥0.12 refuses to serve its API without one, even on loopback;
   * unset ⇒ bare POST (mock-hermes harness contract).
   *
   * FAIL SOFT like the nanoclaw stub: ANY error (runtime not running /
   * ECONNREFUSED, timeout, non-2xx, redirect, malformed JSON) returns '' — an
   * unreachable local runtime must never crash or stall the shared sim; the
   * body just doesn't speak this turn.
   */
  private async chatHermesLocal(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    // Short leash (constructor default 10s) — a hung local runtime must not
    // pin the sim's conversation tick longer than a real gateway would.
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${HERMES_LOCAL_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        // Consistency with every other outbound chat path: never follow a
        // redirect, even from our own localhost constant — a 3xx here is a
        // misbehaving runtime, not a routing instruction.
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          // Hermes ≥0.12 requires API_SERVER_KEY even on loopback; carry the
          // same-box shared secret when configured. Unset ⇒ bare POST (the
          // mock-hermes harness contract, unchanged).
          ...(HERMES_LOCAL_GATEWAY_KEY
            ? { Authorization: `Bearer ${HERMES_LOCAL_GATEWAY_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          // Fixed model name per the hermes OpenAI-compat contract — NOT
          // this.model (which is the `openclaw:<agentId>` gateway default).
          model: 'hermes',
          messages,
          max_tokens: this.maxTokens,
          temperature: 0.8,
        }),
        signal: controller.signal,
      });

      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        console.error(
          `[Hermes] local runtime attempted redirect (status ${res.status}) for agent ${this.agentId} — refusing to follow, failing soft`,
        );
        return '';
      }

      if (!res.ok) {
        // Status only — never the body (keeps log hygiene uniform with the
        // other cognition paths even though this one carries no bearer).
        console.error(
          `[Hermes] local runtime returned ${res.status} for agent ${this.agentId} — failing soft`,
        );
        return '';
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content ?? '';
      // Same bounded-reply defense as the hatcher path: the reply flows into
      // the sim's shared parser surface, so cap it at the source regardless of
      // how trusted the local runtime is.
      return content.length > MAX_HATCHER_REPLY_LEN
        ? content.slice(0, MAX_HATCHER_REPLY_LEN)
        : content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Hermes] local runtime chat failed for agent ${this.agentId}: ${msg} — failing soft`);
      return '';
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatOpenAI(messages: ChatMessage[]): Promise<string> {
    // SSRF guard (Codex round-2 R2-6, 2026-06-12). gatewayUrl is an arbitrary
    // agent-supplied URL validated only by `z.string().url()` at /connect — never
    // for SSRF. Resolve-and-reject private/loopback/link-local IPs at call time
    // (no host allowlist; http allowed) so a connected agent can't aim its own
    // cognition POST at 169.254.169.254 / RFC1918 / localhost. Fail SOFT (return
    // '') on reject — the bot just doesn't speak this turn.
    const urlCheck = await validateOutboundUrlResolved(this.gatewayUrl);
    if (!urlCheck.ok) {
      console.error(
        `[OpenClaw] gatewayUrl rejected for agent ${this.agentId}: ${urlCheck.reason} — failing soft`,
      );
      return '';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${urlCheck.url.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        // SSRF redirect guard (Codex round-2 R2-6, 2026-06-12). The resolve-check
        // above validates only the INITIAL gatewayUrl host. The agent CONTROLS
        // its own gateway, so it can point gatewayUrl at a benign public IP that
        // passes the resolve check, then return `302 Location: http://169.254.
        // 169.254/...` (or any RFC1918 / localhost). Default fetch FOLLOWS that
        // redirect → we'd POST the authToken to the internal address, reopening
        // the exact SSRF this fix closes. `redirect:'manual'` surfaces the 3xx as
        // a response instead of following it; we treat any 3xx as a hard fail
        // (mirrors the Hatcher cognition path).
        redirect: 'manual',
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

      // Hard-fail on any redirect (status 300-399, or opaqueredirect on some
      // runtimes). Treated the SAME as !res.ok so a redirect never looks like a
      // healthy gateway — throws, ping() reads it as unreachable, fail-soft.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        console.error(
          `[OpenClaw] gatewayUrl attempted redirect (status ${res.status}) for agent ${this.agentId} — refusing to follow`,
        );
        throw new Error(`OpenClaw API attempted redirect (status ${res.status}) — refusing to follow`);
      }

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
    // SSRF guard (Codex round-2 R2-6, 2026-06-12) — see chatOpenAI. Fail soft.
    const urlCheck = await validateOutboundUrlResolved(this.gatewayUrl);
    if (!urlCheck.ok) {
      console.error(
        `[OpenClaw] gatewayUrl rejected for agent ${this.agentId}: ${urlCheck.reason} — failing soft`,
      );
      return '';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    try {
      const res = await fetch(`${urlCheck.url.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        // SSRF redirect guard (Codex round-2 R2-6, 2026-06-12) — see chatOpenAI.
        // The resolve-check validates only the initial host; the agent owns its
        // gateway and can 302 us to an internal address, so never follow.
        redirect: 'manual',
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

      // Hard-fail on any redirect — same handling as !res.ok (throw → fail-soft).
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        console.error(
          `[OpenClaw] gatewayUrl attempted redirect (status ${res.status}) for agent ${this.agentId} — refusing to follow`,
        );
        throw new Error(`Anthropic API attempted redirect (status ${res.status}) — refusing to follow`);
      }

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
    // SSRF guard (Codex round-2 R2-6, 2026-06-12) — see chatOpenAI. The webhook
    // POSTs to gatewayUrl VERBATIM (no path suffix), so the normalized url is the
    // exact endpoint. Fail soft on reject.
    const urlCheck = await validateOutboundUrlResolved(this.gatewayUrl);
    if (!urlCheck.ok) {
      console.error(
        `[OpenClaw] gatewayUrl rejected for agent ${this.agentId}: ${urlCheck.reason} — failing soft`,
      );
      return '';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(urlCheck.url, {
        method: 'POST',
        // SSRF redirect guard (Codex round-2 R2-6, 2026-06-12) — see chatOpenAI.
        // HIGHEST-risk path: this method returns `data.response` from the response
        // BODY, so a followed redirect to 169.254.169.254 / RFC1918 would let the
        // agent EXFIL the internal/metadata response back through its own reply.
        // The resolve-check validates only the initial host; the agent owns its
        // gateway, so never follow a redirect.
        redirect: 'manual',
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

      // Hard-fail on any redirect BEFORE reading the body — never read/return a
      // redirected response. This method fails soft by returning '' on error, so
      // a 3xx returns '' (no exfil, the bot just doesn't speak this turn).
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        console.error(
          `[OpenClaw] gatewayUrl (custom webhook) attempted redirect (status ${res.status}) for agent ${this.agentId} — refusing to follow, failing soft`,
        );
        return '';
      }

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
    // always-reachable so registration doesn't block. Same for hermes-local:
    // the agent is a self-managed pull agent whose local cognition runtime is
    // strictly BEST-EFFORT (chatHermesLocal fails soft to ''), so a not-yet-
    // running localhost:8642 must never block a hermes connect/registration.
    if (this.protocol === 'nanoclaw' || this.protocol === 'hermes-local') return true;
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
