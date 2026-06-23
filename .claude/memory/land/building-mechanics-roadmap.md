---
name: building-mechanics-roadmap
description: "Founder steer 2026-06-22: do NOT build HOME interiors / Phase-2 structure catalog yet. The external building mechanics (shops vs homes, what a structure DOES, how agents OFFER SERVICES) are undesigned and must be worked out FIRST. Interiors are downstream of that."
category: constraint
confidence: 0.9
date: 2026-06-22
---

# Building mechanics are UNDESIGNED - design before you build (founder steer)

**Founder, 2026-06-22 (right after the world-parity fix shipped):** "no building interiors yet,
need to work out like shops vs homes and building mechanics before touching that, we haven't
built out external building mechanics even yet, or how to let agents offer services."

**What this means for the land roadmap:**
- **DO NOT** start Phase 2 as written (`STRUCTURE_CATALOG` placement UI, HOME interiors,
  `claim-rest` passive-CT bonus). The schema + constants exist (`land-economy.ts`
  `STRUCTURE_CATALOG`, `STRUCTURE_UPGRADE_COSTS`, the `POST /parcels/:id/structure` +
  `/structures/:id/upgrade` routes already shipped in Phase 1), but the GAMEPLAY MEANING is not
  decided yet.
- **Open design questions to resolve FIRST (with the founder), before any interior/catalog build:**
  1. **Shops vs homes - what is the actual difference?** A home = the owner's spawn/base (the
     spawn-preference route already exists). A shop = ??? (sells what? to whom? for CT?).
  2. **External building mechanics** - what does placing a structure DO in-world beyond render a
     model? Walk-up interaction? A function? Right now placement is cosmetic + a leaderboard event.
  3. **How do agents OFFER SERVICES?** This is the big one - the land/shop economy is meant to let
     agents (and humans) run services for other players. The mechanism (list a service, price it
     in CT, another player/agent buys it, settle via the ledger, parity on both sides) is NOT
     designed. This overlaps the PAUSED peer-marketplace (marketplace-trade domain, 503-gated) +
     the cove money model - coordinate. Likely needs a founder product call + a CLAUDE.md
     carve-out (peer services were "confirmed outside the marketplace pause" per the land DESIGN,
     but the MECHANIC isn't built).
- **Sequence:** design (founder + a plan doc) -> external building mechanics + service offering
  -> THEN interiors. Interiors are the LAST thing, not the next thing.

So when picking up land work: the immediate buildable items are polish/sync (e.g. live land-sync),
NOT the structure/interior economy. That one is gated on a design pass.

Related: [[file-map-and-deployment-state]] · [[land-money-contract]] · [[world-economy-parity-gap]].
