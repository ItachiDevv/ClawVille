---
name: feature-gate-skill-marketplace
description: "The skill_marketplace FEATURE_GATE on all three routes; open-ended deadline ('to be defined / after the overhaul ships') is itself debt; lapsed-without-metric = DELETE not extend; un-pause is all-or-none (shared gate)."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: feature-gate-skill-marketplace
description: The skill_marketplace FEATURE_GATE lifecycle — open-ended deadline = debt; lapsed = DELETE; un-pause is all-or-none across the 3 routes sharing it.
category: constraint
confidence: 0.9
date: 2026-06-22
---

# FEATURE_GATE: skill_marketplace

**State: OPEN debt (verified present in all three routes a4daf0d8).**

All three peer-commerce routes carry the `FEATURE_GATE skill_marketplace` block (bazaar.ts:22-29, marketplace.ts:14-19, auctions.ts:235-240). The graduate-metric + review-deadline read, verbatim:
> Metric to graduate: to be defined during rework.
> Review deadline: after the architecture overhaul ships.

## The constraint (CLAUDE.md no-scaffolding-theater)
A scaffolded feature gate whose deadline lapses WITHOUT the metric being met is **DELETED, not silently extended**. Gate renewal must cite a NEW metric reading, never 'we still want it.' The current open-ended deadline + undefined metric is itself debt to SURFACE as a founder decision — not to perpetuate.

## Un-pause is all-or-none (the shared gate)
All three surfaces share ONE gate. Un-pausing one (e.g. removing only the bazaar gate) is a product-decision reversal that fractures the shared decision AND the menu. Un-pause is founder-approved, all-or-none, same-diff across the 3 gates + 3 modals + docs + the 3 operational-knowledge surfaces.

## Same-diff
Keep the gate honest across all 3 route files + improvements.md §7 (the pause SSOT — a gitignored draft, not in every worktree at read time).

Related: `[[peer-commerce-paused-503]]`, `[[unpause-becomes-money-path]]`.
