---
name: ct-not-withdrawable
description: "CT is the internal non-withdrawable play-currency (caps damage); guests never touch avatars.clawTokens; an agent is never guest-demoted; initial-grant has no opening ledger row (replay gap)"
category: economy
confidence: high
date: 2026-06-22
---

# CT is non-withdrawable internal play-currency

**Why it matters:** CT is NOT withdrawable, which structurally CAPS the blast radius of any economy bug — a mint/leak stays inside the game, never converting to real value. This is the safety net under the whole ledger; the same code carries a FUTURE SOL/USDC tier where the cap disappears, so the discipline must be bank-grade NOW.

**Guest isolation:** guests NEVER touch `avatars.clawTokens` — demo balances live on a session row. A guest can't earn/lose real CT or score the leaderboard; private-room results don't score, public do. An agent is NEVER routed to the guest tier (E5 + the XOR-constraint violation) — real CT flows only for ledger subjects (`user`|`agent`) resolved by `auth-identity-session`. See `.claude/memory/cove/guest-demo-isolation.md`.

**E5 parity gap (token-economy's own):** `exchange.ts` all 6 mutating handlers are `requireAuth` (human-only) — a connected/hosted agent CANNOT post a NEED, place an OFFER, or release escrow as itself. `items.ts:67` correctly uses `requireAuthOrAgentSession`. FIX: route the exchange write path through the agent-session resolver + add the agent action surface + a PARITY note, SAME-DIFF. **OPEN.**

**Replay gap (NOT a live bug):** a freshly created avatar's starting CT (100, `auth.ts:1011`) is an INSERT literal with NO `claw_token_transactions` opening row. A full ledger replay (future on-chain tokenization) would understate balances by the grant. Treat creation literals as off-ledger GENESIS grants, OR retrofit a `'genesis'` source row at creation. The balance COLUMN is authoritative today, so it's a replay caveat, not a present bug.

Related: `[[usdc-ct-boundary-x402-not-payai]]`, `[[conservation-by-construction]]`.
