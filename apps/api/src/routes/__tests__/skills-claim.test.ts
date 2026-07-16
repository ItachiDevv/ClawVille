import { describe, expect, it, mock } from "bun:test";
import type { ActivityIdentity } from "../../middleware/require-auth-or-agent";
import { executeBuildingSkillClaim, skillsRoutes } from "../skills";
import { BuildingSkillInstallError } from "../../services/building-skill-install";

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
    const result = await executeBuildingSkillClaim(
      { ...AGENT, ledgerCapable: false },
      "agent-security",
      install,
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "ownership_required" });
    expect(install).not.toHaveBeenCalled();
  });

  it("passes the exact ownership-proven agent subject and emits no side effect beyond install", async () => {
    const install = mock(async () => ({
      buildingId: "agent-security",
      contentHash: `sha256:${"a".repeat(64)}`,
      installed: "runtime" as const,
    }));
    const result = await executeBuildingSkillClaim(
      AGENT,
      "agent-security",
      install,
    );

    expect(result.status).toBe(200);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({
      userId: "user-1",
      avatarId: "avatar-1",
      buildingId: "agent-security",
      provenAgentId: "agent-1",
    });
    expect(result.body).toMatchObject({ ok: true, installed: "runtime" });
  });

  it("passes a Lucia subject without inventing a proven agent id", async () => {
    const install = mock(async () => ({
      buildingId: "memory-rag",
      contentHash: `sha256:${"b".repeat(64)}`,
      installed: "marker" as const,
    }));
    const result = await executeBuildingSkillClaim(USER, "memory-rag", install);

    expect(result.status).toBe(200);
    expect(install).toHaveBeenCalledWith({
      userId: "user-1",
      avatarId: "avatar-1",
      buildingId: "memory-rag",
    });
  });

  it("returns the entry-skill hint as 400", async () => {
    const result = await executeBuildingSkillClaim(
      USER,
      "clawville-play",
      async () => {
        throw new BuildingSkillInstallError(
          "entry_skill_auto_installed",
          "auto-installed",
        );
      },
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: "entry_skill_auto_installed",
    });
  });

  it("returns an unknown building as 404", async () => {
    const result = await executeBuildingSkillClaim(
      USER,
      "unknown-building",
      async () => {
        throw new BuildingSkillInstallError("skill_not_found", "missing");
      },
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "skill_not_found",
      buildingId: "unknown-building",
    });
  });
});
