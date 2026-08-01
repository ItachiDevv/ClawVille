VERDICT: **REJECT — RUNG-1 CANARY MAY NOT START under this paired gate.** The order-statistic is correct, but the CLI can exit 0 without eight distinct counterbalanced pairs for the declared backend, missing longtask evidence can still be laundered to valid, and the plan's outer sanity bounds are not enforced.

## Delta table

| Re-review #3 finding | Status | Code/evidence judgment |
|---|---|---|
| Delta 1 — class-independent redirect legs | **RESOLVED** | Every network `isRedirectLeg` is checked as 3xx before asset-class filtering (`cold-load-probe.mjs:240-249`); extensionless and missing/non-3xx fixtures cover it (`cold-load-probe.test.ts:91-113`). |
| Delta 2 — failed finite JSON | **RESOLVED** | Unchanged fail-closed asset-failure/partial-byte path remains covered (`cold-load-probe.mjs:238-239`; test `:142-156`). |
| Delta 3 — falsy backend waiver | **RESOLVED** | Both page extraction sites preserve present `''`/`false`, final ingestion uses `parsed.be === undefined`, and waiver requires `backend == null` (`cold-load-probe.mjs:397,414,422,230-233`). |
| Blocking 1 — paired gate | **PARTIAL** | `medianUpperBoundIndex` is correct: n=8 gives k=7 because `P(Bin(8,.5)≤6)=247/256`; ratio null/undefined becomes non-finite and fails; the count bound correctly accepts a tied 7th statistic at +2 (`cold-load-paired-gate.mjs:41-57,91-99,113-120`). CLI/sample enforcement and count disposition remain defective below. |
| Blocking 2 — evidence completeness | **PARTIAL** | Finite reveal/frame projections and quiescence now gate the summary and reasons are carried (`cold-load-probe.mjs:274-286,448-471`). But `parsed.lt || []` launders a missing/null series to length 0, which is finite and complete (`:416,452`); the paired CLI trusts only `.summary` (`cold-load-paired-gate.mjs:145-146`). |
| Major 3 — recomputable longtasks | **PARTIAL** | Full longtasks are now persisted (`cold-load-probe.mjs:499`), but the checker never reads/recomputes them; a stale or forged summary remains authoritative. |
| Minor 4 — provenance | **RESOLVED** | Ledger source is basename-only (`cold-load-ledger.mjs:191-194`), committed source is `report-g-staging-g1-a1.json`, and plan `:304-310` identifies g artifacts plus `bb00fbd5` / `9bb12da2`. |

## New findings

1. **[BLOCKING] The CLI does not enforce “8 complete pairs/backend.”** `manifest.backend` is never read; unknown orders are omitted from both counters; paths/report identities may repeat; baseline and candidate may be the same file (`cold-load-paired-gate.mjs:75,82-85,142-149`). Reproduction: one WebGPU report reused for all 16 arms, manifest backend `webgl2`, eight orders `XX` => **PASS, exit 0**. **Fix:** schema-validate backend and `AB|BA`; require `ab+ba===usable.length`; match both reports' actual/expected backend; require distinct run IDs/files and distinct A/B arms; persist and verify baseline/candidate build IDs and pair/order timestamps; resolve normalized paths relative to the manifest and reject duplicates.

2. **[BLOCKING] The gate is not numerically/absolutely fail-closed.** `null-null` count subtraction coerces to 0 and passes, while only derived ratios get a non-finite guard (`:91-95,113-120`). Also, equal A/B runs far beyond every §2b outer sanity ceiling pass because the script implements no backend ceilings (`plan:340-349`). **Fix:** validate raw values as finite numbers in their legal domains before arithmetic, recompute projections from raw evidence, and enforce every candidate sanity bound per backend before paired statistics.

3. **[BLOCKING] Missing longtask evidence can still enter a pair.** Extraction converts absent/null `lt` to `[]`; completeness receives only `longtasks.length`, so absence is indistinguishable from a legitimately captured empty array; the gate then consumes the self-stamped summary. **Fix:** preserve an absent-series sentinel, require `Array.isArray(longtasks)` with finite `{s,d}` entries, recompute `preRevealTotalMs`, and have CLI reject any mismatch/missing raw series. Add missing/null, valid-empty, malformed-entry, and summary/raw-mismatch tests.

4. **[MAJOR] Frame-count uses the wrong extend/fail rule.** At n=8 an upper bound of +3 returns `fail` immediately, while ratio metrics and §2b require inconclusive below 12 (`cold-load-paired-gate.mjs:100-109` versus `:118-120`; plan `:338-339`). **Fix:** apply the same `<12 => inconclusive; ≥12 => fail` disposition to the count bound. The inclusive +2 tie rule itself is correct.

## Cleared scope

Cleared: redirect-leg status closure, failed-JSON accounting, falsy backend preservation, portable provenance, full-series persistence, the fixed-n order-statistic math, ratio non-finite rejection, inclusive count ties, and `54 pass / 0 fail`. Not cleared: paired manifest/backend/sample identity, raw-evidence recomputation, outer sanity enforcement, or the count extension contract. The one-location GLB §3A seam has no new delta defect, but it may not start while its sole judging gate can false-pass. Existing VRM/later-rung gates remain.
