# Trading Floor mobile and iPad verification

**Status:** Browser verification is pending. The orchestrator owns this sweep after the local build.

**Date:** 2026-09-16

## Required setup

1. Use the production bundle on localhost.
2. Do not use the development server.
3. Force each tested state before each check.
4. Use touch emulation at device scale factor 2.
5. Confirm both joystick zones with `elementFromPoint` where specified.
6. Record screenshots and console output for each viewport.

## Viewport sweep

| Check | Viewport | Required result |
|---|---:|---|
| V1 | 390 x 844 portrait | Floor cards stack without page overflow. Tabs scroll. Every target is at least 44 pixels. The close control works. |
| V2 | 844 x 390 landscape | Same checks as V1. Both joystick zones remain uncovered when the modal closes. |
| V3 | 744 x 1133 portrait | Same checks as V1. The tape is absent from the DOM. |
| V4 | 1133 x 744 landscape | Same checks as V1. The tape is absent from the DOM. |
| V5 | 820 x 1180 portrait | The tape is absent. Both joystick centers return the joystick element. |
| V6 | 1180 x 820 landscape | The tape is absent. Both joystick centers return the joystick element. |
| V7 | 1024 x 1366 portrait | The tape is absent. Both joystick centers return the joystick element. |
| V8 | 1366 x 1024 landscape | The tape is absent. Both joystick centers return the joystick element. |
| V9 | 1440 x 900 | The tape stays inside the sidebar. Every tape corner and row returns the tape from `elementFromPoint`. |
| V10 | 1280 x 720 | The tape remains visible. The sidebar scroll region remains usable. |
| V11 | 1920 x 1080 | Repeat the V9 containment and hit tests. |
| V12 | 1440 x 900 | Collapse the sidebar. The tape unmounts and frame normalisation stops. |
| V13 | 390 x 844 | The leaderboard uses two rows. The agent name is legible. The page has no horizontal scroll. |
| V14 | 1440 x 900 | Trade data shows the Trader column, podium metric, and three legend rows. Missing data hides all four surfaces. |
| V15 | 390 x 844 | A guest sees the account upsell. Binding actions make no request. |
| V16 | 1440 x 900 | Show all six row states. Only the unscored row uses reduced opacity. |
| V17 | 1440 x 900 | Resolve a pending row. It keeps its position, gains a signature link, and does not increase row count. |
| V18 | 1440 x 900 | Stop the API. The header shows RECONNECTING, then STOPPED, and never reports LIVE. |
| V19 | 1440 x 900 | Advance a fake clock past 15 minutes. The row changes to UNCONFIRMED and stays outside totals. |
| V20 | 390 x 844 | Open every live `RpgModal` header. Confirm the 44 x 44 close control remains visible and reachable. |
| V21 | 1440 x 900 | Measure contrast for normal, muted, warning, disabled, and link text on each new dark card. |
| V22 | 1440 x 900 | Expand the thought log with the sidebar open. The tape unmounts and each thought row remains clickable. |

## V20 modal list

- Activity lobby
- Bounty board
- Building portal
- Cosmetics
- Exchange
- Guest account upsell
- Leaderboard
- Land Office
- Quest board
- Sidebar modal surfaces
- World map

Some files contain more than one modal instance. Test each real header with its longest live title and badges.

## Browser-only claims

- Actual horizontal overflow and scroll reachability
- Actual agent-name width and clipping
- Actual page-level overflow
- Pointer hit testing with `elementFromPoint`
- Joystick visibility and overlap
- Computed foreground and background contrast
- Header wrapping with real fonts and badges
- Close-control reachability in every modal
- Visual distinction between all six row states
- In-place row motion during live frame arrival
- Live reconnect timing against a stopped API

Devtools does not emulate `env(safe-area-inset-*)`. This feature adds no bottom-anchored touch element, so no new safe-area claim exists.
