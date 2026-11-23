# BrainChain runtime probe review

Last Audited: 2026-11-09. Reviewer: root, independent of the probe implementer.

Verdict: scoped source and controlled-test approval. Actual staging runtime consumption remains unverified.

## Reviewed source

- Hosted probe SHA256: a9f07e5457fb87fe8731be42da5a04efc52812c2e3b48f7a84886ea287c51683.
- Evidence helper SHA256: 7dfb78f5269645fe8241824b27e0b415d8f1326c1b079d6ccb964a2e4481a616.
- Evidence tests SHA256: 8544277896ea1a87f7e7d93a064aa0452a498a37bc76dfa466b4d45b00ab690c.

The new mode requires the exact public staging API, the staging environment and the staging database marker.
It refuses redirects, retention, unmarked databases and optional legacy echo fixtures.
Fixture writes recheck the database marker. Dedicated sessions use agent_exchange origin.
These sessions do not prove human login or wallet approval.

The probe compares served curriculum bytes and hashes with source.
It checks every stored section, agent scope and deterministic memory identifier.
Fresh chat requests must contain source paragraphs inside current-state context.
Decision requests must contain the curriculum, protocol version and BrainChain operation inventory.
One controlled gateway response requests a workers read.
A later request must contain an unexpired private receipt with status200 and the fixture's empty workers array.
Sequence cursors retain freshness across bounded capture-buffer eviction.
The finalizer stops and disconnects the fixture before deletion, then checks for retained rows.
It never deletes the canonical BrainChain curriculum row.

## Independent execution

Both controlled suites passed together:18 tests,190 assertions,zero failures or skips.
The dedicated script TypeScript configuration also exited0.
That configuration explicitly includes the probe and evidence helper because the normal API configuration excludes scripts.
Root inspected the actual curriculum route, installer and section splitter against the probe's expected response and storage shapes.
These tests use controlled loopback HTTP. They create no staging account and call no paid provider.

## Remaining release requirements

The CI owner must register the new evidence suite in the pure lane.
An actual run must use the final deployed source and verified staging database.
The separate human authentication and wallet-proof procedure remains required.
Root must account for every provider path before execution under the existing separate10USD caps.
The gateway mocks do not control all installation embeddings, retrieval, auxiliary runtime calls or Nori calls.
No live probe, provider charge, wallet signature, settlement or leaderboard result belongs to this approval.

PARITY: this probe verifies the dedicated agent path; separate authenticated human evidence remains mandatory.
