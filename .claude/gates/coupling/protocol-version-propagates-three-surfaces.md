---
{
  "id": "protocol-version-propagates-three-surfaces",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/services/skill-protocol.ts"
  ],
  "requires": [
    [
      "docs/hatcher-integration-spec.md"
    ]
  ],
  "selector": "protocol-version"
}
---

# protocol-version-propagates-three-surfaces

A changed protocol version requires the partner specification. This file coupling does not prove runtime delivery.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
