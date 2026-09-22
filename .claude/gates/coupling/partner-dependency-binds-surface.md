---
{
  "id": "partner-dependency-binds-surface",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/middleware/require-auth-or-agent.ts",
    "packages/shared/src/types/agent-substrate.ts",
    "packages/shared/src/types/openclaw.ts",
    "apps/api/src/services/agent-substrate-client.ts",
    "apps/api/src/services/npc-simulation.ts",
    "apps/api/src/routes/leaderboard.ts",
    "packages/shared/src/constants/hatcher-actions.ts"
  ],
  "requires": [
    [
      "docs/hatcher-integration-spec.md"
    ]
  ],
  "selector": "any"
}
---

# partner-dependency-binds-surface

Changes in partner dependencies update the specification even outside partner-named files.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
