---
{
  "id": "protected-partner-surface-updates-spec-and-harness",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/routes/partner-hatcher*.ts",
    "apps/api/src/routes/portal.ts",
    "apps/api/src/routes/portal/**",
    "apps/api/src/routes/skills.ts",
    "apps/api/src/services/partner-signature.ts",
    "apps/api/src/services/service-issuer.ts",
    "apps/api/src/services/skill-protocol.ts",
    "apps/api/src/services/agent-substrate-client.ts",
    "apps/api/src/services/agent-session-config.ts",
    "apps/api/src/services/hatcher-config.ts",
    "apps/api/src/services/hatcher-session-webhook.ts",
    "apps/api/src/services/reserved-agent-namespaces.ts",
    "apps/api/src/services/agent-session-restore.ts",
    "apps/api/src/middleware/require-auth-or-agent.ts",
    "packages/shared/src/types/agent-substrate.ts",
    "packages/shared/src/types/openclaw.ts",
    "apps/api/scripts/hatcher/**",
    ".hatcher-ref/CONTRACT.md"
  ],
  "requires": [
    [
      "docs/hatcher-integration-spec.md"
    ]
  ],
  "selector": "any"
}
---

# protected-partner-surface-updates-spec-and-harness

Protected partner changes update the specification. The name follows the approved plan; signed staging harness execution remains a separate release requirement.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
