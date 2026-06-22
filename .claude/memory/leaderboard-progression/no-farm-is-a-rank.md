---
name: no-farm-is-a-rank
description: "Measurement integrity is the premise: per-(subject,day) caps + the (fp,ip) tag + bot/guest zero-score keep contribution honest; a farm that climbs the board is a product-level defect"
category: economy
confidence: high
date: 2026-06-22
---

ClawVille's Priority #3 is a FREE contribution-based leaderboard — its only value is measurement integrity. A farmed rank is the leaderboard sibling of token-economy's conservation breach: it doesn't mint CT, but it corrupts the one signal the product is graded on (retention + contribution). A path that lets a farm climb is a PRODUCT-LEVEL DEFECT, not a tuning issue.

**The three layers that keep contribution honest (all must hold):**
1. **Per-(subject,day) `LEAST(count,cap)` caps** in BOTH CTE legs — over-cap events still LOG but score capped, so re-spamming a high-weight event today can't climb. Activity uses a proportional cap ([[activity-proportional-cap]]); session uses a midnight-safe distinct cap ([[scoring-cte-dual-leg-lockstep]]).
2. **The (fp_hash, ip_prefix_hash) forensic tag** (salted by FINGERPRINT_SECRET) on every request-path event via logEventFromContext — the farm-detection tier surfaced by `/dash fingerprintCoverage24h`. The OPEN gap: agent.collaboration.turn is bare-logEvent fp-null ([[fphash-coverage-gap]]).
3. **Bot + guest zero-score** (`subjectType <> 'bot'`, `isGuest <> 'true'`) + guest-403 on account-bound rewards ([[guest-reward-farm-guard]]) — guests/bots feed nothing persistent.

**The legitimate-faucet list (these EARN, by design):** XP level-up (50/level), tutorial-quest claims (~175 CT total, once each, engagement-gated), admin-quest approvals, daily-login (min(100, 10+streak*5)), bounty payouts (PAUSED). Every one is ledger-only + atomic + idempotent ([[reward-credit-atomic-idempotent]]) — an UN-idempotent reward is a CT faucet, the economy sibling of an uncapped score being a rank faucet.

**Rule:** any new scored action gets a weight + a cap + the fp tag + bot/guest exclusion; any new reward gets the ledger + an idempotency anchor + a guest guard. A weight that rewards arcade over learning is also a brand violation (Q3 §2.4 set learning > arcade).

Status: layers 1+3 hold; layer 2 has the agent.collaboration.turn OPEN gap. Related: [[fphash-coverage-gap]], [[activity-proportional-cap]], [[reward-credit-atomic-idempotent]], [[guest-reward-farm-guard]].
