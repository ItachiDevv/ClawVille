/**
 * Redact agent bearer sessionIds from log output (P0, 2026-07-01, Codex gate).
 *
 * The agent bearer (`X-Clawville-Agent-Session`) is the real-CT credential the
 * cove trusts for settlement. It is minted as `(oc|ag|hat)-<base64url(24 bytes)>`
 * — a fixed `oc-`/`ag-`/`hat-` prefix + 32 url-safe chars:
 *   - `ag-…`  agent-gateway `/connect`      (agent-gateway.ts)
 *   - `oc-…`  legacy openclaw `/register`   (openclaw.ts)
 *   - `hat-…` signed partner register/PATCH (partner-hatcher.ts)
 *
 * Several agent routes carry that bearer as a `/:sessionId/…` PATH param
 * (`/api/agent/:sessionId/{events,move,chat,visit-building,…}`, the cove/poker
 * tool routes, legacy unregister). The global `hono/logger` middleware
 * (`index.ts`, `app.use('*', logger())`) prints every request path, so WITHOUT
 * redaction the raw, replayable bearer lands in stdout / the Coolify log drain —
 * anyone with log access can replay it as `X-Clawville-Agent-Session` until
 * TTL/rotation (real-CT bearer theft). This is a pre-existing leak surfaced by
 * the P0 Codex adversarial pass; it is the same vulnerability CLASS as the folded
 * B1 body-id leak (the bearer must NEVER appear on any wire OR in any log).
 *
 * This scrubs the SECRET tail while keeping the `oc-`/`ag-`/`hat-` prefix (ops can
 * still tell it was an agent route). It is a pure string transform — it never
 * throws and only touches OUR log output: NO request/response/URL contract
 * changes, so it is completely invisible to the Hatcher partner.
 *
 * The lookbehind `(?<![A-Za-z0-9])` requires the prefix to start at a token
 * boundary so a substring like the `ag-` inside `flag-…` is never matched; the
 * `{24,}` tail floor keeps ordinary short ids (`oc-1`, `ag-x`) untouched while
 * still catching every 32-char real bearer.
 */
const BEARER_TOKEN_RE = /(?<![A-Za-z0-9])(oc|ag|hat)-[A-Za-z0-9_-]{24,}/g;

/** Replace any agent bearer sessionId in `input` with `<prefix>-<redacted>`. */
export function redactBearerTokens(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  return input.replace(BEARER_TOKEN_RE, '$1-<redacted>');
}
