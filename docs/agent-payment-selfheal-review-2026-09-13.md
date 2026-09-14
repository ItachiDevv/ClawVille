# Agent-payment self-healing review — 2026-09-13

Host: itachi222. Branch: feat/agent-pay-selfheal. All changes remain uncommitted.
The migration remains unapplied. No live payment, RPC recovery pass, staging deployment, or production deployment occurred.

## Work items

- W1 PARTIAL: safe no-money rearm and all requested guards/tests are implemented. The existing daily-cap query conflicts with the requested cap behavior.
- W2 DONE: durable alert state replaces the Map. Default re-alert interval is 24 hours, with a one-hour floor.
- W3 DONE: default-on resolver, observed-signature exclusion, matching index, and guarded verdict annotation are implemented.
- W4 DONE: read-only admin endpoint and minimal dashboard tab are implemented. Bounty IDs use text because no web detail route exists.

DONE describes the local implementation and verification scope. It does not claim deployment or user visual approval.

## Files changed

| File | Purpose |
| --- | --- |
| `apps/api/src/services/bounty-tier1.ts` | Safe retry proof, durable wedge stamps, shared read-only state query and frozen-hold classification. |
| `apps/api/src/services/__tests__/bounty-tier1.test.ts` | Retry, CAS, alert timing, delivery rejection, and frozen-hold tests. |
| `packages/database/src/schema/bounty-usdc-holds.ts` | Durable alert timestamp and counter. |
| `packages/database/migrations/0062_agent_payment_selfheal.sql` | Idempotent alert columns and observed-signature partial index. |
| `packages/database/src/schema/agent-payments.ts` | Matching observed-signature partial index. |
| `apps/api/src/services/x402-auto-reconcile.ts` | Default-on resolver and non-fatal verdict stamps after each auto pass. |
| `apps/api/src/services/x402-bulk-reconcile.ts` | Shared auto consent resolver; operator consent stays unchanged. |
| `apps/api/src/services/x402-reconcile.ts` | Observed-signature exclusion, guarded metadata merge, and bounty hold reference. |
| `apps/api/src/services/agent-pay-resume.ts` | Shared auto enabled resolver for alert ownership. |
| `apps/api/src/services/__tests__/x402-auto-reconcile.test.ts` | Default-on, explicit-off, annotation, and stamp-failure tests. |
| `apps/api/src/services/__tests__/x402-reconcile-apply.test.ts` | Observed-signature and metadata SQL tests. |
| `apps/api/src/services/__tests__/bulk-reconcile.test.ts` | Auto consent and operator double-consent regression test. |
| `apps/api/src/services/__tests__/agent-pay-resume.test.ts` | Explicit-off fixture and default-on alert ownership coverage. |
| `apps/api/src/routes/dashboard.ts` | Admin-only DB-read endpoint and narrow response projection. |
| `apps/api/src/routes/__tests__/dashboard-reconcile.test.ts` | Projection, admin access, cache headers, and malformed metadata tests. |
| `apps/web/src/app/dash/page.tsx` | Reconcile tab navigation. |
| `apps/web/src/app/dash/tabs/reconcile.tsx` | Payment and frozen-hold tables with internal horizontal scroll. |
| `.env.example` | Default-on reconcile and durable alert interval documentation. |
| `ARCHITECTURE.md` | Environment reference, audit note, dashboard note, and PARITY statement. |
| `docs/agent-payment-selfheal-review-2026-09-13.md` | Full verification output, scope conflict, and review record. |

The pre-existing untracked AGENTS.md and CLAUDE.md files remain untouched.

## Deviations and unresolved requirement

The unchanged agent-pay.ts daily-cap status list excludes every failed row.
The aggregate applies that list at agent-pay.ts:418.
Therefore, reconcile_no_money failures do not count toward daily caps in the baseline.
This diff does not set capExempt or change that query.
The requested rearm behavior is implemented, but the requested continued cap counting remains unresolved.
The user received a scope question with two options: preserve the query or add a narrow reconcile_no_money exception.
The report retains the existing query while that choice remains unanswered.

- [x] RESOLVED 2026-09-13 by the orchestrating session: preserve the query. The spec sentence rested on a false premise: `COUNTED_DAILY_CAP_STATUSES` never included `failed`, so no failed row ever counted toward daily caps in the baseline. A `reconcile_no_money` row therefore drops out of cap accounting exactly like every failed row always has, and each rearm attempt is a fresh row that counts normally while pending/settling/settled. No code change is required.

Prepare had no transaction injection point. Its new optional dependency permits tests of the actual transaction body.
Production still takes the poster lock and uses the same state query, validation, archive CAS, and generation CAS.

The actual x402 test names differ from the supplied examples.
Verification uses x402-reconcile-apply.test.ts, reconcile-checkouts.test.ts, and bulk-reconcile.test.ts.

The optional web table shows bounty IDs as text. No supported bounty detail route exists.
The web proof uses the actual async server component, fixture data, and project Tailwind in a standalone shell.
It does not verify the full Next app, live data, or a physical iPad.

## Existing issues left unchanged

The shared Telegram helper absorbs missing-credential, HTTP, and transport failures.
Thus, the durable stamp proves alert-function resolution, not confirmed Telegram receipt.
The injected rejection test proves that a rejected alert promise prevents the stamp.

The auto-reconcile summary fingerprint remains process-local.
The existing dashboard also contains an obsolete npm-sideload statement.
These files or behaviors remain outside this recovery change.

## Review and visual evidence

The independent adversarial audit approved the implemented recovery delta.
It found no executable defect, but it withheld full-specification approval because of the daily-cap conflict.
Capture/fulfillment, complete-window matching, grace rules, and operator double consent remain unchanged.

The fixture checks cover 390x844, 844x390, 744x1133, 1133x744, 820x1180, 1180x820, 1024x1366, and 1366x1024.
Every document width equals its viewport width. Both tables scroll internally where required.
Root inspected the phone and iPad landscape PNGs.
Local evidence on itachi222: C:/Users/itachi/AppData/Local/Temp/cv-selfheal-dashboard-proof/.
That directory contains eight PNGs and viewport-proof.json.
The temporary fixture server and headless browser are stopped.

## Verification setup

bun install --frozen-lockfile installed dependencies without a lockfile change.
bunx turbo run build --filter=@clawville/api^... built all five API dependency packages.
Initial checks exposed missing dependencies and new test fixture type errors. The final checks below pass.
The deliberate alert-rejection test prints an error; that test passes.

## Full final test and typecheck output

Working directory: apps/api

```text
> bun test src/services/__tests__/bounty-tier1.test.ts
bun test v1.3.14 (0d9b296a)

src\services\__tests__\bounty-tier1.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ◈ encrypted .env [www.dotenvx.com]
(pass) Tier-1 bounty rail and cap > defaults to $50 and floors an unsafe env override at $1 [0.13ms]
(pass) Tier-1 approval settlement > uses the deterministic key, count-only exemption, and books only confirmed payment [0.34ms]
(pass) Tier-1 approval settlement > keeps booking untouched on settle failure so the open hold remains retryable [0.11ms]
(pass) Tier-1 approval settlement > propagates an idempotent payment or booking replay [0.10ms]
(pass) poster-scoped USDC spend admission > ordinary sends reserve every open hold plus pending/settling liabilities [0.53ms]
(pass) poster-scoped USDC spend admission > settlement consumes exactly its own hold while every other dollar stays reserved [0.13ms]
(pass) poster-scoped USDC spend admission > blocks on an ambiguous agent-payment liability until operator resolution removes it [0.22ms]
(pass) poster-scoped USDC spend admission > blocks on an ambiguous withdrawal liability until its terminal resolution [0.15ms]
(pass) Tier-1 approve/expiry race > expiry wins first: completed expiry makes approval refuse [0.77ms]
(pass) Tier-1 approve/expiry race > approval wins first: approved-attempt reassertion makes expiry refuse [0.13ms]
(pass) Tier-1 cancel/approve race > cancel wins first: locked terminal CAS makes approval lose and permits release [0.35ms]
(pass) Tier-1 cancel/approve race > approval wins first: locked cancellation CAS refuses and the hold stays open [0.12ms]
(pass) Tier-1 bounded definitive settlement retry > rearms only a proven no-broadcast failure with the next attempt-scoped key [0.08ms]
(pass) Tier-1 bounded definitive settlement retry > freezes reconcile on its original key and never proposes another key [0.02ms]
(pass) Tier-1 bounded definitive settlement retry > stops after five total attempts and requires manual action [0.03ms]
(pass) Tier-1 bounded definitive settlement retry > resume drives the prepared retry generation and books a successful retry [0.47ms]
(pass) Tier-1 bounded definitive settlement retry > resume never calls settle for ambiguous or exhausted attempts and pages ops [0.19ms]
(pass) Tier-1 durable hold contracts > ships an idempotent additive hold table and count-only agent-pay column [0.03ms]
(pass) Tier-1 durable hold contracts > uses one poster spend lock and one admission function on every USDC path [0.11ms]
(pass) Tier-1 durable hold contracts > posts the hold in the bounty transaction and uses row-count CAS terminal writes [0.09ms]
(pass) Tier-1 durable hold contracts > fails closed on historical USDC rows before every work-lifecycle mutation [0.27ms]
(pass) Tier-1 durable hold contracts > keeps Tier-1 expiry in its own off-chain sweeper [0.05ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > rearms chain-proven no-money without changing cap exemptions and preserves archive guards [1.83ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with txSignature at plan and prepare levels [0.20ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with reconcileTxSignature at plan and prepare levels [0.06ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with settlePayer at plan and prepare levels [0.08ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes plain failed rows without either proof at plan and prepare levels [0.19ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > does not advance after archive CAS loss and throws after generation CAS loss [0.33ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > ops classification reports frozen and exhausted holds and omits drivable rearm [0.40ms]
(pass) Tier-1 durable wedge alert delivery > defaults to 24 hours and floors overrides at one hour [0.05ms]
(pass) Tier-1 durable wedge alert delivery > frozen: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.55ms]
(pass) Tier-1 durable wedge alert delivery > exhausted: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.13ms]
(pass) Tier-1 durable wedge alert delivery > settle-failed: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.16ms]
[bounty-tier1] settlement resume failed for 11111111-1111-4111-8111-111111111111: 752 |     await didEnter;
753 |     expect(stamps).toBe(0);
754 |     release();
755 |     await run;
756 |     expect(stamps).toBe(1);
757 |     await resumeTier1BountySettlements(1, { ...deps, alert: async () => { throw new Error('test delivery rejected'); } });
                                                                                          ^
error: test delivery rejected
      at alert (C:\Users\itachi\Documents\Crypto\cv-selfheal\apps\api\src\services\__tests__\bounty-tier1.test.ts:757:85)
      at resumeTier1BountySettlements (C:\Users\itachi\Documents\Crypto\cv-selfheal\apps\api\src\services\bounty-tier1.ts:713:17)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-selfheal\apps\api\src\services\__tests__\bounty-tier1.test.ts:757:11)

(pass) Tier-1 durable wedge alert delivery > does not stamp before delivery resolves or when delivery throws [1.09ms]

 34 pass
 0 fail
 150 expect() calls
Ran 34 tests across 1 file. [521.00ms]
Exit code: 0
```

Working directory: apps/api

```text
> bun test src/services/__tests__/x402-auto-reconcile.test.ts src/services/__tests__/x402-reconcile-apply.test.ts src/services/__tests__/reconcile-checkouts.test.ts src/services/__tests__/bulk-reconcile.test.ts
bun test v1.3.14 (0d9b296a)

src\services\__tests__\bulk-reconcile.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ⌘ enable debugging { debug: true }
[AutonomyStandby] active -> active (reason: default)
(pass) x402 bulk outage reconciliation > allows default-on auto consent while preserving operator double consent [1.75ms]
(pass) x402 bulk outage reconciliation > matches one exact transfer and leaves an unmatched young row waiting [14.53ms]
(pass) x402 bulk outage reconciliation > uses the reconcile update anchor when settling_started_at was cleared [1.09ms]
(pass) x402 bulk outage reconciliation > puts one-row/two-transfer ambiguity in MANUAL and never guesses [1.92ms]
(pass) x402 bulk outage reconciliation > pairs equal overlapping components strictly in chronological order [2.45ms]
(pass) x402 bulk outage reconciliation > applies verified capture once and a rerun captures nothing [1.40ms]
(pass) x402 bulk outage reconciliation > closes an unmatched old row only after a complete window [1.00ms]
(pass) x402 bulk outage reconciliation > never closes no-money when the signature cap exhausts before the boundary [0.94ms]
(pass) x402 bulk outage reconciliation > backs off and retries an RPC 429 while paging the target once [1.35ms]
(pass) x402 bulk outage reconciliation > enforces the row cap and derives bounds from selected rows plus margins [1.35ms]
(pass) x402 bulk outage reconciliation > requires double consent for CLI apply and parses operational bounds [0.38ms]

src\services\__tests__\reconcile-checkouts.test.ts:
(pass) reconcile classifier > capture_lost + signature ⇒ verify_signature / capture_fulfill (money is ours) [1.12ms]
(pass) reconcile classifier > signature_conflict + signature ⇒ verify_signature / refund_required (contested) [0.03ms]
(pass) reconcile classifier > settle_ambiguous ⇒ probe_merchant with the ¢-peg atomic amount + payer + window [0.04ms]
(pass) reconcile classifier > stale_settling ⇒ probe_merchant; falls back to createdAt when no settlingStartedAt [0.06ms]
(pass) reconcile classifier > a signature-carrying reason WITHOUT a signature ⇒ manual_review [0.03ms]
(pass) reconcile classifier > an unrecognized reason ⇒ manual_review [0.03ms]
(pass) reconcile apply gate > assertNoReconcileApply is a no-op while unset/false [0.08ms]
(pass) reconcile apply gate > assertNoReconcileApply no longer rejects env enablement; explicit caller consent is separate [0.03ms]

src\services\__tests__\x402-auto-reconcile.test.ts:
(pass) x402 recurring auto-reconcile > does not touch the sweep or stores when explicitly disabled [0.52ms]
(pass) x402 recurring auto-reconcile > annotates every swept verdict after auto apply and continues after a failed stamp [0.87ms]
(pass) x402 recurring auto-reconcile > is default-on and applies interval floor plus bounded row cap [0.16ms]
(pass) x402 recurring auto-reconcile > runs the shared sweep in auto-apply mode under the advisory lock [0.51ms]
(pass) x402 recurring auto-reconcile > does not alert on quiet ticks and deduplicates an unchanged manual set [0.31ms]
(pass) x402 recurring auto-reconcile > alerts an indeterminate row only after it survives 24 hours [0.31ms]
(pass) x402 recurring auto-reconcile > skips cleanly when another replica owns the advisory lock [0.17ms]

src\services\__tests__\x402-reconcile-apply.test.ts:
(pass) reconcile durable observation stores > excludes a signature observed only in another agent payment reconcile column [1.76ms]
(pass) reconcile durable observation stores > merges verdict metadata under the reconcile status guard without changing anchors [0.89ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_capture_fulfill","detail":"verified signature captured; settle-machine fulfillment invoked","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > captures a verified checkout and invokes its own fulfiller exactly once; second scan is a no-op [1.36ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_refund_required","detail":"durable refund-required evidence recorded; no refund sent","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > turns a capture signature conflict into durable refund-required and never fulfills [0.39ms]
[reconcile] ct_topups ct_topups-1 reason=signature_conflict → verify_signature (refund_required, sig=verified-signature) — signature owned by another checkout; contested → refund-required-with-signature
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"ct_topups-1","action":"applied_refund_required","detail":"durable refund-required evidence recorded; no refund sent","signature":"verified-signature"}
[reconcile] ct_topups ct_topups-1 reason=signature_conflict → manual_review — refund already durably required; awaiting operator executor
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"ct_topups-1","action":"manual_review","detail":"refund already durably required; awaiting operator executor","signature":null}
(pass) x402 reconcile apply orchestration > records an explicit refund-required recommendation once; repeat is manual with no second alert [0.24ms]
[reconcile] ct_topups old reason=stale_settling → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-11T00:01:00.000Z) — stale_settling: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"old","action":"applied_no_money","detail":"no payment found after grace; reconcile→failed","signature":null}
[reconcile] ct_topups young reason=stale_settling → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-13T11:30:00.000Z) — stale_settling: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"young","action":"skipped","detail":"no match, but row remains inside no-money grace window","signature":null}
(pass) x402 reconcile apply orchestration > fails an old no-money row but leaves a younger row untouched [0.42ms]
(pass) x402 reconcile apply orchestration > defaults blank, unset, and non-numeric no-money grace to 24h; explicit numbers retain the 1h floor [0.08ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
(pass) x402 reconcile apply orchestration > does not mutate or fulfill when the capture CAS is lost [0.17ms]
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"capture CAS lost","signature":"verified-signature"}
[reconcile] agent_payments agent_payments-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"agent_payments","rowId":"agent_payments-1","action":"applied_capture_fulfill","detail":"verified signature captured; settle-machine fulfillment invoked","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > captures and fulfills agent_payments using recipientWallet and metadata.network fallback [0.23ms]
(pass) x402 reconcile apply orchestration > F6 restores exact Meridian fee columns from durable reconcile evidence before fulfillment [0.29ms]
(pass) x402 reconcile apply orchestration > F6 refuses to infer Meridian when durable reconcile accounting is incomplete or non-conserving [0.13ms]
(pass) x402 reconcile apply orchestration > normalizes observed agent reconcile signatures to capture_lost and unknown no-signature failures to ambiguous [0.04ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
(pass) x402 reconcile apply orchestration > defaults to dry-run even when env consent is present and performs no chain/apply calls [0.14ms]
[reconcile] scanned 1 reconcile row(s) across x402_checkouts + ct_topups + agent_payments (DRY-RUN — no state changed)
[reconcile] x402_checkouts x402_checkouts-1 reason=settle_ambiguous → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-11T00:01:00.000Z) — settle_ambiguous: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"probe indeterminate: lookback_cap_exhausted","signature":null}
(pass) x402 reconcile apply orchestration > treats a capped/indeterminate probe as skipped, never no-money [0.18ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_capture_pending","detail":"signature captured; settle-machine fulfillment returned non-success and remains resumable","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > keeps a captured row resumable when its native fulfiller returns non-success [0.18ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"fail-soft: config unavailable","signature":null}
(pass) x402 reconcile apply orchestration > fails soft per row when config resolution throws [0.39ms]
(pass) x402 reconcile apply orchestration > requires explicit apply plus env consent and validates CLI row selectors [0.48ms]

 43 pass
 0 fail
 175 expect() calls
Ran 43 tests across 4 files. [894.00ms]
Exit code: 0
```

Working directory: apps/api

```text
> bun test src/services/__tests__/agent-pay-resume.test.ts
bun test v1.3.14 (0d9b296a)

src\services\__tests__\agent-pay-resume.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ◈ encrypted .env [www.dotenvx.com]
[AutonomyStandby] active -> active (reason: default)
(pass) agent-pay resume worker > fulfills a landed captured payment exactly once across two ticks [1.96ms]
(pass) agent-pay resume worker > moves a stale captured on-chain error to reconcile without minting [0.93ms]
(pass) agent-pay resume worker > moves a stale payment with no captured signature to reconcile [9.67ms]
(pass) agent-pay resume worker > lets auto-reconcile own fresh stale alerts while preserving the >24h survivor alert [0.27ms]
(pass) agent-pay resume worker > re-asserts the expected signature at the reconcile mutation boundary [0.19ms]
(pass) agent-pay resume worker > uses strict 120-second candidate and stale-threshold boundaries [0.20ms]
(pass) agent-pay resume worker > treats a stale missing or metadata-less transaction as stale_settling [0.23ms]
(pass) agent-pay resume worker > survives one row throwing and continues to the next row [0.38ms]
(pass) agent-pay resume worker > expires dead pending rows before counting and only pages signed survivors [0.35ms]
(pass) agent-pay resume worker > keeps Tier-1 settlement payments retryable past the generic pending expiry [0.19ms]
(pass) agent-pay resume worker > continues to count and alert survivors when pending expiry throws [0.24ms]
(pass) agent-pay resume worker > pages a steady stale-pending backlog once, re-paging only when the count changes [0.18ms]
(pass) agent-pay resume worker > always resolves when both DB scans throw [0.22ms]
(pass) agent-pay resume worker > skips an overlapping pass and releases the guard afterward [0.37ms]
[agent-pay-resume] worker started — checking stranded payments every 1min (forward-only; never re-sends)
(pass) agent-pay resume worker > resolves poll cadence defaults/floor and starts/stops idempotently [0.19ms]

 15 pass
 0 fail
 64 expect() calls
Ran 15 tests across 1 file. [839.00ms]
Exit code: 0
```

Working directory: apps/api

```text
> bun test src/routes/__tests__/dashboard-reconcile.test.ts
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\dashboard-reconcile.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ⌘ suppress logs { quiet: true }
[AutonomyStandby] active -> active (reason: default)
(pass) read-only reconcile dashboard > projects all three tables, durable bounty context, and narrow metadata without writes [0.92ms]
(pass) read-only reconcile dashboard > handles missing holds and malformed stamps without leaking extra stamp fields [0.24ms]
(pass) read-only reconcile dashboard > rejects anonymous requests on the real dashboard route [12.80ms]
(pass) read-only reconcile dashboard > keeps the registered route private and uncached for an admin cookie [0.79ms]

 4 pass
 0 fail
 18 expect() calls
Ran 4 tests across 1 file. [847.00ms]
Exit code: 0
```

Working directory: apps/api

```text
> bun run typecheck
$ tsc --noEmit
Exit code: 0
```

Working directory: apps/web

```text
> bun run typecheck
$ tsc --noEmit
Exit code: 0
```

```text
> git diff --check
Exit code: 0
```

## Final working-tree status

```text
> git -C . status -sb
## feat/agent-pay-selfheal...origin/staging
 M .env.example
 M ARCHITECTURE.md
 M apps/api/src/routes/dashboard.ts
 M apps/api/src/services/__tests__/agent-pay-resume.test.ts
 M apps/api/src/services/__tests__/bounty-tier1.test.ts
 M apps/api/src/services/__tests__/bulk-reconcile.test.ts
 M apps/api/src/services/__tests__/x402-auto-reconcile.test.ts
 M apps/api/src/services/__tests__/x402-reconcile-apply.test.ts
 M apps/api/src/services/agent-pay-resume.ts
 M apps/api/src/services/bounty-tier1.ts
 M apps/api/src/services/x402-auto-reconcile.ts
 M apps/api/src/services/x402-bulk-reconcile.ts
 M apps/api/src/services/x402-reconcile.ts
 M apps/web/src/app/dash/page.tsx
 M packages/database/src/schema/agent-payments.ts
 M packages/database/src/schema/bounty-usdc-holds.ts
?? AGENTS.md
?? CLAUDE.md
?? apps/api/src/routes/__tests__/dashboard-reconcile.test.ts
?? apps/web/src/app/dash/tabs/reconcile.tsx
?? docs/agent-payment-selfheal-review-2026-09-13.md
?? packages/database/migrations/0062_agent_payment_selfheal.sql
```
