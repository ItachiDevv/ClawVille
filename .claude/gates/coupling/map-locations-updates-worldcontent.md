---
{
  "id": "map-locations-updates-worldcontent",
  "mechanism": "coupling",
  "owner": "world-presence",
  "status": "active",
  "trigger": [
    "packages/shared/src/constants/map-locations.ts",
    "packages/shared/src/constants/building-types.ts"
  ],
  "requires": [
    [
      "WorldContent.md"
    ]
  ],
  "selector": "any"
}
---

# map-locations-updates-worldcontent

Building roster changes update WorldContent.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
