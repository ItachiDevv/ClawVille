import {
  canonicalStageUrl,
  stageDestinationKey,
  type NavNonce,
} from './stage-scene-id';

export interface StageNavigationIssue {
  readonly id: string;
  readonly destinationKey: string;
  readonly href: string;
  readonly issuedAt: number;
  status: 'in-flight' | 'superseded';
}

export interface NavigationTombstone {
  readonly id: string;
  readonly status: 'settled' | 'superseded';
}

export type NavLandingClass =
  | { readonly kind: 'issued-live'; readonly issue: StageNavigationIssue }
  | { readonly kind: 'issued-stale' }
  | { readonly kind: 'traversal' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unissued' };

export const MAX_TRACKED_NAVIGATION_ISSUES = 8;
export const MAX_NAVIGATION_TOMBSTONES = 32;
export const NAVIGATION_ISSUE_TTL_MS = 10_000;

export const documentEpoch = crypto.randomUUID();

let sequence = 0;
let issues: StageNavigationIssue[] = [];
let tombstones: NavigationTombstone[] = [];
let intent: { destinationKey: string; href: string } | null = null;

function pushTombstone(tombstone: NavigationTombstone): void {
  tombstones.push(tombstone);
  if (tombstones.length > MAX_NAVIGATION_TOMBSTONES) {
    tombstones = tombstones.slice(-MAX_NAVIGATION_TOMBSTONES);
  }
}

export function nextNavNonce(): { id: string; seq: number } {
  const seq = ++sequence;
  return { id: `${documentEpoch}.${seq}`, seq };
}

export function issuedHighWater(): number {
  return sequence;
}

export function acceptNavigationIntent(
  href: string,
): { destinationKey: string; href: string } {
  const canonical = canonicalStageUrl(href);
  for (const issue of issues) {
    if (issue.status === 'in-flight') issue.status = 'superseded';
  }
  intent = {
    destinationKey:
      stageDestinationKey(new URL(canonical, location.origin).pathname) ?? '',
    href: canonical,
  };
  return intent;
}

export function getNavigationIntent(): {
  destinationKey: string;
  href: string;
} | null {
  return intent;
}

export function pushIssue(issue: StageNavigationIssue): void {
  issues.push(issue);
  while (issues.length > MAX_TRACKED_NAVIGATION_ISSUES) {
    const evicted = issues.shift();
    if (evicted) {
      pushTombstone({
        id: evicted.id,
        status: 'superseded',
      });
    }
  }
}

export function classifyNavLanding(
  nonce: NavNonce | null,
): NavLandingClass {
  if (nonce === null) return { kind: 'unissued' };
  if (nonce.epoch !== documentEpoch) return { kind: 'foreign' };
  const id = `${nonce.epoch}.${nonce.seq}`;
  const issue = issues.find((candidate) => candidate.id === id);
  if (issue?.status === 'in-flight') {
    return { kind: 'issued-live', issue };
  }
  if (issue?.status === 'superseded') return { kind: 'issued-stale' };
  const tombstone = tombstones.find((candidate) => candidate.id === id);
  if (tombstone?.status === 'superseded') {
    return { kind: 'issued-stale' };
  }
  if (tombstone?.status === 'settled') return { kind: 'traversal' };
  return nonce.seq <= issuedHighWater()
    ? { kind: 'traversal' }
    : { kind: 'malformed' };
}

export function settleIssue(id: string): void {
  const index = issues.findIndex((candidate) => candidate.id === id);
  if (index < 0) return;
  issues.splice(index, 1);
  pushTombstone({ id, status: 'settled' });
}

export function retireStaleIssues(now = Date.now()): void {
  const retained: StageNavigationIssue[] = [];
  for (const issue of issues) {
    if (now - issue.issuedAt < NAVIGATION_ISSUE_TTL_MS) {
      retained.push(issue);
    } else {
      pushTombstone({ id: issue.id, status: 'superseded' });
    }
  }
  issues = retained;
}

export function readStageNavigationLineage(): {
  readonly issues: readonly StageNavigationIssue[];
  readonly tombstones: readonly NavigationTombstone[];
  readonly intent: { destinationKey: string; href: string } | null;
  readonly issuedHighWater: number;
} {
  return {
    issues: issues.map((issue) => ({ ...issue })),
    tombstones: tombstones.map((tombstone) => ({ ...tombstone })),
    intent: intent ? { ...intent } : null,
    issuedHighWater: issuedHighWater(),
  };
}

export function resetStageNavigationLineage(): void {
  issues = [];
  tombstones = [];
  intent = null;
}
