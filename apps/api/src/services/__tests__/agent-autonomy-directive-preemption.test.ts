import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AutonomyStatusThought } from "@clawville/shared";
import { agentAutonomyDriver } from "../agent-autonomy-driver";
import { agentOrchestrator } from "../agent-orchestrator";
import type { CurrentDirective } from "../agent-autonomy-state";
import { npcSimulation } from "../npc-simulation";

type RuntimeState = ReturnType<typeof agentOrchestrator.getRunningAgentRuntime>;

interface TestEntry {
  phase: "deciding" | "walking" | "arrived" | "talking";
  phaseSince: number;
  targetBuildingId: string | null;
  cursorSeeded: boolean;
  recentThoughts: AutonomyStatusThought[];
  directivePending: boolean;
}

interface DriverInternals {
  userAgents: Map<string, TestEntry>;
  readDirectiveBounded: () => Promise<CurrentDirective | null>;
  readRecentLessons: () => Promise<string[]>;
}

interface SimInternals {
  npcs: Map<string, ReturnType<typeof makeBody>>;
  initNpcs: () => void;
}

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;
const OWNER = "directive-preemption-owner";
const AGENT = "directive-preemption-agent";
const BODY = "directive-preemption-body";
const PLATFORM = "directive-preemption-platform";

const originalDirectiveRead = driver.readDirectiveBounded;
const originalLessonRead = driver.readRecentLessons;
const originalCovenantRecord = agentAutonomyDriver.covenantRecord;
const originalGetRuntime = agentOrchestrator.getRunningAgentRuntime;

function makeBody(id: string) {
  return {
    id,
    name: "DirectivePreemptionAgent",
    x: 11264,
    y: 11264,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [] as string[],
    activity: "idle" as const,
    activityEmoji: "",
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: "idle" as const,
    species: "milady_official_1",
    isOpenClaw: true,
    autonomyMode: "self-managed" as const,
    inConversation: false,
    conversationCooldownUntil: 0,
    invulnerableUntil: 0,
    path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0,
    destinationBuildingId: null as string | null,
    behaviorCooldown: 0,
  };
}

function enroll(): TestEntry {
  sim.npcs.set(BODY, makeBody(BODY));
  expect(
    agentAutonomyDriver.registerUserAgent({
      agentId: AGENT,
      bodyId: BODY,
      platformAgentId: PLATFORM,
      systemUserId: OWNER,
      houseUserId: OWNER,
      avatarId: "directive-preemption-avatar",
    }),
  ).toEqual({ ok: true, reused: false });
  const entry = driver.userAgents.get(AGENT)!;
  entry.cursorSeeded = true;
  return entry;
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds())
    agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds())
    agentAutonomyDriver.unregisterUserAgent(id);
  driver.readDirectiveBounded = async () => null;
  driver.readRecentLessons = async () => [];
  agentAutonomyDriver.covenantRecord = async () => ({
    id: "record",
    deduped: false,
  });
});

afterEach(() => {
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.readRecentLessons = originalLessonRead;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  for (const id of agentAutonomyDriver.getHouseAgentIds())
    agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds())
    agentAutonomyDriver.unregisterUserAgent(id);
});

describe("human directive preemption", () => {
  it("preempts walking and decides in the same cycle", async () => {
    const entry = enroll();
    entry.phase = "walking";
    entry.phaseSince = Date.now();
    entry.targetBuildingId = "cove";
    entry.directivePending = true;
    let decides = 0;

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return "";
    });

    expect(driver.userAgents.get(AGENT)!.phase).toBe("deciding");
    expect(entry.targetBuildingId).toBeNull();
    expect(entry.directivePending).toBe(false);
    expect(decides).toBe(1);
    expect(entry.recentThoughts).toContainEqual(
      expect.objectContaining({
        type: "directive",
        text: "New directive — replanning now",
      }),
    );
  });

  it("preempts an active talking linger without waiting for its cooldown", async () => {
    const entry = enroll();
    entry.phase = "talking";
    entry.phaseSince = Date.now() - 5_000;
    entry.targetBuildingId = "cove";
    entry.directivePending = true;
    let decides = 0;

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return "";
    });

    expect(driver.userAgents.get(AGENT)!.phase).toBe("deciding");
    expect(entry.targetBuildingId).toBeNull();
    expect(entry.directivePending).toBe(false);
    expect(decides).toBe(1);
  });

  it("consumes a deciding-phase pending flag exactly once", async () => {
    const entry = enroll();
    entry.directivePending = true;
    let reads = 0;
    let decides = 0;
    driver.readDirectiveBounded = async () => {
      reads++;
      return null;
    };

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return "";
    });
    expect(entry.directivePending).toBe(false);
    expect(reads).toBe(1);
    expect(decides).toBe(1);

    // With no fresh flag, a non-deciding phase stays on its LLM-free fast path.
    entry.phase = "talking";
    entry.phaseSince = Date.now();
    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return "";
    });
    expect(reads).toBe(1);
    expect(decides).toBe(1);
  });

  it("clears the fast-path flag after the read while the durable directive remains retryable", async () => {
    const entry = enroll();
    const durableDirective: CurrentDirective = {
      text: "go play cards",
      setAt: new Date(0).toISOString(),
      setBy: "api",
    };
    entry.directivePending = true;
    let reads = 0;
    driver.readDirectiveBounded = async () => {
      reads++;
      return durableDirective;
    };

    await expect(
      agentAutonomyDriver.driveOnce(AGENT, async () => ""),
    ).resolves.toBeUndefined();
    expect(entry.directivePending).toBe(false);
    expect(entry.phase).toBe("deciding");
    expect(reads).toBe(1);

    // The flag is only the immediate wake signal. The DB row is durable, so a
    // later ordinary deciding tick reads the same directive again after an empty
    // (timeout-contract) decision without needing to re-arm the fast path.
    await expect(
      agentAutonomyDriver.driveOnce(AGENT, async () => ""),
    ).resolves.toBeUndefined();
    expect(entry.directivePending).toBe(false);
    expect(entry.phase).toBe("deciding");
    expect(reads).toBe(2);
  });

  it("runs exactly one follow-up when a directive lands after the in-flight read", async () => {
    const entry = enroll();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let decides = 0;
    const runtime = {
      decide: async () => {
        decides++;
        if (decides === 1) {
          markFirstStarted();
          await firstHeld;
        }
        return "";
      },
    } as unknown as RuntimeState;
    agentOrchestrator.getRunningAgentRuntime = () => runtime;

    const firstDrive = agentAutonomyDriver.driveAgentNow(AGENT);
    await firstStarted;
    // The first drive already read and cleared pending before entering decide.
    expect(entry.directivePending).toBe(false);
    expect(agentAutonomyDriver.kickEnrolledOwnerNow(OWNER, PLATFORM)).toBe(
      true,
    );
    expect(entry.directivePending).toBe(true);

    releaseFirst();
    expect(await firstDrive).toBe(true);
    for (let i = 0; i < 10 && (decides < 2 || entry.directivePending); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(decides).toBe(2);
    expect(entry.directivePending).toBe(false);
  });

  it("bounds the immediate follow-up when a cycle cannot consume the flag", async () => {
    const entry = enroll();
    entry.directivePending = true;
    sim.npcs.delete(BODY);
    const runtime = { decide: async () => "" } as unknown as RuntimeState;
    agentOrchestrator.getRunningAgentRuntime = () => runtime;
    const originalDriveOnce = agentAutonomyDriver.driveOnce;
    let cycles = 0;
    agentAutonomyDriver.driveOnce = async (agentId, decide) => {
      cycles++;
      return originalDriveOnce.call(agentAutonomyDriver, agentId, decide);
    };

    try {
      expect(await agentAutonomyDriver.driveAgentNow(AGENT)).toBe(true);
      for (let i = 0; i < 10 && cycles < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(cycles).toBe(2);
      expect(entry.directivePending).toBe(true);
    } finally {
      agentAutonomyDriver.driveOnce = originalDriveOnce;
    }
  });

  it("does not flag or drive when the enrolled platform identity mismatches", async () => {
    const entry = enroll();
    const originalDriveNow = agentAutonomyDriver.driveAgentNow;
    let drives = 0;
    agentAutonomyDriver.driveAgentNow = async () => {
      drives++;
      return true;
    };

    try {
      expect(
        agentAutonomyDriver.kickEnrolledOwnerNow(OWNER, "wrong-platform"),
      ).toBe(false);
      expect(entry.directivePending).toBe(false);
      expect(drives).toBe(0);
    } finally {
      agentAutonomyDriver.driveAgentNow = originalDriveNow;
    }
  });
});
