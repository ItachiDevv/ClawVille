import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import {
  reconcileDurableAutonomy,
  reconcileSeams,
} from '../agent-autonomy-reconcile';
import {
  armAutonomy,
  autonomyStandbyTestSeams,
  enterStandby,
  getStandbyState,
  isAutonomyActive,
  resolveAutonomyDefaultMode,
} from '../autonomy-standby';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const AGENT_ID = 'standby-house-agent';

type DriverInternals = {
  tick: () => void;
  runReconcile: () => Promise<void>;
  loadReconcileModule: () => Promise<{
    reconcileDurableAutonomy: () => Promise<unknown>;
  }>;
  tickCount: number;
  wasActive: boolean;
};

const driver = agentAutonomyDriver as unknown as DriverInternals;
const originalDriveAgentNow = agentAutonomyDriver.driveAgentNow;
const originalRunReconcile = driver.runReconcile;
const originalLoadReconcileModule = driver.loadReconcileModule;
const originalListFlaggedLiveOwners = reconcileSeams.listFlaggedLiveOwners;
const originalReconcileActivate = reconcileSeams.activate;

function registerAgent(): void {
  agentAutonomyDriver.registerHouseAgent({
    agentId: AGENT_ID,
    bodyId: 'standby-body',
    platformAgentId: 'standby-platform-agent',
    systemUserId: 'standby-system-user',
    houseUserId: 'standby-house-user',
    avatarId: 'standby-avatar',
  });
}

beforeEach(() => {
  setSystemTime(NOW);
  enterStandby();
  agentAutonomyDriver.unregisterHouseAgent(AGENT_ID);
  agentAutonomyDriver.driveAgentNow = originalDriveAgentNow;
  driver.runReconcile = originalRunReconcile;
  driver.loadReconcileModule = originalLoadReconcileModule;
  reconcileSeams.listFlaggedLiveOwners = originalListFlaggedLiveOwners;
  reconcileSeams.activate = originalReconcileActivate;
  driver.tickCount = 1;
  driver.wasActive = true;
});

afterEach(() => {
  agentAutonomyDriver.unregisterHouseAgent(AGENT_ID);
  agentAutonomyDriver.driveAgentNow = originalDriveAgentNow;
  driver.runReconcile = originalRunReconcile;
  driver.loadReconcileModule = originalLoadReconcileModule;
  reconcileSeams.listFlaggedLiveOwners = originalListFlaggedLiveOwners;
  reconcileSeams.activate = originalReconcileActivate;
  setSystemTime();
  autonomyStandbyTestSeams.restoreDefault();
});

describe('autonomy standby default resolution', () => {
  it('defaults staging to standby and production/unset to active', () => {
    expect(resolveAutonomyDefaultMode(undefined, 'staging')).toBe('standby');
    expect(resolveAutonomyDefaultMode(undefined, 'production')).toBe('active');
    expect(resolveAutonomyDefaultMode(undefined, undefined)).toBe('active');
  });

  it('honors AUTONOMY_STANDBY_DEFAULT over the deploy environment', () => {
    expect(resolveAutonomyDefaultMode('on', 'production')).toBe('standby');
    expect(resolveAutonomyDefaultMode('off', 'staging')).toBe('active');
  });
});

describe('autonomy standby state', () => {
  it('keeps the default-active mode unbounded when arm is called', () => {
    autonomyStandbyTestSeams.restoreDefault();
    expect(getStandbyState().defaultMode).toBe('active');

    expect(armAutonomy(15)).toMatchObject({
      mode: 'active',
      armedUntil: null,
      defaultMode: 'active',
    });
    setSystemTime(new Date(NOW.getTime() + 24 * 60 * 60_000));
    expect(isAutonomyActive()).toBe(true);
  });

  it('clamps arm windows and defaults invalid input to 120 minutes', () => {
    expect(armAutonomy(1).armedUntil).toBe(NOW.getTime() + 15 * 60_000);
    enterStandby();
    expect(armAutonomy(999).armedUntil).toBe(NOW.getTime() + 480 * 60_000);
    enterStandby();
    expect(armAutonomy(Number.NaN).armedUntil).toBe(NOW.getTime() + 120 * 60_000);
    enterStandby();
    expect(armAutonomy().armedUntil).toBe(NOW.getTime() + 120 * 60_000);
  });

  it('lazy-expires to standby and logs expiry only once', () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(String(args[0]));
    };
    try {
      armAutonomy(15);
      setSystemTime(new Date(NOW.getTime() + 15 * 60_000 + 1));
      expect(isAutonomyActive()).toBe(false);
      expect(getStandbyState()).toMatchObject({ mode: 'standby', armedUntil: null });
      expect(messages.filter((message) => message.includes('reason: expired'))).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });

  it('re-arm replaces and extends the active window', () => {
    const firstUntil = armAutonomy(30).armedUntil!;
    setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    const secondUntil = armAutonomy(30).armedUntil!;
    expect(secondUntil).toBe(firstUntil + 10 * 60_000);
  });
});

describe('autonomy driver standby gate', () => {
  it('skips the entire tick and reconcile in standby, then runs when armed', () => {
    registerAgent();
    const drive = mock(async () => true);
    const reconcile = mock(async () => {});
    agentAutonomyDriver.driveAgentNow = drive;
    driver.runReconcile = reconcile;
    driver.tickCount = 0;

    driver.tick();
    driver.tick();
    expect(driver.tickCount).toBe(0);
    expect(drive).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    armAutonomy(15);
    driver.tick();
    expect(driver.tickCount).toBe(1);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('auto-arms a 30-minute window for an explicit kick', () => {
    registerAgent();
    const drive = mock(async () => true);
    agentAutonomyDriver.driveAgentNow = drive;

    expect(agentAutonomyDriver.kickAgentNow(AGENT_ID)).toBe(true);
    expect(getStandbyState()).toMatchObject({
      mode: 'active',
      armedUntil: NOW.getTime() + 30 * 60_000,
    });
    expect(drive).toHaveBeenCalledWith(AGENT_ID);
  });

  it('does not auto-arm or drive a reconcile-origin kick in standby', () => {
    registerAgent();
    const drive = mock(async () => true);
    agentAutonomyDriver.driveAgentNow = drive;

    expect(agentAutonomyDriver.kickAgentNow(AGENT_ID, { autoArm: false })).toBe(false);
    expect(drive).not.toHaveBeenCalled();
    expect(getStandbyState()).toMatchObject({ mode: 'standby', armedUntil: null });
  });

  it('manual standby during the reconcile import prevents the pass from running', async () => {
    armAutonomy(15);
    const reconcile = mock(async () => ({}));
    let releaseImport!: (module: {
      reconcileDurableAutonomy: () => Promise<unknown>;
    }) => void;
    driver.loadReconcileModule = () => new Promise((resolve) => {
      releaseImport = resolve;
    });

    const pass = driver.runReconcile();
    await Promise.resolve();
    enterStandby();
    releaseImport({ reconcileDurableAutonomy: reconcile });
    await pass;

    expect(reconcile).not.toHaveBeenCalled();
    expect(getStandbyState()).toMatchObject({ mode: 'standby', armedUntil: null });
  });

  it('manual standby during an active reconcile cancels later enrollments', async () => {
    armAutonomy(15);
    reconcileSeams.listFlaggedLiveOwners = async () => [
      { agentId: 'standby-race-agent-1', userId: 'standby-race-owner-1' },
      { agentId: 'standby-race-agent-2', userId: 'standby-race-owner-2' },
    ];

    let markActivationStarted!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activate = mock(async () => {
      markActivationStarted();
      await activationGate;
      return { ok: true as const, reused: false, bodyId: 'standby-race-body' };
    });
    reconcileSeams.activate = activate;

    const pass = reconcileDurableAutonomy();
    await activationStarted;
    enterStandby();
    releaseActivation();
    await pass;

    expect(activate).toHaveBeenCalledTimes(1);
    expect(getStandbyState()).toMatchObject({ mode: 'standby', armedUntil: null });
  });
});
