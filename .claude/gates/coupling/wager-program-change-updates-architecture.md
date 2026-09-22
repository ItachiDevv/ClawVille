---
{
  "id": "wager-program-change-updates-architecture",
  "mechanism": "coupling",
  "owner": "activities-arena",
  "status": "active",
  "trigger": [
    "apps/api/src/services/wager-program-client.ts",
    "apps/api/src/routes/wager.ts",
    "contracts/wager/**",
    "packages/wager-program/**"
  ],
  "requires": [
    [
      "ARCHITECTURE.md"
    ]
  ],
  "selector": "any"
}
---

# wager-program-change-updates-architecture

Wager client, route, and contract changes update Architecture.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
