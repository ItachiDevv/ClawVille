import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BUILDING_INTERACTION_RADIUS } from "@clawville/shared";
import {
  agentAutonomyDriver,
  directiveInstanceSha,
  FAST_PATH_USED_MAX,
} from "../agent-autonomy-driver";
import type {
  AgentDirectiveState,
  CurrentDirective,
  DirectiveActedClaim,
} from "../agent-autonomy-state";
import { npcSimulation } from "../npc-simulation";

// Driver-level wiring of the directive fast path (autonomy-directive-fastpath.ts).
// Harness copied from agent-autonomy-directive-preemption.test.ts.

interface TestEntry {
  phase: "deciding" | "walking" | "arrived" | "talking";
  phaseSince: number;
  targetBuildingId: string | null;
  cursorSeeded: boolean;
  lastDirectiveSha: string | null;
  lastActedDirectiveSha: string | null;
  directiveShaHydrated: boolean;
  directivePending: boolean;
}

interface DriverInternals {
  userAgents: Map<string, TestEntry>;
  houseAgents: Map<string, TestEntry>;
  readDirectiveBounded: (
    platformAgentId?: string,
    entry?: TestEntry,
  ) => Promise<CurrentDirective | null | undefined>;
  directiveStateRead: (platformAgentId: string) => Promise<AgentDirectiveState>;
  directiveClear: (platformAgentId: string, expectedDirective?: CurrentDirective) => Promise<void>;
  directiveActedShaClaim: (
    platformAgentId: string,
    sha: string,
    directive: CurrentDirective,
  ) => Promise<DirectiveActedClaim>;
  readRecentLessons: () => Promise<string[]>;
  fastPathUsedSha: Map<string, string>;
  markFastPathUsed: (platformAgentId: string, directiveSha: string) => void;
}

interface SimInternals {
  npcs: Map<string, ReturnType<typeof makeBody>>;
  initNpcs: () => void;
}

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;
const OWNER = "directive-fastpath-owner";
const AGENT = "directive-fastpath-agent";
const BODY = "directive-fastpath-body";
const PLATFORM = "directive-fastpath-platform";

const originalDirectiveRead = driver.readDirectiveBounded;
const originalDirectiveStateRead = driver.directiveStateRead;
const originalDirectiveClear = driver.directiveClear;
const originalDirectiveActedShaClaim = driver.directiveActedShaClaim;
const originalLessonRead = driver.readRecentLessons;
const originalCovenantRecord = agentAutonomyDriver.covenantRecord;
const originalDispatch = npcSimulation.dispatchHatcherActions;

function makeBody(id: string) {
  return {
    id,
    name: "DirectiveFastPathAgent",
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

function enroll(kind: "user" | "house" = "user"): TestEntry {
  sim.npcs.set(BODY, makeBody(BODY));
  const registration = {
    agentId: AGENT,
    bodyId: BODY,
    platformAgentId: PLATFORM,
    systemUserId: OWNER,
    houseUserId: OWNER,
    avatarId: "directive-fastpath-avatar",
  };
  if (kind === "user") {
    expect(agentAutonomyDriver.registerUserAgent(registration)).toEqual({ ok: true, reused: false });
  } else {
    expect(agentAutonomyDriver.registerHouseAgent(registration)).toBe(true);
  }
  const entry = (kind === "user" ? driver.userAgents : driver.houseAgents).get(AGENT)!;
  entry.cursorSeeded = true;
  return entry;
}

/** Durable directive state + claim + event + dispatch capture. */
function harness(text: string) {
  const directive: CurrentDirective = { text, setAt: new Date().toISOString(), setBy: "api" };
  const events: string[] = [];
  const dispatched: string[] = [];
  let decides = 0;
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.directiveStateRead = async () => ({ directive, lastActedDirectiveSha: null });
  driver.directiveClear = async () => {};
  driver.directiveActedShaClaim = async () => "claimed";
  agentAutonomyDriver.covenantRecord = async (record) => {
    events.push(record.action);
    return { id: "record", deduped: false };
  };
  npcSimulation.dispatchHatcherActions = (...args) => {
    dispatched.push(args[1]);
    return originalDispatch.apply(npcSimulation, args);
  };
  const decide = async () => {
    decides++;
    return "[ACTION: emote(name=wave)]";
  };
  return { directive, events, dispatched, decide, decides: () => decides };
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
  driver.readDirectiveBounded = async () => null;
  driver.readRecentLessons = async () => [];
  // The used-issuance map is driver-level and survives unregister by design;
  // clear it so one test's issuance never gates another's.
  driver.fastPathUsedSha.clear();
  agentAutonomyDriver.covenantRecord = async () => ({ id: "record", deduped: false });
});

afterEach(() => {
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.directiveStateRead = originalDirectiveStateRead;
  driver.directiveClear = originalDirectiveClear;
  driver.directiveActedShaClaim = originalDirectiveActedShaClaim;
  driver.readRecentLessons = originalLessonRead;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  npcSimulation.dispatchHatcherActions = originalDispatch;
  driver.fastPathUsedSha.clear();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
});

describe("directive fast path in driveOnce", () => {
  it("a new 'go to the cove' directive skips the model and dispatches enter_cove", async () => {
    const entry = enroll();
    const h = harness("go to the cove");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(0);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]"]);
    expect(h.events).toEqual(["agent.directive.received", "agent.directive.acted"]);
    expect(entry.lastDirectiveSha).toBe(directiveInstanceSha(h.directive));
    expect(entry.lastActedDirectiveSha).toBe(directiveInstanceSha(h.directive));
    expect(entry.phase).toBe("walking");
    expect(entry.targetBuildingId).toBe("cove");
  });

  it("the same standing directive on the next decision goes to the model", async () => {
    const entry = enroll();
    const h = harness("go to the cove");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);
    expect(h.decides()).toBe(0);
    // Back to deciding with the SAME issuance (not new): the model decides.
    entry.phase = "deciding";
    entry.targetBuildingId = null;
    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(1);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]", "[ACTION: emote(name=wave)]"]);
    expect(h.events.filter((e) => e === "agent.directive.received")).toHaveLength(1);
    expect(h.events.filter((e) => e === "agent.directive.acted")).toHaveLength(1);
  });

  it("a compound directive goes to the model", async () => {
    enroll();
    const h = harness("go to the cove and play slots");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(1);
    expect(h.dispatched).toEqual(["[ACTION: emote(name=wave)]"]);
    expect(h.events).toEqual(["agent.directive.received", "agent.directive.acted"]);
  });

  it("an agent already at the cove goes to the model", async () => {
    enroll();
    const cove = npcSimulation.buildPerception(BODY)!.places.find((p) => p.placeId === "cove")!;
    const body = sim.npcs.get(BODY)!;
    body.x = cove.centerX;
    body.y = cove.centerY;
    expect(npcSimulation.buildPerception(BODY)!.places.find((p) => p.placeId === "cove")!.distance)
      .toBeLessThanOrEqual(BUILDING_INTERACTION_RADIUS);
    const h = harness("go to the cove");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(1);
    expect(h.dispatched).toEqual(["[ACTION: emote(name=wave)]"]);
  });

  it("a building directive dispatches enter_building with the canonical slug", async () => {
    const entry = enroll();
    const h = harness("Go to Squidward's House.");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(0);
    expect(h.dispatched).toEqual(["[ACTION: enter_building(buildingId=memory-rag)]"]);
    expect(h.events).toEqual(["agent.directive.received", "agent.directive.acted"]);
    expect(entry.phase).toBe("walking");
    expect(entry.targetBuildingId).toBe("memory-rag");
  });

  it("the Trading Floor stays with the model (ambiguous alias)", async () => {
    enroll();
    const h = harness("go to the trading floor");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(1);
  });

  // Codex BLOCKING fix: an unknown acted claim leaves directiveWasNew true, so
  // the fast path must be gated per issuance, not on directiveWasNew alone.
  for (const mode of ["error", "timeout"] as const) {
    it(`an acted claim ${mode} uses the fast path once, then the model decides`, async () => {
      const entry = enroll();
      const h = harness("go to the cove");
      let claims = 0;
      driver.directiveActedShaClaim = async () => {
        claims++;
        if (claims === 1) {
          if (mode === "error") throw new Error("write unavailable");
          return new Promise<DirectiveActedClaim>(() => {}); // never settles -> bounded 'unknown'
        }
        return "claimed";
      };

      await agentAutonomyDriver.driveOnce(AGENT, h.decide);
      expect(h.decides()).toBe(0);
      expect(h.dispatched).toEqual(["[ACTION: enter_cove()]"]);
      expect(h.events).toEqual([]);
      // The unknown claim stamped nothing, so the issuance still reads as new.
      expect(entry.lastDirectiveSha).toBeNull();
      expect(entry.lastActedDirectiveSha).toBeNull();

      // Walk failed: back to deciding with the SAME issuance.
      entry.phase = "deciding";
      entry.targetBuildingId = null;
      await agentAutonomyDriver.driveOnce(AGENT, h.decide);

      expect(h.decides()).toBe(1);
      expect(h.dispatched).toEqual(["[ACTION: enter_cove()]", "[ACTION: emote(name=wave)]"]);
      // Event retries are unchanged: the received + acted pair lands on the retry.
      expect(h.events).toEqual(["agent.directive.received", "agent.directive.acted"]);
      expect(claims).toBe(2);
    });
  }

  // Codex r2 BLOCKING fix: the used-issuance record must survive autonomy off/on.
  it("claim error, then unregister + re-register: the same issuance goes to the model", async () => {
    enroll();
    const h = harness("go to the cove");
    driver.directiveActedShaClaim = async () => {
      throw new Error("write unavailable");
    };

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);
    expect(h.decides()).toBe(0);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]"]);
    expect(driver.fastPathUsedSha.get(PLATFORM)).toBe(directiveInstanceSha(h.directive));

    // Autonomy off/on: a fresh entry for the same platform agent.
    agentAutonomyDriver.unregisterUserAgent(AGENT);
    expect(driver.userAgents.has(AGENT)).toBe(false);
    expect(driver.fastPathUsedSha.get(PLATFORM)).toBe(directiveInstanceSha(h.directive));
    const fresh = enroll();
    expect(fresh.phase).toBe("deciding");
    // The fresh entry hydrates on its first directive read; the claim failed, so
    // the issuance still reads as new (directiveWasNew). Only the driver-level
    // record keeps the fast path from replaying.
    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(1);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]", "[ACTION: emote(name=wave)]"]);
    expect(fresh.lastDirectiveSha).toBeNull();
  });

  it("the used-issuance map evicts the oldest key past its bound", () => {
    for (let i = 0; i < FAST_PATH_USED_MAX; i++) driver.markFastPathUsed(`platform-${i}`, `sha-${i}`);
    expect(driver.fastPathUsedSha.size).toBe(FAST_PATH_USED_MAX);
    // Re-marking an existing key moves it to the newest position.
    driver.markFastPathUsed("platform-0", "sha-0b");
    driver.markFastPathUsed("platform-new", "sha-new");

    expect(driver.fastPathUsedSha.size).toBe(FAST_PATH_USED_MAX);
    expect(driver.fastPathUsedSha.has("platform-1")).toBe(false);
    expect(driver.fastPathUsedSha.get("platform-0")).toBe("sha-0b");
    expect(driver.fastPathUsedSha.get("platform-new")).toBe("sha-new");
    expect(driver.fastPathUsedSha.has("platform-2")).toBe(true);
  });

  it("a NEW issuance of the same text gets the fast path again", async () => {
    const entry = enroll();
    const h = harness("go to the cove");
    await agentAutonomyDriver.driveOnce(AGENT, h.decide);
    expect(h.decides()).toBe(0);

    const reissued: CurrentDirective = {
      ...h.directive,
      setAt: new Date(Date.parse(h.directive.setAt) + 1_000).toISOString(),
    };
    expect(directiveInstanceSha(reissued)).not.toBe(directiveInstanceSha(h.directive));
    driver.directiveStateRead = async () => ({ directive: reissued, lastActedDirectiveSha: null });
    entry.phase = "deciding";
    entry.targetBuildingId = null;
    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(0);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]", "[ACTION: enter_cove()]"]);
    expect(entry.lastDirectiveSha).toBe(directiveInstanceSha(reissued));
  });

  it("a house agent takes the same fast path", async () => {
    const entry = enroll("house");
    const h = harness("go to the cove");

    await agentAutonomyDriver.driveOnce(AGENT, h.decide);

    expect(h.decides()).toBe(0);
    expect(h.dispatched).toEqual(["[ACTION: enter_cove()]"]);
    expect(h.events).toEqual(["agent.directive.received", "agent.directive.acted"]);
    expect(entry.phase).toBe("walking");
  });
});
