---
{
  "id": "new-route-table-service-env-updates-architecture",
  "mechanism": "coupling",
  "owner": "auth-identity-session",
  "status": "active",
  "trigger": [
    "apps/api/src/routes/**",
    "apps/api/src/services/**",
    "packages/database/src/schema/**",
    ".github/workflows/**",
    "scripts/deploy/**"
  ],
  "requires": [
    [
      "ARCHITECTURE.md"
    ]
  ],
  "selector": "architecture"
}
---

# new-route-table-service-env-updates-architecture

New route/service files and every schema or CI/deploy edit require architecture documentation. Existing route/service edits use their domain rules.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
