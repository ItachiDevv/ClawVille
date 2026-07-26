# Full parity pack operations

Run the versioned pack from Git Bash:

```sh
bash scripts/parity/run-full-pack.sh
```

The pack derives row IDs from `SCENARIO_CATALOG`, resumes past persisted PASS
results, retries a non-PASS row at most three times, and stops retrying as soon
as the row runner exits 0. It resets staging guest shoes before each attempt,
checks the agent-browser daemon between rows, and retains the stable
`RUNS COMPLETE:` and `MATRIX-EXIT=` monitor lines.

`reset-guest-shoes.ts` is kept verbatim and resolves its `postgres` dependency
from `apps/api/node_modules`. On Windows the pack injects that directory through
a command-local `NODE_PATH` (converted with `cygpath -w` and prepended to any
existing value with `;`). A failed reset aborts before the row runs so the pack
never proceeds with a known dirty guest shoe.

At pack start, `pack-preflight.ts` performs these guarded operations through
page-context requests from the `9443` web origin:

- Verify the saved guest profile is authenticated and `isGuest=true`.
- Saved guest/live verification opens same-origin `/sw.js`, a static document
  that keeps page-context cookies and fetch available without identity-based
  app-route redirects. The state file is applied only to that session's first
  `agent-browser open`; later eval/wait requests attach without `--state`
  because replaying it resets the live session.
- Live and fixture row drivers use that same one-shot saved-state contract:
  `--state` seeds the first open only, and every later command attaches to the
  already-authenticated daemon session.
- If that anonymous guest session expired, open `9443/game` with no state,
  POST `/api/auth/guest`, verify the new guest identity, and save it to
  `scripts/parity/out/auth/guest-state.json`. No credentials are involved.
- Verify the live profile is authenticated and `isGuest=false`. A stale live
  profile refuses the pack because refreshing it requires orchestrator
  credentials.
- Read the live avatar balance and refuse below 500 vCLAW.
- Select and verify an open low-tier house table with seeded opponents and a
  free seat. This is required because landed cash-table code intentionally
  limits seeded opponents to `source='house'`; private/player tables cannot
  deal a solo harness hand. The chosen ID is persisted in ignored
  `out/pack-cash-table.json`.
- A legacy ignored state containing only `tableId` is recovered read-only from
  the staging DB only when that open private table belongs to the authenticated
  live avatar. The code is written to ignored state and never logged.
- A persisted non-playable private table is retired only when it is that
  avatar's table with zero seats, zero unsettled hands, and zero escrow.

The pack snapshots agent-browser process PIDs before preflight. Between rows it
only stops agent-browser-owned processes that are absent from that baseline
and older than three minutes. The keepalive baseline is never swept.

Manual guest-state recovery uses the same credential-free recipe when needed:
open `https://itachi222.tail06a01b.ts.net:9443/game` in a new agent-browser
session with no `--state`, perform a page-context POST to the absolute
`https://itachi222.tail06a01b.ts.net:9444/api/auth/guest` origin with
`credentials: 'include'`, verify `/api/auth/me` reports `isGuest=true`, then
run `agent-browser --session <session> state save
scripts/parity/out/auth/guest-state.json`. Do not pipe the `agent-browser open`
command; the running daemon owns its inherited browser handles.
