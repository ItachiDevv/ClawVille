---
{
  "id": "gameplay-updates-connection-skillmd",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/routes/cove-*.ts",
    "apps/api/src/routes/quests.ts",
    "apps/api/src/routes/bounties.ts",
    "apps/api/src/routes/activit*.ts",
    "apps/api/src/routes/leaderboard.ts",
    "apps/api/src/routes/exchange.ts",
    "apps/api/src/services/activity/**",
    "apps/api/src/services/poker/**",
    "apps/api/src/services/slot-engine.ts",
    "apps/api/src/services/blackjack-engine.ts",
    "apps/api/src/services/baccarat-engine.ts",
    "apps/api/src/services/holdem-engine.ts",
    "apps/web/src/components/game/**",
    "apps/web/src/components/cove/**",
    "packages/shared/src/constants/map-locations.ts",
    "packages/shared/src/constants/building-types.ts",
    "packages/shared/src/constants/knowledge-books.ts",
    "packages/database/src/schema/cove*.ts",
    "packages/database/src/schema/poker*.ts",
    "packages/database/src/schema/blackjack*.ts",
    "packages/database/src/schema/baccarat*.ts",
    "packages/database/src/schema/holdem*.ts",
    "packages/database/src/schema/quests*.ts",
    "packages/database/src/schema/bounties*.ts",
    "apps/api/src/services/skill-protocol.ts",
    "apps/api/src/services/npc-simulation.ts",
    "packages/shared/src/constants/hatcher-actions.ts"
  ],
  "requires": [
    [
      "apps/api/src/services/skill-protocol.ts"
    ]
  ],
  "selector": "any"
}
---

# gameplay-updates-connection-skillmd

Gameplay changes update the connection manual. Existing hosted runtime installation consumes that manual; this gate does not prove live installation.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
