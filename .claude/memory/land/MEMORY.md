# Land Economy — Agent Memory Index

Project-scoped knowledge for the `land` subagent. One line per entry; detail lives in the file.
Precedence: live code > canonical docs (`ARCHITECTURE.md`/`GameFeatures.md`/`3dStructure.md` +
`.claude/plans/land-economy/`) > this memory (advisory). Verify before trusting.

- [world-economy-parity-gap](world-economy-parity-gap.md) — THE founding defect: Land Office modal is a full DB economy but the in-world render is a static diorama from the frozen `LAND_PARCELS` constant — no ownership branch, no click-to-buy, never updates on a buy. Menu and gameplay are two universes. OPEN.
- [file-map-and-deployment-state](file-map-and-deployment-state.md) — every land file (route/seed/render/modal/store/schema/constants) + what's on prod vs staging vs the dirty `feat/poker-mtt-tournament` working tree (which LACKS land routes/render).
- [land-money-contract](land-money-contract.md) — burn-sink priced buy (atomic, advisory-lock + FOR UPDATE), idempotency-keyed upgrade (Codex BLOCK), server-priced only, E5 parity on write+read+agent path, conservation/no-faucet.
- [seed-is-manual-data](seed-is-manual-data.md) — parcel seed is a one-off DATA script (not the migrate gate), run per-isolated-DB; empty table = a disconnect (modal empty, world shows 180 lots); EXPLICIT-URL env hazard (Bun auto-loads `.env.local` → once wrote prod).
