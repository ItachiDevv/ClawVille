---
name: multiplayer-render-and-verification
description: "Land is GLOBAL state (one land_parcels table; all server instances read it; LAND_PARCELS geometry is deterministic) so parcel rendering never forks per server. Cross-CLIENT propagation is pull-on-fetch, not real-time push. Plus the staging verification outcome of the world-parity fix."
category: pattern
confidence: 0.8
date: 2026-06-22
---

# Land + multiplayer: global state, pull-on-fetch sync

**Founder asked 2026-06-22:** "with multiple servers I'm not sure how parcel rendering works."

**Answer (verified against the architecture):** land is GLOBAL world/economy state, NOT
per-server-instance.
- ONE `land_parcels` table in the single Supabase DB (prod DB / staging DB are isolated
  from each other, but within an env there is ONE land table). Every server instance / room
  reads that same table via `GET /api/land/parcels?status=...`.
- `LAND_PARCELS` (the geometry constant) is deterministic + pure (no RNG), so all clients
  agree on where parcel N is. Ownership/status is layered on top from the DB.
- ClawVille's multiplayer "instances" shard CO-PRESENCE only (which avatars you see, loose
  cap 12 / hard 20 per instance, NPC substitution on join — see `project_shared_world_instancing`).
  They do NOT fork world state. A parcel owned by avatar X is owned in EVERY instance's view.
- ⇒ Parcel rendering is consistent across all servers; there is no per-instance divergence.

**The one caveat — cross-CLIENT propagation is PULL, not PUSH (OPEN enhancement):**
- The buyer's OWN client updates instantly: the Land Office modal invalidates the
  `['landParcels']` query on buy/claim, so the for-sale sign vanishes immediately for them.
- ANOTHER player already in-world picks up the change on their next fetch — world remount,
  window refocus, or the 60s `useQuery` staleTime — NOT the instant the buy lands. There is
  no WebSocket/SSE push for land state today (unlike player positions on the world-stream).
- True real-time cross-player land sync (A buys → B's sign vanishes live) would add a land
  event on the multiplayer channel + a client handler that invalidates `['landParcels']`.
  Scoped as a FOLLOW-UP, not part of the world-parity fix. The land agent owns it.

# World-parity fix — staging verification outcome (feat/land-world-parity, dd189b91)

Shipped to staging 2026-06-22 (PR #162). Verified NON-VISUALLY (the automation browser
can't capture WebGPU pixels + renders at degraded quality tier 1, where only founder+starter
tier-bodies mount — IDENTICAL on prod, so a browser artifact, NOT a regression):
- Hydrator fires BOTH `/api/land/parcels?status=available` and `?status=owned` (network-confirmed).
- API truth: 180 parcels, 5 tiers (founder 8 / a 8 / b 16 / c 40 / starter 108), 178 available,
  owned = parcel-starter-00/01.
- Reactive merged sign meshes present (3 plank + 3 post); 35 click-hitboxes added (prod had 0).
- No money path touched; E5 parity intact (click bridge reuses the authed buy).
- **Founder confirmed on their real machine 2026-06-22: "yes I do see them"** — so the full
  tier render works on real hardware; the 2-tier automation-browser count was the degraded-GPU
  artifact, as suspected. Interactive loop (buy → sign vanishes, owned building renders,
  click → modal focus) still pending an explicit founder run before prod promote (Rule E4).

Related: [[world-economy-parity-gap]] · [[file-map-and-deployment-state]] · [[land-money-contract]].
