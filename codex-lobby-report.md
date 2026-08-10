# Cove 3D table lobby rework report

Date: 2026-08-10  
Branch: `feat/cove-3d-reland`  
Scope: web UI and same-diff documentation only; no API or settlement changes.

## Built

- Replaced the inline `CashTablePicker` with `apps/web/src/components/cove/holdem/TableLobby.tsx` and a dedicated CSS module while preserving the existing null-live-table 3D canvas and `useStandKey(back)` behavior.
- Restored one complete lobby surface with Live Tables, Create Table, and Have a code? tabs:
  - Public-table polling on the existing 3-second cadence.
  - Authenticated public-table sit and route flow.
  - Public tier creation for LOW, MID, and HIGH tables.
  - Private custom buy-in/SB/BB creation with inline Zod validation.
  - Six-max seat stepper clamped to 2–6 and seeded-agent stepper bounded by the chosen seats.
  - Join-code normalization, friendly structured server error copy, and already-seated handling.
  - Private join code shown once with warning, copy control, and enter-table CTA.
- Added six-seat occupancy pips, tier-specific hues, live/waiting status chips only for recognized payload statuses, full-card focus/hover treatment, empty state, and internal panel scrolling.
- Guests can browse. Create and Join render the exact sign-in gate and cannot issue mutation calls.
- Joins and public selections resolving to tables wider than six seats show a one-line notice and route to the classic felt at `/cove/poker/cash/<tableId>`; six-max tables route to the 3D room.
- Deleted the orphaned `CashPokerLobby.tsx`. A repository-wide search found no imports or external consumers of its locally declared props type before deletion, and no `CashPokerLobby` references remain afterward.
- Added reusable production capture tooling at `scripts/capture-lobby.mjs`.
- Updated both duplicated Hold'em cash-lobby records in `GameFeatures.md` and added the founder walkthrough line to checklist §1.

## Design decisions

- Kept the lobby as a DOM layer over the unchanged room canvas: near-black violet panel, gold border/active state, and light text on every dark surface.
- Used compact hierarchy rather than gold row bars: eyebrow, title/subtitle, understated tabs, dark cards, tier chips, stakes, buy-in, pips, status, and chevron.
- Used `useIsMobile()` for the touch/mobile behavior class. The `<=480px` media rule changes layout only (cards/fields become one column); it does not gate interactive content.
- Kept all user-visible currency labels as `vCLAW`. No user-visible forbidden venue naming was introduced.
- React/Next review: the new client component is synchronous, hook dependencies are primitive/stable, static data is module-hoisted, subcomponents are top-level, fetch effects clean up timers, all tabs/actions meet the 44px target, form controls are labeled, notices use status/alert roles, and no new 3D/per-frame work was added.

## Screenshots

- `scripts/lobby-desktop.png` — 1440×900 Live Tables with the painted 3D room behind it (413,942 bytes).
- `scripts/lobby-mobile.png` — 390×844 single-column Live Tables (163,791 bytes).
- `scripts/lobby-create.png` — authenticated Create Table / house-tier state (247,452 bytes).
- `scripts/lobby-code.png` — mocked private-create success with one-time code warning and copy/enter actions (239,633 bytes).

The capture used the optimized production server and the real built DOM/3D page. Browser request interception supplied stable authenticated lobby/table responses and the private-create success response; no image was fabricated.

## Responsive browser verification

`bun run scripts/capture-lobby.mjs http://127.0.0.1:3117` exited 0. Every checked viewport reported:

- `pageDoesNotScroll: true`
- `panelInViewport: true`
- `tabTargets: true`
- `noCardClipping: true`
- `singleColumnOk: true`

Verified viewports:

- 390×844
- 744×1133 and 1133×744
- 820×1180 and 1180×820
- 1024×1366 and 1366×1024
- 1440×900

Production serve evidence: port 3117 had no listener before launch; `bun run start -- -p 3117` produced one server listener; `GET /cove/table` returned HTTP 200; the server was stopped after capture.

## Acceptance outputs

### TypeScript

Command: `cd apps/web && bunx tsc --noEmit`  
Result: exit 0, no diagnostics.

### Tests

Command: `cd apps/web && bun test`  
Result: exit 1 with the established two-test land baseline; no lobby test failed.

```text
2 tests failed:
(fail) land appearance picker options > shows only the matching shell type and marks level locks
  Expected length: 4
  Received length: 11
(fail) land parcel proximity > pins the derived ring bounds to the current parcel supply
  Expected: 10304
  Received: 10592

807 pass
2 fail
13313 expect() calls
Ran 809 tests across 64 files. [3.33s]
```

The requested acceptance text expected 800 pass / 2 fail; after the mandatory fast-forward from `74aa911a` to `35120596`, the current branch contains seven additional passing tests, so the actual current baseline is 807 pass / 2 fail.

### Production build

Command: `cd apps/web && bun run build`  
Result: exit 0.

```text
Next.js 16.2.3 (Turbopack)
✓ Compiled successfully in 8.1s
Finished TypeScript config validation in 14ms
✓ Generating static pages using 15 workers (38/38) in 710ms
Finalizing page optimization ...
```

## Unverifiable locally

- The screenshots use browser-mocked cash REST responses because no authenticated local cash-poker API/session fixture was supplied. The UI exercised the production bundle, real DOM, real 3D room, tab/form interactions, and private success rendering, but it did not create or join a persistent database table.
- A real account/API staging smoke is still required to prove ledger debit, open-table-cap behavior, and server-issued join-code lifecycle end to end. Those existing API/settlement paths were intentionally untouched.

## Parity

UI-only; human path: lobby UI over existing cash REST; agent path: unchanged REST (agents don't use the DOM lobby); settlement untouched.
