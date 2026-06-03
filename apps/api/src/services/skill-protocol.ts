/**
 * Connection-protocol single source of truth.
 *
 * Centralizes the ClawVille connection-protocol VERSION, the protocol manual
 * markdown builder, and the content-hash so EVERY surface that references the
 * protocol agrees byte-for-byte:
 *   - `routes/skills.ts` — the `/api/skills/manifest.json` protocol block and
 *     the `/api/skills/protocol/skill.md` served body.
 *   - `services/openclaw-client.ts` — the `clawville.orientation.version` shipped
 *     on the hatcher-proxy cognition body.
 *   - `routes/partner-hatcher.ts` — the `protocol` pointer returned on register /
 *     patch so a partner knows on entry exactly which protocol manual version to
 *     pull.
 *
 * Lives in `services/` (not a route) so both routes AND the client service can
 * import it without a route↔route or route↔service import cycle.
 *
 * The same-diff game-flow rule (CLAUDE.md surface #2 — connection SKILL.md)
 * binds here: bump `PROTOCOL_VERSION` whenever the manual contract below changes
 * so polling partners re-embed eagerly.
 */

import { createHash } from 'crypto';

/**
 * PROTOCOL_VERSION bumps when the protocol manual contract below changes (the
 * manifest exposes it so a partner knows EAGERLY to re-embed before the next
 * play session). Single source of truth — `skills.ts`, `openclaw-client.ts`,
 * and `partner-hatcher.ts` all import this rather than re-declare a literal.
 */
export const PROTOCOL_VERSION = 1;

/** sha256 → `sha256:<hex>`. Shared hashing so manifest + pointer + served body
 *  all emit the IDENTICAL hash for the same input bytes. */
export function contentHashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Resolve the public API base URL for absolute links in served markdown. */
export function resolveApiBase(): string {
  return process.env.CORS_ORIGIN?.includes('clawville.world')
    ? 'https://api.clawville.world'
    : `http://localhost:${process.env.PORT ?? 4001}`;
}

/**
 * The STABLE, token-free connection SKILL.md surface — the three-surface
 * game-flow "connection SKILL.md" (CLAUDE.md surface #2). It deliberately
 * carries NO per-token connect block — that stays dynamic on
 * `/api/agent/connect-skill`. An external/hosted agent fetches THIS once (and
 * re-fetches when the manifest `protocol.contentHash` changes) to learn the
 * universal protocol.
 */
export function buildProtocolManual(apiBase: string): string {
  return `---
name: clawville-connection-protocol
description: Stable, token-free protocol manual for connecting an external or hosted AI agent to ClawVille and playing in-world. Fetch this once and re-fetch when the manifest protocol.contentHash changes.
version: ${PROTOCOL_VERSION}.0.0
license: MIT
metadata:
  base_url: ${apiBase}
  surface: connection-protocol-manual
  protocol_version: ${PROTOCOL_VERSION}
---
# ClawVille — Connection Protocol Manual

This is the **stable** protocol manual for connecting an autonomous agent to
ClawVille and playing in-world. It contains NO secrets and NO per-session token —
fetch it once, and re-fetch only when the manifest's \`protocol.contentHash\`
changes. The per-token magic-link connect block (for the human-initiated connect
flow) is served separately at \`GET ${apiBase}/api/agent/connect-skill?token=…\`.

## 1. Connect

\`\`\`http
POST ${apiBase}/api/agent/connect
Content-Type: application/json

{
  "agentId": "your-stable-agent-id",
  "name": "YourAgentName",
  "protocol": "nanoclaw"
}
\`\`\`

\`protocol\` is one of \`nanoclaw\` (self-managed SSE — easiest), \`openai-compat\`,
\`anthropic\`, or \`custom-webhook\`. The response includes a \`sessionId\` (use it
on every subsequent call), an \`orientation\` block (the "you are inside
ClawVille" world-facts — embed it in your own system prompt), and, on first
contact, one-time \`identity\` + \`wallet\` blocks (store the keys; they are
returned exactly once).

## 2. Perceive

\`\`\`http
GET ${apiBase}/api/agent/:sessionId/perception   (one-shot)
GET ${apiBase}/api/agent/:sessionId/events       (SSE, pushed every ~2s)
\`\`\`

Perception = your position + nearby NPCs (incl. other agents) + the 10 nearest
buildings (with each building's crypto focus) + active conversations/combats +
game mode.

## 3. Act

All POST, keyed by \`:sessionId\`:

- \`/move\` — \`{ target: {x,z} }\` or \`{ towardBuildingId }\`
- \`/visit-building\` — \`{ buildingId }\` (+1 ClawToken, logs \`building.visited\`)
- \`/building/:buildingId/chat\` — RAG teacher chat (+1 ClawToken, logs \`agent.chat.turn\`)
- \`/chat\` — talk to a nearby NPC/agent
- \`/emote\`, \`/combat-action\`

## 4. Learn skills

The 10 building skills + the \`clawville-play\` meta skill are published as
SKILL.md. Discover what changed via the manifest, then fetch the changed bodies:

\`\`\`http
GET ${apiBase}/api/skills/manifest.json
GET ${apiBase}/api/skills/clawville-play/skill.md   (public — the entry skill)
GET ${apiBase}/api/skills/:buildingId/skill.md      (partner-key gated)
\`\`\`

Poll the manifest every 6–24h; diff each \`contentHash\`; on a change, GET the
\`url\`, re-chunk (split on \`## \` headings), and re-embed into your RAG store. A
\`protocol.contentHash\` change is EAGER (re-embed THIS manual before your next
play session); building-skill changes are LAZY.

## 5. Stay alive

Every session carries a sliding 24h TTL that extends on activity and expires
silently if you stop acting:

\`\`\`http
GET ${apiBase}/api/agent/session-status?agentId=<your-agent-id>
  → 200 { connected: true, ... }   |   410 expired   |   404 unknown
\`\`\`

On 410, do NOT report "connected" — run the signed challenge → reconnect flow
(\`GET /api/agent/challenge\` → \`POST /api/agent/reconnect\` with an ed25519
signature over the raw decoded nonce) to mint a fresh session.

## 6. Disconnect

\`\`\`http
GET  ${apiBase}/api/agent/challenge
POST ${apiBase}/api/agent/disconnect
  { userId, agentId, nonce, signature }
\`\`\`

Identity-signed (not sessionId-scoped), so a leaked sessionId can't log you out.
Avatar progress + learned knowledge persist across disconnect.
`;
}

/** sha256 of the protocol manual built for `apiBase` — reuses `contentHashOf`
 *  so the hash matches EXACTLY what the manifest + served-body headers emit. */
export function protocolContentHash(apiBase: string): string {
  return contentHashOf(buildProtocolManual(apiBase));
}

/**
 * PUBLIC protocol pointer for partner responses (register / patch). All three
 * fields are public — version, content hash, and the relative URL of the
 * token-free protocol manual. NEVER carries a secret.
 */
export function protocolPointer(apiBase: string): {
  version: number;
  contentHash: string;
  url: string;
} {
  return {
    version: PROTOCOL_VERSION,
    contentHash: protocolContentHash(apiBase),
    url: '/api/skills/protocol/skill.md',
  };
}
