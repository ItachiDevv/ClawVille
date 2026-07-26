# Cove render-state parity harness

This directory implements the rev-4 parity seam without changing any game
publisher or mirror field. The browser hook is installed before first
navigation with `agent-browser open --init-script`, records request and response
bodies separately, and correlates them to a mirror root only through the
application-visible hand/coup/table identifiers.

Offline commands:

```sh
bun test scripts/parity/__tests__
bun scripts/parity/run-parity.ts --offline
bun scripts/parity/run-parity.ts --self-test
bun scripts/parity/run-parity.ts --emit-matrix
bun scripts/parity/atlas-fixture/contact-sheet.ts
bun scripts/parity/atlas-fixture/compare-atlas.ts
```

`--emit-matrix` intentionally exits non-zero until every required live row is
proven. Required `UNPROVEN` and `BLOCKED` rows fail the gate. On current HEAD,
the required blackjack/baccarat 2D rows are `BLOCKED` because those modals have
no landed parity publisher/root; this harness does not patch the frozen seam.

Hold’em ordered `hole -> flop -> turn -> river -> showdown` replay is asserted
on `holdem-tray-practice` only. Felt rows assert only full-board/opponent states
the felt actually renders.

The 53-cell contact sheet is not self-approving. A human records the exact PNG
SHA-256 in ignored `out/atlas/APPROVED.md`; absence or hash drift is an
`UNPROVEN` atlas visual gate.

Fixture tokens never leave the page context, are never included in screenshots,
and the capture hook recursively redacts token/secret fields. No credential,
fixture token, or authentication header is written to reports.
On a fixture-backed navigation the pre-navigation hook holds the first
shoe/session/sit seed arm in memory. The runner issues the fixture against the
absolute `apiBase`, releases that queued request with the raw header, and never
writes the header to local/session storage, a state file, or disk. All direct
harness requests use the configured absolute API origin with credentials.
Before every fixture-backed owner row, the neutral `/cove` page performs a
no-resource provisional issue/delete handshake. Organic live rows use their
game-specific preflight/reconciliation without depending on fixture schema.
A `fixture_recovery_required` response is reconciled in the same page closure:
blackjack stands each active slot and closes its shoe, practice folds and
closes, and cash uses the isolated table's Walk Away flow and proves the owner
seat absent. Only then may the stale run be deleted and the requested issue be
retried once. Failure to prove any cleanup leaves the target seed arm gated.
Neither the rotated recovery token nor the replacement token crosses into Bun.

Live rows load the dedicated non-guest harness profile from
`CV_PARITY_AUTH_STATE`. Fixture-backed guest rows instead require a second,
dedicated `users.is_guest=true` Lucia profile from
`CV_PARITY_GUEST_AUTH_STATE`; this exercises the guest cove subject while still
letting the fixture issuer bind the run to that guest avatar. Never reuse the
live profile for these rows. Both state files are ignored credentials and must
retain their browser storage/profile so the raw `X-CV-Fingerprint` remains
stable across the run; neither their paths nor their contents are emitted.
Natural anonymous guest rows use no saved state. Live Hold'em additionally
requires `CV_PARITY_CASH_TABLE_ID` so preflight can open and reconcile the exact
seat rather than guessing.
