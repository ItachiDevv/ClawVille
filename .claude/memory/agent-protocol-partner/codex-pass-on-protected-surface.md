---
name: codex-pass-on-protected-surface
description: "Any change to signing/verification, session/bearer resolution, the SSRF allowlist, money/CT settlement, or the custodial-wallet path gets a Codex adversarial pass before ship. These are the exact paths repeated reviews kept finding holes in. Backend full-team rules apply."
category: constraint
confidence: high
date: 2026-06-22
---

# Codex adversarial pass on the protected surface

**Status: MANDATORY process rule (CLAUDE.md protected-surface mandate #4).**

## Rule
ANY change to these paths gets a **Codex adversarial pass** before 'done' (the exact paths repeated independent reviews kept finding holes in — this domain is BRITTLE):
- signing / verification (`partner-signature.ts`, `service-issuer.ts`)
- session / bearer resolution (`partner-hatcher.ts` register/PATCH, `require-auth-or-agent.ts`)
- the SSRF allowlist (`hatcher-config.ts`, `openclaw-client.ts`)
- money / CT settlement (the cove agent path, `ensureHatcherAvatar`)
- the custodial-wallet / identity / scoped-token path (`keypair-vault.ts`, `wallet-service.ts`, `identity-service.ts`)

Backend full-team rules apply (impl + reconciler + spec/regress/adversary auditors). `bun test` green is NOT a substitute for the adversarial audit. Codex has caught what Claude missed on this surface every round.

## Same-diff obligations
- Update `docs/hatcher-integration-spec.md` when the WIRE contract changes (load-bearing 'cross-validated against live code' promise).
- Cross-check `.hatcher-ref/CONTRACT.md` (refresh first if stale). → [[validate-against-hatcher-ref]]
- Bump `PROTOCOL_VERSION` + propagate per the three-surface rule when the contract/verb set changes. → [[whitelist-manual-protocol-parity]]
- Run the mock-Hatcher harness GREEN on staging. → [[mock-hatcher-harness-gate]]

## Blast radius reminder
Hatcher PROD → ClawVille PROD since 2026-06-15. Staging IS the live partner's prod target — a staging break is a LIVE break. Never push directly to master (staging-first); never claim 'done' without harness GREEN + (where the wire changed) the partner-facing doc updated.
