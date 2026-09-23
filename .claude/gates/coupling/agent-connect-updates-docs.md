---
{
  "id": "agent-connect-updates-docs",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/routes/agent*.ts",
    "apps/web/src/components/agent-connect-instructions.tsx",
    "apps/web/src/components/game/agent-connect*.tsx",
    "apps/web/src/components/game/connect-agent*.tsx"
  ],
  "requires": [
    [
      "ARCHITECTURE.md"
    ],
    [
      "GameFeatures.md"
    ]
  ],
  "selector": "any"
}
---

# agent-connect-updates-docs

Agent connection changes update Architecture and GameFeatures, following the current canonical same-diff rule.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
