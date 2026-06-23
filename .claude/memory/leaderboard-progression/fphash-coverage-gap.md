---
name: fphash-coverage-gap
description: "A request-path emitter using bare logEvent writes NULL fp_hash and escapes the anti-farm fingerprint tier; agent.collaboration.turn (weight 40) is the confirmed OPEN case"
category: gotcha
confidence: high
date: 2026-06-22
---

Anti-farm tagging is `(fp_hash, ip_prefix_hash)` (salted by FINGERPRINT_SECRET, owned by auth-identity-session) — the FORENSIC farm-detection tier (the per-(subject,day) `LEAST(count,cap)` is the actual scoring cap; the fp tag is the detection/monitoring layer surfaced by `/dash fingerprintCoverage24h`). Routes populate the tag via `logEventFromContext(c, {...})` (event-logger.ts:443), which pulls `fpHash`/`ipPrefixHash` from `fingerprintMiddleware`.

**The gap:** a bare `logEvent({...})` from a request path (no Hono context) writes `fp_hash = NULL`, so its rows are invisible to the fingerprint farm-detection tier. System/cron writes (no request) are legitimately fp-null and inherently un-farmable.

**CONFIRMED OPEN:** `agent.collaboration.turn` — the HIGHEST-weighted scored event (40) — is emitted via bare `logEvent` at `services/agent-collaboration.ts:114-115` (import at :28 is `logEvent`, not `logEventFromContext`). It is a system-internal call site (the collaboration broker, no Hono context), so fp-null is structurally unavoidable there without threading fp/ip through the service. The per-day cap of 50 still bounds it BY SUBJECT, but the (fp,ip) tier is blind to it. `dashboard.ts:291` (fp_hash IS NOT NULL count) + :333 (the card) surface the coverage gap.

**Rule:** use `logEventFromContext` from any route emitter; for a service-layer scored emitter, either thread fp/ip through or accept (and document) subject-cap-only protection.

Status: OPEN (MEDIUM) — agent.collaboration.turn fp-null on staging+prod. Related: [[no-farm-is-a-rank]], [[event-name-is-a-cross-file-contract]].
