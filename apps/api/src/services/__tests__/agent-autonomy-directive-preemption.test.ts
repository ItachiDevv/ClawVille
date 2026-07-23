import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AutonomyStatusThought } from "@clawville/shared";
import {
  agentAutonomyDriver,
  DEFAULT_DIRECTIVE_TTL_MS,
  MIN_DIRECTIVE_TTL_MS,
  directiveInstanceSha,
  isDirectiveExpired,
  resolveDirectiveTtlMs,
} from "../agent-autonomy-driver";
import { agentOrchestrator } from "../agent-orchestrator";
import type {
  AgentDirectiveState,
  CurrentDirective,
  DirectiveActedClaim,
} from "../agent-autonomy-state";
import { npcSimulation } from "../npc-simulation";

type RuntimeState = ReturnType<typeof agentOrchestrator.getRunningAgentRuntime>;

interface TestEntry {
  phase: "deciding" | "walking" | "arrived" | "talking";
  phaseSince: number;
  targetBuildingId: string | null;
  cursorSeeded: boolean;
  recentThoughts: AutonomyStatusThought[];
  lastDirectiveSha: string | null;
  lastActedDirectiveSha: string | null;
  directiveShaHydrated: boolean;
  directivePending: boolean;
}

interface DriverInternals {
  userAgents: Map<string, TestEntry>;
  readDirectiveBounded: (
    platformAgentId?: string,
    entry?: TestEntry,
  ) => Promise<CurrentDirective | null>;
  directiveStateRead: (platformAgentId: string) => Promise<AgentDirectiveState>;
  directiveClear: (
    platformAgentId: string,
    expectedDirective?: CurrentDirective,
  ) => Promise<void>;
  directiveActedShaClaim: (
    platformAgentId: string,
    sha: string,
    directive: CurrentDirective,
  ) => Promise<DirectiveActedClaim>;
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
const originalDirectiveStateRead = driver.directiveStateRead;
const originalDirectiveClear = driver.directiveClear;
const originalDirectiveActedShaClaim = driver.directiveActedShaClaim;
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
  driver.directiveStateRead = originalDirectiveStateRead;
  driver.directiveClear = originalDirectiveClear;
  driver.directiveActedShaClaim = originalDirectiveActedShaClaim;
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

describe("directive expiry and durable acted issuance", () => {
  it("parses the TTL config strictly and expires only after the boundary", () => {
    expect(resolveDirectiveTtlMs(undefined)).toBe(DEFAULT_DIRECTIVE_TTL_MS);
    expect(resolveDirectiveTtlMs("garbage")).toBe(DEFAULT_DIRECTIVE_TTL_MS);
    expect(resolveDirectiveTtlMs("-1")).toBe(DEFAULT_DIRECTIVE_TTL_MS);
    expect(resolveDirectiveTtlMs("900000junk")).toBe(DEFAULT_DIRECTIVE_TTL_MS);
    expect(resolveDirectiveTtlMs("1")).toBe(MIN_DIRECTIVE_TTL_MS);
    expect(resolveDirectiveTtlMs("1800000")).toBe(1_800_000);

    const now = Date.now();
    const exactBoundary: CurrentDirective = {
      text: "visit the cove",
      setAt: new Date(now - DEFAULT_DIRECTIVE_TTL_MS).toISOString(),
      setBy: "chat-bar",
    };
    expect(isDirectiveExpired(exactBoundary, now, DEFAULT_DIRECTIVE_TTL_MS)).toBe(false);
    expect(
      isDirectiveExpired(
        { ...exactBoundary, setAt: new Date(now - DEFAULT_DIRECTIVE_TTL_MS - 1).toISOString() },
        now,
        DEFAULT_DIRECTIVE_TTL_MS,
      ),
    ).toBe(true);
    expect(isDirectiveExpired({ ...exactBoundary, setAt: "not-a-date" }, now)).toBe(true);
  });

  it("treats an expired directive as absent and compare-and-clears that issuance", async () => {
    const entry = enroll();
    const expired: CurrentDirective = {
      text: "go play cards",
      setAt: new Date(Date.now() - DEFAULT_DIRECTIVE_TTL_MS - 1_000).toISOString(),
      setBy: "chat-bar",
    };
    const clears: Array<{ platformAgentId: string; expected?: CurrentDirective }> = [];
    const events: string[] = [];
    let writes = 0;
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => ({
      directive: expired,
      lastActedDirectiveSha: null,
    });
    driver.directiveClear = async (platformAgentId, expected) => {
      clears.push({ platformAgentId, expected });
    };
    driver.directiveActedShaClaim = async () => {
      writes++;
      return "claimed";
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };

    let prompt = "";
    await agentAutonomyDriver.driveOnce(AGENT, async (value) => {
      prompt = value;
      return "[ACTION: emote(name=wave)]";
    });
    await Promise.resolve();

    expect(prompt).not.toContain(expired.text);
    expect(clears).toEqual([{ platformAgentId: PLATFORM, expected: expired }]);
    expect(events).not.toContain("agent.directive.received");
    expect(events).not.toContain("agent.directive.acted");
    expect(writes).toBe(0);
    expect(entry.directiveShaHydrated).toBe(true);
  });

  it("hydrates a durable acted SHA on re-seat and fires neither event again", async () => {
    enroll();
    agentAutonomyDriver.unregisterUserAgent(AGENT);
    const entry = enroll();
    const directive: CurrentDirective = {
      text: "visit the cron building",
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    const sha = directiveInstanceSha(directive);
    const events: string[] = [];
    let writes = 0;
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => ({
      directive,
      lastActedDirectiveSha: sha,
    });
    driver.directiveActedShaClaim = async () => {
      writes++;
      return "claimed";
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };

    await agentAutonomyDriver.driveOnce(
      AGENT,
      async () => "[ACTION: emote(name=wave)]",
    );

    expect(entry.directiveShaHydrated).toBe(true);
    expect(entry.lastDirectiveSha).toBe(sha);
    expect(entry.lastActedDirectiveSha).toBe(sha);
    expect(events).not.toContain("agent.directive.received");
    expect(events).not.toContain("agent.directive.acted");
    expect(writes).toBe(0);
  });

  it("fires normally for a new issuance after an expired directive", async () => {
    const entry = enroll();
    const expired: CurrentDirective = {
      text: "visit the cove",
      setAt: new Date(Date.now() - DEFAULT_DIRECTIVE_TTL_MS - 1_000).toISOString(),
      setBy: "api",
    };
    const fresh: CurrentDirective = {
      // Same text proves setAt is part of the issuance identity.
      text: expired.text,
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    let state: AgentDirectiveState = { directive: expired, lastActedDirectiveSha: null };
    const events: string[] = [];
    const writes: string[] = [];
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => state;
    driver.directiveClear = async () => {};
    driver.directiveActedShaClaim = async (_platformAgentId, sha) => {
      writes.push(sha);
      return "claimed";
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };

    await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
    state = { directive: fresh, lastActedDirectiveSha: null };
    await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");

    const freshSha = directiveInstanceSha(fresh);
    expect(directiveInstanceSha(expired)).not.toBe(freshSha);
    expect(events.filter((event) => event === "agent.directive.received")).toHaveLength(1);
    expect(events.filter((event) => event === "agent.directive.acted")).toHaveLength(1);
    expect(writes).toEqual([freshSha]);
    expect(entry.lastActedDirectiveSha).toBe(freshSha);
  });

  it("keeps hydration unknown on read failure and persists before acted event", async () => {
    const entry = enroll();
    const directive: CurrentDirective = {
      text: "visit memory rag",
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    const order: string[] = [];
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => {
      throw new Error("db unavailable");
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      order.push(record.action);
      return { id: "record", deduped: false };
    };

    await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
    expect(entry.directiveShaHydrated).toBe(false);
    expect(order).not.toContain("agent.directive.received");
    expect(order).not.toContain("agent.directive.acted");

    driver.directiveStateRead = async () => ({ directive, lastActedDirectiveSha: null });
    driver.directiveActedShaClaim = async () => {
      order.push("persisted");
      return "claimed";
    };
    await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");

    expect(order).toEqual([
      "persisted",
      "agent.directive.received",
      "agent.directive.acted",
    ]);
  });

  it("lets only one overlapping claimant emit for a standing issuance", async () => {
    const entry = enroll();
    const directive: CurrentDirective = {
      text: "visit the cove",
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    const events: string[] = [];
    let claims = 0;
    let dispatches = 0;
    driver.readDirectiveBounded = originalDirectiveRead;
    // Model two process-local drivers that both read the pre-claim snapshot.
    driver.directiveStateRead = async () => ({ directive, lastActedDirectiveSha: null });
    driver.directiveActedShaClaim = async () => {
      claims++;
      return claims === 1 ? "claimed" : "already_recorded";
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };
    const originalDispatch = npcSimulation.dispatchHatcherActions;
    npcSimulation.dispatchHatcherActions = (...args) => {
      dispatches++;
      return originalDispatch.apply(npcSimulation, args);
    };

    try {
      await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
      // A second process has independent in-memory fields but the same stale DB
      // read; the atomic claim reports the already-recorded loser.
      entry.lastDirectiveSha = null;
      entry.lastActedDirectiveSha = null;
      entry.directiveShaHydrated = true;
      await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
    } finally {
      npcSimulation.dispatchHatcherActions = originalDispatch;
    }

    expect(claims).toBe(2);
    expect(dispatches).toBe(2);
    expect(events.filter((event) => event === "agent.directive.received")).toHaveLength(1);
    expect(events.filter((event) => event === "agent.directive.acted")).toHaveLength(1);
  });

  it("keeps action dispatch fail-soft when the acted claim is unknown", async () => {
    const entry = enroll();
    const directive: CurrentDirective = {
      text: "visit the cove",
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    const events: string[] = [];
    let claimAttempts = 0;
    let dispatches = 0;
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => ({ directive, lastActedDirectiveSha: null });
    driver.directiveActedShaClaim = async () => {
      claimAttempts++;
      if (claimAttempts === 1) throw new Error("write unavailable");
      return "claimed";
    };
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };
    const originalDispatch = npcSimulation.dispatchHatcherActions;
    npcSimulation.dispatchHatcherActions = (...args) => {
      dispatches++;
      return originalDispatch.apply(npcSimulation, args);
    };

    try {
      await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
      expect(entry.lastActedDirectiveSha).toBeNull();
      expect(events).toEqual([]);
      await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
    } finally {
      npcSimulation.dispatchHatcherActions = originalDispatch;
    }

    expect(claimAttempts).toBe(2);
    expect(dispatches).toBe(2);
    expect(events).toEqual(["agent.directive.received", "agent.directive.acted"]);
    expect(entry.lastActedDirectiveSha).toBe(directiveInstanceSha(directive));
  });

  it("does not emit or dispatch when the directive is superseded mid-decision", async () => {
    enroll();
    const directive: CurrentDirective = {
      text: "visit the cove",
      setAt: new Date().toISOString(),
      setBy: "api",
    };
    const events: string[] = [];
    let dispatches = 0;
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => ({ directive, lastActedDirectiveSha: null });
    driver.directiveActedShaClaim = async () => "superseded";
    agentAutonomyDriver.covenantRecord = async (record) => {
      events.push(record.action);
      return { id: "record", deduped: false };
    };
    const originalDispatch = npcSimulation.dispatchHatcherActions;
    npcSimulation.dispatchHatcherActions = (...args) => {
      dispatches++;
      return originalDispatch.apply(npcSimulation, args);
    };

    try {
      await agentAutonomyDriver.driveOnce(AGENT, async () => "[ACTION: emote(name=wave)]");
    } finally {
      npcSimulation.dispatchHatcherActions = originalDispatch;
    }

    expect(events).toEqual([]);
    expect(dispatches).toBe(0);
  });
});
