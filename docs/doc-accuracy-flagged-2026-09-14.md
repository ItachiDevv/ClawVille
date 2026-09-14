# Documentation accuracy pass 2026-09-14 — FLAGGED items (not fixed in the docs-only diff)

Source: the 2026-09-14 documentation accuracy pass (Codex-audited, Fable-reviewed;
fixed items landed in `GameFeatures.md` / `ARCHITECTURE.md` / `README.md` /
`3dStructure.md` the same day). Each item below was deliberately NOT fixed in that
diff because it needs code, a protected-surface process, or its own change. Rule E6
punch list: every entry carries an owner and a review deadline. On the deadline,
fix it or delete the stale surface — do not renew without a reason.

| # | Surface | Finding (code evidence) | Owner | Deadline |
|---|---|---|---|---|
| 1 | `apps/web/src/app/dash/page.tsx:168` | Dash copy still says "npm sideload (live)"; sideload was retired 2026-07-23. Web-source string, not a doc. | knowledge-orientation | 2026-09-21 |
| 2 | `apps/api/src/routes/agent-export.ts:217` | Export still emits `@clawville/app-clawville` (retired npm plugin). | agent-protocol-partner | 2026-09-21 |
| 3 | Protocol manual (`skill-protocol.ts:1975`) | Manual describes same-key settlement retries; `bounty-tier1.ts:358` suffixes the idempotency key after attempt 1. Served-manual change: needs the three-surface rule + `PROTOCOL_VERSION` bump. | agent-protocol-partner | 2026-09-21 |
| 4 | Nori knowledge (`town-guide.ts:269`) | Says founder land is auction-allocated; founder ruling 2026-09-13 is HOLD-ONLY. Three-surface rule applies. | knowledge-orientation | 2026-09-21 |
| 5 | ARCHITECTURE Hatcher inventory | Retains five-verb / version-5 claims; live executor has 14 verbs (`npc-simulation.ts:2764`), `PROTOCOL_VERSION` 58 (`skill-protocol.ts:479`). Protected partner surface: fix under the §11 change-control mandates, not a plain doc edit. | agent-protocol-partner | 2026-09-28 |
| 6 | `land-economy.ts:43,64,78`, `land-showroom.ts:129` | Source comments retain auction claims / a stale 16-entry count. Code-comment fixes. | land | 2026-09-28 |
| 7 | `.env.example` (checkout/top-up + transfer-proof comments) | States a 30000ms stale floor (code: 180000ms) and a removed memo requirement. | token-economy | 2026-09-21 |
| 8 | `docs/money-rails.md:16,29,46` | Retains SAP and pre-recovery claims. Historical-banner or rewrite decision needed. | token-economy | 2026-09-28 |
| 9 | `docs/x402-partner-alignment-specs-2026-07-22.md`, `docs/custody-architecture-spec-2026-07-21.md` (+ its review) | Retain SAP assumptions. Likely historical banners. | token-economy | 2026-09-28 |
| 10 | `docs/uos-integration-plan.md:50,175`, `docs/vclaw-economy-microdenomination-plan-2026-07-12.md`, `docs/house-revenue-map-2026-07-06.md` | Retain SAP / removed-commerce descriptions. Likely historical banners. | token-economy | 2026-09-28 |
| 11 | `docs/eliza-integration-architecture.md:154,359,375` | Describes deleted bazaar functionality. | knowledge-orientation | 2026-09-28 |

OPEN (could not be settled from the worktree): the external Milady curated-grid
status and the README mirror-service claim need outside evidence; the historical
smoke-avatar record's current prod state is unverified.
