export interface HealthVersionResponse {
  commit?: unknown;
}

export function normalizeSourceCommit(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function hasSourceCommitMismatch(
  clientCommit: unknown,
  serverCommit: unknown,
): boolean {
  const client = normalizeSourceCommit(clientCommit);
  const server = normalizeSourceCommit(serverCommit);
  return client !== null && server !== null && client !== server;
}

export async function checkForStaleClient(
  signal?: AbortSignal,
): Promise<boolean> {
  const clientCommit = normalizeSourceCommit(
    process.env.NEXT_PUBLIC_SOURCE_COMMIT,
  );
  if (!clientCommit) return false;

  const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
  const response = await fetch(`${apiBase}/health`, {
    cache: 'no-store',
    credentials: 'include',
    signal,
  });
  if (!response.ok) return false;

  const health = (await response.json()) as HealthVersionResponse;
  return hasSourceCommitMismatch(clientCommit, health.commit);
}
