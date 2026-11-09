# BrainChain root budget verifier review

Reviewed: 2026-11-09. Team: brainchain-plan. Role: independent auditor.

Historical approval-time review. The dispatch gap described below received a later independent correction review in docs/brainchain-dispatch-code-review.md.
Protected-store and trial evidence appears in docs/brainchain-root-store-code-review.md.
Neither later report proves live provisioning or a paid pilot. Preserve the original findings below as review history.

## Scope and verdict

Reviewed `root-compute-budget.ts`, its tests, `docs/brainchain-root-budget.md`, and the verifier calls in `inference-proxy.ts`. No blocker was found within the declared approval-time verifier scope. This is not approval for paid dispatch. Dispatch does not yet recheck root revocation or release after envelope approval.

No live key, provider request, or ledger edit occurred. The independent probe used an ephemeral fixture key and in-memory documents only.

## Signature, history, and head checks

The verifier pins a job UUID, Ed25519 public key, and genesis hash. It validates exact canonical UTF-8 document bytes before signature verification. Strict schemas reject unknown document fields. Canonical comparison rejects duplicate JSON keys, extra whitespace, and alternate serialization. Every revision must increment by one and link the exact previous hash.

The verifier retains the complete history, rather than trusting only its latest signed snapshot. It compares a separately supplied protected head before and after verification. A changed revision or document hash refuses approval. Each head observation has a five-second age limit. Current document and target reservation expiry use time after verification.

A signed document alone cannot establish that it is current. Deployment must provide a protected, monotonic head independent of the history loader. This module does not implement that protected store. A compromised or rolled-back head callback defeats its freshness assumption. It is therefore part of the trusted boundary, not a property proved by signature validation.

## Budget and transition checks

OpenAI and OpenRouter each have a separate cumulative 10,000,000 micro-USD cap. Every reserved or uncertain allocation counts, including expired and revoked holds. Spent totals cannot decrease and cannot fall below retained settled charges. The sum of spent and held amounts cannot exceed its provider cap.

Reservation identity, provider, approval reference, limit, and expiry remain immutable across revisions. Earlier records cannot disappear. Revocation cannot reverse. Terminal records cannot change. Uncertain reservations cannot move to released. A settlement requires an explicit charge and reconciliation reference; the trusted issuer remains responsible for the actual reconciliation evidence.

The target must exactly match the envelope approval, remain reserved, remain unrevoked, and have an unexpired deadline. History and document size limits bound parsing and signature work. The module creates no reservation and contains no signing helper.

## Paid-dispatch activation gap

`DurableInferenceProxy.approveEnvelope` calls `verifyReservation`. `reserve` and `dispatch` currently inspect local envelope state but do not call the root verifier. A signed root revocation, release, or settlement after envelope creation therefore cannot stop a later dispatch from that existing envelope.

The existing documentation correctly discloses this gap. Before paid activation, add a current root-authority check to dispatch admission. Bind it to the envelope's immutable job, provider, reservation ID, approval reference, limit, and expiry. Recheck after lock waits and before committing the dispatch liability. A changed or unavailable root head must prevent a new provider invocation. Already dispatched uncertainty must retain its charge liability.

Root release also requires reconciliation of the actual local envelope. Otherwise another root consumer could reuse an allocation while this envelope still holds spend authority. Do not infer release safety from a signed state string alone.

The supplied head and history callbacks have no internal timeout. The concrete sources or their caller must bound these reads before production wiring. A hung source currently stalls approval, though it does not dispatch a provider or create a new envelope.

## Independent evidence

- Verifier suite: 10 tests, 40 assertions passed.
- Independent probe accepted an exact-cap reservation.
- The probe advanced a separately retained head to a signed revocation and observed refusal.
- The probe rolled back only the history loader and observed refusal against the retained current head.
- Probe source: `.brainchain-work/audit-root-budget.ts`.
- Source inspection found the verifier call only in envelope approval, confirming the dispatch gap.

## Remaining gates

Scoped approval applies only to inactive approval-time verification. Protected head/history provisioning, bounded source reads, root-to-local reconciliation, dispatch-time revocation enforcement, and paid-trial authorization remain separate requirements. No live root document or successful paid pilot is claimed.
