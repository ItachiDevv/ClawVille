# Actual Claude B3a correction review

Session: 659a7e20-40ca-43b7-a210-ba716d16cb85

**Verdict: APPROVED.** The five blocker corrections and R1 are narrow and correct in the source, and I found no new blocking regression.

This was a read-only review with Read, Grep and Glob. I ran no tests, builds, browsers or staging checks. The queue 41/104 and React 8/20 results come from the owner and root, not from me. Those tests use a mocked transaction model and jsdom. They do not prove PostgreSQL durability or live browser behavior, and I make no staging or mainnet claim.

## The five blockers

1. **Older browsers: fixed.** `activity-request.ts:4-25` uses one local `AbortController` with an 8 s `setTimeout`. It forwards the caller signal and clears the timer in `finally`. I found no `AbortSignal.any` or `AbortSignal.timeout` call in `components/game`. `use-party.ts:76-84` ignores `AbortError`.
2. **Failed queue leave locks the avatar out: fixed.**
   - Server: `activity-queue.ts:172-174` retries the stored exact entry ID before a new admission. If the retry fails, the DB error goes back to the user (test `:656-670`).
   - Client: `activity-lobby-modal.tsx:1044-1054` returns `false` and shows a toast on failure. `handleClose` (`:1057`) keeps the lobby in `queuing` until the leave succeeds.
3. **Partial party admission: fixed.**
   - `enqueueBatch` reserves every member before the first await (`:155-171`).
   - All rows go into one transaction (`:206`), and publication is synchronous (`:211`), so the matcher never sees part of a party (test `:697`).
   - `joinParty` refuses while a departure is pending (`:503`, test `:686`).
4. **Concurrent enqueue and solo leave during insert: fixed.**
   - A second admission for the same avatar fails at `:156`.
   - `leaveQueue` cancels the in-flight token (`:282-292`). The fence at `:209` runs with no await before `:211`, so a cancellation never gets published.
   - `leaveQueue` waits for `settled` and retries only its own IDs (`:288`), so it never touches a newer admission.
5. **Guest match not routed to 3D: fixed.** `WorldPresence.tsx:102` passes `partyEligible={!isGuest}`. Guests poll leave-queue and queue-status but never call party routes (test `:60-63`). `requireLedgerCapableIdentity` (`require-auth-or-agent.ts:453-468`) blocks only agents that are not ledger-capable, so a guest's Lucia session passes.

## R1: recovery when the player enters Office

- `GamePage` no longer mounts `Activity2DRecovery`. The only mount is `WorldPresence`, and `(world)/layout.tsx:14` mounts `WorldPresence` once. So only one recovery controller exists.
- `WorldPresence.tsx:100-101` mounts recovery only on `/game` and `/brainchain`, only in 2D, and only with a user and an avatar. Other app pages get no polling (test `:89-91`).
- The key does not change between `/game` and `/brainchain`, so the controller keeps running across the transition. Test `:50-59` waits on a party leave, moves to `/brainchain`, and then follows the exact assigned room.

**Late responses from an old identity.** `isCurrent` reads the raw `['auth-me']` data (`{ user }`) and the raw `['avatar']` data (`{ avatar }`). These shapes match `use-auth-me.ts` and `use-avatar.ts` (where `select` gives `data.avatar`). It also compares a generation counter. `clearIdentityState` calls `resetQueries()`, which sends an `updated` event with `data === undefined`. That event increments the counter, so an old closure returns `false` at once and the key remounts the controller. The recovery checks `isCurrent` after every await before it navigates (`activity-2d-recovery.tsx:47,49`). A late party leave sent under the wrong cookie is harmless: `leaveParty` returns early when the avatar is not a member. Test `:75-88` covers logout, avatar change and session reset.

**Assigned rooms stay authoritative.** Neither `leaveQueue` nor `leaveParty` touches `matchedRooms`. A leave during `createRoom` keeps the room. The recovery navigates even while the party leave waits.

## Other risks I checked (no regression)

- **Leave and rejoin during an admission:** `leaveParty` waits on the admission's `settled` promise through `leaveQueue`, so the ABA case cannot happen.
- **Kick or join during an admission:** `assertBatchValid` runs after commit and aborts the full batch.
- **Pending batch cleanup ownership:** `persistQueueLeave` removes only map entries that are still identical to their batch member (`:316-318`). Staged batch entries never go into memory. A solo cleanup's `removeFromMemory` deletes the avatar lookup only when the ID matches (`:942-944`).
- **2D member and 3D leader:** the 2D member's leave-queue poll can cancel the leader's in-flight party admission. The leader then gets an honest 400 with no partial queue. This matches the 2D-leaves-party design.
- **Rate limits:** no global rate limiter applies to `/api/activities` (`index.ts:229-286`), so the 2 s poll gets no 429s.
- **Unchanged areas:** 3D defaults, CT, wager and auth middleware.

## Non-blocking (not part of this correction)

- **Disclosed limit:** if the commit reply is lost and the cleanup also fails, the full batch can come back at boot hydration (test `:754`). A pod restart before the retry restores a complete party, never a partial one. Only a PostgreSQL run can prove this.
- **Error message text:** `activity-request.ts:13` calls `response.json()` before it checks the status. An HTML 502 from the proxy then shows a parse error, not the friendly text. Minimal fix: `const body: unknown = await response.json().catch(() => ({}));`.
- **Kick, older behavior:** `kickMember` (`:540`) does not call `leaveQueue`. A member kicked after the party queues stays in the party unit. This review did not change it.

## Still not proven

- PostgreSQL transaction and commit behavior.
- A real browser on `/game` → `/brainchain` with a 2D member and a 3D leader.
- An older Safari or iPad device.
- Staging.

## Root reconciliation

The scoped approval covers the five original blockers and R1. It does not close R2.
Root independently reproduced kick/rejoin ABA while this review ran. The review statement that kick or join always aborts the batch is insufficient for that combined sequence.
The old admission succeeded after kick followed by rejoin. See docs/brainchain-2d-party-root-review.md and its retained probe.
World owner now corrects R2; the changed scope requires fresh review.

## R2 independent correction review

Session: 1c33a254-fecc-487f-8e51-bf07152a5dcd

**R2 verdict: APPROVED.** I only read the code. I ran no commands. I did not run the test again. Your evidence (root 2 tests and 6 assertions, owner 42 tests and 106 assertions) stays the test result.

**`kickMember`** (`activity-queue.ts:540-545`)
- Kick adds 1 to `partyDepartureVersions` before `party.members.delete`. Thus, from the first synchronous point, `valid()` cannot see "member present, old version".
- Kick calls `pruneDepartureVersion` right after the removal. During an admission, the prune returns early because `inFlightEnqueues.has(avatarId)` is true. Thus the new version stays. Kick does not wait for the admission.
- When a leave is still in progress, kick adds 1 again. This has no bad effect: `pendingPartyLeaves` already makes `valid()` fail, and the prune keeps the entry until `leaveParty` clears it.

**Version capture in `enqueueBatch`** (`:158-170`)
- Each reservation reads `version` and sets `inFlightEnqueues` in the same synchronous step. No `await` comes between them. Thus no prune can delete the key between the read and the check.
- `assertBatchValid` runs before each insert, after the insert or transaction, and before publication. In R2, the old insert returns, then `valid()` compares the captured value with the new value and throws. The rejoin calls `members.add` but does not reset the version.

**Prune and `finally` lifetime** (`:226-231`, `:968-971`)
- The version lives from the capture to the `finally`. The `finally` deletes the in-flight token and then prunes the key. The prune runs after the `catch` cleanup, so the cleanup cannot let a new version of that member slip through.
- While the old admission runs, a second enqueue for the rejoined member fails at `:156` with "already in progress". After the old admission ends, the key is gone. A new admission then reads 0 and is valid. The two admissions never overlap.

**Test** (`activity-queue.test.ts:774-785`)
- The order is correct: the insert waits, the member is kicked, the member joins again, then the insert continues. There is no `await` before `db.transaction`, so the transaction gets the blocked `dbMock.insert`.
- The test checks two results: the old request fails, and `getQueuedEntry(pid(1))` is null. The leader stays, so the party does not disband.
- Optional improvement, not a blocker: line 782 accepts any `Error`. Check for `'Party membership changed during queue admission'`, so that a fault in the mock or in the cleanup cannot pass the test.

I found no new blocker in the R2 change.
