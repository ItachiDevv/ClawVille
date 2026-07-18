const visited = new Set<string>();
const listeners = new Set<(beaconId: string) => void>();

export function markKelpRealmBeaconVisited(beaconId: string): void {
  if (visited.has(beaconId)) return;
  visited.add(beaconId);
  for (const listener of listeners) listener(beaconId);
}

export function subscribeKelpRealmBeaconVisits(listener: (beaconId: string) => void): () => void {
  listeners.add(listener);
  for (const beaconId of visited) listener(beaconId);
  return () => listeners.delete(listener);
}

export function resetKelpRealmBeaconVisits(): void {
  visited.clear();
}

