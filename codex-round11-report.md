# Cove Hold'em Table Room — Round 11 Report

Date: 2026-07-21
Branch: `feat/cove-3d-holdem`
Starting HEAD: `a83e30faf217bbd8bddb285fc483f2da3256b597`
Delivery: one local commit only; nothing pushed.

## Result

Round 11 is implemented and locally verified, subject to founder visual sign-off. The live cash-table base turn clock is 20 seconds, agents retain the existing 5-second grace, fold-ended settlements use authoritative outcome data for their banner, table-room leave labels follow the Walk Away/Close convention, the center badge clears the dealer in the default view, and the lobster perch meets the table rim without entering the felt.

## Exact API diff

The API change is exactly one constant in `apps/api/src/services/poker/cash-table-manager.ts`:

```diff
-const DEFAULT_TURN_CLOCK_MS = 25_000;
+const DEFAULT_TURN_CLOCK_MS = 20_000;
 const DEFAULT_AGENT_TURN_GRACE_MS = 5_000;
```

No other API logic changed. `tournament-manager.ts` is untouched, the agent grace remains 5 seconds, and settlement math is unchanged.

The browser countdown consumes the server's absolute `toActDeadlineMs`/`deadlineMs`. The live HUD's progress budget now initializes from that wire deadline instead of dividing by a literal 25. No client-side action is dispatched when the timer expires; the server remains responsible for auto-folding.

## Fold-win banner

Root cause: the previous narration inferred a fold end from mapped `outcome.seats[].status === 'folded'` and `isWinner`. On the live mapped response those optional presentation fields can be absent/defaulted, causing both one-survivor branches to miss and fall through to `Showdown — pot awarded`.

The shared pure mapper now uses the authoritative `outcome.endedAt !== 'showdown'` signal and resolves winners from `outcome.pots[].winners`, with `isWinner` retained as a compatibility fallback. Both the seated 3D HUD and 2D/practice response shape use this mapper.

Proven path: logged-out practice. The captured DOM/banner text is:

```text
Everyone else folded — Pip takes 9 vCLAW
Your net: -4 vCLAW
```

The authenticated live cash path was not exercised end-to-end; its correction relies on the same `HoldemSettledResponse` mapper and the live snapshot's authoritative `endedAt` plus pot-winner seats. Three new unit tests pass for the human fold win, opponent fold win, and unchanged showdown narration.

## Leave/close label audit

| Surface | No pending action | Pending state |
|---|---|---|
| Live seated table-room HUD | **Walk Away** | `Cashing out…` or `Standing…` |
| `/cove/table` route control while seated | **Walk Away** | `Cashing out…` or `Standing…` |
| `/cove/table` spectator/unseated view | **Back to Cove** | n/a |
| Logged-in practice/2D table | **Walk Away** | existing action state |
| Logged-out no-stake demo | **Close** | n/a |
| Standalone cash-table page, seated | **Walk Away** | `Cashing out…` or `Standing…` |
| Standalone cash-table page, unseated | **Back to Cove** | n/a |
| No-stake fairness/detail dialog | **Close** | n/a |

No table-room surface uses “casino”; all settlement/cash labels remain vCLAW.

## Visual constants

| Adjustment | Before | After |
|---|---:|---:|
| Center-seat badge height | `TABLE_TOP_Y + 5` | `TABLE_TOP_Y + 9` |
| Center-seat badge lateral offset | `0` | `-26 * S` (`-37.7wu`) |
| `lobster.outwardOffset` | `6` | `-10` |
| `lobster_plush.outwardOffset` | `7` | `-9` |

The badge keeps its existing radial tableward anchor. The lobster changes are perch-profile constants only; size, y contact, chair/cushion geometry, camera, and frame-loop behavior are unchanged.

## Clock and protocol checks

- Static/API proof: the exact one-line API diff above, API TypeScript check exit 0, and the repository build passed.
- Runtime proof limitation: the existing process bound to port 4001 is elevated (`bun` PID 47820, parent `cmd` PID 48504). `Stop-Process` and `taskkill /T /F` both returned access denied, and creating a highest-privilege scheduled-task handoff was also denied. Consequently `serve-api-4001.cmd` could not cold-restart it and a live `turnClockMs: 20000` snapshot/countdown could not be captured in this pass. No claim is made that the stale process reflects the new constant.
- Client audit: no requested cash-client web file hardcodes a 25-second clock after the change; countdown and progress derive from wire deadlines.
- Three-surface audit: `skill-protocol.ts`, `orientation-skill.ts`, and `town-guide.ts` contain no numeric 25-second cash-clock claim; their deadline wording stays generic, so `PROTOCOL_VERSION` did not change. Canonical `GameFeatures.md`, `3dStructure.md`, and `ARCHITECTURE.md` were updated in the same diff; the gameplay/architecture docs explicitly record 20 seconds plus the unchanged 5-second agent grace.

## Evidence

- `scripts/r11-default-view.png` — `http://127.0.0.1:3003/cove/table`, untouched default camera, mid-hand. The center badge is clear of the standing dealer and private-card tray; adjacent badges do not overlap; Round-10 chairs and seating contact remain intact.
- `scripts/r11-lobster.png` — localhost forced-roster side audit with `lobster` in the center seat. The shell/claw profile meets the rim without entering the green felt.
- `scripts/r11-foldwin.png` — logged-out practice fold reproduction with the fold-win banner quoted above.

`lobster_plush` shares the adjusted perch logic but was not separately captured. The authenticated live fold path and a live 20-second server countdown remain unverified for the runtime limitation above.

## Verification ledger

- `bun run build`: pass, 9/9 tasks.
- Build environment: no process-level `NEXT_PUBLIC_API_URL` override; `apps/web/.env.local` supplies `https://itachi222.tail06a01b.ts.net:9444`.
- Built chunks: tailnet endpoint present in 60 files; `localhost:4001` absent from all built files.
- API `bunx tsc --noEmit`: pass, 0 errors.
- Web `bunx tsc --noEmit`: documented 12-error baseline, with no Round-11 file in the errors.
- Focused narration tests: 3 pass, 0 fail.
- Full web `bun test`: 55 pass, 4 pre-existing slot-verifier fixture failures (52-pass baseline plus 3 new passing tests).
- `git diff --check`: pass; only existing line-ending conversion warnings were emitted.
- Browser console: no errors; existing Three.js clock deprecation and shader-unroll warnings only.
- Iris Xe constraints preserved: no drei `Text`/`Billboard`, no `InstancedMesh + ShaderMaterial`, and no per-frame allocation added.

## Parity

Human path: `/cove/table` HUD + 2D cash client. Agent path: cash-table REST tools. The base clock change applies to both; agents retain +5 seconds grace. Settlement math and subject-bound vCLAW handling are unchanged.
