# Land options popup — frozen brief (2026-07-28, Fable)

Founder ask: "make sure options pop up for land." Today the ONLY land
interaction is clicking a FOR-SALE sign (available parcels only —
`land-parcels.tsx:817` → `openLandOffice(parcelCode)`); walking onto a parcel
shows nothing, and owned parcels have zero in-world surface. This slice adds a
building-style proximity pill for parcels.

Branch: `feat/land-options-pill` off current `origin/staging`.
Domain: land-economy (READ-ONLY UI — the pill only ROUTES into existing
surfaces; NO new economy writes, NO API/schema/protocol change).

## Scope

1. **Proximity state.** New axis `nearParcelCode: string | null` on the game
   store (beside `nearLocation`). Set by the SAME mechanism/tick that sets
   `nearLocation` today — find where building proximity is computed (player
   position vs location coords) and extend it with parcel-rect hit-testing
   from the shared parcel geometry (`packages/shared/src/constants/
   land-parcels.ts` — verify the actual exported shape first; positions/rects
   must come from there, never re-derived). Throttle identical to the
   building check; ZERO per-frame allocations (Iris Xe rule); standing inside
   a parcel's rect = near. Buildings take PRECEDENCE: when `nearLocation` is
   set, `nearParcelCode` must be null (or the pill must not render — pick the
   cheaper, document which).
2. **`LandOptionsPill`** (new component mounted beside `LocationHUD` in
   `app/(world)/game/page.tsx`, same bottom-pill styling/slot as the existing
   proximity pill so mobile collision behavior is inherited). Render by
   parcel state (client `useLandStore` — `ParcelStatus`
   'available'|'owned'|'reserved'|'retired', `ownerAvatarId`):
   - available → "🏝️ Parcel <code> · For Sale" + button "View options" →
     `openLandOffice(parcelCode)`
   - owned by ME (ownerAvatarId === my avatar id — resolve the same way the
     land office does) → "🏝️ Your parcel <code>" + button "Manage" →
     `openLandOffice(parcelCode)`
   - owned by someone else → "🏝️ Claimed parcel <code>" (info-only, no
     button; do NOT fetch/display other owners' identity in the pill)
   - reserved/retired → render nothing.
   Copy rules: no em dashes in user copy; light text on dark panel.
3. **Guests** see the pill too (available parcels) — the land office already
   guest-gates writes; do not add a second gate in the pill.
4. **Mobile/iPad**: same pill slot as LocationHUD ⇒ inherits its placement;
   any visibility gating MUST use `useIsMobile()`, never bare media queries.

## Explicit NON-scope
No purchase/rent flow changes, no LandOfficeModal changes, no server/API
edits, no `[ACTION:]`/PROTOCOL_VERSION change (agents keep their existing
land REST/action path — that IS the parity note), no 3D scene changes (the
pill is DOM), no sign-click behavior change.

## Implementer verification-first rule
BEFORE writing code, verify every referenced symbol/path above against the
real files (game store axes, land store shape, shared parcel geometry
export, where nearLocation is computed, LocationHUD mount pattern). If a
brief fact is wrong, STOP and write the discrepancy into the report + notes,
then implement against the REAL code and record the deviation — never
improvise silently.

## Gates (Codex runs 1-3; Fable re-runs + owns 4-5)
1. `bun run build` exit 0; `apps/web` `bunx tsc --noEmit` exit 0.
2. `bun test` apps/web (any touched suites).
3. A tiny pure unit test for the parcel hit-test helper (point-in-rect +
   precedence logic).
4. (Fable) viewport sweep 390×844 / 744×1133 / 820×1180 / 1024×1366,
   portrait+landscape: pill visible, no joystick overlap, ≥44px target.
5. (Fable) live drive: walk onto an available parcel → pill → View options
   opens the office AT that parcel; building approach still wins; owned
   parcel shows Manage (staging landtest account).

## Docs same-diff
`GameFeatures.md` (land section: the pill + precedence), deploy-status on
push (orchestrator), NEW `docs/land-options-popup-notes.md` (inventory +
verification record + honest gaps).

## Working rules
No browser MCP tools; serial steps; wip commits; markers
`land-pill.done` / `land-pill.blocked` + report `land-pill-report.md` in
C:/Users/itachi/AppData/Local/Temp/claude/C--Users-itachi-documents-crypto-clawville/aa839a38-c6cb-48bb-9086-3a7b55129d0a/scratchpad/reports/.
No pushes; no `bun run dev`.
