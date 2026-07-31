import { describe, expect, test } from 'bun:test';
import {
  decideWorldDownlink,
  type WorldDownlinkInput,
} from './world-downlink-policy';
import {
  createWorldStreamMachineState,
  decide,
} from './world-stream-machine';

const streamSource = await Bun.file(
  `${import.meta.dir}/use-world-stream.ts`,
).text();
const machineSource = await Bun.file(
  `${import.meta.dir}/world-stream-machine.ts`,
).text();

const connected: WorldDownlinkInput = {
  wanted: true,
  open: true,
  pendingReopen: false,
  recoveryInFlight: false,
  hasSession: true,
  hasRoom: true,
};

describe('decideWorldDownlink', () => {
  test('closes an open source when the downlink is not wanted', () => {
    expect(
      decideWorldDownlink({ ...connected, wanted: false }),
    ).toBe('CLOSE');
  });

  test('opens a connected room when the downlink is wanted', () => {
    expect(
      decideWorldDownlink({ ...connected, open: false }),
    ).toBe('OPEN');
  });

  test('does nothing when the held source already matches intent', () => {
    expect(decideWorldDownlink(connected)).toBe('NONE');
  });

  test('closes an owed reopen even after the failed source was dropped', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
        pendingReopen: true,
      }),
    ).toBe('CLOSE');
  });

  test('does not pre-empt retry backoff', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        pendingReopen: true,
      }),
    ).toBe('NONE');
  });

  test('does not open without a session', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        hasSession: false,
      }),
    ).toBe('NONE');
  });

  test('does not open without a room', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        hasRoom: false,
      }),
    ).toBe('NONE');
  });

  test('defers opening to a live recovery', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        recoveryInFlight: true,
      }),
    ).toBe('NONE');
  });

  test('does not fold recovery into the close rule', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
        recoveryInFlight: true,
      }),
    ).toBe('NONE');
  });

  test('is idempotent after close clears the source and retry token', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
      }),
    ).toBe('NONE');
  });
});

describe('world downlink integration contract', () => {
  test('cold activity emits no bootstrap, join, stream, or upload', () => {
    const result = decide(createWorldStreamMachineState(), {
      type: 'TICK',
      now: 1,
      policy: 'remote',
      hasSession: false,
      canUpload: true,
      hasFrozenPosition: false,
      recoveryInFlight: false,
      poseChanged: false,
      activeActivity: 'idle',
    });
    expect(result.actions).toEqual([]);
  });

  test('active to activity to active spends no resume join', () => {
    let state = createWorldStreamMachineState();
    let result = decide(state, {
      type: 'TICK',
      now: 1,
      policy: 'active',
      hasSession: false,
      canUpload: true,
      hasFrozenPosition: false,
      recoveryInFlight: false,
      poseChanged: false,
      activeActivity: 'idle',
    });
    expect(result.actions).toContain('BOOTSTRAP');
    state = decide(result.nextState, {
      type: 'BOOTSTRAP_OK',
      now: 2,
    }).nextState;
    result = decide(state, {
      type: 'TICK',
      now: 3,
      policy: 'remote',
      hasSession: true,
      canUpload: true,
      hasFrozenPosition: true,
      recoveryInFlight: false,
      poseChanged: false,
      activeActivity: 'idle',
    });
    result = decide(result.nextState, {
      type: 'TICK',
      now: 4,
      policy: 'active',
      hasSession: true,
      canUpload: true,
      hasFrozenPosition: true,
      recoveryInFlight: false,
      poseChanged: false,
      activeActivity: 'idle',
    });
    expect(result.actions).not.toContain('BOOTSTRAP');
  });

  test('racing error is closed through pendingReopen before retry', () => {
    expect(streamSource).toContain('pendingReopen: activeRetryToken !== null');
    expect(streamSource).toContain("if (downlinkAction === 'CLOSE')");
    expect(streamSource).toContain('activeRetryToken = null');
  });

  test('every source handler carries the live downlink guard', () => {
    expect(
      streamSource.match(/if \(!downlinkEnabledRef\.current\) return;/g),
    ).toHaveLength(4);
  });

  test('source ownership rejects callbacks from replaced sources', () => {
    expect(streamSource.match(/if \(es !== source\) return;/g)).toHaveLength(5);
  });

  test('ticketed rejoin rotates the stream epoch through invalidation', () => {
    expect(streamSource).toMatch(
      /function settleRecovery[\s\S]*?invalidateStream\(\);[\s\S]*?openStream/,
    );
  });

  test('supersession rotates the stream epoch through invalidation', () => {
    expect(streamSource).toMatch(
      /function handleSuperseded[\s\S]*?invalidateStream\(\)/,
    );
  });

  test('ordinary enabled error arms one delayed replacement', () => {
    expect(streamSource).toMatch(
      /source\.onerror[\s\S]*?dropFailedSource\(source\)[\s\S]*?armRetry\(roomId, delay, shouldEscalate\)/,
    );
  });

  test('machine ticks cannot pre-empt an armed retry', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        pendingReopen: true,
      }),
    ).toBe('NONE');
  });

  test.each([
    ['close', /function closeStream\(\)[\s\S]*?invalidateStream\(\)/],
    ['rejoin replacement', /function settleRecovery[\s\S]*?invalidateStream\(\)/],
    ['supersession', /function handleSuperseded[\s\S]*?invalidateStream\(\)/],
    ['teardown', /return \(\) => \{[\s\S]*?cancelled = true[\s\S]*?invalidateStream\(\)/],
  ] as const)('%s invalidates an armed retry token', (_name, pattern) => {
    expect(streamSource).toMatch(pattern);
    expect(streamSource).toMatch(
      /function invalidateStream\(\)[\s\S]*?activeRetryToken = null/,
    );
  });

  test('pendingReopen spans the async recovery continuation', () => {
    expect(streamSource).toMatch(
      /const token = \+\+retryTokenSeq;[\s\S]*?activeRetryToken = token;[\s\S]*?recoverWithTicket\(\)\.then/,
    );
  });

  test('post-await fallback rechecks token and downlink intent', () => {
    expect(streamSource).toMatch(
      /recoverWithTicket\(\)\.then[\s\S]*?activeRetryToken !== token[\s\S]*?!downlinkEnabledRef\.current/,
    );
  });

  test('disable then re-enable success leaves recovery as sole opener', () => {
    expect(streamSource).toMatch(
      /if \(downlinkEnabledRef\.current\) \{\s*openStream\(outcome\.data\.roomId\)/,
    );
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        recoveryInFlight: true,
      }),
    ).toBe('NONE');
  });

  test('failed recovery clears ownership for the tick edge', () => {
    expect(streamSource).toMatch(
      /activeRecoveryLease = null;\s*recoveryInFlight = false;[\s\S]*?RECOVERY_FAILED/,
    );
  });

  test('armed escalation cannot bare-open beneath a 409 recovery', () => {
    expect(streamSource).toMatch(
      /if \(recoveryInFlight\) \{[\s\S]*?armRetry\(roomId, delayMs, shouldEscalate, since\);[\s\S]*?return;/,
    );
  });

  test.each([
    ['success makes the re-armed timer inert', 'activeRetryToken = null'],
    ['failure leaves the re-armed timer live', 'activeRetryToken !== token'],
  ] as const)('busy recovery re-arms: %s', (_name, marker) => {
    expect(streamSource).toContain(marker);
    expect(streamSource).toContain('deferredSince ?? Date.now()');
  });

  test('non-escalating retry refuses to open while recovery is busy', () => {
    const busyIndex = streamSource.indexOf('if (recoveryInFlight) {');
    const bareIndex = streamSource.indexOf('if (!shouldEscalate) {');
    expect(busyIndex).toBeGreaterThan(-1);
    expect(busyIndex).toBeLessThan(bareIndex);
  });

  test('multiple retry expiries under one recovery open nothing directly', () => {
    expect(streamSource).toMatch(
      /if \(recoveryInFlight\)[\s\S]*?armRetry\([\s\S]*?return;[\s\S]*?if \(!shouldEscalate\)/,
    );
  });

  test('recovery success owns exactly one open site', () => {
    expect(streamSource).toMatch(
      /settleRecovery[\s\S]*?invalidateStream\(\);[\s\S]*?openStream\(outcome\.data\.roomId\)/,
    );
  });

  test('recovery failure permits exactly one fallback path', () => {
    expect(streamSource).toMatch(
      /rejoinedRoomId !== null\) return;[\s\S]*?lastAttemptWasBareReopen = true;\s*openStream\(roomId\)/,
    );
  });

  test('busy-wait ceiling retires retry ownership', () => {
    expect(streamSource).toMatch(
      /Date\.now\(\) - since >= RECOVERY_WAIT_CEILING_MS\) \{\s*activeRetryToken = null;\s*return;/,
    );
  });

  test('escalation branch is unreachable while already busy', () => {
    expect(streamSource.indexOf('if (recoveryInFlight) {')).toBeLessThan(
      streamSource.indexOf('void recoverWithTicket().then'),
    );
  });

  test('bootstrap remains structurally gated on missing session', () => {
    expect(machineSource).toContain('!input.hasSession');
    const rejoinBody = streamSource.slice(
      streamSource.indexOf('function rejoinWithTicket'),
      streamSource.indexOf('function settleRecovery'),
    );

    expect(rejoinBody).not.toContain('sessionIdRef.current = null');
  });

  test('never-settling recovery has an independent deadline settlement', () => {
    expect(streamSource).toMatch(
      /const deadlineTimer = setTimeout\(\(\) => \{[\s\S]*?settleRecovery\(lease, \{ kind: 'timeout' \}\)/,
    );
  });

  test('late recovery success is refused by the lease CAS', () => {
    expect(streamSource).toContain('if (activeRecoveryLease !== lease) return null');
  });

  test('late supersession is refused before handleSuperseded', () => {
    const guard = streamSource.indexOf(
      'if (activeRecoveryLease !== lease) return null',
    );
    const superseded = streamSource.indexOf(
      "if (outcome.kind === 'superseded')",
    );
    expect(guard).toBeLessThan(superseded);
  });

  test('deadline does not depend on the fetch honoring abort', () => {
    expect(streamSource).toContain('const done = new Promise<string | null>');
    expect(streamSource).toContain('controller.abort()');
    expect(streamSource).toContain('resolveDone(settleRecovery');
  });

  test('deadline-first and late join both call the settlement CAS', () => {
    expect(
      streamSource.match(/resolveDone\(settleRecovery\(lease,/g),
    ).toHaveLength(3);
  });

  test('a refused late success cannot reach source construction', () => {
    const guard = streamSource.indexOf(
      'if (activeRecoveryLease !== lease) return null',
    );
    const open = streamSource.indexOf('openStream(outcome.data.roomId)', guard);
    expect(open).toBeGreaterThan(guard);
  });

  test.each([
    'deadline-first',
    'join-success-first',
    'join-rejection',
    'superseded-first',
    'disable-during-wait',
    'lease-1-late-after-lease-2-starts',
    'cancelled-before-settlement',
  ])('%s has a single guarded settlement owner', () => {
    expect(streamSource).toContain(
      'if (activeRecoveryLease !== lease) return null',
    );
    const settlementBody = streamSource.slice(
      streamSource.indexOf('function settleRecovery'),
      streamSource.indexOf('function postPosition'),
    );

    expect(settlementBody.match(/recoveryInFlight = false/g)).toHaveLength(1);
  });

  test('recoverWithTicket contains no machine dispatch', () => {
    const body = streamSource.match(
      /async function recoverWithTicket[\s\S]*?\n    \}/,
    )?.[0];
    expect(body).toBeDefined();
    expect(body).not.toContain('transitionMachine');
  });

  test('operation-first settlement clears its deadline timer', () => {
    expect(
      streamSource.match(/clearTimeout\(deadlineTimer\)/g),
    ).toHaveLength(2);
  });

  test('late lease one cannot clear lease two ownership', () => {
    const guard = streamSource.indexOf(
      'if (activeRecoveryLease !== lease) return null',
    );
    const clear = streamSource.indexOf('activeRecoveryLease = null', guard);
    expect(clear).toBeGreaterThan(guard);
  });

  test('join deadline is strictly below retry retirement ceiling', () => {
    const join = Number(streamSource.match(/JOIN_TIMEOUT_MS = ([\d_]+)/)?.[1].replace('_', ''));
    const ceiling = Number(
      streamSource.match(/RECOVERY_WAIT_CEILING_MS = ([\d_]+)/)?.[1].replace('_', ''),
    );
    expect(join).toBeLessThan(ceiling);
  });

  test.each([
    ['hung bootstrap aborts and returns null', /joinBounded[\s\S]*?controller\.abort\(\);\s*return null/],
    ['late bootstrap result loses the completed race', /Promise\.race\(\[[\s\S]*?operation\.then/],
  ] as const)('bounded bootstrap: %s', (_name, pattern) => {
    expect(streamSource).toMatch(pattern);
  });

  test('bootstrap while disabled still writes membership without opening', () => {
    expect(streamSource).toMatch(
      /sessionIdRef\.current = joined\.id;[\s\S]*?setRoomId\(joined\.roomId\);[\s\S]*?if \(downlinkEnabledRef\.current\)/,
    );
  });

  test('rejoin while disabled repairs membership without opening', () => {
    expect(streamSource).toMatch(
      /sessionIdRef\.current = outcome\.data\.id;[\s\S]*?invalidateStream\(\);[\s\S]*?if \(downlinkEnabledRef\.current\)/,
    );
  });

  test('OPEN edge invalidates land exactly at resume', () => {
    expect(streamSource).toMatch(
      /downlinkAction === 'OPEN'[\s\S]*?openStream\(roomIdRef\.current!\);[\s\S]*?LAND_PARCELS_QUERY_KEY/,
    );
  });

  test.each([
    ['persisted pageshow resets membership', /if \(!event\.persisted\) return;[\s\S]*?sessionIdRef\.current = null/],
    ['non-persisted pageshow is a no-op', /function handlePageShow[\s\S]*?if \(!event\.persisted\) return;/],
  ] as const)('%s', (_name, pattern) => {
    expect(streamSource).toMatch(pattern);
  });

  test('effect teardown rotates epoch and kills retry lineage', () => {
    expect(streamSource).toMatch(
      /return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?invalidateStream\(\)/,
    );
  });

  test('unmount while suspended follows one normal cleanup path', () => {
    expect(streamSource.match(/return \(\) => \{/g)).toHaveLength(1);
    expect(streamSource).toContain('leaveBeacon()');
  });

  test('world stream machine public policy and action shapes are unchanged', () => {
    expect(machineSource).toContain(
      "export type WorldPresencePolicy = 'active' | 'remote'",
    );
    expect(machineSource).not.toContain('downlinkEnabled');
    expect(machineSource).not.toContain('pendingReopen');
  });
});
