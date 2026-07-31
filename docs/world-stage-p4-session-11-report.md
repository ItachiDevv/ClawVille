# World Stage P4 — Session 11 merge reconciliation report

## Outcome

The in-progress merge of `origin/staging` (`d738a2e5`) into
`feat/world-stage-p4-activities` was reconciled without aborting or squashing.
Staging's dark world-presence WS uplink is retained, and P4's frozen downlink
semantics now live in the staging `WorldPresenceController` architecture.

## Reconciliation summary

- The thin `useWorldStream` hook delegates to `WorldPresenceController` while
  retaining the P4 downlink-enabled control.
- SSE lifecycle decisions use the unchanged pure downlink policy. Pending
  reopen, epoch invalidation, retry-token ownership, bounded recovery joins,
  lease-CAS settlement, land invalidation, and bfcache membership reset are
  preserved.
- Exact activity routes close SSE while remote `at-activity` uplink poses
  continue; Kelp behavior is preserved.
- The probe supports both activity/canonicalizer lanes and WS-uplink
  instrumentation. All named completion lanes parse and pass.
- The requested API, shared-package, route, registry, environment, architecture,
  deployment-status, and persistent-world auto-merges were audited. Both
  parents' wiring survived; no corrective auto-merge patch was required.
- Existing assertions were not weakened. Focused controller coverage was added,
  and staging-required machine inputs/structural ownership references were
  updated without changing frozen behavior.

## Verification

| Verification | Result |
| --- | --- |
| Workspace typecheck | PASS — 12/12 |
| API and web production builds | PASS |
| P4 constituent suites | PASS — 287/287, including 64 downlink and 81 overlay |
| Controller/machine/API WS suites | PASS — 112/112 |
| Session 9/10 money suites | PASS — 139/139 |
| Hectic / Current Swap | PASS — 10/10, 57,480 assertions |
| Cove/Kelp/activity route and exit probes | PASS |
| Dedicated WS transport probe | PASS |
| Local WS smoke | PASS — 12 pass, 4 optional skip, 0 fail |

The required dark/default Kelp lane stayed inside its heap gate at +14.71%.
All decisive activity downlink assertions passed. The Cove legacy canonical
projection retains the accepted pre-merge P4 hash
`A5B79D4742800A6BAEEAD5337F237F09811724B0D1E588AF95F5BE52C9C02B8B`;
the current summary adds six true WS assertions. The older checked-in P3 raw
artifact's previously documented fixture-bookkeeping difference remains
untouched.

No push was performed and `bun run dev` was never used. Full dispositions and
gate evidence are recorded in `docs/world-stage-p4-notes.md` under
“Session 11 — staging merge reconciliation.”
