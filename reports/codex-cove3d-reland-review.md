# cove-3d reland adversarial conflict-resolution review

Verdict: **APPROVE-WITH-FIXES**

Reviewed commit `88200608` statically against both source trees:

- staging: `a156e3c0`
- cove-3d branch: `e39243d2`

Per the review constraint, no install, build, server, or test command was run.

## Findings

### BLOCKER

None.

### MAJOR

None.

### MINOR

1. **The reland leaves two false scene-scale comments.**

   - `apps/web/src/components/three/world-stage/StageHostedCoveScene.tsx:44` calls `COVE_CAMERA_FAR` “2600 at the current knob,” but `apps/web/src/lib/three/cove-interior.tsx:121` sets the current room knob to `2800` and line 319 computes `Math.round(2800 * 1.3) = 3640`.
   - `apps/web/src/lib/three/cove-interior.tsx:3282` still says “Fog scaled with room” beside an intentionally removed local fog node. Fog is actually owned by the fixed cove scene appearance at `apps/web/src/components/three/world-stage/WorldStageRoot.tsx:342`.
   - This is not a runtime defect: line 53 applies the computed constant, not the stale `2600` prose, and stage fog ownership is functioning. It is nevertheless misleading evidence in the exact resolution area under review.
   - **Concrete fix:** remove the hard-coded far-plane value from the `StageHostedCoveScene` comment (or change it to `3640`), and replace the orphaned `cove-interior` fog comment with an explicit pointer to `WorldStageRoot`’s scene appearance.

## Claims verified correct

1. **Blackjack money path**

   - `git diff e39243d2..88200608` confirms that the branch’s old inline settlement tail contributed only `fixture_run_id` to its lock projection and `fixtureRunId` to the event insert in that block.
   - The shared `settleComputedBlackjackHand` helper inserts `fixtureRunId: shoeLock.fixture_run_id` at `apps/api/src/routes/cove-blackjack.ts:2035`.
   - The autonomous lock projects `fixture_run_id` at line 2162; the ordinary REST settlement lock projects it at line 2492. Newly created autonomous shoes explicitly carry the nullable provenance at line 2329.
   - The branch settlement behavior remains represented in the helper: safe-range guards, rake calculation (`:1898`), incremental-stake calculation and underflow guard (`:1900-1901`), ledger/demo accounting, event persistence, and shoe-counter updates (`:2052` onward).
   - Replay behavior remains outside and inside the helper: settled-hand and prior-key prechecks (`:2520-2536`), 23505 promotion to `IdempotencyReplayError` (`:2024`), and the fresh-transaction replay catch (`:2462`).

2. **Protocol version and manual**

   - Relative to `a156e3c0`, the pre-existing 15→40 history is unchanged. The only history-tail change is the new 40→41 note at `apps/api/src/services/skill-protocol.ts:372`, followed by `PROTOCOL_VERSION = 41` at line 381.
   - The note matches live route contracts: cash-table `/last-settled` is registered for a resolved user/agent subject in `apps/api/src/routes/cove-cash-poker.ts:405-414`, and baccarat `/session/current` returns a locked current-shoe snapshot plus latest settled coup at `apps/api/src/routes/cove-baccarat.ts:1608`.
   - The baccarat recovery manual is present at `apps/api/src/services/skill-protocol.ts:1309`; cash-table settled-hand recovery is present at line 1406.
   - Both requested test pins are 41: `apps/api/src/routes/__tests__/agent-paid-surface.test.ts:44` and `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts:29,183`.

3. **Cove frame and input lifecycle**

   - All nine final frame callbacks use `useSceneFrame` (`apps/web/src/lib/three/cove-interior.tsx:1878,2006,2145,2193,2299,2560,2977,2997,3191`); no executable `useFrame` call remains.
   - The “six” in the review premise describes resolution conversions (the two conflicted avatar loops plus four branch-added/clean-applied loops), not the total final callback count. The final total is nine because the file also retains three other staging-safe callbacks.
   - Per-frame listener attachment was removed from both standing-avatar loops. The `[active]` effect attaches both listener families at `:3233-3234`, detaches and clears all input state on inactive/cleanup, and is reached through `StageHostedCoveScene`’s `active={useSceneActive()}` prop.
   - The seated returns are inside the two movement loops at `:2307` and `:2565`. They freeze movement, hide the standing representation, preserve the VRM idle tick where applicable, and allow the dedicated seat camera loop at `:2006` to own the view. Both walking branches restore visibility after standing.
   - Dropping the local fog node is functionally correct: stage appearance owns cove fog at `apps/web/src/components/three/world-stage/WorldStageRoot.tsx:342`. Only the stale comment identified above needs cleanup.

4. **VRM one-shot invalidation and retarget dispatch**

   - There is one request guard, `oneShotRequestToken`, at `apps/web/src/lib/three/vrm-character-animator.ts:746`; no duplicate generation field remains.
   - `cancelOneShot` invalidates pending loads by incrementing that same token at `:1515-1517`.
   - Both the one-shot path and optional next-loop path call `retargetAnimationClip` at `:1413` and `:1433`.
   - `MESHY_ANIM_NAMES` at `:211` contains only the Cove sit/room Meshy-rig clips. EMOTE2 names are absent, so the dispatcher’s fallback at `:230-232` sends them through `retargetMixamoClip`, matching staging’s original all-Mixamo behavior for those Mixamo-named clips.

5. **Hold’em controller extraction**

   - `HoldemModal` is now a pure consumer of `useHoldemController` at `apps/web/src/components/cove/holdem/HoldemModal.tsx:122`; staging’s duplicate request/mutation block is gone.
   - The controller preserves staging’s session epoch invalidation (`apps/web/src/lib/cove/holdem-controller.ts:355,383`), table reuse/open path (`:484`), settled-state application (`:404`), authoritative ambiguous resync (`:508`), and both deal/action ambiguous-rehydrate calls (`:544,:579`).
   - Deal keys mint once and persist across errors (`:532`); action keys are decision-scoped and mint only when `(act, amount)` changes (`:560-564`); close keys persist across ambiguous retries (`:641`).
   - The non-null assertion at `:564` is semantically safe: the immediately preceding branch assigns the ref when it was null or mismatched, while the opposite branch proves an existing matching object. This is only a type-style regression from staging’s `activePending` local, not a behavioral one.

6. **Cove store union**

   - `createInitialCoveState` starts at `apps/web/src/stores/cove.ts:179`; `seatedTable` and all three room intents are initialized there at `:203-207`.
   - `resetCoveStore` reuses that factory at `:347`, so an identity sweep clears stale seating and navigation intents.
   - The store literal spreads the factory once at `:210` and defines only actions afterward; no state key is duplicated.

7. **World-stage ports and camera correction**

   - The three room intents and plain pushes are present in `apps/web/src/app/(world)/cove/page.tsx:66-90`.
   - The route tree confirms `/cove/table`, `/cove/blackjack`, and `/cove/baccarat` live under `apps/web/src/app/cove/`, outside `apps/web/src/app/(world)/`; bypassing stage navigation is correct.
   - `HoldemControllerRuntime` and `SeatedHoldemHud` mount at `apps/web/src/app/(world)/cove/page.tsx:276,281`.
   - Camera installation ordering is correct: `apps/web/src/components/three/world-stage/stage-camera.ts:55-60` installs the selected persistent camera into R3F first and only then acknowledges `cameraInstalled`; the cove effect is gated on that generation-specific acknowledgement at `StageHostedCoveScene.tsx:25-28,51`.
   - The far-plane correction writes the computed `COVE_CAMERA_FAR` and updates the projection at `StageHostedCoveScene.tsx:52-54`.
   - World and cove have separate persistent camera definitions. World remains `far: 11_500` at `WorldStageRoot.tsx:309`; switching active scenes installs the world camera object rather than retaining the cove object’s corrected far plane.
   - `WorldStageRoot` only lazy-imports `StageHostedCoveScene` at `:55-56`. The sole production `cove-interior` import is inside that lazy module, so the eager stage root does not pull the interior into its root chunk.

8. **Import and package unions**

   - Baccarat retains staging’s `createHash`/`desc`/private-cache additions and the branch fixture imports; fixture seed hashing uses shared `sha256Hex` at `apps/api/src/routes/cove-baccarat.ts:93,813`.
   - Hold’em retains staging’s `noStorePrivate`/actor attribution additions and the branch fixture imports; fixture seed hashing uses `sha256Hex` at `apps/api/src/routes/cove-holdem.ts:100,867`.
   - `avatar-chat-bar.tsx` retains staging’s `useQueryClient` import/use and the branch’s `chibi` category mapping (`:4,:32`).
   - `apps/web/package.json` retains `happy-dom` at line 59 and `jsdom` plus its types at lines 54 and 60.
