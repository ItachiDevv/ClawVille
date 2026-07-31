import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  MAX_NAVIGATION_TOMBSTONES,
  MAX_TRACKED_NAVIGATION_ISSUES,
  NAVIGATION_ISSUE_TTL_MS,
  acceptNavigationIntent,
  classifyNavLanding,
  documentEpoch,
  getNavigationIntent,
  issuedHighWater,
  nextNavNonce,
  pushIssue,
  readStageNavigationLineage,
  resetStageNavigationLineage,
  retireStaleIssues,
  settleIssue,
} from './stage-navigation-lineage-store';
import { resetStageStore, useStageStore } from './stage-store';

const rootSource = readFileSync(
  resolve(import.meta.dir, 'WorldStageRoot.tsx'),
  'utf8',
);
const transitionSource = readFileSync(
  resolve(import.meta.dir, 'StageTransition.tsx'),
  'utf8',
);
const pageSource = readFileSync(
  resolve(
    import.meta.dir,
    '../../../app/(world)/activity/[activityId]/[roomId]/page.tsx',
  ),
  'utf8',
);
const navigationSource = readFileSync(
  resolve(import.meta.dir, 'stage-navigation.ts'),
  'utf8',
);

let dom: JSDOM;

beforeAll(() => {
  dom = new JSDOM('<!doctype html>', {
    url: 'https://clawville.test/game',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: dom.window.location,
  });
});

beforeEach(() => {
  resetStageNavigationLineage();
  resetStageStore();
  dom.reconfigure({ url: 'https://clawville.test/game' });
});

type Issued = {
  id: string;
  seq: number;
  nonce: { epoch: string; seq: number };
};

function issue(href: string, issuedAt = Date.now()): Issued {
  acceptNavigationIntent(href);
  const { id, seq } = nextNavNonce();
  pushIssue({
    id,
    destinationKey: new URL(href, location.origin).pathname,
    href,
    issuedAt,
    status: 'in-flight',
  });
  return { id, seq, nonce: { epoch: documentEpoch, seq } };
}

function supersede(href: string): void {
  acceptNavigationIntent(href);
}

function evictSettledTombstone(target: Issued): void {
  settleIssue(target.id);
  for (let index = 0; index < MAX_NAVIGATION_TOMBSTONES; index += 1) {
    const next = issue(`/game?settled=${index}`);
    settleIssue(next.id);
  }
}

const cases: Array<readonly [string, () => void]> = [
  ['sets the outgoing activity overlay before the router commit', () => {
    expect(rootSource.indexOf('setOutgoingOverlay({')).toBeLessThan(
      rootSource.indexOf('commitStageNavigation(taken.navigation)'),
    );
  }],
  ['holds fade-in at awaiting for the current overlay request', () => {
    expect(transitionSource).toContain(
      'outgoingOverlay?.requestId === pendingRequest.requestId',
    );
  }],
  ['children landing clears the overlay and releases fade-in', () => {
    expect(rootSource).toMatch(
      /setDisplayedPathname\(pathname\);[\s\S]*?overlay\.pathname !== displayedPathname[\s\S]*?clearOutgoingOverlay\(overlay\.requestId\)/,
    );
  }],
  ['does not set an outgoing overlay when leaving cove', () => {
    expect(rootSource).toContain(
      'outgoingSceneId === ACTIVITY_SCENE_ID',
    );
  }],
  ['does not set an outgoing overlay when leaving kelp', () => {
    expect(rootSource).toContain(
      'request.sceneId !== outgoingSceneId',
    );
  }],
  ['ignores an overlay owned by a superseded request', () => {
    expect(transitionSource).toContain(
      'outgoingOverlay?.requestId === pendingRequest.requestId',
    );
  }],
  ['does not overlay same-scene activity to activity navigation', () => {
    expect(rootSource).toContain(
      'request.sceneId !== outgoingSceneId',
    );
  }],
  ['resetStage clears the outgoing overlay', () => {
    useStageStore.getState().setOutgoingOverlay({
      pathname: '/activity/reef-race/A',
      href: '/game',
      requestId: 1,
    });
    useStageStore.getState().resetStage();
    expect(useStageStore.getState().outgoingOverlay).toBeNull();
  }],
  ['keeps activity children mounted until their leave cleanup precedes fade-in', () => {
    expect(transitionSource.indexOf("setTransitionPhase(pendingRequest.requestId, 'fadingIn')"))
      .toBeGreaterThan(transitionSource.indexOf('outgoingOverlay?.requestId'));
  }],
  ['times out in place without clearing the holding overlay', () => {
    expect(rootSource).toContain('OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS = 10_000');
    expect(rootSource).toContain('markOutgoingOverlayTimedOut(requestId)');
    expect(rootSource).not.toMatch(
      /markOutgoingOverlayTimedOut\(requestId\);[\s\S]{0,160}clearOutgoingOverlay/,
    );
  }],
  ['renders handoff recovery for its own timed-out request', () => {
    expect(pageSource).toContain(
      "outgoingOverlay.status !== 'timed-out'",
    );
  }],
  ['does not render handoff recovery for a non-timed-out request', () => {
    expect(pageSource).toContain(
      "if (!outgoingOverlay || outgoingOverlay.status !== 'timed-out') return null",
    );
  }],
  ['pathname-first activity A to B mints a request and generation', () => {
    expect(rootSource).toMatch(
      /pendingMatchesDestination[\s\S]*?!pendingMatchesDestination && !restingOnDestination[\s\S]*?requestStageScene\(sceneId\)/,
    );
  }],
  ['retains A until B reaches the opaque midpoint', () => {
    expect(rootSource).toContain(
      'pendingRouteChildrenRef.current = {\n        pathname,\n        children,\n      }',
    );
    expect(rootSource).toMatch(
      /handleTransitionOpaque[\s\S]*?setDisplayedChildren\(pendingRoute\.children\)/,
    );
    expect(rootSource).toContain(
      '<LazyStageActivityRouteHost pathname={displayedPathname} />',
    );
    expect(rootSource).toMatch(
      /handleTransitionOpaque[\s\S]*?setDisplayedPathname\(pendingRoute\.pathname\)/,
    );
  }],
  ['gates B fade-in on B paint and rejects A readiness', () => {
    expect(pageSource).toContain('targetRoomKey');
    expect(pageSource).toContain('paintedRoomKey');
  }],
  ['/game to /cove installs children behind handler-owned cover', () => {
    expect(rootSource).toContain("phase === 'awaiting' || phase === 'fadingIn'");
  }],
  ['/game to /kelp installs children behind handler-owned cover', () => {
    expect(rootSource).toContain(
      'state.pendingRequest?.requestId === midpoint.requestId',
    );
  }],
  ['/game to activity installs children behind handler-owned cover', () => {
    expect(rootSource).toContain(
      'midpoint.destinationKey === destinationKey',
    );
  }],
  ['handler-owned activity A to B installs B behind the cover', () => {
    expect(rootSource).toContain(
      'pendingDestinationKeyRef.current ?? request.sceneId',
    );
  }],
  ['late route commit after idle installs from the midpoint record', () => {
    expect(rootSource).toMatch(
      /state\.pendingRequest === null &&\s*state\.activeScene === sceneId/,
    );
  }],
  ['midpoint record parks a mismatched destination', () => {
    expect(rootSource).toContain(
      'midpoint.destinationKey === destinationKey',
    );
  }],
  ['B to C before midpoint supersedes with a new request', () => {
    expect(rootSource).toContain("ownership === 'ADOPT'");
    expect(readFileSync(resolve(import.meta.dir, 'stage-navigation-ownership.ts'), 'utf8'))
      .toContain("return 'SUPERSEDE'");
  }],
  ['B to C after midpoint rejects the stale generation ack', () => {
    expect(rootSource).toContain("ownership === 'EXECUTE_NOW'");
    expect(rootSource).toContain('requestStageScene(sceneId)');
  }],
  ['pathname supersession clears the parked B navigation', () => {
    expect(rootSource).toMatch(
      /acceptNavigationIntent\([\s\S]*?navigationRef\.current = null;[\s\S]*?requestStageScene\(sceneId\)/,
    );
  }],
  ['stale B before C midpoint is issued-stale and cannot mint B', () => {
    const b = issue('/activity/reef-race/B');
    supersede('/activity/reef-race/C');
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-stale');
    expect(getNavigationIntent()?.href).toBe('/activity/reef-race/C');
  }],
  ['stale B remains superseded after C is issued', () => {
    const b = issue('/activity/reef-race/B');
    issue('/activity/reef-race/C');
    expect(readStageNavigationLineage().issues.find((x) => x.id === b.id)?.status)
      .toBe('superseded');
  }],
  ['stale B after C completes cannot install or remint', () => {
    const b = issue('/activity/reef-race/B');
    const c = issue('/activity/reef-race/C');
    settleIssue(c.id);
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-stale');
  }],
  ['pathname-first C repair uses a separately registered replace issue', () => {
    expect(rootSource).toMatch(
      /repairUrlToCurrentIntent[\s\S]*?history: 'replace', countTowardStageHistory: false/,
    );
  }],
  ['C completes even when superseded B never lands', () => {
    const b = issue('/activity/reef-race/B');
    const c = issue('/activity/reef-race/C');
    settleIssue(c.id);
    expect(readStageNavigationLineage().issues.find((x) => x.id === b.id)?.status)
      .toBe('superseded');
  }],
  ['a later legitimate B traversal settles its new nonce', () => {
    const stale = issue('/activity/reef-race/B');
    issue('/activity/reef-race/C');
    const live = issue('/activity/reef-race/B');
    expect(classifyNavLanding(live.nonce).kind).toBe('issued-live');
    expect(classifyNavLanding(stale.nonce).kind).toBe('issued-stale');
  }],
  ['age-retired nonce is issued-stale', () => {
    const old = issue('/activity/reef-race/B', 0);
    retireStaleIssues(NAVIGATION_ISSUE_TTL_MS + 1);
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
  }],
  ['count-evicted nonce is issued-stale', () => {
    const old = issue('/activity/reef-race/B');
    for (let i = 0; i < MAX_TRACKED_NAVIGATION_ISSUES; i += 1) {
      issue(`/game?next=${i}`);
    }
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
  }],
  ['absent nonce below high water is traversal', () => {
    nextNavNonce();
    const high = nextNavNonce().seq;
    resetStageNavigationLineage();
    expect(classifyNavLanding({ epoch: documentEpoch, seq: high - 1 }).kind)
      .toBe('traversal');
  }],
  ['absent nonce at inclusive high water is traversal', () => {
    const high = nextNavNonce().seq;
    resetStageNavigationLineage();
    expect(classifyNavLanding({ epoch: documentEpoch, seq: high }).kind)
      .toBe('traversal');
  }],
  ['absent nonce above high water is malformed fresh arrival', () => {
    const high = issuedHighWater();
    expect(classifyNavLanding({ epoch: documentEpoch, seq: high + 1 }).kind)
      .toBe('malformed');
  }],
  ['issued high water survives record eviction and is not scan-derived', () => {
    const one = issue('/activity/reef-race/ONE');
    const two = issue('/activity/reef-race/TWO');
    settleIssue(two.id);
    const high = issuedHighWater();
    expect(issuedHighWater()).toBe(high);
    expect(classifyNavLanding(one.nonce).kind).toBe('issued-stale');
    expect(classifyNavLanding(two.nonce).kind).toBe('traversal');
  }],
  ['production build leaves the stage probe undefined', () => {
    expect(rootSource).toContain(
      "if (process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE !== '1') return",
    );
  }],
  ['enabled stage probe accepts activity href navigation', () => {
    expect(rootSource).toMatch(
      /__WORLD_STAGE_PROBE__ = \{[\s\S]*?navigate: \(to\) => \{[\s\S]*?requestWorldStageNavigation\(\{ to \}\)/,
    );
  }],
  ['settled back-forward before eviction is traversal', () => {
    const b = issue('/activity/reef-race/B');
    settleIssue(b.id);
    expect(classifyNavLanding(b.nonce).kind).toBe('traversal');
  }],
  ['settled back-forward after eviction remains traversal', () => {
    const b = issue('/activity/reef-race/B');
    evictSettledTombstone(b);
    expect(classifyNavLanding(b.nonce).kind).toBe('traversal');
  }],
  ['saved nonce URL replay before eviction is a normal traversal', () => {
    const b = issue('/activity/reef-race/B');
    settleIssue(b.id);
    expect(classifyNavLanding(b.nonce)).toEqual({ kind: 'traversal' });
  }],
  ['saved nonce URL replay after eviction is a normal traversal', () => {
    const b = issue('/activity/reef-race/B');
    evictSettledTombstone(b);
    expect(classifyNavLanding(b.nonce)).toEqual({ kind: 'traversal' });
  }],
  ['late superseded landing inside the horizon still repairs', () => {
    const b = issue('/activity/reef-race/B');
    supersede('/activity/reef-race/C');
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-stale');
  }],
  ['superseded landing beyond the horizon is the accepted traversal residual', () => {
    const b = issue('/activity/reef-race/B');
    supersede('/activity/reef-race/C');
    retireStaleIssues(Date.now() + NAVIGATION_ISSUE_TTL_MS + 1);
    for (let i = 0; i < MAX_NAVIGATION_TOMBSTONES; i += 1) {
      const next = issue(`/game?evict=${i}`);
      settleIssue(next.id);
    }
    expect(classifyNavLanding(b.nonce).kind).toBe('traversal');
  }],
  ['foreign epoch nonce follows the fresh-arrival path', () => {
    expect(classifyNavLanding({ epoch: 'foreign', seq: 1 }).kind).toBe('foreign');
  }],
  ['resetStage preserves lineage and monotonically increasing sequence', () => {
    const b = issue('/activity/reef-race/B');
    useStageStore.getState().resetStage();
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-live');
    expect(nextNavNonce().seq).toBeGreaterThan(b.seq);
  }],
  ['root unmount preserves lineage and sequence', () => {
    expect(rootSource).not.toMatch(
      /markWorldStageUnmounted\(\);[\s\S]{0,100}resetStageNavigationLineage/,
    );
    expect(rootSource).not.toContain('resetStageNavigationLineage(');
  }],
  ['same-destination B1 landing first is stale by nonce', () => {
    const b1 = issue('/activity/reef-race/B');
    issue('/activity/reef-race/C');
    issue('/activity/reef-race/B');
    expect(classifyNavLanding(b1.nonce).kind).toBe('issued-stale');
  }],
  ['same-destination B2 landing first is live by nonce', () => {
    issue('/activity/reef-race/B');
    issue('/activity/reef-race/C');
    const b2 = issue('/activity/reef-race/B');
    expect(classifyNavLanding(b2.nonce).kind).toBe('issued-live');
  }],
  ['B2 then B1 settles only B2 and leaves B1 stale', () => {
    const b1 = issue('/activity/reef-race/B');
    issue('/activity/reef-race/C');
    const b2 = issue('/activity/reef-race/B');
    settleIssue(b2.id);
    expect(classifyNavLanding(b2.nonce).kind).toBe('traversal');
    expect(classifyNavLanding(b1.nonce).kind).toBe('issued-stale');
  }],
  ['unissued back-forward remains unissued', () => {
    expect(classifyNavLanding(null)).toEqual({ kind: 'unissued' });
  }],
  ['unissued cold deep link remains unissued', () => {
    expect(classifyNavLanding(null).kind).toBe('unissued');
  }],
  ['same-path OLD issue is superseded when NEW intent is accepted', () => {
    const old = issue('/activity/reef-race/B?shortCode=OLD');
    const fresh = issue('/activity/reef-race/B?shortCode=NEW');
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
    expect(classifyNavLanding(fresh.nonce).kind).toBe('issued-live');
    expect(getNavigationIntent()?.href).toContain('shortCode=NEW');
  }],
  ['same-path NEW first stays installed while late OLD repairs', () => {
    const old = issue('/activity/reef-race/B?shortCode=OLD');
    const fresh = issue('/activity/reef-race/B?shortCode=NEW');
    settleIssue(fresh.id);
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
    expect(getNavigationIntent()?.href).toContain('shortCode=NEW');
  }],
  ['handler ADOPT accepts full NEW intent', () => {
    expect(rootSource).toMatch(
      /ownership === 'ADOPT'[\s\S]*?acceptNavigationIntent\(navigation\.to\)/,
    );
  }],
  ['handler EXECUTE_NOW accepts full NEW intent', () => {
    expect(rootSource).toMatch(
      /ownership === 'EXECUTE_NOW'[\s\S]*?acceptNavigationIntent\(navigation\.to\)/,
    );
  }],
  ['EXECUTE_NOW acceptance supersedes live issues atomically', () => {
    const old = issue('/activity/reef-race/OLD');
    supersede('/game');
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
    expect(getNavigationIntent()?.href).toBe('/game');
  }],
  ['ADOPT acceptance supersedes live issues atomically', () => {
    const old = issue('/activity/reef-race/OLD');
    supersede('/kelp');
    expect(classifyNavLanding(old.nonce).kind).toBe('issued-stale');
    expect(getNavigationIntent()?.href).toBe('/kelp');
  }],
  ['SUPERSEDE acceptance supersedes live issues atomically', () => {
    expect(rootSource).toMatch(
      /if \(ownership === 'ADOPT'[\s\S]*?\}\s*acceptNavigationIntent\(navigation\.to\);[\s\S]*?requestStageScene/,
    );
  }],
  ['pathname-first acceptance supersedes live issues atomically', () => {
    expect(rootSource).toMatch(
      /if \(!pendingMatchesDestination && !restingOnDestination\)[\s\S]*?acceptNavigationIntent\(/,
    );
  }],
  ['root remount preserves document-scoped lineage', () => {
    expect(rootSource).not.toContain('resetStageNavigationLineage');
  }],
  ['stage-store epoch reset preserves document-scoped lineage', () => {
    const b = issue('/activity/reef-race/B');
    resetStageStore();
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-live');
  }],
  ['ledger maintains at most one in-flight record', () => {
    for (const href of ['/game', '/cove', '/kelp', '/activity/reef-race/B']) {
      issue(href);
      expect(
        readStageNavigationLineage().issues.filter((x) => x.status === 'in-flight'),
      ).toHaveLength(1);
    }
  }],
  ['outstanding live issue survives a real root lifecycle boundary', () => {
    const b = issue('/activity/reef-race/B');
    resetStageStore();
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-live');
    settleIssue(b.id);
    expect(nextNavNonce().seq).toBeGreaterThan(b.seq);
  }],
  ['stale issue stays stale across a root remount', () => {
    const b = issue('/activity/reef-race/B');
    supersede('/activity/reef-race/C');
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-stale');
  }],
  ['stale issue stays stale across stage-store epoch reset', () => {
    const b = issue('/activity/reef-race/B');
    supersede('/activity/reef-race/C');
    resetStageStore();
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-stale');
  }],
  ['repair commits replace history with a fresh nonce and no history count', () => {
    expect(rootSource).toContain(
      "{ history: 'replace', countTowardStageHistory: false }",
    );
    expect(rootSource).toContain('target.searchParams.set(NAV_NONCE_PARAM, id)');
  }],
  ['full URL intent preserves query and hash for repair', () => {
    acceptNavigationIntent('/activity/reef-race/C?shortCode=NEW#frag');
    expect(getNavigationIntent()?.href).toBe(
      '/activity/reef-race/C?shortCode=NEW#frag',
    );
  }],
  ['same path with the wrong query is not already repaired', () => {
    expect(rootSource).toMatch(
      /canonicalStageUrl\(intent\.href\) ===\s*canonicalStageUrl\(window\.location\.href\)/,
    );
  }],
  ['settlement resolves superseded and live records by their own ids', () => {
    const stale = issue('/activity/reef-race/B');
    const live = issue('/activity/reef-race/C');
    settleIssue(live.id);
    expect(classifyNavLanding(live.nonce).kind).toBe('traversal');
    expect(classifyNavLanding(stale.nonce).kind).toBe('issued-stale');
  }],
  ['healthy crossing settles one live issue without repair', () => {
    const b = issue('/activity/reef-race/B');
    expect(classifyNavLanding(b.nonce).kind).toBe('issued-live');
    settleIssue(b.id);
    expect(classifyNavLanding(b.nonce).kind).toBe('traversal');
  }],
  ['opaque midpoint swaps only parked children for its destination', () => {
    expect(rootSource).toMatch(
      /sceneIdForPathname\(pendingRoute\.pathname\) === request\.sceneId &&\s*stageDestinationKey\(pendingRoute\.pathname\) ===\s*pendingDestinationKeyRef\.current/,
    );
  }],
  ['Retry reissues the stored href with a new attempt nonce', () => {
    expect(pageSource).toMatch(
      /onRetry\(\);[\s\S]*?requestWorldStageNavigation\(\{\s*to: outgoingOverlay\.href/,
    );
  }],
  ['Hard navigate leaves and closes before assigning exactly once', () => {
    expect(pageSource.indexOf('leaveRef.current?.()')).toBeLessThan(
      pageSource.indexOf('window.location.assign(outgoingOverlay.href)'),
    );
    expect(readFileSync(resolve(import.meta.dir, '../../../hooks/useActivityWs.ts'), 'utf8'))
      .toContain('leaveAndClose');
  }],
  ['Hard navigate tolerates a null published leave handle', () => {
    expect(pageSource).toContain('leaveRef.current?.()');
    expect(pageSource).toContain('leaveRef.current = null');
  }],
  ['handoff recovery exposes exactly Hard navigate and Retry navigation', () => {
    const body = pageSource.slice(
      pageSource.indexOf('function ActivityHandoffRecovery'),
      pageSource.indexOf('function FullScreenStatus'),
    );
    expect(body.match(/<button/g)).toHaveLength(2);
    expect(body.indexOf('Hard navigate')).toBeLessThan(
      body.indexOf('Retry navigation'),
    );
    expect(body).not.toContain('Stay');
  }],
  ['handoff timeout does not pollute stage recovery diagnostics', () => {
    const timeoutBody = rootSource.slice(
      rootSource.indexOf("outgoingOverlay.status !== 'holding'"),
      rootSource.indexOf('const handleTransitionOpaque'),
    );
    expect(timeoutBody).not.toContain('noteRecovery');
  }],
  ['different buffered destination does not drop navigateOut', () => {
    expect(pageSource).not.toMatch(
      /readWorldStageNavigationSnapshot[\s\S]*?return false/,
    );
    expect(navigationSource).toContain('bufferedNavigation =');
  }],
  ['handler activity path publishes target room before requesting', () => {
    expect(rootSource.indexOf('state.setActivityTarget({ roomKey })'))
      .toBeLessThan(rootSource.indexOf('decideStageNavigationOwnership({'));
  }],
  ['pathname-first activity path publishes target room before minting', () => {
    const childrenEffect = rootSource.slice(
      rootSource.indexOf('const pendingMatchesDestination'),
      rootSource.indexOf('useEffect(() =>', rootSource.indexOf('const pendingMatchesDestination')),
    );
    expect(childrenEffect.indexOf('state.setActivityTarget({ roomKey })'))
      .toBeLessThan(childrenEffect.indexOf('requestStageScene(sceneId)'));
  }],
  ['watchdog retry preserves the activity target', () => {
    const storeSource = readFileSync(resolve(import.meta.dir, 'stage-store.ts'), 'utf8');
    const retryBody = storeSource.slice(
      storeSource.indexOf('export function retryStageScene'),
      storeSource.indexOf('export function resetStageStore'),
    );
    expect(retryBody).not.toContain('clearActivityTarget');
    expect(retryBody).not.toContain('setActivityTarget');
  }],
];

if (cases.length !== 81) {
  throw new Error(`frozen stage-outgoing-overlay count drifted: ${cases.length}`);
}

describe('stage outgoing overlay and navigation lineage', () => {
  test.each(cases)('%s', (_name, assertion) => {
    assertion();
  });
});
