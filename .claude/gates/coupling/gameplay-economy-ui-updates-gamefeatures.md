---
{
  "id": "gameplay-economy-ui-updates-gamefeatures",
  "mechanism": "coupling",
  "owner": "activities-arena",
  "status": "active",
  "trigger": [
    "apps/web/src/components/game/**",
    "apps/web/src/components/cove/**",
    "packages/shared/src/constants/knowledge-books.ts",
    "packages/shared/src/constants/avatar-archetypes.ts",
    "packages/shared/src/constants/map-locations.ts",
    "apps/api/src/routes/quests.ts",
    "apps/api/src/routes/claws.ts",
    "apps/api/src/routes/avatars.ts",
    "apps/api/src/services/claw-token-ledger.ts",
    "apps/api/src/services/daily-login*.ts"
  ],
  "requires": [
    [
      "GameFeatures.md"
    ]
  ],
  "selector": "any"
}
---

# gameplay-economy-ui-updates-gamefeatures

Gameplay, economy, and UI changes update GameFeatures.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
