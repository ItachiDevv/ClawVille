# Hold'em table-room visual round — Codex report

Date: 2026-07-18
Branch: `feat/cove-3d-holdem`

## Outcome

The dedicated `/cove/table` seated surface now reads as one premium card-room system. The visual-only 12-second decision timer, seated keyboard look-around, automatic decision recenter, dynamic seat-badge projection, blind-term teaching, and themed route-back chrome are implemented without changing the Hold'em controller, wire types, request paths, settlement, or ledger.

## Design system tokens

| Role | Settled token |
|---|---|
| Main translucent panel | `rgba(26, 18, 28, 0.88)` |
| Solid panel basis | `#1a121c` |
| Felt tray | `rgba(28, 64, 51, 0.88)` with darker inset leather/felt framing |
| Brass/gold | `#d4af37`; bright state `#e2c15a`; border `rgba(212,175,55,0.52)` |
| Warm cream text | `#f3ead8`; muted `#c9bca7` |
| Fold tint | `#9f4a4c` family |
| All-in/timer warning | `#d18b36` family |
| Geometry | One `10px` radius and one thin brass border treatment |
| Type | `var(--pt-data)` small-caps labels at `0.08–0.14em`; tabular numeric values |

Structural call: the shared styling lives in `SeatedHoldemHud.module.css`, imported by the HUD, `RaiseSlider`, and the table-room page. That keeps this round local to the Hold'em room instead of prematurely creating a global brand kit. Playing-card faces were not recolored; only the felt tray and empty community-card slots changed.

Advancing actions (Deal, Check/Call, Next Hand, raise confirmation) are gold-filled with dark text. Fold is muted red, All In is amber, and all other actions are dark plum with a brass outline. Every interactive target is at least 44px high. The blind legend is persistent: `D Dealer · SB Small blind · BB Big blind`.

## Timer and recenter decisions

- `HOLDEM_DECISION_SECONDS` is a named exported constant with value `12`.
- The timer appears only while the human action buttons are genuinely enabled: `phase === 'player-turn'`, no replay backlog, no in-flight request, and not autonomous mode.
- Reset identity is `(handId, publicActionLog.length, toCall)`.
- Color progression: gold normally, amber under 5 seconds, red under 3 seconds, gentle pulse while held at 0.
- Zero is display-only: no auto-fold, auto-check, call, fetch, mutation, or controller action occurs.
- ArrowLeft/ArrowRight continuously adjust target yaw at 92°/second, eased with `LOOK_EASE=9`, clamped to ±75°.
- `Home` is the instant center key. Each newly enabled decision requests an eased recenter so the dealer/action view is restored before the next choice.
- `E` remains the stand/route-back shortcut. The HUD surfaces `←/→ Look around · Home center · E stand`.

## Badge anchor reprojection

Structural call: `holdem-table-view.ts` is a render-only bridge containing six stable DOM badge registrations, a registry version, and a recenter epoch. It carries no hand, money, subject, or controller state.

`SeatedLookCamera` owns six immutable world anchors. Five opponent anchors are placed outside the torso/head line; seat 0 participates in the projection pass but its visible label stays inside the screen-fixed private-card tray because the viewer is that seat. On a camera/viewport/registry change, the camera builds one view-projection matrix and applies it with module-scope scratch objects (`Vector3` look target, `Vector3` badge projection, `Matrix4` view-projection). Opponent labels receive a 42px outward screen nudge. A projected anchor outside the safe view fades to zero instead of being pinned to an edge.

The R3F `useFrame` callback exits before camera/projection work when yaw, viewport, and registry are unchanged. No Three.js object is allocated in the loop. Timer React renders do not churn badge refs; all six ref callbacks are module-stable.

## Viewport sweep

All measurements were taken in the headed Chrome session on a live human decision with card tray, timer, and action bar visible. “Pass” means: HUD/tray/action/timer contained in the viewport, tray bottom does not overlap the action panel, document has no horizontal/vertical overflow, and every button is at least 44px in both dimensions.

| Viewport | Orientation | HUD / tray / timer | Overflow | Targets | Result |
|---|---|---|---|---|---|
| 390×844 | portrait | contained; tray clears actions | none | min 44px | PASS |
| 844×390 | landscape | contained; tray clears actions | none | min 44px | PASS |
| 744×1133 | portrait | contained; tray clears actions | none | min 44px | PASS |
| 1133×744 | landscape | contained; tray clears actions | none | min 44px | PASS |
| 820×1180 | portrait | contained; tray clears actions | none | min 44px | PASS |
| 1180×820 | landscape | contained; tray clears actions | none | min 44px | PASS |
| 1024×1366 | portrait | contained; tray clears actions | none | min 44px | PASS |
| 1366×1024 | landscape | contained; tray clears actions | none | min 44px | PASS |

At 390×844 the measured HUD was `374×279` at `(8,557)`, the tray was `366×110`, and the action panel was `374×163`; the narrowest action buttons remained 70×44. At 844×390 the HUD was `680×253`, with the tray ending at y=239 and actions beginning at y=244.

Physical-device limitation: the safe-area CSS uses `env(safe-area-inset-*)`, but DevTools/headed viewport emulation cannot prove a real iPad notch/home-indicator inset. A physical-iPad screenshot remains the only unverified viewport item.

## Verification evidence

- `bun run build`: PASS, 9/9 workspace builds; Next.js production bundle compiled and `/cove/table` prerendered.
- API TypeScript: PASS, 0 errors.
- Web TypeScript: expected baseline, exactly 12 errors (10 tracked legacy + 2 in untracked `apps/web/codex-hipcheck-roster.ts`); no error points into this diff.
- Web tests: expected baseline, 52 pass / 4 pre-existing `verifier.test.ts` failures; Hold'em bet-math tests all pass.
- Headed Chrome, cold `next start` on port 3001: page has content, no Next error overlay, and `agent-browser errors` is empty.
- Played one complete hand locally: Deal → Call → Check flop → Check turn → Check river → settled; Next Hand and Close surfaced correctly.
- Timer visibly counted down to red and held at `0s` while actions remained enabled; no automatic action occurred.
- Look-around: held ArrowLeft to near the clamp, observed other seated avatars and the tracked/faded badge layer while the card tray, timer, and actions remained fixed; Home restored center.
- Stand/back regression: pressing `E` navigated from `/cove/table` to `/cove`.
- Controller and shared wire diff: empty.

### Screenshots

| Evidence | Size | SHA-256 |
|---|---:|---|
| `restyle-idle.png` | 929×917 | `64762AA02DB404B003B0EE7DD1C93EE1C032901B1BBBB701CE85C890A334BB2E` |
| `restyle-live-timer.png` | 929×917 | `CF1C11DB4C5CED8F5569E629561E29F9179BCEF4887B76CC5B241BA4D83D904E` |
| `restyle-yawed.png` | 929×917 | `FA77935D34E055C5CB1D72E54C066AE964C81C48F5E0CA95AE3BC4E6FC42FE54` |

## PARITY

Display-only round. Human path gains the themed DOM HUD, blind legend, visual timer, and keyboard camera controls. The connected/hosted agent path is unaffected and continues through the existing subject-bound Hold'em API/action surface. Settlement remains bound to the same avatar and ledger path. No guest, human, or agent money semantics changed.

## Other limitation

The mandatory first `git pull --ff-only` could not fast-forward because this feature branch is 37 commits ahead of and 192 behind `origin/staging`. The worktree also contains prior user-owned evidence/report artifacts. No rebase, merge, reset, or cleanup was performed; this commit is intentionally scoped to the requested visual round.
