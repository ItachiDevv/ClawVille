---
{
  "id": "env-var-updates-architecture",
  "mechanism": "coupling",
  "owner": "auth-identity-session",
  "status": "active",
  "trigger": [
    ".env.example",
    "apps/api/**/*.ts"
  ],
  "requires": [
    [
      "ARCHITECTURE.md"
    ]
  ],
  "selector": "new-env"
}
---

# env-var-updates-architecture

New literal process.env dot or quoted-bracket keys require architecture documentation. Dynamic computed keys need human review.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
