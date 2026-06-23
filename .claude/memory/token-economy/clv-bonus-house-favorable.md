---
name: clv-bonus-house-favorable
description: "The 25% CT bonus on $CLAWVILLE pay must Math.floor (house-favorable) — never ceil/round. NOT in staging code (payai branch). OPEN/future"
category: economy
confidence: high
date: 2026-06-22
---

# CLV 25% bonus floors house-favorable (OPEN / not-in-tree)

**Rule:** paying in $CLAWVILLE grants a 25% CT bonus. The bonus math MUST `Math.floor` (or bigint integer division) so rounding is ALWAYS house-favorable — never `ceil`/`round`/`Math.round` the credited CT, or it leaks a fractional CT per top-up.

**Verify** with a unit test on non-round amounts (e.g. a stake whose `*1.25` is non-integer) asserting the credited CT == `Math.floor(base + base*0.25)`.

**STATE: NOT IN THIS WORKTREE.** Confirmed absent via grep (no `clvBonus`/`1.25`/`bonusCt` in `apps`) 2026-06-22. Lives on the unmerged `feat/payai-x402-economy` branch (`_global` memory `project_payai_x402_integration`). **OPEN/future.**

Related: `[[on-ramp-double-credit-guard]]`, `[[usdc-ct-boundary-x402-not-payai]]`.
