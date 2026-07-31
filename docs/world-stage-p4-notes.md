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
