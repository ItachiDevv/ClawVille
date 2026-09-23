# Read-only PostgreSQL protocol reproduction

Last Audited: 2026-09-23. Owner: dd-cleanup database investigator; coordinator owns live acceptance.

The staging driver stopped before cognition while PostgreSQL reported an active decision SELECT waiting on ClientRead. Source inspection found a zero-parameter halt SELECT beside parameterized decision SELECTs in `readAutonomousTradingTargets`. Drizzle calls postgres.js `unsafe(query, params).values()`. In installed postgres.js 3.4.9, an empty parameter array selects simple protocol; parameters select extended protocol. `values()` changes result shape only. The shared client uses `prepare: false` and the default `max_pipeline: 100`.

The coordinator reproduced the transport difference on staging Bun 1.4.2, postgres.js 3.4.9, transaction-pooler port 6543. A fresh max-one client with mixed simple/extended SELECT constants timed out at nine seconds after one result and zero completed pairs. The parameter-only case passed 200 queries across 100 pairs in 1,457 ms. This reproduces the protocol interaction without application tables or writes. It does not prove every earlier timeout had this cause. A similar report exists in [postgres.js issue 1033](https://github.com/porsager/postgres/issues/1033), using version 3.4.5.

The bounded product repair adds the existing fleet/avatar scope predicate to the active halt query. SQL now selects `cleared_at IS NULL AND (scope = $1 OR scope_id = $2)`. This supplies meaningful parameters and preserves the existing result-selection semantics. Fleet halts and the current avatar's halt still suppress allowed mints. Other avatars and cleared rows do not enter the SQL result. No pool settings, runtime versions, halt authority, or settlement behavior change.

The real Drizzle adapter regression failed before the patch because one concurrent SELECT had zero parameters. It passes after the patch. Transport is replaced by a local stub in that test; the separate staging reproduction supplies real transport evidence. The live hosted probe remains required after deployment.

## Safe reproduction

Use an authorized staging API container. Keep its existing DATABASE_URL private. Set the working directory to `/app/apps/api`. The script requires `CLAWVILLE_ENV=staging` and uses a fresh max-one client. Run each case in a separate process:

```sh
bun scripts/agent-connect/postgres-protocol-mix-probe.ts mixed-default
bun scripts/agent-connect/postgres-protocol-mix-probe.ts parameter-default
bun scripts/agent-connect/postgres-protocol-mix-probe.ts mixed-one
bun scripts/agent-connect/postgres-protocol-mix-probe.ts mixed-zero
```

Each case has a nine-second diagnostic deadline and a twelve-second hard process limit. The script closes only its own client. All queries select constants; it does not read application tables or mutate data. Output includes case, counts, elapsed time, runtime/client versions, and numeric port. It excludes credentials, identities, SQL text, values, rows, and raw errors. `max_pipeline: 1` still permits an active query plus one queued query in this client version; zero is the strict serial control. Do not infer a global production pool change from these diagnostic controls.

PARITY: the shared agent desk retains the same fleet/avatar halt contract. Owner directives and human halt controls keep their existing authority.
