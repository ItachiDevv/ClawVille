---
name: ssrf-allowlist-signed-outbound
description: "All outbound cognition/webhook/launch re-runs a DNS-aware private-IP reject (validateHatcherProxyUrlResolved, fail-closed) every send + redirect:'manual', fails soft without logging the token, and is ed25519-signed. The sync hostname allowlist alone DNS-rebinds. FIXED (Codex R2-3)."
category: security
confidence: high
date: 2026-06-22
---

# SSRF-guarded + signed outbound cognition

**Status: FIXED + LIVE (Codex round-2).**

## Invariant
Every outbound path that uses a partner-supplied URL (cognition proxy, session webhook, owner-launch exchange, a connected agent's own gateway/OpenAI/Anthropic endpoint) MUST, immediately before send:
1. Re-run the **DNS-AWARE** validator — `validateHatcherProxyUrlResolved` (`hatcher-config.ts:191`, https + allowlist + resolve + reject ANY private A/AAAA, **fail-CLOSED on DNS error**) for the partner proxy, or `validateOutboundUrlResolved` (`:247`, no-allowlist gateway path) for an agent's own URL.
2. Set `redirect:'manual'` so any 3xx is a hard fail (a rebind-on-redirect can't bounce the bearer internal).
3. Fail **SOFT** (return `''`) on any guard failure — NEVER fall through to the fetch; log the failure WITHOUT the scoped token.

`openclaw-client.ts`: `chatHatcherProxy` (`:166`) calls the resolved check (`:194`) + `redirect:'manual'` (`:273`); other backends call `validateOutboundUrlResolved` (`:337`/`:398`/`:460`).

## IP classification
`isPrivateIPv4` (`:69`) / `isPrivateIPv6` (`:98`) is the SINGLE source — covers RFC1918, `169.254` metadata, loopback, link-local, CGNAT, doc/benchmark ranges, AND IPv4-mapped IPv6 in BOTH dotted and hex form (`:123`).

## Why the sync allowlist alone is insufficient
The synchronous hostname allowlist (`validateHatcherProxyUrl :148`) checks only the host string — an allowlisted Hatcher subdomain DNS-rebinds to `169.254.169.254`/RFC1918/loopback between resolve and connect. Documented residual TOCTOU is just the sync body-build+sign window.

Outbound is ed25519-signed (`service-issuer signPayload`). Any change to this path → Codex adversarial pass.

→ [[secretkey-returned-once-encrypt-at-rest]] [[ed25519-window-signing]]
