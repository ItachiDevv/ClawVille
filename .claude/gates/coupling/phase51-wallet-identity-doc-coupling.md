---
{
  "id": "phase51-wallet-identity-doc-coupling",
  "mechanism": "coupling",
  "owner": "agent-protocol-partner",
  "status": "active",
  "trigger": [
    "apps/api/src/routes/portal.ts",
    "apps/api/src/routes/portal/**",
    "apps/api/src/services/cf-secrets-*.ts",
    "apps/api/src/services/service-issuer.ts",
    "apps/api/src/services/auth-challenge.ts",
    "apps/api/src/services/identity-service.ts",
    "apps/api/src/services/keypair-vault.ts",
    "apps/api/src/services/wallet-service.ts"
  ],
  "requires": [
    [
      "ARCHITECTURE.md"
    ]
  ],
  "selector": "any"
}
---

# phase51-wallet-identity-doc-coupling

Wallet identity and custody changes update Architecture section 7.

Source: `.claude/plans/ci-gates-protection.md`, Phase 1; current ownership: `.claude/agents/REGISTRY.md`.
The runner checks changed content, not file existence. Human review still checks documentation accuracy.
