/**
 * Redact agent bearer sessionIds from log output (P0, 2026-07-01, Codex gate).
 *
 * The agent bearer (`X-Clawville-Agent-Session`) is the real-CT credential the
 * cove trusts for settlement. It is minted as `(oc|ag|hat)-<base64url(24 bytes)>`
 * — a fixed prefix + 32 url-safe chars:
 *   - `ag-…`  agent-gateway `/connect`      (agent-gateway.ts)
 *   - `oc-…`  legacy openclaw `/register`   (openclaw.ts)
 *   - `hat-…` signed partner register/PATCH (partner-hatcher.ts)
 *   - `ct-…`  agent-gateway `/connect` PENDING ticket, same `randomBytes(24)`
 *             base64url shape (agent-gateway.ts). Not the settlement bearer, but
 *             real-CT-ADJACENT: `/connect` binds a bot to the pending row's
 *             userId/avatarId on TOKEN POSSESSION ALONE, and the frontend POLLS
 *             `GET /api/agent/connect-status/:token` repeatedly — so a leaked
 *             ticket lets a log reader bind THEIR bot to the victim's avatar
 *             within the TTL and drain the victim's real CT. Added 2026-07-02
 *             (adversarial pass) — same leak surface, same class.
 *
 * Several agent routes carry these tokens as a `/:sessionId/…` or `/:token` PATH
 * param (`/api/agent/:sessionId/{events,move,chat,visit-building,…}`, the
 * cove/poker tool routes, legacy unregister, `/connect-status/:token`). The global
 * `hono/logger` middleware (`index.ts`, `app.use('*', logger())`) prints every
 * request path, so WITHOUT redaction the raw, replayable token lands in stdout /
 * the Coolify log drain — anyone with log access can replay it until TTL/rotation
 * (real-CT bearer/ticket theft). Surfaced by the P0 Codex adversarial pass (bearer)
 * + the P1 adversarial pass (`ct-` ticket); same vulnerability CLASS as the folded
 * B1 body-id leak (the credential must NEVER appear on any wire OR in any log).
 *
 * This scrubs the SECRET tail while keeping the `oc-`/`ag-`/`hat-`/`ct-` prefix (ops
 * can still tell it was an agent route). It is a pure string transform — it never
 * throws and only touches OUR log output: NO request/response/URL contract
 * changes, so it is completely invisible to the Hatcher partner.
 *
 * The lookbehind `(?<![A-Za-z0-9])` requires the prefix to start at a token
 * boundary so a substring like the `ag-` inside `flag-…` is never matched; the
 * `{24,}` tail floor keeps ordinary short ids (`oc-1`, `ag-x`) untouched while
 * still catching every 32-char real token.
 */
const BEARER_TOKEN_RE = /(?<![A-Za-z0-9])(oc|ag|hat|ct)-[A-Za-z0-9_-]{24,}/g;

/** Replace any agent bearer sessionId in `input` with `<prefix>-<redacted>`. */
export function redactBearerTokens(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  return input.replace(BEARER_TOKEN_RE, '$1-<redacted>');
}
