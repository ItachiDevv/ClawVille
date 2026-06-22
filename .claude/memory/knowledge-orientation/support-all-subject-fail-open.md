---
name: support-all-subject-fail-open
description: "support tickets all-subject (Lucia→agent→guest), append-only, Telegram plain-text fail-open, non-ledger agent not trusted to own userId — the correct E5-shaped read path"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: support-all-subject-fail-open
description: support.ts resolves user/agent/guest, persists append-only, relays to Telegram fail-open plain-text; a non-ledger agent is not trusted to own its userId. The GOOD E5 reference.
category: pattern
confidence: 0.88
date: 2026-06-22
---

# Support is all-subject + fail-open (the correct E5-shaped read path)

`apps/api/src/routes/support.ts` `POST /api/support/tickets`:
- Resolves identity **user (Lucia) → agent (`resolveAgentSession`, `:152`) → guest (fp)** — the all-subject pattern the chat routes LACK (contrast [[chat-route-e5-parity-gap]]).
- Persists APPEND-ONLY to `support_tickets`.
- Best-effort relays to Telegram, **fail-open** (a bad/unreachable bot never blocks the ticket) and **PLAIN TEXT** (no `parse_mode` so user content can't inject markup).

## The trust guard (Codex review)

`support.ts:160`: only attribute (and rate-limit against) a bound user/avatar when `resolved.ledgerCapable` is true:
```
if (resolved.ledgerCapable) { userId = resolved.userId ?? null; avatarId = resolved.avatarId ?? null; }
```
A non-ledger (unbound / not-fully-bound) agent session must NOT be trusted to own its `userId` — otherwise it could mis-attribute a ticket to, and burn the rate-limit bucket of, a victim user. Rate-limit on the strongest identity available.

## Why this matters here

This is the reference implementation for the E5 fix shape on any knowledge-domain read path that accepts agent sessions: resolve all three subjects, but only TRUST a ledger-capable agent to own its userId.

## Status: LIVE.

Related: [[chat-route-e5-parity-gap]] · [[chat-reward-and-metric-discipline]]
