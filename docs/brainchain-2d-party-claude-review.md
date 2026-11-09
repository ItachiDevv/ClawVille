# Independent Claude B3a and party review

Date:2026-11-09. Session:f4ee6b56-5bd8-4ec2-944f-8d2d61226dfc. Read-only actual Claude CLI; exit0.
Root independently reran current queue tests33/77. The review itself ran no tests.

**Verdict: BLOCKING ISSUES (5).** This is a source review only. I used Read, Grep and Glob. I ran no tests, builds, browsers or staging checks. I did not see the owner's test output. The figures "queue 29/57" and "recovery 3/8" come from the handoff, not from me. No B3a runtime evidence exists.

## Blocking issues

**1. The party requests break on older browsers. This also breaks 3D queueing.**
- `use-party.ts:67` uses `AbortSignal.any`, and `:67` and `:136` use `AbortSignal.timeout`. No other file in `apps/web/src` uses them, and I found no polyfill. `AbortSignal.any` needs Safari 17.4, Chrome 116 or Firefox 124.
- On an older browser, `refresh` throws a TypeError, so `partyError` stays set. Then `partyStateReady` is false (`activity-lobby-modal.tsx:919-922`), and Queue Solo and Queue Party are disabled (`:669`, `:684`). This affects every logged-in non-guest user, also in 3D.
- In 2D, `party` never loads, so the recovery never leaves the party. The 2D fallback is for weak and old devices, so this hits the main users of 2D.
- **Fix:** Use one local `AbortController` and `setTimeout(() => c.abort(), 8000)`. Forward the caller signal with `signal.addEventListener('abort', () => c.abort(), { once: true })`. Clear the timer in `finally`. `activity-2d-recovery.tsx:37-38` already uses this pattern.

**2. A failed queue leave locks the avatar out of the queue, and no UI retries it.**
- `activity-queue.ts:144` refuses each enqueue while `pendingQueueLeaves` holds the avatar. Only a successful `leave-queue` call clears it.
- The lobby `handleLeaveQueue` (`activity-lobby-modal.tsx:1043-1054`) ignores the response and sets `idle`, so the user sees a false success.
- After that, the lobby calls leave only from the `queuing` phase (`:1059`). So the user's next queue click returns "retry leave first", and no control does that retry.
- The cleanup failure at `activity-queue.ts:210-213` belongs to a member who already left the party. `Activity2DRecovery` retries only while `/party/me` returns a party, so nothing retries this case. The pending entry stays until the pod restarts.
- **Fix, server:** At `:144`, replace the throw with `await this.leaveQueue(input.avatarId, 'voluntary')`. This retries the stored entry ID. Then run the checks at `:136-147` again. If the retry fails, the DB error propagates, which is an honest error.
- **Fix, client:** In `handleLeaveQueue`, check `res.ok`. On failure, keep `phase === 'queuing'` and show a toast.
- **Test:** Change the test at `activity-queue.test.ts:657` so the next enqueue retries the exact pending ID. Assert both outcomes: the retry succeeds, and the retry fails with a visible error.

**3. A party queue can be partly admitted, and a rejoin can return a false success.**
- Membership now stays visible while a departure is pending (`activity-queue.ts:499-514`). The leader is the first member in the Set. So `routes/activities.ts:322-333` enqueues the leader first, then the departing member throws (`:143`).
- The result: the leader gets a 400, but the leader's entry stays in the matcher. The leader can then get matched while the lobby shows an error. Before this correction, the window did not exist, because `leaveParty` deleted membership at once.
- `joinParty` (`:435`) returns `party` as a success while `pendingPartyLeaves` holds that member. The member then cannot queue, so the leader's next party queue fails again in the same way.
- **Fix:** Before the loop at `routes/activities.ts:320`, add a synchronous service check that every member is admissible. Return 409 if any member is not. If a later enqueue in the loop fails, call `leaveQueue` for each entry this request created, by its exact ID, then rethrow. In `joinParty`, before `:435`, throw if `pendingPartyLeaves.has(\`${party.id}:${avatarId}\`)`. Use the message "Party departure is still saving; retry leave".
- **Test:** A pending departure, then a leader party queue. Assert that no member stays queued and that the response is an error.

**4. Concurrent enqueue loses an entry ID, and a solo leave during the insert has no effect.**
- `:145` checks `avatarToEntry` before the insert await at `:197`. Two concurrent requests for the same avatar both pass. This happens with two tabs or a double party submit. `addToMemory` (`:864`) then keeps only the later ID. The earlier entry stays matchable, and `leaveQueue` cannot reach it.
- If a solo `leave-queue` arrives while the insert waits, `leaveQueue` returns `removed:false` (`:244`). Then `:215` publishes the entry, so the user is queued after their own leave. The membership fence covers only parties.
- **Fix:** Add `private inFlightEnqueues = new Map<string, { cancelled: boolean }>()`. At `:145`, refuse if the avatar is in the map, then add a token. Delete the token in `finally`. In `leaveQueue`, before `:244`, set `cancelled = true` on an in-flight token and return true. At `:210`, treat `token.cancelled` the same as `!partyAdmissionValid()`.
- **Tests:** Two concurrent enqueues: one fails and memory holds one entry. A solo leave during the insert: no entry is published, and the row gets `left_at`.

**5. A guest's assigned match is not routed to 3D.**
- `page.tsx:691` enables the recovery only for non-guest users. But guests can solo-queue in 3D (`activity-lobby-modal.tsx:1008-1016`). Switching to 2D reloads the page, and the queue entry stays.
- The matcher can match within about 6 s. Without the poll, the guest misses the room (no-show), which is the original B3 failure. `queue-status` uses the same `requireLedgerCapableIdentity` as `/queue`, so guests can read it.
- **Fix:** Split the gate. Run the assignment poll when `rendererMode === '2d' && !!avatar && authData !== undefined`. Keep the party leave only for non-guest users, for example `useParty(null, { enabled: enabled && partyEligible })`. Keep the `key={avatar?.id}` remount.

## Passes in the source
- **Lobby guards:** Create and join refuse 2D as their first statement (`activity-lobby-modal.tsx:924-931`). The party-to-queuing effect (`:949-955`) and the match navigation (`:958-969`) do not run in 2D. The test `world-renderer-mode.test.ts:46-59` runs the real handler bodies.
- **Recovery outside the modal:** `Activity2DRecovery` mounts in GamePage outside the modal's lifetime, keyed by avatar ID. It never queues and never creates a party.
- **Match routing:** The destination comes from the server room's `matchedActivityId` (`routes/activities.ts:431-437`). The fixed `bumper-shells` path only resolves the identity. The URL uses `view=3d`, and the query overrides session storage (`world-renderer-mode.ts:9`). Unsupported or malformed IDs give no destination and show an honest error.
- **Generation and cleanup:** The `stopped` flag, the abort on cleanup, and the generation checks in `use-party.ts:70,139,147,150` drop stale responses.
- **`leaveParty`:**
  - It keeps membership, the pending key and the version until both writes succeed. A retry reuses the exact pending queue ID (`:242-256`) and does not bump the version again.
  - The leave/rejoin version catches the ABA case during the insert (`:141`).
  - A leave during `createRoom` leaves the assigned room in place (test `:601-611`).
  - The matched room stays with the room manager.
- **Retry cap:** The 2D leave retry waits at least 5 s between tries (`activity-2d-recovery.tsx:26`).
- **Unchanged:** I found no change to wager or CT paths, auth middleware, free queue economics, solo matching, or the 3D defaults. Item 1 is the one exception.

## Non-blocking
- `partyDepartureVersions` (`:102`, `:496`) never shrinks. Delete its keys in `disbandParty`.
- **Crash limit:** `hydrateFromDb` (`:574-607`) brings back any row whose `left_at` write failed before a crash, including rows of departed party members. It does not reload parties. The 2D route to 3D limits the harm for users who have the poll. The handoff asks for a hydration failure test, but I found none for the pending state.
- The recovery toast (`:28`) repeats about every 5-10 s during a DB outage.
- **Test gaps:** The recovery test mocks React and `useParty`. It does not cover a failed leave and its retry, the throttle, timeouts, a stale generation, or a guest.
- I did not recheck the `ENTERING ACTIVITY…` mojibake from the earlier report.

## Still not run
- All tests and typechecks.
- A browser check with a 2D member and a 3D leader.
- An older Safari or iPad run for item 1.
- A staging check. I make no parity or staging claim.