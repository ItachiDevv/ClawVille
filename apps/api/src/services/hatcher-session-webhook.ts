/**
 * Hatcher session-lifecycle outbound webhook (2026-06-12).
 *
 * PUSH counterpart to the PULL session-status poll. When a Hatcher agent's
 * session expires (the 5-min TTL sweeper) or is explicitly torn down (signed
 * /disconnect, partner DELETE), we notify the partner so their dashboard can
 * reflect "this agent is no longer live in ClawVille" without polling
 * /session-status. Today Hatcher has NOT given us an endpoint, so this is
 * DORMANT by default: it does nothing unless HATCHER_SESSION_WEBHOOK_URL is set.
 *
 * CONTRACT (every property is load-bearing — read before editing):
 *   - ENV-GATED: no HATCHER_SESSION_WEBHOOK_URL => no-op (returns immediately).
 *     This is the default for now.
 *   - SIGNED: the body is signed with the SAME ed25519 service-issuer scheme as
 *     the cognition callbacks (`signPayload` → canonical JSON + sha256 + ed25519),
 *     carried on `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature`. The
 *     partner verifies against `/.well-known/clawville-issuer.json` (purpose
 *     `partner-session-webhook`). We transmit `signed.body` VERBATIM so the
 *     partner hashes the identical bytes.
 *   - SSRF-GUARDED: the URL is validated with the DNS-resolving Hatcher proxy
 *     guard (https + host allowlist + no private/rebind IP) before every send,
 *     and we never follow redirects (`redirect:'manual'`). The same allowlist
 *     that gates the cognition proxy gates this webhook.
 *   - FAIL-OPEN (advisory only): a webhook failure NEVER blocks or fails the
 *     sweep / disconnect. We time out, retry ONCE, and swallow everything. The
 *     session lifecycle is authoritative in our DB regardless of whether the
 *     partner heard about it.
 *   - HATCHER-ONLY: only `identityType === 'hatcher'` agents notify (these are
 *     the partner's own agents). Every caller passes the row's identityType.
 *   - NO SECRETS LOGGED: we log a sessionDigest-free agentId + reason + status
 *     code only — never the signed body, never a token, never the URL's query.
 */

import { signPayload } from './service-issuer';
import { validateHatcherProxyUrlResolved } from './hatcher-config';

/** Reasons a session lifecycle notification fires. */
export type SessionWebhookReason = 'ttl_expired' | 'disconnected';

/** The de-namespaced raw partner agent id (strip our `hatcher:` storage key). */
const HATCHER_AGENT_PREFIX = 'hatcher:';
function rawHatcherAgentId(namespacedAgentId: string): string {
  return namespacedAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? namespacedAgentId.slice(HATCHER_AGENT_PREFIX.length)
    : namespacedAgentId;
}

/** Per-attempt network timeout. Short — this is advisory, we never wait long. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/** Read the configured endpoint, or null when the webhook is dormant. */
function getWebhookUrl(): string | null {
  const raw = process.env.HATCHER_SESSION_WEBHOOK_URL;
  if (!raw || !raw.trim()) return null;
  return raw.trim();
}

/**
 * POST the signed body once with a hard timeout. Returns true on a 2xx, false on
 * anything else (non-2xx, redirect, network error, timeout). Never throws — the
 * caller is fail-open.
 */
async function postOnce(url: string, signedBody: string, pubkey: string, signature: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // SSRF: never follow a redirect. The guard validates only the INITIAL
      // host; a 3xx from an allowlisted-but-compromised host could otherwise
      // bounce us to an internal address. Surface the 3xx as a response and
      // treat it as a hard fail.
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-Clawville-Issuer-Pubkey': pubkey,
        'X-Clawville-Signature': signature,
      },
      body: signedBody,
      signal: controller.signal,
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return false;
    }
    return res.ok;
  } catch {
    // Network / timeout / abort — advisory, swallow.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify the partner that a Hatcher agent's session ended. Fire-and-forget safe:
 * callers `void notifyHatcherSessionEnded(...)` and never await it on a hot path.
 *
 * @param params.identityType the row's identity type — only `hatcher` notifies.
 * @param params.agentId      the agent id AS STORED (namespaced); de-namespaced
 *                            in the body so the partner sees the raw id it sent.
 * @param params.reason       `ttl_expired` (sweeper) or `disconnected` (explicit).
 * @param params.expiredAt    ISO timestamp of the lifecycle event (defaults now).
 */
export async function notifyHatcherSessionEnded(params: {
  identityType: string | null | undefined;
  agentId: string;
  reason: SessionWebhookReason;
  expiredAt?: Date;
}): Promise<void> {
  // Hatcher-only: these are the partner's own agents. Other frameworks have no
  // webhook contract with us.
  if (params.identityType !== 'hatcher') return;

  const url = getWebhookUrl();
  if (!url) return; // Dormant — no endpoint configured.

  // Validate the destination on EVERY send (env can change, defends rebind).
  const urlCheck = await validateHatcherProxyUrlResolved(url);
  if (!urlCheck.ok) {
    console.warn(
      `[HatcherWebhook] endpoint failed SSRF check (${urlCheck.reason}) — skipping notify for ${rawHatcherAgentId(params.agentId)}`,
    );
    return;
  }

  const body = {
    type: 'session.ended' as const,
    agentId: rawHatcherAgentId(params.agentId),
    reason: params.reason,
    expiredAt: (params.expiredAt ?? new Date()).toISOString(),
  };

  let signed: ReturnType<typeof signPayload>;
  try {
    signed = signPayload(body);
  } catch (err) {
    // Issuer key not configured / bad — advisory, skip.
    console.warn(
      `[HatcherWebhook] sign failed for ${body.agentId} (${(err as Error).message}) — skipping notify`,
    );
    return;
  }

  // One attempt + one retry. Both fail-open; never throw.
  const ok = await postOnce(urlCheck.url, signed.body, signed.pubkey, signed.signature);
  if (!ok) {
    const retried = await postOnce(urlCheck.url, signed.body, signed.pubkey, signed.signature);
    if (!retried) {
      console.warn(
        `[HatcherWebhook] notify failed (after 1 retry) for ${body.agentId} reason=${body.reason}`,
      );
    }
  }
}
