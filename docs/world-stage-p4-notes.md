# World Stage P4 Implementation Notes

## Anchor drift

- DRIFT: spec cites pre-P3 `WorldStageRoot.tsx` line/snippet anchors; live is the landed P3 root with unified capability controller and Kelp slot; requirement applied as a fourth empty `activity` slot plus destination-aware navigation against the landed roles.
- DRIFT: spec cites P3's frozen protocol value 41 in historical passages; live is 42; requirement reserved for P4b as the mandated 42→43 bump.
- DRIFT: spec cites four live v42 references in `docs/hatcher-integration-spec.md`; post-P3 live is five current references plus the append-only version ledger; requirement applied as v43 on every current reference and an appended v43 ledger clause while preserving v42 history.
- DRIFT: spec cites an existing `apps/web/.env.example`; live has only the repository-root `.env.example`; requirement applied as the whitelisted new `apps/web/.env.example` containing only the frozen probe-gate row and comment.
- DRIFT: spec cites pre-P3 `use-world-stream.ts` line anchors; live includes P3's ref-delivered `remoteActivity` and unified 200 ms stream machine; requirement applied as the third ref-delivered downlink parameter and frozen retry/epoch/lease policy inside that landed effect without changing its dependency array or `world-stream-machine.ts`.
- DRIFT: spec cites the pre-extraction `useActivityInput.ts` attachment block at `:533-548`; live role is the keydown/keyup/pointer/custom attachment block beside `resetHeldInput`; requirement applied there through `attachHeldKeyListeners` while leaving the key mapping and 30 Hz send loop unchanged.

## Decisions

- The frozen v16 specification is authoritative. No design alternatives will be introduced.
- All work remains local on `feat/world-stage-p4-activities`; origin will not be touched.

## Slice gates

- Documentation mandate: PASS — source/copy SHA-256 `8383A8671904C3C39E732EF9D71CBD32F06E81AB59B317BB4648FB5909758CEB`.
- P4a: PASS — `bun run build` exit 0; `bun run typecheck` 12/12, 0 errors.
- P4b: PASS — protocol 42→43 propagated through manual, derived orientation pointers, test pins, Hatcher live references/history, presence, peer rendering, and canonical docs; 13 focused tests pass; build exit 0; typecheck 12/12.
- P4c: PASS — exact activity routes suspend only the SSE downlink; retry lineage, epoch/source guards, bounded recovery/bootstrap, land refresh, and bfcache reset are wired without changing the world machine or effect dependencies; 11 focused tests pass; build exit 0; typecheck 12/12.
- P4d: PASS — the neutral held-key attachment/reset primitive now owns both avatar and activity listener lifetimes; custom activity actions use the string-typed stage helper; key/action mapping and the 30 Hz activity loop are unchanged; the exact 17-test equivalence suite plus 20 inherited player-frame tests pass; build exit 0; typecheck 12/12.

## Final gates

### §6.2 reconciliation

The first ten exact files ran together as 267/267. The Kelp row is explicitly the
P4 `+3` amendment inside the inherited 18-test file: the three P4 cases ran as
3/3 (`15 filtered out`), and the complete inherited file also ran as 18/18.

| Suite | Declared | Actual | Result |
| --- | ---: | ---: | --- |
| scene-id | 24 | 24 | PASS |
| readiness | 31 | 31 | PASS |
| paint-probe | 8 | 8 | PASS |
| overlay | 81 | 81 | PASS |
| navigation-ownership | 5 | 5 | PASS |
| activity-slot | 15 | 15 | PASS |
| error-boundary | 11 | 11 | PASS |
| room-runtime | 11 | 11 | PASS |
| downlink | 64 | 64 | PASS |
| held-key | 17 | 17 | PASS |
| kelp-walkin P4 amendment | 3 | 3 | PASS |
| **Total** | **270** | **270** | **PASS** |

### Full web tests

- `bun test apps/web`: 516 pass, 4 fail, 520 total across 38 files.
- The four failures are all the known Cove verifier fixture drift:
  - `verifier.runSpinLocal — byte-identity > matches the server slot-engine output for the canonical fixture`
  - `verifier.evaluateReelsLocal > flat 0-0-0-0-0 across middle row pays line 0 5-of-Cherry (multiplier 20)`
  - `verifier.replaySpin > reports ok=true when expected matches computed`
  - `verifier.evaluateReelsLocal — bonus scatter + wild multiplier math > two wilds on one line multiply their multipliers`
- Detached `origin/staging` reproduction of the exact verifier file: 36 pass,
  4 fail, with the same names and expected/received values. No baseline code was
  changed.

### Diff scope

`git diff --name-only origin/staging`:

```text
3dStructure.md
ARCHITECTURE.md
GameFeatures.md
apps/api/src/routes/__tests__/agent-paid-surface.test.ts
apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts
apps/api/src/services/skill-protocol.ts
apps/web/.env.example
apps/web/src/app/(world)/activity/[activityId]/[roomId]/activity-room-runtime.test.tsx
apps/web/src/app/(world)/activity/[activityId]/[roomId]/page.tsx
apps/web/src/app/(world)/layout.tsx
apps/web/src/components/three/world-stage/ActivitySceneErrorBoundary.test.tsx
apps/web/src/components/three/world-stage/ActivitySceneErrorBoundary.tsx
apps/web/src/components/three/world-stage/StageHostedActivityScene.tsx
apps/web/src/components/three/world-stage/StageTransition.tsx
apps/web/src/components/three/world-stage/WorldPresence.tsx
apps/web/src/components/three/world-stage/WorldStageCanvas.tsx
apps/web/src/components/three/world-stage/WorldStageRoot.tsx
apps/web/src/components/three/world-stage/stage-activity-slot.test.tsx
apps/web/src/components/three/world-stage/stage-navigation-lineage-store.ts
apps/web/src/components/three/world-stage/stage-navigation-ownership.test.ts
apps/web/src/components/three/world-stage/stage-navigation-ownership.ts
apps/web/src/components/three/world-stage/stage-navigation.ts
apps/web/src/components/three/world-stage/stage-outgoing-overlay.test.tsx
apps/web/src/components/three/world-stage/stage-scene-id-for-pathname.test.ts
apps/web/src/components/three/world-stage/stage-scene-id.ts
apps/web/src/components/three/world-stage/stage-store.ts
apps/web/src/components/three/world-stage/stage-watchdog-machine.ts
apps/web/src/components/three/world-stage/world-presence.test.ts
apps/web/src/hooks/use-world-stream.ts
apps/web/src/hooks/useActivityInput.ts
apps/web/src/hooks/useActivityWs.ts
apps/web/src/hooks/world-downlink-policy.test.ts
apps/web/src/hooks/world-downlink-policy.ts
apps/web/src/lib/three/activities/ActivityCanvasReadyProbe.test.ts
apps/web/src/lib/three/activities/ActivityCanvasReadyProbe.tsx
apps/web/src/lib/three/activities/activity-readiness.test.ts
apps/web/src/lib/three/activities/activity-readiness.ts
apps/web/src/lib/three/activities/bumper-shells/BumperShellsScene.tsx
apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx
apps/web/src/lib/three/kelp-walkin-guard.test.ts
apps/web/src/lib/three/kelp-walkin-guard.ts
apps/web/src/lib/three/player/held-key-listeners.test.ts
apps/web/src/lib/three/player/player-input.ts
apps/web/src/lib/three/remote-players.tsx
docs/hatcher-integration-spec.md
docs/persistent-world-canvas-plan-2026-07-24.md
docs/world-stage-p4-brief.md
docs/world-stage-p4-notes.md
packages/shared/src/constants/orientation-skill.ts
packages/shared/src/types/world.ts
```

Scope assertion: PASS. Under `activities/reef-race/`, only
`ReefRaceScene.tsx` appears; under `activities/bumper-shells/`, only
`BumperShellsScene.tsx` appears.

### Build, typecheck, and probe

- Fresh `bun run build`: PASS, 9/9 build tasks, 0 cached, web compiled and
  generated all 34 static pages.
- Fresh `bun run typecheck`: PASS, 12/12 tasks, 0 errors.
- Probe source proof: `WorldStageRoot.tsx:492-555` returns unless
  `NEXT_PUBLIC_ENABLE_STAGE_PROBE === '1'` before constructing or assigning the
  probe object.
- Built-client proof:
  `.next/static/chunks/03l632g2rnlvv.js` emits one effect-level guard before
  the complete `__WORLD_STAGE_PROBE__` assignment and cleanup. The guarded
  object includes `request`, `navigate`, `ledger`, `recover`,
  `sceneInventory`, and `snapshot`; the guard is not limited to `navigate`.
- Production browser confirmation with the env unset:
  `typeof window.__WORLD_STAGE_PROBE__ === 'undefined'`.

### Production browser round trips

- Port deviation: local `:3000` was occupied by an unrelated Packrat Next
  server (PID 37208), which was not terminated. The exact production command
  was run on `:3001` instead; no `bun run dev` was used.
- Cold `/game`: PASS — one 1264×625 canvas painted; screenshot
  `C:\Users\itachi\AppData\Local\Temp\claude\C--Users-itachi-documents-crypto-clawville\aa839a38-c6cb-48bb-9086-3a7b55129d0a\scratchpad\reports\p4-browser\game-cold.png`.
- Reef Race: set `window.__SPA_SENTINEL__.token = 'p4-reef'`, navigated
  same-document to `/activity/reef-race/p4-local`, then used browser history
  back to `/game`. The token survived both legs, the original canvas DOM node
  remained identical, canvas count stayed one, and no alert surface appeared.
  Screenshots: `reef-race.png`, `reef-return-game.png` in the evidence folder.
- Bumper Shells: repeated with token `p4-bumper` and
  `/activity/bumper-shells/p4-local`; the token and identical canvas survived
  both legs, canvas count stayed one, and no alert surface appeared.
  Screenshots: `bumper-shells.png`, `bumper-return-game.png`.
- The API was not running on `:4000`. Therefore this proves route rendering,
  persistent-canvas ownership, and same-document traversal, but does not
  exercise matchmaking, room WebSocket traffic, a live race/match, activity
  input transport, or the world-stream resume against a real API session.

### Protocol v43 propagation

- PASS: `PROTOCOL_VERSION = 43`; all three explicit test pins are 43; Hatcher's
  current header, protocol row, and whitelist reference are 43; both served
  orientation strings are now v43.
- Focused protocol/orientation consumers: 37 pass, 0 fail.
- A targeted current-surface search over the constant, pins, manual, and
  orientation source returns no v42 match. Remaining v42 text in canonical docs
  is historical P3/version-ledger evidence.

### Final-gate commits

- `3d32b904` — reconciliation tests for stage identity and ownership.
- `992ac4a3` — gate fix: page-owned readiness may proceed with no target.
- `acc0504c` — reconciliation tests/seam for the activity paint probe.
- `f6636800` — gate fix: count-evicted navigation issues remain stale.
- `457017b1` — gate fix: activity stage runtime crashes acknowledge readiness.
- `00df0466` — gate fix: audio-unlock listeners stay page-scoped across rooms.
- `bbeedaf3` — reconciliation tests for the activity recovery boundary.
- `c6cf0db5` — reconciliation tests for downlink and Kelp amendments.
- `691d07d4` — typecheck fix: explicit boundary-test child prop.
- `e2ff9d2f` — typecheck fix: avoid a control-flow-narrowed probe assertion.
- `4c007953` — protocol gate fix: served orientation text v42→v43.

**Status: P4 final gates pass; the only non-green/non-exercised items are the
four pre-existing `origin/staging` Cove verifier failures, `:3000` being
occupied (production browser proof ran on `:3001`), and API-backed `:4000`
activity gameplay/WS paths not exercised.**

## Probe-gate Session 4

### Activity-exit retention defect

- Fixed in `e3c042dd` (`fix(web): retain activity route through opaque
  midpoint`). `StageActivityRouteHost` now keeps the activity page under the
  stage root's midpoint-owned `displayedPathname`; the route host changes only
  after the opaque midpoint, and overlay release follows that committed page
  swap.
- The final real-history lane passed all assertions. Its exact precondition was
  committed stage navigation `0 -> 1 -> 2`, `history.go(-2)`, then
  `history.go(+2)`. Generation advanced `4 -> 5`; the outgoing canvas remained
  connected for 553.4 ms and disconnected in `awaiting`, after the opaque
  midpoint. Its incoming-generation readiness trace contains the required
  `WAIT wrong-room` decision and never acknowledges the incoming room.
- Evidence:
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-activity-exit-session4-final.json`.
- The touched inherited surfaces passed: Cove routes at 6.898% heap growth,
  Kelp routes at 16.622% (within its unchanged 17% gate), and Kelp-exit on the
  third clean attempt. The first two Kelp-exit attempts hit its known
  pre-crossing facing-arm flake; the passing 26/26 output is
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-kelp-exit-session4-rerun2.json`.
- Focused overlay tests passed 81/81, `bunx tsc --noEmit` passed, and the
  probe-enabled production build passed 9/9. Activity builds used both
  `NEXT_PUBLIC_ENABLE_STAGE_PROBE=1` and
  `NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true`, as required by the real activity
  route exercised by the lane.

### Activity heap gate ruling

- The loop-5-to-30 controls and activity diagnostic all have the P1c-known
  Three/WebGPU renderer-private
  `textureData.bindGroups -> Set -> _k / Backend.data WeakMap` signature. This
  is the residual accepted and tracked for r186+ in
  `docs/world-stage-p1c-brief.md` under **v4 GATE RULING**, not a
  scene-correlated P4 leak: renderer counts and every scene inventory remain
  flat.
- Cove control: 7.7247% heap growth, +1,850 Sets, +3,192,044 retained bytes.
  Kelp control: 15.5759%, +4,583 Sets, +7,718,396 bytes. Activity diagnostic:
  30.046%, +4,714 Sets, +7,401,384 bytes. Activity's Set count is only 1.03x
  Kelp's despite crossing more contexts.
- The four requested ordinary pre-calibration activity observations were
  38.66%, 41.91%, 40.57%, and 33.35%. The activity-only limit is therefore
  45%, 3.09 percentage points above the observed maximum. Cove is unchanged;
  Kelp remains 17%.
- The change and inline evidence comment are in `56684132`
  (`test(web): probe - calibrate activity heap gate`). A fresh ordinary
  activity run passed every assertion at 39.377%:
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-routes-activity-session4-final.json`.

### Canonical P4a-alone ruling

- Consecutive Cove summaries from the same current-branch production build
  differed:
  `FD113080F75F80EBB85568AA4D04CAEA47ABB8308880DAA40F5D41463A115DB3`
  versus
  `C77F14B3A76A6553D9A571E2EF3321C6F8C4A56517EF7FE907E1B7D497C07CAD`.
  Their canonical forms were identical at
  `1B6E5EBC620D44BA5F88C66B0570244B99A56A29C60A3FA3792BC08049C4328A`.
- **Deviation:** byte-diff replaced by canonical-form diff per orchestrator
  ruling (volatility proven:
  `FD113080F75F80EBB85568AA4D04CAEA47ABB8308880DAA40F5D41463A115DB3`,
  `C77F14B3A76A6553D9A571E2EF3321C6F8C4A56517EF7FE907E1B7D497C07CAD`);
  intent preserved (no behavioral diff).
- `eb5f91f3` (`test(web): probe - add canonical summary form`) adds the
  standalone canonicalizer and two passing tests. The existing probe's default
  output and committed baselines are untouched. Canonical v1 preserves lane
  identity, assertion names and verdicts, verdict/count totals, network and
  violation counts, and threshold/tolerance values while removing run IDs,
  timestamps, durations, paths/URLs, and measured series.
- A detached worktree at exact P4a commit `f25520bf` was freshly installed,
  built 9/9 with the probe flag, served only on `127.0.0.1:3008`, and exercised
  for Cove, Kelp, and Kelp-exit. Cove passed at 3.377%. Kelp completed all 60
  crossings and passed every non-heap assertion, but failed the inherited 17%
  gate in all three clean runs: 21.821%, 19.455%, and 17.829%. Kelp-exit passed
  26/26 on its first run.
- The committed tree has no generated Kelp routes baseline. The comparison
  therefore used the retained final P3 merge artifact
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p3merge-kelp-routes-run3.json`
  (raw SHA-256
  `B95584FCBCFE7AB201BE7D4F28CD27A18A68FEFF406C1AF216886C11B6118E82`,
  PASS at 16.5815%). This baseline gap is itself recorded rather than hidden.
- All three canonical comparisons HARD STOPPED. The preserved diffs are:

```diff
# Cove: committed P3 -> P4a f25520bf
@@ -85,11 +85,12 @@
         "GET /api/auth/me/agent-session": 0,
         "GET /api/avatars/me": 0
       },
-      "stubUnhandled": {
-        "GET /api/auth/me": 39,
-        "GET /api/avatars/me": 3,
-        "GET /api/wallet/link": 32
-      }
+      "interceptedFixtureTraffic": {
+        "GET /api/auth/me": 0,
+        "GET /api/auth/me/agent-session": 0,
+        "GET /api/avatars/me": 0
+      },
+      "stubUnhandled": {}
     }
   },
   "thresholds": {
```

```diff
# Kelp: retained final P3 artifact -> P4a f25520bf
@@ -6,7 +6,7 @@
     "experimentMode": "crossings"
   },
   "verdict": {
-    "pass": true,
+    "pass": false,
     "assertions": {
       "activeCallbacksAdvance": true,
       "bothSlotInventoriesCaptured": true,
@@ -22,7 +22,7 @@
       "hiddenStoresFrozen": true,
       "joinsAfterFirstGameZero": true,
       "kelpCacheControlNonCacheable": true,
-      "kelpHeapPlateauAtMost17Percent": true,
+      "kelpHeapPlateauAtMost17Percent": false,
       "listenerAccountingNeverUnderflowed": true,
       "listenerDeltaZero": true,
       "noRouteCorrelatedStreamReopens": true,
@@ -40,8 +40,8 @@
     },
     "counts": {
       "total": 29,
-      "passed": 29,
-      "failed": 0
+      "passed": 28,
+      "failed": 1
     }
   },
   "counts": {
@@ -65,7 +65,7 @@
       "activeGrowthViolations": 0,
       "transitionErrors": 0,
       "returnLoaderViolations": 0,
-      "inventoryChanges": 3
+      "inventoryChanges": 2
     },
     "recovery": {
       "count": 0
```

```diff
# Kelp-exit: committed P3 -> P4a f25520bf
@@ -8,25 +8,36 @@
   "verdict": {
     "pass": true,
     "assertions": {
+      "beaconChainReset": true,
       "centerHitIsExactStageCanvas": true,
-      "exactAgentSessionFixtureUsed": true,
-      "exactAuthGuestFixtureUsed": true,
-      "exactAvatarFixtureUsed": true,
-      "freshWorldStageProbe": true,
+      "entryLoaderNeverAppeared": true,
+      "exactAgentSessionFixtureIntercepted": true,
+      "exactAuthenticatedNonGuestFixtureIntercepted": true,
+      "exactAvatarFixtureIntercepted": true,
       "kelpCanvasConnectedWithRealBacking": true,
       "kelpNavigationStayedSameDocument": true,
       "kelpPaintHasNonBackgroundVariance": true,
+      "kelpSlotChildMountCountStable": true,
+      "oneCanvasAcrossKelpRoundTrip": true,
+      "playerResetToSpawn": true,
+      "pointerContract": true,
       "returnedToGame": true,
       "returnLoaderAbsent": true,
-      "returnLoaderAppearedBeforeReady": true,
-      "returnLoaderNeverDisappearedBeforeReady": true,
+      "returnLoaderNeverAppeared": true,
       "returnNavigationStayedSameDocument": true,
       "returnTransitionIdle": true,
-      "returnWorldGenuinelyReady": true
+      "returnWorldGenuinelyReady": true,
+      "secondEntryAccepted": true,
+      "stageProbeIdentityStable": true,
+      "worldCameraFrozenWhileKelpActive": true,
+      "worldFacingAcrossKelpRoundTrip": true,
+      "worldFramesFrozenWhileKelpActive": true,
+      "zeroRecoveries": true,
+      "zeroTransitionErrors": true
     },
     "counts": {
-      "total": 15,
-      "passed": 15,
+      "total": 26,
+      "passed": 26,
       "failed": 0
     }
   },
@@ -66,15 +77,20 @@
         "firstGame": 0
       },
       "fixtureTraffic": {
+        "GET /api/auth/me": 0,
+        "GET /api/auth/me/agent-session": 0,
+        "GET /api/avatars/me": 0
+      },
+      "interceptedFixtureTraffic": {
         "GET /api/auth/me": 2,
         "GET /api/auth/me/agent-session": 1,
         "GET /api/avatars/me": 2
       },
       "stubUnhandled": {
-        "GET /api/cosmetics/owned": 2,
-        "GET /api/land/me": 2,
-        "GET /api/wallet/link": 2,
-        "POST /api/kelp/beacon/entry/visit": 2
+        "GET /api/land/me": 1,
+        "GET /api/quests/tutorial/claims": 3,
+        "POST /api/avatars/me/heartbeat": 8,
+        "POST /api/kelp/beacon/entry/visit": 3
       }
     }
   },
```

- Canonical hashes (baseline -> P4a) were:
  Cove
  `EC2CE0FFC46E7BEA6F61B44950B1EDAE435D4A3B28320F609BD045240E25F558`
  ->
  `1B6E5EBC620D44BA5F88C66B0570244B99A56A29C60A3FA3792BC08049C4328A`;
  Kelp
  `1B151D058945E6600098B5A70155BA45B103EAD37911498CE81971D4B530DE36`
  ->
  `51BDB8CF476EB69A3E50E9333E3469362D9E6D026D1AFE02B9E6B2A5CFE17BE7`;
  Kelp-exit
  `1BF3C36D005F94B5156688392990726DCB587C555FC821B9C0F627165848BFAE`
  ->
  `C3F000039BD1CDB6FD9A510C284B40DBD45C559974B1634F0BEE8BF17199FCB3`.
- The detached listener was stopped and its exact temporary worktree removed.
  Nothing was pushed. Sections 6.7-6.9 remain out of scope.

**Session 4 status:** Items 1 and 2 are closed and green. Item 3 is honestly
BLOCKED by the three preserved canonical diffs above; no volatile field was
reintroduced and no preserved verdict/count was normalized away.

### Session 5 same-instrument P4a-alone ruling

- Both detached worktrees used the branch's current probe and canonicalizer
  copied byte-for-byte before execution. Their recorded SHA-256 hashes were
  `85A42D29A95356DFF11B3AD0A45ADE3274BEDFF563D921BC6EB891F2DD8D5D20`
  (`world-stage-probe.mjs`) and
  `7636DC2F15A73D4A176D95AC76F366611CDDE095D06999E1F5DA2AE5762AD6EC`
  (`world-stage-canonicalize.mjs`).
- The fresh `origin/staging` control at `89d059c5` built 9/9 with
  `NEXT_PUBLIC_ENABLE_STAGE_PROBE=1` and produced three green baselines:
  Cove 30/30 at 5.590766% heap
  (`36973697DC2785B3F41EC6BF04D92F85024DCD5956C195B2DBB1D039C0ED5741`
  canonical), Kelp 30/30 at the precise control reading 15.952619660%
  (`1B151D058945E6600098B5A70155BA45B103EAD37911498CE81971D4B530DE36`
  canonical), and Kelp-exit 26/26
  (`F440E9D7EA5F6C6889AC4FE44AFA9D2E7C31B07601F4FA0A6E2DA20A0135FDEE`
  canonical). Five known facing-arm pre-crossing flakes were retained before a
  clean server restart produced the usable Kelp-exit baseline.
- Exact P4a `f25520bf` also built 9/9. Its Cove lane passed 30/30 and 28/28
  assertions at 6.657024%; a retained rerun passed at 3.476703%. Both runs
  canonicalized identically to
  `1B6E5EBC620D44BA5F88C66B0570244B99A56A29C60A3FA3792BC08049C4328A`.
- **Deviation / HARD STOP:** the same-instrument Cove canonical did not match
  the staging control. The sole preserved difference is
  `counts.violations.inventoryChanges`, control `3` versus P4a `1`:

```diff
# Cove: same-instrument origin/staging control -> P4a f25520bf
@@ -64,7 +64,7 @@
       "activeGrowthViolations": 0,
       "transitionErrors": 0,
       "returnLoaderViolations": 0,
-      "inventoryChanges": 3
+      "inventoryChanges": 1
     },
     "recovery": {
       "count": 0
```

- The underlying entries contain no scene inventory delta and
  `sceneInventoriesExactZeroDiff` passed in every run. The control recorded
  WebGPU texture-settle entries at loops 2, 3, and 25; P4a recorded one at loop
  1, and its rerun recorded one at loop 14. That narrows the observed field but
  does not satisfy the orchestrator's required identical-canonical pass
  condition, so it is not normalized or rationalized away.
- Per the ruling, execution stopped at this first unexplained preserved Cove
  difference. P4a Kelp and Kelp-exit were not run, the heap comparison was not
  made, and the `a7bee759` / `e3c042dd` bisect was not entered.
- The two temporary detached worktrees were removed, only their owned
  `127.0.0.1:3008` listeners were stopped, port 3008 was left clear, and nothing
  was pushed.

**Session 5 status:** the apples-to-apples leg remains a HARD STOP on the Cove
canonical mismatch above. The whole probe gate is not green.

### Session 6 inventory distribution and completed P4a regression leg

- The exact Session 5 worktrees were rebuilt: `origin/staging` control
  `89d059c5` and P4a `f25520bf`. Both production builds passed 9/9 with
  `NEXT_PUBLIC_ENABLE_STAGE_PROBE=1`. The copied probe retained SHA-256
  `85A42D29A95356DFF11B3AD0A45ADE3274BEDFF563D921BC6EB891F2DD8D5D20`;
  canonical v1 retained
  `7636DC2F15A73D4A176D95AC76F366611CDDE095D06999E1F5DA2AE5762AD6EC`.
- The requested additional Cove distribution was:
  - staging control: `inventoryChanges` `2`, `2`, `2`; every lane passed.
    Each canonical v1 hash was
    `F0226EBB81026C9205051EEC53468BC40C3908FACCDDE0EC586B1CEDE7433760`.
    Together with Session 5's same-build value `3`, the exact-build control
    distribution is `3, 2, 2, 2`.
  - P4a: `inventoryChanges` `1`, `1`; both lanes passed. Each canonical v1
    hash was
    `1B6E5EBC620D44BA5F88C66B0570244B99A56A29C60A3FA3792BC08049C4328A`,
    matching both retained Session 5 P4a runs.
- This proves the count is WebGPU warmup-timing noise on the same build, not a
  behavioral invariant. `b4fa16e6`
  (`test(web): canonicalize stage probe warmup noise`) ships canonical v2:
  `inventoryChanges` is stripped with the measured `3,2,2,2` distribution in
  the code comment, and the schema is bumped to
  `world-stage-probe-canonical-v2` so forms cannot be silently mixed. Its
  focused suite passes 3/3; the v2 canonicalizer SHA-256 is
  `14F19AE2B0FC34A3A73EE548932922F50A03EF8066F5896DE8FB0176B1EAFA72`.
- All eight retained same-instrument Cove summaries (four control, four P4a)
  are identical under v2 at
  `A5B79D4742800A6BAEEAD5337F237F09811724B0D1E588AF95F5BE52C9C02B8B`.
  No other field differs. The Cove leg therefore passes.
- P4a Kelp completed 30/30 round trips but passed 28/29 assertions:
  `17.589828505%` heap growth versus the precise `15.952619660%` control,
  `+1.637209` percentage points and just outside the instructed approximately
  plus-or-minus 1.5-point noise band. Canonical v2 control
  `13E5F998210690934963F6FAC52AD0C02D376E5B3E505F58026580374B04ED66`
  versus P4a
  `B728427C764C4FA8E1D4E371BFEC731959850FD0E8E7DD121EFBB9DE66A1A0E7`
  differs only at `verdict.pass`,
  `kelpHeapPlateauAtMost17Percent`, and the derived passed/failed totals. This
  is the measured heap-gate consequence, not an unexplained canonical field.
- The prescribed repair bisect measured `a7bee759` at `17.662063168%`
  (`+1.709444` points, still outside the control band) and `e3c042dd` at
  `17.217116264%` (`+1.264497` points, back inside the control band).
  Therefore `e3c042dd` (`fix(web): retain activity route through opaque
  midpoint`) is the repairing commit. The exact bisect sample remained 28/29
  because 17.217% narrowly exceeds the binary 17% assertion; that is retained,
  while the later full-branch Session 4 Kelp run is green at 16.622%.
- P4a Kelp-exit passed 26/26. Its canonical v2 is byte-identical to the
  Session 5 staging control at
  `2F4C822F88BFE98579D12E4307B5AF59395F76373E2620BA0FFB413A9871A808`.

**Session 6 status:** the P4a regression leg is closed. Cove and Kelp-exit are
canonically identical under v2; the sole Kelp difference is an explained
intermediate heap-gate deviation repaired by `e3c042dd`. With the current
branch's Section 6.4-6.6 lanes green, the entire probe gate passes. Nothing was
pushed.

## §6.7 race integrity — Session 7 money gate

### Verdict

**HARD STOP at checkbox 3.** The repaired P4 branch wrote the Reef lap PB and
an integer daily rank. A controlled `origin/staging` race then completed a
faster lap, but did not update that PB row and wrote a `NULL` daily-rank value.
That is both a state-transition difference and a preserved integer-vs-NULL
value-class difference. Per the §6.7 contract, the mid-race Leave and Bumper
Shells checkboxes were not run.

No rows were inserted, updated, deleted, or compensated by hand. All money
evidence below came from the real UI flow and the same staging database used by
the corresponding API process.

### Runtime and scope

- Starting P4 HEAD: `7f31af9ea6dd0bcce4ed569143f3721207cb01dc`.
- P4 API after §6.7 fixes: `3e4a77d5ff5fb64eaa8f87d00166b8612dbcc0e9`,
  direct `apps/api` production build on `127.0.0.1:4000`,
  `REEF_RACE_USE_SPLINE=true`, session-pooler DB, `DB_POOL_MAX=4`.
- P4 web: probe-enabled production bundle on `127.0.0.1:3008`, built with
  `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000` and
  `NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true`.
- Detached control: exact `origin/staging`
  `89d059c5d2958ee68db06fa101f9b47ea42be24c`, API `:4001`, web `:3009`,
  same DB/env/account/procedure.
- Account: user `8f83d834-4660-438b-b367-2200ca830a97`, avatar
  `a74c90f9-8460-4b24-83e2-baede9dbe3d3` (`LandTest1`).
- DB `current_date` was `2026-07-31` UTC. Queries were scoped by the exact
  avatar, room, activity/reason, and run time; live staging traffic was not
  counted.

### Defects exposed and fixed

The first complete P4 run, room
`eee9a8f9-f545-4e26-9864-a1b77ed2c57e`, reached the real results modal in
3rd. It wrote result `2ce3078a-032b-4289-b7e9-1a5bdfda47a4`, event `25658`,
and one 50-CT transaction `99fb5daf-e2b1-40dc-94af-38caecc7b3ef`, but the
direct PB query returned zero rows. The result claimed `is_personal_best=true`
and the ledger included a 10-CT PB bonus, making this a money/PB split-brain,
not a presentation defect.

Two independent app defects caused it:

1. The Spline sim never embedded `reefRace.bestLapMs` / ghost metadata in
   `computeResults`. Commit `15ceda18` (`fix(api): persist spline reef race
   personal bests`) adds bounded 5 Hz lap capture, best-lap selection, the
   established settlement block for finishers and DNF rows, and focused tests.
2. The API's central Reef result adapter then rebuilt every sim row without its
   `reefRace` field. Commit `3e4a77d5` (`fix(api): preserve Reef PB metadata at
   settlement`) preserves that field into the reward pipeline.

Validation:

- API strict typecheck: PASS.
- Spline sim focused suite: 37/37 PASS.
- Spline sim + reward pipeline + PB service + room manager: 110/110 PASS.
- Adapter follow-up reward/room-manager suites: 67/67 PASS.
- Direct API production builds after each fix: PASS.

### Checkbox 1 — real P4 Reef Race: PASS

The retained passing UI artifact is
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s7-reef-p4-pass.json`
with screenshot
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s7-reef-p4-pass.png`.
The browser used `/game?quickQueue=reef-race`; the real queue matched room
`951ad185-9f9e-42fb-b671-ac106f5a5b4e` (`QMB209`), then observed countdown,
LIVE, lap completion, the human `event.crossed_finish` at placement 4 and
143632.983 ms, `event.match_ended`, and the results modal (`You placed 4th`,
`+25 vCLAW`, `+2` leaderboard).

### Checkbox 2 — P4 database money assertions: PASS

The exact scoped queries were:

```sql
SELECT id, room_id, activity_id, avatar_id, subject_type, placement,
       score, score_ms, tokens_awarded, leaderboard_points,
       is_personal_best, match_best_streak, match_pb_daily_rank, created_at
FROM activity_results
WHERE room_id = '951ad185-9f9e-42fb-b671-ac106f5a5b4e'
  AND avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3';

SELECT id, event_type, avatar_id, payload, ts
FROM events
WHERE event_type = 'activity.match.placed'
  AND avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND payload->>'roomId' = '951ad185-9f9e-42fb-b671-ac106f5a5b4e';

SELECT id, avatar_id, amount, balance_after, reason, source, provenance,
       metadata, created_at
FROM claw_token_transactions
WHERE avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND reason = 'activity_match_placed'
  AND metadata->>'roomId' = '951ad185-9f9e-42fb-b671-ac106f5a5b4e';

SELECT id, avatar_id, activity_id, best_lap_ms, best_lap_recorded_at,
       source_room_id,
       jsonb_array_length(ghost_replay_data->'frames') AS ghost_frame_count,
       created_at, updated_at,
       (best_lap_recorded_at AT TIME ZONE 'UTC')::date AS utc_day
FROM reef_race_personal_bests
WHERE avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND activity_id = 'reef-race';
```

Results:

- `activity_results`: exactly one row,
  `ab4e132d-1fb5-47e8-bd71-2f401d4c5a7d`; placement 4,
  score/score_ms `-143633` / `143633`, tokens 25, leaderboard 2,
  `is_personal_best=true`, streak 0, `match_pb_daily_rank=1`,
  created `2026-07-31T09:53:25.929Z`.
- Human `activity.match.placed`: exactly one row, event `25680`; payload
  placement 4, activity `reef-race`, subject `human`, leaderboard 2, room
  correct. Three additional room-scoped placed events (`25682`-`25684`) belong
  to the three bots and are excluded by the required account/avatar scope.
- CT credit: exactly one row,
  `9632e5cb-5357-4de7-b4fb-fb7c1dbfaa3e`; amount 25,
  `reason='activity_match_placed'`, source `simulation`, provenance `soft`,
  metadata room correct, breakdown `{base:15, personalBestBonus:10,
  firstPlayOfDayBonus:0, focusBonus:0, perfectStreakBonus:0}`.
- PB/daily-best source: exactly one PB row,
  `373aca77-4ca2-44df-9b7a-1b9b1a0a9be5`; best lap 70,233 ms,
  source room is the P4 room, 251 stored ghost frames,
  recorded/created/updated `2026-07-31T09:53:25.767Z`,
  `utc_day='2026-07-31'`. The daily-best is an indexed aggregation over this
  PB table, not a separate append table; the per-match persisted daily outcome
  is `activity_results.match_pb_daily_rank=1`.

### Checkbox 3 — exact `origin/staging` comparison: HARD STOP

The first staging control completed room
`24c5ecbf-ae60-42d7-8163-a43303752537` in 4th. Its 70.83 s best lap was slower
than the stored 70.233 s P4 PB, so its null daily rank was performance-dependent
and was not used to claim a code difference.

After restarting only the owned staging API so a new room could be matched, the
controlled rerun completed room
`67018cc7-00ad-4269-94e8-e876c9d8ee5c` in 3rd. Its real
`event.lap_completed.splitMs=68166.50024414062` was 2,066 ms faster than the
stored PB. Artifacts:

- `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s7-reef-staging-2.json`
- `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s7-reef-staging-2.png`

The same four SQL templates above, substituting staging room
`67018cc7-00ad-4269-94e8-e876c9d8ee5c`, returned:

- result `e4a74048-02c0-4630-8d8a-b160f5a10618`: placement 3,
  score/score_ms `-135900` / `135900`, tokens 25, leaderboard 8,
  `is_personal_best=false`, streak 0, **`match_pb_daily_rank=NULL`**;
- exactly one human placed event, `25704`, correct placement 3;
- exactly one CT row, `ebc765c0-c1a4-485c-a891-678acf780593`,
  amount 25, correct room/reason/source/provenance;
- PB query still returned id
  `373aca77-4ca2-44df-9b7a-1b9b1a0a9be5`, best lap **70,233 ms**,
  source room **the earlier P4 room**, and unchanged
  recorded/created/updated time `2026-07-31T09:53:25.767Z`.
  In other words, staging did not apply the demonstrated 68,166 ms improvement.

Normalization used for the comparison:

- removed opaque row IDs, timestamps, and room/source-room UUID values;
- removed `balance_after` because the shared DB had scoped background traffic;
- normalized placement and values directly derived from placement (base award,
  total award, leaderboard award, ordinal);
- retained every column/key, row cardinality, enum/string/boolean meaning,
  null-vs-non-null class, integer/finite performance-value class, activity and
  subject identity, ledger reason/source/provenance, breakdown keys, and PB
  mutation/source ownership.

The decisive normalized diff is:

```diff
 activity_results
- match_pb_daily_rank: integer
+ match_pb_daily_rank: null

 reef_race_personal_bests state transition for a faster valid lap
- updated: true; best_lap_ms: 70233; source: current P4 run
+ updated: false; best_lap_ms: 70233; source: earlier P4 run
```

The second line deliberately records mutation semantics: for the initial P4
run the no-row state became a dated PB row; for the staging faster-lap run the
existing row did not change at all. This is not an ID, timestamp, room,
placement, or live-traffic normalization.

**Verbatim hard-stop finding:** `origin/staging` completed a valid 68,166 ms
lap, faster than the persisted 70,233 ms PB, but left the PB row unchanged and
wrote `match_pb_daily_rank=NULL`; the repaired P4 path persisted its valid PB
and wrote an integer daily rank. The normalized money-path write sets are not
identical. §6.7 checkbox 3 FAILS and execution stops.

### Checkboxes 4 and 5

- Mid-race voluntary Leave: **NOT RUN — prohibited after checkbox 3 HARD
  STOP.**
- Bumper Shells completion/DB check (and any comparison note): **NOT RUN —
  prohibited after checkbox 3 HARD STOP.**

Nothing was pushed.

## §6.7 race integrity — Session 8 orchestrator ruling and completion

### Orchestrator ruling (verbatim)

> Session 7's hard stop is CLEARED by orchestrator ruling. The control run proved the spline PB persistence defect is PRE-EXISTING on `origin/staging` (faster lap 68,166 ms vs stored 70,233 ms PB → no update, `match_pb_daily_rank=NULL`), and it has a money component (the ledger paid a 10-CT PB bonus while the PB row never persisted — a repeatable-bonus leak). Repo law: pre-existing bugs found are FIXED, not walked past. The two fixes (`15ceda18`, `3e4a77d5`) STAY. The §6.7 comparison passes WITH the documented intentional difference: money rows (result/event/CT credit) identical in shape; PB/daily-rank rows now correctly written on the branch where staging wrongly omits them.

This ruling supersedes the Session 7 hard-stop verdict above and authorizes the
remaining §6.7 work. No row was inserted, updated, deleted, or compensated by
hand. All assertions below use the same `LandTest1` account and staging database
as Session 7, with P4 API `:4000`, P4 web `:3008`, spline/probe flags enabled,
and exact avatar/room scoping. Port `:3000` remained untouched. Nothing was
pushed.

### Final checkbox verdicts

| Checkbox | Verdict | Evidence |
| --- | --- | --- |
| 1 — complete real-UI P4 Reef Race | **PASS** | Session 7 retained complete race plus Session 8 complete post-repair room `4cb633c8-53b9-490d-ab24-5faed8ced74f`. |
| 2 — one result, one placed event, one CT credit, correct PB behavior | **PASS** | The post-repair race was slower than the 66,833 ms stored PB: result `55e65dfe-461c-4ab0-850c-90631f75b437` is not a PB, CT row `7c963e17-0a92-4959-b67e-2741c2eb4e77` contains base 15 and PB bonus 0, and PB row `373aca77-4ca2-44df-9b7a-1b9b1a0a9be5` remained unchanged. |
| 3 — `origin/staging` normalized comparison | **PASS WITH DOCUMENTED INTENTIONAL DIFFERENCE** | Per the ruling: result/event/CT-credit rows are identical in shape; P4 additionally persists the valid PB and integer daily rank that staging wrongly omits. No unexplained money-row difference exists. |
| 4 — mid-race voluntary Leave | **PASS** | Real UI sent `{type:'leave'}` in room `efa19c44-3c2b-4d06-b60c-39c3636c00b6`; hub routes it to `event.player_left` with `reason:'voluntary'`; DNF result `92277b1c-9d63-4bdd-8807-e47d1f4b0ec3` settled once with no PB write/bonus. |
| 5 — complete Bumper Shells | **PASS** | Real UI joined and drove room `c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c` through its 90-second sim; result `eeefb4c1-6f1a-49e6-b155-d6761dd5e084`, event `25777`, and CT row `7667ee62-b12b-41ea-9dd9-fe7616385ca9` are each singular and consistent. |

### PB-fix bidirectional proof

The first Session 8 complete Reef run used the real queue/UI and finished room
`4afcc9ab-0bda-4941-86bf-71a94bda5b21` in first. Its best lap was 66,833 ms,
faster than the stored 70,233 ms PB. The PB row correctly updated to 66,833 ms,
source room `4afcc9ab-0bda-4941-86bf-71a94bda5b21`, daily rank 1. It exposed a
third pre-existing defect: the reward pipeline compared whole-match `score_ms`
history while the PB writer compared best-lap time. Consequently result
`c96a9f75-95a1-4b05-bdd6-bfa64f3757db` said
`is_personal_best=false` and transaction
`44c1ac31-fb1e-46b3-89fd-f989271ae04a` paid base 50 with PB bonus 0 even
though the PB row was claimed by that room. Commit `f3bc1de0`
(`fix(api): pay Reef bonus from persisted lap PB`) makes the persisted lap-PB
claim authoritative for the result flag and one-time bonus, including
same-room settlement retry idempotence.

The required post-repair complete UI proof then took the accepted **slower**
branch in room `4cb633c8-53b9-490d-ab24-5faed8ced74f`:

- UI artifacts:
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-reef-proof.json`
  and
  `C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-reef-proof.png`.
- Exactly one result,
  `55e65dfe-461c-4ab0-850c-90631f75b437`: placement 4,
  score/score_ms `-150266` / `150266`, tokens 15, leaderboard 2,
  `is_personal_best=false`, streak 0, `match_pb_daily_rank=NULL`.
- Exactly one scoped human `activity.match.placed`, event `25726`.
- Exactly one CT transaction,
  `7c963e17-0a92-4959-b67e-2741c2eb4e77`: amount 15,
  `source='simulation'`, `provenance='soft'`, breakdown base 15 and every bonus
  including `personalBestBonus` equal to 0.
- PB row `373aca77-4ca2-44df-9b7a-1b9b1a0a9be5` remained exactly 66,833 ms,
  recorded/updated `2026-07-31T10:26:02.488Z`, source room still
  `4afcc9ab-0bda-4941-86bf-71a94bda5b21`. No write and no repeat bonus occurred.

This real slower-path proof establishes that the repair does not overpay. The
focused reward/PB suites cover the corresponding faster claim and retry path,
while the preceding complete faster run supplied the end-to-end defect evidence
that drove the repair.

### Checkbox 4 — voluntary Leave and DNF settlement

The real UI matched Reef room
`efa19c44-3c2b-4d06-b60c-39c3636c00b6`, entered LIVE, drove for eight seconds,
clicked the live Leave control, emitted an outbound `{type:'leave'}` frame, and
returned to `/game`. The evidence is
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-reef-leave3.json` and
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-reef-leave3-room.png`.

Hub/sim evidence is deterministic and seekable in source:

- `activity-ws-hub.ts` handles `type:'leave'` by assigning internal close code
  1000 and closing as `voluntary leave` (lines 402-405).
- The close path immediately calls `notifyForfeit(..., 'voluntary')` without a
  reconnect grace period (lines 323-329).
- `notifyForfeit` invokes the live Reef sim's `forfeit` and broadcasts
  `event.player_left` with the same avatar and `reason:'voluntary'` (lines
  949-960).
- `reef-race-spline-sim.ts` marks the body `forfeited=true`, `dnf=true`, and
  `alive=false`, and emits the same `event.player_left` payload (lines
  1070-1088).

The first diagnostic attempts exposed that the generic 30-second no-WS crash
sweeper aborted a server-driven race after the voluntarily-leaving human was
gone, before the sim could settle its DNF. Commit `87114e6b`
(`fix(api): settle activity DNFs after voluntary leave`) exempts Reef Race and
Bumper Shells from that generic sweep; their sim terminal callbacks and hard
timeouts remain the owners of completion and cleanup.

Post-repair DB assertions for the passing room:

- Exactly one DNF result,
  `92277b1c-9d63-4bdd-8807-e47d1f4b0ec3`: placement 4,
  score `-630001`, `score_ms=NULL`, tokens 15, leaderboard 2,
  `is_personal_best=false`, streak 0, `match_pb_daily_rank=NULL`.
- Exactly one scoped placed event, `25755`.
- Exactly one CT transaction,
  `4e693aae-657c-4526-add6-a58f25145770`: amount/base 15 and PB bonus 0.
- PB row `373aca77-4ca2-44df-9b7a-1b9b1a0a9be5` remained at 66,833 ms with
  unchanged timestamp/source. The DNF produced neither a PB write nor bonus.

`event.player_left` is a real-time hub/sim protocol event, not an analytics row
in the `events` table; the persisted event assertion for settlement is the
single `activity.match.placed` row above.

### Checkbox 5 — Bumper Shells

The browser used `/game?quickQueue=bumper-shells`, matched room
`c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c` (`EHJCEW`), opened the real activity
route with one connected human, reached LIVE, and supplied movement/jump/item
inputs while the authoritative sim ran from
`2026-07-31T10:53:31.570Z` through `2026-07-31T10:55:01.747Z`.
Artifacts are
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-bumper2.json` and
`C:\Users\itachi\AppData\Local\Temp\world-stage-p4-s8-bumper2-room.png`.

The temporary harness captured `event.match_ended` and exited its control loop,
then timed out only on an additional Reef-style terminal-copy/modal wait. The
authoritative settlement had already completed. That harness timeout is not a
match or money-path failure; the exact DB rows are:

- one result, `eeefb4c1-6f1a-49e6-b155-d6761dd5e084`: placement 4, score 0,
  `score_ms=NULL`, tokens 10, leaderboard 2, `is_personal_best=false`, PB/streak
  columns `NULL` where Bumper does not define them;
- one scoped human placed event, `25777`;
- one CT transaction, `7667ee62-b12b-41ea-9dd9-fe7616385ca9`: amount/base 10,
  correct room/activity/reason/source/provenance, every bonus 0.

Bumper Shells does **not** write a distinct reward row class. Both activities
settle through `activity-room-manager.ts` → `issueRewardsForRoom`, producing the
same `activity_results`, `events(activity.match.placed)`, and
`claw_token_transactions(activity_match_placed)` classes. Reef alone adds its
PB table semantics. Therefore the ruled Reef staging comparison suffices for
Bumper; no separate staging-control run is required.

### Exact Session 8 scoped SQL

The Session 8 reconciliation used the following exact room list. The first room
is the faster defect-discovery run; the other three are the accepted slower Reef
proof, voluntary-Leave DNF proof, and Bumper completion proof respectively.

```sql
SELECT id, room_id, activity_id, avatar_id, subject_type, placement,
       score, score_ms, tokens_awarded, leaderboard_points,
       is_personal_best, match_best_streak, match_pb_daily_rank, created_at
FROM activity_results
WHERE room_id IN (
  '4afcc9ab-0bda-4941-86bf-71a94bda5b21',
  '4cb633c8-53b9-490d-ab24-5faed8ced74f',
  'efa19c44-3c2b-4d06-b60c-39c3636c00b6',
  'c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c'
)
  AND avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
ORDER BY created_at;

SELECT id, event_type, avatar_id, payload, ts
FROM events
WHERE event_type = 'activity.match.placed'
  AND avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND payload->>'roomId' IN (
    '4afcc9ab-0bda-4941-86bf-71a94bda5b21',
    '4cb633c8-53b9-490d-ab24-5faed8ced74f',
    'efa19c44-3c2b-4d06-b60c-39c3636c00b6',
    'c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c'
  )
ORDER BY ts;

SELECT id, avatar_id, amount, balance_after, reason, source, provenance,
       metadata, created_at
FROM claw_token_transactions
WHERE avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND reason = 'activity_match_placed'
  AND metadata->>'roomId' IN (
    '4afcc9ab-0bda-4941-86bf-71a94bda5b21',
    '4cb633c8-53b9-490d-ab24-5faed8ced74f',
    'efa19c44-3c2b-4d06-b60c-39c3636c00b6',
    'c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c'
  )
ORDER BY created_at;

SELECT id, avatar_id, activity_id, best_lap_ms, best_lap_recorded_at,
       source_room_id,
       jsonb_array_length(ghost_replay_data->'frames') AS ghost_frame_count,
       created_at, updated_at,
       (best_lap_recorded_at AT TIME ZONE 'UTC')::date AS utc_day
FROM reef_race_personal_bests
WHERE avatar_id = 'a74c90f9-8460-4b24-83e2-baede9dbe3d3'
  AND activity_id = 'reef-race';

SELECT id, activity_id, status, started_at, ended_at
FROM activity_rooms
WHERE id = 'c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c';
```

The ordered result/event/credit row IDs were:

| Room | Result | Placed event | CT transaction |
| --- | --- | --- | --- |
| faster Reef defect discovery `4afcc9ab-0bda-4941-86bf-71a94bda5b21` | `c96a9f75-95a1-4b05-bdd6-bfa64f3757db` | `25715` | `44c1ac31-fb1e-46b3-89fd-f989271ae04a` |
| post-repair slower Reef proof `4cb633c8-53b9-490d-ab24-5faed8ced74f` | `55e65dfe-461c-4ab0-850c-90631f75b437` | `25726` | `7c963e17-0a92-4959-b67e-2741c2eb4e77` |
| voluntary-Leave DNF `efa19c44-3c2b-4d06-b60c-39c3636c00b6` | `92277b1c-9d63-4bdd-8807-e47d1f4b0ec3` | `25755` | `4e693aae-657c-4526-add6-a58f25145770` |
| Bumper completion `c04ddf11-ba76-4e7e-8a86-ebf69c0a0d8c` | `eeefb4c1-6f1a-49e6-b155-d6761dd5e084` | `25777` | `7667ee62-b12b-41ea-9dd9-fe7616385ca9` |

The PB query returned exactly row
`373aca77-4ca2-44df-9b7a-1b9b1a0a9be5`: 66,833 ms, source
`4afcc9ab-0bda-4941-86bf-71a94bda5b21`, 251 ghost frames,
recorded/updated `2026-07-31T10:26:02.488Z`, UTC day `2026-07-31`.

### Session 8 repair verification

- `reef-race-personal-best-service`: 7/7 PASS.
- `reward-pipeline`: 31/31 PASS.
- `activity-room-manager`: 40/40 PASS.
- `reef-race-spline-sim`: 37/37 PASS, including voluntary-forfeit event/row
  semantics.
- API strict typecheck: PASS after both Session 8 repairs.
- Direct API production build: PASS after both Session 8 repairs.

**FINAL LOCAL IMPLEMENTATION GATE STATUS — §6.1-§6.7: PASS. §6.8 harness and
§6.9 founder-floor drive are staging-push/after-staging-push gates and were not
run in this local no-push scope.**
