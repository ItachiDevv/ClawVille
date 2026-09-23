---
{
  "id": "three-d-updates-3dstructure",
  "mechanism": "coupling",
  "owner": "3da",
  "status": "active",
  "trigger": [
    "apps/web/src/lib/three/**",
    "apps/web/src/components/three/**",
    "apps/web/public/models/**"
  ],
  "requires": [
    [
      "3dStructure.md"
    ]
  ],
  "selector": "any"
}
---

# three-d-updates-3dstructure

World render code and model changes update 3dStructure. This gate does not replace independent visual review.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
