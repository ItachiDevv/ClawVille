/**
 * Shared in-memory cache: OpenClaw sessionId → ElizaOS platformAgent ID.
 * Populated at registration (openclaw.ts), consumed by agent-gateway.ts and openclaw.ts chat routes.
 */
const sessionToElizaAgent = new Map<string, string>();

export function setSessionAgent(sessionId: string, agentId: string) {
  sessionToElizaAgent.set(sessionId, agentId);
}

export function getSessionAgent(sessionId: string): string | undefined {
  return sessionToElizaAgent.get(sessionId);
}

export function deleteSessionAgent(sessionId: string) {
  sessionToElizaAgent.delete(sessionId);
}
