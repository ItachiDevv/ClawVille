---
name: fingerprint-stability-and-secret
description: "FINGERPRINT_SECRET is crash-loud + shared by fp-hash AND dash HMAC; tier-2 fp keys /24 prefix not raw IP; getClientIp drops spoofable headers"
category: constraint
confidence: high
date: 2026-06-22
---

# Fingerprint stability + FINGERPRINT_SECRET coupling

**Crash-loud:** `fingerprint.ts` THROWS at module load if `FINGERPRINT_SECRET` is missing (:45) OR < 32 chars (:52) — crashes API boot (same class as the partner `CLAWVILLE_ENV` gate). `fpHash` is the guest subject key and is ALWAYS non-empty via a 3-tier fallback (`X-CV-Fingerprint` → `ua:<UA>:ip:<ipPrefix>` → `no-fp:<ipPrefix>`, :105-110). Guest resolution defensively throws 500 if `fpHash` is somehow missing (`cove-history.ts:162`) rather than let a NULL-keyed row through.

**fp STABILITY (2026-06-21 prod hotfix):** tier-2 keys on the **/24 `ipPrefix`** (:107), NOT the raw full IP. A residential guest on a dynamic IP (DHCP renew / mobile-CGNAT / VPN toggle) otherwise got a DIFFERENT fpHash between writing a cove event and later reading history under the same UA — orphaning the win ('won 20 CT, no history'). The /24 prefix keeps one dynamic-IP guest in ONE bucket across IP churn. Backstop only: the browser now sends `X-CV-Fingerprint` (tier-1 stable) on cove requests; tier-2 serves header-less callers. `deriveIpPrefix` → IPv4 /24, IPv6 /48 (:67-79).

**Spoofable-IP guard:** `getClientIp` (`rate-limit.ts`) = `cf-connecting-ip` (CF-overwritten, not user-settable) → the LAST `x-forwarded-for` entry (appended by the trusted proxy) → 'unknown'. `x-real-ip` and the FIRST XFF entry were REMOVED (FIX-18/SEC-6) — trusting them let a caller rotate the per-IP rate-limit key or the tier-2 fp bucket. ALL fp + limiter IP derivation flows through this one fn.

**SECRET COUPLING (OPEN, operational):** the SAME `FINGERPRINT_SECRET` salts the fp anti-farm hash AND backs the cv_dash dash-access HMAC (`admin-only.ts`). Rotating it to revoke dash access ALSO re-salts every `fp_hash` (resets all anti-farm + leaderboard buckets) AND invalidates every reviewer's cv_dash cookie. Coordinate before rotating; prefer rotating `DASH_SHARED_PASSWORD` when fp buckets must be preserved.

Status: stability + spoof guard FIXED on prod; secret coupling is a standing operational constraint. Related: [[subject-keying-keystone]] (the orphaned-history symptom).
