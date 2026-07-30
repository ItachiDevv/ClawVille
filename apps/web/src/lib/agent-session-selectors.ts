const BOUND_AGENT_SESSION_MODES = new Set([
  'hosted',
  'external-active',
  'external-idle',
  'external-expired',
]);

export function isBoundAgentSessionMode(
  mode: string | undefined,
): boolean {
  return mode !== undefined && BOUND_AGENT_SESSION_MODES.has(mode);
}
