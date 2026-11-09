# Root review of 2D party recovery

Date:2026-11-09. Scope: B3a correction and queue persistence failures.
Verdict: source issue remains at the world-to-Office transition. Actual Claude review also runs independently.

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
