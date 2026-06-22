# Land Economy — Agent Memory Index

Project-scoped knowledge for the `land` subagent. One line per entry; detail lives in the file.
Precedence: live code > canonical docs (`ARCHITECTURE.md`/`GameFeatures.md`/`3dStructure.md` +
`.claude/plans/land-economy/`) > this memory (advisory). Verify before trusting.

## Known traps (Phase 0 pre-read - emit these as hard constraints BEFORE any code)
- **World/DB/UI drift** - the founding defect. The render must reflect DB status/ownership; a
  buy must update the world; the modal and the world are two VIEWS of one DB. [[world-economy-parity-gap]]
- **parcelCode is the join key, NOT the DB UUID.** `LAND_PARCELS[i].id === parcelCode`; the API
  returns the DB UUID as `id`/`parcelId` plus `parcelCode` separately. Join render-to-DB on
  parcelCode (resolve UUID->parcelCode from the parcels payload). The structures join shipped
  broken once exactly here. [[multiplayer-render-and-verification]]
- **Money path is consumed, not owned.** Settlement goes through the CT ledger + the authed
  `requireAuthOrAgentSession` buy route; never add a new write path or a guest buy. Burn-sink,
  atomic-under-lock, idempotency-keyed. [[land-money-contract]]
- **Seed is manual DATA per isolated DB** (not the migrate gate); empty table = a disconnect;
  EXPLICIT-URL env hazard (Bun auto-loads `.env.local`). [[seed-is-manual-data]]
- **Iris-Xe render budget** - merged BufferGeometry, no InstancedMesh+ShaderMaterial, no drei
  Text/Billboard, module-scope scratch only. The automation browser renders land at degraded
  quality tier 1 (only 2 of 5 tier-bodies) - verify visuals on real hardware, not MCP pixels.

## Consumes (NEVER edit these primitives - file the change to the owner per REGISTRY.md)
token-economy (`claw-token-ledger`) · auth-identity-session (`require-auth-or-agent`, fingerprint)
· 3da/world-presence (render substrate `lib/three/**` except `land-*`, world-dimensions SSOT)
· agent-protocol-partner (Hatcher whitelist / PROTOCOL_VERSION for the Phase-3 agent action surface)
· knowledge-orientation (Nori + the 3 operational-knowledge surfaces).

## Entries
- [world-economy-parity-gap](world-economy-parity-gap.md) — THE founding defect: Land Office modal is a full DB economy but the in-world render is a static diorama from the frozen `LAND_PARCELS` constant — no ownership branch, no click-to-buy, never updates on a buy. Menu and gameplay are two universes. OPEN.
- [file-map-and-deployment-state](file-map-and-deployment-state.md) — every land file (route/seed/render/modal/store/schema/constants) + what's on prod vs staging vs the dirty `feat/poker-mtt-tournament` working tree (which LACKS land routes/render).
- [land-money-contract](land-money-contract.md) — burn-sink priced buy (atomic, advisory-lock + FOR UPDATE), idempotency-keyed upgrade (Codex BLOCK), server-priced only, E5 parity on write+read+agent path, conservation/no-faucet.
- [seed-is-manual-data](seed-is-manual-data.md) — parcel seed is a one-off DATA script (not the migrate gate), run per-isolated-DB; empty table = a disconnect (modal empty, world shows 180 lots); EXPLICIT-URL env hazard (Bun auto-loads `.env.local` → once wrote prod).
- [multiplayer-render-and-verification](multiplayer-render-and-verification.md) — land is GLOBAL state (all server instances read one `land_parcels` table; geometry deterministic) so rendering never forks per server; cross-CLIENT sync is pull-on-fetch not push (a live land event is a follow-up). Includes the world-parity fix staging-verification outcome.
