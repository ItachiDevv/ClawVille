# bountyFix2 session audit

Last Audited: 2026-09-22. Baseline: `10575a98` (`origin/staging`). Machine: itachi222.

## Scope and evidence

The source is Claude session `9a694cbe-d6d8-4642-a1ff-18cf75b621a1`, named `bountyFix2`.
Its log is `C:\Users\itachi\.claude\projects\C--Users-itachi-Documents-Crypto-ClawVille\9a694cbe-d6d8-4642-a1ff-18cf75b621a1.jsonl` on itachi222.
Line references below refer to that JSONL file. The audit parsed every JSON record.
The event timestamp range is **2026-09-17 20:05:44.731Z through 2026-09-20 21:26:12.285Z**.
There are 2,741 assistant records and 1,439 user records. Most user records contain tool results, not human requests.
There are no Agent/Task calls and no session subagent directory. The session used shell-launched Codex reviews instead.
Review transcripts appear in tool results. The audit includes their rejections and verification limits.

This report distinguishes historical session evidence from checks against the current source.
It does not claim a current production database, deployed commit, or browser result without a new check.
The registry, canonical document headers, target model, and relevant domain trap indexes informed the review.
Ownership crosses leaderboard-progression, world-presence, 3da, and knowledge-orientation.

## Human requests and approvals

| Log line | UTC date/time | Request or complaint |
|---|---|---|
| 17 | Sep 17 20:05:56 | Pasted gates Phase 0c handoff: constraint inventory, branch protection, dynamic test isolation, coupling runner. This differs from the session name. |
| 56 | Sep 17 20:08:49 | Remove SAP and OOBE. Do not restore removed rails. Challenges the alleged production depositor drain. |
| 145 | Sep 18 08:55:59 | Disable residuals, inspect remaining recovered funds, then address bounty confusion in production. |
| 619 | Sep 18 09:32:13 | Nori wrongly says Pearl holds bounties. Bounties must remain at the Bounty Board. |
| 946, 948 | Sep 18 09:42:42 | Cove build is seriously broken; image attached. Wait until DoorDash work ends. |
| 1134 | Sep 18 09:57:42 | After Reef Race exit, a delayed shadow avatar follows the real avatar. |
| 1163 | Sep 18 10:09:51 | DoorDash work ended. Coordinate with dd and investigate. |
| 3495 | Sep 18 11:57:42 | Continue autonomously while the user sleeps. Search history for previously repaired behavior. Coordinate with dd. |
| 7249 | Sep 18, tool answer | Explicitly approves migration 0067 on production. Asks whether SAP environment settings contain recoverable assets. |
| 7297 | Sep 18, tool answer | Explicitly chooses to retain SAP environment settings. |
| 9139, 9143 | Sep 19 03:00–03:01 | Resume after both sessions restart and coordinate their state. |
| 9548 | Sep 19 03:44:30 | Both sessions restarted again. Compare whether every issue is resolved. |

Additional screenshot complaints survive in the session's R1–R5 inventory at lines 1131 and 1160: Town Tour/minimap overlap, Cove exit inside the building, and empty land lots.
The dd audit supplies their original user-message evidence. They are not invented new complaints.

## Complaint-to-code matrix

| Item | Historical diagnosis and claimed repair | Current independent check | Status and limits |
|---|---|---|---|
| SAP drain allegation | L52 repeats an old memory claim. L138 retracts it after source checks: deleted SAP rail cannot create the alleged vault. | No SAP escrow service or schema remains. Production-source search finds only compatibility fields, historical enum values, comments, and the explicit migration. | The initial drain claim was false. Do not revive SAP work from stale memory. |
| SAP residual removal | L615, L943: migration removes six SAP tables, two gas tables, seven bounty columns, enum, and CHECK constraints. Production promotion follows direct approval at L7249. | `0067_sap_table_drop.sql` contains those operations. `partner-covenant.ts` preserves null/empty wire fields. Active covenant verification fields remain. | Source agrees. Database deletion is historical evidence, not independently repeated here. |
| SAP settings and recovered funds | L943 asks permission to remove settings; L7297 explicitly says keep them. L7970 says settings remain and records the recovery wallet finding. | No environment mutation in this audit. | Retention is intentional. Current wallet balances require a new chain read. |
| Bounty Board location | L862: none of three agent knowledge surfaces stated its location; Nori invented Pearl as holder. Protocol 61→62 adds board location and REST endpoint discovery. | Current canonical records preserve the board. Root/dd audit checks all three active knowledge surfaces. | Physical relocation was not the cause. Hosted action selection needs a separate reachability check; a REST manual alone does not prove hosted executor parity. |
| R1 dark Cove/fallback | L7227: first-visit loading stalls and a fixed 40 FPS threshold falsely select fallback, especially with the 30 FPS phone cap. | `cove-fps-sampler.ts` warms each undecided visit, trims 5%, uses wall-clock input, and scales threshold with cap. 13 current sampler tests pass. | Source and focused tests support repair. No fresh Iris Xe or device result in this report. |
| R1 signs and click routing | L5380/L5492/L5517: raised Baccarat sign; independent capsule raycast prevents wrong table selection. | `cove-click-routing.ts` matches visible capsule. Seven current routing tests pass. | Focused coverage passes. Browser confirmation belongs to root's independent pass. |
| Frame-cap time error | Cove investigation found carried remainder counted twice. | `stage-frame-cap.ts` uses `sinceAdmitMs` for scene delta and retains separate admission accumulator. Seven current tests pass. | No current defect found. |
| R2 Town Tour/minimap overlap | L1131 hypothesis about shared HUD shifts remained unproven. Final diagnosis: fixed tracker top assumed a shorter minimap. | `quest-tracker.tsx` subscribes to registered minimap geometry; `minimap.tsx` measures joystick geometry and uses a stand-in before lazy controls mount. Five registry tests pass. | Original code repair remains. No proof of a reverted commit. |
| R3 Cove exit | L1246 shows old exit west of wall and within entrance radius. Initial proposed door target was later superseded by exit outside the full tunnel band. | `character-positions.ts:205` derives exit X from tunnel prompt maximum +30. Cove page applies it to player and NPC body. Five exit tests and two NPC tests pass. | Source supports final repair. History must distinguish old incomplete geometry from a revert. |
| Home spawn after Cove refresh | L5862: first /game mount mistook a route exit for a town spawn. | `spawn-on-load.tsx:101` checks `isAtTownSpawn` before home placement. Three tests pass. | Source supports repair. |
| R4 empty lots | L7227: outer c ring arrived after initial model-home implementation and lacked entries. dd owned final repair. | Current audit delegated to dd/history owners. | Existing original-ring repair did not cover later ring. |
| R5 shadow avatar | L1160 initially blames unmounted heartbeat; L1364 retracts that premise. Final cause: activity pause cleared local identity while session survived. dd owned repair. | Current audit delegated to dd/history owners. | This is a concrete regression class: surrounding lifecycle invalidated the earlier self-filter. |
| Phone controls | L7227 claims no overlaps on any phone size. Later report qualifies emulation-only checks. | Existing 13 short-touch tests pass, but their CSS evaluator substitutes zero for every safe-area inset. New arithmetic reproduces overlap with nonzero bottom inset. | **Current defect: incomplete repair. See findings below.** |
| Phone World Map | L7227 leaves phone access as a decision. L7243 relays approval to adapt existing map. L7970 claims production verification. | `minimap.tsx:230` renders touch Map button below 768px; button opens the existing map store action. | Source retains access. Device/Safari verification remains separate. |
| Slot-screen black triangles | dd reports it at L7992. L9014 identifies 150 cover faces, preserving 138 lower door faces. | Patch script and model assets remain; runtime `?v=3`, preview `?v=7`. | Source repair remains. Root owns fresh browser and asset evidence. |

## Confirmed baseline findings

B-01 and B-02 have source corrections in this cleanup diff. Browser verification remains with the coordinator.

### B-01: bottom safe area still causes touch-control overlap

At baseline, `hud-anchors.ts:111` caps Jump with `100dvh - 214px`.
The formula assumes an 80px joystick lift.
The actual lift at `hud-anchors.ts:90` is `max(bottomInset + 60px, 80px)`.
With a 34px inset, the joystick lift becomes 94px.
At 740×360, Jump top becomes `360 - 94 - 146 - 64 = 56`.
Nori ends around y62, so the rectangles overlap by 6px when their horizontal ranges intersect.
At a 44px bottom inset, Jump top becomes 46, increasing overlap to 16px.
At 844×390 with a 44px inset, Jump top becomes 54.

Correcting only the Jump top creates another collision on the shortest viewports.
At 740×360 with a 44px inset, the joystick starts at y116.
Only 46px remain between y70 and that joystick.
A 64px Jump button cannot fit vertically there; a complete correction must preserve at least a 44px tap target.

`hud-short-touch.test.ts:21` explicitly replaces every safe-area value with zero.
Its 13 passing tests cannot verify the missing condition.
The previous session disclosed that browser emulation has no safe-area values, but its blanket success claim exceeded that evidence.

### B-02: short-screen Autonomous panel also ignores bottom inset

`autonomy-hud.tsx:147` sets `maxHeight: calc(100dvh - 298px)` from top70.
Its bottom therefore reaches `vh - 228`.
The joystick top is `vh - max(inset + 60,80) - 140`.
At inset34, the panel overlaps the joystick by 6px when tall enough to reach its cap.
At inset44, overlap becomes 16px.
The corresponding test also fixes the bottom inset at zero.

## Historical mistakes and corrections

### B-03: Nori shortcut freezes a first-time Explore visitor

The coordinator reproduced this on production during the current audit.
`/game` mounted NoriButton unconditionally but placed ChatPanel inside `hasAvatar`.
`openGuideChat` froze movement and hid the shortcut and joysticks before any panel could mount.
This repeats the failure class already described in ChatPanel's older `agentConnected`-gate comment.
The cleanup mounts ChatPanel beside the shortcut.
Because the guide API requires a session, the first definitive401 uses the existing guest bootstrap and retries once.
Network failures and5xx responses never trigger automatic replay or an identity change.
The panel shows failures, keeps a44px close target, and advances local quest progress only after success.
DOM and hook tests cover the no-avatar mount, touch close, guest retry, terminal retry, and failure paths.

The coordinator also verified production table removal and closed wager rows through read-only queries.
Those results belong to the combined audit evidence; this report does not repeat their database output.

1. **False production-drain claim.** L52 relied on stale memory. L138 retracts it after checking source.
2. **Premature knowledge assertion.** L615 says all knowledge surfaces were correct. L619 immediately supplies the missing location complaint.
3. **Unproven common-cause theory.** L1108/L1131 suggest one shared cause for all regressions. Later evidence shows several independent causes.
4. **Wrong heartbeat premise.** L1160 says the heartbeat unmounts during races. L1364 corrects the premise after inspecting the world route group.
5. **Destructive migration sequence caused an outage.** L7970 admits production bounty list/create errors from 23:24:36Z to 23:28:33Z on Sep18. Migration preceded the new API container, while the old API still selected removed columns. `deploy-status.md:68` records the same event. The session reports no debit and rolled-back creation; this audit does not repeat those database checks.
6. **Migration comments retain a false safety claim.** `0067_sap_table_drop.sql:48` says no runtime reader existed since Aug20. The outage proves that statement omitted ORM-selected schema columns. The migration header also says the sole readers were Covenant routes. This is incorrect historical documentation.
7. **Premature asset fetch poisoned the new cache key.** L9413 admits downloading the new production model URLs before the container flip. Cloudflare cached old bytes under the new versions. PR293 changes the keys to `?v=3` and `?v=7`; L9357–9379 waits for the flip, checks bytes, and checks the room.
8. **Stored knowledge did not prove chat behavior.** L9618 reports no broken item. L9652 retracts the knowledge result: live Nori chat answered three of seven questions incorrectly. dd's v64 follow-up reports seven of seven at L9713. Root must avoid equating current knowledge rows with a live conversation.
9. **Documentation status briefly regressed.** L9604 says duplicate-copy notes remain. L9623 corrects that message; L9629 verifies both branches.
10. **Device evidence remained limited.** L7227 asks for real-device checks after headless tests. No later log supplies founder visual approval for the full list.

## Review and test failures in the original session

| Log anchor | Evidence and disposition |
|---|---|
| 1870 | Local Turbopack build failed. Later builds passed; deployment log identifies a Google Fonts network fetch. |
| 2063 | First Codex source-read review failed with `CryptUnprotectData failed: 2148073483`; review explicitly covered only supplied diff. It is not independent source verification. |
| 3343 | HUD reviewer finds missing registry lifecycle tests. Later ownership-aware registration and five tests address it. |
| 4868 | Cove reviewer requests changes after focused tests pass. Passing helper tests did not establish complete click behavior. |
| 5252–5348, 5396 | Isolated world-stage run reports three failures and one error; another run reports ten failures. Reviewer did not independently establish baseline equivalence. Later full-web runs pass. |
| 5396 | Reviewer notes no integration test proves retained-visit reset occurs before first resumed callback. No demonstrated failure. |
| 5517 | Final click-routing review replays 1,260 geometry points without failure. Glow-only pixels remain outside the filled-capsule contract. |
| 5688 | NPC placement reviewer passes seven tests but notes no test protects the exit callback's invocation. Browser verification was not repeated by that reviewer. |
| 6420 | One short-touch test fails during iteration; later corrected. |
| 6512 | Reviewer identifies untested collapsed-map assumption and omitted Autonomous mode. Later checks include those states. |
| 6742, 6753 | Full web run reports four failures, then one failure. Session attributes timeouts to orphan Chrome processes; later full run passes. |
| 6829 | Final HUD reviewer passes 33 tests. Browser and full-suite checks are not repeated; enrolled-wallet state remains synthetic. |
| 7807 | Phone-map focused suite passes 12 tests. Reviewer does not repeat browser measurements. |
| 8827 | First slot-model review cannot read source or assets due to the same DPAPI failure. Later review rebuilds the assets byte-for-byte. |

## Cross-session coordination

The session exchanged 40 `SendMessage` calls with dd and later clawAgents.
Relevant inbound anchors:

- L1251/L1328: dd coordinates staging windows, DoorDash hotfixes, and Nori collider ownership.
- L7243: dd relays SAP-drop approval, phone-map preference, and agent-label decision. This session then obtains direct migration approval.
- L7992: dd reports the slot-screen triangles from a live Cove check.
- L9020/L9417: dd reports protocol-v63 gates and releases deployment ownership.
- L9604/L9623: dd reports current fixes, then retracts the duplicate-doc open item.
- L9635/L9657/L9713: dd reports live Nori failures, v64 tests, promotion, and seven-answer re-test.
- L9673/L9687/L9735/L9747: clawAgents schedules later staging releases, protocol versions65 and66. These are separate workstreams.

Key commit references recorded in the session and deploy ledger:

- SAP drop: staging `b428cb5f`, production cherry-pick `8ed77738`, PR289 merge `bc55c91a`.
- Cove exit: `32680477`; HUD measurement: `0ebe63ee` and `11306f08`.
- Cove sampler/routing: `3793c675` and `3681ed20`; NPC exit: `498c04ab`.
- Phone controls: `24d1cb1c` / `fe944ba5`; phone map: `9e7aa6fb` / `6d16cbf4`; tablet cap: `b7adac31` / `ec435e66`.
- Slot asset patch: local `df424a01`, landed `05122ea4` / `b31e8468`, PR292 merge `3846e5de`.
- Asset cache repair: staging `074a413a`, PR293 merge `c185bca4`.
- Nori v64: dd PR294 merge `a6d17e05`.

Different SHAs often reflect cherry-picks and rebases. They do not establish a revert by themselves.

## Independent validation on Sep22

From `apps/web`, ran the eight relevant suites against baseline source:

```text
bun test src/lib/three/__tests__/cove-fps-sampler.test.ts src/lib/three/__tests__/cove-click-routing.test.ts src/lib/three/cove-exit-spawn.test.ts src/components/three/world-stage/stage-frame-cap.test.ts src/lib/__tests__/hud-short-touch.test.ts src/lib/__tests__/hud-anchors-registry.test.ts src/stores/__tests__/npc-place-player.test.ts src/components/game/__tests__/spawn-on-load-route-exit.test.ts
55 pass, 0 fail, 198 assertions.
```

All eight suites appear in `.github/workflows/gates.yml:99` onward.
Independent arithmetic then exposes the two nonzero-inset omissions above.
No product code, production data, wallet, or deployed environment changed during this audit stage.

## Required follow-through

### Cleanup implementation, Sep22

The coordinator authorized a bounded touch-layout correction after the audit.
Shared CSS now uses the actual joystick bottom offset for Jump and the short-screen Autonomous panel.
Jump uses a responsive 44–64px target on short screens; the bottom prompt consumes the same size.
Required phone/tablet dimensions and both orientations retain their zero-inset geometry.
Tests include bottom insets0/20/34/44 and the 740×360 case.

The expanded tests also exposed an older, separate small-portrait defect.
At 320×568 with a 34px bottom inset, the old prompt top reserve prevented its full8px gap above Jump.
The coordinator authorized a bounded correction for this case too.
Jump's size now also respects the prompt's shared top reserve on narrow viewports.
At 320×568 with inset44, Jump becomes48px and the prompt retains its8px gap.
All91 tests across the two affected suites pass, with425 assertions.
After the Nori correction, the combined three suites pass99 tests with463 assertions.
`bunx tsc --noEmit --incremental false` exits0 for the final web diff.
`git diff --check` exits0.
For narrower or shorter screens, a44px target plus the current joystick and prompt reserves require at least564px height at width320/inset44.
That arithmetic states the limit; it does not claim universal device coverage.

The coordinator owns independent browser checks, current deployment comparison, and the combined complaint matrix.
The bounded touch-layout correction must cover nonzero bottom insets and keep normal geometry unchanged.
The migration comments must acknowledge the old ORM reader and expand/contract sequencing failure.
The final verdict must distinguish tested source, current runtime evidence, and unresolved real-device approval.

PARITY: these touch-layout repairs affect human controls only; connected and hosted agent identity and settlement paths remain unchanged.
