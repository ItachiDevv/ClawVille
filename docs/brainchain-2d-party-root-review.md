# Root review of 2D party recovery

Date:2026-11-09. Scope: B3a correction and queue persistence failures.
Original verdict: R1 blocked the world-to-Office transition. The correction review below supersedes that source finding.

## Independent checks

Root reran apps/api/src/services/activity/__tests__/activity-queue.test.ts.
Result:33tests passed,77assertions,0failures.
These tests use a mocked database. They prove queue state transitions under the supplied failures, not PostgreSQL durability or staging parity.
The tests cover departed membership during insertion, leave/rejoin, failed cleanup retry, and a match selected before departure.

Source now retains exact pending queue entry IDs after database failure.
The same pending entry blocks another admission until cleanup succeeds.
removeFromMemory only deletes the avatar lookup when its ID matches the old entry.
Party departure remains visible for retry until queue and membership persistence succeed.
An assigned room remains authoritative after a concurrent departure.

## R1: recovery lifetime ends when the player enters Office

GamePage mounts Activity2DRecovery at apps/web/src/app/(world)/game/page.tsx.
The shared world layout preserves WorldStageRoot while its children change to the BrainChain Office page.
The recovery component's cleanup aborts its status request and stops its timer when GamePage unmounts.

A departure can remain pending after a database error, or a room can finish creation after the player enters Office.
At that point, the2D canvas remains, but this recovery component no longer observes the pending party or assigned match.
This leaves the original no-show risk on the Office transition.
This is a source-derived finding; root has not reproduced it in the browser.

The lead's earlier GamePage-only placement guidance was too narrow for the shared world lifecycle.
Retain the identity-bound recovery controller across relevant persistent world/service routes, or prevent departure until recovery resolves.
Preserve guest isolation, one controller, bounded requests, exact authorized room destination and cancellation on identity change.
Do not introduce polling on unrelated application pages.

Required regression: keep a leave request pending, enter Office, then return an authorized room assignment and verify3D recovery.
Also verify that logout or avatar change prevents the old identity's late response from navigating.
The next build and browser checks must include this transition.

## R1 correction review

Root reviewed the frozen correction on2026-11-09.
WorldPresence now retains Activity2DRecovery across game and Office routes.
The controller binds current auth-me and avatar cache identities plus a reset generation.
Logout, avatar changes and same-user session resets reject late assignment responses.
Unrelated routes unmount recovery. Guest assignment reads remain separate from party operations.
Root read the actual route middleware: human identities pass requireLedgerCapableIdentity; bound agents still require ledger capability.
No authorization middleware changed for this correction.

Root independently reran the frozen suites on itachi222:
- queue tests:41passed,104assertions,0failures;
- mounted React recovery:8passed,20assertions,0failures.

The mounted test retains a pending party departure across Office navigation and follows the exact authorized room URL.
Other tests cover departure retry, guest assignment, stalled requests and stale identities.
The queue suite covers synchronous admission reservation, whole-party transaction publication, cancellation during commit and exact cleanup retry.
Its transaction model explicitly retains the whole committed batch when commit response and cleanup both fail.
These tests do not prove PostgreSQL transport failure behavior or authenticated browser behavior.

R1 has scoped source and mounted-test approval. Final browser evidence remains required.
Actual-Claude review of its five source blockers remains separate and pending.

## R2: kicked-member admission survives rejoin

Root reproduced this issue against the frozen correction on itachi222.
Start a member queue admission and hold its insert response.
Kick that member, rejoin the same party, then release the old insert.
The old admission succeeds. The test expected refusal and failed.

kickMember removes membership without advancing the departure version or cancelling the admission token.
Rejoin restores the same party membership before valid() executes again.
The old queue request therefore passes its membership and version checks.
Use the same departure fence for kick, and retain the regression in the canonical queue suite.
This blocks source approval for the combined party correction; R1 approval remains scoped to controller lifetime.

Evidence: .brainchain-work/activity-queue-root-aba-original-layout.test.ts preserves the full probe with original relative imports.
Run it from the activity __tests__ directory with --test-name-pattern 'ROOT R2'.
Root removed its temporary duplicate test after reproduction; the owner owns the canonical regression.
The earlier relocated probe failed module mocks before executing; only the original-layout run establishes R2.

## R2 correction evidence

The owner added the departure-version fence before kick removes membership.
The existing prune helper retains that version until the old admission finishes.
Root read the correction and reran the canonical targeted regression plus the existing rejoin test:2passed,6assertions,0failures.
Owner reports the full queue suite42passed,106assertions.
No await or assigned-room mutation was added. Root approves this narrow source correction; actual-Claude R2 re-review and browser evidence remain pending.
