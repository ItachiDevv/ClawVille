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
