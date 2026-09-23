---
{
  "id": "action-whitelist-bumps-protocol-version",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/services/npc-simulation.ts",
    "packages/shared/src/constants/hatcher-actions.ts"
  ],
  "requires": [
    [
      "apps/api/src/services/skill-protocol.ts"
    ]
  ],
  "selector": "executor",
  "assertion": "protocol-increase"
}
---

# action-whitelist-bumps-protocol-version

Changed dispatch/execution methods or shared action menu require a changed manual and a strict literal integer PROTOCOL_VERSION increase.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
