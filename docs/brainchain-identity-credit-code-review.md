# BrainChain identity and credit independent review

Audited: 2026-11-09 on itachi222. Team: brainchain-plan. Reviewer: identity_audit.
Verdict after correction review: APPROVED for the scoped read-only identity/credit source. I1 and I2 pass independent regression probes.
No source edit or financial operation occurred during this review. Historical findings remain below for traceability.

## Correction verification

The final reader now captures one clock value after the last parent block await.
It recomputes parent, record, route snapshot, and stock ages before response construction.
Absolute timestamp comparisons preserve fractional-second expiry. The no_record state requires route evidence that remains fresh.

The hosted selector now uses absolute parent, observed record, route snapshot, and stock deadlines.
Transport delay cannot extend those deadlines. A no_record receipt without observed route evidence expires immediately.
Future or oversized parent timestamps and invalid future source timestamps cannot create a usable lifetime.
Already stale observations remain explicitly stale, subject to the parent deadline.

Independent rerun: 29 passed, 0 failed, 123 assertions across the original ignored probes, identity-credit tests, and hosted action tests.
Both original defect probes now pass. An added independent probe checks stock expiry by one millisecond and future stock timestamps.
The owner regressions also cover final-wait no_record suppression, fractional record age, transport delay, and oversized parent timestamps.
No UI or shared source changed in this correction scope. Earlier UI and route evidence retains its original scope.

## Findings

### I1: Final parent read can leave stale Priors data marked observed

`identity-credit.ts` computes record and route ages before the awaited final parent block read.
A record and route snapshot aged 299 seconds then cross the 300-second limit during that read.
The response still reports observed and age 299. The parent remains fresh, so its final check does not reject this result.
The explicit no_record branch has the same final-evidence issue.

Independent reproduction: `.brainchain-work/identity-freshness-audit.test.ts`, first test.
The controlled parent block read advances the clock four seconds. Expected stale; received observed.
Recompute all relevant source ages after the last asynchronous read and before response construction.
Derive no_record only from route evidence that remains fresh at that point.

### I2: Hosted receipt outlives the Priors display freshness limit

`brainchain-action.ts` bounds identity receipts only by the parent block age.
With parent age 10 seconds and record age 299 seconds, the receipt survives another 110 seconds.
The record crosses its 300-second limit after one second but stays observed in the private decision context.

Independent reproduction: the second test in the same ignored probe.
Expected expiry at or before 1794240001000; received 1794240110000.
Bound expiry by the absolute parent deadline and every observed source deadline.
The no_record state must retain the deadline of its supporting route evidence.
Use source timestamps so response transport cannot extend the lifetime.

## Independent verification

All tests used controlled fixtures. No provider key, signature, payment, debt operation, or partner message was used.

| Test scope | Result |
| --- | --- |
| identity-credit, parent-reader, priors-reader, earnings-reader, chain-client | 27 passed; 228 assertions |
| HTTP identity and existing worker authorization | 7 passed; 54 assertions |
| Hosted action and MCP route mapping | 114 passed; 853 assertions |
| Mounted identity, earnings and account UI | 9 passed; 60 assertions |
| Independent final-source-age and receipt-expiry probes | 2 failed; 3 assertions |

Commands run from the worktree, except UI tests from apps/web:

```powershell
bun test apps/api/src/services/brainchain/identity-credit.test.ts apps/api/src/services/brainchain/parent-reader.test.ts apps/api/src/services/brainchain/priors-reader.test.ts apps/api/src/services/brainchain/earnings-reader.test.ts apps/api/src/services/brainchain/chain-client.test.ts
bun test apps/api/src/routes/brainchain-auth.test.ts
bun test apps/api/src/services/__tests__/brainchain-action.test.ts apps/api/src/services/__tests__/agent-mcp-tools.test.ts
bun test src/components/brainchain/office-worker-identity.test.tsx src/components/brainchain/office-worker-record.test.tsx src/components/brainchain/office-account.test.tsx
bun test ./.brainchain-work/identity-freshness-audit.test.ts
```

## Reviewed invariants

- The private route resolves a non-guest human or ledger-capable bound agent before service access.
- The service queries the worker by worker ID and avatar ID before it constructs external readers.
- Parent reads pin chain 4663, identity and reputation registries, issuer, and tags.
- Owner, registered wallet, registry association, and reputation use the same provisional block.
- The final block hash and parent age are checked. Association does not grant owner consent.
- Priors source owner and identity must match the selected registry identity.
- Exact monetary decimal strings remain separate from numeric route quotes and wallet balances.
- IDs above MAX_SAFE_INTEGER retain chain reads but refuse Priors requests.
- The MCP client permits only initialize and constant agent_record. The GET uses one fixed host and path.
- JSON/SSE reads have byte and time bounds. Redirects and caller-selected tools or URLs are absent.
- Vendor text, content blocks, links, suggestions, and unknown loan terms do not reach the result.
- No-record, unavailable, unsupported, stale, and unknown loan terms remain distinct.
- UI query keys include owner and worker. Account changes unmount private state and abort requests.
- Hosted results reach only the bound private context. The two freshness findings remain exceptions.
- Protocol 122, Nori, orientation, route mapping, and the human form expose the same read operation.
- Malformed decimal input checks guard BigInt conversion. Scientific notation regressions pass.

The UI presents timestamped snapshots. It does not continuously update freshness labels after a read.
That limitation must remain clear; a displayed snapshot does not establish current credit eligibility.

This review does not prove live identity association, staging parity, real credit availability, visual acceptance, or full integration completion.
Root retains the shared build and device verification scope. No scoped blocker remains after the correction review.
