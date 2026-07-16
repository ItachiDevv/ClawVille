import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ActivityIdentity } from "../../middleware/require-auth-or-agent";
import {
  emitBuildingSkillClaimEvent,
  executeBuildingSkillClaim,
  resetBuildingSkillClaimRateLimit,
  skillsRoutes,
} from "../skills";
import { BuildingSkillInstallError } from "../../services/building-skill-install";
import type { EventInput } from "../../services/event-logger";

const USER: ActivityIdentity = {
  kind: "user",
  userId: "user-1",
  avatarId: "avatar-1",
  agentId: null,
};

const AGENT: ActivityIdentity = {
  kind: "agent",
  userId: "user-1",
  avatarId: "avatar-1",
  agentId: "agent-1",
  sessionId: "session-redacted",
  ledgerCapable: true,
};

const SAFE_DEPENDENCIES = {
  allowSubject: () => true,
  isGuest: async () => false,
};

afterEach(() => {
  resetBuildingSkillClaimRateLimit();
});

describe("POST /:buildingId/claim auth boundary", () => {
  it("rejects a request with no subject", async () => {
    const response = await skillsRoutes.request("/agent-security/claim", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("X-Clawville-Agent-Session");
  });

  it("does not treat a partner key alone as a claim subject", async () => {
    const response = await skillsRoutes.request("/agent-security/claim", {
      method: "POST",
      headers: { Authorization: "Bearer partner-key-is-read-only-here" },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("X-Clawville-Agent-Session");
  });
});

describe("executeBuildingSkillClaim", () => {
  it("rejects an ownership-unproven agent before service execution", async () => {
    const install = mock(async () => {
      throw new Error("must not run");
    });
    const onSuccess = mock(async () => {});
    const result = await executeBuildingSkillClaim(
      { ...AGENT, ledgerCapable: false },
      "agent-security",
      { ...SAFE_DEPENDENCIES, install, onSuccess },
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "ownership_required" });
    expect(install).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it.each(["runtime", "marker", "already"] as const)(
    "passes the exact ownership-proven agent subject and emits one event for %s",
    async (installed) => {
      const install = mock(async () => ({
        buildingId: "agent-security",
        contentHash: `sha256:${"a".repeat(64)}`,
        installed,
      }));
      const onSuccess = mock(async () => {});
      const result = await executeBuildingSkillClaim(
        AGENT,
        "agent-security",
        { ...SAFE_DEPENDENCIES, install, onSuccess },
      );

      expect(result.status).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledWith({
        userId: "user-1",
        avatarId: "avatar-1",
        buildingId: "agent-security",
        provenAgentId: "agent-1",
      });
      expect(result.body).toMatchObject({ ok: true, installed });
      expect(onSuccess).toHaveBeenCalledTimes(1);
    },
  );

  it("passes a Lucia subject without inventing a proven agent id", async () => {
    const install = mock(async () => ({
      buildingId: "memory-rag",
      contentHash: `sha256:${"b".repeat(64)}`,
      installed: "marker" as const,
    }));
    const result = await executeBuildingSkillClaim(USER, "memory-rag", {
      ...SAFE_DEPENDENCIES,
      install,
    });

    expect(result.status).toBe(200);
    expect(install).toHaveBeenCalledWith({
      userId: "user-1",
      avatarId: "avatar-1",
      buildingId: "memory-rag",
    });
  });

  it("returns the entry-skill hint as 400", async () => {
    const onSuccess = mock(async () => {});
    const result = await executeBuildingSkillClaim(
      USER,
      "clawville-play",
      {
        ...SAFE_DEPENDENCIES,
        install: async () => {
          throw new BuildingSkillInstallError(
            "entry_skill_auto_installed",
            "auto-installed",
          );
        },
        onSuccess,
      },
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: "entry_skill_auto_installed",
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("returns an unknown building as 404", async () => {
    const onSuccess = mock(async () => {});
    const result = await executeBuildingSkillClaim(
      USER,
      "unknown-building",
      {
        ...SAFE_DEPENDENCIES,
        install: async () => {
          throw new BuildingSkillInstallError("skill_not_found", "missing");
        },
        onSuccess,
      },
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "skill_not_found",
      buildingId: "unknown-building",
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("rejects a guest user before installer or event execution", async () => {
    const install = mock(async () => {
      throw new Error("must not run");
    });
    const onSuccess = mock(async () => {});
    const result = await executeBuildingSkillClaim(USER, "memory-rag", {
      allowSubject: () => true,
      isGuest: async () => true,
      install,
      onSuccess,
    });

    expect(result).toEqual({
      status: 403,
      body: {
        error: "demo_account",
        hint: "Guest accounts play the demo economy - sign up to install skills.",
      },
    });
    expect(install).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("limits the resolved subject to 30 claims per minute", async () => {
    const install = mock(async () => ({
      buildingId: "memory-rag",
      contentHash: `sha256:${"c".repeat(64)}`,
      installed: "already" as const,
    }));
    const onSuccess = mock(async () => {});

    for (let i = 0; i < 30; i += 1) {
      const allowed = await executeBuildingSkillClaim(USER, "memory-rag", {
        isGuest: async () => false,
        install,
        onSuccess,
      });
      expect(allowed.status).toBe(200);
    }
    const limited = await executeBuildingSkillClaim(USER, "memory-rag", {
      isGuest: async () => false,
      install,
      onSuccess,
    });

    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "rate_limited" });
    expect(install).toHaveBeenCalledTimes(30);
    expect(onSuccess).toHaveBeenCalledTimes(30);
  });

  it("emits the organic event shape with canonical subject attribution", async () => {
    const emit = mock(
      async (_context: { get(key: string): unknown }, _event: EventInput) => {},
    );
    const context = {
      get: () => undefined,
      req: {
        header: (name: string) =>
          name === "user-agent"
            ? "claim-test-agent"
            : name === "referer"
              ? "https://clawville.world/game"
              : undefined,
      },
    };

    await emitBuildingSkillClaimEvent(context, AGENT, "agent-security", {
      loadMetadata: async () => ({
        name: "Agent Security",
        generatorVersion: 7,
      }),
      emit,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]?.[1];
    expect(event).toMatchObject({
      eventType: "skill_md.fetched",
      userId: "user-1",
      avatarId: "avatar-1",
      agentId: "agent-1",
      buildingId: "agent-security",
      payload: {
        userAgent: "claim-test-agent",
        referer: "https://clawville.world/game",
        skillName: "Agent Security",
        generatorVersion: 7,
        gated: true,
        method: "claim",
      },
    });
    expect(event?.sessionId).not.toBe(AGENT.sessionId);
    expect(event?.sessionId).toMatch(/^[a-f0-9]{16}$/);
    expect(event?.payload).not.toHaveProperty("via");
  });

  it("attributes a human claim to the resolved user and avatar only", async () => {
    const emit = mock(
      async (_context: { get(key: string): unknown }, _event: EventInput) => {},
    );
    const context = {
      get: () => undefined,
      req: { header: () => undefined },
    };

    await emitBuildingSkillClaimEvent(context, USER, "memory-rag", {
      loadMetadata: async () => ({ name: "Memory RAG", generatorVersion: 4 }),
      emit,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      userId: "user-1",
      avatarId: "avatar-1",
      agentId: null,
      sessionId: null,
      buildingId: "memory-rag",
    });
    expect(emit.mock.calls[0]?.[1]?.payload).not.toHaveProperty("via");
  });

  it("keeps a persisted claim successful when analytics throws", async () => {
    const result = await executeBuildingSkillClaim(USER, "memory-rag", {
      ...SAFE_DEPENDENCIES,
      install: async () => ({
        buildingId: "memory-rag",
        contentHash: `sha256:${"d".repeat(64)}`,
        installed: "runtime" as const,
      }),
      onSuccess: async () => {
        throw new Error("analytics unavailable");
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, installed: "runtime" });
  });

  it.each([
    ["agent_not_connected", 409],
    ["runtime_unavailable", 503],
  ] as const)("emits nothing when install fails with %s", async (code, status) => {
    const onSuccess = mock(async () => {});
    const result = await executeBuildingSkillClaim(USER, "memory-rag", {
      ...SAFE_DEPENDENCIES,
      install: async () => {
        throw new BuildingSkillInstallError(code, code);
      },
      onSuccess,
    });

    expect(result.status).toBe(status);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
